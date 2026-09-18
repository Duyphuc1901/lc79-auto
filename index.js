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

// ─── PREDICTION ENGINE (Sequence Analysis: Run/Streak, N-gram Markov, Recency, Regime, Empirical Break, Log-Odds Ensemble) ──

/*
 * Sequence Analysis / Forecasting Reference Engine
 * ------------------------------------------------
 * Pure offline sequence analysis.
 *
 * Input:
 *   history = ['T', 'X', 'T', 'T', 'X', ...]
 *
 * T = Tai
 * X = Xiu
 *
 * Không có:
 * - API
 * - WebSocket
 * - đặt cược
 * - stake
 * - bankroll
 * - auto-bet
 */

// =========================
// BASIC HELPERS
// =========================

function clean(history) {
    if (!Array.isArray(history)) return [];

    return history
        .map(x => String(x).trim().toUpperCase())
        .filter(x => x === 'T' || x === 'X');
}

function opposite(x) {
    return x === 'T' ? 'X' : 'T';
}

function clamp(x, min = 0, max = 1) {
    return Math.max(min, Math.min(max, x));
}

function entropy(seq) {
    seq = clean(seq);

    if (!seq.length) return 0;

    const t = seq.filter(x => x === 'T').length;
    const x = seq.length - t;

    const pT = t / seq.length;
    const pX = x / seq.length;

    let h = 0;

    if (pT > 0) h -= pT * Math.log2(pT);
    if (pX > 0) h -= pX * Math.log2(pX);

    return h;
}


// =========================
// RUN / STREAK ANALYSIS
// =========================

function getRuns(history) {
    const seq = clean(history);

    if (!seq.length) return [];

    const runs = [];

    let current = seq[0];
    let length = 1;

    for (let i = 1; i < seq.length; i++) {
        if (seq[i] === current) {
            length++;
        } else {
            runs.push({
                value: current,
                length
            });

            current = seq[i];
            length = 1;
        }
    }

    runs.push({
        value: current,
        length
    });

    return runs;
}

function analyzeStreak(history) {
    const seq = clean(history);

    if (!seq.length) {
        return {
            value: null,
            length: 0,
            previousLength: 0,
            averageLength: 0,
            maxLength: 0
        };
    }

    const runs = getRuns(seq);

    const current = runs[runs.length - 1];

    const previous =
        runs.length >= 2
            ? runs[runs.length - 2]
            : null;

    const averageLength =
        runs.reduce((sum, r) => sum + r.length, 0) /
        runs.length;

    const maxLength =
        Math.max(...runs.map(r => r.length));

    return {
        value: current.value,
        length: current.length,
        previousLength: previous ? previous.length : 0,
        averageLength,
        maxLength
    };
}


// =========================
// PATTERN DETECTION
// =========================

function detectPatterns(history) {
    const seq = clean(history);

    if (seq.length < 2) {
        return {
            streak: false,
            equalRun: false,
            alternation: false,
            doubleAlternation: false
        };
    }

    const runs = getRuns(seq);

    // Current streak
    const streak = runs.length >= 1 &&
        runs[runs.length - 1].length >= 3;

    // 2-2 pattern:
    // TT XX TT XX
    let equalRun = false;

    if (runs.length >= 4) {
        const last4 = runs.slice(-4);

        const lengths = last4.map(r => r.length);

        equalRun =
            lengths[0] === lengths[1] &&
            lengths[1] === lengths[2] &&
            lengths[2] === lengths[3];
    }

    // T X T X
    const last4 = seq.slice(-4);

    const alternation =
        last4.length === 4 &&
        last4[0] !== last4[1] &&
        last4[1] !== last4[2] &&
        last4[2] !== last4[3];

    // TT XX TT XX
    const doubleAlternation =
        runs.length >= 4 &&
        (() => {
            const r = runs.slice(-4);

            return (
                r[0].length === 2 &&
                r[1].length === 2 &&
                r[2].length === 2 &&
                r[3].length === 2
            );
        })();

    return {
        streak,
        equalRun,
        alternation,
        doubleAlternation
    };
}


// =========================
// N-GRAM PROBABILITY
// =========================

function ngramProbability(history, order = 2, decay = 0.96) {
    const seq = clean(history);

    if (seq.length <= order) {
        return null;
    }

    const context = seq.slice(-order);

    let taiWeight = 0;
    let xiuWeight = 0;

    for (let i = order; i < seq.length; i++) {
        const previous = seq.slice(i - order, i);

        if (
            previous.length !== context.length ||
            previous.some((v, j) => v !== context[j])
        ) {
            continue;
        }

        const distance = seq.length - i;

        const weight = Math.pow(decay, distance);

        if (seq[i] === 'T') {
            taiWeight += weight;
        } else {
            xiuWeight += weight;
        }
    }

    const total = taiWeight + xiuWeight;

    if (total === 0) {
        return null;
    }

    return {
        T: taiWeight / total,
        X: xiuWeight / total,
        samples: taiWeight + xiuWeight
    };
}


// =========================
// MARKOV ENSEMBLE
// =========================

function markovProbability(history, maxOrder = 4) {
    const seq = clean(history);

    const results = [];

    for (
        let order = 1;
        order <= maxOrder;
        order++
    ) {
        const result = ngramProbability(
            seq,
            order
        );

        if (result) {
            results.push({
                order,
                ...result
            });
        }
    }

    if (!results.length) {
        return {
            T: 0.5,
            X: 0.5,
            orders: []
        };
    }

    let weightedT = 0;
    let weightedX = 0;
    let totalWeight = 0;

    for (const r of results) {
        /*
         * Lower-order Markov:
         * more stable with little data.
         *
         * Higher-order:
         * more specific but easier to overfit.
         */
        const weight = 1 / r.order;

        weightedT += r.T * weight;
        weightedX += r.X * weight;

        totalWeight += weight;
    }

    return {
        T: weightedT / totalWeight,
        X: weightedX / totalWeight,
        orders: results
    };
}


// =========================
// RECENCY / LOCAL BIAS
// =========================

