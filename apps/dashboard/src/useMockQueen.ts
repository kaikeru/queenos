import { useCallback, useEffect, type Dispatch } from "react";
import type { QueenClientMessage } from "@queenos/queen-types";
import { MockQueen, setActiveMockQueen } from "./mockQueen";
import type { Action } from "./reducer";

/** Drop-in for useQueenSocket in mock mode: a scripted Queen that emits two releases. */
export function useMockQueen(namespace: string, dispatch: Dispatch<Action>) {
  useEffect(() => {
    const q = new MockQueen(namespace, dispatch);
    setActiveMockQueen(q);
    q.start();
    return () => {
      q.stop();
      setActiveMockQueen(null);
    };
  }, [namespace, dispatch]);
  const send = useCallback(
    (message: QueenClientMessage) => {
      void message;
      dispatch({ type: "system", text: "Mock mode: prompts are not simulated; watch the scripted releases.", at: Date.now() });
      return true;
    },
    [dispatch],
  );
  return { status: "open" as const, latencyMs: 12, retryAt: null, send };
}
