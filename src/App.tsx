import { useState, useRef, useCallback, useEffect } from "react";

/* ================================================================
   cseetv — CCTV 이상 움직임 감지 및 알림 시스템
   React 프론트엔드 (클라이언트 사이드 영상처리 + FastAPI 연동 준비)
   ================================================================ */

// ============================================================
// 영상처리 엔진 (클라이언트 사이드 Canvas API)
// 팀원의 Python 백엔드가 준비되면 API 호출로 교체 가능
// ============================================================

function getGray(data: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const idx = i * 4;
    g[i] = Math.round(
      0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2],
    );
  }
  return g;
}

function calcHistogram(gray: Uint8Array): number[] {
  const h = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) h[gray[i]]++;
  return h;
}

function calcStats(gray: Uint8Array) {
  const n = gray.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += gray[i];
  const mean = sum / n;
  let vs = 0;
  for (let i = 0; i < n; i++) vs += (gray[i] - mean) ** 2;
  const std = Math.sqrt(vs / n);
  const hist = calcHistogram(gray);
  const prob = hist.map((v) => v / n).filter((v) => v > 0);
  const entropy = -prob.reduce((a, p) => a + p * Math.log2(p), 0);
  const leftR = hist.slice(0, 85).reduce((a, b) => a + b, 0) / n;
  const rightR = hist.slice(170).reduce((a, b) => a + b, 0) / n;
  let diagnosis: "good" | "under_exposed" | "over_exposed" | "low_contrast" =
    "good";
  let detail = "양호";
  if (leftR > 0.6) {
    diagnosis = "under_exposed" as const;
    detail = "저조도";
  } else if (rightR > 0.6) {
    diagnosis = "over_exposed" as const;
    detail = "과노출";
  } else if (std < 40) {
    diagnosis = "low_contrast" as const;
    detail = "저대비";
  }
  return {
    mean: +mean.toFixed(1),
    std: +std.toFixed(1),
    entropy: +entropy.toFixed(2),
    diagnosis,
    detail,
    histogram: hist,
  };
}

function contrastStretch(gray: Uint8Array): Uint8Array {
  const s = [...gray].sort((a, b) => a - b);
  const lo = s[Math.floor(s.length * 0.01)];
  const hi = s[Math.floor(s.length * 0.99)];
  const range = hi - lo || 1;
  const a = 255 / range;
  const b = -a * lo;
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++)
    out[i] = Math.max(0, Math.min(255, Math.round(a * gray[i] + b)));
  return out;
}

function histEq(gray: Uint8Array): Uint8Array {
  const hist = calcHistogram(gray);
  const n = gray.length;
  const cdf = [hist[0]];
  for (let i = 1; i < 256; i++) cdf[i] = cdf[i - 1] + hist[i];
  const mn = cdf.find((v) => v > 0) || 1;
  const lut = cdf.map((v) => Math.round(((v - mn) / (n - mn)) * 255));
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = lut[gray[i]];
  return out;
}

function grayToUrl(gray: Uint8Array, w: number, h: number): string {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d")!;
  const d = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = gray[i];
    d.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(d, 0, 0);
  return cv.toDataURL();
}

function frameDiff(g1: Uint8Array, g2: Uint8Array, threshold = 30) {
  const n = g1.length;
  const diff = new Uint8Array(n);
  let motionPx = 0;
  for (let i = 0; i < n; i++) {
    diff[i] = Math.abs(g1[i] - g2[i]);
    if (diff[i] > threshold) motionPx++;
  }
  return { diff, motionPixels: motionPx, ratio: +(motionPx / n).toFixed(4) };
}

// ============================================================
// 비디오 프레임 추출 훅
// ============================================================

interface VideoInfo {
  url: string;
  duration: number;
  width: number;
  height: number;
  name: string;
  size: string;
  type: string;
}

interface FrameData {
  url: string;
  gray: Uint8Array;
  w: number;
  h: number;
  time: number;
}

function useVideoFrames() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoLoaded, setVideoLoaded] = useState(false);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);

  const loadVideo = useCallback((file: File): Promise<VideoInfo | null> => {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;
      video.onloadedmetadata = () => {
        const info: VideoInfo = {
          url,
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
          name: file.name,
          size: (file.size / 1024 / 1024).toFixed(1) + "MB",
          type: file.type,
        };
        videoRef.current = video;
        setVideoInfo(info);
        setVideoLoaded(true);
        resolve(info);
      };
      video.onerror = () => resolve(null);
      video.src = url;
    });
  }, []);

  const extractFrame = useCallback(
    (time: number): Promise<FrameData | null> => {
      return new Promise((resolve) => {
        const video = videoRef.current;
        if (!video) {
          resolve(null);
          return;
        }
        video.currentTime = time;
        video.onseeked = () => {
          const MAX = 480;
          let w = video.videoWidth,
            h = video.videoHeight;
          if (Math.max(w, h) > MAX) {
            const s = MAX / Math.max(w, h);
            w = Math.round(w * s);
            h = Math.round(h * s);
          }
          const cv = document.createElement("canvas");
          cv.width = w;
          cv.height = h;
          const ctx = cv.getContext("2d")!;
          ctx.drawImage(video, 0, 0, w, h);
          const imgData = ctx.getImageData(0, 0, w, h);
          const gray = getGray(imgData.data, w, h);
          resolve({ url: cv.toDataURL(), gray, w, h, time });
        };
      });
    },
    [],
  );

  return { loadVideo, extractFrame, videoLoaded, videoInfo };
}

