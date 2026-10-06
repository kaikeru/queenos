import { withRetry } from "./retry";
import { useCallback, useEffect, useRef, useState } from "react";

export interface Resource<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/** Load once per `key` (and on reload()). Stale responses are dropped. 5xx and network errors are retried with backoff (3 tries). */
export function useResource<T>(load: () => Promise<T>, key: string): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let live = true;
    setLoading(true);
    withRetry(() => loadRef.current(), { cancelled: () => !live }).then(
      (d) => {
        if (!live) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (!live) return;
        setError(e);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** Run `onKey` on Escape while mounted. */
export function useEscape(onEscape: () => void, enabled = true): void {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") ref.current();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [enabled]);
}

/** A boolean kept in localStorage (per-viewer convenience). Falls back to in-memory when storage is blocked. */
export function usePersistedBool(key: string, initial: boolean): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : raw === "1";
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setValue((prev) => {
        const v = typeof next === "function" ? next(prev) : next;
        try {
          window.localStorage.setItem(key, v ? "1" : "0");
        } catch {
          /* storage blocked: keep the in-memory value */
        }
        return v;
      });
    },
    [key],
  );
  return [value, set];
}
