import { useMemo, useRef, useState, type FormEvent } from "react";
import { GUARDRAIL_DEFAULTS, GUARDRAIL_MAX, RUNBOOK, type Escalation, type EscalationAction } from "@queenos/queen-types";
import { api, errorMessage } from "./api";
import { ACTION_LABEL, GUARDRAIL_FIELDS, escalationButtons, escalationSubjectLabel, goalPrompt, guardrailPatch, isExternal, parseGuardrail, reasonText, type ExternalJudgeChoice, type GuardrailKey } from "./homeLogic";
import { CandidateActions, RejectAll } from "./RacePick";
import { goalRows, pickingRows, raceChipClass, trackFresh, type GoalRow } from "./raceStatus";
import { prodUrlOf, releaseStrip } from "./releases";
import type { Room } from "./room";
import { Link } from "./router";
import { hrefFor } from "./route";
import type { State } from "./reducer";
import { openEscalations } from "./status";

/** One-line current-release row for the status home: phase timeline, who shipped it, prod link. */
export function ReleaseStripRow({ state }: { state: State }) {
  const strip = releaseStrip(state);
  if (!strip) return null;
  const { release, steps, shipper, prodUrl } = strip;
  return (
    <section className={`panel rstrip rstrip--${release.phase.toLowerCase()}`} aria-label="Current release">
      <div className="rstrip__top">
        <p className="eyebrow">RELEASE</p>
        <code>{release.headSha.slice(0, 7)}</code>
        <span className="rstrip__headline">{strip.headline}</span>
        {shipper && (
          <span className={`rstrip__who rstrip__who--${shipper.kind}`} title={`tapped by ${shipper.by}`}>
            {shipper.kind === "auto" ? "auto-shipped by the Queen" : `tapped by ${shipper.by}`}
          </span>
        )}
        {prodUrl && (
          <a className="rstrip__prod" href={prodUrl} target="_blank" rel="noreferrer" title={prodUrl}>prod ▸</a>
        )}
      </div>
      <ol className="rtl__steps rstrip__steps">
        {steps.map((s) => (
          <li key={s.key} className={`rstep rstep--${s.state}${s.percent ? " rstep--canary" : ""}`} aria-current={s.state === "now" ? "step" : undefined}>
            <i>{s.state === "done" ? "✓" : s.state === "bad" ? "✕" : ""}</i>
            <span>{s.label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Collapsed-by-default editor for the common guardrails (WIP limits). */
export function GuardrailsPanel({ hive, state }: { hive: string; state: State }) {
  const h = state.hive;
  const current = {
    maxChildrenPerItem: h?.settings.guardrails?.maxChildrenPerItem ?? GUARDRAIL_DEFAULTS.maxChildrenPerItem,
    maxActiveTrains: h?.settings.guardrails?.maxActiveTrains ?? GUARDRAIL_DEFAULTS.maxActiveTrains,
  };
  const [draft, setDraft] = useState<Record<GuardrailKey, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (!h) return null;
  const values = draft ?? { maxChildrenPerItem: String(current.maxChildrenPerItem), maxActiveTrains: String(current.maxActiveTrains) };
  const patch = guardrailPatch(current, values);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!patch) return;
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      await api.updateSettings(hive, patch);
      setDraft(null);
      setSaved(true);
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="panel sh-guard" aria-label="Guardrails">
      <summary>
        <span className="eyebrow">GUARDRAILS</span>
        <span className="sh-muted">{current.maxChildrenPerItem} children per item · {current.maxActiveTrains} active trains</span>
      </summary>
      <form className="sh-guard__form" onSubmit={(e) => void submit(e)}>
        {GUARDRAIL_FIELDS.map((f) => {
          const p = parseGuardrail(f.key, values[f.key]);
          return (
            <label key={f.key} className="sh-guard__field">
              <span>{f.label} <i className="sh-muted">{f.hint} (1 to {GUARDRAIL_MAX[f.key]})</i></span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={GUARDRAIL_MAX[f.key]}
                value={values[f.key]}
                aria-invalid={"error" in p}
                onChange={(e) => {
                  setSaved(false);
                  setDraft({ ...values, [f.key]: e.target.value });
                }}
              />
              {"error" in p && <i className="sh-err">{p.error}</i>}
            </label>
          );
        })}
        <button type="submit" className="btn" disabled={busy || !patch}>{busy ? "Saving…" : "Save"}</button>
        {saved && <span className="sh-ok">Saved</span>}
        {err && <span className="sh-err">{err}</span>}
      </form>
    </details>
  );
}

// ── add a goal ────────────────────────────────────────────────────────────

/** ADD A GOAL (spec §3.3): title plus intent / work spec; judge auto | you pick on external hives. Always files one decomposed goal. */
export function AddGoal({ hive, room }: { hive: string; room: Pick<Room, "state" | "status" | "send"> }) {
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState("");
  const [judge, setJudge] = useState<ExternalJudgeChoice>("auto");
  const [note, setNote] = useState<string | null>(null);
  const external = isExternal(room.state.hive);
  const disabled = room.status !== "open";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const ok = room.send({ type: "submit_prompt", prompt: goalPrompt(hive, title, spec, { external, judge }) });
    setNote(ok ? (external ? "Added. Agents can push to it now." : "Added. The Queen is splitting it into items.") : "Not linked to the Queen; nothing was sent.");
    if (ok) {
      setTitle("");
      setSpec("");
    }
  };
  return (
    <form className="panel home-composer" onSubmit={submit} aria-label="Add a goal">
      <p className="eyebrow">ADD A GOAL</p>
      {disabled && <p className="composer__hint">Waiting for the Queen link. Adding is disabled until it opens.</p>}
      <input className="home-composer__title" type="text" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="title" aria-label="Goal title" />
      <textarea
        value={spec}
        onChange={(e) => setSpec(e.target.value)}
        rows={4}
        placeholder="intent / work spec …"
        aria-label="Intent or work spec"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
        }}
      />
      <div className="home-composer__row">
        {external && (
          <fieldset className="home-composer__judge">
            <legend>judge</legend>
            <label><input type="radio" name="judge" checked={judge === "auto"} onChange={() => setJudge("auto")} /> auto</label>
            <label><input type="radio" name="judge" checked={judge === "pick"} onChange={() => setJudge("pick")} /> you pick</label>
          </fieldset>
        )}
        <span className="sh-spacer" />
        <button type="submit" className="btn btn--launch btn--launch-sm" disabled={disabled || !title.trim()}>Add goal</button>
      </div>
      {note && <p className="sh-muted" role="status">{note}</p>}
    </form>
  );
}

// ── needs you ─────────────────────────────────────────────────────────────

/** The empty Needs you state (spec §3.7). */
export function Bee() {
  return (
    <div className="needs__empty">
      <pre className="bee" aria-hidden="true">{"   \\_/\n-=(_'_)>\n   / \\"}</pre>
      <p><b>Nothing needs you.</b><br /><span className="sh-muted">The hive is buzzing.</span></p>
    </div>
  );
}

/** NEEDS YOU (spec §3.4): escalations plus every PICKING race with inline Pick / Reject / Reject all. Gold glow while a pick waits. */
export function NeedsYou({ hive, state, now }: { hive: string; state: State; now: number }) {
  const escalations = openEscalations(state);
  const picks = pickingRows(state, now);
  const count = escalations.length + picks.length;
  return (
    <section className={`panel needs${picks.length ? " needs--pending" : ""}`} aria-label="Needs you">
      <p className="eyebrow">{`NEEDS YOU${count ? ` (${count})` : ""}`}</p>
      {count === 0 ? (
        <Bee />
      ) : (
        <div className="needs__list">
          {picks.map((p) => (
            <article key={p.race.raceId} className="needs__race" data-race={p.race.raceId}>
              <p className="needs__race-head">
                <Link to={hrefFor.item(hive, p.item.itemId)}>{p.root.itemId === p.item.itemId ? p.item.title : `${p.root.title} · ${p.item.title}`}</Link>{" "}
                <span className={raceChipClass(p.status)}>{p.status.text}</span>
              </p>
              <ul className="needs__rows">
                {p.heads.map((h) => (
                  <li key={h.train.trainId} className="needs__row">
                    <span className="cand__who" title={h.origin.title}>{h.who}</span>
                    {h.claim && <span className="cand__claim sh-muted">{h.claim}</span>}
                    <span className="cand-chip cand-chip--passed">passed</span>
                    {h.previewUrl && <a className="cand__preview sh-link" href={h.previewUrl} target="_blank" rel="noreferrer">preview ▸</a>}
                    <CandidateActions hive={hive} raceId={p.race.raceId} trainId={h.train.trainId} tag={h.tag} compact />
                  </li>
                ))}
              </ul>
              <RejectAll hive={hive} raceId={p.race.raceId} />
            </article>
          ))}
          {escalations.map((e) => <EscalationCard key={e.escalationId} hive={hive} e={e} items={state.items} />)}
        </div>
      )}
    </section>
  );
}

/** One open escalation with its actions and runbook (moved from StatusHome). */
export function EscalationCard({ hive, e, items }: { hive: string; e: Escalation; items: State["items"] }) {
  const [busy, setBusy] = useState<EscalationAction | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<EscalationAction | null>(null);
  const [rb, setRb] = useState(false);
  const run = async (action: EscalationAction) => {
    setBusy(action);
    setErr(null);
    try {
      await api.resolveEscalation(hive, e.escalationId, { action });
      setDone(action);
    } catch (x) {
      setErr(errorMessage(x));
    } finally {
      setBusy(null);
    }
  };
  const runbook = RUNBOOK[e.reason];
  const subject =
    e.subject.type === "item" ? <Link to={hrefFor.item(hive, e.subject.id)}>{escalationSubjectLabel(e, items)}</Link> : <span>{escalationSubjectLabel(e, items)}</span>;
  return (
    <article className="sh-esc">
      <p className="sh-esc__title">
        <span aria-hidden="true">⚠</span> <b>{e.reason}</b> · {subject} · <span className="sh-muted">{reasonText(e.reason)}</span>
      </p>
      <p className="sh-esc__summary">{e.summary}</p>
      <div className="sh-esc__actions">
        {escalationButtons(e).map((b) => (
          <button
            key={b.action}
            type="button"
            className={`btn${b.primary ? " btn--primary" : ""}${b.danger ? " btn--danger" : ""}`}
            disabled={busy !== null || done !== null}
            onClick={() => void run(b.action)}
            title={runbook.actions[b.action]}
          >
            {busy === b.action ? "…" : b.label}
          </button>
        ))}
        <button type="button" className="sh-link" aria-expanded={rb} onClick={() => setRb((v) => !v)}>runbook {rb ? "▾" : "▸"}</button>
        {e.traceId && <Link className="sh-link" to={hrefFor.trace(hive, e.traceId)}>trace ▸</Link>}
      </div>
      {done && <p className="sh-ok">Sent: {ACTION_LABEL[done]}. Waiting for the Queen to confirm.</p>}
      {err && <p className="sh-err" role="alert">{err}</p>}
      {rb && (
        <dl className="sh-runbook">
          <dt>What happened</dt><dd>{runbook.what}</dd>
          <dt>What the Queen did</dt><dd>{runbook.did}</dd>
          {Object.entries(runbook.actions).map(([a, text]) => (
            <div key={a}><dt>{ACTION_LABEL[a as EscalationAction]}</dt><dd>{text}</dd></div>
          ))}
        </dl>
      )}
    </article>
  );
}

// ── goals ─────────────────────────────────────────────────────────────────

/** GOALS (spec §3.2): one card per root, active before done, newest first, with a race chip, a summary and agent tiles. */
export function GoalList({ hive, state, now }: { hive: string; state: State; now: number }) {
  const rows = useMemo(() => goalRows(state, now), [state, now]);
  // Motion marks state changes only: tiles and landings first seen after the page loaded.
  const memo = useRef({ seen: null as Set<string> | null, fresh: new Set<string>() });
  const fresh = trackFresh(memo.current, rows.flatMap((r) => [...r.tiles.flatMap((g) => g.tiles.map((t) => t.key)), `${r.root.itemId}:${r.status.kind}`]));
  const prod = prodUrlOf(state);
  if (!state.loaded) {
    return (
      <section className="panel goals" aria-label="Goals" aria-busy="true">
        <p className="eyebrow">GOALS</p>
        <div className="skel skel--row" />
        <div className="skel skel--row" />
        <div className="skel skel--row" />
      </section>
    );
  }
  return (
    <section className="panel goals" aria-label="Goals">
      <p className="eyebrow">{`GOALS${rows.length ? ` (${rows.length})` : ""}`}</p>
      {rows.length === 0 ? (
        <p className="sh-muted">{isExternal(state.hive) ? "Nothing yet. Add a goal, or have your agents push to goal/<slug> or item/<id>/<agent>." : "Nothing yet. Add a goal and the Queen splits it into items."}</p>
      ) : (
        <ul className="goals__list">
          {rows.map((r) => <GoalRowView key={r.root.itemId} hive={hive} row={r} fresh={fresh} prod={prod} />)}
        </ul>
      )}
    </section>
  );
}

function GoalRowView({ hive, row, fresh, prod }: { hive: string; row: GoalRow; fresh: ReadonlySet<string>; prod: string | null }) {
  const { root, status, summary, tiles } = row;
  const celebrate = status.kind === "landed" && fresh.has(`${root.itemId}:landed`);
  const winner = celebrate ? row.cards.flatMap((c) => c.heads).find((h) => h.status.kind === "won") : undefined;
  const cls = `goal-row goal-row--${status.tone}${row.done ? " goal-row--done" : ""}${celebrate ? " goal-row--celebrate" : ""}`;
  return (
    <li className={cls}>
      <Link className="goal-row__main" to={hrefFor.item(hive, root.itemId)}>
        <span className="goal-row__title">{root.title}</span>
        {row.followUp && <span className="chip chip--sm goal-row__follow">follow-up</span>}
        <span className={raceChipClass(status)}>{status.text}</span>
        {summary && <span className="goal-row__summary sh-muted">{summary}</span>}
      </Link>
      {tiles.length > 0 && (
        <span className="goal-row__tiles">
          {tiles.map((g) => (
            <span key={g.raceId} className={`atiles${g.lastMinute ? " atiles--last-minute" : ""}`} data-race={g.raceId}>
              {g.tiles.map((t) => (
                <span key={t.key} className={`atile atile--${t.kind}${t.filled ? " atile--filled" : ""}${fresh.has(t.key) ? " atile--changed" : ""}`} title={t.title} aria-label={t.title} />
              ))}
            </span>
          ))}
        </span>
      )}
      {celebrate && (
        <p className="celebrate-banner" role="status">
          <span className="celebrate-banner__crown" aria-hidden="true">♛</span> Landed{winner ? ` · ${winner.who}${winner.claim ? ` ${winner.claim}` : ""}` : ""}
          {prod && <> · <a href={prod} target="_blank" rel="noreferrer">prod ▸</a></>}
        </p>
      )}
    </li>
  );
}
