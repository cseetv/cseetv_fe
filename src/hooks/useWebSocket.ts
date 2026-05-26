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
  const [status, setStatus] = useState<WsStatus>("disconnected");
  const retriesRef = useRef(0);
  const maxRetries = 5;

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setStatus("connecting");
    const ws = new WebSocket(`${WS_URL}/ws/stream`);
    ws.binaryType = "blob";

    ws.onopen = () => {
      setStatus("connected");
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
          /* ignore parse errors */
        }
      }
    };

    ws.onclose = () => {
      setStatus("disconnected");
      wsRef.current = null;

      // 자동 재연결
      if (retriesRef.current < maxRetries) {
        retriesRef.current++;
        setTimeout(connect, 3000);
      }
    };

    ws.onerror = () => {
      setStatus("error");
    };

    wsRef.current = ws;
  }, [onMessage, onBinary]);

  const disconnect = useCallback(() => {
    retriesRef.current = maxRetries; // 재연결 방지
    wsRef.current?.close();
    wsRef.current = null;
    setStatus("disconnected");
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

  // 언마운트 시 정리
  useEffect(() => {
    return () => {
      retriesRef.current = maxRetries;
      wsRef.current?.close();
    };
  }, []);

  return { status, connect, disconnect, sendJson, sendBinary };
}
