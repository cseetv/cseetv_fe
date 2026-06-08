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

/* ================================================================
   cseetv v5 — 분석 완료 후 프레임 재생기 + CSV 내보내기
   ================================================================ */

interface StoredFrame {
  url: string;
  index: number;
  detected?: boolean;
  riskScore?: number;
}

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

/* ── 알림 모달 ── */
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
        background: "#000C",
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
        {a.frame_base64 && (
          <img
            src={a.frame_base64}
            alt=""
            style={{ width: "100%", display: "block" }}
          />
        )}
        <div style={{ padding: 16 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <Badge status={a.risk_level} />
            <span
              style={{ fontSize: 11, color: C.muted, fontFamily: "monospace" }}
            >
              {a.timestamp}
            </span>
          </div>
          <div style={{ fontSize: 12, color: "#CBD5E1", marginBottom: 8 }}>
            {a.message}
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
              value={a.risk_score.toFixed(1)}
              unit=""
              color="#EF4444"
            />
            <StatCard
              label="모션 픽셀"
              value={a.motion_pixels}
              unit="px"
              color={C.accent}
            />
            <StatCard
              label="감지 박스"
              value={a.boxes?.length || 0}
              unit="개"
              color="#F59E0B"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════ 메인 앱 ══════════ */
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
  const [storedFrames, setStoredFrames] = useState<StoredFrame[]>([]);
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
  const [playerResult, setPlayerResult] = useState<FrameResult | null>(null);

  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const cameraIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameUrlRef = useRef<string | null>(null);
  const frameCountRef = useRef(0);
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

        if (fr.frame_base64) {
          const url = `data:image/jpeg;base64,${fr.frame_base64}`;
          setFrameUrl(url);
          frameUrlRef.current = url;
          // 분석 완료 후 재생용 프레임 저장
          const idx = frameCountRef.current++;
          setStoredFrames((prev) => [
            ...prev,
            {
              url,
              index: idx,
              detected: fr.motion?.detected,
              riskScore: fr.motion?.risk_score,
            },
          ]);
        }

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
    // binary 모드에서도 프레임 저장
    const idx = frameCountRef.current++;
    setStoredFrames((prev) => [...prev, { url, index: idx }]);
  }, []);

  const ws = useWebSocket(handleWsMessage, handleWsBinary);

  // ═══ 상태 초기화 ═══
  const resetState = useCallback(() => {
    setFrameUrl(null);
    setLastResult(null);
    setTimeline([]);
    setAlerts([]);
    setAllResults([]);
    setStoredFrames([]);
    setDone(null);
    setHeatmapUrl(null);
    setProgress(null);
    setPlayerResult(null);
    frameCountRef.current = 0;
  }, []);

  // ═══ 영상 업로드 ═══
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
    setDone({ manual: true });
  }, [camera, ws]);

  // ═══ 설정 ═══
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

  // ═══ CSV 내보내기 ═══
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
        entropy: r.quality?.entropy || 0,
      })),
      `cseetv_${videoInfo?.filename?.replace(/\.[^.]+$/, "") || "result"}.csv`,
    );
  }, [allResults, videoInfo]);

  // cleanup
  useEffect(
    () => () => {
      if (cameraIntervalRef.current) clearInterval(cameraIntervalRef.current);
    },
    [],
  );

  // derived
  const riskScore = (playerResult || lastResult)?.motion?.risk_score || 0;
  const displayResult = playerResult || lastResult;
  const riskLevel =
    riskScore > 70 ? "danger" : riskScore > 40 ? "warn" : "safe";
  const isAnalyzing = mode !== "idle" && !done;
  const isPlayback = done && storedFrames.length > 0 && mode !== "camera";

  const summary = useMemo(() => {
    if (!allResults.length) return null;
    const detected = allResults.filter((r) => r.motion?.detected).length;
    const risks = allResults.map((r) => r.motion?.risk_score || 0);
    return {
      total: allResults.length,
      detected,
      avgRisk: +(risks.reduce((a, b) => a + b, 0) / risks.length).toFixed(1),
      maxRisk: +Math.max(...risks).toFixed(1),
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
          {videoInfo && !isAnalyzing && (
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
              {isPlayback && (
                <span
                  style={{ fontSize: 10, color: "#10B981", marginLeft: "auto" }}
                >
                  ✅ 분석 완료 — {storedFrames.length}프레임 재생 가능
                </span>
              )}
              {isAnalyzing && (
                <span style={{ fontSize: 9, color: C.dim, marginLeft: "auto" }}>
                  분석 중: {allResults.length}프레임
                </span>
              )}
            </div>

            {progress && (
              <ProgressBar
                current={progress.current}
                total={progress.total}
                label="영상 분석 진행률"
              />
            )}

            {/* 빈 상태 */}
            {!lastResult && !isPlayback && mode === "idle" ? (
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
                  분석 결과는 CSV로 내보내어 보고서에 활용할 수 있습니다.
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
                  {/* ── 영상 표시 영역 ── */}
                  <div>
                    {/* 분석 완료 후: FramePlayer */}
                    {isPlayback ? (
                      <FramePlayer
                        frames={storedFrames}
                        fps={2}
                        onFrameChange={(f) => {
                          // 재생 중인 프레임의 분석 결과를 사이드바에 반영
                          if (f.index < allResults.length) {
                            setPlayerResult(allResults[f.index]);
                          }
                        }}
                      />
                    ) : (
                      /* 분석 중: 실시간 프레임 표시 */
                      <div
                        style={{
                          position: "relative",
                          background: "#000",
                          borderRadius: 10,
                          overflow: "hidden",
                          border: `1px solid ${C.border}`,
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
                        {mode === "camera" && !frameUrl && (
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
                          {mode === "camera" && (
                            <Badge status="safe" text="LIVE" />
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 사이드 패널 */}
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
                        hist={displayResult?.quality?.histogram ?? null}
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
                          diagnosis={
                            displayResult?.quality?.diagnosis ?? "good"
                          }
                        />
                        <span style={{ fontSize: 8, color: C.dim }}>
                          σ={displayResult?.quality?.brightness_std ?? "-"}
                        </span>
                      </div>
                    </Card>
                  </div>
                </div>

                {/* 통계 */}
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
                    value={displayResult?.quality?.brightness_mean ?? "-"}
                    unit="μ"
                    color={C.accent}
                  />
                  <StatCard
                    label="밝기 분산"
                    value={displayResult?.quality?.brightness_std ?? "-"}
                    unit="σ"
                    color="#10B981"
                    sub={
                      (displayResult?.quality?.brightness_std ?? 99) < 30
                        ? "저대비⚠️"
                        : ""
                    }
                  />
                  <StatCard
                    label="엔트로피"
                    value={displayResult?.quality?.entropy ?? "-"}
                    unit="bit"
                    color="#F59E0B"
                  />
                  <StatCard
                    label="모션 픽셀"
                    value={displayResult?.motion?.total_motion_pixels ?? 0}
                    unit="px"
                    color={
                      (displayResult?.motion?.total_motion_pixels ?? 0) > 1000
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
                      fontSize: 9,
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: `1px solid ${C.border}`,
                      background: "none",
                      color: "#10B981",
                      cursor: "pointer",
                    }}
                  >
                    📥
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
                      <div style={{ flex: 1 }}>
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
                  📥 CSV 내보내기
                </button>
              )}
            </div>
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
                  분석 요약 {done && "✅"}
                </div>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, 1fr)",
                    gap: 6,
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
              </Card>
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
                marginBottom: 10,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 700, color: "#F8FAFC" }}>
                설정
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {settingsDirty && (
                  <span style={{ fontSize: 9, color: "#F59E0B" }}>
                    변경사항 *
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
              <Card key={s.key} style={{ marginBottom: 6 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 6,
                  }}
                >
                  <span
                    style={{ fontSize: 12, fontWeight: 600, color: "#F8FAFC" }}
                  >
                    {s.label}
                  </span>
                  <span
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
                  </span>
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
          </>
        )}
      </div>
    </div>
  );
}
