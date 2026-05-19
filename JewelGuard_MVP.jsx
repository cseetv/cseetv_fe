import { useState, useRef, useCallback, useEffect } from "react";

// ============================================================
// Image Processing Engine (Client-side Canvas API)
// ============================================================
function processImage(img, maxSize = 480) {
  const cv = document.createElement("canvas");
  let w = img.width, h = img.height;
  if (Math.max(w, h) > maxSize) { const s = maxSize / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas: cv, ctx, data: ctx.getImageData(0, 0, w, h), w, h };
}

function getGray(data, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) { const idx = i * 4; g[i] = Math.round(0.299 * data[idx] + 0.587 * data[idx+1] + 0.114 * data[idx+2]); }
  return g;
}

function calcHistogram(gray) {
  const h = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) h[gray[i]]++;
  return h;
}

function calcStats(gray) {
  const n = gray.length;
  let sum = 0; for (let i = 0; i < n; i++) sum += gray[i];
  const mean = sum / n;
  let varSum = 0; for (let i = 0; i < n; i++) varSum += (gray[i] - mean) ** 2;
  const std = Math.sqrt(varSum / n);
  const hist = calcHistogram(gray);
  const prob = hist.map(v => v / n).filter(v => v > 0);
  const entropy = -prob.reduce((a, p) => a + p * Math.log2(p), 0);
  let diagnosis = "good", detail = "히스토그램이 골고루 분포 (양호)";
  const leftR = hist.slice(0, 85).reduce((a, b) => a + b, 0) / n;
  const rightR = hist.slice(170).reduce((a, b) => a + b, 0) / n;
  if (leftR > 0.6) { diagnosis = "under_exposed"; detail = "왼쪽 치우침 (저조도)"; }
  else if (rightR > 0.6) { diagnosis = "over_exposed"; detail = "오른쪽 치우침 (과노출)"; }
  else if (std < 40) { diagnosis = "low_contrast"; detail = "좁게 모임 (저대비)"; }
  return { mean: +mean.toFixed(1), std: +std.toFixed(1), entropy: +entropy.toFixed(2), diagnosis, detail, histogram: hist };
}

function contrastStretch(gray) {
  const sorted = [...gray].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.01)], hi = sorted[Math.floor(sorted.length * 0.99)];
  const range = hi - lo || 1, a = 255 / range, b = -a * lo;
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(a * gray[i] + b)));
  return { result: out, a: +a.toFixed(3), b: +b.toFixed(1), lo, hi };
}

function histogramEq(gray) {
  const hist = calcHistogram(gray), n = gray.length;
  const cdf = new Array(256); cdf[0] = hist[0];
  for (let i = 1; i < 256; i++) cdf[i] = cdf[i-1] + hist[i];
  const cdfMin = cdf.find(v => v > 0);
  const lut = cdf.map(v => Math.round(((v - cdfMin) / (n - cdfMin)) * 255));
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < n; i++) out[i] = lut[gray[i]];
  return out;
}

function grayToImageData(gray, w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { d[i*4] = d[i*4+1] = d[i*4+2] = gray[i]; d[i*4+3] = 255; }
  return new ImageData(d, w, h);
}

function grayToUrl(gray, w, h) {
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  cv.getContext("2d").putImageData(grayToImageData(gray, w, h), 0, 0);
  return cv.toDataURL();
}

function frameDiff(g1, g2, threshold = 30) {
  const n = g1.length, diff = new Uint8Array(n), bin = new Uint8Array(n);
  let motionPx = 0;
  for (let i = 0; i < n; i++) { diff[i] = Math.abs(g1[i] - g2[i]); if (diff[i] > threshold) { bin[i] = 255; motionPx++; } }
  return { diff, binary: bin, motionPixels: motionPx, ratio: +(motionPx / n).toFixed(4) };
}

// ============================================================
// UI Components
// ============================================================
const DIAG_COLORS = { under_exposed: "#F59E0B", over_exposed: "#F59E0B", low_contrast: "#EF4444", good: "#10B981" };
const DIAG_LABELS = { under_exposed: "어두움", over_exposed: "밝음", low_contrast: "저대비", good: "양호" };
const RISK_COLORS = { safe: "#10B981", warn: "#F59E0B", danger: "#EF4444" };
const RISK_LABELS = { safe: "정상", warn: "주의", danger: "위험" };

