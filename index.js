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

// ==================== MODEL WEIGHTS (in-memory) ====================
let modelWeights = {};
let subModelWeights = {};
let miniModelWeights = {};
for (let i = 1; i <= 21; i++) modelWeights[`model${i}`] = 1.0;
for (let i = 1; i <= 42; i++) subModelWeights[`sub_model_${i}`] = 1.0;
for (let i = 1; i <= 21; i++) miniModelWeights[`mini_model_${i}`] = 1.0;
function saveModelWeights() { /* in-memory */ }

// ==================== TAI XIU ANALYZER ====================
class TaiXiuAnalyzer {
    constructor() {
        // Model weights
        this.modelWeights = modelWeights;
        this.subModelWeights = subModelWeights;
        this.miniModelWeights = miniModelWeights;
        
        // Sub models (42 cái với chuyên môn riêng)
        this.subModels = {};
        this.initSubModels();
        
        // Mini models (21 cái)
        this.miniModels = {};
        this.initMiniModels();
        
        this.performanceHistory = {};
        this.patternLibrary = this.loadPatternLibrary();
    }
    
    loadPatternLibrary() {
        return {
            '1-1': [], '2-2': [], '3-3': [], '1-2': [], '2-1': [],
            '2-1-2': [], '1-2-1': [], 'bệt': [], 'loạn': []
        };
    }
    
    savePatternLibrary() { /* in-memory only */ }
    
    initSubModels() {
        // 42 sub models với chuyên môn khác nhau
        const subModelSpecialties = {
            // Model 1-6: Chuyên phân tích cầu 1-1 các biến thể
            1: { name: '1-1 thuần', type: '1-1', logic: 'pure', minLength: 4, threshold: 0.9 },
            2: { name: '1-1 biến thể', type: '1-1', logic: 'variant', minLength: 5, threshold: 0.8 },
            3: { name: '1-1 dài hạn', type: '1-1', logic: 'long', minLength: 8, threshold: 0.75 },
            4: { name: '1-1 kết hợp', type: '1-1', logic: 'hybrid', minLength: 6, threshold: 0.7 },
            5: { name: '1-1 gãy', type: '1-1', logic: 'break', minLength: 6, threshold: 0.8 },
            6: { name: '1-1 phục hồi', type: '1-1', logic: 'recovery', minLength: 7, threshold: 0.7 },
            
            // Model 7-12: Chuyên cầu 2-2
            7: { name: '2-2 chuẩn', type: '2-2', logic: 'pure', minLength: 6, threshold: 0.9 },
            8: { name: '2-2 lệch', type: '2-2', logic: 'offset', minLength: 7, threshold: 0.8 },
            9: { name: '2-2 biến tướng', type: '2-2', logic: 'variant', minLength: 8, threshold: 0.75 },
            10: { name: '2-2 kết hợp 1-1', type: '2-2', logic: 'hybrid', minLength: 8, threshold: 0.7 },
            11: { name: '2-2 dài', type: '2-2', logic: 'long', minLength: 10, threshold: 0.8 },
            12: { name: '2-2 bẻ', type: '2-2', logic: 'break', minLength: 7, threshold: 0.85 },
            
            // Model 13-18: Chuyên cầu bệt
            13: { name: 'bệt ngắn', type: 'bệt', logic: 'short', minLength: 3, threshold: 0.8 },
            14: { name: 'bệt trung', type: 'bệt', logic: 'medium', minLength: 5, threshold: 0.85 },
            15: { name: 'bệt dài', type: 'bệt', logic: 'long', minLength: 7, threshold: 0.9 },
            16: { name: 'bệt gãy', type: 'bệt', logic: 'break', minLength: 5, threshold: 0.8 },
            17: { name: 'bệt xen kẽ', type: 'bệt', logic: 'hybrid', minLength: 6, threshold: 0.7 },
            18: { name: 'siêu bệt', type: 'bệt', logic: 'super', minLength: 10, threshold: 0.95 },
            
            // Model 19-24: Chuyên cầu 3-3
            19: { name: '3-3 chuẩn', type: '3-3', logic: 'pure', minLength: 9, threshold: 0.9 },
            20: { name: '3-3 biến thể', type: '3-3', logic: 'variant', minLength: 10, threshold: 0.8 },
            21: { name: '3-3 ngắn', type: '3-3', logic: 'short', minLength: 6, threshold: 0.7 },
            22: { name: '3-3 kết hợp', type: '3-3', logic: 'hybrid', minLength: 9, threshold: 0.75 },
            23: { name: '3-3 bẻ', type: '3-3', logic: 'break', minLength: 8, threshold: 0.8 },
            24: { name: '3-3 dài', type: '3-3', logic: 'long', minLength: 12, threshold: 0.85 },
            
            // Model 25-30: Chuyên cầu 2-1-2 và 1-2-1
            25: { name: '2-1-2 chuẩn', type: '2-1-2', logic: 'pure', minLength: 5, threshold: 0.9 },
            26: { name: '2-1-2 biến thể', type: '2-1-2', logic: 'variant', minLength: 6, threshold: 0.8 },
            27: { name: '2-1-2 dài', type: '2-1-2', logic: 'long', minLength: 8, threshold: 0.8 },
            28: { name: '1-2-1 chuẩn', type: '1-2-1', logic: 'pure', minLength: 5, threshold: 0.9 },
            29: { name: '1-2-1 biến thể', type: '1-2-1', logic: 'variant', minLength: 6, threshold: 0.8 },
            30: { name: '1-2-1 dài', type: '1-2-1', logic: 'long', minLength: 8, threshold: 0.8 },
            
            // Model 31-36: Chuyên bẻ cầu và chuyển tiếp
            31: { name: 'bẻ cầu 1-1', type: 'break', logic: 'break11', minLength: 4, threshold: 0.85 },
            32: { name: 'bẻ cầu 2-2', type: 'break', logic: 'break22', minLength: 5, threshold: 0.85 },
            33: { name: 'bẻ cầu bệt', type: 'break', logic: 'breakStreak', minLength: 4, threshold: 0.8 },
            34: { name: 'chuyển tiếp 1-1 sang 2-2', type: 'transition', logic: '11to22', minLength: 6, threshold: 0.75 },
            35: { name: 'chuyển tiếp 2-2 sang 1-1', type: 'transition', logic: '22to11', minLength: 6, threshold: 0.75 },
            36: { name: 'chuyển tiếp bệt sang 1-1', type: 'transition', logic: 'streakTo11', minLength: 5, threshold: 0.7 },
            
            // Model 37-42: Chuyên phân tích tổng hợp
            37: { name: 'phân tích tần suất', type: 'frequency', logic: 'frequency', minLength: 10, threshold: 0.7 },
            38: { name: 'phân tích chu kỳ', type: 'cycle', logic: 'cycle', minLength: 12, threshold: 0.7 },
            39: { name: 'phân tích đối xứng', type: 'symmetry', logic: 'symmetry', minLength: 8, threshold: 0.75 },
            40: { name: 'phân tích Fibonacci', type: 'fibonacci', logic: 'fibonacci', minLength: 8, threshold: 0.7 },
            41: { name: 'phân tích xu hướng dài', type: 'trend', logic: 'longTrend', minLength: 15, threshold: 0.8 },
            42: { name: 'tổng hợp siêu cầu', type: 'super', logic: 'super', minLength: 20, threshold: 0.85 }
        };
        
        for (let i = 1; i <= 42; i++) {
            this.subModels[`sub_model_${i}`] = {
                ...subModelSpecialties[i],
                weight: this.subModelWeights[`sub_model_${i}`] || 1.0,
                accuracy: 0.5,
                predictions: []
            };
        }
    }
    
