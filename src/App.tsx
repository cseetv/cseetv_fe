import { useState, useRef, useCallback, useEffect } from "react";
import { Header, NavBar, Badge, StatCard, Histogram, RiskGauge, Timeline, Card, ProgressBar, DiagBadge, C } from "./components/ui";
import { RoiCanvas } from "./components/RoiCanvas";
import { useWebSocket } from "./hooks/useWebSocket";
import { useCamera } from "./hooks/useCamera";
import { useApi } from "./hooks/useApi";
import type { FrameResult, AlertItem, TimelinePoint, RoiPolygon, WsMessage, VideoInfo, Settings } from "./types";

/* ================================================================
   cseetv — CCTV 이상 움직임 감지 및 알림 시스템
   React 프론트엔드 v3 (UI/UX 최적화 + 카메라 위 ROI 오버레이)
   ================================================================ */

const DEFAULT_SETTINGS: Settings = {
  threshold_value: 25, min_motion_area: 200, denoise_h: 7,
  use_gaussian: true, gaussian_kernel: 5, use_median: true, median_kernel: 5,
  use_averaging: true, averaging_n: 5, use_adaptive_threshold: false,
  use_shadow_removal: true, use_temporal_smoothing: true, temporal_frames: 3,
  use_dynamic_threshold: false, alert_threshold: 60,
  checks_per_second: 2, jpeg_quality: 70, transfer_mode: "binary",
  skip_unchanged_frames: true,
};

/* ── ROI 오버레이 (카메라/프레임 위에 그리기) ── */
function RoiOverlay({ polygons, width, height }: { polygons: RoiPolygon[]; width: number; height: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    cv.width = width;
    cv.height = height;
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, width, height);

    polygons.forEach((p) => {
      if (p.points.length < 3) return;
      ctx.beginPath();
      ctx.moveTo(p.points[0][0], p.points[0][1]);
      p.points.forEach(([x, y]) => ctx.lineTo(x, y));
      ctx.closePath();
      ctx.fillStyle = p.color + "18";
      ctx.fill();
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2;
      ctx.stroke();

      const cx = p.points.reduce((s, pt) => s + pt[0], 0) / p.points.length;
      const cy = p.points.reduce((s, pt) => s + pt[1], 0) / p.points.length;
      ctx.fillStyle = p.color;
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(p.name, cx, cy);
    });
  }, [polygons, width, height]);

  return (
    <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 2 }} />
  );
}