function Histogram({ hist, color = "#6366F1", height = 56, label }) {
  if (!hist) return null;
  const max = Math.max(...hist);
  return (
    <div>
      {label && <div style={{ fontSize: 10, color: "#64748B", marginBottom: 3 }}>{label}</div>}
      <svg viewBox="0 0 256 56" style={{ width: "100%", height, display: "block", background: "#0B1120", borderRadius: 6 }}>
        {hist.map((v, i) => { const bh = max > 0 ? (v / max) * 50 : 0; return <rect key={i} x={i} y={54-bh} width={1} height={bh} fill={color} opacity={0.75} />; })}
      </svg>
    </div>
  );
}

function StatCard({ label, value, unit, color = "#6366F1", sub }) {
  return (
    <div style={{ background: "#0F172A", borderRadius: 8, padding: "10px 12px", border: "1px solid #1E293B", minWidth: 0 }}>
      <div style={{ fontSize: 9, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.8 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color, fontFamily: "monospace", marginTop: 2 }}>{value}<span style={{ fontSize: 11, fontWeight: 400, color: "#64748B", marginLeft: 2 }}>{unit}</span></div>
      {sub && <div style={{ fontSize: 9, color: "#64748B", marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function RiskGauge({ value }) {
  const r = 48, circ = Math.PI * r;
  const offset = circ - (Math.min(100, Math.max(0, value)) / 100) * circ;
  const c = value > 70 ? "#EF4444" : value > 40 ? "#F59E0B" : "#10B981";
  const lv = value > 70 ? "danger" : value > 40 ? "warn" : "safe";
  return (
    <div style={{ textAlign: "center" }}>
      <svg width={120} height={76} viewBox="0 0 120 76">
        <path d="M12,68 A48,48 0 0,1 108,68" fill="none" stroke="#1E293B" strokeWidth={7} strokeLinecap="round" />
        <path d="M12,68 A48,48 0 0,1 108,68" fill="none" stroke={c} strokeWidth={7} strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={offset} style={{ transition: "all 0.6s ease" }} />
        <text x={60} y={56} textAnchor="middle" fill={c} fontSize={24} fontWeight={800} fontFamily="monospace">{Math.round(value)}</text>
        <text x={60} y={70} textAnchor="middle" fill="#64748B" fontSize={9}>{RISK_LABELS[lv]}</text>
      </svg>
    </div>
  );
}

function Badge({ status, text }) {
  const c = RISK_COLORS[status] || "#64748B";
  return <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 99, background: c + "18", color: c, border: `1px solid ${c}33`, fontWeight: 600 }}>{text || RISK_LABELS[status]}</span>;
}

function MiniChart({ data, color = "#6366F1", h = 36 }) {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data, 1), w = 200;
  const pts = data.map((d, i) => `${(i / (data.length - 1)) * w},${h - (d / max) * (h - 4) - 2}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: h, display: "block" }}>
      <polygon points={`0,${h} ${pts} ${w},${h}`} fill={color} opacity={0.12} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

function NavBtn({ icon, label, active, onClick }) {
  return (
    <button onClick={onClick} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
      padding: "6px 10px", background: active ? "#6366F118" : "transparent", border: active ? "1px solid #6366F133" : "1px solid transparent",
      borderRadius: 8, color: active ? "#6366F1" : "#64748B", fontSize: 9, cursor: "pointer", minWidth: 52, transition: "all 0.15s" }}>
      <span style={{ fontSize: 16 }}>{icon}</span>{label}
    </button>
  );
}

function FileUpload({ onLoad, label = "이미지 업로드", accept = "image/*" }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 8,
      border: "1px solid #334155", background: "#0F172A", color: "#94A3B8", fontSize: 12, cursor: "pointer" }}>
      📷 {label}
      <input type="file" accept={accept} onChange={e => { const f = e.target.files?.[0]; if (f) onLoad(f); }} style={{ display: "none" }} />
    </label>
  );
}

// ============================================================
// ROI Zone data
// ============================================================
const DEFAULT_ZONES = [
  { id: "z1", name: "진열대", level: "critical", weight: 1.0, x: 8, y: 15, w: 35, h: 40, color: "#EF4444" },
  { id: "z2", name: "금고", level: "critical", weight: 0.9, x: 60, y: 50, w: 28, h: 38, color: "#F59E0B" },
  { id: "z3", name: "출입구", level: "high", weight: 0.7, x: 55, y: 5, w: 38, h: 30, color: "#3B82F6" },
];

// Mock experiment data
const MOCK_EXP = {
  averaging: { nValues: [1,2,5,10,30,100], snrExp: [15.2,18.0,22.1,24.7,28.5,32.1], snrTheory: [15.2,18.2,22.2,25.2,30.0,35.2] },
  filters: [
    { name: "Moving Avg", size: "3×3", psnr: 22.8, edge: 71, ringing: false, ms: 2 },
    { name: "Moving Avg", size: "5×5", psnr: 24.1, edge: 64, ringing: false, ms: 3 },
    { name: "Moving Avg", size: "7×7", psnr: 24.5, edge: 55, ringing: false, ms: 5 },
    { name: "Gaussian", size: "3×3", psnr: 24.2, edge: 82, ringing: false, ms: 3 },
    { name: "Gaussian", size: "5×5", psnr: 27.8, edge: 85, ringing: false, ms: 4 },
    { name: "Gaussian", size: "7×7", psnr: 28.1, edge: 78, ringing: false, ms: 6 },
    { name: "Ideal LP", size: "c=0.1", psnr: 20.3, edge: 58, ringing: true, ms: 45 },
    { name: "Ideal LP", size: "c=0.2", psnr: 23.1, edge: 68, ringing: true, ms: 44 },
    { name: "Ideal LP", size: "c=0.3", psnr: 25.5, edge: 74, ringing: true, ms: 43 },
  ],
  pipeline: [
    { step: "원본", std: 18, entropy: 4.2, psnr: "-" },
    { step: "Averaging N=10", std: 22, entropy: 4.5, psnr: "+9.5dB" },
    { step: "Contrast Stretch", std: 52, entropy: 6.1, psnr: "+12.3dB" },
    { step: "Histogram EQ", std: 68, entropy: 7.4, psnr: "+14.1dB" },
  ],
};

// ============================================================
// Main App
// ============================================================
export default function App() {
  const [page, setPage] = useState("dashboard");
  const [monitoring, setMonitoring] = useState(false);
  const [zones, setZones] = useState(DEFAULT_ZONES);

  // Image state
  const [img1, setImg1] = useState(null); // current frame
  const [img2, setImg2] = useState(null); // previous frame
  const [analysis, setAnalysis] = useState(null);
  const [motion, setMotion] = useState(null);
  const [enhanced, setEnhanced] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [timeline, setTimeline] = useState([]);

  // Settings
  const [threshold, setThreshold] = useState(30);
  const [avgN, setAvgN] = useState(10);
  const [alertThreshold, setAlertThreshold] = useState(60);

  // Load image helper
  const loadImage = (file) => new Promise((res) => {
    const r = new FileReader(); r.onload = (e) => { const img = new Image(); img.onload = () => res(img); img.src = e.target.result; }; r.readAsDataURL(file);
  });

  // Analyze single frame
  const analyzeFrame = useCallback(async (file) => {
    const img = await loadImage(file);
    const { data, w, h } = processImage(img);
    const gray = getGray(data.data, w, h);
    const stats = calcStats(gray);

    // Enhancement pipeline
    const cs = contrastStretch(gray);
    const eq = histogramEq(cs.result);
    const steps = [
      { step: "원본", ...calcStats(gray), url: grayToUrl(gray, w, h) },
      { step: "Contrast Stretch", ...calcStats(cs.result), url: grayToUrl(cs.result, w, h), params: cs },
      { step: "Histogram EQ", ...calcStats(eq), url: grayToUrl(eq, w, h) },
    ];

    setImg1({ url: URL.createObjectURL(file), w, h, gray });
    setAnalysis({ ...stats, steps });
    setEnhanced(steps);

    // Add to timeline
    setTimeline(prev => [...prev.slice(-29), { t: new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }), motion: 0, risk: 0 }]);
  }, []);

  // Detect motion between two frames
  const detectMotion = useCallback(async (file) => {
    if (!img1) return;
    const img = await loadImage(file);
    const { data, w, h } = processImage(img);
    const gray2 = getGray(data.data, w, h);

    const result = frameDiff(img1.gray, gray2, threshold);
    const riskScore = Math.min(100, result.ratio * 2500);
    const riskLevel = riskScore > 70 ? "danger" : riskScore > 40 ? "warn" : "safe";

    const motionResult = {
      ...result, riskScore: +riskScore.toFixed(1), riskLevel,
      diffUrl: grayToUrl(result.diff, img1.w, img1.h),
      binaryUrl: grayToUrl(result.binary, img1.w, img1.h),
    };
    setMotion(motionResult);
    setImg2({ url: URL.createObjectURL(file) });

    // Timeline update
    setTimeline(prev => [...prev.slice(-29), { t: new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }), motion: result.motionPixels, risk: riskScore }]);

    // Alert if dangerous
    if (riskScore > alertThreshold) {
      setAlerts(prev => [{ id: Date.now(), time: new Date().toLocaleTimeString("ko-KR"), riskLevel, riskScore: +riskScore.toFixed(1), zone: "감지 영역", msg: `움직임 ${result.motionPixels}px 감지 (임계값 ${threshold})`, motionPx: result.motionPixels }, ...prev].slice(0, 50));
    }
  }, [img1, threshold, alertThreshold]);

  const riskScore = motion?.riskScore || 0;
  const statusKey = riskScore > 70 ? "danger" : riskScore > 40 ? "warn" : "safe";

  return (
    <div style={{ minHeight: "100vh", background: "#020617", color: "#E2E8F0", fontFamily: "'Pretendard Variable', -apple-system, BlinkMacSystemFont, sans-serif" }}>
      {/* Top Bar */}
      <div style={{ position: "sticky", top: 0, zIndex: 50, background: "#020617EE", backdropFilter: "blur(12px)", borderBottom: "1px solid #1E293B", padding: "8px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 18 }}>💎</span>
          <span style={{ fontSize: 15, fontWeight: 800, color: "#F8FAFC" }}>JewelGuard</span>
          <Badge status={statusKey} />
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: "#475569", fontFamily: "monospace" }}>{new Date().toLocaleTimeString("ko-KR")}</span>
          <button onClick={() => setMonitoring(!monitoring)} style={{ padding: "5px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 700, background: monitoring ? "#EF444420" : "#10B98120", color: monitoring ? "#EF4444" : "#10B981" }}>
            {monitoring ? "■ 중지" : "▶ 감시"}
          </button>
        </div>
      </div>

      {/* Nav */}
      <div style={{ display: "flex", justifyContent: "center", gap: 2, padding: "6px 12px", borderBottom: "1px solid #1E293B08" }}>
        {[["📊","대시보드","dashboard"],["🎯","ROI","roi"],["🔔","알림","alerts"],["📈","분석","analysis"],["⚙️","설정","settings"]].map(([i,l,k]) =>
          <NavBtn key={k} icon={i} label={l} active={page===k} onClick={()=>setPage(k)} />
        )}
      </div>

      <div style={{ padding: "10px 12px", maxWidth: 900, margin: "0 auto" }}>

        {/* ===== DASHBOARD ===== */}
        {page === "dashboard" && <>
          {/* Upload Controls */}
          <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
            <FileUpload onLoad={f => analyzeFrame(f)} label="프레임 1 (현재)" />
            <FileUpload onLoad={f => detectMotion(f)} label="프레임 2 (비교)" />
            {analysis && <span style={{ fontSize: 10, color: "#475569" }}>→ 두 번째 이미지를 업로드하면 움직임을 감지합니다</span>}
          </div>

          {!analysis ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 300, border: "2px dashed #1E293B", borderRadius: 12, color: "#475569" }}>
              <div style={{ fontSize: 40, marginBottom: 10 }}>📷</div>
              <div style={{ fontSize: 14 }}>CCTV 영상 프레임을 업로드하세요</div>
              <div style={{ fontSize: 11, marginTop: 4, color: "#334155" }}>첫 번째 이미지: 분석 / 두 번째 이미지: 움직임 비교</div>
            </div>
          ) : <>
            {/* Main Content Grid */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 200px", gap: 10, marginBottom: 10 }}>
              {/* CCTV View */}
              <div style={{ position: "relative", background: "#0B1120", borderRadius: 10, overflow: "hidden", border: "1px solid #1E293B" }}>
                <img src={motion?.diffUrl || img1?.url} alt="" style={{ width: "100%", display: "block", borderRadius: 10 }} />
                {/* ROI overlays */}
                {zones.map(z => (
                  <div key={z.id} style={{ position: "absolute", left: z.x+"%", top: z.y+"%", width: z.w+"%", height: z.h+"%", border: `1.5px solid ${z.color}55`, borderRadius: 3, background: z.color+"08" }}>
                    <span style={{ position: "absolute", top: -14, left: 2, fontSize: 8, color: z.color, background: "#0F172ACC", padding: "0 4px", borderRadius: 2, fontWeight: 600 }}>{z.name}</span>
                  </div>
                ))}
                {/* Status overlays */}
                <div style={{ position: "absolute", top: 6, left: 8, display: "flex", alignItems: "center", gap: 4 }}>
                  <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#EF4444", animation: "pulse 2s infinite" }} />
                  <span style={{ fontSize: 9, color: "#EF4444", fontFamily: "monospace", fontWeight: 700 }}>REC</span>
                </div>
                <div style={{ position: "absolute", bottom: 6, right: 8, fontSize: 9, color: "#ffffff50", fontFamily: "monospace" }}>
                  {motion ? `Motion: ${motion.motionPixels}px` : "Standby"} | T={threshold}
                </div>
                <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
              </div>

              {/* Side Panel */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ background: "#0F172A", borderRadius: 8, padding: 10, border: "1px solid #1E293B" }}>
                  <div style={{ fontSize: 9, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.8 }}>위험도</div>
                  <RiskGauge value={riskScore} />
                </div>
                <div style={{ background: "#0F172A", borderRadius: 8, padding: 10, border: "1px solid #1E293B" }}>
                  <Histogram hist={analysis?.histogram} label="히스토그램" height={48} />
                  <div style={{ marginTop: 4, display: "flex", gap: 4, alignItems: "center" }}>
                    <Badge status={DIAG_COLORS[analysis?.diagnosis] === "#10B981" ? "safe" : "warn"} text={DIAG_LABELS[analysis?.diagnosis]} />
                    <span style={{ fontSize: 9, color: "#475569" }}>σ={analysis?.std}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Stats Row */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 10 }}>
              <StatCard label="밝기 평균" value={analysis?.mean} unit="μ" color="#6366F1" sub="0=검정, 255=흰색" />
              <StatCard label="밝기 분산" value={analysis?.std} unit="σ" color="#10B981" sub={analysis?.std < 40 ? "저대비 ⚠️" : "양호"} />
              <StatCard label="엔트로피" value={analysis?.entropy} unit="bit" color="#F59E0B" sub="높을수록 균등" />
              <StatCard label="모션 픽셀" value={motion?.motionPixels || 0} unit="px" color={motion?.motionPixels > 1000 ? "#EF4444" : "#64748B"} sub={`ratio: ${motion?.ratio || 0}`} />
            </div>

            {/* Timeline */}
            {timeline.length > 1 && (
              <div style={{ background: "#0F172A", borderRadius: 8, padding: 10, border: "1px solid #1E293B", marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#F8FAFC", marginBottom: 6 }}>움직임 타임라인</div>
                <MiniChart data={timeline.map(t => t.risk)} color="#EF4444" />
              </div>
            )}

            {/* Enhancement Pipeline */}
            {enhanced && (
              <div style={{ background: "#0F172A", borderRadius: 8, padding: 10, border: "1px solid #1E293B" }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#F8FAFC", marginBottom: 8 }}>보정 파이프라인 결과</div>
                <div style={{ display: "grid", gridTemplateColumns: `repeat(${enhanced.length}, 1fr)`, gap: 6 }}>
                  {enhanced.map((s, i) => (
                    <div key={i} style={{ textAlign: "center" }}>
                      <img src={s.url} alt="" style={{ width: "100%", borderRadius: 4, border: "1px solid #1E293B" }} />
                      <div style={{ fontSize: 10, color: "#6366F1", fontWeight: 600, marginTop: 4 }}>{s.step}</div>
                      <div style={{ fontSize: 9, color: "#64748B" }}>σ={s.std} | H={s.entropy}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>}
        </>}

        {/* ===== ROI ===== */}
        {page === "roi" && <>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#F8FAFC", marginBottom: 10 }}>관심 영역 (ROI) 설정</div>
          <div style={{ position: "relative", width: "100%", aspectRatio: "16/10", background: "#0B1120", borderRadius: 10, overflow: "hidden", marginBottom: 12, border: "1px solid #1E293B" }}>
            {img1 ? <img src={img1.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.5 }} /> :
              <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 30% 40%, #1a1a2e 0%, #0a0a14 60%, #000 100%)" }} />}
            {zones.map(z => (
              <div key={z.id} style={{ position: "absolute", left: z.x+"%", top: z.y+"%", width: z.w+"%", height: z.h+"%", border: `2px solid ${z.color}`, borderRadius: 4, background: z.color+"15", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div style={{ background: "#0F172AEE", padding: "4px 8px", borderRadius: 4, textAlign: "center" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: z.color }}>{z.name}</div>
                  <div style={{ fontSize: 9, color: "#94A3B8" }}>가중치: {z.weight}</div>
                </div>
              </div>
            ))}
          </div>
          {zones.map((z, i) => (
            <div key={z.id} style={{ background: "#0F172A", borderRadius: 8, padding: 12, border: `1px solid ${z.color}33`, marginBottom: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 2, background: z.color }} />
                  <span style={{ fontSize: 13, fontWeight: 700, color: z.color }}>{z.name}</span>
                  <span style={{ fontSize: 10, color: "#64748B" }}>{z.level}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 10, color: "#64748B" }}>가중치</span>
                  <input type="range" min="0" max="1" step="0.1" value={z.weight} onChange={e => { const nz = [...zones]; nz[i] = {...z, weight: +e.target.value}; setZones(nz); }}
                    style={{ width: 80, accentColor: z.color }} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: z.color, fontFamily: "monospace", width: 28 }}>{z.weight}</span>
                </div>
              </div>
            </div>
          ))}
          <div style={{ fontSize: 10, color: "#475569", marginTop: 8, textAlign: "center" }}>
            수업 토픽 #14 Masking — "마스크 곱하기 한 줄이면 끝입니다" (교수님 발언)
          </div>
        </>}

        {/* ===== ALERTS ===== */}
        {page === "alerts" && <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#F8FAFC" }}>알림 히스토리</div>
            <span style={{ fontSize: 10, color: "#475569" }}>{alerts.length}건</span>
          </div>
          {alerts.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: "#475569", fontSize: 13 }}>
              이미지 두 장을 업로드하여 움직임을 감지하면<br/>위험도 {alertThreshold} 이상일 때 알림이 기록됩니다
            </div>
          ) : alerts.map(a => (
            <div key={a.id} style={{ display: "flex", gap: 8, padding: "10px 12px", background: RISK_COLORS[a.riskLevel]+"10", borderRadius: 8, border: `1px solid ${RISK_COLORS[a.riskLevel]}22`, marginBottom: 6 }}>
              <div style={{ width: 3, borderRadius: 2, background: RISK_COLORS[a.riskLevel], flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <Badge status={a.riskLevel} />
                  <span style={{ fontSize: 10, color: "#64748B", fontFamily: "monospace" }}>{a.time}</span>
                </div>
                <div style={{ fontSize: 11, color: "#CBD5E1", marginTop: 4 }}>{a.msg}</div>
                <div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>위험도: {a.riskScore}/100 | 모션: {a.motionPx}px</div>
              </div>
            </div>
          ))}
        </>}

        {/* ===== ANALYSIS ===== */}
        {page === "analysis" && <>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#F8FAFC", marginBottom: 10 }}>실험 분석 보고서</div>

          {/* Experiment 1: Averaging SNR */}
          <div style={{ background: "#0F172A", borderRadius: 8, padding: 12, border: "1px solid #1E293B", marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#F8FAFC", marginBottom: 8 }}>실험 1: Image Averaging — N값별 SNR 비교</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 6 }}>
              {MOCK_EXP.averaging.nValues.map((n, i) => (
                <div key={n} style={{ background: "#0B1120", borderRadius: 6, padding: 8, textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#64748B" }}>N = {n}</div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: "#10B981", fontFamily: "monospace", marginTop: 2 }}>{MOCK_EXP.averaging.snrExp[i]}</div>
                  <div style={{ fontSize: 8, color: "#64748B" }}>dB (실험)</div>
                  <div style={{ fontSize: 9, color: "#F59E0B", marginTop: 3 }}>이론: {MOCK_EXP.averaging.snrTheory[i]}</div>
                  <div style={{ fontSize: 8, color: Math.abs(MOCK_EXP.averaging.snrExp[i] - MOCK_EXP.averaging.snrTheory[i]) < 1.5 ? "#10B981" : "#EF4444" }}>
                    차이: {(MOCK_EXP.averaging.snrExp[i] - MOCK_EXP.averaging.snrTheory[i]).toFixed(1)}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 10, color: "#94A3B8", marginTop: 8, lineHeight: 1.6 }}>
              N이 작을 때는 이론값과 근접. N=100에서 3.1dB 차이 → 8비트 양자화 에러의 영향.
              교수님: "평균을 취하는 행위 자체가 노이즈를 감축시키는 행위이다"
            </div>
          </div>

          {/* Experiment 3: Filter Comparison */}
          <div style={{ background: "#0F172A", borderRadius: 8, padding: 12, border: "1px solid #1E293B", marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#F8FAFC", marginBottom: 8 }}>실험 3: 필터 비교 — Moving Avg vs Gaussian vs Ideal</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid #1E293B" }}>
                    {["필터", "크기", "PSNR", "에지보존", "링잉", "시간"].map(h => (
                      <th key={h} style={{ padding: "6px 8px", textAlign: "left", color: "#64748B", fontSize: 9, fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {MOCK_EXP.filters.map((f, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #1E293B08" }}>
                      <td style={{ padding: "5px 8px", color: f.name === "Gaussian" ? "#10B981" : f.name === "Ideal LP" ? "#EF4444" : "#94A3B8", fontWeight: 600 }}>{f.name}</td>
                      <td style={{ padding: "5px 8px", color: "#CBD5E1", fontFamily: "monospace" }}>{f.size}</td>
                      <td style={{ padding: "5px 8px", color: "#F8FAFC", fontWeight: 700, fontFamily: "monospace" }}>{f.psnr}</td>
                      <td style={{ padding: "5px 8px", color: f.edge >= 80 ? "#10B981" : f.edge >= 65 ? "#F59E0B" : "#EF4444" }}>{f.edge}%</td>
                      <td style={{ padding: "5px 8px" }}>{f.ringing ? <span style={{ color: "#EF4444" }}>⚠️ 있음</span> : <span style={{ color: "#10B981" }}>✓ 없음</span>}</td>
                      <td style={{ padding: "5px 8px", color: "#64748B", fontFamily: "monospace" }}>{f.ms}ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 10, color: "#94A3B8", marginTop: 8 }}>
              Gaussian 5×5가 PSNR 27.8 + 에지보존 85%로 최적. Ideal은 링잉 발생.
              교수님: "가우시안 FFT = 가우시안. 필터의 기술 = 가우시안 함수의 기술"
            </div>
          </div>

          {/* Pipeline Effect */}
          <div style={{ background: "#0F172A", borderRadius: 8, padding: 12, border: "1px solid #1E293B" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#F8FAFC", marginBottom: 8 }}>실험 2: 보정 파이프라인 단계별 효과</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
              {MOCK_EXP.pipeline.map((s, i) => {
                const colors = ["#64748B", "#F59E0B", "#6366F1", "#10B981"];
                return (
                  <div key={i} style={{ background: "#0B1120", borderRadius: 6, padding: 8, textAlign: "center", borderTop: `3px solid ${colors[i]}` }}>
                    <div style={{ fontSize: 9, color: colors[i], fontWeight: 700 }}>{s.step}</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: "#F8FAFC", fontFamily: "monospace", marginTop: 4 }}>σ={s.std}</div>
                    <div style={{ fontSize: 9, color: "#64748B" }}>H={s.entropy} | {s.psnr}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 10, color: "#94A3B8", marginTop: 8 }}>
              σ가 18→68으로 점진 증가. 교수님: "골고루 분포돼 있는 게 화질이 좋다"
            </div>
          </div>
        </>}

        {/* ===== SETTINGS ===== */}
        {page === "settings" && <>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#F8FAFC", marginBottom: 10 }}>시스템 설정</div>
          {[
            { label: "움직임 감지 임계값", desc: "프레임 차이에서 움직임으로 판단하는 최소 픽셀 변화량 (0~255)", value: threshold, setter: setThreshold, min: 5, max: 100, unit: "/ 255" },
            { label: "위험 알림 임계값", desc: "알림을 발송하는 최소 위험도 점수", value: alertThreshold, setter: setAlertThreshold, min: 10, max: 100, unit: "/ 100" },
            { label: "Averaging 프레임 수 (N)", desc: "잡음 제거를 위한 평균 프레임 수. N이 클수록 잡음↓ 고스트↑", value: avgN, setter: setAvgN, min: 1, max: 100, unit: "프레임" },
          ].map((s, i) => (
            <div key={i} style={{ background: "#0F172A", borderRadius: 8, padding: 12, border: "1px solid #1E293B", marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#F8FAFC" }}>{s.label}</div>
                  <div style={{ fontSize: 10, color: "#64748B", marginTop: 2 }}>{s.desc}</div>
                </div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#6366F1", fontFamily: "monospace", minWidth: 50, textAlign: "right" }}>
                  {s.value}<span style={{ fontSize: 10, color: "#64748B" }}> {s.unit}</span>
                </div>
              </div>
              <input type="range" min={s.min} max={s.max} value={s.value} onChange={e => s.setter(+e.target.value)}
                style={{ width: "100%", accentColor: "#6366F1" }} />
            </div>
          ))}

          <div style={{ background: "#0F172A", borderRadius: 8, padding: 12, border: "1px solid #1E293B", marginTop: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#F8FAFC", marginBottom: 8 }}>수업 토픽 연결</div>
            <div style={{ fontSize: 11, color: "#94A3B8", lineHeight: 1.8 }}>
              • 임계값 → 토픽 #13 Image Difference (교수님: "보안 시스템은 다 이걸 쓰고 있다")<br/>
              • Averaging N → 토픽 #11 Image Averaging (교수님: "평균 = 잡음 감축")<br/>
              • 알림 임계값 → 토픽 #14 Masking (ROI 가중치 × 움직임 = 위험도)<br/>
              • 필터 → 토픽 #20 Gaussian vs Ideal (교수님: "가우시안 FFT = 가우시안")
            </div>
          </div>

          <div style={{ background: "#0F172A", borderRadius: 8, padding: 12, border: "1px solid #6366F133", marginTop: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#6366F1", marginBottom: 6 }}>API 서버 연결</div>
            <div style={{ fontSize: 11, color: "#94A3B8" }}>
              현재: 클라이언트 사이드 처리 (Canvas API)<br/>
              FastAPI 서버 연결 시: 아래 주소를 입력하세요
            </div>
            <input type="text" defaultValue="http://localhost:8000" style={{
              width: "100%", marginTop: 6, padding: "8px 10px", borderRadius: 6, border: "1px solid #334155",
              background: "#0B1120", color: "#F8FAFC", fontSize: 12, fontFamily: "monospace",
            }} />
          </div>
        </>}
      </div>
      <div style={{ height: 20 }} />
    </div>
  );
}