function recencyProbability(
    history,
    window = 20,
    halfLife = 8
) {
    const seq = clean(history);

    const start = Math.max(
        0,
        seq.length - window
    );

    let tWeight = 0;
    let xWeight = 0;

    for (
        let i = start;
        i < seq.length;
        i++
    ) {
        const distance =
            seq.length - 1 - i;

        const weight =
            Math.pow(
                0.5,
                distance / halfLife
            );

        if (seq[i] === 'T') {
            tWeight += weight;
        } else {
            xWeight += weight;
        }
    }

    const total =
        tWeight + xWeight;

    if (!total) {
        return {
            T: 0.5,
            X: 0.5
        };
    }

    return {
        T: tWeight / total,
        X: xWeight / total
    };
}


// =========================
// SWITCH RATE
// =========================

function switchRate(history, window = 20) {
    const seq = clean(history);

    if (seq.length < 2) return 0;

    const start =
        Math.max(1, seq.length - window);

    let switches = 0;
    let comparisons = 0;

    for (let i = start; i < seq.length; i++) {
        comparisons++;

        if (seq[i] !== seq[i - 1]) {
            switches++;
        }
    }

    return comparisons
        ? switches / comparisons
        : 0;
}


// =========================
// REGIME DETECTION
// =========================

function detectRegime(history) {
    const seq = clean(history);

    if (seq.length < 8) {
        return 'UNKNOWN';
    }

    const rate = switchRate(seq, 20);

    const t =
        seq.filter(x => x === 'T').length /
        seq.length;

    const x = 1 - t;

    const bias =
        Math.abs(t - x);

    /*
     * High switch rate:
     * likely alternating / choppy.
     */
    if (rate >= 0.65) {
        return 'ZIGZAG';
    }

    /*
     * Strong global imbalance.
     */
    if (bias >= 0.25) {
        return 'BIASED';
    }

    /*
     * Low switch rate:
     * longer runs.
     */
    if (rate <= 0.30) {
        return 'STREAK';
    }

    return 'CHOPPY';
}


// =========================
// EMPIRICAL STREAK BREAK
// =========================

function empiricalBreak(
    history,
    minRun = 3
) {
    const seq = clean(history);
    const runs = getRuns(seq);

    const breakStats = {};

    for (let i = 0; i < runs.length - 1; i++) {
        const run = runs[i];

        if (run.length < minRun) {
            continue;
        }

        const next = runs[i + 1];

        if (!breakStats[run.length]) {
            breakStats[run.length] = {
                total: 0,
                broke: 0,
                continued: 0
            };
        }

        breakStats[run.length].total++;

        if (next.value !== run.value) {
            breakStats[run.length].broke++;
        } else {
            breakStats[run.length].continued++;
        }
    }

    const current =
        runs.length
            ? runs[runs.length - 1]
            : null;

    if (!current) {
        return {
            currentRun: 0,
            probabilityBreak: 0.5,
            stats: breakStats
        };
    }

    const exact =
        breakStats[current.length];

    if (!exact || exact.total === 0) {
        return {
            currentRun: current.length,
            probabilityBreak: 0.5,
            stats: breakStats
        };
    }

    return {
        currentRun: current.length,

        probabilityBreak:
            exact.broke / exact.total,

        stats: breakStats
    };
}


// =========================
// SIMPLE SIGNALS
// =========================

function signalStreakFollow(history) {
    const seq = clean(history);

    if (!seq.length) {
        return {
            T: 0.5,
            X: 0.5
        };
    }

    const last = seq[seq.length - 1];

    return last === 'T'
        ? { T: 0.65, X: 0.35 }
        : { T: 0.35, X: 0.65 };
}

function signalStreakBreak(history) {
    const seq = clean(history);

    if (!seq.length) {
        return {
            T: 0.5,
            X: 0.5
        };
    }

    const last = seq[seq.length - 1];

    return last === 'T'
        ? { T: 0.35, X: 0.65 }
        : { T: 0.65, X: 0.35 };
}

function signalAlternation(history) {
    const seq = clean(history);

    if (seq.length < 2) {
        return {
            T: 0.5,
            X: 0.5
        };
    }

    const last = seq[seq.length - 1];

    return last === 'T'
        ? { T: 0.35, X: 0.65 }
        : { T: 0.65, X: 0.35 };
}


// =========================
// LOG-ODDS ENSEMBLE
// =========================

function probabilityToLogOdds(p) {
    p = clamp(p, 0.001, 0.999);

    return Math.log(
        p / (1 - p)
    );
}

function logOddsToProbability(logOdds) {
    return 1 / (
        1 + Math.exp(-logOdds)
    );
}

function combineSignals(signals) {
    if (!Array.isArray(signals) || !signals.length) {
        return {
            T: 0.5,
            X: 0.5
        };
    }

    let score = 0;
    let totalWeight = 0;

    for (const signal of signals) {
        if (!signal || !signal.probability) {
            continue;
        }

        const p =
            clamp(signal.probability.T);

        const weight =
            Number.isFinite(signal.weight)
                ? signal.weight
                : 1;

        score +=
            probabilityToLogOdds(p) *
            weight;

        totalWeight += weight;
    }

    if (!totalWeight) {
        return {
            T: 0.5,
            X: 0.5
        };
    }

    score /= totalWeight;

    const pT =
        logOddsToProbability(score);

    return {
        T: pT,
        X: 1 - pT
    };
}


// =========================
// MAIN ANALYSIS
// =========================