/* ── 메인 앱 ── */
export default function App() {
  const [page, setPage] = useState("dashboard");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<FrameResult | null>(null);
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [done, setDone] = useState<any>(null);
  const [roiPolygons, setRoiPolygons] = useState<RoiPolygon[]>([]);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [heatmapUrl, setHeatmapUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<"idle" | "video" | "camera">("idle");
  const [roiDrawMode, setRoiDrawMode] = useState(false);
  const [displaySize, setDisplaySize] = useState({ w: 640, h: 480 });

  const camera = useCamera();
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const cameraIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const displayRef = useRef<HTMLDivElement>(null);
  const frameUrlRef = useRef<string | null>(null);
  const alertFrameUrls = useRef<Set<string>>(new Set());  // 알림에 사용된 URL (revoke 방지)
  const api = useApi();

  // ── WebSocket ──
  const handleWsMessage = useCallback((msg: WsMessage) => {
    const t = msg.type as string;
    if (t === "frame_meta" || t === "frame_result") {
      const fr = msg as unknown as FrameResult;
      setLastResult(fr);
      if (fr.frame_base64) setFrameUrl(`data:image/jpeg;base64,${fr.frame_base64}`);
      const risk = fr.motion?.risk_score || 0;
      const motion = fr.motion?.total_motion_pixels || 0;
      setTimeline((prev) => [...prev.slice(-99), { risk, motion }]);
      if (risk > settings.alert_threshold) {
        // 알림 시점의 프레임 URL 보존
        const capturedFrame = fr.frame_base64
          ? `data:image/jpeg;base64,${fr.frame_base64}`
          : frameUrlRef.current || null;
        if (capturedFrame?.startsWith("blob:")) alertFrameUrls.current.add(capturedFrame);

        setAlerts((prev) => [{
          timestamp: new Date().toLocaleTimeString("ko-KR"),
          risk_score: risk, risk_level: fr.motion?.risk_level || "warn",
          motion_pixels: motion, boxes: fr.motion?.boxes || [],
          message: `움직임 감지 (위험도 ${risk.toFixed(0)})`,
          frame_base64: capturedFrame || undefined,
        }, ...prev].slice(0, 200));
      }
    } else if (t === "progress") {
      setProgress({ current: msg.current as number, total: msg.total as number });
    } else if (t === "done") {
      setDone(msg); setProgress(null); setMode("idle");
    } else if (t === "heatmap") {
      setHeatmapUrl(`data:image/jpeg;base64,${msg.heatmap_base64}`);
    } else if (t === "error") {
      console.error("서버 오류:", msg.message);
    }
  }, [settings.alert_threshold]);

  const handleWsBinary = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob);
    frameUrlRef.current = url;
    setFrameUrl((prev) => {
      // 알림에 사용된 URL은 revoke하지 않음
      if (prev?.startsWith("blob:") && !alertFrameUrls.current.has(prev)) {
        URL.revokeObjectURL(prev);
      }
      return url;
    });
  }, []);

  const ws = useWebSocket(handleWsMessage, handleWsBinary);

  // ── 영상 업로드 ──
  const handleVideoUpload = useCallback(async (file: File) => {
    try {
      if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl);
      setVideoPreviewUrl(URL.createObjectURL(file));
      setUploading(true); setFrameUrl(null); setTimeline([]); setAlerts([]); setDone(null); setHeatmapUrl(null); setLastResult(null);
      const info = await api.uploadVideo(file);
      setVideoInfo(info); setMode("video");
      ws.connect();
      ws.waitAndSend({ type: "start_video", video_id: info.video_id, include_previews: true });
    } catch (e) { console.error("업로드 실패:", e); }
    finally { setUploading(false); }
  }, [api, ws, videoPreviewUrl]);

  // ── 카메라 ──
  const startCamera = useCallback(async () => {
    setMode("camera");
    setFrameUrl(null);  // 이전 영상 프레임 제거
    setTimeline([]); setAlerts([]); setDone(null); setHeatmapUrl(null); setLastResult(null);
    ws.connect();
  }, [ws]);

  // mode가 camera로 바뀌면 video 요소가 렌더링된 후 카메라 시작
  useEffect(() => {
    if (mode !== "camera") return;
    const el = cameraVideoRef.current;
    if (!el) return;

    let cancelled = false;
    (async () => {
      await camera.start(el);
      if (cancelled) return;
      // 프레임 캡처 루프 시작 (초당 2프레임)
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
    if (cameraIntervalRef.current) { clearInterval(cameraIntervalRef.current); cameraIntervalRef.current = null; }
    camera.stop(); ws.sendJson({ type: "stop" }); setMode("idle");
  }, [camera, ws]);

  // ── 설정 ──
  const updateSetting = useCallback((key: string, value: unknown) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    if (ws.status === "connected") ws.sendJson({ type: "update_settings", [key]: value });
  }, [ws]);

  const updateRoi = useCallback((polys: RoiPolygon[]) => {
    setRoiPolygons(polys);
    if (ws.status === "connected") ws.sendJson({ type: "update_roi", polygons: polys.map((p) => ({ id: p.id, name: p.name, points: p.points })) });
  }, [ws]);

  // ── 디스플레이 크기 추적 ──
  useEffect(() => {
    const el = displayRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setDisplaySize({ w: Math.round(width), h: Math.round(height) });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => { return () => { if (cameraIntervalRef.current) clearInterval(cameraIntervalRef.current); }; }, []);
  useEffect(() => { return () => { if (videoPreviewUrl) URL.revokeObjectURL(videoPreviewUrl); }; }, [videoPreviewUrl]);

  const riskScore = lastResult?.motion?.risk_score || 0;
  const riskLevel = riskScore > 70 ? "danger" : riskScore > 40 ? "warn" : "safe";
  const hasData = lastResult || mode === "camera";

  // ── 렌더 ──
  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: "#E2E8F0", fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      <Header status={ws.status} riskLevel={riskLevel} videoName={videoInfo?.filename} />
      <NavBar page={page} onNavigate={setPage} />

      <div style={{ padding: "8px 12px 24px", maxWidth: 920, margin: "0 auto" }}>

        {/* ═══════════ 대시보드 ═══════════ */}
        {page === "dashboard" && <>

          {/* 상단 컨트롤 */}
          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "7px 14px", borderRadius: 8, border: `1px solid #334155`, background: C.card, color: "#94A3B8", fontSize: 11, cursor: "pointer", transition: "border-color 0.2s" }}>
              📁 영상 업로드
              <input type="file" accept="video/mp4,video/webm,.mp4,.webm,.mov" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleVideoUpload(f); }} style={{ display: "none" }} />
            </label>

            {mode !== "camera" ? (
              <button onClick={startCamera} style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "#10B98118", color: "#10B981", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                📷 카메라 시작
              </button>
            ) : (
              <button onClick={stopCamera} style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: "#EF444418", color: "#EF4444", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                ⏹ 카메라 중지
              </button>
            )}

            {/* ROI 그리기 모드 토글 (카메라 활성 시) */}
            {mode === "camera" && (
              <button onClick={() => setRoiDrawMode(!roiDrawMode)} style={{
                padding: "7px 14px", borderRadius: 8, border: `1px solid ${roiDrawMode ? C.accent : C.border}`,
                background: roiDrawMode ? C.accent + "18" : "transparent",
                color: roiDrawMode ? C.accent : C.muted, fontSize: 11, fontWeight: 600, cursor: "pointer",
              }}>
                🎯 {roiDrawMode ? "ROI 그리기 중" : "ROI 그리기"}
              </button>
            )}

            {uploading && <span style={{ fontSize: 10, color: "#F59E0B" }}>업로드 중...</span>}

            {/* 연결 상태 */}
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: ws.status === "connected" ? C.safe : ws.status === "connecting" ? C.warn : C.muted }} />
              <span style={{ fontSize: 9, color: C.muted }}>{ws.status === "connected" ? "서버 연결됨" : ws.status === "connecting" ? "연결 중..." : "미연결"}</span>
            </div>
          </div>

          {/* 진행률 */}
          {progress && <div style={{ marginBottom: 8 }}><ProgressBar current={progress.current} total={progress.total} label="영상 분석 진행률" /></div>}

          {/* 카메라 비디오 — 항상 DOM에 존재 (ref 안정성 보장) */}
          <video ref={cameraVideoRef} playsInline muted autoPlay
            style={{ display: "none" }} />

          {/* 빈 상태 */}
          {!hasData && mode === "idle" ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 300, border: `2px dashed ${C.border}`, borderRadius: 16, color: C.dim }}>
              <div style={{ fontSize: 44, marginBottom: 10, opacity: 0.6 }}>📹</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#94A3B8" }}>CCTV 영상을 업로드하거나 카메라를 시작하세요</div>
              <div style={{ fontSize: 11, marginTop: 8, color: "#475569", textAlign: "center", lineHeight: 1.7, maxWidth: 360 }}>
                영상 파일 업로드 시 서버에서 프레임을 분석하여 결과를 실시간으로 보여줍니다.
                카메라 모드에서는 브라우저 카메라로 실시간 감시가 가능합니다.
              </div>
            </div>
          ) : <>

            {/* ── 메인 그리드: 영상 + 사이드 ── */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 190px", gap: 8, marginBottom: 10 }}>

              {/* 영상 디스플레이 영역 */}
              <div ref={displayRef} style={{ position: "relative", background: C.dark, borderRadius: 10, overflow: "hidden", border: `1px solid ${C.border}`, aspectRatio: "16/10" }}>

                {/* 서버에서 처리된 프레임 (카메라 + 영상 공통) */}
                {frameUrl && (
                  <img src={frameUrl} alt="분석 프레임" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", zIndex: 1 }} />
                )}

                {/* 영상 업로드 후 프레임 오기 전 미리보기 */}
                {mode === "video" && !frameUrl && videoPreviewUrl && (
                  <video src={videoPreviewUrl} controls muted style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", zIndex: 1 }} />
                )}

                {/* 카메라 모드에서 서버 응답 오기 전 대기 */}
                {mode === "camera" && !frameUrl && (
                  <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", zIndex: 1 }}>
                    <div style={{ fontSize: 24, marginBottom: 6 }}>📷</div>
                    <div style={{ fontSize: 11, color: C.muted }}>카메라 프레임 분석 대기 중...</div>
                  </div>
                )}

                {/* ROI 오버레이 (항상 표시) */}
                {roiPolygons.length > 0 && <RoiOverlay polygons={roiPolygons} width={displaySize.w} height={displaySize.h} />}

                {/* ROI 그리기 캔버스 (카메라 모드에서 ROI 그리기 활성 시) */}
                {roiDrawMode && mode === "camera" && (
                  <div style={{ position: "absolute", inset: 0, zIndex: 3 }}>
                    <RoiCanvas imageUrl={null} width={displaySize.w} height={displaySize.h} polygons={roiPolygons} onChange={updateRoi} />
                  </div>
                )}

                {/* 상태 오버레이 */}
                <div style={{ position: "absolute", top: 6, left: 8, zIndex: 5, display: "flex", gap: 4 }}>
                  {lastResult?.motion?.detected && <Badge status="danger" text="움직임 감지" />}
                  {mode === "camera" && <Badge status="safe" text="LIVE" />}
                  {roiDrawMode && <Badge status="warn" text="ROI 편집" />}
                </div>

                <div style={{ position: "absolute", bottom: 4, right: 6, zIndex: 5, fontSize: 8, color: "#ffffff50", fontFamily: "monospace", background: "#00000060", padding: "1px 5px", borderRadius: 3 }}>
                  T={lastResult?.motion?.threshold_used || settings.threshold_value} | {mode}
                </div>
              </div>

              {/* 사이드 패널 */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <Card style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>위험도</div>
                  <RiskGauge value={riskScore} />
                </Card>
                <Card>
                  <Histogram hist={lastResult?.quality?.histogram ?? null} label="히스토그램" height={48} />
                  <div style={{ display: "flex", gap: 3, alignItems: "center", marginTop: 4 }}>
                    <DiagBadge diagnosis={lastResult?.quality?.diagnosis ?? "good"} />
                    <span style={{ fontSize: 8, color: C.dim }}>σ={lastResult?.quality?.brightness_std ?? "-"}</span>
                  </div>
                </Card>
                {lastResult?.quality?.correction_type && (
                  <Card>
                    <div style={{ fontSize: 9, color: C.muted }}>보정 상태</div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#F8FAFC", marginTop: 2 }}>{lastResult.quality.correction_type}</div>
                  </Card>
                )}
              </div>
            </div>

            {/* 통계 카드 */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 10 }}>
              <StatCard label="밝기 평균" value={lastResult?.quality?.brightness_mean ?? "-"} unit="μ" color={C.accent} />
              <StatCard label="밝기 분산" value={lastResult?.quality?.brightness_std ?? "-"} unit="σ" color="#10B981"
                sub={lastResult && (lastResult.quality?.brightness_std ?? 99) < 30 ? "저대비⚠️" : ""} />
              <StatCard label="엔트로피" value={lastResult?.quality?.entropy ?? "-"} unit="bit" color="#F59E0B" />
              <StatCard label="모션 픽셀" value={lastResult?.motion?.total_motion_pixels ?? 0} unit="px"
                color={(lastResult?.motion?.total_motion_pixels ?? 0) > 1000 ? "#EF4444" : C.muted} />
            </div>

            {/* 타임라인 */}
            {timeline.length > 1 && (
              <Card style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 10, fontWeight: 600, color: "#F8FAFC" }}>위험도 타임라인</span>
                  <span style={{ fontSize: 9, color: C.dim, fontFamily: "monospace" }}>최근 {timeline.length}프레임</span>
                </div>
                <Timeline data={timeline.map((t) => t.risk)} />
              </Card>
            )}

            {/* 보정 파이프라인 */}
            {lastResult?.pipeline?.enhanced_previews && lastResult.pipeline.enhanced_previews.length > 0 && (
              <Card style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#F8FAFC", marginBottom: 6 }}>보정 파이프라인</div>
                <div style={{ display: "grid", gridTemplateColumns: `repeat(${lastResult.pipeline.enhanced_previews.length}, 1fr)`, gap: 6 }}>
                  {lastResult.pipeline.enhanced_previews.map((s, i) => (
                    <div key={i} style={{ textAlign: "center" }}>
                      <img src={`data:image/jpeg;base64,${s.base64}`} alt="" style={{ width: "100%", borderRadius: 6, border: `1px solid ${C.border}` }} />
                      <div style={{ fontSize: 9, color: C.accent, fontWeight: 600, marginTop: 4 }}>{s.step}</div>
                      <div style={{ fontSize: 8, color: C.dim }}>σ={s.std} | μ={s.mean}</div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* 적용된 처리 단계 */}
            {lastResult?.pipeline?.steps_applied && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginBottom: 8 }}>
                {lastResult.pipeline.steps_applied.map((s, i) => (
                  <span key={i} style={{ fontSize: 8, padding: "2px 6px", borderRadius: 4, background: C.accent + "12", color: C.accent, border: `1px solid ${C.accent}18` }}>{s}</span>
                ))}
              </div>
            )}
          </>}
        </>}

        {/* ═══════════ ROI ═══════════ */}
        {page === "roi" && <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#F8FAFC" }}>관심 영역 (ROI) 설정</div>
            <span style={{ fontSize: 10, color: C.dim }}>{roiPolygons.length}개 영역</span>
          </div>

          <Card style={{ padding: 0, overflow: "hidden", marginBottom: 10 }}>
            <RoiCanvas imageUrl={frameUrl} width={640} height={480} polygons={roiPolygons} onChange={updateRoi} />
          </Card>

          <div style={{ fontSize: 10, color: C.dim, marginBottom: 10, lineHeight: 1.6 }}>
            클릭으로 꼭짓점을 추가하고, 더블클릭으로 다각형을 완성하세요. 우클릭으로 삭제할 수 있어요.
            {mode === "camera" && " 대시보드에서 🎯 ROI 그리기 버튼을 누르면 카메라 영상 위에서도 그릴 수 있어요."}
          </div>

          {roiPolygons.length === 0 ? (
            <div style={{ textAlign: "center", padding: 30, color: C.dim, fontSize: 12, border: `1px dashed ${C.border}`, borderRadius: 10 }}>
              아직 설정된 ROI가 없습니다
            </div>
          ) : roiPolygons.map((z, i) => (
            <Card key={z.id} style={{ marginBottom: 6, borderColor: z.color + "33" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 3, background: z.color }} />
                  <span style={{ fontSize: 12, fontWeight: 700, color: z.color }}>{z.name}</span>
                  <span style={{ fontSize: 9, color: C.dim }}>{z.points.length}개 꼭짓점</span>
                </div>
                <button onClick={() => updateRoi(roiPolygons.filter((_, j) => j !== i))} style={{ background: "#EF444412", border: "1px solid #EF444422", borderRadius: 6, color: "#EF4444", cursor: "pointer", fontSize: 10, padding: "3px 10px" }}>삭제</button>
              </div>
            </Card>
          ))}
        </>}

        {/* ═══════════ 알림 ═══════════ */}
        {page === "alerts" && <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#F8FAFC" }}>알림 히스토리</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 10, color: C.dim }}>{alerts.length}건</span>
              {alerts.length > 0 && (
                <button onClick={() => { setAlerts([]); alertFrameUrls.current.forEach((u) => URL.revokeObjectURL(u)); alertFrameUrls.current.clear(); }} style={{ fontSize: 9, padding: "4px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: "none", color: C.muted, cursor: "pointer" }}>초기화</button>
              )}
            </div>
          </div>
          {alerts.length === 0 ? (
            <div style={{ textAlign: "center", padding: 50, color: C.dim, fontSize: 12, border: `1px dashed ${C.border}`, borderRadius: 10 }}>
              영상을 분석하면 위험도 {settings.alert_threshold} 이상일 때 알림이 기록됩니다
            </div>
          ) : alerts.map((a, i) => {
            const ac = (C as Record<string, string>)[a.risk_level] || C.muted;
            return (
              <div key={i} style={{ background: ac + "08", borderRadius: 10, border: `1px solid ${ac}18`, marginBottom: 6, overflow: "hidden" }}>
                <div style={{ display: "flex", gap: 8, padding: "10px 12px" }}>
                  {/* 캡처 프레임 썸네일 */}
                  {a.frame_base64 && (
                    <img src={a.frame_base64} alt="감지 순간" style={{ width: 80, height: 52, objectFit: "cover", borderRadius: 6, border: `1px solid ${ac}33`, flexShrink: 0, cursor: "pointer" }}
                      onClick={() => {
                        // 클릭 시 프레임 확대 표시
                        setFrameUrl(a.frame_base64 || null);
                        setPage("dashboard");
                      }}
                    />
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <Badge status={a.risk_level} />
                      <span style={{ fontSize: 9, color: C.muted, fontFamily: "monospace" }}>{a.timestamp}</span>
                    </div>
                    <div style={{ fontSize: 10, color: "#CBD5E1", marginTop: 4 }}>{a.message}</div>
                    <div style={{ fontSize: 9, color: C.dim, marginTop: 2 }}>
                      위험도: {a.risk_score.toFixed(1)} | 모션: {a.motion_pixels}px
                      {a.boxes?.some((b) => b.in_roi) && ` | ROI: ${a.boxes.find((b) => b.in_roi)?.in_roi}`}
                    </div>
                  </div>
                  <div style={{ width: 3, borderRadius: 2, background: ac, flexShrink: 0 }} />
                </div>
              </div>
            );
          })}
        </>}

        {/* ═══════════ 분석 ═══════════ */}
        {page === "analysis" && <>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#F8FAFC", marginBottom: 10 }}>분석 결과</div>

          {done ? (
            <Card style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#F8FAFC", marginBottom: 8 }}>분석 요약</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
                <StatCard label="분석 프레임" value={done.analyzed_frames || 0} unit="장" color={C.accent} />
                <StatCard label="감지 횟수" value={done.total_detections || 0} unit="회" color="#EF4444" />
                <StatCard label="평균 위험도" value={done.summary?.avg_risk?.toFixed(1) || 0} unit="" color="#F59E0B" />
                <StatCard label="최대 위험도" value={done.summary?.max_risk?.toFixed(1) || 0} unit="" color="#EF4444" />
              </div>
            </Card>
          ) : (
            <div style={{ textAlign: "center", padding: 30, color: C.dim, fontSize: 12, border: `1px dashed ${C.border}`, borderRadius: 10, marginBottom: 10 }}>
              영상 분석을 완료하면 여기에 결과가 표시됩니다
            </div>
          )}

          {heatmapUrl && (
            <Card style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#F8FAFC", marginBottom: 6 }}>움직임 히트맵</div>
              <img src={heatmapUrl} alt="heatmap" style={{ width: "100%", borderRadius: 8 }} />
              <div style={{ fontSize: 9, color: C.dim, marginTop: 4 }}>빨강 = 움직임 빈번 / 파랑 = 움직임 적음</div>
            </Card>
          )}

          <Card style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#F8FAFC", marginBottom: 8 }}>평가 지표 가이드</div>
            {([
              ["📊 영상 품질 (실시간)", [
                ["μ (평균 밝기)", "0~255. μ<50 저조도 → CLAHE 필요"],
                ["σ (밝기 분산)", "대비. σ<30 저대비 → 객체 구분 어려움"],
                ["Entropy", "정보량. 높을수록 디테일 풍부"],
                ["Histogram", "왼쪽 치우침=저조도, 고르게 퍼짐=양호"],
              ]],
              ["🎯 감지 성능 (분석 후)", [
                ["Precision", "감지 중 진짜 비율. 오탐↑ → Precision↓"],
                ["Recall", "실제 움직임 중 잡은 비율. 보안에서 가장 중요"],
                ["F1-Score", "Precision×Recall 균형. ≥0.8이면 양호"],
                ["SNR/PSNR", "노이즈 제거 효과. ≥30dB 양호"],
                ["ROC 곡선", "임계값별 검출률 vs 오탐률 그래프"],
              ]],
            ] as const).map(([title, items]) => (
              <div key={title} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: C.accent, marginBottom: 5 }}>{title}</div>
                {items.map(([name, desc]) => (
                  <div key={name} style={{ display: "flex", gap: 8, marginBottom: 4, fontSize: 10, padding: "3px 0" }}>
                    <span style={{ color: "#F8FAFC", fontWeight: 600, minWidth: 85, flexShrink: 0 }}>{name}</span>
                    <span style={{ color: C.dim }}>{desc}</span>
                  </div>
                ))}
              </div>
            ))}
          </Card>

          {lastResult?.pipeline?.steps_applied && (
            <Card>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#F8FAFC", marginBottom: 6 }}>적용된 처리 단계</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {lastResult.pipeline.steps_applied.map((s, i) => (
                  <span key={i} style={{ fontSize: 10, padding: "3px 8px", borderRadius: 6, background: C.accent + "12", color: C.accent, border: `1px solid ${C.accent}18` }}>{s}</span>
                ))}
              </div>
            </Card>
          )}
        </>}

        {/* ═══════════ 설정 ═══════════ */}
        {page === "settings" && <>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#F8FAFC", marginBottom: 10 }}>설정</div>

          {/* 슬라이더 */}
          {([
            { key: "threshold_value", label: "움직임 감지 임계값 (T)", desc: "프레임 차이 이진화 기준", min: 5, max: 100, unit: "/255" },
            { key: "min_motion_area", label: "최소 감지 영역", desc: "이 크기 미만은 노이즈로 무시", min: 50, max: 2000, unit: "px" },
            { key: "alert_threshold", label: "알림 임계값", desc: "이 위험도 이상일 때 알림", min: 10, max: 100, unit: "/100" },
            { key: "denoise_h", label: "노이즈 제거 강도", desc: "fastNlMeans h값", min: 0, max: 20, unit: "" },
            { key: "averaging_n", label: "Image Averaging N", desc: "평균할 프레임 수", min: 1, max: 20, unit: "프레임" },
            { key: "temporal_frames", label: "Temporal Smoothing N", desc: "연속 감지 판단 프레임 수", min: 1, max: 10, unit: "프레임" },
          ] as const).map((s) => (
            <Card key={s.key} style={{ marginBottom: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <div><div style={{ fontSize: 12, fontWeight: 600, color: "#F8FAFC" }}>{s.label}</div><div style={{ fontSize: 9, color: C.muted }}>{s.desc}</div></div>
                <div style={{ fontSize: 20, fontWeight: 800, color: C.accent, fontFamily: "monospace" }}>{(settings as any)[s.key]}<span style={{ fontSize: 9, color: C.muted }}>{s.unit}</span></div>
              </div>
              <input type="range" min={s.min} max={s.max} value={(settings as any)[s.key]} onChange={(e) => updateSetting(s.key, +e.target.value)} style={{ width: "100%", accentColor: C.accent }} />
            </Card>
          ))}

          <div style={{ fontSize: 11, fontWeight: 600, color: C.muted, margin: "14px 0 8px", textTransform: "uppercase", letterSpacing: 0.5 }}>필터 ON/OFF</div>

          {/* 토글 */}
          {([
            { key: "use_gaussian", label: "Gaussian Blur", desc: "고주파 노이즈 smoothing" },
            { key: "use_median", label: "Median Filter", desc: "소금-후추 노이즈 제거" },
            { key: "use_averaging", label: "Image Averaging", desc: "N프레임 평균으로 랜덤 노이즈 제거" },
            { key: "use_shadow_removal", label: "Shadow Removal", desc: "HSV 기반 그림자 오탐 제거" },
            { key: "use_temporal_smoothing", label: "Temporal Smoothing", desc: "연속 프레임 확인으로 단발성 오탐 제거" },
            { key: "use_adaptive_threshold", label: "Adaptive Threshold", desc: "영역별 자동 임계값" },
            { key: "use_dynamic_threshold", label: "Dynamic Threshold", desc: "밝기에 따라 임계값 자동 조정" },
            { key: "skip_unchanged_frames", label: "변화 없는 프레임 스킵", desc: "대역폭 절약" },
          ] as const).map((s) => (
            <Card key={s.key} style={{ marginBottom: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div><div style={{ fontSize: 11, fontWeight: 600, color: "#F8FAFC" }}>{s.label}</div><div style={{ fontSize: 9, color: C.muted }}>{s.desc}</div></div>
                <button onClick={() => updateSetting(s.key, !(settings as any)[s.key])} style={{
                  width: 38, height: 22, borderRadius: 11, border: "none", cursor: "pointer",
                  background: (settings as any)[s.key] ? C.accent : C.border,
                  position: "relative", transition: "background 0.2s",
                }}>
                  <div style={{ width: 16, height: 16, borderRadius: "50%", background: "#fff", position: "absolute", top: 3, left: (settings as any)[s.key] ? 19 : 3, transition: "left 0.2s" }} />
                </button>
              </div>
            </Card>
          ))}

          <div style={{ fontSize: 11, fontWeight: 600, color: C.muted, margin: "14px 0 8px", textTransform: "uppercase", letterSpacing: 0.5 }}>전송</div>
          <Card>
            <div style={{ display: "flex", gap: 6 }}>
              {(["binary", "base64"] as const).map((m) => (
                <button key={m} onClick={() => updateSetting("transfer_mode", m)} style={{
                  padding: "5px 14px", borderRadius: 6, border: `1px solid ${settings.transfer_mode === m ? C.accent : C.border}`,
                  background: settings.transfer_mode === m ? C.accent + "15" : "transparent",
                  color: settings.transfer_mode === m ? C.accent : C.muted, fontSize: 11, cursor: "pointer",
                }}>{m}</button>
              ))}
            </div>
            <div style={{ fontSize: 9, color: C.dim, marginTop: 6 }}>binary: 33% 절약 (기본) | base64: 디버깅 편리</div>
          </Card>
        </>}

      </div>
    </div>
  );
}