    initMiniModels() {
        const specialties = {
            1: 'phat_hien_cau_dep',
            2: 'du_doan_bien_dong',
            3: 'phan_tich_so_sanh',
            4: 'nhan_dien_xu_huong_cuc_bo',
            5: 'tinh_toan_xac_suat_cao',
            6: 'phat_hien_diem_gay',
            7: 'du_doan_nguong',
            8: 'phan_tich_chuoi',
            9: 'nhan_dien_mau_lap',
            10: 'tinh_he_so_tuong_quan',
            11: 'du_doan_doan_nhiet',
            12: 'phan_tich_pha',
            13: 'nhan_dien_song',
            14: 'tinh_toan_momentum',
            15: 'du_doan_hoi_phuc',
            16: 'phat_hien_dot_bien',
            17: 'phan_tich_can_bang',
            18: 'nhan_dien_tan_so',
            19: 'du_doan_chu_ky',
            20: 'tinh_toan_ma_tran',
            21: 'phan_tich_tong_hop'
        };
        
        for (let i = 1; i <= 21; i++) {
            this.miniModels[`mini_model_${i}`] = {
                weight: this.miniModelWeights[`mini_model_${i}`] || 1.0,
                accuracy: 0.5,
                specialty: specialties[i] || 'chung',
                predictions: []
            };
        }
    }
    
    // Helper: lấy mảng kết quả từ history
    getResultArray(history) {
        return history.map(h => h.Ket_qua || (h.score >= 11 ? 'Tài' : 'Xỉu'));
    }
    
    // ==================== SUB MODELS THÔNG MINH ====================
    
    // Model 1-6: Chuyên cầu 1-1
    runSubModel11(results, model) {
        if (results.length < model.minLength) return null;
        
        const last = results[results.length - 1];
        const last4 = results.slice(-4);
        const last6 = results.slice(-6);
        
        switch (model.logic) {
            case 'pure':
                // 1-1 thuần túy: TXTX TXTX
                if (this.isPerfectAlternating(results, 4)) {
                    return {
                        prediction: last === 'Tài' ? 'Xỉu' : 'Tài',
                        confidence: 0.9,
                        reason: 'Phát hiện cầu 1-1 thuần túy'
                    };
                }
                break;
                
            case 'variant':
                // 1-1 biến thể: chấp nhận lệch 1 nhịp
                if (this.isAlternatingWithTolerance(results, 1)) {
                    return {
                        prediction: last === 'Tài' ? 'Xỉu' : 'Tài',
                        confidence: 0.8,
                        reason: 'Phát hiện cầu 1-1 biến thể'
                    };
                }
                break;
                
            case 'long':
                // 1-1 dài hạn: xét 12 phiên
                const longResults = results.slice(-12);
                const altCount = this.countAlternating(longResults);
                if (altCount >= 8) {
                    return {
                        prediction: last === 'Tài' ? 'Xỉu' : 'Tài',
                        confidence: 0.7 + (altCount / 20),
                        reason: `Cầu 1-1 dài hạn với ${altCount}/11 cặp xen kẽ`
                    };
                }
                break;
                
            case 'hybrid':
                // Kết hợp 1-1 với yếu tố khác
                const recent = results.slice(-5);
                if (recent[0] !== recent[1] && recent[1] !== recent[2] && recent[3] !== recent[4]) {
                    return {
                        prediction: last === 'Tài' ? 'Xỉu' : 'Tài',
                        confidence: 0.7,
                        reason: 'Phát hiện cầu 1-1 kết hợp'
                    };
                }
                break;
                
            case 'break':
                // Phát hiện 1-1 sắp gãy
                if (last4[0] !== last4[1] && last4[1] !== last4[2] && last4[2] !== last4[3]) {
                    // Đang xen kẽ hoàn hảo, có thể sắp gãy
                    const streak = this.getStreak(results.slice(0, -1));
                    if (streak > 4) {
                        return {
                            prediction: last, // Giữ nguyên, không đảo
                            confidence: 0.8,
                            reason: 'Cầu 1-1 dài sắp gãy, dự đoán giữ nguyên'
                        };
                    }
                }
                break;
                
            case 'recovery':
                // 1-1 phục hồi sau gãy
                if (last4[0] === last4[1] && last4[1] !== last4[2] && last4[2] !== last4[3]) {
                    return {
                        prediction: last4[3] === 'Tài' ? 'Xỉu' : 'Tài',
                        confidence: 0.7,
                        reason: 'Cầu 1-1 đang phục hồi sau gãy'
                    };
                }
                break;
        }
        
        return null;
    }
    
    // Model 7-12: Chuyên cầu 2-2
    runSubModel22(results, model) {
        if (results.length < model.minLength) return null;
        
        const last = results[results.length - 1];
        const last4 = results.slice(-4);
        const last6 = results.slice(-6);
        const last8 = results.slice(-8);
        
        switch (model.logic) {
            case 'pure':
                // 2-2 chuẩn: TTXX TTXX
                if (last6.length === 6) {
                    if (last6[0] === last6[1] && last6[1] !== last6[2] &&
                        last6[2] === last6[3] && last6[3] !== last6[4] &&
                        last6[4] === last6[5]) {
                        return {
                            prediction: last6[4] === 'Tài' ? 'Xỉu' : 'Tài',
                            confidence: 0.9,
                            reason: 'Phát hiện cầu 2-2 chuẩn'
                        };
                    }
                }
                break;
                
            case 'offset':
                // 2-2 lệch: TTX TX X?
                if (last6.length === 6) {
                    if (last6[0] === last6[1] && last6[1] !== last6[2] &&
                        last6[2] !== last6[3] && last6[3] === last6[4] &&
                        last6[4] !== last6[5]) {
                        return {
                            prediction: last6[4] === 'Tài' ? 'Xỉu' : 'Tài',
                            confidence: 0.8,
                            reason: 'Phát hiện cầu 2-2 lệch'
                        };
                    }
                }
                break;
                
            case 'variant':
                // 2-2 biến tướng
                if (last8.length === 8) {
                    if (last8[0] === last8[1] && last8[1] !== last8[2] &&
                        last8[2] === last8[3] && last8[3] !== last8[4] &&
                        last8[4] === last8[5] && last8[5] !== last8[6] &&
                        last8[6] === last8[7]) {
                        return {
                            prediction: last8[6] === 'Tài' ? 'Xỉu' : 'Tài',
                            confidence: 0.75,
                            reason: 'Phát hiện cầu 2-2 biến tướng'
                        };
                    }
                }
                break;
                
            case 'hybrid':
                // 2-2 kết hợp 1-1
                if (last6.length === 6) {
                    if (last6[0] === last6[1] && last6[1] !== last6[2] &&
                        last6[2] !== last6[3] && last6[3] !== last6[4] &&
                        last6[4] === last6[5]) {
                        return {
                            prediction: last6[4] === 'Tài' ? 'Xỉu' : 'Tài',
                            confidence: 0.7,
                            reason: 'Cầu 2-2 kết hợp 1-1'
                        };
                    }
                }
                break;
                
            case 'long':
                // 2-2 dài
                if (last8.length === 8) {
                    let score = 0;
                    for (let i = 0; i < 7; i+=2) {
                        if (last8[i] === last8[i+1]) score++;
                    }
                    if (score >= 3) {
                        return {
                            prediction: last === 'Tài' ? 'Xỉu' : 'Tài',
                            confidence: 0.7 + (score * 0.05),
                            reason: `Cầu 2-2 dài với ${score}/4 cặp đúng`
                        };
                    }
                }
                break;
                
            case 'break':
                // Phát hiện bẻ cầu 2-2
                if (last6.length === 6) {
                    if (last6[0] === last6[1] && last6[1] !== last6[2] &&
                        last6[2] === last6[3] && last6[3] !== last6[4] &&
                        last6[4] !== last6[5]) {
                        return {
                            prediction: last6[4],
                            confidence: 0.85,
                            reason: 'Phát hiện bẻ cầu 2-2'
                        };
                    }
                }
                break;
        }
        
        return null;
    }
    