function analyzeSequence(history) {
    const seq = clean(history);

    if (!seq.length) {
        return {
            prediction: null,
            probabilities: {
                T: 0.5,
                X: 0.5
            },
            confidence: 0,
            regime: 'UNKNOWN',
            patterns: {},
            signals: [],
            streak: {},
            empiricalBreak: {},
            switchRate12: 0,
            entropy: 0
        };
    }

    const signals = [];

    // Markov
    const markov = markovProbability(
        seq,
        4
    );

    signals.push({
        name: 'MARKOV',
        probability: {
            T: markov.T,
            X: markov.X
        },
        weight: 1.4
    });

    // Recency
    const recency =
        recencyProbability(
            seq,
            20,
            8
        );

    signals.push({
        name: 'RECENCY',
        probability: recency,
        weight: 0.8
    });

    // Streak follow
    signals.push({
        name: 'STREAK_FOLLOW',
        probability:
            signalStreakFollow(seq),
        weight: 0.35
    });

    // Streak break
    signals.push({
        name: 'STREAK_BREAK',
        probability:
            signalStreakBreak(seq),
        weight: 0.35
    });

    // Alternation
    signals.push({
        name: 'ALTERNATION',
        probability:
            signalAlternation(seq),
        weight: 0.25
    });

    const combined =
        combineSignals(signals);

    const prediction =
        combined.T >= combined.X
            ? 'T'
            : 'X';

    const confidence =
        Math.abs(
            combined.T -
            combined.X
        );

    return {
        prediction,

        probabilities: {
            T: Number(
                combined.T.toFixed(4)
            ),

            X: Number(
                combined.X.toFixed(4)
            )
        },

        confidence: Number(
            confidence.toFixed(4)
        ),

        regime:
            detectRegime(seq),

        patterns:
            detectPatterns(seq),

        signals,

        streak:
            analyzeStreak(seq),

        empiricalBreak:
            empiricalBreak(seq),

        switchRate12:
            switchRate(seq, 12),

        entropy:
            Number(
                entropy(seq).toFixed(4)
            )
    };
}


// =========================
// WALK-FORWARD BACKTEST
// =========================

function walkForwardBacktest(
    history,
    minTrain = 30
) {
    const seq = clean(history);

    const results = [];

    if (seq.length <= minTrain) {
        return {
            total: 0,
            correct: 0,
            accuracy: 0,
            results
        };
    }

    for (
        let i = minTrain;
        i < seq.length;
        i++
    ) {
        const train =
            seq.slice(0, i);

        const actual =
            seq[i];

        const analysis =
            analyzeSequence(train);

        const predicted =
            analysis.prediction;

        const correct =
            predicted === actual;

        results.push({
            index: i,
            predicted,
            actual,
            correct,
            confidence:
                analysis.confidence,
            regime:
                analysis.regime
        });
    }

    const correct =
        results.filter(
            r => r.correct
        ).length;

    const total =
        results.length;

    return {
        total,

        correct,

        accuracy:
            total
                ? correct / total
                : 0,

        results
    };
}


// =========================
// CONFIDENCE BUCKETS
// =========================

function confidenceBuckets(backtest) {
    if (
        !backtest ||
        !Array.isArray(backtest.results)
    ) {
        return [];
    }

    const buckets = [
        {
            name: '0-10%',
            min: 0,
            max: 0.10
        },
        {
            name: '10-20%',
            min: 0.10,
            max: 0.20
        },
        {
            name: '20-30%',
            min: 0.20,
            max: 0.30
        },
        {
            name: '30-40%',
            min: 0.30,
            max: 0.40
        },
        {
            name: '40-50%',
            min: 0.40,
            max: 0.50
        }
    ];

    return buckets.map(bucket => {
        const items =
            backtest.results.filter(
                r =>
                    r.confidence >= bucket.min &&
                    r.confidence < bucket.max
            );

        const correct =
            items.filter(
                r => r.correct
            ).length;

        return {
            bucket: bucket.name,
            total: items.length,
            correct,
            accuracy:
                items.length
                    ? correct / items.length
                    : null
        };
    });
}




// ── NHẬN DIỆN LOẠI CẦU (để hiển thị UI) ─────────────────────────────────────
function identifyRoadType(history) {
  const seq = clean(history);
  if (seq.length < 4) return { type: 'Chưa đủ dữ liệu', code: 'NONE' };

  const patterns = detectPatterns(seq);
  const streak = analyzeStreak(seq);
  const runs = getRuns(seq);

  // Cầu bệt (streak dài)
  if (streak.length >= 5) {
    return { type: `Cầu bệt ${streak.value === 'T' ? 'TÀI' : 'XỈU'} (${streak.length} phiên)`, code: 'BET', value: streak.value };
  }
  if (streak.length >= 3) {
    return { type: `Bắt đầu bệt ${streak.value === 'T' ? 'TÀI' : 'XỈU'} (${streak.length} phiên)`, code: 'BET_START', value: streak.value };
  }

  // Cầu 2-2 đều
  if (patterns.doubleAlternation) {
    return { type: 'Cầu 2-2 (đều đặn)', code: 'PAIR' };
  }

  // Cầu 1-1 (xen kẽ)
  if (patterns.alternation) {
    return { type: 'Cầu 1-1 (xen kẽ)', code: 'ALT' };
  }

  // Cầu đều theo độ dài run
  if (patterns.equalRun && runs.length >= 4) {
    const len = runs[runs.length-1].length;
    return { type: `Cầu đều ${len}-${len}`, code: 'EQUAL', len };
  }

  return { type: 'Cầu loạn (không rõ mẫu)', code: 'CHOPPY' };
}

// ── TÂM LÝ BẺ CẦU ────────────────────────────────────────────────────────────
// Người chơi thực tế có xu hướng "bẻ cầu" (đặt ngược) khi thấy streak dài,
// khiến cầu bệt thường gãy sớm hơn xác suất lý thuyết thuần Markov.
// Signal này dùng empiricalBreak (thống kê thật của chính lịch sử) làm chủ đạo,
// rồi cộng thêm một độ lệch tâm lý tăng dần theo độ dài streak hiện tại.
function signalBreakPsychology(history) {
  const seq = clean(history);
  if (seq.length < 8) return { T: 0.5, X: 0.5 };

  const streak = analyzeStreak(seq);
  const eb = empiricalBreak(seq, 3);

  // Không có streak đáng kể → trung lập
  if (streak.length < 3) return { T: 0.5, X: 0.5 };

  // Xác suất bẻ cầu thực nghiệm (từ chính lịch sử, không giả định)
  let pBreak = eb.probabilityBreak;

  // Điều chỉnh tâm lý: streak càng dài, người chơi càng có xu hướng bẻ,
  // nhà cái cũng có xu hướng "cắt cầu" ở các mốc tâm lý (4, 6, 8...).
  // Tăng nhẹ pBreak khi streak vượt các mốc này, nhưng KHÔNG áp đặt nếu
  // dữ liệu thực tế (eb) không ủng hộ — chỉ dùng như hệ số điều chỉnh nhỏ.
  const psychMilestones = [4, 6, 8, 10];
  let psychBoost = 0;
  for (const m of psychMilestones) {
    if (streak.length >= m) psychBoost += 0.03; // mỗi mốc vượt qua +3%
  }
  pBreak = clamp(pBreak + psychBoost, 0.05, 0.95);

  const breakSide = opposite(streak.value); // bên sẽ ra nếu cầu gãy
  return breakSide === 'T'
    ? { T: pBreak, X: 1 - pBreak }
    : { T: 1 - pBreak, X: pBreak };
}

