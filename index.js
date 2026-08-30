const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const axios = require('axios');
const md5 = require('md5');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── GLOBAL STATE ─────────────────────────────────────────────────────────────
let globalHistory = [];         // ["TAI","XIU",...]
let session = null;             // active bot session
let logs = [];                  // activity log

const SESSIONS_API = 'https://wtxmd52.tele68.com/v1/txmd5/sessions';

async function fetchAndSeedHistory() {
  try {
    const r = await axios.get(SESSIONS_API, { timeout: 8000 });
    const list = r.data.list || [];
    // API trả từ mới → cũ, cần đảo lại
    const newHistory = list.reverse().map(s => s.resultTruyenThong).filter(v => v === 'TAI' || v === 'XIU');
    if (newHistory.length > 0) {
      // Merge: giữ history từ WS (mới hơn), prepend API history (cũ hơn)
      // Lấy sessionId mới nhất từ API để tránh duplicate
      const latestApiId = list[list.length - 1]?.id || 0;
      globalHistory = newHistory;
      console.log(`[📊] Seed ${newHistory.length} phiên từ API (phiên mới nhất: #${latestApiId})`);
    }
  } catch(e) {
    console.error('[❌] Fetch history API lỗi:', e.message);
  }
}

// Fetch history ngay khi khởi động
fetchAndSeedHistory();
// Fetch lại mỗi 5 phút để cập nhật
setInterval(fetchAndSeedHistory, 5 * 60 * 1000);

function addLog(type, msg) {
  const entry = { time: new Date().toLocaleTimeString('vi-VN', {timeZone:'Asia/Ho_Chi_Minh'}), type, msg };
  logs.unshift(entry);
  if (logs.length > 200) logs.pop();
  broadcast({ type: 'log', data: entry });
}

// ─── PREDICTION ENGINE (ported from Python V10) ───────────────────────────────
function detectRegime(seq) {
  if (seq.length < 10) return 'CHOPPY';
  const tail = seq.slice(-11);
  const sr10 = tail.slice(1).filter((v,i) => v !== tail[i]).length / 10;
  let streak = 1;
  for (let i = seq.length - 2; i >= 0; i--) {
    if (seq[i] === seq[seq.length-1]) streak++; else break;
  }
  const w20 = seq.slice(-20);
  const bias = Math.abs(w20.filter(v => v === 'TAI').length / w20.length - 0.5);
  if (streak >= 4) return 'STREAK';
  if (sr10 > 0.72) return 'ZIGZAG';
  if (bias > 0.18) return 'BIASED';
  return 'CHOPPY';
}

function backtestSplit(seq, fn, window = 120, cap = 200) {
  const n = seq.length;
  const start = Math.max(6, n - window);
  const mid = Math.floor((start + n) / 2);
  function run(s, e) {
    let hits = 0, total = 0;
    for (let i = s; i < e; i++) {
      const sub = seq.slice(Math.max(0, i - cap), i);
      const p = fn(sub);
      if (p === null) continue;
      total++;
      if (p === seq[i]) hits++;
    }
    return [hits, total];
  }
  const [h1, t1] = run(start, mid);
  const [h2, t2] = run(mid, n);
  const total = t1 + t2;
  if (total < 10) return [null, total, 0];
  const acc = (h1 + h2) / total;
  const acc1 = t1 >= 5 ? h1/t1 : null;
  const acc2 = t2 >= 5 ? h2/t2 : null;
  const consistency = (acc1 && acc2 && acc1 > 0.5 && acc2 > 0.5) ? 1.0 : 0.6;
  return [acc, total, consistency];
}

// Signal functions
function sigWeightedMarkov(order, decay = 0.88) {
  return (sub) => {
    if (sub.length <= order + 2) return null;
    const key = sub.slice(-order).join(',');
    let wTai = 0, wXiu = 0;
    const n = sub.length;
    for (let i = 0; i < n - order; i++) {
      if (sub.slice(i, i+order).join(',') === key) {
        const age = n - order - i;
        const w = Math.pow(decay, age);
        if (sub[i+order] === 'TAI') wTai += w; else wXiu += w;
      }
    }
    const total = wTai + wXiu;
    if (total < 1.0) return null;
    const p = wTai / total;
    if (p > 0.60) return 'TAI';
    if (p < 0.40) return 'XIU';
    return null;
  };
}

function sigStreakFollow(sub) {
  if (sub.length < 2) return null;
  return sub[sub.length-1];
}

function sigStreakBreak(minLen) {
  return (sub) => {
    if (sub.length < minLen) return null;
    const last = sub[sub.length-1];
    let s = 1;
    for (let i = sub.length-2; i >= 0; i--) {
      if (sub[i] === last) s++; else break;
    }
    if (s < minLen) return null;
    return last === 'TAI' ? 'XIU' : 'TAI';
  };
}

function sigPattern(order) {
  return (sub) => {
    if (sub.length <= order) return null;
    const key = sub.slice(-order).join(',');
    const c = {};
    for (let i = 0; i < sub.length - order; i++) {
      if (sub.slice(i, i+order).join(',') === key) {
        c[sub[i+order]] = (c[sub[i+order]] || 0) + 1;
      }
    }
    if (!Object.keys(c).length) return null;
    const total = Object.values(c).reduce((a,b) => a+b, 0);
    if (total < 3) return null;
    const best = Object.keys(c).sort((a,b) => c[b]-c[a])[0];
    if (c[best]/total < 0.60) return null;
    return best;
  };
}

function sigBias(window) {
  return (sub) => {
    if (sub.length < window) return null;
    const rt = sub.slice(-window).filter(v => v === 'TAI').length / window;
    if (rt > 0.62) return 'XIU';
    if (rt < 0.38) return 'TAI';
    return null;
  };
}

function sigZigzagPersist(sub) {
  if (sub.length < 8) return null;
  const sr6 = Array.from({length:6}, (_,i) => sub[sub.length-1-i] !== sub[sub.length-2-i]).filter(Boolean).length / 6;
  if (sr6 < 0.65) return null;
  return sub[sub.length-1] === 'TAI' ? 'XIU' : 'TAI';
}

function sigMomentumDecay(sub) {
  if (sub.length < 20) return null;
  const runs = [];
  let cv = sub[0], cl = 1;
  for (let i = 1; i < sub.length; i++) {
    if (sub[i] === cv) cl++;
    else { runs.push(cl); cv = sub[i]; cl = 1; }
  }
  runs.push(cl);
  if (runs.length < 6) return null;
  const curStreak = runs[runs.length-1];
  const sorted = [...runs].sort((a,b)=>a-b);
  const p80 = sorted[Math.min(sorted.length-1, Math.floor(sorted.length * 0.80))];
  if (curStreak <= p80) return null;
  return sub[sub.length-1] === 'TAI' ? 'XIU' : 'TAI';
}

// ── THUẬT TOÁN CỔ ĐIỂN ──────────────────────────────────────────────────────

function sigWeightedMarkov(order, decay = 0.88) {
  return (sub) => {
    if (sub.length <= order + 2) return null;
    const key = sub.slice(-order).join(',');
    let wTai = 0, wXiu = 0;
    const n = sub.length;
    for (let i = 0; i < n - order; i++) {
      if (sub.slice(i, i+order).join(',') === key) {
        const age = n - order - i;
        const w = Math.pow(decay, age);
        if (sub[i+order] === 'TAI') wTai += w; else wXiu += w;
      }
    }
    const total = wTai + wXiu;
    if (total < 1.0) return null;
    const p = wTai / total;
    if (p > 0.60) return 'TAI';
    if (p < 0.40) return 'XIU';
    return null;
  };
}

function sigStreakFollow(sub) {
  if (sub.length < 2) return null;
  return sub[sub.length-1];
}

function sigStreakBreak(minLen) {
  return (sub) => {
    if (sub.length < minLen) return null;
    const last = sub[sub.length-1];
    let s = 1;
    for (let i = sub.length-2; i >= 0; i--) {
      if (sub[i] === last) s++; else break;
    }
    if (s < minLen) return null;
    return last === 'TAI' ? 'XIU' : 'TAI';
  };
}

function sigPattern(order) {
  return (sub) => {
    if (sub.length <= order) return null;
    const key = sub.slice(-order).join(',');
    const c = {};
    for (let i = 0; i < sub.length - order; i++) {
      if (sub.slice(i, i+order).join(',') === key) {
        c[sub[i+order]] = (c[sub[i+order]] || 0) + 1;
      }
    }
    if (!Object.keys(c).length) return null;
    const total = Object.values(c).reduce((a,b) => a+b, 0);
    if (total < 3) return null;
    const best = Object.keys(c).sort((a,b) => c[b]-c[a])[0];
    if (c[best]/total < 0.60) return null;
    return best;
  };
}

