/* 분석 완료 후 영상 재생기
   원본 영상 <video> + 감지 영역 캔버스 오버레이 */

import { useState, useRef, useEffect, useCallback } from "react";
import type { FrameResult } from "../types";

interface Props {
  videoUrl: string;
  results: FrameResult[];
  fps?: number;
  onTimeUpdate?: (result: FrameResult | null) => void;
}

export function FramePlayer({ videoUrl, results, fps = 2, onTimeUpdate }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [videoSize, setVideoSize] = useState({ w: 640, h: 480 });

  const resultIdx = Math.min(Math.floor(currentTime * fps), results.length - 1);
  const currentResult = resultIdx >= 0 ? results[resultIdx] : null;
  const boxes = currentResult?.motion?.boxes || [];
  const detected = currentResult?.motion?.detected || false;
  const risk = currentResult?.motion?.risk_score || 0;

  // 감지된 프레임 타임라인 마커
  const detectionTimes = results
    .map((r, i) => (r.motion?.detected ? i / fps : -1))
    .filter(t => t >= 0);

  useEffect(() => {
    if (onTimeUpdate) onTimeUpdate(currentResult);
  }, [resultIdx]);

  // 캔버스에 감지 영역 그리기
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 캔버스 크기를 비디오 표시 크기에 맞춤
    const rect = video.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!detected || boxes.length === 0) return;

    // 비디오 원본 크기 → 표시 크기 비율
    const vw = video.videoWidth || 640;
    const vh = video.videoHeight || 480;
    const scaleX = rect.width / vw;
    const scaleY = rect.height / vh;

    // 감지 박스 그리기
    boxes.forEach((box: any) => {
      const x = (box.x || 0) * scaleX;
      const y = (box.y || 0) * scaleY;
      const w = (box.w || box.width || 0) * scaleX;
      const h = (box.h || box.height || 0) * scaleY;

      // 박스
      ctx.strokeStyle = risk > 70 ? "#EF4444" : risk > 40 ? "#F59E0B" : "#22C55E";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);

      // 배경 fill (반투명)
      ctx.fillStyle = ctx.strokeStyle + "18";
      ctx.fillRect(x, y, w, h);

      // 라벨
      const label = `${(box.area || 0).toLocaleString()}px`;
      ctx.font = "bold 11px sans-serif";
      const textW = ctx.measureText(label).width;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillRect(x, y - 18, textW + 8, 18);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, x + 4, y - 5);
    });

    // 모션 픽셀 전체 수
    if (detected) {
      const motionPx = currentResult?.motion?.total_motion_pixels || 0;
      ctx.font = "bold 12px sans-serif";
      ctx.fillStyle = "#EF4444CC";
      ctx.fillRect(canvas.width - 140, 8, 132, 24);
      ctx.fillStyle = "#fff";
      ctx.fillText(`모션: ${motionPx.toLocaleString()}px`, canvas.width - 134, 24);
    }
  }, [resultIdx, detected, boxes, risk, videoSize]);

  // 비디오 크기 변경 감지
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const obs = new ResizeObserver(() => {
      const r = video.getBoundingClientRect();
      setVideoSize({ w: r.width, h: r.height });
    });
    obs.observe(video);
    return () => obs.disconnect();
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setPlaying(true); }
    else { v.pause(); setPlaying(false); }
  }, []);

  const seek = useCallback((sec: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + sec));
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === " ") { e.preventDefault(); togglePlay(); }
      else if (e.key === "ArrowLeft") seek(-1);
      else if (e.key === "ArrowRight") seek(1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePlay, seek]);

  const fmt = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;

  return (
    <div style={{ borderRadius: 12, overflow: "hidden", border: "1px solid #E2E8F0", background: "#fff" }}>
      {/* 영상 + 캔버스 오버레이 */}
      <div ref={containerRef} style={{ position: "relative", background: "#000" }}>
        <video
          ref={videoRef}
          src={videoUrl}
          style={{ width: "100%", display: "block" }}
          onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime || 0)}
          onLoadedMetadata={() => {
            setDuration(videoRef.current?.duration || 0);
            setVideoSize({ w: videoRef.current?.clientWidth || 640, h: videoRef.current?.clientHeight || 480 });
          }}
          onEnded={() => setPlaying(false)}
          playsInline
        />
        {/* 감지 영역 오버레이 캔버스 */}
        <canvas
          ref={canvasRef}
          style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none" }}
        />
        {/* 감지 상태 뱃지 */}
        {detected && (
          <div style={{ position: "absolute", top: 8, left: 10, padding: "4px 10px", borderRadius: 6, background: "#EF4444DD", color: "#fff", fontSize: 11, fontWeight: 700, pointerEvents: "none" }}>
            🔴 움직임 감지 ({boxes.length}개 영역)
          </div>
        )}
      </div>

      {/* 감지 마커 바 */}
      {duration > 0 && (
        <div style={{ height: 4, background: "#F1F5F9", position: "relative" }}>
          {detectionTimes.map((t, i) => (
            <div key={i} style={{ position: "absolute", left: `${(t / duration) * 100}%`, top: 0, width: 2, height: 4, background: "#EF4444" }} />
          ))}
          {/* 현재 위치 */}
          <div style={{ position: "absolute", left: `${(currentTime / duration) * 100}%`, top: -2, width: 4, height: 8, background: "#4F46E5", borderRadius: 2 }} />
        </div>
      )}

      {/* 시크바 */}
      <div style={{ padding: "4px 12px 0" }}>
        <input type="range" min={0} max={duration || 1} step={0.1} value={currentTime}
          onChange={e => { const v = videoRef.current; if (v) v.currentTime = Number(e.target.value); }}
          style={{ width: "100%", accentColor: "#4F46E5", cursor: "pointer" }} />
      </div>

      {/* 컨트롤 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 12px 10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Btn onClick={() => seek(-10)} label="⏪ 10s" />
          <Btn onClick={() => seek(-1)} label="◀ 1s" />
          <button onClick={togglePlay} style={{
            width: 38, height: 38, borderRadius: 99, border: "none", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16,
            background: playing ? "#FEE2E2" : "#EEF2FF", color: playing ? "#EF4444" : "#4F46E5",
          }}>
            {playing ? "⏸" : "▶"}
          </button>
          <Btn onClick={() => seek(1)} label="1s ▶" />
          <Btn onClick={() => seek(10)} label="10s ⏩" />
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 12, color: "#475569", fontFamily: "monospace" }}>{fmt(currentTime)} / {fmt(duration)}</div>
          <div style={{ fontSize: 10, color: "#94A3B8" }}>프레임 #{resultIdx >= 0 ? resultIdx : 0} | 위험도 {risk.toFixed(0)}</div>
        </div>
      </div>
    </div>
  );
}

function Btn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} style={{
      padding: "5px 10px", borderRadius: 6, border: "1px solid #E2E8F0",
      background: "#F8FAFC", color: "#64748B", fontSize: 11, cursor: "pointer",
      fontWeight: 500,
    }}>
      {label}
    </button>
  );
}