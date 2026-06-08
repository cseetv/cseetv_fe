/* 분석 완료 후 영상 재생기
   원본 영상을 <video>로 재생 + 분석 결과를 타임라인에 오버레이 */

import { useState, useRef, useEffect, useCallback } from "react";
import type { FrameResult } from "../types";

interface Props {
  videoUrl: string; // 원본 영상 blob URL
  results: FrameResult[]; // 프레임별 분석 결과
  fps?: number; // 분석 FPS (기본 2)
  onTimeUpdate?: (result: FrameResult | null) => void;
}

export function FramePlayer({
  videoUrl,
  results,
  fps = 2,
  onTimeUpdate,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // 현재 시간에 해당하는 분석 결과 인덱스
  const resultIdx = Math.min(Math.floor(currentTime * fps), results.length - 1);
  const currentResult = resultIdx >= 0 ? results[resultIdx] : null;

  // 감지된 프레임 위치 (타임라인 마커용)
  const detectionTimes = results
    .map((r, i) => (r.motion?.detected ? i / fps : -1))
    .filter((t) => t >= 0);

  useEffect(() => {
    if (onTimeUpdate) onTimeUpdate(currentResult);
  }, [resultIdx, currentResult, onTimeUpdate]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play();
      setPlaying(true);
    } else {
      v.pause();
      setPlaying(false);
    }
  }, []);

  const seek = useCallback((sec: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + sec));
  }, []);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Number(e.target.value);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") seek(-1);
      else if (e.key === "ArrowRight") seek(1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePlay, seek]);

  const fmt = (s: number) =>
    `${Math.floor(s / 60)}:${Math.floor(s % 60)
      .toString()
      .padStart(2, "0")}`;

  return (
    <div
      style={{
        borderRadius: 12,
        overflow: "hidden",
        border: "1px solid #E2E8F0",
        background: "#fff",
      }}
    >
      {/* 영상 */}
      <div style={{ position: "relative", background: "#000" }}>
        <video
          ref={videoRef}
          src={videoUrl}
          style={{ width: "100%", display: "block" }}
          onTimeUpdate={() =>
            setCurrentTime(videoRef.current?.currentTime || 0)
          }
          onLoadedMetadata={() => setDuration(videoRef.current?.duration || 0)}
          onEnded={() => setPlaying(false)}
          playsInline
        />
        {/* 감지 오버레이 */}
        {currentResult?.motion?.detected && (
          <div
            style={{
              position: "absolute",
              top: 8,
              left: 10,
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
        <div
          style={{
            position: "absolute",
            bottom: 6,
            right: 8,
            fontSize: 10,
            color: "#ffffffAA",
            fontFamily: "monospace",
            background: "#00000080",
            padding: "2px 8px",
            borderRadius: 4,
          }}
        >
          위험도: {currentResult?.motion?.risk_score?.toFixed(0) || 0} | #
          {resultIdx}
        </div>
      </div>

      {/* 감지 마커 바 */}
      {duration > 0 && (
        <div style={{ height: 4, background: "#F1F5F9", position: "relative" }}>
          {detectionTimes.map((t, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: `${(t / duration) * 100}%`,
                top: 0,
                width: 2,
                height: 4,
                background: "#EF4444",
              }}
            />
          ))}
        </div>
      )}

      {/* 시크바 */}
      <div style={{ padding: "4px 12px 0" }}>
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={currentTime}
          onChange={handleSeek}
          style={{ width: "100%", accentColor: "#4F46E5", cursor: "pointer" }}
        />
      </div>

      {/* 컨트롤 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 12px 10px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Btn onClick={() => seek(-10)} label="−10s" />
          <Btn onClick={() => seek(-1)} label="−1s" />
          <button
            onClick={togglePlay}
            style={{
              width: 36,
              height: 36,
              borderRadius: 99,
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 16,
              background: playing ? "#FEE2E2" : "#EEF2FF",
              color: playing ? "#EF4444" : "#4F46E5",
            }}
          >
            {playing ? "⏸" : "▶"}
          </button>
          <Btn onClick={() => seek(1)} label="+1s" />
          <Btn onClick={() => seek(10)} label="+10s" />
        </div>
        <span
          style={{ fontSize: 12, color: "#64748B", fontFamily: "monospace" }}
        >
          {fmt(currentTime)} / {fmt(duration)}
        </span>
      </div>
    </div>
  );
}

function Btn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "4px 8px",
        borderRadius: 6,
        border: "1px solid #E2E8F0",
        background: "#F8FAFC",
        color: "#64748B",
        fontSize: 10,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