// ============================================================
// UI 컴포넌트
// ============================================================

const RISK_C: Record<string, string> = {
  safe: "#10B981",
  warn: "#F59E0B",
  danger: "#EF4444",
};
const RISK_L: Record<string, string> = {
  safe: "정상",
  warn: "주의",
  danger: "위험",
};
const DIAG_L: Record<string, string> = {
  under_exposed: "저조도",
  over_exposed: "과노출",
  low_contrast: "저대비",
  good: "양호",
};

function Histogram({
  hist,
  color = "#6366F1",
  height = 52,
  label,
}: {
  hist: number[] | null;
  color?: string;
  height?: number;
  label?: string;
}) {
  if (!hist) return null;
  const max = Math.max(...hist);
  return (
    <div>
      {label && (
        <div style={{ fontSize: 10, color: "#64748B", marginBottom: 2 }}>
          {label}
        </div>
      )}
      <svg
        viewBox="0 0 256 52"
        style={{
          width: "100%",
          height,
          display: "block",
          background: "#0B1120",
          borderRadius: 6,
        }}
      >
        {hist.map((v, i) => {
          const bh = max > 0 ? (v / max) * 48 : 0;
          return (
            <rect
              key={i}
              x={i}
              y={50 - bh}
              width={1}
              height={bh}
              fill={color}
              opacity={0.75}
            />
          );
        })}
      </svg>
    </div>
  );
}

function StatCard({
  label,
  value,
  unit,
  color = "#6366F1",
  sub,
}: {
  label: string;
  value: string | number;
  unit: string;
  color?: string;
  sub?: string;
}) {
  return (
    <div
      style={{
        background: "#0F172A",
        borderRadius: 8,
        padding: "8px 10px",
        border: "1px solid #1E293B",
      }}
    >
      <div
        style={{
          fontSize: 9,
          color: "#64748B",
          textTransform: "uppercase",
          letterSpacing: 0.6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 800,
          color,
          fontFamily: "monospace",
          marginTop: 1,
        }}
      >
        {value}
        <span
          style={{
            fontSize: 10,
            fontWeight: 400,
            color: "#64748B",
            marginLeft: 2,
          }}
        >
          {unit}
        </span>
      </div>
      {sub && (
        <div style={{ fontSize: 9, color: "#475569", marginTop: 1 }}>{sub}</div>
      )}
    </div>
  );
}

function RiskGauge({ value }: { value: number }) {
  const r = 44,
    circ = Math.PI * r,
    offset = circ - (Math.min(100, Math.max(0, value)) / 100) * circ;
  const c = value > 70 ? "#EF4444" : value > 40 ? "#F59E0B" : "#10B981";
  const lv = value > 70 ? "danger" : value > 40 ? "warn" : "safe";
  return (
    <svg width={110} height={70} viewBox="0 0 110 70">
      <path
        d="M11,62 A44,44 0 0,1 99,62"
        fill="none"
        stroke="#1E293B"
        strokeWidth={6}
        strokeLinecap="round"
      />
      <path
        d="M11,62 A44,44 0 0,1 99,62"
        fill="none"
        stroke={c}
        strokeWidth={6}
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        style={{ transition: "all 0.4s" }}
      />
      <text
        x={55}
        y={50}
        textAnchor="middle"
        fill={c}
        fontSize={22}
        fontWeight={800}
        fontFamily="monospace"
      >
        {Math.round(value)}
      </text>
      <text x={55} y={64} textAnchor="middle" fill="#64748B" fontSize={9}>
        {RISK_L[lv]}
      </text>
    </svg>
  );
}

function Badge({ status, text }: { status: string; text?: string }) {
  const c = RISK_C[status] || "#64748B";
  return (
    <span
      style={{
        fontSize: 9,
        padding: "2px 7px",
        borderRadius: 99,
        background: c + "18",
        color: c,
        border: `1px solid ${c}33`,
        fontWeight: 600,
      }}
    >
      {text || RISK_L[status]}
    </span>
  );
}