    // Model 13-18: Chuyên cầu bệt
    runSubModelStreak(results, model) {
        if (results.length < model.minLength) return null;
        
        const last = results[results.length - 1];
        const other = last === 'Tài' ? 'Xỉu' : 'Tài';
        
        // Tính độ dài bệt hiện tại
        let streak = 1;
        for (let i = results.length - 2; i >= 0; i--) {
            if (results[i] === last) streak++;
            else break;
        }
        
        switch (model.logic) {
            case 'short':
                if (streak >= 2 && streak <= 3) {
                    return {
                        prediction: last,
                        confidence: 0.7 + (streak * 0.05),
                        reason: `Bệt ngắn ${streak} phiên`
                    };
                }
                break;
                
            case 'medium':
                if (streak >= 4 && streak <= 5) {
                    return {
                        prediction: last,
                        confidence: 0.75 + ((streak - 4) * 0.05),
                        reason: `Bệt trung ${streak} phiên`
                    };
                }
                break;
                
            case 'long':
                if (streak >= 6) {
                    return {
                        prediction: last,
                        confidence: 0.8 + (Math.min(streak, 10) * 0.01),
                        reason: `Bệt dài ${streak} phiên`
                    };
                }
                break;
                
            case 'break':
                if (streak >= 4) {
                    // Có thể sắp gãy
                    return {
                        prediction: other,
                        confidence: 0.6 + (streak * 0.03),
                        reason: `Bệt ${streak} phiên, dự đoán sắp gãy`
                    };
                }
                break;
                
            case 'hybrid':
                // Bệt xen kẽ yếu tố khác
                if (streak >= 3) {
                    const prev = results[results.length - streak - 1];
                    if (prev && prev !== last) {
                        return {
                            prediction: last,
                            confidence: 0.7,
                            reason: `Bệt sau khi đảo từ ${prev}`
                        };
                    }
                }
                break;
                
            case 'super':
                if (streak >= 8) {
                    return {
                        prediction: last,
                        confidence: 0.9,
                        reason: `Siêu bệt ${streak} phiên`
                    };
                }
                break;
        }
        
        return null;
    }
    
    // Model 19-24: Chuyên cầu 3-3
    runSubModel33(results, model) {
        if (results.length < model.minLength) return null;
        
        const last = results[results.length - 1];
        const last9 = results.slice(-9);
        const last12 = results.slice(-12);
        
        switch (model.logic) {
            case 'pure':
                if (last9.length === 9) {
                    if (last9[0] === last9[1] && last9[1] === last9[2] &&
                        last9[3] === last9[4] && last9[4] === last9[5] &&
                        last9[6] === last9[7] && last9[7] === last9[8] &&
                        last9[0] !== last9[3] && last9[3] !== last9[6]) {
                        return {
                            prediction: last9[6] === 'Tài' ? 'Xỉu' : 'Tài',
                            confidence: 0.9,
                            reason: 'Phát hiện cầu 3-3 chuẩn'
                        };
                    }
                }
                break;
                
            case 'variant':
                if (last12.length === 12) {
                    let score = 0;
                    for (let i = 0; i < 12; i+=3) {
                        if (i+2 < 12 && last12[i] === last12[i+1] && last12[i+1] === last12[i+2]) {
                            score++;
                        }
                    }
                    if (score >= 3) {
                        return {
                            prediction: last === 'Tài' ? 'Xỉu' : 'Tài',
                            confidence: 0.7 + (score * 0.05),
                            reason: `Cầu 3-3 biến thể với ${score}/4 bộ ba`
                        };
                    }
                }
                break;
                
            case 'short':
                if (results.length >= 6) {
                    const last6 = results.slice(-6);
                    if (last6[0] === last6[1] && last6[1] === last6[2] &&
                        last6[3] === last6[4] && last6[4] === last6[5]) {
                        return {
                            prediction: last6[3] === 'Tài' ? 'Xỉu' : 'Tài',
                            confidence: 0.7,
                            reason: 'Cầu 3-3 ngắn (6 phiên)'
                        };
                    }
                }
                break;
                
            case 'hybrid':
                if (last9.length === 9) {
                    if (last9[0] === last9[1] && last9[1] === last9[2] &&
                        last9[3] !== last9[4] && last9[5] === last9[6] && last9[6] === last9[7]) {
                        return {
                            prediction: last9[6] === 'Tài' ? 'Xỉu' : 'Tài',
                            confidence: 0.75,
                            reason: 'Cầu 3-3 kết hợp'
                        };
                    }
                }
                break;
                
            case 'break':
                if (last9.length === 9) {
                    if (last9[0] === last9[1] && last9[1] === last9[2] &&
                        last9[3] === last9[4] && last9[4] === last9[5] &&
                        last9[6] !== last9[7]) {
                        return {
                            prediction: last9[6],
                            confidence: 0.8,
                            reason: 'Phát hiện bẻ cầu 3-3'
                        };
                    }
                }
                break;
                
            case 'long':
                if (results.length >= 15) {
                    const last15 = results.slice(-15);
                    let pattern = [];
                    for (let i = 0; i < 15; i+=3) {
                        if (i+2 < 15 && last15[i] === last15[i+1] && last15[i+1] === last15[i+2]) {
                            pattern.push(last15[i]);
                        }
                    }
                    if (pattern.length >= 4 && pattern[0] !== pattern[1] && pattern[1] !== pattern[2]) {
                        return {
                            prediction: pattern[pattern.length-1] === 'Tài' ? 'Xỉu' : 'Tài',
                            confidence: 0.8,
                            reason: 'Cầu 3-3 dài hạn'
                        };
                    }
                }
                break;
        }
        
        return null;
    }
    
    // Model 25-30: Chuyên cầu 2-1-2 và 1-2-1
    runSubModel212(results, model) {
        if (results.length < model.minLength) return null;
        
        const last = results[results.length - 1];
        const last5 = results.slice(-5);
        const last7 = results.slice(-7);
        
        switch (model.logic) {
            case 'pure':
                if (last5.length === 5) {
                    // 2-1-2: TTXTT
                    if (last5[0] === last5[1] && last5[1] !== last5[2] &&
                        last5[2] !== last5[3] && last5[3] === last5[4] &&
                        last5[0] === last5[3]) {
                        return {
                            prediction: last5[4] === 'Tài' ? 'Xỉu' : 'Tài',
                            confidence: 0.9,
                            reason: 'Phát hiện cầu 2-1-2 chuẩn'
                        };
                    }
                }
                break;
                
            case 'variant':
                if (last7.length === 7) {
                    // 2-1-2 mở rộng: TTX TTX?
                    if (last7[0] === last7[1] && last7[1] !== last7[2] &&
                        last7[3] === last7[4] && last7[4] !== last7[5] &&
                        last7[0] === last7[3]) {
                        return {
                            prediction: last7[5] === 'Tài' ? 'Xỉu' : 'Tài',
                            confidence: 0.8,
                            reason: 'Phát hiện cầu 2-1-2 biến thể'
                        };
                    }
                }
                break;
                
            case 'long':
                if (results.length >= 10) {
                    const last10 = results.slice(-10);
                    let count = 0;
                    for (let i = 0; i < 5; i+=2) {
                        if (i+4 < 10 && last10[i] === last10[i+1] && last10[i+1] !== last10[i+2] &&
                            last10[i+3] === last10[i+4]) {
                            count++;
                        }
                    }
                    if (count >= 2) {
                        return {
                            prediction: last === 'Tài' ? 'Xỉu' : 'Tài',
                            confidence: 0.75,
                            reason: 'Cầu 2-1-2 dài hạn'
                        };
                    }
                }
                break;
        }
        
        return null;
    }
    
    runSubModel121(results, model) {
        if (results.length < model.minLength) return null;
        
        const last = results[results.length - 1];
        const last5 = results.slice(-5);
        const last7 = results.slice(-7);
        
        switch (model.logic) {
            case 'pure':
                if (last5.length === 5) {
                    // 1-2-1: XTTXT
                    if (last5[0] !== last5[1] && last5[1] === last5[2] &&
                        last5[2] !== last5[3] && last5[3] === last5[4] &&
                        last5[0] === last5[3]) {
                        return {
                            prediction: last5[4] === 'Tài' ? 'Xỉu' : 'Tài',
                            confidence: 0.9,
                            reason: 'Phát hiện cầu 1-2-1 chuẩn'
                        };
                    }
                }
                break;
                
            case 'variant':
                if (last7.length === 7) {
                    if (last7[0] !== last7[1] && last7[1] === last7[2] &&
                        last7[3] !== last7[4] && last7[4] === last7[5] &&
                        last7[0] === last7[3]) {
                        return {
                            prediction: last7[5] === 'Tài' ? 'Xỉu' : 'Tài',
                            confidence: 0.8,
                            reason: 'Phát hiện cầu 1-2-1 biến thể'
                        };
                    }
                }
                break;
                
            case 'long':
                if (results.length >= 10) {
                    const last10 = results.slice(-10);
                    let count = 0;
                    for (let i = 0; i < 5; i+=2) {
                        if (i+4 < 10 && last10[i] !== last10[i+1] && last10[i+1] === last10[i+2] &&
                            last10[i+3] === last10[i+4]) {
                            count++;
                        }
                    }
                    if (count >= 2) {
                        return {
                            prediction: last === 'Tài' ? 'Xỉu' : 'Tài',
                            confidence: 0.75,
                            reason: 'Cầu 1-2-1 dài hạn'
                        };
                    }
                }
                break;
        }
        
        return null;
    }
    
