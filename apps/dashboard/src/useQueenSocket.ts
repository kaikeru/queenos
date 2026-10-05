import { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import { QueenClientMessageSchema, QueenServerMessageSchema, type QueenClientMessage } from "@queenos/queen-types";
import { isUnknownFrameType, type Action } from "./reducer";

export type ConnStatus = "connecting" | "open" | "reconnecting";

const PING_MS = 15_000;
const PONG_TIMEOUT_MS = 10_000;

/** ws(s) URL of the hive's War Room socket. */
export function roomUrl(namespace: string): string {
  const base = import.meta.env.VITE_QUEEN_URL || window.location.origin;
  const url = new URL(`/hives/${encodeURIComponent(namespace)}/room`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function backoffMs(attempt: number): number {
  const base = Math.min(8000, 500 * 2 ** attempt);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

/**
 * Connects to the Queen, validates every frame with QueenServerMessageSchema and
 * feeds the reducer. Reconnects with backoff; the Queen sends a fresh snapshot on
 * every connect, so reconnecting needs no replay logic.
 */
export function useQueenSocket(namespace: string, dispatch: Dispatch<Action>) {
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stopped = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let lastPing = 0;
    let lastPong = 0;

    const connect = () => {
      setStatus(attempt === 0 ? "connecting" : "reconnecting");
      const ws = new WebSocket(roomUrl(namespace));
      wsRef.current = ws;

      ws.onopen = () => {
        if (attempt > 0) dispatch({ type: "system", text: "Reconnected to the Queen.", at: Date.now() });
        attempt = 0;
        setRetryAt(null);
        setStatus("open");
        lastPing = 0;
        lastPong = 0;
        pingTimer = setInterval(() => {
          if (lastPing > lastPong && Date.now() - lastPing > PONG_TIMEOUT_MS) {
            ws.close(); // half-open socket: no pong; fall into the reconnect path
            return;
          }
          lastPing = Date.now();
          // The literal "ping" is auto-answered by the runtime without waking the DO.
          if (ws.readyState === WebSocket.OPEN) ws.send("ping");
        }, PING_MS);
      };

      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== "string") return;
        if (ev.data === "pong") {
          lastPong = Date.now();
          if (lastPing) setLatencyMs(lastPong - lastPing);
          return;
        }
        let json: unknown;
        try {
          json = JSON.parse(ev.data);
        } catch {
          dispatch({ type: "invalid_frame", detail: "not JSON", at: Date.now() });
          return;
        }
        const parsed = QueenServerMessageSchema.safeParse(json);
        if (!parsed.success) {
          console.warn("war-room: invalid frame", parsed.error.issues);
          dispatch({
            type: "invalid_frame",
            detail: parsed.error.issues[0]?.message ?? "schema mismatch",
            at: Date.now(),
            ...(isUnknownFrameType(parsed.error.issues, json) ? { outdated: true } : {}),
          });
          return;
        }
        dispatch({ type: "server", message: parsed.data, at: Date.now() });
      };

      ws.onclose = () => {
        clearInterval(pingTimer);
        if (stopped) return;
        if (attempt === 0) dispatch({ type: "system", text: "Lost the Queen. Reconnecting...", at: Date.now() });
        const delay = backoffMs(attempt++);
        setStatus("reconnecting");
        setRetryAt(Date.now() + delay);
        retryTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.close();
      }
      wsRef.current = null;
    };
  }, [namespace, dispatch]);

  const send = useCallback((message: QueenClientMessage): boolean => {
    const ws = wsRef.current;
    const parsed = QueenClientMessageSchema.safeParse(message);
    if (!parsed.success || !ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(parsed.data));
    return true;
  }, []);

  return { status, latencyMs, retryAt, send };
}
