import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
  NavBar,
  Badge,
  StatCard,
  Histogram,
  RiskGauge,
  Timeline,
  Card,
  ProgressBar,
  DiagBadge,
  C,
} from "./components/ui";
import { RoiCanvas } from "./components/RoiCanvas";
import { FramePlayer } from "./components/FramePlayer";
import { useWebSocket } from "./hooks/useWebSocket";
import { useCamera } from "./hooks/useCamera";
import { useApi } from "./hooks/useApi";
import type {
  FrameResult,
  AlertItem,
  TimelinePoint,
  RoiPolygon,
  WsMessage,
  VideoInfo,
  Settings,
} from "./types";

/* ══════════════════════════════════════════
   cseetv v6 — Light Theme + Video Playback
   ══════════════════════════════════════════ */

// ── 라이트 테마 ──
const L = {
  bg: "#F8FAFC",
  card: "#FFFFFF",
  border: "#E2E8F0",
  accent: "#4F46E5",
  accentLight: "#EEF2FF",
  danger: "#EF4444",
  dangerLight: "#FEE2E2",
  success: "#22C55E",
  successLight: "#DCFCE7",
  warn: "#F59E0B",
  warnLight: "#FEF3C7",
  text: "#1E293B",
  sub: "#475569",
  muted: "#94A3B8",
  dim: "#CBD5E1",
  safe: "#22C55E",
};

const DEFAULT_SETTINGS: Settings = {
  threshold_value: 25,
  min_motion_area: 200,
  denoise_h: 7,
  use_gaussian: true,
  gaussian_kernel: 5,
  use_median: true,
  median_kernel: 5,
  use_averaging: true,
  averaging_n: 5,
  use_adaptive_threshold: false,
  use_shadow_removal: true,
  use_temporal_smoothing: true,
  temporal_frames: 3,
  use_dynamic_threshold: false,
  alert_threshold: 60,
  checks_per_second: 2,
  jpeg_quality: 70,
  transfer_mode: "binary",
  skip_unchanged_frames: true,
};

function downloadCSV(data: Record<string, unknown>[], filename: string) {
  if (!data.length) return;
  const keys = Object.keys(data[0]);
  const csv = [
    keys.join(","),
    ...data.map((r) => keys.map((k) => JSON.stringify(r[k] ?? "")).join(",")),
  ].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob(["\uFEFF" + csv], { type: "text/csv" }),
  );
  a.download = filename;
  a.click();
}

// ── 카드 (밝은 테마) ──
function LCard({
  children,
  style,
  ...p
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      style={{
        background: L.card,
        borderRadius: 12,
        border: `1px solid ${L.border}`,
        padding: "12px 14px",
        boxShadow: "0 1px 3px #0000000A",
        ...style,
      }}
      {...p}
    >
      {children}
    </div>
  );
}

// ── 알림 모달 ──
function AlertModal({
  alert: a,
  onClose,
}: {
  alert: AlertItem;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "#00000040",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        backdropFilter: "blur(4px)",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 16,
          maxWidth: 500,
          width: "100%",
          maxHeight: "90vh",
          overflow: "auto",
          boxShadow: "0 20px 60px #00000020",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: `1px solid ${L.border}`,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 700, color: L.text }}>
            알림 상세
          </span>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: L.muted,
              fontSize: 20,
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>
        {a.frame_base64 && (
          <img
            src={a.frame_base64}
            alt=""
            style={{ width: "100%", display: "block" }}
          />
        )}
        <div style={{ padding: 16 }}>
          <div
            style={{
              fontSize: 13,
              color: L.text,
              fontWeight: 600,
              marginBottom: 6,
            }}
          >
            {a.message}
          </div>
          <div style={{ fontSize: 11, color: L.muted }}>
            {a.timestamp} | 위험도: {a.risk_score.toFixed(1)} | 모션:{" "}
            {a.motion_pixels}px
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 알림 토스트 (웹캠 실시간) ──
function AlertToast({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div
      style={{
        position: "fixed",
        top: 70,
        right: 16,
        zIndex: 90,
        padding: "10px 16px",
        borderRadius: 10,
        background: L.dangerLight,
        border: `1px solid #FECACA`,
        color: L.danger,
        fontSize: 12,
        fontWeight: 600,
        boxShadow: "0 4px 20px #EF444420",
        animation: "slideIn 0.3s ease",
      }}
    >
      🔴 {message}
    </div>
  );
}