// ── DỰ ĐOÁN CHÍNH: chuyển đổi TAI/XIU ↔ T/X, thêm tâm lý bẻ vào ensemble ────
function _toTX(v) { return v === 'TAI' ? 'T' : 'X'; }
function _fromTX(v) { return v === 'T' ? 'TAI' : 'XIU'; }

function predictNext(history) {
  const seqTX = history.map(_toTX);

  if (seqTX.length < 8) {
    const pred = seqTX.length === 0
      ? (Math.random() < 0.5 ? 'TAI' : 'XIU')
      : _fromTX(seqTX.filter(v=>v==='T').length >= seqTX.length/2 ? 'T' : 'X');
    return { pred, conf: 51, n_active: 0, regime: 'INIT', road: 'Chưa đủ dữ liệu', note: `Dữ liệu mỏng (${seqTX.length} phiên)` };
  }

  // Chạy engine chính (Markov + Recency + Streak Follow/Break + Alternation)
  const analysis = analyzeSequence(seqTX);

  // Thêm signal tâm lý bẻ cầu vào ensemble log-odds
  const breakPsych = signalBreakPsychology(seqTX);
  const allSignals = [
    ...analysis.signals,
    { name: 'BREAK_PSYCH', probability: breakPsych, weight: 1.1 }
  ];
  const combined = combineSignals(allSignals);

  const pred = _fromTX(combined.T >= combined.X ? 'T' : 'X');
  const confRaw = Math.abs(combined.T - combined.X); // 0..1
  // Hiệu chỉnh confidence về thang thực tế 50-65% (tránh ảo tưởng quá tin)
  const conf = Math.round(50 + Math.min(confRaw / 0.30, 1.0) * 15);

  const road = identifyRoadType(seqTX);

  return {
    pred,
    conf: Math.max(50, Math.min(65, conf)),
    p_tai: +combined.T.toFixed(3),
    n_active: allSignals.length,
    signals: allSignals.map(s => `${s.name}:${Math.round((s.probability.T)*100)}%`),
    regime: analysis.regime,
    road: road.type,
    roadCode: road.code,
    streakInfo: analysis.streak,
    breakProbability: +breakPsych[combined.T >= combined.X ? 'T' : 'X'].toFixed(2),
    entropy: analysis.entropy,
  };
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
    this.maxWinStreak = 0;
    this.maxLoseStreak = 0;
    this.currentWinStreak = 0;
    this.currentLoseStreak = 0;
    this.betHistory = []; // [{time, result, amount, hour}]
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
          // Stop-loss: chỉ kích hoạt khi balance > 0 và stopLossPercent < 1.0 (không phải 100%)
          if (this.stopLossPercent < 1.0 && this.balance > 0 && 
              this.statProfit < 0 && Math.abs(this.statProfit) > this.balance * this.stopLossPercent) {
            addLog('warn', `⚠️ Stop-loss kích hoạt (lỗ ${Math.round(this.stopLossPercent*100)}%). Dừng auto.`);
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
        addLog('pred', `🔮 Phiên #${this.sessionId} | AI: ${pred.pred} (${pred.conf}%) | ${pred.road||pred.regime} | Bẻ cầu: ${Math.round((pred.breakProbability||0.5)*100)}%`);
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
            this.currentLoseStreak++;
            this.currentWinStreak = 0;
            if (this.currentLoseStreak > this.maxLoseStreak) this.maxLoseStreak = this.currentLoseStreak;
            const _now2 = new Date();
            const _hStr2 = _now2.toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',hour:'2-digit'}).replace(/[^0-9]/g,'').padStart(2,'0');
            this.betHistory.push({ time: Date.now(), result: 'lose', amount: _betAmt, hour: _hStr2+'h' });
            if (this.betHistory.length > 500) this.betHistory.shift();
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
      if (won) {
        this.statWin++;
        this.statProfit += profit;
        this.currentWinStreak++;
        this.currentLoseStreak = 0;
        if (this.currentWinStreak > this.maxWinStreak) this.maxWinStreak = this.currentWinStreak;
        const _now = new Date();
        const _hStr = _now.toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',hour:'2-digit'}).replace(/[^0-9]/g,'').padStart(2,'0');
        this.betHistory.push({ time: Date.now(), result: 'win', amount: profit, hour: _hStr+'h' });
        if (this.betHistory.length > 500) this.betHistory.shift();
      }

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
      maxWinStreak: this.maxWinStreak,
      maxLoseStreak: this.maxLoseStreak,
      currentWinStreak: this.currentWinStreak,
      currentLoseStreak: this.currentLoseStreak,
      betHistory: this.betHistory.slice(-200),
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

/* ── ANIMATIONS ── */
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
@keyframes glow{0%,100%{text-shadow:0 0 20px currentColor}50%{text-shadow:0 0 40px currentColor,0 0 80px currentColor}}
@keyframes countUp{from{transform:scale(.8);opacity:0}to{transform:scale(1);opacity:1}}
@keyframes barGrow{from{width:0}to{width:var(--w)}}
@keyframes ripple{0%{transform:scale(0);opacity:.6}100%{transform:scale(2.5);opacity:0}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes flash{0%,100%{opacity:1}50%{opacity:.2}}

.fade-in{animation:fadeIn .4s ease both}
.slide-up{animation:slideUp .3s ease both}
.pulse{animation:pulse 1.5s infinite}
.glow{animation:glow 2s ease-in-out infinite}
.count-up{animation:countUp .4s cubic-bezier(.34,1.56,.64,1) both}

/* ── LAYOUT ── */
.app{display:flex;flex-direction:column;min-height:100vh}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:0 16px;height:48px;background:rgba(13,17,23,.95);border-bottom:1px solid var(--b1);position:sticky;top:0;z-index:100;backdrop-filter:blur(8px)}
.logo{font-family:var(--mono);font-weight:700;font-size:15px;letter-spacing:3px}
.logo em{color:var(--gold);font-style:normal}
.conn-badge{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--t2);font-family:var(--mono)}
.conn-dot{width:6px;height:6px;border-radius:50%;transition:background .5s}

.botnav{position:fixed;bottom:0;left:0;right:0;display:flex;background:rgba(13,17,23,.95);border-top:1px solid var(--b1);z-index:100;backdrop-filter:blur(8px)}
.botnav button{flex:1;padding:10px 4px 12px;background:transparent;border:none;color:var(--t3);font-size:10px;font-family:var(--sans);display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;transition:color .2s;position:relative;overflow:hidden}
.botnav button.active{color:var(--blue)}
.botnav button.active::after{content:'';position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:20px;height:2px;background:var(--blue);border-radius:2px}
.botnav button svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:1.5;transition:transform .2s}
.botnav button:active svg{transform:scale(.85)}

