/* 실시간 카메라 뷰
   - 카메라 원본 영상 항상 표시 (검정 화면 깜빡임 해결)
   - 감지 박스 캔버스 오버레이
   - 현재 시각 표시
   - 녹화 기능 (MediaRecorder → WebM)
*/

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
  lastResult: FrameResult | null;
  onRecordingComplete?: (blob: Blob, duration: number) => void;
}

export interface CameraViewHandle {
  getVideo: () => HTMLVideoElement | null;
  startRecording: () => void;
  stopRecording: () => void;
  isRecording: boolean;
}

export const CameraView = forwardRef<CameraViewHandle, Props>(
  ({ lastResult, onRecordingComplete }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const [recording, setRecording] = useState(false);
    const [currentTime, setCurrentTime] = useState("");
    const [recDuration, setRecDuration] = useState(0);
    const recStartRef = useRef(0);
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

    // 감지 박스 + 시각 오버레이 그리기
    useEffect(() => {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) return;

      const rect = video.getBoundingClientRect();
      if (rect.width === 0) return;
      canvas.width = rect.width;
      canvas.height = rect.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // 시각 표시
      ctx.font = "bold 14px monospace";
      const timeText = currentTime;
      ctx.fillStyle = "#00000080";
      ctx.fillRect(8, 8, ctx.measureText(timeText).width + 16, 26);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(timeText, 16, 27);

      // 녹화 표시
      if (recording) {
        const m = Math.floor(recDuration / 60);
        const s = (recDuration % 60).toString().padStart(2, "0");
        const recText = `● REC ${m}:${s}`;
        ctx.font = "bold 13px sans-serif";
        const tw = ctx.measureText(recText).width;
        ctx.fillStyle = "#EF444490";
        ctx.fillRect(canvas.width - tw - 24, 8, tw + 16, 24);
        ctx.fillStyle = "#fff";
        ctx.fillText(recText, canvas.width - tw - 16, 25);
      }

      // 감지 박스
      const boxes = lastResult?.motion?.boxes || [];
      const detected = lastResult?.motion?.detected || false;
      const risk = lastResult?.motion?.risk_score || 0;

      if (detected && boxes.length > 0) {
        const vw = video.videoWidth || 640;
        const vh = video.videoHeight || 480;
        const scaleX = rect.width / vw;
        const scaleY = rect.height / vh;
        const color = risk > 70 ? "#EF4444" : risk > 40 ? "#F59E0B" : "#22C55E";

        boxes.forEach((box: any) => {
          const x = (box.x || 0) * scaleX;
          const y = (box.y || 0) * scaleY;
          const w = (box.w || box.width || 0) * scaleX;
          const h = (box.h || box.height || 0) * scaleY;

          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.strokeRect(x, y, w, h);
          ctx.fillStyle = color + "20";
          ctx.fillRect(x, y, w, h);

          ctx.font = "bold 10px sans-serif";
          const label = `${(box.area || 0).toLocaleString()}px`;
          const lw = ctx.measureText(label).width;
          ctx.fillStyle = color;
          ctx.fillRect(x, y - 16, lw + 8, 16);
          ctx.fillStyle = "#fff";
          ctx.fillText(label, x + 4, y - 4);
        });

        // 하단 정보 바
        const motionPx = lastResult?.motion?.total_motion_pixels || 0;
        const info = `모션: ${motionPx.toLocaleString()}px | 위험도: ${risk.toFixed(0)} | ${boxes.length}개 영역`;
        ctx.font = "bold 12px sans-serif";
        const iw = ctx.measureText(info).width;
        ctx.fillStyle = color + "CC";
        ctx.fillRect(8, canvas.height - 32, iw + 16, 26);
        ctx.fillStyle = "#fff";
        ctx.fillText(info, 16, canvas.height - 14);
      }
    }, [lastResult, currentTime, recording, recDuration]);

    // 녹화 시작
    const startRecording = useCallback(() => {
      const video = videoRef.current;
      if (!video || !video.srcObject) return;
      const stream = video.srcObject as MediaStream;
      chunksRef.current = [];
      try {
        const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
          ? "video/webm;codecs=vp9"
          : "video/webm";
        const recorder = new MediaRecorder(stream, { mimeType });
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: "video/webm" });
          const dur = Math.floor((Date.now() - recStartRef.current) / 1000);
          if (onRecordingComplete) onRecordingComplete(blob, dur);
        };
        recorder.start(1000);
        recorderRef.current = recorder;
        recStartRef.current = Date.now();
        setRecording(true);
        setRecDuration(0);
        recTimerRef.current = setInterval(
          () =>
            setRecDuration(
              Math.floor((Date.now() - recStartRef.current) / 1000),
            ),
          1000,
        );
      } catch (e) {
        console.error("녹화 실패:", e);
      }
    }, [onRecordingComplete]);

    // 녹화 중지
    const stopRecording = useCallback(() => {
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
      getVideo: () => videoRef.current,
      startRecording,
      stopRecording,
      isRecording: recording,
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
      </div>
    );
  },
);

CameraView.displayName = "CameraView";
