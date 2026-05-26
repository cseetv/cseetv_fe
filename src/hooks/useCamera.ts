/* 브라우저 카메라 제어 (getUserMedia) */

import { useRef, useState, useCallback } from "react";

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("environment");

  const start = useCallback(async (videoEl: HTMLVideoElement) => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      videoEl.srcObject = stream;
      await videoEl.play();
      videoRef.current = videoEl;
      streamRef.current = stream;
      setActive(true);

      // 캡처용 캔버스
      if (!canvasRef.current) {
        canvasRef.current = document.createElement("canvas");
      }
    } catch (e) {
      setError("카메라 접근 권한이 필요합니다.");
      setActive(false);
    }
  }, [facingMode]);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setActive(false);
  }, []);

  const captureFrame = useCallback((): Blob | null => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !active) return null;

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // 동기적으로 Blob을 만들 수 없으므로 base64로 반환
    return null; // captureFrameAsync 사용
  }, [active]);

  const captureFrameAsync = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || !active) { resolve(null); return; }

      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(null); return; }

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.7);
    });
  }, [active]);

  const toggleFacing = useCallback(() => {
    const next = facingMode === "user" ? "environment" : "user";
    setFacingMode(next);
    // 카메라가 켜져 있으면 재시작
    if (active && videoRef.current) {
      stop();
      setTimeout(() => {
        if (videoRef.current) start(videoRef.current);
      }, 300);
    }
  }, [facingMode, active, stop, start]);

  return { active, error, start, stop, captureFrameAsync, toggleFacing, facingMode };
}