main{flex:1;padding:12px 14px;padding-bottom:72px;max-width:600px;margin:0 auto;width:100%}
.view{display:none}.view.show{display:block}

/* ── CARDS ── */
.card{background:var(--s1);border:1px solid var(--b1);border-radius:var(--r);overflow:hidden;margin-bottom:12px;transition:border-color .3s}
.card-head{padding:10px 14px;font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:var(--t2);border-bottom:1px solid var(--b1);background:var(--s2);display:flex;align-items:center;gap:6px}
.card-body{padding:14px}

/* ── ACCOUNT HERO ── */
.acct-hero{padding:20px 16px;background:linear-gradient(135deg,var(--s2),var(--s1));border-bottom:1px solid var(--b1)}
.acct-nick{font-size:18px;font-weight:700;margin-bottom:4px}
.acct-bal{font-family:var(--mono);font-size:32px;font-weight:700;color:var(--gold);line-height:1;transition:all .4s}
.acct-bal-label{font-size:11px;color:var(--t2);margin-top:2px}
.acct-status{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-family:var(--mono);padding:3px 8px;border-radius:20px;margin-top:8px;transition:all .3s}
.status-on{background:var(--tai2);color:var(--tai);border:1px solid var(--tai3)}
.status-off{background:var(--xiu2);color:var(--xiu);border:1px solid var(--xiu3)}

