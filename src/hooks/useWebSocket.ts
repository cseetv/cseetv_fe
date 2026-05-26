/* WebSocket 연결/메시지/재연결 관리 */

import { useRef, useState, useCallback, useEffect } from "react";
import type { WsMessage } from "../types";

type WsStatus = "disconnected" | "connecting" | "connected" | "error";
type MessageHandler = (data: WsMessage) => void;
type BinaryHandler = (blob: Blob) => void;

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8000";

export function useWebSocket(
  onMessage: MessageHandler,
  onBinary: BinaryHandler,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const statusRef = useRef<WsStatus>("disconnected");
  const [status, setStatus] = useState<WsStatus>("disconnected");
  const retriesRef = useRef(0);
  const maxRetries = 5;

  const updateStatus = (s: WsStatus) => {
    statusRef.current = s;
    setStatus(s);
  };

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    updateStatus("connecting");
    const ws = new WebSocket(`${WS_URL}/ws/stream`);
    ws.binaryType = "blob";

    ws.onopen = () => {
      updateStatus("connected");
      retriesRef.current = 0;
    };

    ws.onmessage = (event) => {
      if (event.data instanceof Blob) {
        onBinary(event.data);
      } else {
        try {
          const msg: WsMessage = JSON.parse(event.data);
          onMessage(msg);
        } catch {
          /* ignore */
        }
      }
    };

    ws.onclose = () => {
      updateStatus("disconnected");
      wsRef.current = null;
      if (retriesRef.current < maxRetries) {
        retriesRef.current++;
        setTimeout(connect, 3000);
      }
    };

    ws.onerror = () => {
      updateStatus("error");
    };

    wsRef.current = ws;
  }, [onMessage, onBinary]);

  const disconnect = useCallback(() => {
    retriesRef.current = maxRetries;
    wsRef.current?.close();
    wsRef.current = null;
    updateStatus("disconnected");
  }, []);

  const sendJson = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const sendBinary = useCallback((data: Blob | ArrayBuffer) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
    }
  }, []);

  /** 연결될 때까지 대기 후 전송 (ref 기반이라 클로저 문제 없음) */
  const waitAndSend = useCallback((msg: object, maxWait = 8000) => {
    const start = Date.now();
    const check = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(msg));
        console.log("[WS] 메시지 전송:", msg);
        return;
      }
      if (Date.now() - start < maxWait) {
        setTimeout(check, 200);
      } else {
        console.warn("[WS] 전송 타임아웃:", msg);
      }
    };
    check();
  }, []);

  useEffect(() => {
    return () => {
      retriesRef.current = maxRetries;
      wsRef.current?.close();
    };
  }, []);

  return { status, connect, disconnect, sendJson, sendBinary, waitAndSend };
}