function sigBias(window) {
  return (sub) => {
    if (sub.length < window) return null;
    const rt = sub.slice(-window).filter(v => v === 'TAI').length / window;
    if (rt > 0.62) return 'XIU';
    if (rt < 0.38) return 'TAI';
    return null;
  };
}

function sigZigzagPersist(sub) {
  if (sub.length < 8) return null;
  const sr6 = Array.from({length:6}, (_,i) => sub[sub.length-1-i] !== sub[sub.length-2-i]).filter(Boolean).length / 6;
  if (sr6 < 0.65) return null;
  return sub[sub.length-1] === 'TAI' ? 'XIU' : 'TAI';
}

function sigMomentumDecay(sub) {
  if (sub.length < 20) return null;
  const runs = [];
  let cv = sub[0], cl = 1;
  for (let i = 1; i < sub.length; i++) {
    if (sub[i] === cv) cl++;
    else { runs.push(cl); cv = sub[i]; cl = 1; }
  }
  runs.push(cl);
  if (runs.length < 6) return null;
  const curStreak = runs[runs.length-1];
  const sorted = [...runs].sort((a,b)=>a-b);
  const p80 = sorted[Math.min(sorted.length-1, Math.floor(sorted.length * 0.80))];
  if (curStreak <= p80) return null;
  return sub[sub.length-1] === 'TAI' ? 'XIU' : 'TAI';
}

// ── THUẬT TOÁN MỚI ──────────────────────────────────────────────────────────

// Entropy: chuỗi càng hỗn loạn → theo zigzag, càng đều → theo cầu
function sigEntropy(sub) {
  if (sub.length < 15) return null;
  const w = sub.slice(-15);
  let sw = 0;
  for (let i = 1; i < w.length; i++) if (w[i] !== w[i-1]) sw++;
  const sr = sw / 14;
  if (sr > 0.70) return w[w.length-1] === 'TAI' ? 'XIU' : 'TAI'; // zigzag
  if (sr < 0.35) return w[w.length-1]; // bệt → theo cầu
  return null;
}

// Weighted Recent: ưu tiên 10 phiên gần nhất hơn toàn bộ lịch sử
function sigWeightedRecent(sub) {
  if (sub.length < 15) return null;
  const recent = sub.slice(-10);
  const old10 = sub.slice(-30, -10);
  const rT = recent.filter(v => v === 'TAI').length / recent.length;
  const oT = old10.length ? old10.filter(v => v === 'TAI').length / old10.length : 0.5;
  const weighted = rT * 0.7 + oT * 0.3;
  if (weighted > 0.60) return 'TAI';
  if (weighted < 0.40) return 'XIU';
  return null;
}

// Double pattern: tìm pattern 2 phiên liên tiếp lặp lại
function sigDoublePattern(sub) {
  if (sub.length < 20) return null;
  const last2 = sub.slice(-2).join(',');
  let tai = 0, xiu = 0;
  for (let i = 0; i < sub.length - 3; i++) {
    if (sub.slice(i, i+2).join(',') === last2) {
      if (sub[i+2] === 'TAI') tai++; else xiu++;
    }
  }
  const total = tai + xiu;
  if (total < 4) return null;
  if (tai/total > 0.65) return 'TAI';
  if (xiu/total > 0.65) return 'XIU';
  return null;
}

// Mean reversion: nếu lệch quá nhiều so với 50/50 thì kéo về
function sigMeanReversion(sub) {
  if (sub.length < 30) return null;
  const w = sub.slice(-30);
  const taiCount = w.filter(v => v === 'TAI').length;
  if (taiCount >= 22) return 'XIU'; // quá nhiều TAI → kéo về XIU
  if (taiCount <= 8)  return 'TAI'; // quá nhiều XIU → kéo về TAI
  return null;
}

// Consecutive alternating: chuỗi 1-1-1 dài → break
function sigAltBreak(sub) {
  if (sub.length < 8) return null;
  let altLen = 1;
  for (let i = sub.length-2; i >= 0; i--) {
    if (sub[i] !== sub[i+1]) altLen++;
    else break;
  }
  if (altLen >= 6) return sub[sub.length-1]; // break zigzag dài → follow
  return null;
}

// Volume-weighted bias: 5 phiên gần nhất có weight cao hơn
function sigVWBias(sub) {
  if (sub.length < 20) return null;
  const weights = [5,4,3,2,1];
  let wTai = 0, wTotal = 0;
  const recent5 = sub.slice(-5);
  recent5.forEach((v, i) => {
    wTai += (v === 'TAI' ? 1 : 0) * weights[i];
    wTotal += weights[i];
  });
  const p = wTai / wTotal;
  if (p >= 0.70) return 'TAI';
  if (p <= 0.30) return 'XIU';
  return null;
}

// Cycle detector: tìm chu kỳ lặp lại (4,6,8 phiên)
function sigCycle(period) {
  return (sub) => {
    if (sub.length < period * 3) return null;
    let matches = 0, total = 0;
    for (let i = sub.length - period - 1; i >= period; i -= period) {
      if (sub[i] === sub[i - period]) matches++;
      total++;
      if (total >= 3) break;
    }
    if (total < 2 || matches/total < 0.70) return null;
    const predicted = sub[sub.length - period];
    return predicted;
  };
}

const SIGNALS = [
  // Cổ điển
  ['MK1', sigWeightedMarkov(1), 2.0],
  ['MK2', sigWeightedMarkov(2), 2.5],
  ['MK3', sigWeightedMarkov(3), 3.0],
  ['SF',  sigStreakFollow,       1.5],
  ['SB3', sigStreakBreak(3),     2.0],
  ['SB5', sigStreakBreak(5),     2.5],
  ['P3',  sigPattern(3),         2.0],
  ['P4',  sigPattern(4),         2.5],
  ['P5',  sigPattern(5),         3.0],
  ['B10', sigBias(10),           1.2],
  ['B20', sigBias(20),           1.2],
  ['ZPG', sigZigzagPersist,      2.0],
  ['MDK', sigMomentumDecay,      2.2],
  // Mới
  ['ENT', sigEntropy,            2.2],
  ['WRE', sigWeightedRecent,     2.0],
  ['DP2', sigDoublePattern,      2.2],
  ['MVR', sigMeanReversion,      1.8],
  ['ALB', sigAltBreak,           2.0],
  ['VWB', sigVWBias,             1.8],
  ['CY4', sigCycle(4),           2.0],
  ['CY6', sigCycle(6),           2.2],
  ['CY8', sigCycle(8),           2.0],
];

const REGIME_MULT = {
  'STREAK:SB': 1.4, 'STREAK:MDK': 1.6, 'STREAK:SF': 0.5,
  'ZIGZAG:ALT': 1.5, 'ZIGZAG:ZPG': 1.6, 'ZIGZAG:SF': 0.3,
  'CHOPPY:SF': 0.4,  'BIASED:B': 1.5,
};

function getRegimeMult(regime, tag) {
  for (const [k, v] of Object.entries(REGIME_MULT)) {
    const [r, t] = k.split(':');
    if (r === regime && tag.startsWith(t)) return v;
  }
  return 1.0;
}

// Backtest một signal đơn trên toàn bộ lịch sử
function backtestSingle(history, fn, minSamples = 8) {
  if (history.length < minSamples + 5) return null;
  let hits = 0, total = 0;
  const start = Math.max(10, history.length - 300);
  for (let i = start; i < history.length; i++) {
    const sub = history.slice(0, i);
    const pred = fn(sub);
    if (pred === null) continue;
    total++;
    if (pred === history[i]) hits++;
  }
  if (total < minSamples) return null;
  return { acc: hits / total, total, hits };
}

// Tính tỉ lệ thắng cho tất cả thuật toán, trả về sorted list
function rankAlgorithms(history) {
  const results = [];
  for (const [tag, fn] of SIGNALS) {
    const r = backtestSingle(history, fn);
    if (r) results.push({ tag, acc: r.acc, total: r.total });
  }
  return results.sort((a, b) => b.acc - a.acc);
}