    // Model 31-36: Chuyên bẻ cầu và chuyển tiếp
    runSubModelBreak(results, model) {
        if (results.length < model.minLength) return null;
        
        const last = results[results.length - 1];
        const last4 = results.slice(-4);
        const last5 = results.slice(-5);
        const last6 = results.slice(-6);
        
        switch (model.logic) {
            case 'break11':
                // Bẻ cầu 1-1: TXTX -> XX
                if (last4.length === 4) {
                    if (last4[0] !== last4[1] && last4[1] !== last4[2] && last4[2] === last4[3]) {
                        return {
                            prediction: last4[3],
                            confidence: 0.85,
                            reason: 'Phát hiện bẻ cầu 1-1'
                        };
                    }
                }
                break;
                
            case 'break22':
                // Bẻ cầu 2-2: TTXX -> TTT
                if (last5.length === 5) {
                    if (last5[0] === last5[1] && last5[1] !== last5[2] &&
                        last5[2] === last5[3] && last5[3] !== last5[4] &&
                        last5[0] === last5[4]) {
                        return {
                            prediction: last5[4],
                            confidence: 0.85,
                            reason: 'Phát hiện bẻ cầu 2-2'
                        };
                    }
                }
                break;
                
            case 'breakStreak':
                // Bẻ cầu bệt
                const streak = this.getStreak(results.slice(0, -1));
                if (streak >= 3 && last !== results[results.length - 2]) {
                    return {
                        prediction: last,
                        confidence: 0.8,
                        reason: `Phát hiện bẻ cầu bệt sau ${streak} phiên`
                    };
                }
                break;
                
            case '11to22':
                // Chuyển từ 1-1 sang 2-2
                if (last6.length === 6) {
                    if (last6[0] !== last6[1] && last6[1] !== last6[2] &&
                        last6[2] === last6[3] && last6[3] !== last6[4] &&
                        last6[4] === last6[5]) {
                        return {
                            prediction: last6[4] === 'Tài' ? 'Xỉu' : 'Tài',
                            confidence: 0.75,
                            reason: 'Chuyển từ cầu 1-1 sang 2-2'
                        };
                    }
                }
                break;
                
            case '22to11':
                // Chuyển từ 2-2 sang 1-1
                if (last6.length === 6) {
                    if (last6[0] === last6[1] && last6[1] !== last6[2] &&
                        last6[2] !== last6[3] && last6[3] !== last6[4] &&
                        last6[4] !== last6[5]) {
                        return {
                            prediction: last6[4] === 'Tài' ? 'Xỉu' : 'Tài',
                            confidence: 0.75,
                            reason: 'Chuyển từ cầu 2-2 sang 1-1'
                        };
                    }
                }
                break;
                
            case 'streakTo11':
                // Chuyển từ bệt sang 1-1
                if (last5.length === 5) {
                    if (last5[0] === last5[1] && last5[1] === last5[2] &&
                        last5[2] !== last5[3] && last5[3] !== last5[4]) {
                        return {
                            prediction: last5[4] === 'Tài' ? 'Xỉu' : 'Tài',
                            confidence: 0.7,
                            reason: 'Chuyển từ bệt sang cầu 1-1'
                        };
                    }
                }
                break;
        }
        
        return null;
    }
    
    // Model 37-42: Chuyên phân tích tổng hợp
    runSubModelAdvanced(results, model) {
        if (results.length < model.minLength) return null;
        
        const last = results[results.length - 1];
        const other = last === 'Tài' ? 'Xỉu' : 'Tài';
        
        switch (model.logic) {
            case 'frequency':
                // Phân tích tần suất
                const freq = this.analyzeFrequency(results);
                if (freq.dominant && freq.ratio > 0.6) {
                    return {
                        prediction: freq.dominant,
                        confidence: 0.6 + (freq.ratio * 0.2),
                        reason: `Tần suất ${freq.dominant} chiếm ${(freq.ratio*100).toFixed(0)}%`
                    };
                }
                break;
                
            case 'cycle':
                // Phân tích chu kỳ
                const cycle = this.detectCycle(results);
                if (cycle.found) {
                    return {
                        prediction: cycle.next,
                        confidence: 0.7,
                        reason: `Phát hiện chu kỳ ${cycle.length} phiên`
                    };
                }
                break;
                
            case 'symmetry':
                // Phân tích đối xứng
                const symmetry = this.checkSymmetry(results);
                if (symmetry.found) {
                    return {
                        prediction: symmetry.prediction,
                        confidence: 0.75,
                        reason: 'Phát hiện cầu đối xứng'
                    };
                }
                break;
                
            case 'fibonacci':
                // Phân tích Fibonacci
                const fib = this.checkFibonacci(results);
                if (fib.found) {
                    return {
                        prediction: fib.prediction,
                        confidence: 0.7,
                        reason: 'Phát hiện cầu Fibonacci'
                    };
                }
                break;
                
            case 'longTrend':
                // Xu hướng dài
                const trend = this.getLongTrend(results);
                if (trend.strength > 0.7) {
                    return {
                        prediction: trend.direction,
                        confidence: 0.7 + (trend.strength * 0.1),
                        reason: `Xu hướng dài ${trend.direction} với độ mạnh ${(trend.strength*100).toFixed(0)}%`
                    };
                }
                break;
                
            case 'super':
                // Tổng hợp siêu cầu
                const superAnalysis = this.superAnalysis(results);
                if (superAnalysis.confidence > 0.8) {
                    return superAnalysis;
                }
                break;
        }
        
        return null;
    }
    
    // Helper functions
    isPerfectAlternating(results, length) {
        const last = results.slice(-length);
        for (let i = 0; i < last.length - 1; i++) {
            if (last[i] === last[i+1]) return false;
        }
        return true;
    }
    
    isAlternatingWithTolerance(results, tolerance) {
        const last = results.slice(-6);
        let errors = 0;
        for (let i = 0; i < last.length - 1; i++) {
            if (last[i] === last[i+1]) errors++;
        }
        return errors <= tolerance;
    }
    
    countAlternating(results) {
        let count = 0;
        for (let i = 0; i < results.length - 1; i++) {
            if (results[i] !== results[i+1]) count++;
        }
        return count;
    }
    
    getStreak(results) {
        if (results.length === 0) return 0;
        const last = results[results.length - 1];
        let streak = 1;
        for (let i = results.length - 2; i >= 0; i--) {
            if (results[i] === last) streak++;
            else break;
        }
        return streak;
    }
    
    analyzeFrequency(results) {
        const recent = results.slice(-20);
        const taiCount = recent.filter(r => r === 'Tài').length;
        const xiuCount = recent.length - taiCount;
        const ratio = Math.max(taiCount, xiuCount) / recent.length;
        const dominant = taiCount > xiuCount ? 'Tài' : 'Xỉu';
        return { dominant, ratio };
    }
    
    detectCycle(results) {
        // Đơn giản: tìm chu kỳ 2,3,4
        for (let cycleLen of [2, 3, 4]) {
            if (results.length < cycleLen * 2) continue;
            const lastCycle = results.slice(-cycleLen);
            const prevCycle = results.slice(-cycleLen*2, -cycleLen);
            if (JSON.stringify(lastCycle) === JSON.stringify(prevCycle)) {
                return {
                    found: true,
                    length: cycleLen,
                    next: lastCycle[0]
                };
            }
        }
        return { found: false };
    }
    
    checkSymmetry(results) {
        if (results.length < 6) return { found: false };
        const last3 = results.slice(-3);
        const prev3 = results.slice(-6, -3);
        if (last3[0] === prev3[2] && last3[1] === prev3[1] && last3[2] === prev3[0]) {
            return {
                found: true,
                prediction: last3[1]
            };
        }
        return { found: false };
    }
    