function MiniChart({
  data,
  color = "#6366F1",
  h = 32,
}: {
  data: number[];
  color?: string;
  h?: number;
}) {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data, 1),
    w = 200;
  const pts = data
    .map(
      (d, i) => `${(i / (data.length - 1)) * w},${h - (d / max) * (h - 4) - 2}`,
    )
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      style={{ width: "100%", height: h, display: "block" }}
    >
      <polygon points={`0,${h} ${pts} ${w},${h}`} fill={color} opacity={0.1} />
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NavBtn({
  icon,
  label,
  active,
  onClick,
}: {
  icon: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 1,
        padding: "6px 8px",
        background: active ? "#6366F118" : "transparent",
        border: active ? "1px solid #6366F133" : "1px solid transparent",
        borderRadius: 8,
        color: active ? "#6366F1" : "#64748B",
        fontSize: 9,
        cursor: "pointer",
        minWidth: 48,
      }}
    >
      <span style={{ fontSize: 15 }}>{icon}</span>
      {label}
    </button>
  );
}

// ============================================================
// ROI / 실험 데이터
// ============================================================

interface RoiZone {
  id: string;
  name: string;
  level: string;
  weight: number;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

const DEFAULT_ZONES: RoiZone[] = [
  {
    id: "z1",
    name: "진열대",
    level: "critical",
    weight: 1.0,
    x: 8,
    y: 15,
    w: 35,
    h: 40,
    color: "#EF4444",
  },
  {
    id: "z2",
    name: "금고",
    level: "critical",
    weight: 0.9,
    x: 60,
    y: 50,
    w: 28,
    h: 38,
    color: "#F59E0B",
  },
  {
    id: "z3",
    name: "출입구",
    level: "high",
    weight: 0.7,
    x: 55,
    y: 5,
    w: 38,
    h: 30,
    color: "#3B82F6",
  },
];

const MOCK_EXP = {
  averaging: {
    n: [1, 2, 5, 10, 30, 100],
    exp: [15.2, 18.0, 22.1, 24.7, 28.5, 32.1],
    theory: [15.2, 18.2, 22.2, 25.2, 30.0, 35.2],
  },
  filters: [
    {
      name: "Moving Avg",
      size: "3×3",
      psnr: 22.8,
      edge: 71,
      ringing: false,
      ms: 2,
    },
    {
      name: "Moving Avg",
      size: "5×5",
      psnr: 24.1,
      edge: 64,
      ringing: false,
      ms: 3,
    },
    {
      name: "Gaussian",
      size: "3×3",
      psnr: 24.2,
      edge: 82,
      ringing: false,
      ms: 3,
    },
    {
      name: "Gaussian",
      size: "5×5",
      psnr: 27.8,
      edge: 85,
      ringing: false,
      ms: 4,
    },
    {
      name: "Gaussian",
      size: "7×7",
      psnr: 28.1,
      edge: 78,
      ringing: false,
      ms: 6,
    },
    {
      name: "Ideal LP",
      size: "c=0.1",
      psnr: 20.3,
      edge: 58,
      ringing: true,
      ms: 45,
    },
    {
      name: "Ideal LP",
      size: "c=0.2",
      psnr: 23.1,
      edge: 68,
      ringing: true,
      ms: 44,
    },
  ],
};

// ============================================================
// 타입 정의
// ============================================================

interface AnalysisResult {
  mean: number;
  std: number;
  entropy: number;
  diagnosis: string;
  detail: string;
  histogram: number[];
}

interface MotionResult {
  diff: Uint8Array;
  motionPixels: number;
  ratio: number;
  riskScore: number;
  riskLevel: string;
  diffUrl: string;
}

interface EnhancedStep {
  step: string;
  std: number;
  entropy: number;
  url: string;
  mean: number;
  diagnosis: string;
  detail: string;
  histogram: number[];
}

interface AlertItem {
  id: number;
  time: string;
  riskLevel: string;
  riskScore: number;
  msg: string;
  motionPx: number;
}

interface TimelinePoint {
  motion: number;
  risk: number;
}

// ============================================================
// 메인 앱
// ============================================================

export default function App() {
  const [page, setPage] = useState("dashboard");
  const [zones, setZones] = useState<RoiZone[]>(DEFAULT_ZONES);
  const [threshold, setThreshold] = useState(30);
  const [alertThreshold, setAlertThreshold] = useState(60);
  const [inputType, setInputType] = useState<"image" | "video" | null>(null);

  // API 서버 주소 (팀원 백엔드 연동 시 사용)
  const [apiUrl, setApiUrl] = useState("http://localhost:8000");

  // 이미지 상태
  const [img1Url, setImg1Url] = useState<string | null>(null);
  // const [img1Data, setImg1Data] = useState<{
  //   gray: Uint8Array;
  //   w: number;
  //   h: number;
  // } | null>(null);

  // 비디오 상태
  const { loadVideo, extractFrame, videoLoaded, videoInfo } = useVideoFrames();
  const [playing, setPlaying] = useState(false);
  const [frameIdx, setFrameIdx] = useState(0);
  const [videoFrameUrl, setVideoFrameUrl] = useState<string | null>(null);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 분석 결과
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [motion, setMotion] = useState<MotionResult | null>(null);
  const [enhanced, setEnhanced] = useState<EnhancedStep[] | null>(null);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);
  const prevFrameRef = useRef<{
    gray: Uint8Array;
    w: number;
    h: number;
  } | null>(null);

