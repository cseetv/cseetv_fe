/* 분석 완료 후 프레임 재생기
   - 저장된 프레임을 영상처럼 재생
   - 재생바 드래그, 10초 전후 이동, 정지/재생
*/

import { useState, useRef, useEffect, useCallback } from "react";

interface StoredFrame {
  url: string; // blob URL 또는 data URL
  index: number;
  timestamp?: number;
  detected?: boolean;
  riskScore?: number;
}

interface Props {
  frames: StoredFrame[];
  fps?: number; // 재생 속도 (기본 2fps = 분석 속도와 동일)
  onFrameChange?: (frame: StoredFrame) => void;
}

const C = {
  bg: "#020617",
  card: "#0F172A",
  border: "#1E293B",
  accent: "#6366F1",
  muted: "#64748B",
  text: "#E2E8F0",
};

export function FramePlayer({ frames, fps = 2, onFrameChange }: Props) {
  const [currentIdx, setCurrentIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playbackFps, setPlaybackFps] = useState(fps);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const total = frames.length;
  const current = frames[currentIdx] || null;

  // 재생/정지 토글
  const togglePlay = useCallback(() => {
    setPlaying((prev) => !prev);
  }, []);

  // 재생 루프
  useEffect(() => {
    if (!playing) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      return;
    }

    intervalRef.current = setInterval(() => {
      setCurrentIdx((prev) => {
        const next = prev + 1;
        if (next >= total) {
          setPlaying(false);
          return prev;
        }
        return next;
      });
    }, 1000 / playbackFps);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [playing, playbackFps, total]);

  // 프레임 변경 콜백
  useEffect(() => {
    if (current && onFrameChange) {
      onFrameChange(current);
    }
  }, [currentIdx, current, onFrameChange]);

  // 10초 이동 (fps 기준)
  const skip = useCallback(
    (seconds: number) => {
      const delta = Math.round(seconds * playbackFps);
      setCurrentIdx((prev) => Math.max(0, Math.min(total - 1, prev + delta)));
    },
    [playbackFps, total],
  );

  // 시크바 클릭/드래그
  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setCurrentIdx(Number(e.target.value));
  }, []);

  // 키보드
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") skip(-1);
      else if (e.key === "ArrowRight") skip(1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePlay, skip]);

  if (total === 0) return null;

  const timeStr = (idx: number) => {
    const sec = idx / playbackFps;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // 감지 위치 마커
  const detectionMarkers = frames
    .map((f, i) => (f.detected ? i : -1))
    .filter((i) => i >= 0);

  return (
    <div
      style={{
        background: C.card,
        borderRadius: 10,
        overflow: "hidden",
        border: `1px solid ${C.border}`,
      }}
    >
      {/* 프레임 표시 */}
      <div
        style={{
          position: "relative",
          background: "#000",
          aspectRatio: "16/10",
        }}
      >
        {current && (
          <img
            src={current.url}
            alt={`Frame ${current.index}`}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              display: "block",
            }}
          />
        )}
        {/* 상태 오버레이 */}
        <div
          style={{
            position: "absolute",
            top: 6,
            left: 8,
            display: "flex",
            gap: 4,
          }}
        >
          {current?.detected && (
            <span
              style={{
                fontSize: 9,
                padding: "2px 7px",
                borderRadius: 99,
                background: "#EF444430",
                color: "#EF4444",
                fontWeight: 600,
              }}
            >
              움직임 감지
            </span>
          )}
          {playing && (
            <span
              style={{
                fontSize: 9,
                padding: "2px 7px",
                borderRadius: 99,
                background: "#10B98130",
                color: "#10B981",
                fontWeight: 600,
              }}
            >
              재생 중
            </span>
          )}
        </div>
        <div
          style={{
            position: "absolute",
            bottom: 4,
            right: 6,
            fontSize: 9,
            color: "#ffffff60",
            fontFamily: "monospace",
            background: "#00000080",
            padding: "1px 6px",
            borderRadius: 3,
          }}
        >
          #{current?.index || 0} | 위험도: {current?.riskScore?.toFixed(0) || 0}
        </div>
      </div>

      {/* 시크바 */}
      <div style={{ padding: "6px 12px", position: "relative" }}>
        {/* 감지 마커 (시크바 위에 빨간 점) */}
        <div style={{ position: "relative", height: 4, marginBottom: 2 }}>
          {detectionMarkers.map((idx) => (
            <div
              key={idx}
              style={{
                position: "absolute",
                left: `${(idx / Math.max(total - 1, 1)) * 100}%`,
                top: 0,
                width: 2,
                height: 4,
                background: "#EF4444",
                borderRadius: 1,
              }}
            />
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={total - 1}
          value={currentIdx}
          onChange={handleSeek}
          style={{ width: "100%", accentColor: C.accent, cursor: "pointer" }}
        />
      </div>

      {/* 컨트롤 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 12px 10px",
          gap: 8,
        }}
      >
        {/* 왼쪽: 재생 버튼 + 10초 이동 */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button onClick={() => skip(-10)} title="10초 뒤로" style={btnStyle}>
            ⏪
          </button>
          <button onClick={() => skip(-1)} title="1초 뒤로" style={btnStyle}>
            ◀
          </button>
          <button
            onClick={togglePlay}
            style={{
              ...btnStyle,
              width: 36,
              height: 36,
              fontSize: 16,
              background: playing ? "#EF444420" : "#10B98120",
              color: playing ? "#EF4444" : "#10B981",
            }}
          >
            {playing ? "⏸" : "▶"}
          </button>
          <button onClick={() => skip(1)} title="1초 앞으로" style={btnStyle}>
            ▶
          </button>
          <button onClick={() => skip(10)} title="10초 앞으로" style={btnStyle}>
            ⏩
          </button>
        </div>

        {/* 중앙: 시간 */}
        <div style={{ fontSize: 11, color: C.text, fontFamily: "monospace" }}>
          {timeStr(currentIdx)} / {timeStr(total - 1)}
        </div>

        {/* 오른쪽: 속도 */}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ fontSize: 9, color: C.muted }}>속도</span>
          {[1, 2, 5, 10].map((s) => (
            <button
              key={s}
              onClick={() => setPlaybackFps(s)}
              style={{
                ...btnStyle,
                fontSize: 9,
                padding: "2px 6px",
                background: playbackFps === s ? C.accent + "20" : "transparent",
                color: playbackFps === s ? C.accent : C.muted,
                border: `1px solid ${playbackFps === s ? C.accent + "40" : C.border}`,
              }}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 6,
  border: `1px solid #334155`,
  background: "transparent",
  color: "#94A3B8",
  fontSize: 12,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