    checkFibonacci(results) {
        // Fibonacci trong cầu: 1,1,2,3,5,8...
        if (results.length < 5) return { found: false };
        const fibs = [1, 2, 3, 5];
        for (let fib of fibs) {
            if (results.length >= fib * 2) {
                const lastFib = results.slice(-fib);
                const prevFib = results.slice(-fib*2, -fib);
                if (JSON.stringify(lastFib) === JSON.stringify(prevFib)) {
                    return {
                        found: true,
                        prediction: lastFib[0]
                    };
                }
            }
        }
        return { found: false };
    }
    
    getLongTrend(results) {
        if (results.length < 10) return { strength: 0, direction: null };
        const first = results.slice(0, 5);
        const last = results.slice(-5);
        const firstTai = first.filter(r => r === 'Tài').length;
        const lastTai = last.filter(r => r === 'Tài').length;
        
        if (lastTai > firstTai + 2) {
            return { strength: 0.8, direction: 'Tài' };
        } else if (lastTai < firstTai - 2) {
            return { strength: 0.8, direction: 'Xỉu' };
        }
        return { strength: 0.5, direction: lastTai > 2 ? 'Tài' : 'Xỉu' };
    }
    
    superAnalysis(results) {
        // Kết hợp nhiều yếu tố
        const freq = this.analyzeFrequency(results);
        const trend = this.getLongTrend(results);
        const cycle = this.detectCycle(results);
        
        let score = 0;
        let predictions = [];
        
        if (freq.ratio > 0.6) {
            predictions.push({ pred: freq.dominant, weight: freq.ratio });
            score++;
        }
        
        if (trend.strength > 0.7) {
            predictions.push({ pred: trend.direction, weight: trend.strength });
            score++;
        }
        
        if (cycle.found) {
            predictions.push({ pred: cycle.next, weight: 0.7 });
            score++;
        }
        
        if (score >= 2) {
            const taiWeight = predictions.filter(p => p.pred === 'Tài')
                .reduce((sum, p) => sum + p.weight, 0);
            const xiuWeight = predictions.filter(p => p.pred === 'Xỉu')
                .reduce((sum, p) => sum + p.weight, 0);
            
            if (taiWeight > xiuWeight * 1.5) {
                return {
                    prediction: 'Tài',
                    confidence: 0.85,
                    reason: 'Siêu phân tích đồng thuận Tài'
                };
            } else if (xiuWeight > taiWeight * 1.5) {
                return {
                    prediction: 'Xỉu',
                    confidence: 0.85,
                    reason: 'Siêu phân tích đồng thuận Xỉu'
                };
            }
        }
        
        return { confidence: 0 };
    }
    
    // Run sub model
    runSubModel(index, history) {
        if (history.length < 3) return null;
        
        const results = this.getResultArray(history);
        const model = this.subModels[`sub_model_${index}`];
        
        if (!model) return null;
        
        let result = null;
        const type = model.type;
        
        switch (type) {
            case '1-1':
                result = this.runSubModel11(results, model);
                break;
            case '2-2':
                result = this.runSubModel22(results, model);
                break;
            case 'bệt':
                result = this.runSubModelStreak(results, model);
                break;
            case '3-3':
                result = this.runSubModel33(results, model);
                break;
            case '2-1-2':
                result = this.runSubModel212(results, model);
                break;
            case '1-2-1':
                result = this.runSubModel121(results, model);
                break;
            case 'break':
            case 'transition':
                result = this.runSubModelBreak(results, model);
                break;
            default:
                result = this.runSubModelAdvanced(results, model);
        }
        
        if (result) {
            result.model_name = model.name;
            return result;
        }
        
        return null;
    }
    
    // Run mini model
    runMiniModel(index, history) {
        if (history.length < 2) return null;
        
        const results = this.getResultArray(history);
        const miniModel = this.miniModels[`mini_model_${index}`];
        
        let prediction, confidence, reason;
        
        switch (miniModel.specialty) {
            case 'phat_hien_cau_dep':
                const pattern = this.analyzeBasicPatterns(history);
                prediction = pattern.prediction;
                confidence = pattern.confidence * 0.9;
                reason = pattern.reason;
                break;
                
            case 'du_doan_bien_dong':
                const dice = this.analyzeDiceVolatility(history);
                prediction = dice.prediction;
                confidence = dice.confidence * 0.8;
                reason = dice.reason;
                break;
                
            case 'nhan_dien_xu_huong_cuc_bo':
                const short = this.analyzeShortTerm(history);
                prediction = short.prediction;
                confidence = short.confidence * 0.85;
                reason = short.reason;
                break;
                
            case 'tinh_toan_xac_suat_cao':
                const taiCount = results.filter(r => r === 'Tài').length;
                const xiuCount = results.length - taiCount;
                if (taiCount > xiuCount * 1.5) {
                    prediction = 'Xỉu';
                    confidence = 0.7;
                    reason = 'Xác suất Tài cao, dự đoán Xỉu để cân bằng';
                } else if (xiuCount > taiCount * 1.5) {
                    prediction = 'Tài';
                    confidence = 0.7;
                    reason = 'Xác suất Xỉu cao, dự đoán Tài để cân bằng';
                } else {
                    prediction = results[results.length - 1];
                    confidence = 0.5;
                    reason = 'Xác suất cân bằng';
                }
                break;
                
            case 'phan_tich_so_sanh':
                // So sánh với các mẫu trong thư viện
                const currentPattern = results.slice(-5).join('');
                let matchFound = false;
                for (let [type, patterns] of Object.entries(this.patternLibrary)) {
                    if (patterns.includes(currentPattern)) {
                        matchFound = true;
                        prediction = results[results.length - 1] === 'Tài' ? 'Xỉu' : 'Tài';
                        confidence = 0.75;
                        reason = `Khớp mẫu ${type} trong thư viện`;
                        break;
                    }
                }
                if (!matchFound) {
                    prediction = results[results.length - 1];
                    confidence = 0.4;
                    reason = 'Không tìm thấy mẫu tương tự';
                }
                break;
                
            default:
                // Các mini model khác dùng logic đơn giản
                const random = Math.random();
                if (random < 0.4) {
                    prediction = results[results.length - 1];
                    confidence = 0.5;
                } else if (random < 0.7) {
                    prediction = results[results.length - 1] === 'Tài' ? 'Xỉu' : 'Tài';
                    confidence = 0.5;
                } else {
                    const streak = this.getStreak(results);
                    if (streak >= 3) {
                        prediction = results[results.length - 1];
                        confidence = 0.6;
                    } else {
                        prediction = results[results.length - 1] === 'Tài' ? 'Xỉu' : 'Tài';
                        confidence = 0.5;
                    }
                }
                reason = `Mini model ${index} (${miniModel.specialty})`;
        }
        
        return {
            prediction,
            confidence: Math.min(confidence, 0.95),
            reason,
            model_name: `mini_${index}_${miniModel.specialty}`
        };
    }
    
    // Model 1: Nhận biết các loại cầu cơ bản
    analyzeBasicPatterns(history) {
        if (history.length < 3) {
            return { prediction: null, confidence: 0, reason: 'Không đủ dữ liệu' };
        }
        
        const results = this.getResultArray(history);
        
        const patterns = {
            '1-1': this.checkAlternatingPattern(results),
            '1-2-1': this.checkPattern121(results),
            '2-1-2': this.checkPattern212(results),
            '3-1': this.checkPattern31(results),
            '1-3': this.checkPattern13(results),
            '2-2': this.checkPattern22(results),
            'cầu_bệt': this.checkStreakPattern(results),
            'cầu_đảo': this.checkReversalPattern(results)
        };
        
        // Lọc pattern có confidence > 0
        const validPatterns = {};
        for (let [key, value] of Object.entries(patterns)) {
            if (value && value.confidence > 0) {
                validPatterns[key] = value;
            }
        }
        
        if (Object.keys(validPatterns).length === 0) {
            return {
                prediction: results[results.length - 1],
                confidence: 0.3,
                reason: 'Không phát hiện pattern rõ ràng'
            };
        }
        
        // Tìm pattern tốt nhất
        let bestPattern = null;
        let bestConfidence = 0;
        let bestKey = '';
        
        for (let [key, value] of Object.entries(validPatterns)) {
            if (value.confidence > bestConfidence) {
                bestConfidence = value.confidence;
                bestPattern = value;
                bestKey = key;
            }
        }
        
        return {
            prediction: bestPattern.prediction,
            confidence: bestPattern.confidence,
            pattern_type: bestKey,
            reason: `Phát hiện cầu ${bestKey} với độ tin cậy ${(bestPattern.confidence * 100).toFixed(0)}%`
        };
    }
    