/* ── PREDICTION ── */
.pred-hero{padding:24px 16px;text-align:center;background:linear-gradient(180deg,var(--s2),var(--s1));position:relative;overflow:hidden}
.pred-big{font-family:var(--mono);font-weight:700;font-size:60px;line-height:1;letter-spacing:4px;margin-bottom:8px;transition:all .4s;position:relative;z-index:1}
.pred-big.tai{color:var(--tai);animation:glow 2s ease-in-out infinite}
.pred-big.xiu{color:var(--xiu);animation:glow 2s ease-in-out infinite}
.pred-big.empty{color:var(--t3);font-size:32px;animation:none}
.conf-bar-wrap{width:200px;margin:0 auto 12px;height:4px;background:var(--s3);border-radius:2px;overflow:hidden}
.conf-bar{height:100%;border-radius:2px;transition:width .8s cubic-bezier(.34,1.56,.64,1)}
.conf-bar.tai{background:linear-gradient(90deg,var(--tai),#00ff9d)}
.conf-bar.xiu{background:linear-gradient(90deg,var(--xiu),#ff8080)}
.pred-meta{display:flex;justify-content:center;gap:20px;font-size:12px;color:var(--t2)}
.pred-meta span{font-family:var(--mono)}

/* ── KV ROWS ── */
.kv{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--b1);transition:background .15s}
.kv:last-child{border:none}
.kv:active{background:var(--s2)}
.kv-k{color:var(--t2);font-size:13px}
.kv-v{font-family:var(--mono);font-size:13px;text-align:right}

/* ── AUTO BTN ── */
.auto-btn{width:100%;padding:15px;border-radius:var(--r);font-size:15px;font-weight:700;border:none;cursor:pointer;font-family:var(--sans);display:flex;align-items:center;justify-content:center;gap:8px;transition:all .25s;letter-spacing:.5px;position:relative;overflow:hidden}
.auto-btn::after{content:'';position:absolute;inset:0;background:rgba(255,255,255,.1);opacity:0;transition:opacity .2s}
.auto-btn:active::after{opacity:1}
.auto-btn.start{background:var(--tai);color:#000;box-shadow:0 4px 20px rgba(57,217,138,.3)}
.auto-btn.start:hover{box-shadow:0 6px 30px rgba(57,217,138,.5)}
.auto-btn.stop{background:var(--xiu2);color:var(--xiu);border:1px solid var(--xiu3)}

/* ── STATS ── */
.stat3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px}
.stat-cell{background:var(--s2);border:1px solid var(--b1);border-radius:var(--r2);padding:12px 8px;text-align:center;transition:transform .2s,border-color .3s}
.stat-cell:active{transform:scale(.96)}
.stat-cell .n{font-family:var(--mono);font-weight:700;font-size:22px;line-height:1;margin-bottom:4px}
.stat-cell .l{font-size:10px;color:var(--t2);text-transform:uppercase;letter-spacing:.5px}

.stat2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px}
.streak-cell{background:var(--s2);border:1px solid var(--b1);border-radius:var(--r2);padding:10px 12px;display:flex;justify-content:space-between;align-items:center}
.streak-label{font-size:12px;color:var(--t2)}
.streak-val{font-family:var(--mono);font-weight:700;font-size:18px}

/* ── BEADS ── */
.beads{display:flex;flex-wrap:wrap;gap:5px}
.bead{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-family:var(--mono);font-weight:700;transition:transform .15s}
.bead:active{transform:scale(.85)}
.bead.t{background:var(--tai2);color:var(--tai);border:1px solid var(--tai3)}
.bead.x{background:var(--xiu2);color:var(--xiu);border:1px solid var(--xiu3)}
.bead.new{animation:countUp .4s cubic-bezier(.34,1.56,.64,1) both}

/* ── CHART ── */
.chart-wrap{position:relative;height:120px;margin-top:8px}
.chart-svg{width:100%;height:100%}
.chart-tooltip{position:absolute;background:var(--s1);border:1px solid var(--b1);border-radius:6px;padding:4px 8px;font-size:11px;font-family:var(--mono);pointer-events:none;opacity:0;transition:opacity .2s;white-space:nowrap}

/* ── HOURLY CHART ── */
.hour-chart{display:flex;align-items:flex-end;gap:3px;height:80px;padding:0 2px}
.hour-bar-wrap{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;cursor:pointer}
.hour-bar{width:100%;border-radius:3px 3px 0 0;transition:height .6s cubic-bezier(.34,1.56,.64,1),background .3s;position:relative;min-height:2px}
.hour-label{font-size:8px;font-family:var(--mono);color:var(--t3);white-space:nowrap}
.chart-legend{display:flex;gap:12px;margin-top:8px;justify-content:center}
.legend-item{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--t2)}
.legend-dot{width:8px;height:8px;border-radius:2px}

/* ── FORM ── */
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
.save-btn{width:100%;padding:12px;border-radius:var(--r);background:var(--blue);color:#000;font-size:14px;font-weight:700;border:none;cursor:pointer;font-family:var(--sans);transition:all .2s}
.save-btn:active{transform:scale(.98)}
.err-msg{color:var(--xiu);font-size:13px;margin:6px 0;min-height:18px;font-family:var(--mono)}
.login-wrap{max-width:360px;margin:40px auto}
.login-title{font-size:20px;font-weight:700;margin-bottom:4px}
.login-sub{font-size:13px;color:var(--t2);margin-bottom:20px}
.session-badge{display:flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;color:var(--t2)}
.session-badge .s-dot{width:5px;height:5px;border-radius:50%;background:var(--tai)}

/* ── RANK ── */
.rank-list{display:flex;flex-direction:column;gap:6px}
.rank-item{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--s2);border-radius:var(--r2);border:1px solid var(--b1);cursor:pointer;transition:all .2s}
.rank-item:active{transform:scale(.98)}
.rank-item.selected{border-color:var(--blue);background:var(--blue2)}
.rank-item.best{border-color:var(--tai)}
.rank-name{font-size:13px;font-weight:500}
.rank-acc{font-family:var(--mono);font-size:12px}
.rank-badge{font-size:10px;padding:2px 6px;border-radius:4px;margin-left:6px}
.badge-best{background:var(--tai2);color:var(--tai);border:1px solid var(--tai3)}
.badge-good{background:var(--blue2);color:var(--blue);border:1px solid rgba(88,166,255,.3)}
.rank-loading{color:var(--t2);font-size:13px;padding:12px 0;text-align:center;font-family:var(--mono)}

/* ── LOG ── */
.log-wrap{height:300px;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
.log-item{display:grid;grid-template-columns:52px 1fr;gap:8px;padding:4px 2px;border-radius:4px;animation:fadeIn .3s ease both}
.log-t{font-family:var(--mono);font-size:10px;color:var(--t3);padding-top:1px}
.log-m{font-size:12px;line-height:1.5;word-break:break-word}
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
  <div class="card fade-in">
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
        <div>Cầu <span id="dRegime">—</span></div>
        <div><span id="dSig">—</span> model</div>
      </div>
      <div id="dReason" style="font-size:11px;color:var(--t3);margin-top:8px;font-family:var(--mono);padding:0 8px;text-align:center;min-height:16px"></div>
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

  <!-- STATS -->
  <div class="card fade-in" style="animation-delay:.1s">
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
      <div class="stat2">
        <div class="streak-cell">
          <div><div class="streak-label">🔥 Chuỗi thắng dài nhất</div><div style="font-size:10px;color:var(--t3);margin-top:2px">Hiện tại: <span id="dCurWin" style="color:var(--tai);font-family:var(--mono)">0</span></div></div>
          <div class="streak-val" id="dMaxWin" style="color:var(--tai)">0</div>
        </div>
        <div class="streak-cell">
          <div><div class="streak-label">💔 Chuỗi thua dài nhất</div><div style="font-size:10px;color:var(--t3);margin-top:2px">Hiện tại: <span id="dCurLose" style="color:var(--xiu);font-family:var(--mono)">0</span></div></div>
          <div class="streak-val" id="dMaxLose" style="color:var(--xiu)">0</div>
        </div>
      </div>
      <div class="beads" id="dBeads"></div>
    </div>
  </div>

  <!-- CHART -->
  <div class="card fade-in" style="animation-delay:.2s">
    <div class="card-head">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
      Biểu đồ theo giờ
    </div>
    <div class="card-body">
      <div class="hour-chart" id="hourChart"></div>
      <div class="chart-legend">
        <div class="legend-item"><div class="legend-dot" style="background:var(--tai)"></div>Thắng</div>
        <div class="legend-item"><div class="legend-dot" style="background:var(--xiu)"></div>Thua</div>
      </div>
      <div id="chartEmpty" style="text-align:center;color:var(--t3);font-size:12px;padding:20px 0;display:none">Chưa có dữ liệu</div>
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
  <div class="card">
    <div class="card-head">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      Thông tin Engine
    </div>
    <div class="card-body">
      <div style="font-size:13px;color:var(--t2);line-height:1.6">
        <div style="margin-bottom:8px">🧠 <span style="color:var(--t1);font-weight:600">Sequence Analysis Engine</span></div>
        <div>• Run/Streak analysis — theo dõi độ dài chuỗi hiện tại, trung bình, tối đa</div>
        <div>• Nhận diện cầu: bệt, 1-1 (xen kẽ), 2-2 (đều), cầu đều theo độ dài</div>
        <div>• N-gram Markov bậc 1-4 kết hợp trọng số (bậc thấp ổn định, bậc cao chi tiết hơn)</div>
        <div>• Recency weighting — nửa chu kỳ 8 phiên, cửa sổ 20 phiên gần nhất</div>
        <div>• Switch-rate / Regime: STREAK / ZIGZAG / BIASED / CHOPPY</div>
        <div>• Empirical Break — xác suất gãy cầu tính từ chính lịch sử thật, không giả định</div>
        <div>• Tâm lý bẻ cầu — cộng thêm độ lệch tăng dần ở các mốc streak 4/6/8/10</div>
        <div>• Ensemble bằng log-odds (không cộng vote 0/1 thô)</div>
        <div style="margin-top:8px;color:var(--t3);font-size:11px;font-family:var(--mono)" id="engineStatus">Đang khởi động...</div>
      </div>
    </div>
  </div>
</div>

<!-- LOGIN -->
<div class="view" id="v-login">
  <div class="login-wrap">
    <div class="login-title">Đăng nhập</div>
    <div class="login-sub">Kết nối tài khoản LC79 của bạn</div>
    <div class="card"><div class="card-body">
      <div class="field"><label>Tên đăng nhập</label><input id="iUser" placeholder="username" autocomplete="username"/></div>
      <div class="field"><label>Mật khẩu</label><input id="iPass" type="password" placeholder="••••••••" autocomplete="current-password"/></div>
      <div class="err-msg" id="loginErr"></div>
      <button class="save-btn" onclick="doLogin()">Đăng nhập</button>
      <button onclick="doLogout()" style="width:100%;padding:10px;margin-top:8px;background:transparent;border:1px solid var(--b1);color:var(--t2);border-radius:var(--r2);cursor:pointer;font-size:13px">Đăng xuất</button>
    </div></div>
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
  HMM:'HMM Markov',FOU:'Fourier Cycle',ACR:'Auto-Correlation',
  BAY:'Bayesian',RLE:'Run-Length',CP3:'Cond.Prob 3',TSI:'Trend Strength',ADP:'Adaptive',
  auto:'Tự động (tất cả)',trend:'Theo cầu',reverse:'Bắt cầu gãy',
  cycle:'Chu kỳ',recent:'Ngắn hạn',deep:'Chuyên sâu 100 phiên'
};

function showView(v,btn){
  document.querySelectorAll('.view').forEach(d=>d.classList.remove('show'));
  const el=document.getElementById('v-'+v);
  el.classList.add('show');
  // Re-trigger animation
  el.querySelectorAll('.fade-in,.slide-up').forEach(c=>{c.style.animation='none';requestAnimationFrame(()=>{c.style.animation='';});});
  document.querySelectorAll('.botnav button').forEach(b=>b.classList.remove('active'));
  const nb=document.getElementById('nb-'+v);if(nb)nb.classList.add('active');
  if(v==='cfg')updateEngineStatus();
}

function connect(){
  const proto=location.protocol==='https:'?'wss':'ws';
  ws=new WebSocket(proto+'://'+location.host);
  ws.onopen=()=>{document.getElementById('cDot').style.background='var(--tai)';document.getElementById('cLabel').textContent='Online'};
  ws.onclose=()=>{document.getElementById('cDot').style.background='var(--xiu)';document.getElementById('cLabel').textContent='Offline';setTimeout(connect,3000)};
  ws.onmessage=(e)=>{
    const msg=JSON.parse(e.data);
    if(msg.type==='state'){st=msg.data;render();}
    if(msg.type==='logs'){msg.data.slice(0,50).forEach(l=>addLog(l,false));}
    if(msg.type==='log'){addLog(msg.data,true);}
  };
}

let prevPred='', prevWin=-1, prevLose=-1;
function render(){
  if(!st)return;
  // Account
  document.getElementById('dNick').textContent=st.nickname||'—';
  const balEl=document.getElementById('dBal');
  balEl.textContent=fmt(st.balance)+'đ';
  const conn=st.connected;
  document.getElementById('dConn').className='acct-status '+(conn?'status-on':'status-off');
  document.getElementById('dConnTxt').textContent=conn?'Đang kết nối':'Mất kết nối';

  // Prediction with animation on change
  const pred=st.lastPred;
  const pEl=document.getElementById('dPred');
  if(pred&&pred.pred){
    if(pred.pred!==prevPred){
      pEl.style.animation='none';
      requestAnimationFrame(()=>{pEl.style.animation='';});
      prevPred=pred.pred;
    }
    pEl.textContent=pred.pred==='TAI'?'TÀI':'XỈU';
    pEl.className='pred-big '+(pred.pred==='TAI'?'tai':'xiu');
    const pct=Math.max(0,Math.min(100,(pred.conf-50)*2));
    const bar=document.getElementById('dConfBar');
    bar.style.width=pct+'%';
    bar.className='conf-bar '+(pred.pred==='TAI'?'tai':'xiu');
    document.getElementById('dConf').textContent=pred.conf+'%';
    document.getElementById('dRegime').textContent=pred.road||pred.regime||'—';
    document.getElementById('dSig').textContent=pred.n_active??'0';
    const rEl=document.getElementById('dReason');
    if(rEl){
      const bp=pred.breakProbability!=null?Math.round(pred.breakProbability*100)+'% khả năng bẻ cầu':'';
      rEl.textContent=pred.note||bp||(pred.n_active?pred.n_active+' tín hiệu đồng thuận':'');
    }
  }else{pEl.textContent='—';pEl.className='pred-big empty';}

  // Auto
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

  // Stats with count-up animation
  const wEl=document.getElementById('dWin');
  const lEl=document.getElementById('dLose');
  if(st.statWin!==prevWin){wEl.style.animation='none';requestAnimationFrame(()=>{wEl.style.animation='countUp .4s cubic-bezier(.34,1.56,.64,1) both';});prevWin=st.statWin;}
  if(st.statLose!==prevLose){lEl.style.animation='none';requestAnimationFrame(()=>{lEl.style.animation='countUp .4s cubic-bezier(.34,1.56,.64,1) both';});prevLose=st.statLose;}
  wEl.textContent=st.statWin;
  lEl.textContent=st.statLose;
  const pl=document.getElementById('dPL');
  const profit=st.statProfit||0;
  pl.textContent=(profit>=0?'+':'')+fmt(profit);
  pl.style.color=profit>0?'var(--tai)':profit<0?'var(--xiu)':'var(--t2)';
  pl.style.fontSize=Math.abs(profit)>=1000000?'12px':Math.abs(profit)>=100000?'14px':'18px';

  // Streaks
  document.getElementById('dMaxWin').textContent=st.maxWinStreak||0;
  document.getElementById('dMaxLose').textContent=st.maxLoseStreak||0;
  document.getElementById('dCurWin').textContent=st.currentWinStreak||0;
  document.getElementById('dCurLose').textContent=st.currentLoseStreak||0;

  // Beads with new-bead animation
  const beads=document.getElementById('dBeads');
  const hist=(st.recentHistory||[]).slice(-20);
  const oldCount=beads.children.length;
  beads.innerHTML=hist.map((r,i)=>{
    const t=r==='TAI';
    const isNew=i===hist.length-1&&oldCount>0&&oldCount!==hist.length;
    return '<div class="bead '+(t?'t':'x')+(isNew?' new':'')+'">'+( t?'T':'X')+'</div>';
  }).join('');

  // Hourly chart
  renderHourChart(st.betHistory||[]);

  // Sync config form
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
}

function renderHourChart(history){
  const chart=document.getElementById('hourChart');
  const empty=document.getElementById('chartEmpty');
  if(!history.length){chart.style.display='none';empty.style.display='block';return;}
  chart.style.display='flex';empty.style.display='none';

  // Group by hour
  const byHour={};
  history.forEach(({hour,result})=>{
    if(!byHour[hour])byHour[hour]={win:0,lose:0};
    if(result==='win')byHour[hour].win++;
    else byHour[hour].lose++;
  });

  const hours=Object.keys(byHour).sort();
  const maxTotal=Math.max(...hours.map(h=>byHour[h].win+byHour[h].lose),1);

  chart.innerHTML=hours.map(h=>{
    const d=byHour[h];
    const total=d.win+d.lose;
    const winH=Math.max(4,Math.round((d.win/maxTotal)*72));
    const loseH=Math.max(4,Math.round((d.lose/maxTotal)*72));
    const wr=Math.round(d.win/total*100);
    return '<div class="hour-bar-wrap" data-h="'+h+'" data-w="'+d.win+'" data-l="'+d.lose+'" onclick="showHourTip(this)">' +
      '<div class="hour-bar" style="height:'+winH+'px;background:var(--tai);opacity:.85"></div>' +
      '<div class="hour-bar" style="height:'+loseH+'px;background:var(--xiu);opacity:.85;border-radius:0 0 3px 3px"></div>' +
      '<div class="hour-label">'+h.split(':')[0]+'h</div>' +
    '</div>';
  }).join('');
}

function showHourTip(el){
  const hour=el.dataset.h, win=+el.dataset.w, lose=+el.dataset.l;
  const total=win+lose;
  const wr=Math.round(win/total*100);
  el.querySelectorAll('.hour-bar').forEach(b=>{b.style.opacity='1';setTimeout(()=>b.style.opacity='.85',300);});
  alert(hour+': '+win+' thang / '+lose+' thua ('+wr+'% WR)');
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

async function updateEngineStatus(){
  const el=document.getElementById('engineStatus');
  if(!el||!st)return;
  el.textContent='Lịch sử: '+(st.historyLen||0)+' phiên | Đã học từ dữ liệu thực tế';
}

async function loadRanking(){
  const list=document.getElementById('rankList');
  const status=document.getElementById('rankStatus');
  list.innerHTML='';
  const combos=[
    {tag:'auto',label:'🧠 Tự động (tất cả)'},
    {tag:'deep',label:'🔬 Chuyên sâu 100 phiên'},
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
  const sep=document.createElement('div');
  sep.style='font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:1px;margin:12px 0 6px;font-family:var(--mono)';
  sep.textContent='— Thuật toán đơn lẻ';
  list.appendChild(sep);
  try{
    status.textContent='Đang phân tích...';
    const ranks=await fetch('/api/rank').then(r=>r.json());
    if(!ranks.length){
      status.textContent='Chưa đủ dữ liệu';
      const allTags=['MK1','MK2','MK3','SF','SB3','SB5','P3','P4','P5','B10','B20','ZPG','MDK','ENT','WRE','DP2','MVR','ALB','VWB','CY4','CY6','CY8','HMM','FOU','ACR','BAY','RLE','CP3','TSI','ADP'];
      allTags.forEach(tag=>{
        const div=document.createElement('div');
        div.className='rank-item'+(selectedStrategy===tag?' selected':'');
        div.innerHTML='<span class="rank-name">'+(ALGO_NAMES[tag]||tag)+'</span><span class="rank-acc" style="color:var(--t3)">—</span>';
        div.onclick=function(){selectStrategy(tag,div)};
        list.appendChild(div);
      });return;
    }
    status.textContent='Phân tích '+ranks.length+' thuật toán | '+ranks[0].total+' phiên';
    sep.textContent='— Thuật toán đơn lẻ (backtest '+ranks[0].total+' phiên)';
    const best=ranks[0];
    ranks.forEach(({tag,acc})=>{
      const pct=Math.round(acc*100);
      const isBest=tag===best.tag;
      const isGood=pct>=54;
      const div=document.createElement('div');
      div.className='rank-item'+(isBest?' best':'')+(selectedStrategy===tag?' selected':'');
      div.innerHTML='<span class="rank-name">'+(ALGO_NAMES[tag]||tag)+(isBest?'<span class="rank-badge badge-best">✅ Ưu tiên</span>':isGood?'<span class="rank-badge badge-good">👍 Tốt</span>':'')+'</span><span class="rank-acc" style="color:'+(pct>=55?'var(--tai)':pct>=52?'var(--gold)':'var(--t2)')+'">'+pct+'%</span>';
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
  const cfg={baseAmount:+document.getElementById('cAmount').value||1000,x2Enabled:x2On,x2MaxLevel:+document.getElementById('cX2max').value||5,stopLossPercent:+document.getElementById('cStop').value||30,algoEnabled:true};
  const res=await api('/api/login',{username:u,password:p,config:cfg});
  if(res.error){err.textContent='❌ '+res.error;}
  else{err.textContent='';showView('home',document.getElementById('nb-home'));}
}

async function doLogout(){await api('/api/logout',{});st=null;}

async function toggleAuto(){
  if(!st){showView('login',null);return}
  await api(st.autoRunning?'/api/auto/stop':'/api/auto/start',{});
}

function getConfig(){
  return{baseAmount:+document.getElementById('cAmount').value||1000,x2Enabled:x2On,x2MaxLevel:+document.getElementById('cX2max').value||5,stopLossPercent:+document.getElementById('cStop').value||30,algoEnabled:true};
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
  showView('home',document.getElementById('nb-home'));
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