  // --- 프레임 분석 ---
  const analyzeGray = useCallback(
    (gray: Uint8Array, w: number, h: number) => {
      const stats = calcStats(gray);
      const cs = contrastStretch(gray);
      const eq = histEq(cs);
      const steps: EnhancedStep[] = [
        { step: "원본", ...calcStats(gray), url: grayToUrl(gray, w, h) },
        {
          step: "Contrast Stretch",
          ...calcStats(cs),
          url: grayToUrl(cs, w, h),
        },
        { step: "Histogram EQ", ...calcStats(eq), url: grayToUrl(eq, w, h) },
      ];
      setAnalysis(stats);
      setEnhanced(steps);

      if (
        prevFrameRef.current &&
        prevFrameRef.current.w === w &&
        prevFrameRef.current.h === h
      ) {
        const diff = frameDiff(prevFrameRef.current.gray, gray, threshold);
        const risk = Math.min(100, diff.ratio * 2500);
        const level = risk > 70 ? "danger" : risk > 40 ? "warn" : "safe";
        const motionResult: MotionResult = {
          ...diff,
          riskScore: +risk.toFixed(1),
          riskLevel: level,
          diffUrl: grayToUrl(diff.diff, w, h),
        };
        setMotion(motionResult);
        setTimeline((prev) => [
          ...prev.slice(-59),
          { motion: diff.motionPixels, risk },
        ]);

        if (risk > alertThreshold) {
          setAlerts((prev) =>
            [
              {
                id: Date.now(),
                time: new Date().toLocaleTimeString("ko-KR"),
                riskLevel: level,
                riskScore: +risk.toFixed(1),
                msg: `움직임 ${diff.motionPixels}px (T=${threshold})`,
                motionPx: diff.motionPixels,
              },
              ...prev,
            ].slice(0, 100),
          );
        }
      } else {
        setMotion(null);
        setTimeline((prev) => [...prev.slice(-59), { motion: 0, risk: 0 }]);
      }
      prevFrameRef.current = { gray, w, h };
    },
    [threshold, alertThreshold],
  );

