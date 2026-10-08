import { useState } from "react";

import { api } from "./api";
import { useNow } from "./components";
import { OriginChip } from "./shell";
import { countdownLine, decidedSummary, pickCards, pickFailure, PICK_REASON_MAX, type PickCard } from "./raceLogic";
import { hrefFor } from "./route";
import { Link } from "./router";
import type { RaceView } from "./swarm";

// Mock mode has no POST actions (as in PushCode): the view renders, picking is disabled.
const MOCK = import.meta.env.VITE_MOCK_API === "1";

const na = (v: number | null, unit = "") => (v == null ? "n/a" : `${v}${unit}`);
const bytes = (n: number | null) => (n == null ? "n/a" : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

/**
 * The race box's Pick view (design §10.6): candidates side by side, the Queen's recommendation badged, a countdown to the auto-pick,
 * "Pick this one" with an optional reason, and the decided result. Renders nothing for a race that never needed a human.
 */
export function RacePick({ hive, view, now: nowProp, onChanged, showItem = false }: { hive: string; view: RaceView; now?: number; onChanged?: () => void; showItem?: boolean }) {
  const tick = useNow(1000);
  const now = nowProp ?? tick;
  const { race } = view;
  const decided = decidedSummary(race);
  const picking = race.state === "PICKING";
  if (!picking && !(decided && (decided.human || view.item?.judge === "human"))) return null;

  const cards = pickCards(view);
  const countdown = countdownLine(view, now);
  const rec = race.recommendedTrainId ? cards.find((c) => c.recommended) : undefined;
  return (
    <section className="panel rp" aria-label="Pick a candidate" data-race={race.raceId}>
      <p className="eyebrow">
        {picking ? "YOUR PICK" : "PICKED"}
        {showItem && view.item ? <> · <Link to={hrefFor.item(hive, view.item.itemId)}>{view.item.title}</Link></> : null}
      </p>
      {picking && (
        <p className="rp__count" role="timer">
          {countdown ?? "waiting for your pick"}
        </p>
      )}
      {picking && race.recommendReason && (
        <p className="sh-muted rp__why">
          Queen recommends {rec ? <b>{rec.model ?? rec.tag}</b> : "a candidate"}: {race.recommendReason}
        </p>
      )}
      {decided && (
        <p className="rp__decided" role="status">
          {decided.text}
          {decided.agreed != null && (decided.agreed ? " · agreed with the Queen's recommendation" : " · overrode the Queen's recommendation")}
          {race.reason ? <span className="sh-muted"> · {race.reason}</span> : null}
        </p>
      )}
      <ul className="rp__cards">
        {cards.map((c) => (
          <li key={c.trainId} className="rp__card-li">
            <Card hive={hive} raceId={race.raceId} c={c} picking={picking} onChanged={onChanged} />
          </li>
        ))}
      </ul>
      {cards.length === 0 && <p className="sh-muted">No candidate details yet.</p>}
    </section>
  );
}

function Card({ hive, raceId, c, picking, onChanged }: { hive: string; raceId: string; c: PickCard; picking: boolean; onChanged?: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.pickRace(hive, raceId, c.trainId, reason);
      setConfirm(false);
      onChanged?.();
    } catch (e) {
      const f = pickFailure(e);
      setErr(f.message);
      setConfirm(false);
      if (f.refresh) onChanged?.();
    } finally {
      setBusy(false);
    }
  };
  const cls = `rp__card${c.recommended ? " rp__card--rec" : ""}${c.winner ? " rp__card--winner" : ""}${c.rejectedReason || (!picking && !c.winner) ? " rp__card--out" : ""}`;
  return (
    <div className={cls}>
      <p className="rp__head">
        <b>{c.tag}</b> <span className="sh-muted">{c.model ?? "no model"}</span> <OriginChip badge={c.origin.kind === "drone" ? null : c.origin} />
        {c.recommended && <span className="chip chip--sm rp__rec" title="The Queen's own ranking">recommended</span>}
        {c.winner && <span className="chip chip--sm rp__won">picked</span>}
      </p>
      {c.previewUrl ? (
        <>
          {picking && c.pickable && <iframe className="rp__frame" src={c.previewUrl} title={`Preview of ${c.tag}`} loading="lazy" sandbox="allow-scripts allow-forms allow-popups" />}
          <a className="sh-link rp__link" href={c.previewUrl} target="_blank" rel="noreferrer">open preview ▸</a>
        </>
      ) : (
        <p className="sh-muted">preview n/a</p>
      )}
      <dl className="rp__stats">
        <div><dt>diff</dt><dd>{na(c.changedFiles)} files · {bytes(c.changedBytes)}</dd></div>
        <div><dt>gate checks</dt><dd>{na(c.checks)}</dd></div>
        <div><dt>reviewer</dt><dd>{c.satisfied == null ? "n/a" : `${c.satisfied} satisfied · ${c.missing ?? 0} missing`}{c.review ? ` (${c.review})` : ""}</dd></div>
      </dl>
      {c.notes && <p className="sh-muted rp__notes">{c.notes}</p>}
      {c.rejectedReason && <p className="sh-err">rejected: {c.rejectedReason}</p>}
      {picking && c.pickable && (
        confirm ? (
          <div className="rp__confirm">
            <input type="text" value={reason} maxLength={PICK_REASON_MAX} onChange={(e) => setReason(e.target.value)} placeholder="why this one? (optional)" aria-label={`Reason for picking ${c.tag}`} />
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void submit()}>{busy ? "Picking…" : "Confirm pick"}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        ) : (
          <button type="button" className="btn btn--primary" disabled={MOCK} title={MOCK ? "Mock mode: picking is not available" : undefined} onClick={() => setConfirm(true)}>Pick this one</button>
        )
      )}
      {MOCK && picking && c.pickable && <p className="sh-muted">Mock mode has no pick API.</p>}
      {err && <p className="sh-err" role="alert">{err}</p>}
    </div>
  );
}