/* ══════════ 메인 ══════════ */
export default function App() {
  const [page, setPage] = useState("dashboard");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [pendingSettings, setPendingSettings] =
    useState<Settings>(DEFAULT_SETTINGS);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<FrameResult | null>(null);
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [allResults, setAllResults] = useState<FrameResult[]>([]);
  const [progress, setProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [done, setDone] = useState<any>(null);
  const [roiPolygons, setRoiPolygons] = useState<RoiPolygon[]>([]);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [heatmapUrl, setHeatmapUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<"idle" | "video" | "camera">("idle");
  const [selectedAlert, setSelectedAlert] = useState<AlertItem | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [playerResult, setPlayerResult] = useState<FrameResult | null>(null);

  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const cameraIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameUrlRef = useRef<string | null>(null);
  const alertFrameUrls = useRef<Set<string>>(new Set());
  const camera = useCamera();
  const api = useApi();

  // ═══ WebSocket ═══
  const handleWsMessage = useCallback(
    (msg: WsMessage) => {
      const t = msg.type as string;
      if (t === "frame_meta" || t === "frame_result") {
        const fr = msg as unknown as FrameResult;
        setLastResult(fr);
        setAllResults((p) => [...p, fr]);
        if (fr.frame_base64) {
          const url = `data:image/jpeg;base64,${fr.frame_base64}`;
          setFrameUrl(url);
          frameUrlRef.current = url;
        }
        const risk = fr.motion?.risk_score || 0;
        setTimeline((p) => [
          ...p.slice(-199),
          { risk, motion: fr.motion?.total_motion_pixels || 0 },
        ]);
        if (risk > settings.alert_threshold) {
          const cap = fr.frame_base64
            ? `data:image/jpeg;base64,${fr.frame_base64}`
            : frameUrlRef.current || undefined;
          if (cap?.startsWith("blob:")) alertFrameUrls.current.add(cap);
          const alert: AlertItem = {
            timestamp: new Date().toLocaleTimeString("ko-KR"),
            risk_score: risk,
            risk_level: fr.motion?.risk_level || "warn",
            motion_pixels: fr.motion?.total_motion_pixels || 0,
            boxes: fr.motion?.boxes || [],
            message: `움직임 감지 (위험도 ${risk.toFixed(0)})`,
            frame_base64: cap,
          };
          setAlerts((p) => [alert, ...p].slice(0, 200));
          setToast(alert.message);
        }
      } else if (t === "progress") {
        setProgress({
          current: msg.current as number,
          total: msg.total as number,
        });
      } else if (t === "done") {
        setDone(msg);
        setProgress(null);
      } else if (t === "heatmap") {
        setHeatmapUrl(`data:image/jpeg;base64,${msg.heatmap_base64}`);
      }
    },
    [settings.alert_threshold],
  );

  const handleWsBinary = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob);
    frameUrlRef.current = url;
    setFrameUrl((p) => {
      if (p?.startsWith("blob:") && !alertFrameUrls.current.has(p))
        URL.revokeObjectURL(p);
      return url;
    });
  }, []);

  const ws = useWebSocket(handleWsMessage, handleWsBinary);

  const resetState = useCallback(() => {
    setFrameUrl(null);
    setLastResult(null);
    setTimeline([]);
    setAlerts([]);
    setAllResults([]);
    setDone(null);
    setHeatmapUrl(null);
    setProgress(null);
    setPlayerResult(null);
  }, []);

  const handleVideoUpload = useCallback(
    async (file: File) => {
      try {
        if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
        setVideoPreviewUrl(URL.createObjectURL(file));
        setUploading(true);
        resetState();
        const info = await api.uploadVideo(file);
        setVideoInfo(info);
        setMode("video");
        ws.connect();
        ws.waitAndSend({
          type: "start_video",
          video_id: info.video_id,
          include_previews: true,
        });
      } catch (e) {
        console.error(e);
      } finally {
        setUploading(false);
      }
    },
    [api, ws, videoPreviewUrl, resetState],
  );

  const reanalyze = useCallback(() => {
    if (!videoInfo) return;
    resetState();
    ws.connect();
    ws.waitAndSend({
      type: "reanalyze",
      video_id: videoInfo.video_id,
      settings: pendingSettings,
    });
  }, [videoInfo, ws, pendingSettings, resetState]);

  const startCamera = useCallback(() => {
    setMode("camera");
    resetState();
    ws.connect();
  }, [ws, resetState]);
  useEffect(() => {
    if (mode !== "camera") return;
    const el = cameraVideoRef.current;
    if (!el) return;
    let c = false;
    (async () => {
      await camera.start(el);
      if (c) return;
      cameraIntervalRef.current = setInterval(async () => {
        const b = await camera.captureFrameAsync();
        if (b) ws.sendBinary(b);
      }, 500);
    })();
    return () => {
      c = true;
      if (cameraIntervalRef.current) {
        clearInterval(cameraIntervalRef.current);
        cameraIntervalRef.current = null;
      }
    };
  }, [mode, camera, ws]);
  const stopCamera = useCallback(() => {
    if (cameraIntervalRef.current) {
      clearInterval(cameraIntervalRef.current);
      cameraIntervalRef.current = null;
    }
    camera.stop();
    ws.sendJson({ type: "stop" });
    setDone({ manual: true });
  }, [camera, ws]);

  const changeSetting = useCallback((k: string, v: unknown) => {
    setPendingSettings((p) => ({ ...p, [k]: v }));
    setSettingsDirty(true);
  }, []);
  const saveSettings = useCallback(() => {
    setSettings(pendingSettings);
    ws.sendJson({ type: "update_settings", ...pendingSettings });
    setSettingsDirty(false);
  }, [pendingSettings, ws]);
  const updateRoi = useCallback(
    (p: RoiPolygon[]) => {
      setRoiPolygons(p);
      if (ws.status === "connected")
        ws.sendJson({
          type: "update_roi",
          polygons: p.map((x) => ({
            id: x.id,
            name: x.name,
            points: x.points,
          })),
        });
    },
    [ws],
  );

  const exportResults = useCallback(() => {
    if (!allResults.length) return;
    downloadCSV(
      allResults.map((r, i) => ({
        frame: i,
        detected: r.motion?.detected ? 1 : 0,
        risk: r.motion?.risk_score || 0,
        motion_px: r.motion?.total_motion_pixels || 0,
        mu: r.quality?.brightness_mean || 0,
        sigma: r.quality?.brightness_std || 0,
      })),
      `cseetv_${videoInfo?.filename?.replace(/\.[^.]+$/, "") || "result"}.csv`,
    );
  }, [allResults, videoInfo]);

  useEffect(
    () => () => {
      if (cameraIntervalRef.current) clearInterval(cameraIntervalRef.current);
    },
    [],
  );

  const dr = playerResult || lastResult;
  const riskScore = dr?.motion?.risk_score || 0;
  const isPlayback = done && videoPreviewUrl && mode === "video";

  const summary = useMemo(() => {
    if (!allResults.length) return null;
    const d = allResults.filter((r) => r.motion?.detected).length;
    const risks = allResults.map((r) => r.motion?.risk_score || 0);
    return {
      total: allResults.length,
      detected: d,
      avgRisk: +(risks.reduce((a, b) => a + b, 0) / risks.length).toFixed(1),
      maxRisk: +Math.max(...risks).toFixed(1),
    };
  }, [allResults]);

  // ═══ 렌더 ═══
  return (
    <div
      style={{
        minHeight: "100vh",
        background: L.bg,
        color: L.text,
        fontFamily:
          "'Pretendard','Inter',-apple-system,BlinkMacSystemFont,sans-serif",
      }}
    >
      <video
        ref={cameraVideoRef}
        playsInline
        muted
        autoPlay
        style={{ display: "none" }}
      />
      {selectedAlert && (
        <AlertModal
          alert={selectedAlert}
          onClose={() => setSelectedAlert(null)}
        />
      )}
      {toast && <AlertToast message={toast} onClose={() => setToast(null)} />}

      <style>{`
        @keyframes slideIn { from { transform:translateX(100px);opacity:0 } to { transform:translateX(0);opacity:1 } }
        @media (max-width:640px) { .grid-main { grid-template-columns:1fr !important } .grid-stats { grid-template-columns:repeat(2,1fr) !important } }
      `}</style>

      {/* 헤더 */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: "#ffffffEE",
          backdropFilter: "blur(12px)",
          borderBottom: `1px solid ${L.border}`,
          padding: "10px 16px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 20 }}>📹</span>
          <span
            style={{
              fontSize: 16,
              fontWeight: 800,
              color: L.text,
              letterSpacing: "-0.5px",
            }}
          >
            cseetv
          </span>
          {mode !== "idle" && (
            <span
              style={{
                fontSize: 10,
                color: L.muted,
                background: L.bg,
                padding: "2px 8px",
                borderRadius: 99,
              }}
            >
              {mode === "camera" ? "🟢 LIVE" : videoInfo?.filename}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {videoInfo && done && (
            <button
              onClick={reanalyze}
              style={{
                padding: "6px 12px",
                borderRadius: 8,
                border: `1px solid ${L.border}`,
                background: "#fff",
                color: L.accent,
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              🔄 재분석
            </button>
          )}
          {allResults.length > 0 && (
            <button
              onClick={exportResults}
              style={{
                padding: "6px 12px",
                borderRadius: 8,
                border: `1px solid ${L.border}`,
                background: "#fff",
                color: L.success,
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              📥 CSV
            </button>
          )}
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: 99,
              background:
                ws.status === "connected"
                  ? L.success
                  : ws.status === "connecting"
                    ? L.warn
                    : L.dim,
            }}
          />
        </div>
      </div>

      {/* 네비게이션 */}
      <div
        style={{
          display: "flex",
          gap: 0,
          borderBottom: `1px solid ${L.border}`,
          background: "#fff",
          overflow: "auto",
        }}
      >
        {[
          { id: "dashboard", label: "📊 대시보드" },
          { id: "roi", label: "🎯 ROI" },
          {
            id: "alerts",
            label: `🔔 알림${alerts.length ? ` (${alerts.length})` : ""}`,
          },
          { id: "analysis", label: "📈 분석" },
          { id: "settings", label: "⚙️ 설정" },
        ].map((n) => (
          <button
            key={n.id}
            onClick={() => setPage(n.id)}
            style={{
              padding: "10px 16px",
              border: "none",
              borderBottom:
                page === n.id
                  ? `2px solid ${L.accent}`
                  : "2px solid transparent",
              background: "transparent",
              color: page === n.id ? L.accent : L.muted,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {n.label}
          </button>
        ))}
      </div>

      <div
        style={{ padding: "12px 16px 32px", maxWidth: 960, margin: "0 auto" }}
      >
        {/* ═══ 대시보드 ═══ */}
        {page === "dashboard" && (
          <>
            {/* 액션 바 */}
            <div
              style={{
                display: "flex",
                gap: 8,
                marginBottom: 12,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "8px 16px",
                  borderRadius: 10,
                  border: `1px solid ${L.border}`,
                  background: "#fff",
                  color: L.sub,
                  fontSize: 12,
                  cursor: "pointer",
                  fontWeight: 500,
                }}
              >
                📁 영상 업로드
                <input
                  type="file"
                  accept="video/*"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleVideoUpload(f);
                  }}
                  style={{ display: "none" }}
                />
              </label>
              {mode !== "camera" ? (
                <button
                  onClick={startCamera}
                  style={{
                    padding: "8px 16px",
                    borderRadius: 10,
                    border: "none",
                    background: L.successLight,
                    color: L.success,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  📷 카메라 시작
                </button>
              ) : (
                <button
                  onClick={stopCamera}
                  style={{
                    padding: "8px 16px",
                    borderRadius: 10,
                    border: "none",
                    background: L.dangerLight,
                    color: L.danger,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  ⏹ 카메라 중지
                </button>
              )}
              {uploading && (
                <span style={{ fontSize: 11, color: L.warn, fontWeight: 500 }}>
                  업로드 중...
                </span>
              )}
              {isPlayback && (
                <span
                  style={{
                    fontSize: 11,
                    color: L.success,
                    fontWeight: 600,
                    marginLeft: "auto",
                  }}
                >
                  ✅ 분석 완료 — 재생 가능
                </span>
              )}
            </div>

            {progress && (
              <div style={{ marginBottom: 12 }}>
                <ProgressBar
                  current={progress.current}
                  total={progress.total}
                  label="영상 분석"
                />
              </div>
            )}

            {/* 빈 상태 */}
            {!lastResult && !isPlayback && mode === "idle" ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  height: 320,
                  border: `2px dashed ${L.border}`,
                  borderRadius: 16,
                  background: "#fff",
                }}
              >
                <div style={{ fontSize: 48, marginBottom: 12, opacity: 0.4 }}>
                  📹
                </div>
                <div style={{ fontSize: 16, fontWeight: 600, color: L.sub }}>
                  영상을 업로드하거나 카메라를 시작하세요
                </div>
                <div
                  style={{
                    fontSize: 12,
                    marginTop: 8,
                    color: L.muted,
                    textAlign: "center",
                    lineHeight: 1.8,
                    maxWidth: 400,
                  }}
                >
                  CDnet 데이터셋, 직접 촬영 영상, 실시간 웹캠을 지원합니다
                </div>
              </div>
            ) : (
              <>
                <div
                  className="grid-main"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 200px",
                    gap: 10,
                    marginBottom: 12,
                  }}
                >
                  {/* 영상 영역 */}
                  <div>
                    {isPlayback && videoPreviewUrl ? (
                      <FramePlayer
                        videoUrl={videoPreviewUrl}
                        results={allResults}
                        fps={2}
                        onTimeUpdate={(r) => setPlayerResult(r)}
                      />
                    ) : (
                      <div
                        style={{
                          position: "relative",
                          background: "#000",
                          borderRadius: 12,
                          overflow: "hidden",
                          border: `1px solid ${L.border}`,
                          aspectRatio: "16/10",
                        }}
                      >
                        {mode === "camera" && (
                          <video
                            ref={cameraVideoRef}
                            playsInline
                            muted
                            autoPlay
                            style={{
                              position: "absolute",
                              inset: 0,
                              width: "100%",
                              height: "100%",
                              objectFit: "contain",
                              zIndex: 1,
                            }}
                          />
                        )}
                        {frameUrl && (
                          <img
                            src={frameUrl}
                            alt=""
                            style={{
                              position: "absolute",
                              inset: 0,
                              width: "100%",
                              height: "100%",
                              objectFit: "contain",
                              zIndex: 2,
                              opacity: mode === "camera" ? 0.7 : 1,
                            }}
                          />
                        )}
                        {mode === "video" && !frameUrl && videoPreviewUrl && (
                          <video
                            src={videoPreviewUrl}
                            controls
                            muted
                            style={{
                              position: "absolute",
                              inset: 0,
                              width: "100%",
                              height: "100%",
                              objectFit: "contain",
                              zIndex: 1,
                            }}
                          />
                        )}
                        {lastResult?.motion?.detected && (
                          <div
                            style={{
                              position: "absolute",
                              top: 8,
                              left: 10,
                              zIndex: 5,
                              padding: "4px 10px",
                              borderRadius: 6,
                              background: "#EF4444DD",
                              color: "#fff",
                              fontSize: 11,
                              fontWeight: 700,
                            }}
                          >
                            🔴 움직임 감지
                          </div>
                        )}
                        {mode === "camera" && (
                          <div
                            style={{
                              position: "absolute",
                              top: 8,
                              right: 10,
                              zIndex: 5,
                              padding: "4px 10px",
                              borderRadius: 6,
                              background: "#22C55EDD",
                              color: "#fff",
                              fontSize: 11,
                              fontWeight: 700,
                            }}
                          >
                            LIVE
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {/* 사이드 */}
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 8 }}
                  >
                    <LCard style={{ textAlign: "center" }}>
                      <div
                        style={{
                          fontSize: 10,
                          color: L.muted,
                          textTransform: "uppercase",
                          letterSpacing: 1,
                          marginBottom: 4,
                        }}
                      >
                        위험도
                      </div>
                      <div
                        style={{
                          fontSize: 32,
                          fontWeight: 800,
                          color:
                            riskScore > 70
                              ? L.danger
                              : riskScore > 40
                                ? L.warn
                                : L.success,
                        }}
                      >
                        {riskScore.toFixed(0)}
                      </div>
                    </LCard>
                    <LCard>
                      <Histogram
                        hist={dr?.quality?.histogram ?? null}
                        label="히스토그램"
                        height={50}
                      />
                      <div
                        style={{
                          display: "flex",
                          gap: 4,
                          alignItems: "center",
                          marginTop: 4,
                        }}
                      >
                        <DiagBadge
                          diagnosis={dr?.quality?.diagnosis ?? "good"}
                        />
                        <span style={{ fontSize: 9, color: L.muted }}>
                          σ={dr?.quality?.brightness_std ?? "-"}
                        </span>
                      </div>
                    </LCard>
                  </div>
                </div>

                {/* 통계 카드 */}
                <div
                  className="grid-stats"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4,1fr)",
                    gap: 8,
                    marginBottom: 12,
                  }}
                >
                  <LCard>
                    <div style={{ fontSize: 10, color: L.muted }}>
                      밝기 평균
                    </div>
                    <div
                      style={{ fontSize: 18, fontWeight: 700, color: L.accent }}
                    >
                      {dr?.quality?.brightness_mean?.toFixed(1) ?? "-"}
                      <span style={{ fontSize: 10, color: L.muted }}> μ</span>
                    </div>
                  </LCard>
                  <LCard>
                    <div style={{ fontSize: 10, color: L.muted }}>
                      밝기 분산
                    </div>
                    <div
                      style={{
                        fontSize: 18,
                        fontWeight: 700,
                        color: L.success,
                      }}
                    >
                      {dr?.quality?.brightness_std?.toFixed(1) ?? "-"}
                      <span style={{ fontSize: 10, color: L.muted }}> σ</span>
                    </div>
                  </LCard>
                  <LCard>
                    <div style={{ fontSize: 10, color: L.muted }}>엔트로피</div>
                    <div
                      style={{ fontSize: 18, fontWeight: 700, color: L.warn }}
                    >
                      {dr?.quality?.entropy?.toFixed(2) ?? "-"}
                      <span style={{ fontSize: 10, color: L.muted }}> bit</span>
                    </div>
                  </LCard>
                  <LCard>
                    <div style={{ fontSize: 10, color: L.muted }}>
                      모션 픽셀
                    </div>
                    <div
                      style={{
                        fontSize: 18,
                        fontWeight: 700,
                        color:
                          (dr?.motion?.total_motion_pixels ?? 0) > 1000
                            ? L.danger
                            : L.muted,
                      }}
                    >
                      {dr?.motion?.total_motion_pixels ?? 0}
                      <span style={{ fontSize: 10, color: L.muted }}> px</span>
                    </div>
                  </LCard>
                </div>

                {timeline.length > 1 && (
                  <LCard style={{ marginBottom: 12 }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        marginBottom: 6,
                      }}
                    >
                      <span
                        style={{ fontSize: 11, fontWeight: 600, color: L.text }}
                      >
                        위험도 타임라인
                      </span>
                      <span style={{ fontSize: 10, color: L.muted }}>
                        {timeline.length}프레임
                      </span>
                    </div>
                    <Timeline data={timeline.map((t) => t.risk)} />
                  </LCard>
                )}
              </>
            )}
          </>
        )}

        {/* ═══ ROI ═══ */}
        {page === "roi" && (
          <>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>
              관심 영역 (ROI)
            </h2>
            <LCard style={{ padding: 0, overflow: "hidden", marginBottom: 12 }}>
              <RoiCanvas
                imageUrl={frameUrl}
                width={640}
                height={480}
                polygons={roiPolygons}
                onChange={updateRoi}
              />
            </LCard>
            {roiPolygons.map((z, i) => (
              <LCard key={z.id} style={{ marginBottom: 6 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <div
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 4,
                        background: z.color,
                      }}
                    />
                    <span style={{ fontWeight: 700, color: z.color }}>
                      {z.name}
                    </span>
                  </div>
                  <button
                    onClick={() =>
                      updateRoi(roiPolygons.filter((_, j) => j !== i))
                    }
                    style={{
                      background: L.dangerLight,
                      border: "none",
                      borderRadius: 6,
                      color: L.danger,
                      cursor: "pointer",
                      fontSize: 11,
                      padding: "4px 12px",
                      fontWeight: 600,
                    }}
                  >
                    삭제
                  </button>
                </div>
              </LCard>
            ))}
          </>
        )}

        {/* ═══ 알림 ═══ */}
        {page === "alerts" && (
          <>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <h2 style={{ fontSize: 16, fontWeight: 700 }}>알림 히스토리</h2>
              <div style={{ display: "flex", gap: 6 }}>
                {alerts.length > 0 && (
                  <button
                    onClick={() =>
                      downloadCSV(
                        alerts.map((a) => ({
                          time: a.timestamp,
                          risk: a.risk_score,
                          level: a.risk_level,
                          pixels: a.motion_pixels,
                        })),
                        "alerts.csv",
                      )
                    }
                    style={{
                      padding: "6px 12px",
                      borderRadius: 8,
                      border: `1px solid ${L.border}`,
                      background: "#fff",
                      color: L.success,
                      fontSize: 11,
                      cursor: "pointer",
                      fontWeight: 600,
                    }}
                  >
                    📥
                  </button>
                )}
                {alerts.length > 0 && (
                  <button
                    onClick={() => setAlerts([])}
                    style={{
                      padding: "6px 12px",
                      borderRadius: 8,
                      border: `1px solid ${L.border}`,
                      background: "#fff",
                      color: L.muted,
                      fontSize: 11,
                      cursor: "pointer",
                    }}
                  >
                    초기화
                  </button>
                )}
              </div>
            </div>
            {alerts.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: 50,
                  color: L.muted,
                  fontSize: 13,
                  border: `2px dashed ${L.border}`,
                  borderRadius: 12,
                  background: "#fff",
                }}
              >
                위험도 {settings.alert_threshold} 이상일 때 기록됩니다
              </div>
            ) : (
              alerts.map((a, i) => (
                <LCard
                  key={i}
                  onClick={() => setSelectedAlert(a)}
                  style={{
                    cursor: "pointer",
                    marginBottom: 6,
                    borderLeft: `3px solid ${a.risk_level === "danger" ? L.danger : L.warn}`,
                  }}
                >
                  <div style={{ display: "flex", gap: 10 }}>
                    {a.frame_base64 && (
                      <img
                        src={a.frame_base64}
                        alt=""
                        style={{
                          width: 80,
                          height: 52,
                          objectFit: "cover",
                          borderRadius: 8,
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <div>
                      <div
                        style={{ fontSize: 12, fontWeight: 600, color: L.text }}
                      >
                        {a.message}
                      </div>
                      <div
                        style={{ fontSize: 11, color: L.muted, marginTop: 2 }}
                      >
                        {a.timestamp} | 위험도: {a.risk_score.toFixed(1)}
                      </div>
                    </div>
                  </div>
                </LCard>
              ))
            )}
          </>
        )}

        {/* ═══ 분석 ═══ */}
        {page === "analysis" && (
          <>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <h2 style={{ fontSize: 16, fontWeight: 700 }}>분석 결과</h2>
              {allResults.length > 0 && (
                <button
                  onClick={exportResults}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 8,
                    border: `1px solid ${L.border}`,
                    background: L.successLight,
                    color: L.success,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  📥 CSV 내보내기
                </button>
              )}
            </div>
            {summary ? (
              <LCard style={{ marginBottom: 12 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: L.text,
                    marginBottom: 10,
                  }}
                >
                  요약 {done && "✅"}
                </div>
                <div
                  className="grid-stats"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4,1fr)",
                    gap: 8,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 10, color: L.muted }}>
                      분석 프레임
                    </div>
                    <div
                      style={{ fontSize: 20, fontWeight: 700, color: L.accent }}
                    >
                      {summary.total}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: L.muted }}>
                      감지 횟수
                    </div>
                    <div
                      style={{ fontSize: 20, fontWeight: 700, color: L.danger }}
                    >
                      {summary.detected}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: L.muted }}>
                      평균 위험도
                    </div>
                    <div
                      style={{ fontSize: 20, fontWeight: 700, color: L.warn }}
                    >
                      {summary.avgRisk}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10, color: L.muted }}>
                      최대 위험도
                    </div>
                    <div
                      style={{ fontSize: 20, fontWeight: 700, color: L.danger }}
                    >
                      {summary.maxRisk}
                    </div>
                  </div>
                </div>
              </LCard>
            ) : (
              <div
                style={{
                  textAlign: "center",
                  padding: 40,
                  color: L.muted,
                  fontSize: 13,
                  border: `2px dashed ${L.border}`,
                  borderRadius: 12,
                  background: "#fff",
                  marginBottom: 12,
                }}
              >
                영상 분석 후 결과가 표시됩니다
              </div>
            )}
            {heatmapUrl && (
              <LCard style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
                  움직임 히트맵
                </div>
                <img
                  src={heatmapUrl}
                  alt=""
                  style={{ width: "100%", borderRadius: 8 }}
                />
              </LCard>
            )}
          </>
        )}

        {/* ═══ 설정 ═══ */}
        {page === "settings" && (
          <>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <h2 style={{ fontSize: 16, fontWeight: 700 }}>설정</h2>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {settingsDirty && (
                  <span
                    style={{ fontSize: 10, color: L.warn, fontWeight: 600 }}
                  >
                    변경사항 있음
                  </span>
                )}
                <button
                  onClick={saveSettings}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 8,
                    border: "none",
                    background: settingsDirty ? L.accent : "#E2E8F0",
                    color: settingsDirty ? "#fff" : L.muted,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  💾 저장
                </button>
                {videoInfo && (
                  <button
                    onClick={reanalyze}
                    style={{
                      padding: "6px 14px",
                      borderRadius: 8,
                      border: "none",
                      background: L.successLight,
                      color: L.success,
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    🔄 재분석
                  </button>
                )}
              </div>
            </div>
            {(
              [
                {
                  key: "threshold_value",
                  label: "임계값 (T)",
                  min: 5,
                  max: 100,
                  unit: "/255",
                },
                {
                  key: "min_motion_area",
                  label: "최소 감지 영역",
                  min: 50,
                  max: 2000,
                  unit: "px",
                },
                {
                  key: "alert_threshold",
                  label: "알림 임계값",
                  min: 10,
                  max: 100,
                  unit: "/100",
                },
                {
                  key: "denoise_h",
                  label: "노이즈 제거 강도",
                  min: 0,
                  max: 20,
                  unit: "",
                },
              ] as const
            ).map((s) => (
              <LCard key={s.key} style={{ marginBottom: 8 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 8,
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    {s.label}
                  </span>
                  <span
                    style={{
                      fontSize: 22,
                      fontWeight: 800,
                      color: L.accent,
                      fontFamily: "monospace",
                    }}
                  >
                    {(pendingSettings as any)[s.key]}
                    <span style={{ fontSize: 10, color: L.muted }}>
                      {s.unit}
                    </span>
                  </span>
                </div>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  value={(pendingSettings as any)[s.key]}
                  onChange={(e) => changeSetting(s.key, +e.target.value)}
                  style={{ width: "100%", accentColor: L.accent }}
                />
              </LCard>
            ))}
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: L.muted,
                margin: "16px 0 8px",
              }}
            >
              필터 ON/OFF
            </div>
            {(
              [
                { key: "use_gaussian", label: "Gaussian Blur" },
                { key: "use_median", label: "Median Filter" },
                { key: "use_shadow_removal", label: "Shadow Removal" },
                { key: "use_temporal_smoothing", label: "Temporal Smoothing" },
              ] as const
            ).map((s) => (
              <LCard key={s.key} style={{ marginBottom: 6 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span style={{ fontSize: 12, fontWeight: 600 }}>
                    {s.label}
                  </span>
                  <button
                    onClick={() =>
                      changeSetting(s.key, !(pendingSettings as any)[s.key])
                    }
                    style={{
                      width: 42,
                      height: 24,
                      borderRadius: 12,
                      border: "none",
                      cursor: "pointer",
                      background: (pendingSettings as any)[s.key]
                        ? L.accent
                        : "#E2E8F0",
                      position: "relative",
                      transition: "all 0.2s",
                    }}
                  >
                    <div
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 99,
                        background: "#fff",
                        position: "absolute",
                        top: 3,
                        left: (pendingSettings as any)[s.key] ? 21 : 3,
                        transition: "left 0.2s",
                        boxShadow: "0 1px 3px #0001",
                      }}
                    />
                  </button>
                </div>
              </LCard>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