    checkAlternatingPattern(results) {
        if (results.length < 2) {
            return { prediction: null, confidence: 0 };
        }
        
        const last = results[results.length - 1];
        const pred = last === 'Tài' ? 'Xỉu' : 'Tài';
        
        let confidence = 0.5;
        for (let i = results.length - 2; i >= Math.max(results.length - 6, 0); i -= 2) {
            if (results[i] === last) {
                confidence += 0.1;
            } else {
                break;
            }
        }
        
        return { prediction: pred, confidence: Math.min(confidence, 0.95) };
    }
    
    checkPattern121(results) {
        if (results.length < 3) {
            return { prediction: null, confidence: 0 };
        }
        
        if (results[results.length - 3] === results[results.length - 1] && 
            results[results.length - 2] !== results[results.length - 1]) {
            return { prediction: results[results.length - 1], confidence: 0.7 };
        } else {
            return { prediction: results[results.length - 1], confidence: 0.3 };
        }
    }
    
    checkPattern212(results) {
        if (results.length < 3) {
            return { prediction: null, confidence: 0 };
        }
        
        if (results[results.length - 3] !== results[results.length - 1] && 
            results[results.length - 2] === results[results.length - 1]) {
            return { prediction: results[results.length - 2], confidence: 0.7 };
        } else {
            return { prediction: results[results.length - 1], confidence: 0.3 };
        }
    }
    
    checkPattern31(results) {
        if (results.length < 4) {
            return { prediction: null, confidence: 0 };
        }
        
        if (results[results.length - 4] === results[results.length - 3] && 
            results[results.length - 3] === results[results.length - 2] && 
            results[results.length - 2] !== results[results.length - 1]) {
            return { prediction: results[results.length - 1], confidence: 0.8 };
        } else {
            return { prediction: results[results.length - 1], confidence: 0.2 };
        }
    }
    
    checkPattern13(results) {
        if (results.length < 4) {
            return { prediction: null, confidence: 0 };
        }
        
        if (results[results.length - 4] !== results[results.length - 3] && 
            results[results.length - 3] === results[results.length - 2] && 
            results[results.length - 2] === results[results.length - 1]) {
            return { prediction: results[results.length - 1], confidence: 0.8 };
        } else {
            return { prediction: results[results.length - 1], confidence: 0.2 };
        }
    }
    
    checkPattern22(results) {
        if (results.length < 4) {
            return { prediction: null, confidence: 0 };
        }
        
        if (results[results.length - 4] === results[results.length - 3] && 
            results[results.length - 2] === results[results.length - 1] && 
            results[results.length - 3] !== results[results.length - 2]) {
            return { prediction: results[results.length - 1], confidence: 0.75 };
        } else {
            return { prediction: results[results.length - 1], confidence: 0.25 };
        }
    }
    
    checkStreakPattern(results) {
        let streak = 1;
        for (let i = results.length - 2; i >= 0; i--) {
            if (results[i] === results[results.length - 1]) {
                streak++;
            } else {
                break;
            }
        }
        
        if (streak >= 3) {
            let confidence = 0.6 + (streak * 0.05);
            return { prediction: results[results.length - 1], confidence: Math.min(confidence, 0.9) };
        } else {
            const other = results[results.length - 1] === 'Tài' ? 'Xỉu' : 'Tài';
            if (streak >= 6) {
                return { prediction: other, confidence: 0.65 };
            }
            return { prediction: results[results.length - 1], confidence: 0.4 };
        }
    }
    
    checkReversalPattern(results) {
        if (results.length < 3) {
            return { prediction: null, confidence: 0 };
        }
        
        if (results[results.length - 2] !== results[results.length - 1]) {
            return { prediction: results[results.length - 1], confidence: 0.5 };
        } else {
            const other = results[results.length - 1] === 'Tài' ? 'Xỉu' : 'Tài';
            return { prediction: other, confidence: 0.4 };
        }
    }
    
    // Model 2: Bắt trend
    analyzeTrend(history) {
        if (history.length < 5) {
            return { prediction: null, confidence: 0, reason: 'Không đủ dữ liệu' };
        }
        
        const results = this.getResultArray(history);
        
        // Xu hướng ngắn (3 phiên)
        const shortTerm = results.slice(-3);
        const shortCounts = this.countResults(shortTerm);
        const shortTrend = this.getMostCommon(shortCounts);
        
        // Xu hướng dài (10 phiên)
        const longTerm = results.slice(-10);
        const longCounts = this.countResults(longTerm);
        const longTrend = this.getMostCommon(longCounts);
        
        // Momentum
        const momentum = this.calculateMomentum(results);
        
        if (shortTrend.count >= 2 && longTrend.count >= 6) {
            return {
                prediction: shortTrend.value,
                confidence: Math.min(0.7 + momentum * 0.1, 0.95),
                momentum: momentum,
                reason: `Xu hướng ngắn và dài đều nghiêng về ${shortTrend.value}`
            };
        } else if (shortTrend.count >= 2) {
            return {
                prediction: shortTrend.value,
                confidence: Math.min(0.6 + momentum * 0.1, 0.95),
                momentum: momentum,
                reason: `Xu hướng ngắn hạn nghiêng về ${shortTrend.value}`
            };
        } else if (longTrend.count >= 6) {
            return {
                prediction: longTrend.value,
                confidence: Math.min(0.6 + momentum * 0.1, 0.95),
                momentum: momentum,
                reason: `Xu hướng dài hạn nghiêng về ${longTrend.value}`
            };
        } else {
            const other = results[results.length - 1] === 'Tài' ? 'Xỉu' : 'Tài';
            return {
                prediction: other,
                confidence: 0.5,
                momentum: momentum,
                reason: "Không có trend rõ ràng, dự đoán đảo chiều"
            };
        }
    }
    
    countResults(results) {
        const counts = { 'Tài': 0, 'Xỉu': 0 };
        results.forEach(r => counts[r]++);
        return counts;
    }
    
    getMostCommon(counts) {
        if (counts['Tài'] >= counts['Xỉu']) {
            return { value: 'Tài', count: counts['Tài'] };
        } else {
            return { value: 'Xỉu', count: counts['Xỉu'] };
        }
    }
    
    calculateMomentum(results) {
        if (results.length < 5) return 0;
        
        const recent = results.slice(-5);
        const taiCount = recent.filter(r => r === 'Tài').length;
        
        if (taiCount === 5 || taiCount === 0) return 0.3;
        if (taiCount >= 3 || taiCount <= 2) return 0.15;
        return 0;
    }
    
    // Model 3: Chênh lệch 12 phiên
    analyzeImbalance(history) {
        if (history.length < 12) {
            return { prediction: null, confidence: 0, reason: 'Không đủ 12 phiên' };
        }
        
        const results = this.getResultArray(history.slice(-12));
        const countTai = results.filter(r => r === 'Tài').length;
        const countXiu = results.length - countTai;
        
        const imbalanceRatio = Math.abs(countTai - countXiu) / 12;
        
        if (imbalanceRatio > 0.4) {
            if (countTai > countXiu) {
                return {
                    prediction: 'Xỉu',
                    confidence: Math.min(0.7 + imbalanceRatio * 0.2, 0.95),
                    tai_count: countTai,
                    xiu_count: countXiu,
                    reason: `Chênh lệch lớn (${countTai}T - ${countXiu}X), dự đoán Xỉu để cân bằng`
                };
            } else {
                return {
                    prediction: 'Tài',
                    confidence: Math.min(0.7 + imbalanceRatio * 0.2, 0.95),
                    tai_count: countTai,
                    xiu_count: countXiu,
                    reason: `Chênh lệch lớn (${countTai}T - ${countXiu}X), dự đoán Tài để cân bằng`
                };
            }
        } else {
            return {
                prediction: results[results.length - 1],
                confidence: 0.5,
                tai_count: countTai,
                xiu_count: countXiu,
                reason: `Chênh lệch ${countTai}T - ${countXiu}X trong 12 phiên, tiếp tục xu hướng`
            };
        }
    }
    
