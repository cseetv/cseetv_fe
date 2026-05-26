import { useState, useRef, useCallback, useEffect } from "react";
import { Header, NavBar, Badge, StatCard, Histogram, RiskGauge, Timeline, Card, ProgressBar, DiagBadge, C } from "./components/ui";
import { RoiCanvas } from "./components/RoiCanvas";
import { useWebSocket } from "./hooks/useWebSocket";
import { useCamera } from "./hooks/useCamera";
import { useApi } from "./hooks/useApi";
import type { FrameResult, AlertItem, TimelinePoint, RoiPolygon, WsMessage, VideoInfo, Settings } from "./types";

/* ================================================================
   cseetv — CCTV 이상 움직임 감지 및 알림 시스템
   React 프론트엔드 v2 (WebSocket + 브라우저 카메라 + ROI)
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

export default function App() {
  const [page, setPage] = useState("dashboard");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  // 프레임 표시
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<FrameResult | null>(null);

  // 타임라인 + 알림
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [done, setDone] = useState<any>(null);

  // ROI
  const [roiPolygons, setRoiPolygons] = useState<RoiPolygon[]>([]);

  // 영상 업로드
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // 카메라
  const camera = useCamera();
  const videoElRef = useRef<HTMLVideoElement>(null);
  const cameraIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 히트맵
  const [heatmapUrl, setHeatmapUrl] = useState<string | null>(null);

  // 입력 모드
  const [mode, setMode] = useState<"idle" | "video" | "camera">("idle");

  // API
  const api = useApi();

  // ── WebSocket 핸들러 ──
  const handleWsMessage = useCallback((msg: WsMessage) => {
    const t = msg.type as string;

    if (t === "frame_meta" || t === "frame_result") {
      const fr = msg as unknown as FrameResult;
      setLastResult(fr);

      // base64 이미지가 있으면 표시
      if (fr.frame_base64) {
        setFrameUrl(`data:image/jpeg;base64,${fr.frame_base64}`);
      }

      const risk = fr.motion?.risk_score || 0;
      const motion = fr.motion?.total_motion_pixels || 0;
      setTimeline((prev) => [...prev.slice(-99), { risk, motion }]);

      // 알림 추가
      if (risk > settings.alert_threshold) {
        setAlerts((prev) => [{
          timestamp: new Date().toLocaleTimeString("ko-KR"),
          risk_score: risk,
          risk_level: fr.motion?.risk_level || "warn",
          motion_pixels: motion,
          boxes: fr.motion?.boxes || [],
          message: `움직임 감지 (위험도 ${risk.toFixed(0)})`,
          frame_base64: fr.frame_base64,
        }, ...prev].slice(0, 200));
      }
    } else if (t === "progress") {
      setProgress({ current: msg.current as number, total: msg.total as number });
    } else if (t === "done") {
      setDone(msg);
      setProgress(null);
      setMode("idle");
    } else if (t === "heatmap") {
      setHeatmapUrl(`data:image/jpeg;base64,${msg.heatmap_base64}`);
    } else if (t === "error") {
      console.error("서버 오류:", msg.message);
    }
  }, [settings.alert_threshold]);

  const handleWsBinary = useCallback((blob: Blob) => {
    const url = URL.createObjectURL(blob);
    setFrameUrl((prev) => {
      if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
      return url;
    });
  }, []);

  const ws = useWebSocket(handleWsMessage, handleWsBinary);

  // ── 영상 업로드 + 분석 시작 ──
  const handleVideoUpload = useCallback(async (file: File) => {
    try {
      if (videoPreviewUrl) {
        URL.revokeObjectURL(videoPreviewUrl);
      }
      setVideoPreviewUrl(URL.createObjectURL(file));
      setUploading(true);
      setTimeline([]);
      setAlerts([]);
      setDone(null);
      setHeatmapUrl(null);

      const info = await api.uploadVideo(file);
      setVideoInfo(info);
      setMode("video");

      // WebSocket 연결 후 분석 시작
      ws.connect();
      // 연결될 때까지 대기
      setTimeout(() => {
        ws.sendJson({ type: "start_video", video_id: info.video_id, include_previews: true });
      }, 1000);
    } catch (e) {
      console.error("업로드 실패:", e);
    } finally {
      setUploading(false);
    }
  }, [api, ws, videoPreviewUrl]);

  // ── 카메라 시작 ──
  const startCamera = useCallback(async () => {
    if (!videoElRef.current) return;
    await camera.start(videoElRef.current);
    setMode("camera");
    setTimeline([]);
    setAlerts([]);
    setDone(null);
    setHeatmapUrl(null);

    ws.connect();

    // 프레임 캡처 루프 시작 (초당 2프레임)
    setTimeout(() => {
      cameraIntervalRef.current = setInterval(async () => {
        const blob = await camera.captureFrameAsync();
        if (blob) ws.sendBinary(blob);
      }, 500);
    }, 1000);
  }, [camera, ws]);

  const stopCamera = useCallback(() => {
    if (cameraIntervalRef.current) {
      clearInterval(cameraIntervalRef.current);
      cameraIntervalRef.current = null;
    }
    camera.stop();
    ws.sendJson({ type: "stop" });
    setMode("idle");
  }, [camera, ws]);

  // ── 설정 변경 → 서버에 실시간 전송 ──
  const updateSetting = useCallback((key: string, value: unknown) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    ws.sendJson({ type: "update_settings", [key]: value });
  }, [ws]);

  // ── ROI 변경 → 서버에 전송 ──
  const updateRoi = useCallback((polys: RoiPolygon[]) => {
    setRoiPolygons(polys);
    ws.sendJson({
      type: "update_roi",
      polygons: polys.map((p) => ({ id: p.id, name: p.name, points: p.points })),
    });
  }, [ws]);

  // ── 정리 ──
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

  // ── 파생 상태 ──
  const riskScore = lastResult?.motion?.risk_score || 0;
  const riskLevel = riskScore > 70 ? "danger" : riskScore > 40 ? "warn" : "safe";

  // ── 렌더링 ──
  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: "#E2E8F0", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      <Header status={ws.status} riskLevel={riskLevel} videoName={videoInfo?.filename} />
      <NavBar page={page} onNavigate={setPage} />

      <div style={{ padding: "8px 12px", maxWidth: 900, margin: "0 auto" }}>

        {/* ═══ 대시보드 ═══ */}
        {page === "dashboard" && <>
          {/* 입력 버튼 */}
          <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 8, border: `1px solid #334155`, background: C.card, color: "#94A3B8", fontSize: 11, cursor: "pointer" }}>
              📁 영상 업로드
              <input type="file" accept="video/mp4,video/webm,.mp4,.webm,.mov" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleVideoUpload(f); }} style={{ display: "none" }} />
            </label>
            {mode !== "camera" ? (
              <button onClick={startCamera} style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: "#10B98120", color: "#10B981", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                📷 카메라 시작
              </button>
            ) : (
              <button onClick={stopCamera} style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: "#EF444420", color: "#EF4444", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                ⏹ 카메라 중지
              </button>
            )}
            {uploading && <span style={{ fontSize: 10, color: C.warn }}>업로드 중...</span>}
          </div>

          {/* 카메라 비디오 */}
          <video
            ref={videoElRef}
            style={{ display: mode === "camera" ? "block" : "none", width: "100%", borderRadius: 8, marginBottom: 8 }}
            playsInline
            muted
            autoPlay
          />

          {/* 진행률 */}
          {progress && <div style={{ marginBottom: 8 }}><ProgressBar current={progress.current} total={progress.total} label="영상 분석 진행률" /></div>}

          {!lastResult && mode === "idle" ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 280, border: `2px dashed ${C.border}`, borderRadius: 12, color: C.dim }}>
              <div style={{ fontSize: 40, marginBottom: 8 }}>🎬</div>
              <div style={{ fontSize: 14 }}>CCTV 영상을 업로드하거나 카메라를 시작하세요</div>
              <div style={{ fontSize: 11, marginTop: 6, color: "#334155", textAlign: "center", lineHeight: 1.6 }}>
                영상 파일 또는 브라우저 카메라로 실시간 움직임 감지
              </div>
            </div>
          ) : <>
            {/* 메인 뷰 */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 180px", gap: 8, marginBottom: 8 }}>
              <div style={{ position: "relative", background: C.dark, borderRadius: 8, overflow: "hidden", border: `1px solid ${C.border}` }}>
                {frameUrl ? (
                  <img src={frameUrl} alt="" style={{ width: "100%", display: "block", borderRadius: 8 }} />
                ) : mode === "video" && videoPreviewUrl ? (
                  <video src={videoPreviewUrl} controls style={{ width: "100%", display: "block", borderRadius: 8 }} />
                ) : null}
                {/* ROI 오버레이 */}
                {roiPolygons.map((z) => {
                  // 간단한 바운딩 박스 표시 (실제 다각형은 RoiPage에서)
                  return null; // ROI는 서버 측에서 처리
                })}
                <div style={{ position: "absolute", bottom: 4, right: 6, fontSize: 8, color: "#ffffff40", fontFamily: "monospace" }}>
                  T={lastResult?.motion?.threshold_used || settings.threshold_value} | {ws.status}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <Card style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase" }}>위험도</div>
                  <RiskGauge value={riskScore} />
                </Card>
                <Card>
                  <Histogram hist={lastResult?.quality?.histogram ?? null} label="히스토그램" height={44} />
                  <div style={{ display: "flex", gap: 3, alignItems: "center", marginTop: 3 }}>
                    <DiagBadge diagnosis={lastResult?.quality?.diagnosis ?? "good"} />
                    <span style={{ fontSize: 8, color: C.dim }}>σ={lastResult?.quality?.brightness_std}</span>
                  </div>
                </Card>
              </div>
            </div>

            {/* 통계 카드 */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 8 }}>
              <StatCard label="밝기 평균" value={lastResult?.quality?.brightness_mean ?? 0} unit="μ" color={C.accent} />
              <StatCard label="밝기 분산" value={lastResult?.quality?.brightness_std ?? 0} unit="σ" color="#10B981"
                sub={lastResult && (lastResult.quality?.brightness_std ?? 0) < 30 ? "저대비⚠️" : "양호"} />
              <StatCard label="엔트로피" value={lastResult?.quality?.entropy ?? 0} unit="bit" color="#F59E0B" />
              <StatCard label="모션 픽셀" value={lastResult?.motion?.total_motion_pixels || 0} unit="px"
                color={lastResult && (lastResult.motion?.total_motion_pixels || 0) > 1000 ? "#EF4444" : C.muted} />
            </div>

            {/* 타임라인 */}
            {timeline.length > 1 && (
              <Card style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 10, fontWeight: 600, color: "#F8FAFC" }}>움직임 타임라인</span>
                <Timeline data={timeline.map((t) => t.risk)} />
              </Card>
            )}

            {/* 보정 파이프라인 */}
            {lastResult?.pipeline?.enhanced_previews && (
              <Card>
                <div style={{ fontSize: 10, fontWeight: 600, color: "#F8FAFC", marginBottom: 6 }}>보정 파이프라인</div>
                <div style={{ display: "grid", gridTemplateColumns: `repeat(${lastResult.pipeline.enhanced_previews.length}, 1fr)`, gap: 4 }}>
                  {lastResult.pipeline.enhanced_previews.map((s, i) => (
                    <div key={i} style={{ textAlign: "center" }}>
                      <img src={`data:image/jpeg;base64,${s.base64}`} alt="" style={{ width: "100%", borderRadius: 4, border: `1px solid ${C.border}` }} />
                      <div style={{ fontSize: 9, color: C.accent, fontWeight: 600, marginTop: 3 }}>{s.step}</div>
                      <div style={{ fontSize: 8, color: C.dim }}>σ={s.std}</div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* 적용된 단계 */}
            {lastResult?.pipeline?.steps_applied && (
              <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 3 }}>
                {lastResult.pipeline.steps_applied.map((s, i) => (
                  <span key={i} style={{ fontSize: 8, padding: "1px 5px", borderRadius: 4, background: C.accent + "15", color: C.accent, border: `1px solid ${C.accent}22` }}>{s}</span>
                ))}
              </div>
            )}
          </>}
        </>}

        {/* ═══ ROI ═══ */}
        {page === "roi" && <>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#F8FAFC", marginBottom: 8 }}>관심 영역 (ROI) 설정</div>
          <RoiCanvas
            imageUrl={frameUrl}
            width={640}
            height={480}
            polygons={roiPolygons}
            onChange={updateRoi}
          />
          <div style={{ marginTop: 8 }}>
            {roiPolygons.length === 0 ? (
              <div style={{ textAlign: "center", padding: 20, color: C.dim, fontSize: 11 }}>
                위 영역을 클릭하여 ROI를 그리세요. 더블클릭으로 완성합니다.
              </div>
            ) : roiPolygons.map((z, i) => (
              <Card key={z.id} style={{ marginBottom: 6, borderColor: z.color + "33" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 2, background: z.color }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: z.color }}>{z.name}</span>
                    <span style={{ fontSize: 9, color: C.dim }}>{z.points.length}개 꼭짓점</span>
                  </div>
                  <button onClick={() => updateRoi(roiPolygons.filter((_, j) => j !== i))} style={{ background: "none", border: "none", color: "#EF4444", cursor: "pointer", fontSize: 11 }}>삭제</button>
                </div>
              </Card>
            ))}
          </div>
        </>}

        {/* ═══ 알림 ═══ */}
        {page === "alerts" && <>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#F8FAFC" }}>알림 히스토리</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 10, color: C.dim }}>{alerts.length}건</span>
              {alerts.length > 0 && (
                <button onClick={() => setAlerts([])} style={{ fontSize: 9, padding: "3px 8px", borderRadius: 6, border: `1px solid ${C.border}`, background: "none", color: C.muted, cursor: "pointer" }}>초기화</button>
              )}
            </div>
          </div>
          {alerts.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: C.dim, fontSize: 12 }}>
              영상을 분석하면 위험도 {settings.alert_threshold} 이상일 때 알림이 기록됩니다
            </div>
          ) : alerts.map((a, i) => {
            const ac = (C as Record<string, string>)[a.risk_level] || C.muted;
            return (
              <div key={i} style={{ display: "flex", gap: 6, padding: "8px 10px", background: ac + "0D", borderRadius: 8, border: `1px solid ${ac}22`, marginBottom: 4 }}>
                <div style={{ width: 3, borderRadius: 2, background: ac, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <Badge status={a.risk_level} />
                    <span style={{ fontSize: 9, color: C.muted, fontFamily: "monospace" }}>{a.timestamp}</span>
                  </div>
                  <div style={{ fontSize: 10, color: "#CBD5E1", marginTop: 3 }}>{a.message}</div>
                  <div style={{ fontSize: 9, color: C.dim, marginTop: 1 }}>
                    위험도: {a.risk_score.toFixed(1)} | 모션: {a.motion_pixels}px
                    {a.boxes?.some((b) => b.in_roi) && ` | ROI: ${a.boxes.find((b) => b.in_roi)?.in_roi}`}
                  </div>
                </div>
              </div>
            );
          })}
        </>}

        {/* ═══ 분석 ═══ */}
        {page === "analysis" && <>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#F8FAFC", marginBottom: 8 }}>분석 결과</div>

          {/* 완료 요약 */}
          {done && (
            <Card style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#F8FAFC", marginBottom: 6 }}>분석 요약</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
                <StatCard label="분석 프레임" value={done.analyzed_frames || 0} unit="장" color={C.accent} />
                <StatCard label="감지 횟수" value={done.total_detections || 0} unit="회" color="#EF4444" />
                <StatCard label="평균 위험도" value={done.summary?.avg_risk?.toFixed(1) || 0} unit="" color="#F59E0B" />
                <StatCard label="최대 위험도" value={done.summary?.max_risk?.toFixed(1) || 0} unit="" color="#EF4444" />
              </div>
            </Card>
          )}

          {/* 히트맵 */}
          {heatmapUrl && (
            <Card style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#F8FAFC", marginBottom: 6 }}>움직임 히트맵</div>
              <img src={heatmapUrl} alt="heatmap" style={{ width: "100%", borderRadius: 6 }} />
              <div style={{ fontSize: 9, color: C.dim, marginTop: 4 }}>빨강=움직임 빈번 / 파랑=움직임 적음</div>
            </Card>
          )}

          {/* 평가 지표 설명 */}
          <Card style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#F8FAFC", marginBottom: 6 }}>평가 지표 가이드</div>
            {([
              ["영상 품질 (실시간)", [
                ["μ (평균 밝기)", "영상의 전체 밝기. μ<50이면 저조도 → CLAHE 보정 필요"],
                ["σ (밝기 분산)", "대비 정도. σ<30이면 저대비 → 객체 구분 어려움"],
                ["Entropy", "정보량(bit). 높을수록 디테일 풍부. 보정 후 증가하면 정보 회복 성공"],
                ["Histogram", "밝기 분포. 왼쪽 치우침=저조도, 고르게 퍼짐=양호"],
              ]],
              ["감지 성능 (분석 후)", [
                ["Precision", "감지한 것 중 진짜 비율. 오탐이 많으면 ↓. '알림 10개 중 진짜 8개 = 0.8'"],
                ["Recall", "실제 움직임 중 잡은 비율. 미검출이 많으면 ↓. 보안에서 가장 중요"],
                ["F1-Score", "Precision×Recall 균형. 0.8 이상이면 양호"],
                ["SNR/PSNR", "노이즈 제거 효과. 필터 적용 전후 비교. 30dB↑ 양호"],
                ["ROC 곡선", "임계값별 검출률 vs 오탐률. 왼쪽 위에 가까울수록 좋음"],
              ]],
            ] as const).map(([title, items]) => (
              <div key={title} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: C.accent, marginBottom: 4 }}>{title}</div>
                {items.map(([name, desc]) => (
                  <div key={name} style={{ display: "flex", gap: 6, marginBottom: 3, fontSize: 10 }}>
                    <span style={{ color: "#F8FAFC", fontWeight: 600, minWidth: 80 }}>{name}</span>
                    <span style={{ color: C.dim }}>{desc}</span>
                  </div>
                ))}
              </div>
            ))}
          </Card>

          {/* 적용된 파이프라인 단계 */}
          {lastResult?.pipeline?.steps_applied && (
            <Card>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#F8FAFC", marginBottom: 6 }}>적용된 처리 단계</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {lastResult.pipeline.steps_applied.map((s, i) => (
                  <span key={i} style={{ fontSize: 10, padding: "3px 8px", borderRadius: 6, background: C.accent + "15", color: C.accent, border: `1px solid ${C.accent}22` }}>{s}</span>
                ))}
              </div>
            </Card>
          )}
        </>}

        {/* ═══ 설정 ═══ */}
        {page === "settings" && <>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#F8FAFC", marginBottom: 8 }}>설정</div>

          {/* 슬라이더 설정 */}
          {([
            { key: "threshold_value", label: "움직임 감지 임계값 (T)", desc: "프레임 차이 이진화 기준", min: 5, max: 100, unit: "/255" },
            { key: "min_motion_area", label: "최소 감지 영역", desc: "이 크기 미만은 노이즈로 무시", min: 50, max: 2000, unit: "px" },
            { key: "alert_threshold", label: "알림 임계값", desc: "이 위험도 이상일 때 알림 발생", min: 10, max: 100, unit: "/100" },
            { key: "denoise_h", label: "노이즈 제거 강도", desc: "fastNlMeans h값. 클수록 강한 제거", min: 0, max: 20, unit: "" },
            { key: "averaging_n", label: "Image Averaging N", desc: "평균할 프레임 수. 클수록 안정적이지만 느림", min: 1, max: 20, unit: "프레임" },
            { key: "temporal_frames", label: "Temporal Smoothing N", desc: "연속 N프레임 감지 시 진짜로 판단", min: 1, max: 10, unit: "프레임" },
          ] as const).map((s) => (
            <Card key={s.key} style={{ marginBottom: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#F8FAFC" }}>{s.label}</div>
                  <div style={{ fontSize: 9, color: C.muted }}>{s.desc}</div>
                </div>
                <div style={{ fontSize: 18, fontWeight: 800, color: C.accent, fontFamily: "monospace" }}>
                  {(settings as any)[s.key]}<span style={{ fontSize: 9, color: C.muted }}>{s.unit}</span>
                </div>
              </div>
              <input type="range" min={s.min} max={s.max} value={(settings as any)[s.key]}
                onChange={(e) => updateSetting(s.key, +e.target.value)}
                style={{ width: "100%", accentColor: C.accent }} />
            </Card>
          ))}

          {/* 토글 설정 */}
          {([
            { key: "use_gaussian", label: "Gaussian Blur", desc: "고주파 노이즈 smoothing" },
            { key: "use_median", label: "Median Filter", desc: "소금-후추 노이즈 제거" },
            { key: "use_averaging", label: "Image Averaging", desc: "N프레임 평균으로 랜덤 노이즈 제거" },
            { key: "use_shadow_removal", label: "Shadow Removal", desc: "HSV 기반 그림자 오탐 제거" },
            { key: "use_temporal_smoothing", label: "Temporal Smoothing", desc: "연속 프레임 확인으로 단발성 오탐 제거" },
            { key: "use_adaptive_threshold", label: "Adaptive Threshold", desc: "영역별 자동 임계값 (고정 임계값 대체)" },
            { key: "use_dynamic_threshold", label: "Dynamic Threshold", desc: "밝기에 따라 임계값 자동 조정" },
            { key: "skip_unchanged_frames", label: "변화 없는 프레임 스킵", desc: "움직임 없으면 이미지 생략하여 대역폭 절약" },
          ] as const).map((s) => (
            <Card key={s.key} style={{ marginBottom: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#F8FAFC" }}>{s.label}</div>
                  <div style={{ fontSize: 9, color: C.muted }}>{s.desc}</div>
                </div>
                <button onClick={() => updateSetting(s.key, !(settings as any)[s.key])} style={{
                  width: 36, height: 20, borderRadius: 10, border: "none", cursor: "pointer",
                  background: (settings as any)[s.key] ? C.accent : C.border,
                  position: "relative", transition: "background 0.2s",
                }}>
                  <div style={{
                    width: 16, height: 16, borderRadius: "50%", background: "#fff",
                    position: "absolute", top: 2,
                    left: (settings as any)[s.key] ? 18 : 2,
                    transition: "left 0.2s",
                  }} />
                </button>
              </div>
            </Card>
          ))}

          {/* 전송 모드 */}
          <Card style={{ marginTop: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#F8FAFC", marginBottom: 4 }}>전송 모드</div>
            <div style={{ display: "flex", gap: 6 }}>
              {(["binary", "base64"] as const).map((m) => (
                <button key={m} onClick={() => updateSetting("transfer_mode", m)} style={{
                  padding: "4px 12px", borderRadius: 6, border: `1px solid ${settings.transfer_mode === m ? C.accent : C.border}`,
                  background: settings.transfer_mode === m ? C.accent + "18" : "transparent",
                  color: settings.transfer_mode === m ? C.accent : C.muted, fontSize: 11, cursor: "pointer",
                }}>{m}</button>
              ))}
            </div>
            <div style={{ fontSize: 9, color: C.dim, marginTop: 4 }}>binary: 33% 절약 (기본) | base64: 디버깅 편리</div>
          </Card>
        </>}
      </div>
      <div style={{ height: 16 }} />
    </div>
  );
}