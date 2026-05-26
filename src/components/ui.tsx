/* cseetv UI 컴포넌트 모음 */

import { ReactNode } from "react";

/* ── 색상 상수 ── */
const C = {
  safe: "#10B981", warn: "#F59E0B", danger: "#EF4444",
  bg: "#020617", card: "#0F172A", border: "#1E293B", dark: "#0B1120",
  text: "#E2E8F0", muted: "#64748B", dim: "#475569",
  accent: "#6366F1",
};

const RISK_L: Record<string, string> = { safe: "정상", warn: "주의", danger: "위험" };
const DIAG_L: Record<string, string> = {
  under_exposed: "저조도", over_exposed: "과노출", low_contrast: "저대비", good: "양호",
};

/* ── Header ── */
export function Header({ status, riskLevel, videoName }: {
  status: string; riskLevel: string; videoName?: string;
}) {
  const sc: Record<string, string> = { connected: C.safe, connecting: C.warn, disconnected: C.muted, error: C.danger };
  const sl: Record<string, string> = { connected: "연결됨", connecting: "연결 중...", disconnected: "미연결", error: "오류" };
  return (
    <div style={{ position: "sticky", top: 0, zIndex: 50, background: C.bg + "EE", backdropFilter: "blur(12px)", borderBottom: `1px solid ${C.border}`, padding: "8px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 17 }}>📹</span>
        <span style={{ fontSize: 14, fontWeight: 800, color: "#F8FAFC" }}>cseetv</span>
        <Badge status={riskLevel} />
        {videoName && <span style={{ fontSize: 9, color: C.dim, fontFamily: "monospace" }}>{videoName}</span>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <div style={{ width: 6, height: 6, borderRadius: "50%", background: sc[status] || C.muted }} />
        <span style={{ fontSize: 9, color: C.muted }}>{sl[status] || status}</span>
      </div>
    </div>
  );
}

/* ── NavBar ── */
const NAV = [
  ["📊", "대시보드", "dashboard"],
  ["🎯", "ROI", "roi"],
  ["🔔", "알림", "alerts"],
  ["📈", "분석", "analysis"],
  ["⚙️", "설정", "settings"],
] as const;

export function NavBar({ page, onNavigate }: { page: string; onNavigate: (p: string) => void }) {
  return (
    <div style={{ display: "flex", justifyContent: "center", gap: 2, padding: "5px 8px" }}>
      {NAV.map(([icon, label, key]) => (
        <button key={key} onClick={() => onNavigate(key)} style={{
          display: "flex", flexDirection: "column", alignItems: "center", gap: 1,
          padding: "6px 8px", background: page === key ? C.accent + "18" : "transparent",
          border: page === key ? `1px solid ${C.accent}33` : "1px solid transparent",
          borderRadius: 8, color: page === key ? C.accent : C.muted, fontSize: 9, cursor: "pointer", minWidth: 48,
        }}>
          <span style={{ fontSize: 15 }}>{icon}</span>{label}
        </button>
      ))}
    </div>
  );
}

/* ── Badge ── */
export function Badge({ status, text }: { status: string; text?: string }) {
  const c = (C as Record<string, string>)[status] || C.muted;
  return (
    <span style={{ fontSize: 9, padding: "2px 7px", borderRadius: 99, background: c + "18", color: c, border: `1px solid ${c}33`, fontWeight: 600 }}>
      {text || RISK_L[status] || status}
    </span>
  );
}

/* ── StatCard ── */
export function StatCard({ label, value, unit, color = C.accent, sub }: {
  label: string; value: string | number; unit: string; color?: string; sub?: string;
}) {
  return (
    <div style={{ background: C.card, borderRadius: 8, padding: "8px 10px", border: `1px solid ${C.border}` }}>
      <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 0.6 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color, fontFamily: "monospace", marginTop: 1 }}>
        {value}<span style={{ fontSize: 10, fontWeight: 400, color: C.muted, marginLeft: 2 }}>{unit}</span>
      </div>
      {sub && <div style={{ fontSize: 9, color: C.dim, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

/* ── Histogram ── */
export function Histogram({ hist, color = C.accent, height = 52, label }: {
  hist: number[] | null; color?: string; height?: number; label?: string;
}) {
  if (!hist) return null;
  const max = Math.max(...hist);
  return (
    <div>
      {label && <div style={{ fontSize: 10, color: C.muted, marginBottom: 2 }}>{label}</div>}
      <svg viewBox="0 0 256 52" style={{ width: "100%", height, display: "block", background: C.dark, borderRadius: 6 }}>
        {hist.map((v, i) => {
          const bh = max > 0 ? (v / max) * 48 : 0;
          return <rect key={i} x={i} y={50 - bh} width={1} height={bh} fill={color} opacity={0.75} />;
        })}
      </svg>
    </div>
  );
}

/* ── RiskGauge ── */
export function RiskGauge({ value }: { value: number }) {
  const r = 44, circ = Math.PI * r, offset = circ - (Math.min(100, Math.max(0, value)) / 100) * circ;
  const c = value > 70 ? C.danger : value > 40 ? C.warn : C.safe;
  const lv = value > 70 ? "danger" : value > 40 ? "warn" : "safe";
  return (
    <svg width={110} height={70} viewBox="0 0 110 70">
      <path d="M11,62 A44,44 0 0,1 99,62" fill="none" stroke={C.border} strokeWidth={6} strokeLinecap="round" />
      <path d="M11,62 A44,44 0 0,1 99,62" fill="none" stroke={c} strokeWidth={6} strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={offset} style={{ transition: "all 0.4s" }} />
      <text x={55} y={50} textAnchor="middle" fill={c} fontSize={22} fontWeight={800} fontFamily="monospace">{Math.round(value)}</text>
      <text x={55} y={64} textAnchor="middle" fill={C.muted} fontSize={9}>{RISK_L[lv]}</text>
    </svg>
  );
}

/* ── Timeline ── */
export function Timeline({ data, color = C.danger, h = 32 }: { data: number[]; color?: string; h?: number }) {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data, 1), w = 200;
  const pts = data.map((d, i) => `${(i / (data.length - 1)) * w},${h - (d / max) * (h - 4) - 2}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: h, display: "block" }}>
      <polygon points={`0,${h} ${pts} ${w},${h}`} fill={color} opacity={0.1} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

/* ── DiagBadge ── */
export function DiagBadge({ diagnosis }: { diagnosis: string }) {
  const status = diagnosis === "good" ? "safe" : "warn";
  return <Badge status={status} text={DIAG_L[diagnosis] || diagnosis} />;
}

/* ── Card wrapper ── */
export function Card({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: C.card, borderRadius: 8, padding: 10, border: `1px solid ${C.border}`, ...style }}>
      {children}
    </div>
  );
}

/* ── Progress Bar ── */
export function ProgressBar({ current, total, label }: { current: number; total: number; label?: string }) {
  const pct = total > 0 ? (current / total) * 100 : 0;
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 10, color: C.muted }}>{label || "진행률"}</span>
        <span style={{ fontSize: 10, color: C.accent, fontFamily: "monospace" }}>{current} / {total}</span>
      </div>
      <div style={{ width: "100%", height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: C.accent, borderRadius: 3, transition: "width 0.2s" }} />
      </div>
    </Card>
  );
}

export { C, RISK_L, DIAG_L };
