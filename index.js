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
      this._reconnectTimer = setTimeout(() => {
        if (this.running) {
          this.autoRunning = wasAuto;
          this.connect();
        }
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
            this._wonThisSession = false;
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
      const pred = predictNext(globalHistory);
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
        this._loseCheckTimer = setTimeout(() => {
          if (!this._wonThisSession) {
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
          this._wonThisSession = false;
          this.sessionPlaced = false;
        }, 10000);
      }
      broadcastState();
    }

    else if (event === 'won-session') {
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

// Serve inline HTML
app.get('/', (req, res) => {
  res.send("<!DOCTYPE html>\n<html lang=\"vi\">\n<head>\n<meta charset=\"UTF-8\"/>\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>\n<title>AutoLC</title>\n<link href=\"https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap\" rel=\"stylesheet\"/>\n<style>\n*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}\n:root{\n  --bg:#07090d;--s1:#0d1117;--s2:#161b22;--s3:#21262d;\n  --b1:#30363d;--b2:#3d444d;\n  --t1:#e6edf3;--t2:#8b949e;--t3:#484f58;\n  --tai:#39d98a;--tai2:rgba(57,217,138,.12);--tai3:rgba(57,217,138,.25);\n  --xiu:#f85149;--xiu2:rgba(248,81,73,.12);--xiu3:rgba(248,81,73,.25);\n  --gold:#e3b341;--gold2:rgba(227,179,65,.12);\n  --blue:#58a6ff;--blue2:rgba(88,166,255,.15);\n  --purple:#bc8cff;\n  --mono:'JetBrains Mono',monospace;--sans:'Inter',sans-serif;\n  --r:10px;--r2:6px;\n}\nhtml,body{min-height:100vh;background:var(--bg);color:var(--t1);font-family:var(--sans);font-size:14px}\n::-webkit-scrollbar{width:3px;height:3px}\n::-webkit-scrollbar-thumb{background:var(--b2);border-radius:2px}\n\n/* LAYOUT */\n.app{display:flex;flex-direction:column;min-height:100vh}\n\n/* TOPBAR */\n.topbar{\n  display:flex;align-items:center;justify-content:space-between;\n  padding:0 16px;height:48px;\n  background:var(--s1);border-bottom:1px solid var(--b1);\n  position:sticky;top:0;z-index:100;\n}\n.logo{font-family:var(--mono);font-weight:700;font-size:15px;letter-spacing:3px;color:var(--t1)}\n.logo em{color:var(--gold);font-style:normal}\n.conn-badge{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--t2);font-family:var(--mono)}\n.conn-dot{width:6px;height:6px;border-radius:50%;transition:background .3s}\n\n/* BOTTOM NAV */\n.botnav{\n  position:fixed;bottom:0;left:0;right:0;\n  display:flex;background:var(--s1);border-top:1px solid var(--b1);\n  z-index:100;\n}\n.botnav button{\n  flex:1;padding:10px 4px 12px;background:transparent;border:none;\n  color:var(--t3);font-size:10px;font-family:var(--sans);\n  display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;\n  transition:color .2s;\n}\n.botnav button.active{color:var(--blue)}\n.botnav button svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:1.5}\n.botnav button span{font-size:10px}\n\n/* MAIN */\nmain{flex:1;padding:16px;padding-bottom:72px;max-width:600px;margin:0 auto;width:100%}\n\n/* VIEWS */\n.view{display:none}.view.show{display:block}\n\n/* CARDS */\n.card{background:var(--s1);border:1px solid var(--b1);border-radius:var(--r);overflow:hidden;margin-bottom:12px}\n.card-head{\n  padding:10px 14px;font-size:10px;font-weight:600;letter-spacing:1.5px;\n  text-transform:uppercase;color:var(--t2);\n  border-bottom:1px solid var(--b1);background:var(--s2);\n  display:flex;align-items:center;gap:6px;\n}\n.card-body{padding:14px}\n\n/* ACCOUNT HERO */\n.acct-hero{\n  padding:20px 16px;\n  background:linear-gradient(135deg,var(--s2) 0%,var(--s1) 100%);\n  border-bottom:1px solid var(--b1);\n}\n.acct-nick{font-size:18px;font-weight:700;margin-bottom:4px}\n.acct-bal{font-family:var(--mono);font-size:28px;font-weight:700;color:var(--gold);line-height:1}\n.acct-bal-label{font-size:11px;color:var(--t2);margin-top:2px}\n.acct-status{\n  display:inline-flex;align-items:center;gap:5px;\n  font-size:11px;font-family:var(--mono);\n  padding:3px 8px;border-radius:20px;margin-top:8px;\n}\n.status-on{background:var(--tai2);color:var(--tai);border:1px solid var(--tai3)}\n.status-off{background:var(--xiu2);color:var(--xiu);border:1px solid var(--xiu3)}\n\n/* PREDICTION */\n.pred-hero{\n  padding:24px 16px;text-align:center;\n  background:linear-gradient(180deg,var(--s2) 0%,var(--s1) 100%);\n}\n.pred-big{\n  font-family:var(--mono);font-weight:700;font-size:56px;line-height:1;\n  letter-spacing:4px;margin-bottom:8px;\n  text-shadow:0 0 40px currentColor;\n}\n.pred-big.tai{color:var(--tai)}\n.pred-big.xiu{color:var(--xiu)}\n.pred-big.empty{color:var(--t3);font-size:32px}\n.conf-bar-wrap{width:180px;margin:0 auto 12px;height:4px;background:var(--s3);border-radius:2px;overflow:hidden}\n.conf-bar{height:100%;border-radius:2px;transition:width .5s;background:var(--blue)}\n.conf-bar.tai{background:var(--tai)}\n.conf-bar.xiu{background:var(--xiu)}\n.pred-meta{display:flex;justify-content:center;gap:16px;font-size:12px;color:var(--t2)}\n.pred-meta span{font-family:var(--mono)}\n\n/* ROWS */\n.kv{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--b1)}\n.kv:last-child{border:none}\n.kv-k{color:var(--t2);font-size:13px}\n.kv-v{font-family:var(--mono);font-size:13px;text-align:right}\n\n/* STATS */\n.stat3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px}\n.stat-cell{background:var(--s2);border:1px solid var(--b1);border-radius:var(--r2);padding:12px 8px;text-align:center}\n.stat-cell .n{font-family:var(--mono);font-weight:700;font-size:22px;line-height:1;margin-bottom:4px}\n.stat-cell .l{font-size:10px;color:var(--t2);text-transform:uppercase;letter-spacing:.5px}\n\n/* BEADS */\n.beads{display:flex;flex-wrap:wrap;gap:5px}\n.bead{\n  width:30px;height:30px;border-radius:50%;\n  display:flex;align-items:center;justify-content:center;\n  font-size:10px;font-family:var(--mono);font-weight:700;\n}\n.bead.t{background:var(--tai2);color:var(--tai);border:1px solid var(--tai3)}\n.bead.x{background:var(--xiu2);color:var(--xiu);border:1px solid var(--xiu3)}\n\n/* AUTO BTN */\n.auto-btn{\n  width:100%;padding:14px;border-radius:var(--r);font-size:15px;font-weight:700;\n  border:none;cursor:pointer;font-family:var(--sans);\n  display:flex;align-items:center;justify-content:center;gap:8px;\n  transition:all .2s;letter-spacing:.5px;\n}\n.auto-btn.start{background:var(--tai);color:#000}\n.auto-btn.start:active{background:#2cc47a}\n.auto-btn.stop{background:var(--xiu2);color:var(--xiu);border:1px solid var(--xiu3)}\n\n/* PULSE */\n@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}\n.pulse{animation:pulse 1.5s infinite}\n\n/* LOGS */\n.log-wrap{height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:2px}\n.log-item{display:grid;grid-template-columns:52px 1fr;gap:8px;padding:4px 2px;border-radius:4px}\n.log-item:hover{background:var(--s2)}\n.log-t{font-family:var(--mono);font-size:10px;color:var(--t3);padding-top:1px}\n.log-m{font-size:12px;line-height:1.5;word-break:break-word}\n\n/* FORM */\n.field{margin-bottom:14px}\n.field label{display:block;font-size:11px;font-weight:600;color:var(--t2);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px}\n.field input,.field select{\n  width:100%;background:var(--s2);border:1px solid var(--b1);border-radius:var(--r2);\n  padding:10px 12px;color:var(--t1);font-size:14px;font-family:var(--mono);outline:none;\n  transition:border .2s;\n}\n.field input:focus,.field select:focus{border-color:var(--blue)}\n.field select option{background:var(--s2)}\n.toggle-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}\n.toggle-row label{font-size:13px;color:var(--t1)}\n.tog{padding:5px 14px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;border:none;font-family:var(--mono);transition:all .2s}\n.tog.on{background:var(--tai2);color:var(--tai);border:1px solid var(--tai3)}\n.tog.off{background:var(--s3);color:var(--t2);border:1px solid var(--b1)}\n.save-btn{\n  width:100%;padding:12px;border-radius:var(--r);background:var(--blue);\n  color:#000;font-size:14px;font-weight:700;border:none;cursor:pointer;font-family:var(--sans);\n}\n.err-msg{color:var(--xiu);font-size:13px;margin:6px 0;min-height:18px;font-family:var(--mono)}\n\n/* LOGIN */\n.login-wrap{max-width:360px;margin:40px auto}\n.login-title{font-size:20px;font-weight:700;margin-bottom:4px}\n.login-sub{font-size:13px;color:var(--t2);margin-bottom:20px}\n\n/* CHIP */\n.chip{display:inline-block;font-family:var(--mono);font-size:10px;padding:2px 7px;border-radius:4px;background:var(--gold2);color:var(--gold);border:1px solid rgba(227,179,65,.3)}\n.chip.blue{background:var(--blue2);color:var(--blue);border-color:rgba(88,166,255,.3)}\n.chip.purple{background:rgba(188,140,255,.1);color:var(--purple);border-color:rgba(188,140,255,.3)}\n\n/* SESSION BADGE */\n.session-badge{\n  display:flex;align-items:center;gap:6px;\n  font-family:var(--mono);font-size:11px;color:var(--t2);\n}\n.session-badge .s-dot{width:5px;height:5px;border-radius:50%;background:var(--tai)}\n</style>\n</head>\n<body>\n<div class=\"app\">\n\n<div class=\"topbar\">\n  <div class=\"logo\">AUTO<em>LC</em></div>\n  <div class=\"conn-badge\">\n    <div class=\"conn-dot\" id=\"cDot\" style=\"background:var(--xiu)\"></div>\n    <span id=\"cLabel\">\u0110ang k\u1ebft n\u1ed1i</span>\n  </div>\n</div>\n\n<main>\n<div class=\"view show\" id=\"v-home\">\n\n  <!-- Account hero -->\n  <div class=\"card\">\n    <div class=\"acct-hero\" id=\"acctHero\">\n      <div class=\"acct-nick\" id=\"dNick\">Ch\u01b0a \u0111\u0103ng nh\u1eadp</div>\n      <div class=\"acct-bal\" id=\"dBal\">\u2014</div>\n      <div class=\"acct-bal-label\">S\u1ed1 d\u01b0</div>\n      <div class=\"acct-status status-off\" id=\"dConn\">\n        <span>\u25cf</span><span id=\"dConnTxt\">Ch\u01b0a k\u1ebft n\u1ed1i</span>\n      </div>\n    </div>\n\n    <!-- Prediction -->\n    <div class=\"pred-hero\">\n      <div class=\"pred-big empty\" id=\"dPred\">\u2014</div>\n      <div class=\"conf-bar-wrap\"><div class=\"conf-bar\" id=\"dConfBar\" style=\"width:0%\"></div></div>\n      <div class=\"pred-meta\">\n        <div>Tin c\u1eady <span id=\"dConf\">\u2014</span></div>\n        <div>Ch\u1ebf \u0111\u1ed9 <span id=\"dRegime\">\u2014</span></div>\n        <div><span id=\"dSig\">\u2014</span> t\u00edn hi\u1ec7u</div>\n      </div>\n    </div>\n\n    <!-- Auto control -->\n    <div class=\"card-body\" style=\"padding:14px\">\n      <div class=\"kv\">\n        <span class=\"kv-k\">Tr\u1ea1ng th\u00e1i</span>\n        <span id=\"dAutoStatus\" class=\"kv-v\" style=\"color:var(--t3)\">D\u1eebng</span>\n      </div>\n      <div class=\"kv\">\n        <span class=\"kv-k\">M\u1ee9c c\u01b0\u1ee3c</span>\n        <span class=\"kv-v\" id=\"dAmount\">\u2014</span>\n      </div>\n      <div class=\"kv\" id=\"dX2Row\" style=\"display:none\">\n        <span class=\"kv-k\">G\u1ea5p th\u1ebfp</span>\n        <span class=\"kv-v purple\" id=\"dX2\">\u2014</span>\n      </div>\n      <div class=\"kv\" style=\"border:none;padding-bottom:0\">\n        <span class=\"kv-k\">Phi\u00ean hi\u1ec7n t\u1ea1i</span>\n        <div class=\"session-badge\"><div class=\"s-dot pulse\"></div><span id=\"dSession\">\u2014</span></div>\n      </div>\n    </div>\n\n    <div style=\"padding:0 14px 14px\">\n      <button class=\"auto-btn start\" id=\"autoBtn\" onclick=\"toggleAuto()\">\n        <svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><polygon points=\"5,3 19,12 5,21\"/></svg>\n        B\u1eadt Auto C\u01b0\u1ee3c\n      </button>\n    </div>\n  </div>\n\n  <!-- Stats -->\n  <div class=\"card\">\n    <div class=\"card-head\">\n      <svg width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><polyline points=\"22 12 18 12 15 21 9 3 6 12 2 12\"/></svg>\n      Th\u1ed1ng k\u00ea phi\u00ean\n    </div>\n    <div class=\"card-body\">\n      <div class=\"stat3\">\n        <div class=\"stat-cell\">\n          <div class=\"n\" id=\"dWin\" style=\"color:var(--tai)\">0</div>\n          <div class=\"l\">Th\u1eafng</div>\n        </div>\n        <div class=\"stat-cell\">\n          <div class=\"n\" id=\"dLose\" style=\"color:var(--xiu)\">0</div>\n          <div class=\"l\">Thua</div>\n        </div>\n        <div class=\"stat-cell\">\n          <div class=\"n\" id=\"dPL\" style=\"font-size:15px;color:var(--t2)\">+0</div>\n          <div class=\"l\">P/L (\u0111)</div>\n        </div>\n      </div>\n      <div class=\"beads\" id=\"dBeads\"></div>\n    </div>\n  </div>\n\n</div><!-- v-home -->\n\n<!-- LOGS VIEW -->\n<div class=\"view\" id=\"v-logs\">\n  <div class=\"card\">\n    <div class=\"card-head\">\n      <svg width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z\"/><polyline points=\"14 2 14 8 20 8\"/></svg>\n      Nh\u1eadt k\u00fd ho\u1ea1t \u0111\u1ed9ng\n    </div>\n    <div class=\"card-body\" style=\"padding:8px\">\n      <div class=\"log-wrap\" id=\"logBox\"></div>\n    </div>\n  </div>\n</div>\n\n<!-- CONFIG VIEW -->\n<div class=\"view\" id=\"v-cfg\">\n  <div class=\"card\">\n    <div class=\"card-head\">\n      <svg width=\"13\" height=\"13\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M19.07 4.93l-1.41 1.41M4.93 4.93l1.41 1.41M12 2v2M12 20v2M2 12h2M20 12h2M19.07 19.07l-1.41-1.41M4.93 19.07l1.41-1.41\"/></svg>\n      C\u1ea5u h\u00ecnh Bot\n    </div>\n    <div class=\"card-body\">\n      <div class=\"field\"><label>M\u1ee9c c\u01b0\u1ee3c (\u0111)</label><input id=\"cAmount\" type=\"number\" value=\"1000\" min=\"100\"/></div>\n      <div class=\"field\"><label>Stop-loss (%)</label><input id=\"cStop\" type=\"number\" value=\"30\" min=\"1\" max=\"100\"/></div>\n      <div class=\"field\"><label>C\u1ea7u ch\u1ed1t</label>\n        <select id=\"cSide\">\n          <option value=\"\">\ud83e\udd16 AI t\u1ef1 ch\u1ecdn</option>\n          <option value=\"TAI\">\ud83d\udfe2 Lu\u00f4n T\u00c0I</option>\n          <option value=\"XIU\">\ud83d\udd34 Lu\u00f4n X\u1ec8U</option>\n        </select>\n      </div>\n      <div class=\"toggle-row\">\n        <label>G\u1ea5p th\u1ebfp X2</label>\n        <button class=\"tog off\" id=\"togX2\" onclick=\"toggleX2()\">T\u1eaeT</button>\n      </div>\n      <div id=\"x2Extra\" style=\"display:none\">\n        <div class=\"field\"><label>Gi\u1edbi h\u1ea1n X2 (l\u1ea7n)</label><input id=\"cX2max\" type=\"number\" value=\"5\" min=\"1\" max=\"10\"/></div>\n      </div>\n      <button class=\"save-btn\" onclick=\"saveConfig()\">L\u01b0u c\u1ea5u h\u00ecnh</button>\n    </div>\n  </div>\n</div>\n\n<!-- LOGIN VIEW -->\n<div class=\"view\" id=\"v-login\">\n  <div class=\"login-wrap\">\n    <div class=\"login-title\">\u0110\u0103ng nh\u1eadp</div>\n    <div class=\"login-sub\">K\u1ebft n\u1ed1i t\u00e0i kho\u1ea3n LC79 c\u1ee7a b\u1ea1n</div>\n    <div class=\"card\">\n      <div class=\"card-body\">\n        <div class=\"field\"><label>T\u00ean \u0111\u0103ng nh\u1eadp</label><input id=\"iUser\" placeholder=\"username\" autocomplete=\"username\"/></div>\n        <div class=\"field\"><label>M\u1eadt kh\u1ea9u</label><input id=\"iPass\" type=\"password\" placeholder=\"\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\" autocomplete=\"current-password\"/></div>\n        <div class=\"err-msg\" id=\"loginErr\"></div>\n        <button class=\"save-btn\" onclick=\"doLogin()\">\u0110\u0103ng nh\u1eadp</button>\n        <button onclick=\"doLogout()\" style=\"width:100%;padding:10px;margin-top:8px;background:transparent;border:1px solid var(--b1);color:var(--t2);border-radius:var(--r2);cursor:pointer;font-size:13px\">\u0110\u0103ng xu\u1ea5t</button>\n      </div>\n    </div>\n  </div>\n</div>\n\n</main>\n\n<!-- BOTTOM NAV -->\n<nav class=\"botnav\">\n  <button class=\"active\" id=\"nb-home\" onclick=\"showView('home',this)\">\n    <svg viewBox=\"0 0 24 24\"><path d=\"M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/><polyline points=\"9 22 9 12 15 12 15 22\"/></svg>\n    <span>T\u1ed5ng quan</span>\n  </button>\n  <button id=\"nb-logs\" onclick=\"showView('logs',this)\">\n    <svg viewBox=\"0 0 24 24\"><path d=\"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z\"/><polyline points=\"14 2 14 8 20 8\"/><line x1=\"16\" y1=\"13\" x2=\"8\" y2=\"13\"/><line x1=\"16\" y1=\"17\" x2=\"8\" y2=\"17\"/></svg>\n    <span>Nh\u1eadt k\u00fd</span>\n  </button>\n  <button id=\"nb-cfg\" onclick=\"showView('cfg',this)\">\n    <svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M19.07 4.93l-1.41 1.41M4.93 4.93l1.41 1.41M12 2v2M12 20v2M2 12h2M20 12h2M19.07 19.07l-1.41-1.41M4.93 19.07l1.41-1.41\"/></svg>\n    <span>C\u1ea5u h\u00ecnh</span>\n  </button>\n  <button id=\"nb-login\" onclick=\"showView('login',this)\">\n    <svg viewBox=\"0 0 24 24\"><path d=\"M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2\"/><circle cx=\"12\" cy=\"7\" r=\"4\"/></svg>\n    <span>T\u00e0i kho\u1ea3n</span>\n  </button>\n</nav>\n\n</div>\n<script>\nconst LC={info:'#58a6ff',pred:'#e3b341',result:'#8b949e',win:'#39d98a',lose:'#f85149',bet:'#bc8cff',warn:'#d29922',error:'#f85149'};\nlet st=null,ws=null,x2On=false;\nconst fmt=n=>Number(n||0).toLocaleString('vi-VN');\n\nfunction showView(v,btn){\n  document.querySelectorAll('.view').forEach(d=>d.classList.remove('show'));\n  document.getElementById('v-'+v).classList.add('show');\n  document.querySelectorAll('.botnav button').forEach(b=>b.classList.remove('active'));\n  const nb=document.getElementById('nb-'+v);\n  if(nb)nb.classList.add('active');\n}\n\nfunction connect(){\n  const proto=location.protocol==='https:'?'wss':'ws';\n  ws=new WebSocket(proto+'://'+location.host);\n  ws.onopen=()=>{\n    document.getElementById('cDot').style.background='var(--tai)';\n    document.getElementById('cLabel').textContent='Online';\n  };\n  ws.onclose=()=>{\n    document.getElementById('cDot').style.background='var(--xiu)';\n    document.getElementById('cLabel').textContent='Offline';\n    setTimeout(connect,3000);\n  };\n  ws.onmessage=(e)=>{\n    const msg=JSON.parse(e.data);\n    if(msg.type==='state'){st=msg.data;render()}\n    if(msg.type==='logs'){msg.data.slice(0,50).forEach(l=>addLog(l,false))}\n    if(msg.type==='log'){addLog(msg.data,true)}\n  };\n}\n\nfunction render(){\n  if(!st)return;\n  // Account\n  document.getElementById('dNick').textContent=st.nickname||'\u2014';\n  document.getElementById('dBal').textContent=fmt(st.balance)+'\u0111';\n  const conn=st.connected;\n  const cEl=document.getElementById('dConn');\n  const cTxt=document.getElementById('dConnTxt');\n  cEl.className='acct-status '+(conn?'status-on':'status-off');\n  cTxt.textContent=conn?'\u0110ang k\u1ebft n\u1ed1i':'M\u1ea5t k\u1ebft n\u1ed1i';\n\n  // Prediction\n  const pred=st.lastPred;\n  const pEl=document.getElementById('dPred');\n  if(pred&&pred.pred!=='\u2014'){\n    pEl.textContent=pred.pred;\n    pEl.className='pred-big '+(pred.pred==='TAI'?'tai':'xiu');\n    const pct=Math.max(0,Math.min(100,(pred.conf-50)*2));\n    const bar=document.getElementById('dConfBar');\n    bar.style.width=pct+'%';\n    bar.className='conf-bar '+(pred.pred==='TAI'?'tai':'xiu');\n    document.getElementById('dConf').textContent=pred.conf+'%';\n    document.getElementById('dRegime').textContent=pred.regime||'\u2014';\n    document.getElementById('dSig').textContent=pred.n_active??'0';\n  } else {\n    pEl.textContent='\u2014';pEl.className='pred-big empty';\n  }\n\n  // Auto\n  const running=st.autoRunning;\n  document.getElementById('dAutoStatus').textContent=running?'\u25cf \u0110ANG CH\u1ea0Y':'\u25cb D\u1eebng';\n  document.getElementById('dAutoStatus').style.color=running?'var(--tai)':'var(--t3)';\n  const btn=document.getElementById('autoBtn');\n  if(running){\n    btn.className='auto-btn stop';\n    btn.innerHTML='<svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><rect x=\"6\" y=\"4\" width=\"4\" height=\"16\"/><rect x=\"14\" y=\"4\" width=\"4\" height=\"16\"/></svg> D\u1eebng Auto';\n  } else {\n    btn.className='auto-btn start';\n    btn.innerHTML='<svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"currentColor\"><polygon points=\"5,3 19,12 5,21\"/></svg> B\u1eadt Auto C\u01b0\u1ee3c';\n  }\n  document.getElementById('dAmount').textContent=fmt(st.baseAmount)+'\u0111';\n  document.getElementById('dSession').textContent='#'+(st.sessionId||'\u2014');\n  if(st.x2Enabled){\n    document.getElementById('dX2Row').style.display='flex';\n    document.getElementById('dX2').textContent='Lv.'+st.x2Level+'/'+st.x2MaxLevel;\n  } else {\n    document.getElementById('dX2Row').style.display='none';\n  }\n\n  // Stats\n  document.getElementById('dWin').textContent=st.statWin;\n  document.getElementById('dLose').textContent=st.statLose;\n  const pl=document.getElementById('dPL');\n  const profit=st.statProfit||0;\n  pl.textContent=(profit>=0?'+':'')+fmt(profit);\n  pl.style.color=profit>0?'var(--tai)':profit<0?'var(--xiu)':'var(--t2)';\n  pl.style.fontSize=Math.abs(profit)>=1000000?'12px':Math.abs(profit)>=100000?'14px':'16px';\n\n  // Beads\n  const beads=document.getElementById('dBeads');\n  beads.innerHTML=(st.recentHistory||[]).slice(-20).map(r=>{\n    const t=r==='TAI';\n    return '<div class=\"bead '+(t?'t':'x')+'\">'+(t?'T':'X')+'</div>';\n  }).join('');\n}\n\nconst LOG_COLORS=LC;\nfunction addLog(l,prepend){\n  const box=document.getElementById('logBox');\n  const div=document.createElement('div');\n  div.className='log-item';\n  div.innerHTML='<span class=\"log-t\">'+l.time+'</span><span class=\"log-m\" style=\"color:'+(LOG_COLORS[l.type]||'var(--t1)')+'\">'+l.msg+'</span>';\n  if(prepend)box.insertBefore(div,box.firstChild);\n  else box.appendChild(div);\n  if(box.children.length>200)box.lastChild.remove();\n}\n\nasync function api(path,body){\n  try{\n    const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});\n    return r.json();\n  }catch(e){return{error:e.message}}\n}\n\nasync function doLogin(){\n  const err=document.getElementById('loginErr');\n  err.textContent='';\n  const u=document.getElementById('iUser').value.trim();\n  const p=document.getElementById('iPass').value;\n  if(!u||!p){err.textContent='Nh\u1eadp \u0111\u1ee7 th\u00f4ng tin';return}\n  err.textContent='\u23f3 \u0110ang k\u1ebft n\u1ed1i...';\n  const cfg=getConfig();\n  const res=await api('/api/login',{username:u,password:p,config:cfg});\n  if(res.error){err.textContent='\u274c '+res.error}\n  else{err.textContent='\u2705 Th\u00e0nh c\u00f4ng!';setTimeout(()=>showView('home',null),800)}\n}\n\nasync function doLogout(){\n  await api('/api/logout',{});\n  st=null;\n}\n\nasync function toggleAuto(){\n  if(!st){showView('login',null);return}\n  await api(st.autoRunning?'/api/auto/stop':'/api/auto/start',{});\n}\n\nfunction getConfig(){\n  return{\n    baseAmount:+document.getElementById('cAmount').value||1000,\n    x2Enabled:x2On,\n    x2MaxLevel:+document.getElementById('cX2max').value||5,\n    stopLossPercent:+document.getElementById('cStop').value||30,\n    algoEnabled:true,\n    fixedSide:document.getElementById('cSide').value\n  };\n}\n\nfunction toggleX2(){\n  x2On=!x2On;\n  const btn=document.getElementById('togX2');\n  btn.textContent=x2On?'B\u1eacT':'T\u1eaeT';\n  btn.className='tog '+(x2On?'on':'off');\n  document.getElementById('x2Extra').style.display=x2On?'block':'none';\n}\n\nasync function saveConfig(){\n  if(!st){showView('home',null);return}\n  await api('/api/config',getConfig());\n  showView('home',null);\n  document.getElementById('nb-home').classList.add('active');\n  document.getElementById('nb-cfg').classList.remove('active');\n}\n\nconnect();\n</script>\n</body>\n</html>");
});

server.listen(PORT, () => {
  console.log(`🚀 AutoLC Web chạy tại port ${PORT}`);
});