function getSignalsByStrategy(strategy) {
  if (strategy === 'trend')   return SIGNALS.filter(([t]) => ['MK1','MK2','MK3','SF','P3','P4','P5','WRE','VWB'].includes(t));
  if (strategy === 'reverse') return SIGNALS.filter(([t]) => ['SB3','SB5','MDK','MVR','ENT','ALB'].includes(t));
  if (strategy === 'cycle')   return SIGNALS.filter(([t]) => ['CY4','CY6','CY8','DP2'].includes(t));
  if (strategy === 'recent')  return SIGNALS.filter(([t]) => ['WRE','VWB','B10','ENT','MK1'].includes(t));
  // Thuật toán đơn lẻ
  const single = SIGNALS.find(([t]) => t === strategy);
  if (single) return [single];
  return SIGNALS;
}

function predictNext(history, strategy = 'auto') {
  const seq = [...history];
  if (seq.length < 8) {
    return { pred: 'TAI', conf: 51, signals: [], n_active: 0, regime: 'INIT' };
  }
  const regime = detectRegime(seq);
  const votes = [];
  const activeSignals = [];
  const activeSet = getSignalsByStrategy(strategy);
  for (const [tag, fn, capW] of activeSet) {
    const [acc, total, consistency] = backtestSplit(seq, fn);
    if (acc === null || acc <= 0.50) continue;
    const se = Math.sqrt(0.25 / total);
    const z = (acc - 0.50) / se;
    if (z < 2.0) continue;
    const cur = fn(seq);
    if (cur === null) continue;
    const sampleConf = Math.min(1.0, total / 20);
    const regMult = getRegimeMult(regime, tag);
    const weight = (acc - 0.50) * 2 * capW * sampleConf * Math.min(1.0, z/2.5) * regMult * consistency;
    if (weight <= 0.02) continue;
    votes.push([cur === 'TAI' ? 1.0 : 0.0, weight]);
    activeSignals.push(`${tag}:${(acc*100).toFixed(0)}%/${total}`);
  }
  if (!votes.length) {
    return { pred: Math.random() > 0.5 ? 'TAI' : 'XIU', conf: 51, signals: [], n_active: 0, regime };
  }
  const totalW = votes.reduce((s,[,w]) => s+w, 0);
  let pTai = votes.reduce((s,[p,w]) => s+p*w, 0) / totalW;
  pTai = Math.max(0.05, Math.min(0.95, pTai));
  const pred = pTai >= 0.50 ? 'TAI' : 'XIU';
  const edge = Math.abs(pTai - 0.50);
  const conf = Math.round(51 + Math.min(edge / 0.35, 1.0) * 37);
  return { pred, conf, p_tai: +pTai.toFixed(3), n_active: votes.length, signals: activeSignals, regime };
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
async function loginAndGetToken(username, password) {
  const pwMd5 = md5(password);
  try {
    const r1 = await axios.get(
      `https://apifo88daigia.tele68.com/api?c=3&un=${username}&pw=${pwMd5}&cp=R&cl=R&pf=web&at=`,
      { timeout: 12000 }
    );
    const data = r1.data;
    if (!data.success) throw new Error(data.message || 'Sai tài khoản/mật khẩu');
    const sessionData = JSON.parse(Buffer.from(data.sessionKey, 'base64').toString());
    const nickname = sessionData.nickname;
    const accessToken = data.accessToken;
    const r2 = await axios.post(
      'https://wlb.tele68.com/v1/lobby/auth/login?cp=R&cl=R&pf=web&at=',
      { nickName: nickname, accessToken },
      {
        headers: {
          'authority': 'wlb.tele68.com',
          'content-type': 'application/json',
          'authorization': 'Bearer null',
          'origin': 'https://lc79b.bet',
          'referer': 'https://lc79b.bet/',
          'user-agent': 'Mozilla/5.0',
        },
        timeout: 12000
      }
    );
    const lobby = r2.data;
    if (!lobby.token) throw new Error(lobby.message || 'Lobby không trả token');
    return { token: lobby.token, nickname, accessToken };
  } catch (e) {
    throw new Error(e.message);
  }
}

// ─── LC79 BOT SESSION ─────────────────────────────────────────────────────────
class Lc79Session {
  constructor(username, password, token, nickname, config) {
    this.username = username;
    this.password = password;
    this.token = token;
    this.nickname = nickname;
    this.balance = 0;
    this.sessionId = null;
    this.bettingOpen = false;
    this.autoRunning = false;
    this.baseAmount = config.baseAmount || 1000;
    this.currentAmount = config.baseAmount || 1000;
    this.x2Enabled = config.x2Enabled || false;
    this.x2Level = 0;
    this.x2MaxLevel = config.x2MaxLevel || 5;
    this.x2Pending = false;
    this.stopLossPercent = config.stopLossPercent || 0.30;
    this.algoEnabled = config.algoEnabled !== false;
    this.fixedSide = config.fixedSide || null; // 'TAI' | 'XIU' | null (auto)
    this.strategy = config.strategy || 'auto'; // auto|trend|reverse|cycle|recent
    this.sessionPlaced = false;
    this.betPending = false;
    this.statWin = 0;
    this.statLose = 0;
    this.statProfit = 0;
    this.lastBetType = null;
    this.lastBetAmount = 0;
    this.lastLossAmount = 0;
    this.lastPred = null;
    this.ws = null;
    this.running = true;
    this.betTimer = null;
    this.pingInterval = null;
  }

  connect() {
    const wsUrl = 'wss://wtxmd52.tele68.com/txmd5/?EIO=4&transport=websocket';
    this.ws = new WebSocket(wsUrl, {
      headers: {
        'Origin': 'https://lc79b.bet',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    this._eioReady = false; // chờ server gửi "0{...}" trước
    this._wsConnected = false;

    this.ws.on('open', () => {
      // chờ EIO handshake — không log
    });

    this.ws.on('message', (msg) => {
      const m = msg.toString();

      // EIO open packet: "0{...}" — server gửi đầu tiên
      if (m.startsWith('0') && !this._eioReady) {
        this._eioReady = true;
        // EIO OK — gửi token
        // Gửi namespace connect với token
        this.ws.send(`40/txmd5,{"token":"${this.token}"}`);
        // Sau 600ms gửi các lệnh init
        setTimeout(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send('42/txmd5,["get-current-my-info",null]');
          }
        }, 600);
        setTimeout(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send('42/txmd5,["join-room",null]');
            this.ws.send('42/txmd5,["get-current-session",null]');
            this.ws.send('42/txmd5,["get-his-bet",null]');
            if (this.autoRunning) {
              addLog('info', '🤖 Auto vẫn đang bật — tiếp tục theo dõi phiên');
            }
          }
        }, 1000);
        // Không tự ping — server lc79 tự gửi ping, ta chỉ pong lại
        return;
      }

      // EIO ping "2" → pong "3"
      if (m === '2' || m.startsWith('2')) { 
        try { this.ws.send('3'); } catch(e) {}
        return; 
      }

      // Namespace connect confirm
      if (m.startsWith('40')) {
        if (!this._wsConnected) addLog('info', '✅ Đã kết nối LC79');
        this._wsConnected = true;
        broadcastState();
        return;
      }

      // Socket.IO events — hỗ trợ cả có và không có namespace prefix
      if (!m.startsWith('42')) return;
      try {
        // "42/txmd5,[...]" hoặc "42[...]"
        let jsonPart = m.slice(2); // bỏ "42"
        if (jsonPart.startsWith('/txmd5,')) jsonPart = jsonPart.slice('/txmd5,'.length);
        else if (jsonPart.startsWith('/')) {
          // namespace khác — bỏ qua
          const commaIdx = jsonPart.indexOf(',');
          if (commaIdx < 0) return;
          jsonPart = jsonPart.slice(commaIdx + 1);
        }
        const arr = JSON.parse(jsonPart);
        if (!Array.isArray(arr) || arr.length < 1) return;
        const eventName = arr[0];
        const eventData = arr.length > 1 ? (typeof arr[1] === 'object' ? arr[1] : {}) : {};
        this._handleEvent(eventName, eventData);
      } catch(e) {}
    });
    this.ws.on('close', (code, reason) => {
      if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
      this._wsConnected = false;
      this.bettingOpen = false;
      this.betPending = false;
      if (this.betTimer) { clearTimeout(this.betTimer); this.betTimer = null; }
      if (!this.running) {
        broadcastState();
        return;
      }
      addLog('warn', `⚡ WS đóng: code=${code} reason=${reason||'?'}`);
      const wasAuto = this.autoRunning;
      this._reconnectCount = (this._reconnectCount || 0) + 1;
      addLog('warn', `🔄 Mất kết nối (lần ${this._reconnectCount}) — thử lại sau 5s`);
      broadcastState();
      this._reconnectTimer = setTimeout(async () => {
        if (!this.running) return;
        this.autoRunning = wasAuto;
        // Cứ mỗi 3 lần mất kết nối → lấy token mới
        if (this._reconnectCount % 3 === 0 && this.username && this.password) {
          try {
            addLog('info', '🔑 Lấy token mới...');
            const auth = await loginAndGetToken(this.username, this.password);
            this.token = auth.token;
            addLog('info', '✅ Token mới OK — kết nối lại');
          } catch(e) {
            addLog('error', `❌ Lấy token thất bại: ${e.message}`);
          }
        }
        this.connect();
      }, 5000);
    });
    this.ws.on('error', (e) => {
      addLog('error', `❌ WS lỗi: ${e.message}`);
    });
  }

  _handleEvent(event, data) {
    if (['ping','pong','heartbeat','undefined','summary-winner'].includes(event)) return;

    // tick-update: theo dõi state để bet đúng lúc
    if (event === 'tick-update') {
      const state = data.state || '';
      const tickId = data.id;
      // Cập nhật sessionId từ tick
      if (tickId) this.sessionId = tickId;
      // Chỉ bet khi state OPEN và chưa bet phiên này
      if (state === 'PREPARE_TO_START') {
        if (tickId && tickId !== this._lastOpenSessionId) {
          // Xử lý kết quả phiên vừa xong trước khi reset
          if (this._pendingResultCheck) {
            const { placed, betAmount } = this._pendingResultCheck;
            this._pendingResultCheck = null;
            if (placed && !this._wonThisSession) {
              // THUA — won-session không đến
              this.statLose++;
              this.statProfit -= betAmount;
              const plStr = this.statProfit >= 0 ? '+' + this.statProfit.toLocaleString() : this.statProfit.toLocaleString();
              addLog('lose', `❌ THUA | -${betAmount.toLocaleString()}đ | P/L: ${plStr}đ`);
              if (this.autoRunning && this.x2Enabled) {
                this.lastLossAmount = betAmount;
                this.x2Pending = true;
              } else {
                this.currentAmount = this.baseAmount;
                this.x2Level = 0;
                this.x2Pending = false;
              }
            }
            this.sessionPlaced = false;
          }
          // Reset cho phiên mới
          this._lastOpenSessionId = tickId;
          this._lastBetSessionId = null;
          this.bettingOpen = false;
          const pred = predictNext(globalHistory);
          this.lastPred = pred;
          addLog('pred', `🔮 Phiên #${tickId} | AI: ${pred.pred} (${pred.conf}%) | ${pred.n_active} tín hiệu`);
          broadcastState();
        }
        return;
      }

      if (state === 'BETTING' || state === 'OPEN' || state === 'BET_OPEN') {
        this.bettingOpen = true;
        // Bet ngay khi vào BETTING lần đầu của phiên này
        if (this.autoRunning && !this.sessionPlaced && !this.betPending
            && tickId && tickId !== this._lastBetSessionId) {
          this._lastBetSessionId = tickId;
          // X2 logic
          if (this.x2Enabled && this.x2Pending) {
            const newAmt = (this.lastLossAmount || this.currentAmount) * 2;
            if (this.x2Level >= this.x2MaxLevel) {
              addLog('warn', `❌ Đạt giới hạn x2. Dừng auto.`);
              this.autoRunning = false; broadcastState(); return;
            }
            if (newAmt > this.balance) {
              this.currentAmount = this.baseAmount; this.x2Level = 0; this.x2Pending = false;
            } else {
              this.x2Level++; this.x2Pending = false; this.currentAmount = newAmt;
            }
          } else {
            this.currentAmount = this.baseAmount;
          }
          // Stop loss
          if (this.statProfit < 0 && Math.abs(this.statProfit) > this.balance * this.stopLossPercent) {
            addLog('warn', `⚠️ Stop-loss. Dừng auto.`);
            this.autoRunning = false; broadcastState(); return;
          }
          const side = this.fixedSide || (this.lastPred ? this.lastPred.pred : 'TAI');
          this._placeBet(side, this.currentAmount);
        }
        return;
      }
      return;
    }

    // Handle exception từ server
    if (event === 'exception') {
      const msg = data.message || data.msg || JSON.stringify(data);
      addLog('error', `⚠️ Server exception: ${msg}`);
      return;
    }

    // Debug unknown events
    if (!['your-info','session-info','new-session','open-bet','bet-open','start-session',
          'your-current-session-info','current-session','session',
          'session-result','result','game-result','end-session','won-session','bet'].includes(event)) {
      addLog('info', `📡 event: ${event} | ${JSON.stringify(data).slice(0,80)}`);
    }

    if (event === 'your-info') {
      this._wsConnected = true;
      this.balance = data.balance || 0;
      this.nickname = data.nickname || this.nickname;
      broadcastState();
    }

    // your-current-session-info: chỉ lấy trạng thái hiện tại, KHÔNG bet (có thể đã hết giờ)
    else if (['your-current-session-info','current-session'].includes(event)) {
      this.sessionId = data.id;
      broadcastState();
    }

    else if (['session-info','new-session','open-bet','bet-open','start-session'].includes(event)) {
      const incomingId = data.id;
      const isNewSession = incomingId && incomingId !== this._lastOpenSessionId;

      this.sessionId = incomingId;
      this.bettingOpen = true;
      this.betPending = false;

      // Chỉ reset sessionPlaced nếu là phiên MỚI
      if (isNewSession) {
        this._lastOpenSessionId = incomingId;
        this.sessionPlaced = false;
      }

      // Prediction
      const pred = predictNext(globalHistory, this.strategy || 'auto');
      this.lastPred = pred;
      if (isNewSession) {
        addLog('pred', `🔮 Phiên #${this.sessionId} | AI: ${pred.pred} (${pred.conf}%) | Chế độ: ${pred.regime} | ${pred.n_active} tín hiệu`);
      }
      broadcastState();

      // KHÔNG bet ở đây — chờ tick-update state=OPEN mới bet
    }

    else if (['session-result','result','game-result','end-session'].includes(event)) {
      const result = data.resultTruyenThong;
      if (result === 'TAI' || result === 'XIU') {
        globalHistory.push(result);
        if (globalHistory.length > 400) globalHistory = globalHistory.slice(-400);
      }
      const dices = data.dices || [];
      const total = dices.reduce((s,d) => s+d, 0);
      addLog('result', `🎲 Phiên #${this.sessionId} | ${dices.join('-')} (${total}) → ${result || '?'}`);

      // Chờ 3 giây — đủ thời gian cho won-session đến nếu thắng
      if (this.sessionPlaced) {
        const _betAmt = this.lastBetAmount || this.currentAmount || this.baseAmount;
        const _checkSid = this.sessionId; // snapshot sessionId
        this._loseCheckTimer = setTimeout(() => {
          // Chỉ log thua nếu session này chưa thắng
          if (!this._wonSessions) this._wonSessions = new Set();
          if (!this._wonSessions.has(_checkSid)) {
            this.statLose++;
            this.statProfit -= _betAmt;
            const plStr = this.statProfit >= 0 ? '+' + this.statProfit.toLocaleString() : this.statProfit.toLocaleString();
            addLog('lose', `❌ THUA | -${_betAmt.toLocaleString()}đ | P/L: ${plStr}đ`);
            if (this.autoRunning && this.x2Enabled) {
              this.lastLossAmount = _betAmt;
              this.x2Pending = true;
            } else {
              this.currentAmount = this.baseAmount;
              this.x2Level = 0;
              this.x2Pending = false;
            }
            broadcastState();
          }
          // Cleanup
          if (this._wonSessions) this._wonSessions.delete(_checkSid);
        }, 10000);
      }
      broadcastState();
    }

    else if (event === 'won-session') {
      // Đánh dấu session này đã thắng
      if (!this._wonSessions) this._wonSessions = new Set();
      this._wonSessions.add(data.id || this.sessionId);
      this._wonThisSession = true;
      if (this._loseCheckTimer) { clearTimeout(this._loseCheckTimer); this._loseCheckTimer = null; }
      // Format: {id, dices, bets:[{won, type, amount}], prize, balance}
      const prize = data.prize ?? 0;
      if (data.balance) this.balance = data.balance;

      const myBet = Array.isArray(data.bets) && data.bets.length > 0 ? data.bets[0] : null;
      const betAmount = myBet ? (myBet.amount || 0) : (this.lastBetAmount || this.baseAmount);

      // prize > 0 thắng, prize < 0 thua (số âm), prize = 0 chưa cược
      const won = prize > 0;
      const lostAmt = prize < 0 ? Math.abs(prize) : betAmount;
      const profitAmt = won ? prize : lostAmt;

      // prize bao gồm cả vốn, cần trừ ra để lấy lời thực
      const profit = won ? (prize - betAmount) : 0;
      if (won) { this.statWin++; this.statProfit += profit; }

      const plStr = this.statProfit >= 0 ? '+' + this.statProfit.toLocaleString() : this.statProfit.toLocaleString();
      if (won) addLog('win', `✅ THẮNG | +${profit.toLocaleString()}đ | P/L: ${plStr}đ`);

      // X2 martingale
      if (this.autoRunning && this.x2Enabled) {
        if (won) {
          this.currentAmount = this.baseAmount;
          this.x2Level = 0;
          this.x2Pending = false;
          this.lastLossAmount = 0;
        }
        // Thua được xử lý trong session-result
      } else {
        this.currentAmount = this.baseAmount;
        this.x2Level = 0;
        this.x2Pending = false;
      }
      this.sessionPlaced = false;
      broadcastState();
    }

    else if (event === 'bet' || event === 'bet-result') {
      if (this.betTimer) { clearTimeout(this.betTimer); this.betTimer = null; }
      this.betPending = false;
      const amount = data.amount || data.betAmount || 0;
      const type = data.type || data.betType || '';
      const postBal = data.postBalance || data.balance || 0;
      if (type && amount > 0) {
        this.sessionPlaced = true;
        if (postBal) this.balance = postBal;
        addLog('bet', `✅ Xác nhận: ${type} | ${amount.toLocaleString()}đ`);
        broadcastState();
      } else {
        this.sessionPlaced = false;
        addLog('error', '❌ Nhà cái từ chối lệnh cược');
        if (this.autoRunning) { this.autoRunning = false; addLog('warn', '⏹ Dừng auto'); }
        broadcastState();
      }
    }

    else if (['bet-error','error'].includes(event)) {
      if (this.betTimer) { clearTimeout(this.betTimer); this.betTimer = null; }
      this.betPending = false;
      this.sessionPlaced = false;
      addLog('error', `❌ Lỗi cược: ${data.message || event}`);
      if (this.autoRunning) { this.autoRunning = false; addLog('warn', '⏹ Dừng auto'); }
      broadcastState();
    }
  }

  _placeBet(side, amount) {
    if (this.sessionPlaced || !this.bettingOpen || this.betPending) return;
    if (!['TAI','XIU'].includes(side)) return;
    if (amount > this.balance) {
      addLog('warn', `⚠️ Số dư không đủ: cần ${amount.toLocaleString()}đ, dư ${this.balance.toLocaleString()}đ`);
      this.autoRunning = false;
      broadcastState();
      return;
    }
    try {
      const payload = `42/txmd5,["bet",${JSON.stringify({ type: side, amount: Math.floor(amount), referenceId: parseInt(this.sessionId) })}]`;
      this.ws.send(payload);
      this.lastBetType = side;
      this.lastBetAmount = amount;
      this.betPending = true;
      this.betTimer = setTimeout(() => {
        this.betPending = false;
        this.sessionPlaced = true;
      }, 10000);
      addLog('bet', `🎯 ${side} | ${amount.toLocaleString()}đ`);
    } catch(e) {
      addLog('error', `❌ Lỗi gửi lệnh: ${e.message}`);
      this.autoRunning = false;
    }
  }

  disconnect() {
    this.running = false;   // set false TRƯỚC khi đóng ws để close handler không reconnect
    this.autoRunning = false;
    clearInterval(this.pingInterval);
    if (this.betTimer) clearTimeout(this.betTimer);
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.ws) try { this.ws.close(); } catch(e) {}
  }

  getState() {
    return {
      connected: this.running && this._wsConnected,
      nickname: this.nickname,
      balance: this.balance,
      sessionId: this.sessionId,
      bettingOpen: this.bettingOpen,
      autoRunning: this.autoRunning,
      baseAmount: this.baseAmount,
      currentAmount: this.currentAmount,
      x2Enabled: this.x2Enabled,
      x2Level: this.x2Level,
      x2MaxLevel: this.x2MaxLevel,
      stopLossPercent: this.stopLossPercent,
      algoEnabled: this.algoEnabled,
      fixedSide: this.fixedSide,
      strategy: this.strategy,
      statWin: this.statWin,
      statLose: this.statLose,
      statProfit: this.statProfit,
      lastPred: this.lastPred,
      sessionPlaced: this.sessionPlaced,
      historyLen: globalHistory.length,
      recentHistory: globalHistory.slice(-20),
    };
  }
}

