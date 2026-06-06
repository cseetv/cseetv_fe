import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
  Header,
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

/* ================================================================
   cseetv v4 — 결과 추출 + 카메라 듀얼 레이어 + 설정 저장/재분석
   ================================================================ */

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

/* ── 결과 CSV 내보내기 ── */
function downloadCSV(data: Record<string, unknown>[], filename: string) {
  if (!data.length) return;
  const keys = Object.keys(data[0]);
  const csv = [
    keys.join(","),
    ...data.map((r) => keys.map((k) => JSON.stringify(r[k] ?? "")).join(",")),
  ].join("\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ── 알림 모달 ── */
function AlertModal({
  alert,
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
        background: "#000000CC",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: C.card,
          borderRadius: 12,
          maxWidth: 600,
          width: "100%",
          maxHeight: "90vh",
          overflow: "auto",
          border: `1px solid ${C.border}`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderBottom: `1px solid ${C.border}`,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 700, color: "#F8FAFC" }}>
            알림 상세
          </span>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: C.muted,
              fontSize: 18,
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>
        {alert.frame_base64 && (
          <img
            src={alert.frame_base64}
            alt="감지 순간"
            style={{ width: "100%", display: "block" }}
          />
        )}
        <div style={{ padding: 16 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <Badge status={alert.risk_level} />
            <span
              style={{ fontSize: 11, color: C.muted, fontFamily: "monospace" }}
            >
              {alert.timestamp}
            </span>
          </div>
          <div style={{ fontSize: 12, color: "#CBD5E1", marginBottom: 8 }}>
            {alert.message}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 6,
            }}
          >
            <StatCard
              label="위험도"
              value={alert.risk_score.toFixed(1)}
              unit=""
              color="#EF4444"
            />
            <StatCard
              label="모션 픽셀"
              value={alert.motion_pixels}
              unit="px"
              color={C.accent}
            />
            <StatCard
              label="감지 박스"
              value={alert.boxes?.length || 0}
              unit="개"
              color="#F59E0B"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── 메인 앱 ── */
export default function App() {
  const [page, setPage] = useState("dashboard");

  // ═══ 분석 엔진 상태 (페이지 전환과 독립) ═══
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [pendingSettings, setPendingSettings] =
    useState<Settings>(DEFAULT_SETTINGS);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<FrameResult | null>(null);
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [allResults, setAllResults] = useState<FrameResult[]>([]); // 전체 프레임 결과 저장 (CSV용)
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

  // refs
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
        setAllResults((prev) => [...prev, fr]);
        if (fr.frame_base64)
          setFrameUrl(`data:image/jpeg;base64,${fr.frame_base64}`);
        const risk = fr.motion?.risk_score || 0;
        const motion = fr.motion?.total_motion_pixels || 0;
        setTimeline((prev) => [...prev.slice(-199), { risk, motion }]);
        if (risk > settings.alert_threshold) {
          const capturedFrame = fr.frame_base64
            ? `data:image/jpeg;base64,${fr.frame_base64}`
            : frameUrlRef.current || undefined;
          if (capturedFrame?.startsWith("blob:"))
            alertFrameUrls.current.add(capturedFrame);
          setAlerts((prev) =>
            [
              {
                timestamp: new Date().toLocaleTimeString("ko-KR"),
                risk_score: risk,
                risk_level: fr.motion?.risk_level || "warn",
                motion_pixels: motion,
                boxes: fr.motion?.boxes || [],
                message: `움직임 감지 (위험도 ${risk.toFixed(0)})`,
                frame_base64: capturedFrame,
              },
              ...prev,
            ].slice(0, 200),
          );
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
      } else if (t === "error") {
        console.error("서버:", msg.message);
      }
    },
    [settings.alert_threshold],
  );

  const handleWsBinary = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob);
    frameUrlRef.current = url;
    setFrameUrl((prev) => {
      if (prev?.startsWith("blob:") && !alertFrameUrls.current.has(prev))
        URL.revokeObjectURL(prev);
      return url;
    });
  }, []);

  const ws = useWebSocket(handleWsMessage, handleWsBinary);

  // ═══ 영상 업로드 + 분석 ═══
  const resetState = useCallback(() => {
    setFrameUrl(null);
    setLastResult(null);
    setTimeline([]);
    setAlerts([]);
    setAllResults([]);
    setDone(null);
    setHeatmapUrl(null);
    setProgress(null);
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
        console.error("업로드 실패:", e);
      } finally {
        setUploading(false);
      }
    },
    [api, ws, videoPreviewUrl, resetState],
  );

  // ═══ 재분석 ═══
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

  // ═══ 카메라 ═══
  const startCamera = useCallback(() => {
    setMode("camera");
    resetState();
    ws.connect();
  }, [ws, resetState]);

  useEffect(() => {
    if (mode !== "camera") return;
    const el = cameraVideoRef.current;
    if (!el) return;
    let cancelled = false;
    (async () => {
      await camera.start(el);
      if (cancelled) return;
      cameraIntervalRef.current = setInterval(async () => {
        const blob = await camera.captureFrameAsync();
        if (blob) ws.sendBinary(blob);
      }, 500);
    })();
    return () => {
      cancelled = true;
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
    setMode("idle");
  }, [camera, ws]);

  // ═══ 설정 ═══
  const changeSetting = useCallback((key: string, value: unknown) => {
    setPendingSettings((prev) => ({ ...prev, [key]: value }));
    setSettingsDirty(true);
  }, []);

  const saveSettings = useCallback(() => {
    setSettings(pendingSettings);
    ws.sendJson({ type: "update_settings", ...pendingSettings });
    setSettingsDirty(false);
  }, [pendingSettings, ws]);

  const updateRoi = useCallback(
    (polys: RoiPolygon[]) => {
      setRoiPolygons(polys);
      if (ws.status === "connected")
        ws.sendJson({
          type: "update_roi",
          polygons: polys.map((p) => ({
            id: p.id,
            name: p.name,
            points: p.points,
          })),
        });
    },
    [ws],
  );

  // ═══ 결과 내보내기 ═══
  const exportResults = useCallback(() => {
    if (!allResults.length) return;
    const rows = allResults.map((r, i) => ({
      frame: r.frame_number || i,
      timestamp: r.timestamp || "",
      detected: r.motion?.detected ? 1 : 0,
      risk_score: r.motion?.risk_score || 0,
      motion_pixels: r.motion?.total_motion_pixels || 0,
      boxes: r.motion?.boxes?.length || 0,
      brightness_mean: r.quality?.brightness_mean || 0,
      brightness_std: r.quality?.brightness_std || 0,
      entropy: r.quality?.entropy || 0,
      diagnosis: r.quality?.diagnosis || "",
    }));
    const name = videoInfo?.filename?.replace(/\.[^.]+$/, "") || "camera";
    downloadCSV(rows, `cseetv_${name}_results.csv`);
  }, [allResults, videoInfo]);

  const exportAlerts = useCallback(() => {
    if (!alerts.length) return;
    downloadCSV(
      alerts.map((a) => ({
        time: a.timestamp,
        risk: a.risk_score,
        level: a.risk_level,
        pixels: a.motion_pixels,
        message: a.message,
      })),
      "cseetv_alerts.csv",
    );
  }, [alerts]);

  // cleanup
  useEffect(() => {
    return () => {
      if (cameraIntervalRef.current) clearInterval(cameraIntervalRef.current);
    };
  }, []);
  useEffect(() => {
    return () => {
      if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
    };
  }, [videoPreviewUrl]);

  // derived
  const riskScore = lastResult?.motion?.risk_score || 0;
  const riskLevel =
    riskScore > 70 ? "danger" : riskScore > 40 ? "warn" : "safe";
  const hasData = lastResult || mode === "camera";

  // ═══ 요약 통계 ═══
  const summary = useMemo(() => {
    if (!allResults.length) return null;
    const detected = allResults.filter((r) => r.motion?.detected).length;
    const risks = allResults.map((r) => r.motion?.risk_score || 0);
    return {
      total: allResults.length,
      detected,
      avgRisk: risks.length
        ? +(risks.reduce((a, b) => a + b, 0) / risks.length).toFixed(1)
        : 0,
      maxRisk: risks.length ? +Math.max(...risks).toFixed(1) : 0,
      avgMu: +(
        allResults.reduce((s, r) => s + (r.quality?.brightness_mean || 0), 0) /
        allResults.length
      ).toFixed(1),
      avgSigma: +(
        allResults.reduce((s, r) => s + (r.quality?.brightness_std || 0), 0) /
        allResults.length
      ).toFixed(1),
    };
  }, [allResults]);

  // ═══ 렌더 ═══
  return (
    <div
      style={{
        minHeight: "100vh",
        background: C.bg,
        color: "#E2E8F0",
        fontFamily:
          "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      }}
    >
      {/* 숨겨진 카메라 비디오 (항상 DOM에) */}
      <video
        ref={cameraVideoRef}
        playsInline
        muted
        autoPlay
        style={{ display: "none" }}
      />

      {/* 알림 모달 */}
      {selectedAlert && (
        <AlertModal
          alert={selectedAlert}
          onClose={() => setSelectedAlert(null)}
        />
      )}

      {/* 헤더 */}
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: C.bg + "EE",
          backdropFilter: "blur(12px)",
          borderBottom: `1px solid ${C.border}`,
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
          <Badge status={riskLevel} />
          {mode !== "idle" && (
            <span
              style={{ fontSize: 9, color: C.dim, fontFamily: "monospace" }}
            >
              {mode === "camera" ? "LIVE" : videoInfo?.filename}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {videoInfo && mode !== "camera" && (
            <button
              onClick={reanalyze}
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                border: `1px solid ${C.border}`,
                background: "none",
                color: C.accent,
                fontSize: 10,
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
                padding: "4px 10px",
                borderRadius: 6,
                border: `1px solid ${C.border}`,
                background: "none",
                color: "#10B981",
                fontSize: 10,
                cursor: "pointer",
              }}
            >
              📥 CSV
            </button>
          )}
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background:
                ws.status === "connected"
                  ? "#10B981"
                  : ws.status === "connecting"
                    ? "#F59E0B"
                    : C.muted,
            }}
          />
          <span style={{ fontSize: 9, color: C.muted }}>
            {ws.status === "connected"
              ? "연결됨"
              : ws.status === "connecting"
                ? "연결 중"
                : "미연결"}
          </span>
        </div>
      </div>

      <NavBar page={page} onNavigate={setPage} />

      <div
        style={{ padding: "8px 12px 24px", maxWidth: 920, margin: "0 auto" }}
      >
        {/* ═══ 대시보드 ═══ */}
        {page === "dashboard" && (
          <>
            <div
              style={{
                display: "flex",
                gap: 6,
                marginBottom: 10,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "7px 14px",
                  borderRadius: 8,
                  border: `1px solid #334155`,
                  background: C.card,
                  color: "#94A3B8",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                📁 영상 업로드
                <input
                  type="file"
                  accept="video/*,.mp4,.webm,.mov,.avi"
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
                    padding: "7px 14px",
                    borderRadius: 8,
                    border: "none",
                    background: "#10B98118",
                    color: "#10B981",
                    fontSize: 11,
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
                    padding: "7px 14px",
                    borderRadius: 8,
                    border: "none",
                    background: "#EF444418",
                    color: "#EF4444",
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  ⏹ 카메라 중지
                </button>
              )}
              {uploading && (
                <span style={{ fontSize: 10, color: "#F59E0B" }}>
                  업로드 중...
                </span>
              )}
              {allResults.length > 0 && (
                <span style={{ fontSize: 9, color: C.dim, marginLeft: "auto" }}>
                  분석: {allResults.length}프레임
                </span>
              )}
            </div>

            {progress && (
              <div style={{ marginBottom: 8 }}>
                <ProgressBar
                  current={progress.current}
                  total={progress.total}
                  label="영상 분석 진행률"
                />
              </div>
            )}

            {!hasData && mode === "idle" ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  height: 300,
                  border: `2px dashed ${C.border}`,
                  borderRadius: 16,
                  color: C.dim,
                }}
              >
                <div style={{ fontSize: 44, marginBottom: 10, opacity: 0.6 }}>
                  📹
                </div>
                <div
                  style={{ fontSize: 15, fontWeight: 600, color: "#94A3B8" }}
                >
                  CCTV 영상을 업로드하거나 카메라를 시작하세요
                </div>
                <div
                  style={{
                    fontSize: 11,
                    marginTop: 8,
                    color: "#475569",
                    textAlign: "center",
                    lineHeight: 1.7,
                    maxWidth: 380,
                  }}
                >
                  NightOwls 데이터셋 영상, 직접 촬영 영상, 또는 실시간 웹캠을
                  지원합니다. 분석 결과는 CSV로 내보내어 보고서 표에 활용할 수
                  있습니다.
                </div>
              </div>
            ) : (
              <>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 190px",
                    gap: 8,
                    marginBottom: 10,
                  }}
                >
                  {/* 영상 디스플레이 */}
                  <div
                    style={{
                      position: "relative",
                      background: C.dark,
                      borderRadius: 10,
                      overflow: "hidden",
                      border: `1px solid ${C.border}`,
                      aspectRatio: "16/10",
                    }}
                  >
                    {/* 카메라 원본 (레이어 1) */}
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
                    {/* 서버 처리 결과 (레이어 2, 카메라 위에 겹침) */}
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
                    {/* 영상 미리보기 (분석 시작 전) */}
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
                    {/* 카메라 대기 */}
                    {mode === "camera" && !frameUrl && !camera.active && (
                      <div
                        style={{
                          position: "absolute",
                          inset: 0,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          zIndex: 3,
                        }}
                      >
                        <span style={{ fontSize: 11, color: C.muted }}>
                          📷 카메라 연결 중...
                        </span>
                      </div>
                    )}
                    {/* 상태 뱃지 */}
                    <div
                      style={{
                        position: "absolute",
                        top: 6,
                        left: 8,
                        zIndex: 5,
                        display: "flex",
                        gap: 4,
                      }}
                    >
                      {lastResult?.motion?.detected && (
                        <Badge status="danger" text="움직임 감지" />
                      )}
                      {mode === "camera" && <Badge status="safe" text="LIVE" />}
                    </div>
                    <div
                      style={{
                        position: "absolute",
                        bottom: 4,
                        right: 6,
                        zIndex: 5,
                        fontSize: 8,
                        color: "#ffffff50",
                        fontFamily: "monospace",
                        background: "#00000060",
                        padding: "1px 5px",
                        borderRadius: 3,
                      }}
                    >
                      T={settings.threshold_value} | {mode}
                    </div>
                  </div>
                  {/* 사이드 */}
                  <div
                    style={{ display: "flex", flexDirection: "column", gap: 6 }}
                  >
                    <Card style={{ textAlign: "center" }}>
                      <div
                        style={{
                          fontSize: 9,
                          color: C.muted,
                          textTransform: "uppercase",
                        }}
                      >
                        위험도
                      </div>
                      <RiskGauge value={riskScore} />
                    </Card>
                    <Card>
                      <Histogram
                        hist={lastResult?.quality?.histogram ?? null}
                        label="히스토그램"
                        height={48}
                      />
                      <div
                        style={{
                          display: "flex",
                          gap: 3,
                          alignItems: "center",
                          marginTop: 4,
                        }}
                      >
                        <DiagBadge
                          diagnosis={lastResult?.quality?.diagnosis ?? "good"}
                        />
                        <span style={{ fontSize: 8, color: C.dim }}>
                          σ={lastResult?.quality?.brightness_std ?? "-"}
                        </span>
                      </div>
                    </Card>
                  </div>
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, 1fr)",
                    gap: 6,
                    marginBottom: 10,
                  }}
                >
                  <StatCard
                    label="밝기 평균"
                    value={lastResult?.quality?.brightness_mean ?? "-"}
                    unit="μ"
                    color={C.accent}
                  />
                  <StatCard
                    label="밝기 분산"
                    value={lastResult?.quality?.brightness_std ?? "-"}
                    unit="σ"
                    color="#10B981"
                    sub={
                      (lastResult?.quality?.brightness_std ?? 99) < 30
                        ? "저대비⚠️"
                        : ""
                    }
                  />
                  <StatCard
                    label="엔트로피"
                    value={lastResult?.quality?.entropy ?? "-"}
                    unit="bit"
                    color="#F59E0B"
                  />
                  <StatCard
                    label="모션 픽셀"
                    value={lastResult?.motion?.total_motion_pixels ?? 0}
                    unit="px"
                    color={
                      (lastResult?.motion?.total_motion_pixels ?? 0) > 1000
                        ? "#EF4444"
                        : C.muted
                    }
                  />
                </div>
                {timeline.length > 1 && (
                  <Card style={{ marginBottom: 10 }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        marginBottom: 4,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          color: "#F8FAFC",
                        }}
                      >
                        위험도 타임라인
                      </span>
                      <span style={{ fontSize: 9, color: C.dim }}>
                        {timeline.length}프레임
                      </span>
                    </div>
                    <Timeline data={timeline.map((t) => t.risk)} />
                  </Card>
                )}
                {lastResult?.pipeline?.enhanced_previews &&
                  lastResult.pipeline.enhanced_previews.length > 0 && (
                    <Card style={{ marginBottom: 10 }}>
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
                          gridTemplateColumns: `repeat(${lastResult.pipeline.enhanced_previews.length}, 1fr)`,
                          gap: 6,
                        }}
                      >
                        {lastResult.pipeline.enhanced_previews.map((s, i) => (
                          <div key={i} style={{ textAlign: "center" }}>
                            <img
                              src={`data:image/jpeg;base64,${s.base64}`}
                              alt=""
                              style={{
                                width: "100%",
                                borderRadius: 6,
                                border: `1px solid ${C.border}`,
                              }}
                            />
                            <div
                              style={{
                                fontSize: 9,
                                color: C.accent,
                                fontWeight: 600,
                                marginTop: 4,
                              }}
                            >
                              {s.step}
                            </div>
                            <div style={{ fontSize: 8, color: C.dim }}>
                              σ={s.std} μ={s.mean}
                            </div>
                          </div>
                        ))}
                      </div>
                    </Card>
                  )}
                {lastResult?.pipeline?.steps_applied && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                    {lastResult.pipeline.steps_applied.map((s, i) => (
                      <span
                        key={i}
                        style={{
                          fontSize: 8,
                          padding: "2px 6px",
                          borderRadius: 4,
                          background: C.accent + "12",
                          color: C.accent,
                          border: `1px solid ${C.accent}18`,
                        }}
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        )}

        {/* ═══ ROI ═══ */}
        {page === "roi" && (
          <>
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: "#F8FAFC",
                marginBottom: 10,
              }}
            >
              관심 영역 (ROI) 설정
            </div>
            <Card style={{ padding: 0, overflow: "hidden", marginBottom: 10 }}>
              <RoiCanvas
                imageUrl={frameUrl}
                width={640}
                height={480}
                polygons={roiPolygons}
                onChange={updateRoi}
              />
            </Card>
            <div
              style={{
                fontSize: 10,
                color: C.dim,
                marginBottom: 10,
                lineHeight: 1.6,
              }}
            >
              클릭: 꼭짓점 추가 | 더블클릭: 완성 | 우클릭: 삭제
            </div>
            {roiPolygons.map((z, i) => (
              <Card
                key={z.id}
                style={{ marginBottom: 6, borderColor: z.color + "33" }}
              >
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
                        width: 10,
                        height: 10,
                        borderRadius: 3,
                        background: z.color,
                      }}
                    />
                    <span
                      style={{ fontSize: 12, fontWeight: 700, color: z.color }}
                    >
                      {z.name}
                    </span>
                    <span style={{ fontSize: 9, color: C.dim }}>
                      {z.points.length}점
                    </span>
                  </div>
                  <button
                    onClick={() =>
                      updateRoi(roiPolygons.filter((_, j) => j !== i))
                    }
                    style={{
                      background: "#EF444412",
                      border: "1px solid #EF444422",
                      borderRadius: 6,
                      color: "#EF4444",
                      cursor: "pointer",
                      fontSize: 10,
                      padding: "3px 10px",
                    }}
                  >
                    삭제
                  </button>
                </div>
              </Card>
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
                marginBottom: 10,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 700, color: "#F8FAFC" }}>
                알림 히스토리
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {alerts.length > 0 && (
                  <button
                    onClick={exportAlerts}
                    style={{
                      fontSize: 9,
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: `1px solid ${C.border}`,
                      background: "none",
                      color: "#10B981",
                      cursor: "pointer",
                    }}
                  >
                    📥 CSV
                  </button>
                )}
                {alerts.length > 0 && (
                  <button
                    onClick={() => setAlerts([])}
                    style={{
                      fontSize: 9,
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: `1px solid ${C.border}`,
                      background: "none",
                      color: C.muted,
                      cursor: "pointer",
                    }}
                  >
                    초기화
                  </button>
                )}
                <span style={{ fontSize: 10, color: C.dim }}>
                  {alerts.length}건
                </span>
              </div>
            </div>
            {alerts.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  padding: 50,
                  color: C.dim,
                  fontSize: 12,
                  border: `1px dashed ${C.border}`,
                  borderRadius: 10,
                }}
              >
                위험도 {settings.alert_threshold} 이상일 때 기록됩니다
              </div>
            ) : (
              alerts.map((a, i) => {
                const ac =
                  (C as Record<string, string>)[a.risk_level] || C.muted;
                return (
                  <div
                    key={i}
                    onClick={() => setSelectedAlert(a)}
                    style={{
                      cursor: "pointer",
                      background: ac + "08",
                      borderRadius: 10,
                      border: `1px solid ${ac}18`,
                      marginBottom: 5,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{ display: "flex", gap: 8, padding: "10px 12px" }}
                    >
                      {a.frame_base64 && (
                        <img
                          src={a.frame_base64}
                          alt=""
                          style={{
                            width: 72,
                            height: 48,
                            objectFit: "cover",
                            borderRadius: 6,
                            flexShrink: 0,
                          }}
                        />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                          }}
                        >
                          <Badge status={a.risk_level} />
                          <span
                            style={{
                              fontSize: 9,
                              color: C.muted,
                              fontFamily: "monospace",
                            }}
                          >
                            {a.timestamp}
                          </span>
                        </div>
                        <div
                          style={{
                            fontSize: 10,
                            color: "#CBD5E1",
                            marginTop: 3,
                          }}
                        >
                          {a.message}
                        </div>
                        <div
                          style={{ fontSize: 9, color: C.dim, marginTop: 1 }}
                        >
                          위험도: {a.risk_score.toFixed(1)} | 모션:{" "}
                          {a.motion_pixels}px
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
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
                marginBottom: 10,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 700, color: "#F8FAFC" }}>
                분석 결과
              </div>
              {allResults.length > 0 && (
                <button
                  onClick={exportResults}
                  style={{
                    padding: "5px 14px",
                    borderRadius: 6,
                    border: `1px solid ${C.border}`,
                    background: "#10B98112",
                    color: "#10B981",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  📥 전체 결과 CSV 내보내기
                </button>
              )}
            </div>

            {/* 요약 통계 */}
            {summary ? (
              <Card style={{ marginBottom: 10 }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: "#F8FAFC",
                    marginBottom: 8,
                  }}
                >
                  분석 요약 {done && "✅ 완료"}
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: 6,
                    marginBottom: 8,
                  }}
                >
                  <StatCard
                    label="분석 프레임"
                    value={summary.total}
                    unit="장"
                    color={C.accent}
                  />
                  <StatCard
                    label="감지 횟수"
                    value={summary.detected}
                    unit="회"
                    color="#EF4444"
                  />
                  <StatCard
                    label="감지율"
                    value={
                      summary.total > 0
                        ? ((summary.detected / summary.total) * 100).toFixed(1)
                        : 0
                    }
                    unit="%"
                    color="#F59E0B"
                  />
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, 1fr)",
                    gap: 6,
                  }}
                >
                  <StatCard
                    label="평균 위험도"
                    value={summary.avgRisk}
                    unit=""
                    color="#F59E0B"
                  />
                  <StatCard
                    label="최대 위험도"
                    value={summary.maxRisk}
                    unit=""
                    color="#EF4444"
                  />
                  <StatCard
                    label="평균 μ"
                    value={summary.avgMu}
                    unit=""
                    color={C.accent}
                  />
                  <StatCard
                    label="평균 σ"
                    value={summary.avgSigma}
                    unit=""
                    color="#10B981"
                  />
                </div>
              </Card>
            ) : (
              <div
                style={{
                  textAlign: "center",
                  padding: 30,
                  color: C.dim,
                  fontSize: 12,
                  border: `1px dashed ${C.border}`,
                  borderRadius: 10,
                  marginBottom: 10,
                }}
              >
                영상 분석을 완료하면 결과가 표시됩니다
              </div>
            )}

            {heatmapUrl && (
              <Card style={{ marginBottom: 10 }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: "#F8FAFC",
                    marginBottom: 6,
                  }}
                >
                  움직임 히트맵
                </div>
                <img
                  src={heatmapUrl}
                  alt=""
                  style={{ width: "100%", borderRadius: 8 }}
                />
                <div style={{ fontSize: 9, color: C.dim, marginTop: 4 }}>
                  빨강=빈번 / 파랑=적음
                </div>
              </Card>
            )}

            {/* CSV 내보내기 안내 */}
            <Card style={{ marginBottom: 10 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#F8FAFC",
                  marginBottom: 6,
                }}
              >
                📊 보고서 데이터 추출
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: C.dim,
                  lineHeight: 1.7,
                  marginBottom: 8,
                }}
              >
                상단의 "📥 CSV" 버튼으로 프레임별 분석 결과를 내보낼 수
                있습니다. CSV에는 각 프레임의 밝기(μ), 분산(σ), 엔트로피, 움직임
                감지 여부, 위험도, 모션 픽셀 수가 포함됩니다. 이 데이터를
                NightOwls GT와 비교하여 Precision/Recall/F1을 계산하세요.
              </div>
              <div style={{ fontSize: 10, color: C.dim, lineHeight: 1.7 }}>
                <strong style={{ color: C.accent }}>
                  Precision/Recall/F1 계산 방법:
                </strong>
                <br />
                1. CSV의 "detected" 열 = 시스템 감지 결과 (0 또는 1)
                <br />
                2. NightOwls GT의 프레임별 "has_motion" = 정답
                <br />
                3. 두 열을 비교: TP, FP, FN 계산 → Precision, Recall, F1 산출
                <br />
                4. 임계값(T)을 바꿔가며 반복 → 최적 T 결정
              </div>
            </Card>

            {/* 평가 지표 가이드 */}
            <Card>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#F8FAFC",
                  marginBottom: 8,
                }}
              >
                평가 지표 가이드
              </div>
              {(
                [
                  [
                    "📊 영상 품질 (실시간)",
                    [
                      ["μ", "평균 밝기. <50 저조도"],
                      ["σ", "대비. <30 저대비"],
                      ["Entropy", "정보량. 높을수록 디테일↑"],
                      ["Histogram", "밝기 분포 시각화"],
                    ],
                  ],
                  [
                    "🎯 감지 성능 (GT 기반)",
                    [
                      ["Precision", "감지 중 진짜 비율"],
                      ["Recall", "실제 중 잡은 비율"],
                      ["F1", "P×R 균형. ≥0.8 양호"],
                      ["PR Curve", "T 변화에 따른 P-R 관계"],
                    ],
                  ],
                ] as const
              ).map(([title, items]) => (
                <div key={title} style={{ marginBottom: 10 }}>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: C.accent,
                      marginBottom: 5,
                    }}
                  >
                    {title}
                  </div>
                  {items.map(([name, desc]) => (
                    <div
                      key={name}
                      style={{
                        display: "flex",
                        gap: 8,
                        marginBottom: 3,
                        fontSize: 10,
                        padding: "2px 0",
                      }}
                    >
                      <span
                        style={{
                          color: "#F8FAFC",
                          fontWeight: 600,
                          minWidth: 70,
                        }}
                      >
                        {name}
                      </span>
                      <span style={{ color: C.dim }}>{desc}</span>
                    </div>
                  ))}
                </div>
              ))}
            </Card>
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
                marginBottom: 10,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 700, color: "#F8FAFC" }}>
                설정
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {settingsDirty && (
                  <span style={{ fontSize: 9, color: "#F59E0B" }}>
                    변경사항 있음 *
                  </span>
                )}
                <button
                  onClick={saveSettings}
                  style={{
                    padding: "5px 14px",
                    borderRadius: 6,
                    border: "none",
                    background: settingsDirty ? C.accent : C.border,
                    color: settingsDirty ? "#fff" : C.muted,
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: "pointer",
                    transition: "all 0.2s",
                  }}
                >
                  💾 저장
                </button>
                {videoInfo && (
                  <button
                    onClick={reanalyze}
                    style={{
                      padding: "5px 14px",
                      borderRadius: 6,
                      border: "none",
                      background: "#10B98118",
                      color: "#10B981",
                      fontSize: 11,
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
                  label: "움직임 감지 임계값 (T)",
                  desc: "프레임 차이 이진화 기준",
                  min: 5,
                  max: 100,
                  unit: "/255",
                },
                {
                  key: "min_motion_area",
                  label: "최소 감지 영역",
                  desc: "이 크기 미만은 노이즈로 무시",
                  min: 50,
                  max: 2000,
                  unit: "px",
                },
                {
                  key: "alert_threshold",
                  label: "알림 임계값",
                  desc: "이 위험도 이상일 때 알림",
                  min: 10,
                  max: 100,
                  unit: "/100",
                },
                {
                  key: "denoise_h",
                  label: "노이즈 제거 강도 (h)",
                  desc: "fastNlMeans h값",
                  min: 0,
                  max: 20,
                  unit: "",
                },
                {
                  key: "averaging_n",
                  label: "Image Averaging N",
                  desc: "평균할 프레임 수",
                  min: 1,
                  max: 20,
                  unit: "",
                },
                {
                  key: "temporal_frames",
                  label: "Temporal Smoothing N",
                  desc: "연속 감지 판단 수",
                  min: 1,
                  max: 10,
                  unit: "",
                },
              ] as const
            ).map((s) => (
              <Card key={s.key} style={{ marginBottom: 6 }}>
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
                    <div style={{ fontSize: 9, color: C.muted }}>{s.desc}</div>
                  </div>
                  <div
                    style={{
                      fontSize: 20,
                      fontWeight: 800,
                      color: C.accent,
                      fontFamily: "monospace",
                    }}
                  >
                    {(pendingSettings as any)[s.key]}
                    <span style={{ fontSize: 9, color: C.muted }}>
                      {s.unit}
                    </span>
                  </div>
                </div>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  value={(pendingSettings as any)[s.key]}
                  onChange={(e) => changeSetting(s.key, +e.target.value)}
                  style={{ width: "100%", accentColor: C.accent }}
                />
              </Card>
            ))}

            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: C.muted,
                margin: "14px 0 8px",
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              필터 ON/OFF
            </div>
            {(
              [
                { key: "use_gaussian", label: "Gaussian Blur" },
                { key: "use_median", label: "Median Filter" },
                { key: "use_averaging", label: "Image Averaging" },
                { key: "use_shadow_removal", label: "Shadow Removal" },
                { key: "use_temporal_smoothing", label: "Temporal Smoothing" },
                { key: "use_adaptive_threshold", label: "Adaptive Threshold" },
                { key: "use_dynamic_threshold", label: "Dynamic Threshold" },
              ] as const
            ).map((s) => (
              <Card key={s.key} style={{ marginBottom: 4 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{ fontSize: 11, fontWeight: 600, color: "#F8FAFC" }}
                  >
                    {s.label}
                  </span>
                  <button
                    onClick={() =>
                      changeSetting(s.key, !(pendingSettings as any)[s.key])
                    }
                    style={{
                      width: 38,
                      height: 22,
                      borderRadius: 11,
                      border: "none",
                      cursor: "pointer",
                      background: (pendingSettings as any)[s.key]
                        ? C.accent
                        : C.border,
                      position: "relative",
                      transition: "background 0.2s",
                    }}
                  >
                    <div
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: "50%",
                        background: "#fff",
                        position: "absolute",
                        top: 3,
                        left: (pendingSettings as any)[s.key] ? 19 : 3,
                        transition: "left 0.2s",
                      }}
                    />
                  </button>
                </div>
              </Card>
            ))}

            <div
              style={{
                marginTop: 14,
                padding: "10px 12px",
                background: "#10B98108",
                borderRadius: 8,
                border: "1px solid #10B98118",
                fontSize: 10,
                color: C.dim,
                lineHeight: 1.6,
              }}
            >
              💡 설정을 변경한 뒤{" "}
              <strong style={{ color: "#10B981" }}>💾 저장</strong>을 누르면
              서버에 반영됩니다. 이미 분석한 영상을 새 설정으로 다시 분석하려면{" "}
              <strong style={{ color: "#10B981" }}>🔄 재분석</strong>을
              누르세요. 임계값(T)을 바꿔가며 재분석하면 최적의 설정을 찾을 수
              있습니다.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