    // Model 4: Ngắn hạn
    analyzeShortTerm(history) {
        if (history.length < 3) {
            return { prediction: null, confidence: 0, reason: 'Không đủ dữ liệu' };
        }
        
        const results = this.getResultArray(history);
        const last3 = results.slice(-3);
        
        const patterns = [];
        
        // Pattern 3 liên tiếp
        if (last3[0] === last3[1] && last3[1] === last3[2]) {
            patterns.push({ type: 'bệt', prediction: last3[0], confidence: 0.75 });
        }
        
        // Pattern 2-1
        if (last3[0] === last3[1] && last3[1] !== last3[2]) {
            patterns.push({ type: '2-1', prediction: last3[2], confidence: 0.7 });
        }
        
        // Pattern 1-2
        if (last3[0] !== last3[1] && last3[1] === last3[2]) {
            const other = last3[2] === 'Tài' ? 'Xỉu' : 'Tài';
            patterns.push({ type: '1-2', prediction: other, confidence: 0.65 });
        }
        
        // Pattern xen kẽ
        if (results.length >= 4) {
            const last4 = results.slice(-4);
            if (last4[0] !== last4[1] && last4[1] !== last4[2] && last4[2] !== last4[3]) {
                const other = last4[3] === 'Tài' ? 'Xỉu' : 'Tài';
                patterns.push({ type: 'xen_kẽ', prediction: other, confidence: 0.8 });
            }
        }
        
        if (patterns.length > 0) {
            const bestPattern = patterns.reduce((best, current) => 
                current.confidence > best.confidence ? current : best
            );
            
            return {
                prediction: bestPattern.prediction,
                confidence: bestPattern.confidence,
                pattern: bestPattern.type,
                reason: `Phát hiện pattern ${bestPattern.type} trong ngắn hạn`
            };
        } else {
            return {
                prediction: results[results.length - 1],
                confidence: 0.4,
                pattern: 'không_rõ',
                reason: "Không phát hiện pattern ngắn hạn rõ ràng"
            };
        }
    }
    
    // Model 11: Biến động xúc xắc
    analyzeDiceVolatility(history) {
        if (history.length < 5) {
            return { prediction: null, confidence: 0, reason: 'Không đủ dữ liệu' };
        }
        
        // Lấy mặt xúc xắc từ history
        const faceSequences = [];
        history.forEach(h => {
            if (h.Xuc_xac_1) faceSequences.push(h.Xuc_xac_1);
            if (h.Xuc_xac_2) faceSequences.push(h.Xuc_xac_2);
            if (h.Xuc_xac_3) faceSequences.push(h.Xuc_xac_3);
        });
        
        if (faceSequences.length === 0) {
            return { prediction: null, confidence: 0, reason: 'Không có dữ liệu mặt xúc xắc' };
        }
        
        // Tần suất xuất hiện
        const faceFreq = {};
        for (let i = 1; i <= 6; i++) faceFreq[i] = 0;
        faceSequences.forEach(f => faceFreq[f]++);
        
        // 5 phiên gần nhất
        const recentFaces = [];
        const recentHistory = history.slice(-5);
        recentHistory.forEach(h => {
            if (h.Xuc_xac_1) recentFaces.push(h.Xuc_xac_1);
            if (h.Xuc_xac_2) recentFaces.push(h.Xuc_xac_2);
            if (h.Xuc_xac_3) recentFaces.push(h.Xuc_xac_3);
        });
        
        const recentFreq = {};
        for (let i = 1; i <= 6; i++) recentFreq[i] = 0;
        recentFaces.forEach(f => recentFreq[f]++);
        
        // Dự đoán mặt có khả năng cao
        const predictions = [];
        for (let face = 1; face <= 6; face++) {
            if (recentFreq[face] < 2) {
                const prob = 0.3 + (2 - recentFreq[face]) * 0.1;
                predictions.push({ face, prob });
            }
        }
        
        if (predictions.length > 0) {
            predictions.sort((a, b) => b.prob - a.prob);
            const topFaces = predictions.slice(0, 3);
            
            if (topFaces.length >= 3) {
                const predictedScores = [];
                for (let i = 0; i < topFaces.length; i++) {
                    for (let j = i; j < topFaces.length; j++) {
                        for (let k = j; k < topFaces.length; k++) {
                            predictedScores.push(topFaces[i].face + topFaces[j].face + topFaces[k].face);
                        }
                    }
                }
                
                if (predictedScores.length > 0) {
                    const avgPredicted = predictedScores.reduce((a, b) => a + b, 0) / predictedScores.length;
                    const predType = avgPredicted >= 11 ? 'Tài' : 'Xỉu';
                    
                    return {
                        prediction: predType,
                        confidence: 0.65,
                        predicted_faces: topFaces.map(f => f.face),
                        reason: `Dựa trên biến động xúc xắc, các mặt ${topFaces.map(f => f.face).join(',')} có khả năng xuất hiện cao`
                    };
                }
            } else if (topFaces.length === 2) {
                const predictedScores = [];
                for (let i = 0; i < topFaces.length; i++) {
                    for (let j = i; j < topFaces.length; j++) {
                        for (let k = j; k < topFaces.length; k++) {
                            predictedScores.push(topFaces[i].face + topFaces[j].face + topFaces[k].face);
                        }
                    }
                }
                
                if (predictedScores.length > 0) {
                    const avgPredicted = predictedScores.reduce((a, b) => a + b, 0) / predictedScores.length;
                    const predType = avgPredicted >= 11 ? 'Tài' : 'Xỉu';
                    
                    return {
                        prediction: predType,
                        confidence: 0.6,
                        predicted_faces: topFaces.map(f => f.face),
                        reason: `Dựa trên biến động xúc xắc, các mặt ${topFaces.map(f => f.face).join(',')} có khả năng xuất hiện cao`
                    };
                }
            } else {
                const face = topFaces[0].face;
                const avgOther = 3.5;
                const avgPredicted = face + avgOther + avgOther;
                const predType = avgPredicted >= 11 ? 'Tài' : 'Xỉu';
                
                return {
                    prediction: predType,
                    confidence: 0.55,
                    predicted_faces: [face],
                    reason: `Dựa trên biến động xúc xắc, mặt ${face} có khả năng xuất hiện cao`
                };
            }
        }
        
        return {
            prediction: history[history.length - 1].Ket_qua || (history[history.length - 1].score >= 11 ? 'Tài' : 'Xỉu'),
            confidence: 0.4,
            reason: "Không phát hiện biến động đặc biệt"
        };
    }
    