// ─── WEBSOCKET BROADCAST TO DASHBOARD ────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const dashboardClients = new Set();

wss.on('connection', (ws) => {
  dashboardClients.add(ws);
  ws.send(JSON.stringify({ type: 'state', data: session ? session.getState() : null }));
  ws.send(JSON.stringify({ type: 'logs', data: logs }));
  ws.on('close', () => dashboardClients.delete(ws));
});

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const ws of dashboardClients) {
    if (ws.readyState === 1) ws.send(str);
  }
}

function broadcastState() {
  broadcast({ type: 'state', data: session ? session.getState() : null });
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { username, password, config = {} } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Thiếu thông tin' });
  if (session) { session.disconnect(); session = null; }
  try {
    addLog('info', `🔐 Đang đăng nhập: ${username}...`);
    const auth = await loginAndGetToken(username, password);
    session = new Lc79Session(username, password, auth.token, auth.nickname, config);
    session.connect();
    addLog('info', `✅ Đăng nhập thành công: ${auth.nickname}`);
    res.json({ ok: true, nickname: auth.nickname });
  } catch(e) {
    addLog('error', `❌ Đăng nhập thất bại: ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  if (session) { session.disconnect(); session = null; addLog('info', '👋 Đã đăng xuất'); broadcastState(); }
  res.json({ ok: true });
});

app.post('/api/auto/start', (req, res) => {
  if (!session) return res.status(400).json({ error: 'Chưa đăng nhập' });
  session.autoRunning = true;
  addLog('info', '🤖 Bật Auto Cược');
  broadcastState();
  res.json({ ok: true });
});

app.post('/api/auto/stop', (req, res) => {
  if (!session) return res.status(400).json({ error: 'Chưa đăng nhập' });
  session.autoRunning = false;
  addLog('info', '⏹ Dừng Auto Cược');
  broadcastState();
  res.json({ ok: true });
});

app.post('/api/config', (req, res) => {
  if (!session) return res.status(400).json({ error: 'Chưa đăng nhập' });
  const { baseAmount, x2Enabled, x2MaxLevel, stopLossPercent, algoEnabled, fixedSide } = req.body;
  if (baseAmount != null) { session.baseAmount = Number(baseAmount); session.currentAmount = session.baseAmount; }
  if (x2Enabled != null) session.x2Enabled = x2Enabled;
  if (x2MaxLevel != null) session.x2MaxLevel = Number(x2MaxLevel);
  if (stopLossPercent != null) session.stopLossPercent = Number(stopLossPercent) / 100;
  if (algoEnabled != null) session.algoEnabled = algoEnabled;
  if (fixedSide != null) session.fixedSide = fixedSide || null;
  addLog('info', `⚙️ Cập nhật cấu hình`);
  broadcastState();
  res.json({ ok: true });
});

app.get('/api/state', (req, res) => {
  res.json(session ? session.getState() : null);
});

app.get('/api/logs', (req, res) => {
  res.json(logs);
});

app.get('/api/rank', (req, res) => {
  if (globalHistory.length < 50) return res.json([]);
  const ranked = rankAlgorithms(globalHistory);
  res.json(ranked);
});

app.get('/api/predict', (req, res) => {
  res.json(predictNext(globalHistory));
});

// Serve inline HTML
app.get('/', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>AutoLC</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#07090d;--s1:#0d1117;--s2:#161b22;--s3:#21262d;
  --b1:#30363d;--b2:#3d444d;
  --t1:#e6edf3;--t2:#8b949e;--t3:#484f58;
  --tai:#39d98a;--tai2:rgba(57,217,138,.12);--tai3:rgba(57,217,138,.25);
  --xiu:#f85149;--xiu2:rgba(248,81,73,.12);--xiu3:rgba(248,81,73,.25);
  --gold:#e3b341;--gold2:rgba(227,179,65,.12);
  --blue:#58a6ff;--blue2:rgba(88,166,255,.15);
  --purple:#bc8cff;
  --mono:'JetBrains Mono',monospace;--sans:'Inter',sans-serif;
  --r:10px;--r2:6px;
}
html,body{min-height:100vh;background:var(--bg);color:var(--t1);font-family:var(--sans);font-size:14px}
::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:var(--b2);border-radius:2px}
.app{display:flex;flex-direction:column;min-height:100vh}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:0 16px;height:48px;background:var(--s1);border-bottom:1px solid var(--b1);position:sticky;top:0;z-index:100}
.logo{font-family:var(--mono);font-weight:700;font-size:15px;letter-spacing:3px}
.logo em{color:var(--gold);font-style:normal}
.conn-badge{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--t2);font-family:var(--mono)}
.conn-dot{width:6px;height:6px;border-radius:50%;transition:background .3s}
.botnav{position:fixed;bottom:0;left:0;right:0;display:flex;background:var(--s1);border-top:1px solid var(--b1);z-index:100}
.botnav button{flex:1;padding:10px 4px 12px;background:transparent;border:none;color:var(--t3);font-size:10px;font-family:var(--sans);display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;transition:color .2s}
.botnav button.active{color:var(--blue)}
.botnav button svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:1.5}
main{flex:1;padding:16px;padding-bottom:72px;max-width:600px;margin:0 auto;width:100%}
.view{display:none}.view.show{display:block}
.card{background:var(--s1);border:1px solid var(--b1);border-radius:var(--r);overflow:hidden;margin-bottom:12px}
.card-head{padding:10px 14px;font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:var(--t2);border-bottom:1px solid var(--b1);background:var(--s2);display:flex;align-items:center;gap:6px}
.card-body{padding:14px}
.acct-hero{padding:20px 16px;background:linear-gradient(135deg,var(--s2),var(--s1));border-bottom:1px solid var(--b1)}
.acct-nick{font-size:18px;font-weight:700;margin-bottom:4px}
.acct-bal{font-family:var(--mono);font-size:28px;font-weight:700;color:var(--gold);line-height:1}
.acct-bal-label{font-size:11px;color:var(--t2);margin-top:2px}
.acct-status{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-family:var(--mono);padding:3px 8px;border-radius:20px;margin-top:8px}
.status-on{background:var(--tai2);color:var(--tai);border:1px solid var(--tai3)}
.status-off{background:var(--xiu2);color:var(--xiu);border:1px solid var(--xiu3)}
.pred-hero{padding:24px 16px;text-align:center;background:linear-gradient(180deg,var(--s2),var(--s1))}
.pred-big{font-family:var(--mono);font-weight:700;font-size:56px;line-height:1;letter-spacing:4px;margin-bottom:8px;text-shadow:0 0 40px currentColor}
.pred-big.tai{color:var(--tai)}.pred-big.xiu{color:var(--xiu)}.pred-big.empty{color:var(--t3);font-size:32px}
.conf-bar-wrap{width:180px;margin:0 auto 12px;height:4px;background:var(--s3);border-radius:2px;overflow:hidden}
.conf-bar{height:100%;border-radius:2px;transition:width .5s}
.conf-bar.tai{background:var(--tai)}.conf-bar.xiu{background:var(--xiu)}
.pred-meta{display:flex;justify-content:center;gap:16px;font-size:12px;color:var(--t2)}
.pred-meta span{font-family:var(--mono)}
.kv{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--b1)}
.kv:last-child{border:none}
.kv-k{color:var(--t2);font-size:13px}
.kv-v{font-family:var(--mono);font-size:13px;text-align:right}
.stat3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px}
.stat-cell{background:var(--s2);border:1px solid var(--b1);border-radius:var(--r2);padding:12px 8px;text-align:center}
.stat-cell .n{font-family:var(--mono);font-weight:700;font-size:22px;line-height:1;margin-bottom:4px}
.stat-cell .l{font-size:10px;color:var(--t2);text-transform:uppercase;letter-spacing:.5px}
.beads{display:flex;flex-wrap:wrap;gap:5px}
.bead{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-family:var(--mono);font-weight:700}
.bead.t{background:var(--tai2);color:var(--tai);border:1px solid var(--tai3)}
.bead.x{background:var(--xiu2);color:var(--xiu);border:1px solid var(--xiu3)}
.auto-btn{width:100%;padding:14px;border-radius:var(--r);font-size:15px;font-weight:700;border:none;cursor:pointer;font-family:var(--sans);display:flex;align-items:center;justify-content:center;gap:8px;transition:all .2s;letter-spacing:.5px}
.auto-btn.start{background:var(--tai);color:#000}
.auto-btn.stop{background:var(--xiu2);color:var(--xiu);border:1px solid var(--xiu3)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.pulse{animation:pulse 1.5s infinite}
.log-wrap{height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
.log-item{display:grid;grid-template-columns:52px 1fr;gap:8px;padding:4px 2px;border-radius:4px}
.log-item:hover{background:var(--s2)}
.log-t{font-family:var(--mono);font-size:10px;color:var(--t3);padding-top:1px}
.log-m{font-size:12px;line-height:1.5;word-break:break-word}
.field{margin-bottom:14px}
.field label{display:block;font-size:11px;font-weight:600;color:var(--t2);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px}
.field input,.field select{width:100%;background:var(--s2);border:1px solid var(--b1);border-radius:var(--r2);padding:10px 12px;color:var(--t1);font-size:14px;font-family:var(--mono);outline:none;transition:border .2s}
.field input:focus,.field select:focus{border-color:var(--blue)}
.field select option{background:var(--s2)}
.toggle-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.toggle-row label{font-size:13px;color:var(--t1)}
.tog{padding:5px 14px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;border:none;font-family:var(--mono);transition:all .2s}
.tog.on{background:var(--tai2);color:var(--tai);border:1px solid var(--tai3)}
.tog.off{background:var(--s3);color:var(--t2);border:1px solid var(--b1)}
.save-btn{width:100%;padding:12px;border-radius:var(--r);background:var(--blue);color:#000;font-size:14px;font-weight:700;border:none;cursor:pointer;font-family:var(--sans)}
.err-msg{color:var(--xiu);font-size:13px;margin:6px 0;min-height:18px;font-family:var(--mono)}
.login-wrap{max-width:360px;margin:40px auto}
.login-title{font-size:20px;font-weight:700;margin-bottom:4px}
.login-sub{font-size:13px;color:var(--t2);margin-bottom:20px}
.session-badge{display:flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;color:var(--t2)}
.session-badge .s-dot{width:5px;height:5px;border-radius:50%;background:var(--tai)}
.rank-list{display:flex;flex-direction:column;gap:6px}
.rank-item{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--s2);border-radius:var(--r2);border:1px solid var(--b1);cursor:pointer;transition:border .15s}
.rank-item.selected{border-color:var(--blue)}
.rank-item.best{border-color:var(--tai)}
.rank-name{font-size:13px;font-weight:500}
.rank-acc{font-family:var(--mono);font-size:12px}
.rank-badge{font-size:10px;padding:2px 6px;border-radius:4px;margin-left:6px}
.badge-best{background:var(--tai2);color:var(--tai);border:1px solid var(--tai3)}
.badge-good{background:var(--blue2);color:var(--blue);border:1px solid rgba(88,166,255,.3)}
.rank-loading{color:var(--t2);font-size:13px;padding:12px 0;text-align:center;font-family:var(--mono)}
</style>
</head>
<body>
<div class="app">
<div class="topbar">
  <div class="logo">AUTO<em>LC</em></div>
  <div class="conn-badge">
    <div class="conn-dot" id="cDot" style="background:var(--xiu)"></div>
    <span id="cLabel">Đang kết nối</span>
  </div>
</div>
<main>

<!-- HOME -->
<div class="view show" id="v-home">
  <div class="card">
    <div class="acct-hero">
      <div class="acct-nick" id="dNick">Chưa đăng nhập</div>
      <div class="acct-bal" id="dBal">—</div>
      <div class="acct-bal-label">Số dư</div>
      <div class="acct-status status-off" id="dConn"><span>●</span><span id="dConnTxt">Chưa kết nối</span></div>
    </div>
    <div class="pred-hero">
      <div class="pred-big empty" id="dPred">—</div>
      <div class="conf-bar-wrap"><div class="conf-bar" id="dConfBar" style="width:0%"></div></div>
      <div class="pred-meta">
        <div>Tin cậy <span id="dConf">—</span></div>
        <div>Chế độ <span id="dRegime">—</span></div>
        <div><span id="dSig">—</span> tín hiệu</div>
      </div>
    </div>
    <div class="card-body">
      <div class="kv"><span class="kv-k">Trạng thái</span><span id="dAutoStatus" class="kv-v" style="color:var(--t3)">Dừng</span></div>
      <div class="kv"><span class="kv-k">Mức cược</span><span class="kv-v" id="dAmount">—</span></div>
      <div class="kv" id="dX2Row" style="display:none"><span class="kv-k">Gấp thếp</span><span class="kv-v" style="color:var(--purple)" id="dX2">—</span></div>
      <div class="kv" style="border:none;padding-bottom:0"><span class="kv-k">Phiên hiện tại</span><div class="session-badge"><div class="s-dot pulse"></div><span id="dSession">—</span></div></div>
    </div>
    <div style="padding:0 14px 14px">
      <button class="auto-btn start" id="autoBtn" onclick="toggleAuto()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
        Bật Auto Cược
      </button>
    </div>
  </div>
  <div class="card">
    <div class="card-head">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      Thống kê phiên
    </div>
    <div class="card-body">
      <div class="stat3">
        <div class="stat-cell"><div class="n" id="dWin" style="color:var(--tai)">0</div><div class="l">Thắng</div></div>
        <div class="stat-cell"><div class="n" id="dLose" style="color:var(--xiu)">0</div><div class="l">Thua</div></div>
        <div class="stat-cell"><div class="n" id="dPL" style="font-size:15px;color:var(--t2)">+0</div><div class="l">P/L (đ)</div></div>
      </div>
      <div class="beads" id="dBeads"></div>
    </div>
  </div>
</div>

<!-- LOGS -->
<div class="view" id="v-logs">
  <div class="card">
    <div class="card-head">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      Nhật ký hoạt động
    </div>
    <div class="card-body" style="padding:8px"><div class="log-wrap" id="logBox"></div></div>
  </div>
</div>

<!-- CONFIG -->
<div class="view" id="v-cfg">
  <div class="card">
    <div class="card-head">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93l-1.41 1.41M4.93 4.93l1.41 1.41M12 2v2M12 20v2M2 12h2M20 12h2M19.07 19.07l-1.41-1.41M4.93 19.07l1.41-1.41"/></svg>
      Cấu hình Bot
    </div>
    <div class="card-body">
      <div class="field"><label>Mức cược (đ)</label><input id="cAmount" type="number" value="1000" min="100"/></div>
      <div class="field"><label>Stop-loss (%)</label><input id="cStop" type="number" value="30" min="1" max="100"/></div>
      <div class="toggle-row">
        <label>Gấp thếp X2</label>
        <button class="tog off" id="togX2" onclick="toggleX2()">TẮT</button>
      </div>
      <div id="x2Extra" style="display:none">
        <div class="field"><label>Giới hạn X2 (lần)</label><input id="cX2max" type="number" value="5" min="1" max="10"/></div>
      </div>
      <button class="save-btn" onclick="saveConfig()">Lưu cấu hình</button>
    </div>
  </div>

  <!-- Chọn chiến lược AI -->
  <div class="card">
    <div class="card-head">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      Chiến lược AI
    </div>
    <div class="card-body">
      <div id="rankStatus" style="font-size:12px;color:var(--t2);margin-bottom:12px;font-family:var(--mono)">Đang phân tích thuật toán...</div>
      <div class="rank-list" id="rankList">
        <div class="rank-loading">Cần ít nhất 50 phiên dữ liệu để phân tích</div>
      </div>
    </div>
  </div>
</div>

<!-- LOGIN -->
<div class="view" id="v-login">
  <div class="login-wrap">
    <div class="login-title">Đăng nhập</div>
    <div class="login-sub">Kết nối tài khoản LC79 của bạn</div>
    <div class="card">
      <div class="card-body">
        <div class="field"><label>Tên đăng nhập</label><input id="iUser" placeholder="username" autocomplete="username"/></div>
        <div class="field"><label>Mật khẩu</label><input id="iPass" type="password" placeholder="••••••••" autocomplete="current-password"/></div>
        <div class="err-msg" id="loginErr"></div>
        <button class="save-btn" onclick="doLogin()">Đăng nhập</button>
        <button onclick="doLogout()" style="width:100%;padding:10px;margin-top:8px;background:transparent;border:1px solid var(--b1);color:var(--t2);border-radius:var(--r2);cursor:pointer;font-size:13px">Đăng xuất</button>
      </div>
    </div>
  </div>
</div>

</main>
<nav class="botnav">
  <button class="active" id="nb-home" onclick="showView('home',this)">
    <svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
    <span>Tổng quan</span>
  </button>
  <button id="nb-logs" onclick="showView('logs',this)">
    <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
    <span>Nhật ký</span>
  </button>
  <button id="nb-cfg" onclick="showView('cfg',this)">
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93l-1.41 1.41M4.93 4.93l1.41 1.41M12 2v2M12 20v2M2 12h2M20 12h2M19.07 19.07l-1.41-1.41M4.93 19.07l1.41-1.41"/></svg>
    <span>Cấu hình</span>
  </button>
  <button id="nb-login" onclick="showView('login',this)">
    <svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
    <span>Tài khoản</span>
  </button>
</nav>
</div>

<script>
const LC={info:'#58a6ff',pred:'#e3b341',result:'#8b949e',win:'#39d98a',lose:'#f85149',bet:'#bc8cff',warn:'#d29922',error:'#f85149'};
let st=null,ws=null,x2On=false,selectedStrategy='auto';
const fmt=n=>Number(n||0).toLocaleString('vi-VN');

const ALGO_NAMES={
  MK1:'Markov bậc 1',MK2:'Markov bậc 2',MK3:'Markov bậc 3',
  SF:'Bám cầu',SB3:'Gãy cầu 3',SB5:'Gãy cầu 5',
  P3:'Pattern 3',P4:'Pattern 4',P5:'Pattern 5',
  B10:'Bias 10',B20:'Bias 20',ZPG:'Zigzag',MDK:'Momentum',
  ENT:'Entropy',WRE:'Recent Weight',DP2:'Double Pattern',
  MVR:'Mean Reversion',ALB:'Alt Break',VWB:'Volume Bias',
  CY4:'Chu kỳ 4',CY6:'Chu kỳ 6',CY8:'Chu kỳ 8',
  auto:'Tự động (tất cả)',trend:'Theo cầu',reverse:'Bắt cầu gãy',
  cycle:'Chu kỳ',recent:'Ngắn hạn'
};

function showView(v,btn){
  document.querySelectorAll('.view').forEach(d=>d.classList.remove('show'));
  document.getElementById('v-'+v).classList.add('show');
  document.querySelectorAll('.botnav button').forEach(b=>b.classList.remove('active'));
  const nb=document.getElementById('nb-'+v);
  if(nb)nb.classList.add('active');
  if(v==='cfg') loadRanking();
}

function connect(){
  const proto=location.protocol==='https:'?'wss':'ws';
  ws=new WebSocket(proto+'://'+location.host);
  ws.onopen=()=>{document.getElementById('cDot').style.background='var(--tai)';document.getElementById('cLabel').textContent='Online'};
  ws.onclose=()=>{document.getElementById('cDot').style.background='var(--xiu)';document.getElementById('cLabel').textContent='Offline';setTimeout(connect,3000)};
  ws.onmessage=(e)=>{
    const msg=JSON.parse(e.data);
    if(msg.type==='state'){st=msg.data;render()}
    if(msg.type==='logs'){msg.data.slice(0,50).forEach(l=>addLog(l,false))}
    if(msg.type==='log'){addLog(msg.data,true)}
  };
}

function render(){
  if(!st)return;
  document.getElementById('dNick').textContent=st.nickname||'—';
  document.getElementById('dBal').textContent=fmt(st.balance)+'đ';
  const conn=st.connected;
  const cEl=document.getElementById('dConn');
  cEl.className='acct-status '+(conn?'status-on':'status-off');
  document.getElementById('dConnTxt').textContent=conn?'Đang kết nối':'Mất kết nối';
  const pred=st.lastPred;
  const pEl=document.getElementById('dPred');
  if(pred&&pred.pred){
    pEl.textContent=pred.pred;pEl.className='pred-big '+(pred.pred==='TAI'?'tai':'xiu');
    const pct=Math.max(0,Math.min(100,(pred.conf-50)*2));
    const bar=document.getElementById('dConfBar');
    bar.style.width=pct+'%';bar.className='conf-bar '+(pred.pred==='TAI'?'tai':'xiu');
    document.getElementById('dConf').textContent=pred.conf+'%';
    document.getElementById('dRegime').textContent=pred.regime||'—';
    document.getElementById('dSig').textContent=pred.n_active??'0';
  }else{pEl.textContent='—';pEl.className='pred-big empty';}
  const running=st.autoRunning;
  document.getElementById('dAutoStatus').textContent=running?'● ĐANG CHẠY':'○ Dừng';
  document.getElementById('dAutoStatus').style.color=running?'var(--tai)':'var(--t3)';
  const btn=document.getElementById('autoBtn');
  if(running){btn.className='auto-btn stop';btn.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Dừng Auto';}
  else{btn.className='auto-btn start';btn.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg> Bật Auto Cược';}
  document.getElementById('dAmount').textContent=fmt(st.baseAmount)+'đ';
  document.getElementById('dSession').textContent='#'+(st.sessionId||'—');
  if(st.x2Enabled){document.getElementById('dX2Row').style.display='flex';document.getElementById('dX2').textContent='Lv.'+st.x2Level+'/'+st.x2MaxLevel;}
  else{document.getElementById('dX2Row').style.display='none';}
  // Sync config form với state server
  const amt=document.getElementById('cAmount');if(amt&&st.baseAmount)amt.value=st.baseAmount;
  const stop=document.getElementById('cStop');if(stop&&st.stopLossPercent)stop.value=Math.round(st.stopLossPercent*100);
  const x2max=document.getElementById('cX2max');if(x2max&&st.x2MaxLevel)x2max.value=st.x2MaxLevel;
  if(st.x2Enabled!==undefined){
    x2On=st.x2Enabled;
    const togX2=document.getElementById('togX2');
    if(togX2){togX2.textContent=x2On?'BẬT':'TẮT';togX2.className='tog '+(x2On?'on':'off');}
    const x2Extra=document.getElementById('x2Extra');
    if(x2Extra)x2Extra.style.display=x2On?'block':'none';
  }
  document.getElementById('dWin').textContent=st.statWin;
  document.getElementById('dLose').textContent=st.statLose;
  const pl=document.getElementById('dPL');
  const profit=st.statProfit||0;
  pl.textContent=(profit>=0?'+':'')+fmt(profit);
  pl.style.color=profit>0?'var(--tai)':profit<0?'var(--xiu)':'var(--t2)';
  const beads=document.getElementById('dBeads');
  beads.innerHTML=(st.recentHistory||[]).slice(-20).map(r=>{const t=r==='TAI';return '<div class="bead '+(t?'t':'x')+'">'+(t?'T':'X')+'</div>';}).join('');
}

function addLog(l,prepend){
  const box=document.getElementById('logBox');
  const div=document.createElement('div');div.className='log-item';
  div.innerHTML='<span class="log-t">'+l.time+'</span><span class="log-m" style="color:'+(LC[l.type]||'var(--t1)')+'">'+l.msg+'</span>';
  if(prepend)box.insertBefore(div,box.firstChild);else box.appendChild(div);
  if(box.children.length>200)box.lastChild.remove();
}

async function api(path,body){
  try{const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json();}
  catch(e){return{error:e.message}}
}

async function loadRanking(){
  const list=document.getElementById('rankList');
  const status=document.getElementById('rankStatus');
  list.innerHTML='';

  // Luôn hiện combo strategies trước
  const combos=[
    {tag:'auto',label:'🧠 Tự động (tất cả thuật toán)'},
    {tag:'trend',label:'📈 Theo cầu'},
    {tag:'reverse',label:'🔄 Bắt cầu gãy'},
    {tag:'cycle',label:'🔁 Chu kỳ'},
    {tag:'recent',label:'⚡ Ngắn hạn'},
  ];
  combos.forEach(({tag,label})=>{
    const div=document.createElement('div');
    div.className='rank-item'+(selectedStrategy===tag?' selected':'');
    div.innerHTML='<span class="rank-name">'+label+'</span><span></span>';
    div.onclick=function(){selectStrategy(tag,div)};
    list.appendChild(div);
  });

  // Separator
  const sep=document.createElement('div');
  sep.style='font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:1px;margin:12px 0 6px;font-family:var(--mono)';
  sep.textContent='— Thuật toán đơn lẻ';
  list.appendChild(sep);

  // Thử load backtest
  try{
    status.textContent='Đang phân tích...';
    const ranks=await fetch('/api/rank').then(r=>r.json());
    if(!ranks.length){
      status.textContent='Chưa đủ dữ liệu — sẽ cập nhật sau vài phiên';
      // Hiện danh sách thuật toán không có tỉ lệ
      const allTags=['MK1','MK2','MK3','SF','SB3','SB5','P3','P4','P5','B10','B20','ZPG','MDK','ENT','WRE','DP2','MVR','ALB','VWB','CY4','CY6','CY8'];
      allTags.forEach(tag=>{
        const div=document.createElement('div');
        div.className='rank-item'+(selectedStrategy===tag?' selected':'');
        div.innerHTML='<span class="rank-name">'+(ALGO_NAMES[tag]||tag)+'</span><span class="rank-acc" style="color:var(--t3)">—</span>';
        div.onclick=function(){selectStrategy(tag,div)};
        list.appendChild(div);
      });
      return;
    }
    status.textContent='Phân tích '+ranks.length+' thuật toán | '+ranks[0].total+' phiên';
    const best=ranks[0];
    sep.textContent='— Thuật toán đơn lẻ (backtest '+ranks[0].total+' phiên)';
    ranks.forEach(({tag,acc})=>{
      const pct=Math.round(acc*100);
      const isBest=tag===best.tag;
      const isGood=pct>=54;
      const div=document.createElement('div');
      div.className='rank-item'+(isBest?' best':'')+(selectedStrategy===tag?' selected':'');
      div.innerHTML=
        '<span class="rank-name">'+(ALGO_NAMES[tag]||tag)+
        (isBest?'<span class="rank-badge badge-best">✅ Ưu tiên</span>':
         isGood?'<span class="rank-badge badge-good">👍 Tốt</span>':'')+
        '</span>'+
        '<span class="rank-acc" style="color:'+(pct>=55?'var(--tai)':pct>=52?'var(--gold)':'var(--t2)')+'">'+pct+'%</span>';
      div.onclick=function(){selectStrategy(tag,div)};
      list.appendChild(div);
    });
  }catch(e){status.textContent='Lỗi tải dữ liệu';}
}

function selectStrategy(tag,el){
  selectedStrategy=tag;
  document.querySelectorAll('.rank-item').forEach(e=>e.classList.remove('selected'));
  if(el)el.classList.add('selected');
  api('/api/config',{strategy:tag});
}

async function doLogin(){
  const err=document.getElementById('loginErr');err.textContent='';
  const u=document.getElementById('iUser').value.trim();
  const p=document.getElementById('iPass').value;
  if(!u||!p){err.textContent='Nhập đủ thông tin';return}
  err.textContent='⏳ Đang kết nối...';
  const cfg={baseAmount:+document.getElementById('cAmount').value||1000,x2Enabled:x2On,x2MaxLevel:+document.getElementById('cX2max').value||5,stopLossPercent:+document.getElementById('cStop').value||30,algoEnabled:true,strategy:selectedStrategy};
  const res=await api('/api/login',{username:u,password:p,config:cfg});
  if(res.error){err.textContent='❌ '+res.error;}
  else{err.textContent='✅ Thành công!';setTimeout(()=>showView('home',null),800);}
}

async function doLogout(){await api('/api/logout',{});st=null;}

async function toggleAuto(){
  if(!st){showView('login',null);return}
  await api(st.autoRunning?'/api/auto/stop':'/api/auto/start',{});
}

function getConfig(){
  return{baseAmount:+document.getElementById('cAmount').value||1000,x2Enabled:x2On,x2MaxLevel:+document.getElementById('cX2max').value||5,stopLossPercent:+document.getElementById('cStop').value||30,algoEnabled:true,strategy:selectedStrategy};
}

function toggleX2(){
  x2On=!x2On;
  const btn=document.getElementById('togX2');
  btn.textContent=x2On?'BẬT':'TẮT';btn.className='tog '+(x2On?'on':'off');
  document.getElementById('x2Extra').style.display=x2On?'block':'none';
}

async function saveConfig(){
  if(!st){showView('home',null);return}
  await api('/api/config',getConfig());
  showView('home',null);
}

connect();
</script>
</body>
</html>`;
  res.send(html);
});


server.listen(PORT, () => {
  console.log(`🚀 AutoLC Web chạy tại port ${PORT}`);
});
