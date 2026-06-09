/* CameraView — 카메라 완전 자체 관리
   카메라 시작/중지, 프레임 캡처, 감지 박스, 시각, 녹화를 모두 내부에서 처리.
   App.tsx는 onFrame 콜백으로 서버에 전송하고, lastResult로 감지 결과를 받음. */

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";
import type { FrameResult } from "../types";

interface Props {
  active: boolean; // true면 카메라 시작
  lastResult: FrameResult | null; // 서버에서 받은 분석 결과
  onFrame: (blob: Blob) => void; // 캡처된 프레임 → App이 서버에 전송
  onStopped?: () => void; // 카메라 완전 중지 시 콜백
  onRecordingComplete?: (blob: Blob) => void; // 녹화 완료 시 콜백
  captureInterval?: number; // 프레임 캡처 간격 ms (기본 500)
}

export interface CameraViewHandle {
  startRecording: () => void;
  stopRecording: () => void;
}

export const CameraView = forwardRef<CameraViewHandle, Props>(
  (
    {
      active,
      lastResult,
      onFrame,
      onStopped,
      onRecordingComplete,
      captureInterval = 500,
    },
    ref,
  ) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null); // 감지 박스 오버레이
    const captureCanvasRef = useRef<HTMLCanvasElement>(null); // 프레임 캡처용 (hidden)
    const streamRef = useRef<MediaStream | null>(null);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const [recording, setRecording] = useState(false);
    const [currentTime, setCurrentTime] = useState("");
    const [recSec, setRecSec] = useState(0);
    const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // 시각 업데이트
    useEffect(() => {
      const t = setInterval(
        () =>
          setCurrentTime(
            new Date().toLocaleTimeString("ko-KR", { hour12: false }),
          ),
        1000,
      );
      return () => clearInterval(t);
    }, []);

    // ── 카메라 시작/중지 ──
    useEffect(() => {
      if (!active) {
        // 카메라 중지
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        }
        if (videoRef.current) videoRef.current.srcObject = null;
        if (recording) stopRecordingInternal();
        return;
      }

      // 카메라 시작
      let cancelled = false;
      (async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: "environment",
              width: { ideal: 640 },
              height: { ideal: 480 },
            },
            audio: false,
          });
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          streamRef.current = stream;
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            await videoRef.current.play().catch(() => {});
          }

          // 프레임 캡처 루프
          intervalRef.current = setInterval(() => {
            const video = videoRef.current;
            const canvas = captureCanvasRef.current;
            if (!video || !canvas || video.readyState < 2) return;

            canvas.width = video.videoWidth || 640;
            canvas.height = video.videoHeight || 480;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(
              (blob) => {
                if (blob) onFrame(blob);
              },
              "image/jpeg",
              0.7,
            );
          }, captureInterval);
        } catch (e) {
          console.error("카메라 시작 실패:", e);
        }
      })();

      return () => {
        cancelled = true;
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
        }
      };
    }, [active, captureInterval, onFrame]);

    // ── 감지 박스 + 시각 오버레이 ──
    useEffect(() => {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) return;
      const rect = video.getBoundingClientRect();
      if (rect.width < 10) return;
      canvas.width = rect.width;
      canvas.height = rect.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // 시각
      ctx.font = "bold 13px monospace";
      ctx.fillStyle = "#00000080";
      ctx.fillRect(8, 8, ctx.measureText(currentTime).width + 14, 24);
      ctx.fillStyle = "#fff";
      ctx.fillText(currentTime, 15, 26);

      // 녹화 표시
      if (recording) {
        const m = Math.floor(recSec / 60),
          s = (recSec % 60).toString().padStart(2, "0");
        const txt = `● REC ${m}:${s}`;
        ctx.font = "bold 12px sans-serif";
        const tw = ctx.measureText(txt).width;
        ctx.fillStyle = "#EF444490";
        ctx.fillRect(canvas.width - tw - 22, 8, tw + 14, 22);
        ctx.fillStyle = "#fff";
        ctx.fillText(txt, canvas.width - tw - 15, 24);
      }

      // 감지 박스
      const boxes = lastResult?.motion?.boxes || [];
      const detected = lastResult?.motion?.detected;
      const risk = lastResult?.motion?.risk_score || 0;
      if (!detected || !boxes.length) return;

      const vw = video.videoWidth || 640,
        vh = video.videoHeight || 480;
      const sx = rect.width / vw,
        sy = rect.height / vh;
      const color = risk > 70 ? "#EF4444" : risk > 40 ? "#F59E0B" : "#22C55E";

      boxes.forEach((box: any) => {
        const x = (box.x || 0) * sx,
          y = (box.y || 0) * sy,
          w = (box.w || 0) * sx,
          h = (box.h || 0) * sy;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = color + "20";
        ctx.fillRect(x, y, w, h);
        ctx.font = "bold 10px sans-serif";
        const lbl = `${(box.area || 0).toLocaleString()}px`;
        ctx.fillStyle = color;
        ctx.fillRect(x, y - 15, ctx.measureText(lbl).width + 8, 15);
        ctx.fillStyle = "#fff";
        ctx.fillText(lbl, x + 4, y - 3);
      });

      const motionPx = lastResult?.motion?.total_motion_pixels || 0;
      const info = `모션: ${motionPx.toLocaleString()}px | 위험도: ${risk.toFixed(0)}`;
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = color + "CC";
      ctx.fillRect(8, canvas.height - 28, ctx.measureText(info).width + 14, 22);
      ctx.fillStyle = "#fff";
      ctx.fillText(info, 15, canvas.height - 12);
    }, [lastResult, currentTime, recording, recSec]);

    // ── 녹화 ──
    const startRecordingInternal = useCallback(() => {
      if (!streamRef.current) return;
      chunksRef.current = [];
      try {
        const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
          ? "video/webm;codecs=vp9"
          : "video/webm";
        const rec = new MediaRecorder(streamRef.current, { mimeType: mime });
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        rec.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: "video/webm" });
          if (onRecordingComplete) onRecordingComplete(blob);
        };
        rec.start(1000);
        recorderRef.current = rec;
        setRecording(true);
        setRecSec(0);
        recTimerRef.current = setInterval(() => setRecSec((p) => p + 1), 1000);
      } catch (e) {
        console.error("녹화 실패:", e);
      }
    }, [onRecordingComplete]);

    const stopRecordingInternal = useCallback(() => {
      if (recorderRef.current?.state !== "inactive")
        recorderRef.current?.stop();
      recorderRef.current = null;
      setRecording(false);
      if (recTimerRef.current) {
        clearInterval(recTimerRef.current);
        recTimerRef.current = null;
      }
    }, []);

    useImperativeHandle(ref, () => ({
      startRecording: startRecordingInternal,
      stopRecording: stopRecordingInternal,
    }));

    useEffect(
      () => () => {
        if (recTimerRef.current) clearInterval(recTimerRef.current);
        if (recorderRef.current?.state !== "inactive")
          recorderRef.current?.stop();
      },
      [],
    );

    return (
      <div
        style={{
          position: "relative",
          borderRadius: 12,
          overflow: "hidden",
          border: "1px solid #E2E8F0",
          background: "#000",
        }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          style={{ width: "100%", display: "block" }}
        />
        <canvas
          ref={canvasRef}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
          }}
        />
        <canvas ref={captureCanvasRef} style={{ display: "none" }} />
        {lastResult?.motion?.detected && (
          <div
            style={{
              position: "absolute",
              top: 36,
              left: 8,
              padding: "4px 10px",
              borderRadius: 6,
              background: "#EF4444DD",
              color: "#fff",
              fontSize: 11,
              fontWeight: 700,
              pointerEvents: "none",
            }}
          >
            🔴 움직임 감지 ({lastResult.motion.boxes?.length || 0}개)
          </div>
        )}
      </div>
    );
  },
);
CameraView.displayName = "CameraView";