    // Ensemble tất cả các model
    ensembleModels(history) {
        const modelResults = {};
        
        // Chạy các model chính
        modelResults.model1 = this.analyzeBasicPatterns(history);
        modelResults.model2 = this.analyzeTrend(history);
        modelResults.model3 = this.analyzeImbalance(history);
        modelResults.model4 = this.analyzeShortTerm(history);
        modelResults.model11 = this.analyzeDiceVolatility(history);
        
        // Chạy sub models (1-42)
        for (let i = 1; i <= 42; i++) {
            const subResult = this.runSubModel(i, history);
            if (subResult && subResult.prediction) {
                modelResults[`sub_model_${i}`] = subResult;
            }
        }
        
        // Chạy mini models (1-21)
        for (let i = 1; i <= 21; i++) {
            const miniResult = this.runMiniModel(i, history);
            if (miniResult && miniResult.prediction) {
                modelResults[`mini_model_${i}`] = miniResult;
            }
        }
        
        // Tính weighted vote
        let taiWeight = 0;
        let xiuWeight = 0;
        let totalWeight = 0;
        let details = [];
        
        for (let [modelName, result] of Object.entries(modelResults)) {
            if (result && result.prediction && result.confidence > 0.3) {
                // Lấy weight phù hợp
                let weight = 1.0;
                if (modelName.startsWith('sub')) {
                    weight = this.subModelWeights[modelName] || 1.0;
                } else if (modelName.startsWith('mini')) {
                    weight = this.miniModelWeights[modelName] || 1.0;
                } else {
                    weight = this.modelWeights[modelName] || 1.0;
                }
                
                const weightedConfidence = weight * result.confidence;
                
                if (result.prediction === 'Tài') {
                    taiWeight += weightedConfidence;
                } else if (result.prediction === 'Xỉu') {
                    xiuWeight += weightedConfidence;
                }
                
                totalWeight += weightedConfidence;
                details.push({
                    model: result.model_name || modelName,
                    prediction: result.prediction,
                    confidence: result.confidence,
                    weight: weight,
                    reason: result.reason
                });
            }
        }
        
        // Sắp xếp details theo confidence giảm dần
        details.sort((a, b) => b.confidence - a.confidence);
        
        // Quyết định cuối cùng
        let finalPrediction, finalConfidence, finalReason, finalPattern, finalType;
        
        if (totalWeight > 0) {
            const taiRatio = taiWeight / totalWeight;
            const xiuRatio = xiuWeight / totalWeight;
            
            if (taiRatio > 0.55) {
                finalPrediction = 'Tài';
                finalConfidence = taiRatio;
                finalReason = `${details.length} models đồng thuận Tài (${(taiRatio*100).toFixed(1)}%)`;
            } else if (xiuRatio > 0.55) {
                finalPrediction = 'Xỉu';
                finalConfidence = xiuRatio;
                finalReason = `${details.length} models đồng thuận Xỉu (${(xiuRatio*100).toFixed(1)}%)`;
            } else {
                // Tỉ lệ cân bằng, dùng model có confidence cao nhất
                const bestModel = details[0];
                if (bestModel) {
                    finalPrediction = bestModel.prediction;
                    finalConfidence = 0.5 + bestModel.confidence * 0.2;
                    finalReason = `Tỉ lệ cân bằng, dùng model ${bestModel.model}: ${bestModel.reason}`;
                } else {
                    finalPrediction = history.length > 0 ? 
                        (history[history.length - 1].Ket_qua || 
                         (history[history.length - 1].score >= 11 ? 'Tài' : 'Xỉu')) : 'Tài';
                    finalConfidence = 0.5;
                    finalReason = "Không có model nào đủ tin cậy";
                }
            }
        } else {
            finalPrediction = history.length > 0 ? 
                (history[history.length - 1].Ket_qua || 
                 (history[history.length - 1].score >= 11 ? 'Tài' : 'Xỉu')) : 'Tài';
            finalConfidence = 0.5;
            finalReason = "Không đủ dữ liệu model";
        }
        
        // Lấy pattern type từ model tốt nhất
        if (details.length > 0) {
            finalType = details[0].model;
            finalPattern = history.length > 0 ? 
                this.getResultArray(history.slice(-5)).join('') : '';
        } else {
            finalType = 'Không xác định';
            finalPattern = '';
        }
        
        return {
            prediction: finalPrediction,
            confidence: finalConfidence,
            reason: finalReason,
            pattern_type: finalType,
            pattern: finalPattern,
            details: details.slice(0, 5) // Top 5 models
        };
    }
    
    // Cập nhật trọng số model dựa trên kết quả
    updateModelWeights(actual, predicted, confidence) {
        const correct = (actual === predicted) ? 1 : 0;
        
        // Update main models
        for (let modelName in this.modelWeights) {
            if (correct) {
                this.modelWeights[modelName] = Math.min(this.modelWeights[modelName] * 1.01, 2.0);
            } else {
                this.modelWeights[modelName] = Math.max(this.modelWeights[modelName] * 0.99, 0.5);
            }
        }
        
        // Update sub models
        for (let modelName in this.subModelWeights) {
            if (correct) {
                this.subModelWeights[modelName] = Math.min(this.subModelWeights[modelName] * 1.005, 1.5);
            } else {
                this.subModelWeights[modelName] = Math.max(this.subModelWeights[modelName] * 0.995, 0.7);
            }
        }
        
        // Update mini models
        for (let modelName in this.miniModelWeights) {
            if (correct) {
                this.miniModelWeights[modelName] = Math.min(this.miniModelWeights[modelName] * 1.003, 1.3);
            } else {
                this.miniModelWeights[modelName] = Math.max(this.miniModelWeights[modelName] * 0.997, 0.8);
            }
        }
        
        // weights auto-saved in memory
    }
}

// Initialize analyzer
const analyzer = new TaiXiuAnalyzer();

// ── WRAPPER: chuyển globalHistory (["TAI","XIU",...]) → format analyzer ──
function historyToAnalyzerFormat(history) {
    return history.map(r => ({
        Ket_qua: r === 'TAI' ? 'Tài' : 'Xỉu',
        score: r === 'TAI' ? 11 : 10,
        Xuc_xac_1: 0, Xuc_xac_2: 0, Xuc_xac_3: 0
    }));
}

function predictNext(history) {
    if (history.length < 4) {
        return { pred: 'TAI', conf: 50, n_active: 0, signals: [], regime: 'INIT', reason: 'Chưa đủ dữ liệu' };
    }
    try {
        const formatted = historyToAnalyzerFormat(history);
        const result = analyzer.ensembleModels(formatted);
        if (!result || !result.prediction) {
            console.error('[❌] ensembleModels trả về rỗng:', JSON.stringify(result).slice(0,200));
            return { pred: history[history.length-1], conf: 50, n_active: 0, signals: [], regime: 'FALLBACK', reason: 'Engine lỗi - dùng kết quả trước' };
        }
        const pred = result.prediction === 'Tài' ? 'TAI' : 'XIU';
        const conf = Math.round(result.confidence * 100);
        return {
            pred,
            conf: Math.max(50, Math.min(95, conf)),
            n_active: result.details ? result.details.length : 0,
            signals: result.details ? result.details.slice(0,3).map(d => d.model) : [],
            regime: result.pattern_type || 'N/A',
            reason: result.reason || ''
        };
    } catch(e) {
        console.error('[❌] predictNext exception:', e.message, e.stack?.slice(0,300));
        return { pred: history[history.length-1] || 'TAI', conf: 50, n_active: 0, signals: [], regime: 'ERROR', reason: 'Lỗi: ' + e.message };
    }
}

// Cập nhật trọng số sau mỗi phiên có kết quả
function updateAnalyzerWeights(actual, predicted, confidence) {
    const actualStr = actual === 'TAI' ? 'Tài' : 'Xỉu';
    const predictedStr = predicted === 'TAI' ? 'Tài' : 'Xỉu';
    analyzer.updateModelWeights(actualStr, predictedStr, confidence);
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
  if (strategy === 'trend')   return SIGNALS.filter(([t]) => ['MK1','MK2','MK3','SF','P3','P4','P5','WRE','VWB','HMM','BAY'].includes(t));
  if (strategy === 'reverse') return SIGNALS.filter(([t]) => ['SB3','SB5','MDK','MVR','ENT','ALB','RLE','ADP'].includes(t));
  if (strategy === 'cycle')   return SIGNALS.filter(([t]) => ['CY4','CY6','CY8','DP2','FOU','ACR'].includes(t));
  if (strategy === 'recent')  return SIGNALS.filter(([t]) => ['WRE','VWB','B10','ENT','MK1','ADP'].includes(t));
  if (strategy === 'deep')    return SIGNALS.filter(([t]) => ['HMM','FOU','ACR','BAY','RLE','CP3','TSI','ADP'].includes(t));
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
  const activeSet = getSignalsByStrategy(strategy, seq);
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
            // Cập nhật trọng số analyzer
            const _lastH = globalHistory[globalHistory.length-1];
            if (this.lastPred && this.lastPred.pred && _lastH) {
              updateAnalyzerWeights(_lastH, this.lastPred.pred, (this.lastPred.conf||50)/100);
            }
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
        <div style="margin-bottom:8px">🧠 <span style="color:var(--t1);font-weight:600">TaiXiu Analyzer Engine</span></div>
        <div>• 84 model chuyên biệt: cầu 1-1, 2-2, 3-3, bệt, 2-1-2...</div>
        <div>• Tự học: trọng số tự điều chỉnh sau mỗi phiên thắng/thua</div>
        <div>• Voting có trọng số từ tất cả model hoạt động</div>
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
    document.getElementById('dRegime').textContent=pred.regime||'—';
    document.getElementById('dSig').textContent=pred.n_active??'0';
    const rEl=document.getElementById('dReason');
    if(rEl)rEl.textContent=pred.reason||'';
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