  // --- 이미지 업로드 ---
  const handleImageUpload = useCallback(
    (file: File) => {
      setInputType("image");
      setPlaying(false);
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const MAX = 480;
          let w = img.width,
            h = img.height;
          if (Math.max(w, h) > MAX) {
            const s = MAX / Math.max(w, h);
            w = Math.round(w * s);
            h = Math.round(h * s);
          }
          const cv = document.createElement("canvas");
          cv.width = w;
          cv.height = h;
          cv.getContext("2d")!.drawImage(img, 0, 0, w, h);
          const data = cv.getContext("2d")!.getImageData(0, 0, w, h);
          const gray = getGray(data.data, w, h);
          setImg1Url(cv.toDataURL());
          setImg1Data({ gray, w, h });
          setVideoFrameUrl(null);
          analyzeGray(gray, w, h);
        };
        img.src = e.target?.result as string;
      };
      reader.readAsDataURL(file);
    },
    [analyzeGray],
  );

  // --- 영상 업로드 ---
  const handleVideoUpload = useCallback(
    async (file: File) => {
      setInputType("video");
      setPlaying(false);
      prevFrameRef.current = null;
      setTimeline([]);
      setAlerts([]);
      setMotion(null);
      const info = await loadVideo(file);
      if (!info) return;
      const frame = await extractFrame(0);
      if (frame) {
        setVideoFrameUrl(frame.url);
        setImg1Data({ gray: frame.gray, w: frame.w, h: frame.h });
        analyzeGray(frame.gray, frame.w, frame.h);
        setFrameIdx(0);
      }
    },
    [loadVideo, extractFrame, analyzeGray],
  );

  // --- 영상 재생 ---
  useEffect(() => {
    if (!playing || !videoInfo) return;
    playRef.current = setInterval(async () => {
      setFrameIdx((prev) => {
        const next = prev + 0.2;
        if (next >= videoInfo.duration) {
          setPlaying(false);
          return prev;
        }
        extractFrame(next).then((frame) => {
          if (frame) {
            setVideoFrameUrl(frame.url);
            setImg1Data({ gray: frame.gray, w: frame.w, h: frame.h });
            analyzeGray(frame.gray, frame.w, frame.h);
          }
        });
        return next;
      });
    }, 300);
    return () => {
      if (playRef.current) clearInterval(playRef.current);
    };
  }, [playing, videoInfo, extractFrame, analyzeGray]);

  // --- 파일 핸들러 ---
  const handleFile = useCallback(
    (file: File) => {
      if (!file) return;
      if (file.type.startsWith("video/")) handleVideoUpload(file);
      else if (file.type.startsWith("image/")) handleImageUpload(file);
    },
    [handleImageUpload, handleVideoUpload],
  );

  const riskScore = motion?.riskScore || 0;
  const statusKey =
    riskScore > 70 ? "danger" : riskScore > 40 ? "warn" : "safe";
  const displayUrl = videoFrameUrl || img1Url;

  // ============================================================
  // 렌더링
  // ============================================================

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#020617",
        color: "#E2E8F0",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      {/* 상단 바 */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: "#020617EE",
          backdropFilter: "blur(12px)",
          borderBottom: "1px solid #1E293B",
          padding: "8px 12px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 17 }}>📹</span>
          <span style={{ fontSize: 14, fontWeight: 800, color: "#F8FAFC" }}>
            cseetv
          </span>
          <Badge status={statusKey} />
          {inputType === "video" && videoInfo && (
            <span
              style={{ fontSize: 9, color: "#475569", fontFamily: "monospace" }}
            >
              {videoInfo.name}
            </span>
          )}
        </div>
        {inputType === "video" && videoLoaded && (
          <button
            onClick={() => setPlaying(!playing)}
            style={{
              padding: "4px 12px",
              borderRadius: 6,
              border: "none",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 700,
              background: playing ? "#EF444420" : "#10B98120",
              color: playing ? "#EF4444" : "#10B981",
            }}
          >
            {playing ? "⏸ 일시정지" : "▶ 분석 시작"}
          </button>
        )}
      </div>

      {/* 네비게이션 */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          gap: 2,
          padding: "5px 8px",
        }}
      >
        {(
          [
            ["📊", "대시보드", "dashboard"],
            ["🎯", "ROI", "roi"],
            ["🔔", "알림", "alerts"],
            ["📈", "분석", "analysis"],
            ["⚙️", "설정", "settings"],
          ] as const
        ).map(([i, l, k]) => (
          <NavBtn
            key={k}
            icon={i}
            label={l}
            active={page === k}
            onClick={() => setPage(k)}
          />
        ))}
      </div>

      <div style={{ padding: "8px 12px", maxWidth: 900, margin: "0 auto" }}>
        {/* ===== 대시보드 ===== */}
        {page === "dashboard" && (
          <>
            <div
              style={{
                display: "flex",
                gap: 6,
                marginBottom: 8,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: "1px solid #334155",
                  background: "#0F172A",
                  color: "#94A3B8",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                📁 이미지 또는 영상 업로드
                <input
                  type="file"
                  accept="image/*,video/mp4,video/webm,video/ogg,.mp4,.webm,.ogg,.mov"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                  }}
                  style={{ display: "none" }}
                />
              </label>
              <span style={{ fontSize: 10, color: "#334155" }}>
                JPG, PNG | MP4, WebM
              </span>
            </div>

            {!analysis ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  height: 280,
                  border: "2px dashed #1E293B",
                  borderRadius: 12,
                  color: "#475569",
                }}
              >
                <div style={{ fontSize: 40, marginBottom: 8 }}>🎬</div>
                <div style={{ fontSize: 14 }}>
                  CCTV 영상 또는 이미지를 업로드하세요
                </div>
                <div
                  style={{
                    fontSize: 11,
                    marginTop: 6,
                    color: "#334155",
                    textAlign: "center",
                    lineHeight: 1.6,
                  }}
                >
                  <strong style={{ color: "#6366F1" }}>이미지</strong>: 업로드할
                  때마다 이전 프레임과 비교
                  <br />
                  <strong style={{ color: "#10B981" }}>영상 (MP4)</strong>: ▶
                  버튼으로 프레임별 자동 분석
                </div>
              </div>
            ) : (
              <>
                {inputType === "video" && videoInfo && (
                  <div
                    style={{
                      background: "#0F172A",
                      borderRadius: 8,
                      padding: "8px 10px",
                      border: "1px solid #1E293B",
                      marginBottom: 8,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 4,
                      }}
                    >
                      <span style={{ fontSize: 10, color: "#64748B" }}>
                        영상 분석 진행률
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          color: "#6366F1",
                          fontFamily: "monospace",
                        }}
                      >
                        {frameIdx.toFixed(1)}s / {videoInfo.duration.toFixed(1)}
                        s
                      </span>
                    </div>
                    <div
                      style={{
                        width: "100%",
                        height: 6,
                        background: "#1E293B",
                        borderRadius: 3,
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${(frameIdx / videoInfo.duration) * 100}%`,
                          height: "100%",
                          background: playing ? "#6366F1" : "#334155",
                          borderRadius: 3,
                          transition: "width 0.2s",
                        }}
                      />
                    </div>
                  </div>
                )}

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 180px",
                    gap: 8,
                    marginBottom: 8,
                  }}
                >
                  <div
                    style={{
                      position: "relative",
                      background: "#0B1120",
                      borderRadius: 8,
                      overflow: "hidden",
                      border: "1px solid #1E293B",
                    }}
                  >
                    <img
                      src={motion?.diffUrl || displayUrl || ""}
                      alt=""
                      style={{
                        width: "100%",
                        display: "block",
                        borderRadius: 8,
                      }}
                    />
                    {zones.map((z) => (
                      <div
                        key={z.id}
                        style={{
                          position: "absolute",
                          left: z.x + "%",
                          top: z.y + "%",
                          width: z.w + "%",
                          height: z.h + "%",
                          border: `1.5px solid ${z.color}44`,
                          borderRadius: 2,
                          background: z.color + "06",
                        }}
                      >
                        <span
                          style={{
                            position: "absolute",
                            top: -12,
                            left: 1,
                            fontSize: 7,
                            color: z.color,
                            background: "#0F172ABB",
                            padding: "0 3px",
                            borderRadius: 2,
                          }}
                        >
                          {z.name}
                        </span>
                      </div>
                    ))}
                    <div
                      style={{
                        position: "absolute",
                        bottom: 4,
                        right: 6,
                        fontSize: 8,
                        color: "#ffffff40",
                        fontFamily: "monospace",
                      }}
                    >
                      {motion ? `Motion: ${motion.motionPixels}px` : "Ready"} |
                      T={threshold}
                    </div>
                    <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
                  </div>
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 6 }}
                  >
                    <div
                      style={{
                        background: "#0F172A",
                        borderRadius: 8,
                        padding: 8,
                        border: "1px solid #1E293B",
                        textAlign: "center",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 9,
                          color: "#64748B",
                          textTransform: "uppercase",
                        }}
                      >
                        위험도
                      </div>
                      <RiskGauge value={riskScore} />
                    </div>
                    <div
                      style={{
                        background: "#0F172A",
                        borderRadius: 8,
                        padding: 8,
                        border: "1px solid #1E293B",
                      }}
                    >
                      <Histogram
                        hist={analysis?.histogram ?? null}
                        label="히스토그램"
                        height={44}
                      />
                      <div
                        style={{
                          display: "flex",
                          gap: 3,
                          alignItems: "center",
                          marginTop: 3,
                        }}
                      >
                        <Badge
                          status={
                            analysis?.diagnosis === "good" ? "safe" : "warn"
                          }
                          text={DIAG_L[analysis?.diagnosis ?? "good"]}
                        />
                        <span style={{ fontSize: 8, color: "#475569" }}>
                          σ={analysis?.std}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, 1fr)",
                    gap: 6,
                    marginBottom: 8,
                  }}
                >
                  <StatCard
                    label="밝기 평균"
                    value={analysis?.mean ?? 0}
                    unit="μ"
                    color="#6366F1"
                  />
                  <StatCard
                    label="밝기 분산"
                    value={analysis?.std ?? 0}
                    unit="σ"
                    color="#10B981"
                    sub={analysis && analysis.std < 40 ? "저대비⚠️" : "양호"}
                  />
                  <StatCard
                    label="엔트로피"
                    value={analysis?.entropy ?? 0}
                    unit="bit"
                    color="#F59E0B"
                  />
                  <StatCard
                    label="모션 픽셀"
                    value={motion?.motionPixels || 0}
                    unit="px"
                    color={
                      motion && motion.motionPixels > 1000
                        ? "#EF4444"
                        : "#64748B"
                    }
                  />
                </div>

                {timeline.length > 1 && (
                  <div
                    style={{
                      background: "#0F172A",
                      borderRadius: 8,
                      padding: 8,
                      border: "1px solid #1E293B",
                      marginBottom: 8,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        color: "#F8FAFC",
                      }}
                    >
                      움직임 타임라인
                    </span>
                    <MiniChart
                      data={timeline.map((t) => t.risk)}
                      color="#EF4444"
                    />
                  </div>
                )}

                {enhanced && (
                  <div
                    style={{
                      background: "#0F172A",
                      borderRadius: 8,
                      padding: 8,
                      border: "1px solid #1E293B",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        color: "#F8FAFC",
                        marginBottom: 6,
                      }}
                    >
                      보정 파이프라인
                    </div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: `repeat(${enhanced.length}, 1fr)`,
                        gap: 4,
                      }}
                    >
                      {enhanced.map((s, i) => (
                        <div key={i} style={{ textAlign: "center" }}>
                          <img
                            src={s.url}
                            alt=""
                            style={{
                              width: "100%",
                              borderRadius: 4,
                              border: "1px solid #1E293B",
                            }}
                          />
                          <div
                            style={{
                              fontSize: 9,
                              color: "#6366F1",
                              fontWeight: 600,
                              marginTop: 3,
                            }}
                          >
                            {s.step}
                          </div>
                          <div style={{ fontSize: 8, color: "#475569" }}>
                            σ={s.std}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* ===== ROI ===== */}
        {page === "roi" && (
          <>
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: "#F8FAFC",
                marginBottom: 8,
              }}
            >
              관심 영역 (ROI) 설정
            </div>
            <div
              style={{
                position: "relative",
                width: "100%",
                aspectRatio: "16/10",
                background: "#0B1120",
                borderRadius: 8,
                overflow: "hidden",
                marginBottom: 10,
                border: "1px solid #1E293B",
              }}
            >
              {displayUrl ? (
                <img
                  src={displayUrl}
                  alt=""
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    opacity: 0.4,
                  }}
                />
              ) : (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    background:
                      "radial-gradient(ellipse at 30% 40%, #1a1a2e, #000)",
                  }}
                />
              )}
              {zones.map((z) => (
                <div
                  key={z.id}
                  style={{
                    position: "absolute",
                    left: z.x + "%",
                    top: z.y + "%",
                    width: z.w + "%",
                    height: z.h + "%",
                    border: `2px solid ${z.color}`,
                    borderRadius: 4,
                    background: z.color + "12",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <div
                    style={{
                      background: "#0F172ADD",
                      padding: "3px 7px",
                      borderRadius: 4,
                      textAlign: "center",
                    }}
                  >
                    <div
                      style={{ fontSize: 11, fontWeight: 700, color: z.color }}
                    >
                      {z.name}
                    </div>
                    <div style={{ fontSize: 8, color: "#94A3B8" }}>
                      가중치: {z.weight}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {zones.map((z, i) => (
              <div
                key={z.id}
                style={{
                  background: "#0F172A",
                  borderRadius: 8,
                  padding: 10,
                  border: `1px solid ${z.color}33`,
                  marginBottom: 6,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: z.color,
                      }}
                    />
                    <span
                      style={{ fontSize: 12, fontWeight: 700, color: z.color }}
                    >
                      {z.name}
                    </span>
                  </div>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.1"
                      value={z.weight}
                      onChange={(e) => {
                        const nz = [...zones];
                        nz[i] = { ...z, weight: +e.target.value };
                        setZones(nz);
                      }}
                      style={{ width: 70, accentColor: z.color }}
                    />
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: z.color,
                        fontFamily: "monospace",
                        width: 24,
                      }}
                    >
                      {z.weight}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </>
        )}

        {/* ===== 알림 ===== */}
        {page === "alerts" && (
          <>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 700, color: "#F8FAFC" }}>
                알림 히스토리
              </div>
              <span style={{ fontSize: 10, color: "#475569" }}>
                {alerts.length}건
              </span>
            </div>
            {alerts.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: 40,
                  color: "#475569",
                  fontSize: 12,
                }}
              >
                영상을 분석하면 위험도 {alertThreshold} 이상일 때 알림이
                기록됩니다
              </div>
            ) : (
              alerts.map((a) => (
                <div
                  key={a.id}
                  style={{
                    display: "flex",
                    gap: 6,
                    padding: "8px 10px",
                    background: RISK_C[a.riskLevel] + "0D",
                    borderRadius: 8,
                    border: `1px solid ${RISK_C[a.riskLevel]}22`,
                    marginBottom: 4,
                  }}
                >
                  <div
                    style={{
                      width: 3,
                      borderRadius: 2,
                      background: RISK_C[a.riskLevel],
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1 }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <Badge status={a.riskLevel} />
                      <span
                        style={{
                          fontSize: 9,
                          color: "#64748B",
                          fontFamily: "monospace",
                        }}
                      >
                        {a.time}
                      </span>
                    </div>
                    <div
                      style={{ fontSize: 10, color: "#CBD5E1", marginTop: 3 }}
                    >
                      {a.msg}
                    </div>
                    <div
                      style={{ fontSize: 9, color: "#475569", marginTop: 1 }}
                    >
                      위험도: {a.riskScore} | 모션: {a.motionPx}px
                    </div>
                  </div>
                </div>
              ))
            )}
          </>
        )}

        {/* ===== 분석 ===== */}
        {page === "analysis" && (
          <>
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: "#F8FAFC",
                marginBottom: 8,
              }}
            >
              실험 분석 보고서
            </div>
            <div
              style={{
                background: "#0F172A",
                borderRadius: 8,
                padding: 10,
                border: "1px solid #1E293B",
                marginBottom: 8,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#F8FAFC",
                  marginBottom: 6,
                }}
              >
                실험 1: Image Averaging SNR
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(6, 1fr)",
                  gap: 4,
                }}
              >
                {MOCK_EXP.averaging.n.map((n, i) => (
                  <div
                    key={n}
                    style={{
                      background: "#0B1120",
                      borderRadius: 5,
                      padding: 6,
                      textAlign: "center",
                    }}
                  >
                    <div style={{ fontSize: 8, color: "#64748B" }}>N={n}</div>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 800,
                        color: "#10B981",
                        fontFamily: "monospace",
                      }}
                    >
                      {MOCK_EXP.averaging.exp[i]}
                    </div>
                    <div style={{ fontSize: 7, color: "#475569" }}>
                      이론: {MOCK_EXP.averaging.theory[i]}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div
              style={{
                background: "#0F172A",
                borderRadius: 8,
                padding: 10,
                border: "1px solid #1E293B",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#F8FAFC",
                  marginBottom: 6,
                }}
              >
                실험 3: 필터 비교
              </div>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 10,
                }}
              >
                <thead>
                  <tr style={{ borderBottom: "1px solid #1E293B" }}>
                    {["필터", "크기", "PSNR", "에지", "링잉", "시간"].map(
                      (h) => (
                        <th
                          key={h}
                          style={{
                            padding: "4px 6px",
                            textAlign: "left",
                            color: "#64748B",
                            fontSize: 8,
                          }}
                        >
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {MOCK_EXP.filters.map((f, i) => (
                    <tr key={i}>
                      <td
                        style={{
                          padding: "3px 6px",
                          color:
                            f.name === "Gaussian"
                              ? "#10B981"
                              : f.ringing
                                ? "#EF4444"
                                : "#94A3B8",
                          fontWeight: 600,
                        }}
                      >
                        {f.name}
                      </td>
                      <td
                        style={{
                          padding: "3px 6px",
                          fontFamily: "monospace",
                          color: "#CBD5E1",
                        }}
                      >
                        {f.size}
                      </td>
                      <td
                        style={{
                          padding: "3px 6px",
                          fontFamily: "monospace",
                          fontWeight: 700,
                          color: "#F8FAFC",
                        }}
                      >
                        {f.psnr}
                      </td>
                      <td
                        style={{
                          padding: "3px 6px",
                          color: f.edge >= 80 ? "#10B981" : "#F59E0B",
                        }}
                      >
                        {f.edge}%
                      </td>
                      <td style={{ padding: "3px 6px" }}>
                        {f.ringing ? (
                          <span style={{ color: "#EF4444" }}>⚠️</span>
                        ) : (
                          <span style={{ color: "#10B981" }}>✓</span>
                        )}
                      </td>
                      <td
                        style={{
                          padding: "3px 6px",
                          color: "#64748B",
                          fontFamily: "monospace",
                        }}
                      >
                        {f.ms}ms
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* ===== 설정 ===== */}
        {page === "settings" && (
          <>
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: "#F8FAFC",
                marginBottom: 8,
              }}
            >
              설정
            </div>
            {[
              {
                label: "움직임 감지 임계값 (T)",
                desc: "프레임 차이에서 움직임 판단 기준",
                value: threshold,
                setter: setThreshold,
                min: 5,
                max: 100,
                unit: "/255",
              },
              {
                label: "알림 임계값",
                desc: "알림 발생 최소 위험도",
                value: alertThreshold,
                setter: setAlertThreshold,
                min: 10,
                max: 100,
                unit: "/100",
              },
            ].map((s, i) => (
              <div
                key={i}
                style={{
                  background: "#0F172A",
                  borderRadius: 8,
                  padding: 10,
                  border: "1px solid #1E293B",
                  marginBottom: 6,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 6,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "#F8FAFC",
                      }}
                    >
                      {s.label}
                    </div>
                    <div style={{ fontSize: 9, color: "#64748B" }}>
                      {s.desc}
                    </div>
                  </div>
                  <div
                    style={{
                      fontSize: 18,
                      fontWeight: 800,
                      color: "#6366F1",
                      fontFamily: "monospace",
                    }}
                  >
                    {s.value}
                    <span style={{ fontSize: 9, color: "#64748B" }}>
                      {s.unit}
                    </span>
                  </div>
                </div>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  value={s.value}
                  onChange={(e) => s.setter(+e.target.value)}
                  style={{ width: "100%", accentColor: "#6366F1" }}
                />
              </div>
            ))}
            <div
              style={{
                background: "#0F172A",
                borderRadius: 8,
                padding: 10,
                border: "1px solid #1E293B",
                marginTop: 8,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: "#F8FAFC",
                  marginBottom: 4,
                }}
              >
                팀원 백엔드 API 연동
              </div>
              <div style={{ fontSize: 10, color: "#94A3B8", marginBottom: 6 }}>
                cseetv_ip 서버 주소를 입력하면 Python OpenCV 분석 결과를
                사용합니다
              </div>
              <input
                type="text"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: 6,
                  border: "1px solid #334155",
                  background: "#0B1120",
                  color: "#F8FAFC",
                  fontSize: 12,
                  fontFamily: "monospace",
                }}
              />
            </div>
          </>
        )}
      </div>
      <div style={{ height: 16 }} />
    </div>
  );
}
