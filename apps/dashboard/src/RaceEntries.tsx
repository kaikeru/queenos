import { useState } from "react";

import { api } from "./api";
import { useNow } from "./components";
import { closeEntriesFailure, entriesLine, entryState, reworkLines } from "./raceLogic";
import type { RaceView } from "./swarm";

// Mock mode has no POST actions (as in RacePick): the box renders, ending entries is disabled.
const MOCK = import.meta.env.VITE_MOCK_API === "1";

/**
 * External hives keep a git-pushed race open to entries for a window. Shows the live countdown and "End entries now" while the
 * window is open, and "Entries closed · deciding…" once it has passed. In the rework loop it also shows each REWORK candidate's or the REWORKING winner's due time. Renders nothing for swarm races or races past RACING.
 */
export function RaceEntries({ hive, view, now: nowProp, onChanged }: { hive: string; view: RaceView; now?: number; onChanged?: () => void }) {
  const tick = useNow(1000);
  const now = nowProp ?? tick;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { race } = view;
  const state = entryState(race, now);
  const lines = reworkLines(view, now);
  if (!state && !lines.length) return null;
  const end = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.closeRaceEntries(hive, race.raceId);
      onChanged?.();
    } catch (e) {
      const f = closeEntriesFailure(e);
      setErr(f.message);
      if (f.refresh) onChanged?.();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel rp re" aria-label="Race entries" data-race={race.raceId}>
      <p className="eyebrow">{race.state === "REWORKING" ? "REWORK" : "RACE ENTRIES"}</p>
      {state && <p className="rp__count" role="timer">{entriesLine(race, view.candidates.length, now)}</p>}
      {lines.map((l) => (
        <p key={l} className="sh-muted rp__rework" role="status">{l}</p>
      ))}
      {state?.kind === "open" && (
        <div>
          <button type="button" className="btn btn--primary" disabled={busy || MOCK} title={MOCK ? "Mock mode: not available" : undefined} onClick={() => void end()}>
            {busy ? "Ending…" : "End entries now"}
          </button>
        </div>
      )}
      {err && <p className="sh-err" role="alert">{err}</p>}
    </section>
  );
}
