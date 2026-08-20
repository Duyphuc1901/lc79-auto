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

function addLog(type, msg) {
  const entry = { time: new Date().toLocaleTimeString('vi-VN'), type, msg };
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

const SIGNALS = [
  ['WM1', sigWeightedMarkov(1), 2.0],
  ['WM2', sigWeightedMarkov(2), 2.5],
  ['WM3', sigWeightedMarkov(3), 3.0],
  ['SF',  sigStreakFollow,       1.5],
  ['SB3', sigStreakBreak(3),     2.0],
  ['SB5', sigStreakBreak(5),     2.5],
  ['SB7', sigStreakBreak(7),     3.0],
  ['P3',  sigPattern(3),         2.0],
  ['P4',  sigPattern(4),         2.5],
  ['P5',  sigPattern(5),         3.0],
  ['B10', sigBias(10),           1.2],
  ['B20', sigBias(20),           1.2],
  ['ZPG', sigZigzagPersist,      2.0],
  ['MDK', sigMomentumDecay,      2.2],
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

function predictNext(history) {
  const seq = [...history];
  if (seq.length < 8) {
    return { pred: 'TAI', conf: 51, signals: [], n_active: 0, regime: 'INIT' };
  }
  const regime = detectRegime(seq);
  const votes = [];
  const activeSignals = [];
  for (const [tag, fn, capW] of SIGNALS) {
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
      addLog('info', '🔗 TCP kết nối — chờ EIO handshake...');
      // KHÔNG gửi gì ở đây — đợi server gửi "0{...}" trước
    });

    this.ws.on('message', (msg) => {
      const m = msg.toString();

      // EIO open packet: "0{...}" — server gửi đầu tiên
      if (m.startsWith('0') && !this._eioReady) {
        this._eioReady = true;
        addLog('info', '✅ EIO handshake OK — gửi auth token');
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
          }
        }, 1000);
        // Bật ping interval
        this.pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send('2');
        }, 20000);
        return;
      }

      // EIO ping "2" → pong "3"
      if (m === '2') { this.ws.send('3'); return; }

      // Namespace connect confirm "40/txmd5" → log ok
      if (m.startsWith('40/txmd5')) {
        this._wsConnected = true;
        addLog('info', '✅ Namespace /txmd5 xác nhận — đã vào phòng');
        broadcastState();
        return;
      }

      // Socket.IO event "42/txmd5,[...]"
      if (!m.startsWith('42/txmd5,')) return;
      try {
        const jsonPart = m.slice('42/txmd5,'.length);
        const arr = JSON.parse(jsonPart);
        if (!Array.isArray(arr) || arr.length < 2) return;
        this._handleEvent(arr[0], typeof arr[1] === 'object' ? arr[1] : {});
      } catch(e) {}
    });
    this.ws.on('close', () => {
      clearInterval(this.pingInterval);
      this._wsConnected = false;
      this.bettingOpen = false;
      this.betPending = false;
      if (this.betTimer) { clearTimeout(this.betTimer); this.betTimer = null; }
      if (!this.running) {
        addLog('info', '🔌 WebSocket đã đóng (chủ động)');
        broadcastState();
        return;
      }
      addLog('warn', '🔌 WebSocket đứt — tự kết nối lại sau 5 giây...');
      broadcastState();
      this._reconnectTimer = setTimeout(() => {
        if (this.running) {
          addLog('info', '🔄 Đang kết nối lại...');
          this.connect();
        }
      }, 5000);
    });
    this.ws.on('error', (e) => {
      addLog('error', `❌ WS lỗi: ${e.message}`);
    });
  }

  _handleEvent(event, data) {
    if (['tick-update','summary-winner','ping','pong','heartbeat'].includes(event)) return;

    if (event === 'your-info') {
      this._wsConnected = true; // nhận được data = chắc chắn đang connected
      this.balance = data.balance || 0;
      this.nickname = data.nickname || this.nickname;
      broadcastState();
    }

    else if (['session-info','new-session','open-bet','bet-open','start-session'].includes(event)) {
      this.sessionId = data.id;
      this.bettingOpen = true;
      this.sessionPlaced = false;
      this.betPending = false;

      // Prediction
      const pred = predictNext(globalHistory);
      this.lastPred = pred;
      addLog('pred', `🔮 Phiên #${this.sessionId} | AI: ${pred.pred} (${pred.conf}%) | Chế độ: ${pred.regime} | ${pred.n_active} tín hiệu`);
      broadcastState();

      // Auto bet
      if (this.autoRunning && this.baseAmount > 0 && !this.sessionPlaced) {
        if (this.statProfit < 0 && Math.abs(this.statProfit) > this.balance * this.stopLossPercent) {
          addLog('warn', `⚠️ Stop-loss kích hoạt. Dừng auto.`);
          this.autoRunning = false;
          broadcastState();
          return;
        }
        if (this.x2Enabled && this.x2Pending) {
          const newAmt = (this.lastLossAmount || this.currentAmount) * 2;
          if (this.x2Level >= this.x2MaxLevel) {
            addLog('warn', `❌ Đạt giới hạn x2 (${this.x2MaxLevel} lần). Dừng auto.`);
            this.autoRunning = false;
            broadcastState();
            return;
          }
          if (newAmt > this.balance) {
            this.currentAmount = this.baseAmount;
            this.x2Level = 0;
            this.x2Pending = false;
          } else {
            this.x2Level++;
            this.x2Pending = false;
            this.currentAmount = newAmt;
          }
        } else {
          this.currentAmount = this.baseAmount;
        }
        const side = this.fixedSide || pred.pred;
        this._placeBet(side, this.currentAmount);
      }
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
      broadcastState();
    }

    else if (event === 'won-session') {
      const prize = data.prize || 0;
      this.balance = data.balance || this.balance;
      const won = prize > 0;
      if (won) { this.statWin++; this.statProfit += prize; }
      else { this.statLose++; this.statProfit += prize; }
      const icon = won ? '✅ THẮNG' : '❌ THUA';
      addLog(won ? 'win' : 'lose', `${icon} | ${prize > 0 ? '+' : ''}${prize.toLocaleString()}đ | Tổng P/L: ${this.statProfit.toLocaleString()}đ`);
      if (this.autoRunning && this.x2Enabled) {
        if (won) { this.currentAmount = this.baseAmount; this.x2Level = 0; this.x2Pending = false; this.lastLossAmount = 0; }
        else { this.lastLossAmount = Math.abs(prize) || this.currentAmount; this.x2Pending = true; }
      } else {
        this.currentAmount = this.baseAmount;
        this.x2Level = 0;
        this.x2Pending = false;
      }
      this.sessionPlaced = false;
      broadcastState();
    }

    else if (event === 'bet') {
      if (data.type && data.amount != null) {
        if (this.betTimer) { clearTimeout(this.betTimer); this.betTimer = null; }
        this.betPending = false;
        this.sessionPlaced = true;
        if (data.postBalance != null) this.balance = data.postBalance;
        addLog('bet', `💰 Đặt cược: ${data.type} | ${(data.amount || 0).toLocaleString()}đ`);
        broadcastState();
      }
    }

    else if (['bet-error','error'].includes(event)) {
      this.betPending = false;
      this.sessionPlaced = false;
      if (this.autoRunning) { this.autoRunning = false; addLog('error', '⏹ Dừng auto do lỗi cược'); }
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
      }, 8000);
      addLog('bet', `⏳ Gửi lệnh ${side} | ${amount.toLocaleString()}đ`);
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

app.get('/api/predict', (req, res) => {
  res.json(predictNext(globalHistory));
});

// Serve React build
app.use(express.static(path.join(__dirname, '../client/dist')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});

server.listen(PORT, () => {
  console.log(`🚀 AutoLC Web chạy tại port ${PORT}`);
});
