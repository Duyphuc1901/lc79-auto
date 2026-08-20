import { useState, useEffect, useRef, useCallback } from 'react'

const fmt = (n) => Number(n || 0).toLocaleString('vi-VN')
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`

const LOG_COLORS = {
  info: '#4a9eff', pred: '#f0b429', result: '#d4dbe8',
  win: '#00d48a', lose: '#ff4f6a', bet: '#c084fc',
  warn: '#fb923c', error: '#ff4f6a',
}

export default function App() {
  const [state, setState] = useState(null)
  const [logs, setLogs] = useState([])
  const [connected, setConnected] = useState(false)
  const [view, setView] = useState('dashboard') // 'dashboard' | 'login' | 'config'
  const wsRef = useRef(null)
  const logsEndRef = useRef(null)

  // Login form
  const [loginForm, setLoginForm] = useState({ username: '', password: '' })
  const [loginLoading, setLoginLoading] = useState(false)
  const [loginError, setLoginError] = useState('')

  // Config form
  const [cfg, setCfg] = useState({
    baseAmount: 1000, x2Enabled: false, x2MaxLevel: 5,
    stopLossPercent: 30, algoEnabled: true, fixedSide: ''
  })

  // Connect dashboard WS
  useEffect(() => {
    function connect() {
      const ws = new window.WebSocket(WS_URL)
      wsRef.current = ws
      ws.onopen = () => setConnected(true)
      ws.onclose = () => { setConnected(false); setTimeout(connect, 3000) }
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data)
        if (msg.type === 'state') {
          setState(msg.data)
          if (msg.data) setCfg(c => ({
            ...c,
            baseAmount: msg.data.baseAmount,
            x2Enabled: msg.data.x2Enabled,
            x2MaxLevel: msg.data.x2MaxLevel,
            stopLossPercent: Math.round(msg.data.stopLossPercent * 100),
            algoEnabled: msg.data.algoEnabled,
            fixedSide: msg.data.fixedSide || '',
          }))
        }
        if (msg.type === 'logs') setLogs(msg.data)
        if (msg.type === 'log') setLogs(l => [msg.data, ...l].slice(0, 200))
      }
    }
    connect()
    return () => wsRef.current?.close()
  }, [])

  const api = useCallback(async (path, body) => {
    const r = await fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    return r.json()
  }, [])

  const handleLogin = async () => {
    setLoginLoading(true); setLoginError('')
    const res = await api('/api/login', { ...loginForm, config: cfg })
    setLoginLoading(false)
    if (res.error) setLoginError(res.error)
    else setView('dashboard')
  }

  const handleLogout = async () => {
    await api('/api/logout', {})
    setState(null)
    setView('dashboard')
  }

  const handleConfig = async () => {
    await api('/api/config', cfg)
    setView('dashboard')
  }

  const toggleAuto = async () => {
    if (!state) return
    await api(state.autoRunning ? '/api/auto/stop' : '/api/auto/start', {})
  }

  const pred = state?.lastPred
  const isLoggedIn = !!state

  return (
    <div style={S.root}>
      {/* Header */}
      <header style={S.header}>
        <div style={S.headerLeft}>
          <span style={S.logo}>◈ AUTO<span style={{color:'var(--gold)'}}>LC</span></span>
          <span style={{...S.dot, background: connected ? '#00d48a' : '#ff4f6a'}} />
          <span style={{...S.dimText, fontSize: 11}}>{connected ? 'Kết nối' : 'Mất kết nối'}</span>
        </div>
        <nav style={S.nav}>
          {['dashboard','config'].map(v => (
            <button key={v} onClick={() => setView(v)}
              style={{...S.navBtn, ...(view===v ? S.navActive : {})}}>
              {v === 'dashboard' ? '📊 Dashboard' : '⚙️ Cấu hình'}
            </button>
          ))}
          {!isLoggedIn
            ? <button style={{...S.navBtn, color:'var(--tai)'}} onClick={() => setView('login')}>🔐 Đăng nhập</button>
            : <button style={{...S.navBtn, color:'var(--xiu)'}} onClick={handleLogout}>👋 Đăng xuất</button>
          }
        </nav>
      </header>

      <main style={S.main}>

        {/* ── LOGIN ── */}
        {view === 'login' && (
          <div style={S.centerCard}>
            <h2 style={S.cardTitle}>Đăng nhập LC79</h2>
            <input style={S.input} placeholder="Tên đăng nhập"
              value={loginForm.username} onChange={e => setLoginForm(f => ({...f, username: e.target.value}))} />
            <input style={S.input} type="password" placeholder="Mật khẩu"
              value={loginForm.password} onChange={e => setLoginForm(f => ({...f, password: e.target.value}))} />
            {loginError && <p style={{color:'var(--xiu)',fontSize:13}}>{loginError}</p>}
            <button style={S.btnPrimary} onClick={handleLogin} disabled={loginLoading}>
              {loginLoading ? '⏳ Đang kết nối...' : '🔐 Đăng nhập'}
            </button>
          </div>
        )}

        {/* ── CONFIG ── */}
        {view === 'config' && (
          <div style={S.centerCard}>
            <h2 style={S.cardTitle}>⚙️ Cấu hình Bot</h2>

            <label style={S.label}>Mức cược cố định (đ)</label>
            <input style={S.input} type="number" value={cfg.baseAmount}
              onChange={e => setCfg(c => ({...c, baseAmount: +e.target.value}))} />

            <label style={S.label}>Stop-loss (%)</label>
            <input style={S.input} type="number" min="1" max="100" value={cfg.stopLossPercent}
              onChange={e => setCfg(c => ({...c, stopLossPercent: +e.target.value}))} />

            <label style={S.label}>Cầu chốt (TAI / XIU / để trống = AI tự chọn)</label>
            <select style={S.input} value={cfg.fixedSide} onChange={e => setCfg(c => ({...c, fixedSide: e.target.value}))}>
              <option value="">🤖 AI tự chọn</option>
              <option value="TAI">🟢 Luôn TÀI</option>
              <option value="XIU">🔴 Luôn XỈU</option>
            </select>

            <div style={S.row}>
              <label style={S.label}>Gấp thếp X2</label>
              <button style={cfg.x2Enabled ? S.toggleOn : S.toggleOff}
                onClick={() => setCfg(c => ({...c, x2Enabled: !c.x2Enabled}))}>
                {cfg.x2Enabled ? 'BẬT' : 'TẮT'}
              </button>
            </div>

            {cfg.x2Enabled && <>
              <label style={S.label}>Giới hạn X2 tối đa (lần)</label>
              <input style={S.input} type="number" min="1" max="10" value={cfg.x2MaxLevel}
                onChange={e => setCfg(c => ({...c, x2MaxLevel: +e.target.value}))} />
            </>}

            <div style={S.row}>
              <label style={S.label}>AI phân tích</label>
              <button style={cfg.algoEnabled ? S.toggleOn : S.toggleOff}
                onClick={() => setCfg(c => ({...c, algoEnabled: !c.algoEnabled}))}>
                {cfg.algoEnabled ? 'BẬT' : 'TẮT'}
              </button>
            </div>

            <button style={S.btnPrimary} onClick={handleConfig}>💾 Lưu cấu hình</button>
          </div>
        )}

        {/* ── DASHBOARD ── */}
        {view === 'dashboard' && (
          <div style={S.grid}>

            {/* Account card */}
            <div style={S.card}>
              <div style={S.cardHead}>👤 Tài khoản</div>
              {isLoggedIn ? (<>
                <div style={S.stat}><span style={S.dimText}>Nickname</span><span style={S.mono}>{state.nickname}</span></div>
                <div style={S.stat}><span style={S.dimText}>Số dư</span>
                  <span style={{...S.mono, color:'var(--gold)', fontSize:20}}>{fmt(state.balance)}đ</span></div>
                <div style={S.stat}><span style={S.dimText}>Trạng thái</span>
                  <span style={{color: state.connected ? 'var(--tai)' : 'var(--xiu)'}}>
                    {state.connected ? '🟢 Đang kết nối' : '🔴 Mất kết nối'}
                  </span>
                </div>
              </>) : (
                <p style={{...S.dimText, marginTop:8}}>Chưa đăng nhập →
                  <button style={S.linkBtn} onClick={() => setView('login')}> Đăng nhập</button>
                </p>
              )}
            </div>

            {/* Prediction card */}
            <div style={S.card}>
              <div style={S.cardHead}>🔮 Dự đoán AI</div>
              {pred ? (<>
                <div style={{textAlign:'center', padding:'12px 0'}}>
                  <div style={{fontSize:42, fontWeight:700, fontFamily:'var(--mono)',
                    color: pred.pred === 'TAI' ? 'var(--tai)' : 'var(--xiu)'}}>
                    {pred.pred}
                  </div>
                  <div style={{fontSize:13, color:'var(--dim)', marginTop:4}}>
                    Độ tin cậy <span style={{color:'var(--gold)', fontFamily:'var(--mono)'}}>{pred.conf}%</span>
                  </div>
                </div>
                <div style={S.stat}><span style={S.dimText}>Chế độ</span>
                  <span style={S.chip}>{pred.regime}</span></div>
                <div style={S.stat}><span style={S.dimText}>Tín hiệu</span>
                  <span style={S.mono}>{pred.n_active} tích cực</span></div>
              </>) : (
                <p style={{...S.dimText, marginTop:8}}>Chờ dữ liệu phiên...</p>
              )}
            </div>

            {/* Auto control */}
            <div style={S.card}>
              <div style={S.cardHead}>🤖 Auto Cược</div>
              {isLoggedIn ? (<>
                <div style={S.stat}>
                  <span style={S.dimText}>Trạng thái</span>
                  <span style={{color: state.autoRunning ? 'var(--tai)' : 'var(--dim)'}}>
                    {state.autoRunning ? '● ĐANG CHẠY' : '○ Dừng'}
                  </span>
                </div>
                <div style={S.stat}><span style={S.dimText}>Mức cược</span>
                  <span style={S.mono}>{fmt(state.baseAmount)}đ</span></div>
                {state.x2Enabled && <div style={S.stat}><span style={S.dimText}>Gấp thếp</span>
                  <span style={S.mono}>Lv.{state.x2Level}/{state.x2MaxLevel}</span></div>}
                <div style={S.stat}><span style={S.dimText}>Phiên hiện tại</span>
                  <span style={S.mono}>#{state.sessionId || '—'}</span></div>
                <button
                  style={state.autoRunning ? S.btnDanger : S.btnSuccess}
                  onClick={toggleAuto}>
                  {state.autoRunning ? '⏹ Dừng Auto' : '▶ Bật Auto'}
                </button>
              </>) : <p style={S.dimText}>Cần đăng nhập trước</p>}
            </div>

            {/* Stats */}
            <div style={S.card}>
              <div style={S.cardHead}>📈 Thống kê</div>
              {isLoggedIn ? (<>
                <div style={S.statRow}>
                  <div style={S.statBox}><div style={{color:'var(--tai)', fontSize:22, fontFamily:'var(--mono)'}}>{state.statWin}</div><div style={S.dimText}>Thắng</div></div>
                  <div style={S.statBox}><div style={{color:'var(--xiu)', fontSize:22, fontFamily:'var(--mono)'}}>{state.statLose}</div><div style={S.dimText}>Thua</div></div>
                  <div style={S.statBox}>
                    <div style={{color: state.statProfit >= 0 ? 'var(--tai)' : 'var(--xiu)', fontSize:16, fontFamily:'var(--mono)'}}>
                      {state.statProfit >= 0 ? '+' : ''}{fmt(state.statProfit)}
                    </div>
                    <div style={S.dimText}>P/L (đ)</div>
                  </div>
                </div>
                {/* History beads */}
                <div style={{display:'flex', flexWrap:'wrap', gap:4, marginTop:12}}>
                  {(state.recentHistory || []).slice(-20).map((r,i) => (
                    <span key={i} style={{
                      width:28, height:28, borderRadius:'50%', display:'flex',
                      alignItems:'center', justifyContent:'center', fontSize:9,
                      fontFamily:'var(--mono)', fontWeight:600,
                      background: r === 'TAI' ? 'rgba(0,212,138,.15)' : 'rgba(255,79,106,.15)',
                      color: r === 'TAI' ? 'var(--tai)' : 'var(--xiu)',
                      border: `1px solid ${r === 'TAI' ? 'rgba(0,212,138,.3)' : 'rgba(255,79,106,.3)'}`,
                    }}>{r === 'TAI' ? 'T' : 'X'}</span>
                  ))}
                </div>
              </>) : <p style={S.dimText}>Cần đăng nhập trước</p>}
            </div>

            {/* Log panel — full width */}
            <div style={{...S.card, gridColumn: '1 / -1'}}>
              <div style={S.cardHead}>📋 Nhật ký hoạt động</div>
              <div style={S.logBox}>
                {logs.length === 0 && <p style={S.dimText}>Chưa có hoạt động nào...</p>}
                {logs.map((l, i) => (
                  <div key={i} style={S.logRow}>
                    <span style={{...S.logTime}}>{l.time}</span>
                    <span style={{color: LOG_COLORS[l.type] || 'var(--text)', fontFamily:'var(--mono)', fontSize:12}}>{l.msg}</span>
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            </div>

          </div>
        )}
      </main>
    </div>
  )
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const S = {
  root: { display:'flex', flexDirection:'column', minHeight:'100vh', background:'var(--bg)' },
  header: { display:'flex', alignItems:'center', justifyContent:'space-between',
    padding:'0 24px', height:52, borderBottom:'1px solid var(--border)',
    background:'rgba(17,20,24,0.95)', backdropFilter:'blur(8px)', position:'sticky', top:0, zIndex:10 },
  headerLeft: { display:'flex', alignItems:'center', gap:10 },
  logo: { fontFamily:'var(--mono)', fontWeight:600, fontSize:16, letterSpacing:2 },
  dot: { width:7, height:7, borderRadius:'50%' },
  dimText: { color:'var(--dim)', fontSize:12 },
  nav: { display:'flex', gap:4 },
  navBtn: { background:'transparent', color:'var(--dim)', padding:'5px 12px',
    borderRadius:6, fontSize:13, transition:'color .15s' },
  navActive: { color:'var(--text)', background:'var(--muted)' },
  main: { flex:1, padding:'24px 20px', maxWidth:1100, margin:'0 auto', width:'100%' },
  grid: { display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(240px, 1fr))', gap:16 },
  card: { background:'var(--surface)', border:'1px solid var(--border)', borderRadius:12, padding:16 },
  cardHead: { fontSize:12, fontWeight:600, color:'var(--dim)', letterSpacing:1,
    textTransform:'uppercase', marginBottom:12, paddingBottom:10, borderBottom:'1px solid var(--border)' },
  stat: { display:'flex', justifyContent:'space-between', alignItems:'center',
    padding:'6px 0', borderBottom:'1px solid var(--border)' },
  statRow: { display:'flex', gap:8 },
  statBox: { flex:1, background:'var(--muted)', borderRadius:8, padding:'10px 8px', textAlign:'center' },
  mono: { fontFamily:'var(--mono)', fontSize:13 },
  chip: { fontFamily:'var(--mono)', fontSize:11, background:'var(--muted)',
    padding:'2px 8px', borderRadius:4, color:'var(--gold)' },
  centerCard: { maxWidth:400, margin:'60px auto', background:'var(--surface)',
    border:'1px solid var(--border)', borderRadius:12, padding:28, display:'flex', flexDirection:'column', gap:12 },
  cardTitle: { fontSize:16, fontWeight:600, marginBottom:4 },
  label: { fontSize:12, color:'var(--dim)' },
  input: { background:'var(--muted)', border:'1px solid var(--border)', borderRadius:8,
    padding:'9px 12px', color:'var(--text)', fontSize:13, width:'100%' },
  row: { display:'flex', justifyContent:'space-between', alignItems:'center' },
  btnPrimary: { background:'var(--blue)', color:'#fff', padding:'10px 0',
    borderRadius:8, fontWeight:600, fontSize:14, marginTop:4 },
  btnSuccess: { background:'rgba(0,212,138,.15)', color:'var(--tai)',
    border:'1px solid rgba(0,212,138,.3)', borderRadius:8, padding:'10px 0',
    fontWeight:600, fontSize:14, width:'100%', marginTop:12 },
  btnDanger: { background:'rgba(255,79,106,.15)', color:'var(--xiu)',
    border:'1px solid rgba(255,79,106,.3)', borderRadius:8, padding:'10px 0',
    fontWeight:600, fontSize:14, width:'100%', marginTop:12 },
  toggleOn: { background:'rgba(0,212,138,.2)', color:'var(--tai)',
    border:'1px solid rgba(0,212,138,.4)', borderRadius:6, padding:'4px 12px', fontSize:12, fontWeight:600 },
  toggleOff: { background:'var(--muted)', color:'var(--dim)',
    border:'1px solid var(--border)', borderRadius:6, padding:'4px 12px', fontSize:12 },
  linkBtn: { background:'transparent', color:'var(--blue)', fontSize:12, textDecoration:'underline' },
  logBox: { height:240, overflowY:'auto', display:'flex', flexDirection:'column', gap:4, marginTop:4 },
  logRow: { display:'flex', gap:10, alignItems:'flex-start' },
  logTime: { color:'var(--dim)', fontFamily:'var(--mono)', fontSize:11, whiteSpace:'nowrap', marginTop:1 },
}
