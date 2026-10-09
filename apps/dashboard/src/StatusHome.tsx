import { useMemo, useState, type FormEvent } from "react";
import { RUNBOOK, type Escalation, type EscalationAction } from "@queenos/queen-types";
import { api, errorMessage } from "./api";
import { SWARM_DEMO_SIZE, demoSwarmPrompt } from "./demo";
import { ACTION_LABEL, autonomyLabel, executorsMode, externalPrompt, isExternal, isSimulation, type ExternalJudgeChoice, compactNumber, durationText, escalationButtons, escalationSubjectLabel, meterFill, reasonText } from "./homeLogic";
import { MergeTrainStrip } from "./MergeGraph.tsx";
import { Link } from "./router";
import { hrefFor } from "./route";
import { ReleaseStripRow, GuardrailsPanel } from "./HomePanels";
import { HiveFooter, HiveHeader, ItemChip, OriginChip } from "./shell";
import { blockedOrFailed, goalTrees, headline, openEscalations, pipelineCounts, statusTiles, type GoalNode, type ItemRow } from "./status";
import { composerRace, YOU_PICK_WIDTH, type BestOfChoice } from "./raceLogic";
import { SwarmFloor } from "./SwarmFloor";
import type { Room } from "./WarRoom";

const SHOW_DEMO = import.meta.env.DEV || import.meta.env.VITE_MOCK_API === "1";

export function StatusHome({ hive, room }: { hive: string; room: Room }) {
  const { state, status, latencyMs } = room;
  const head = useMemo(() => headline(state), [state]);
  const tiles = useMemo(() => statusTiles(state), [state.hive]);
  const open = useMemo(() => openEscalations(state), [state.escalations, state.escalationOrder]);
  const trees = useMemo(() => goalTrees(state), [state]);
  const blocked = useMemo(() => blockedOrFailed(state), [state]);
  const counts = useMemo(() => pipelineCounts(state), [state.items, state.hive]);
  const external = isExternal(state.hive);

  return (
    <div className="app hive-page">
      {state.outdated && (
        <div className="update-banner" role="alert">
          <span>QueenOS was updated. Reload to get the latest dashboard</span>
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}
      <HiveHeader hive={hive} status={status} latencyMs={latencyMs} sim={isSimulation(state.hive)} actions={<><Link to={hrefFor.push(hive)} className="sh-link">push code ▸</Link><ExecutorsSelect hive={hive} state={room.state} /><AutonomySelect hive={hive} state={room.state} /></>} />

      <section className={`sh-head sh-head--${head.kind.toLowerCase()}`} aria-live="polite">
        <span className="sh-head__dot" aria-hidden="true" />
        <h2>{head.text}</h2>
      </section>

      <ReleaseStripRow hive={hive} state={state} />

      <Tiles tiles={tiles} />

      <GuardrailsPanel hive={hive} state={state} />

      {open.length > 0 && (
        <section className="panel sh-needs" aria-label="Needs you">
          <p className="eyebrow">NEEDS YOU ({open.length})</p>
          <div className="sh-needs__list">
            {open.map((e) => <EscalationCard key={e.escalationId} hive={hive} e={e} items={state.items} />)}
          </div>
        </section>
      )}

      {!external && <SwarmFloor state={state} hive={hive} />}
      <MergeTrainStrip state={state} hive={hive} />

      <section className="panel" aria-label="Goals">
        <p className="eyebrow">GOALS{trees.goals.length ? ` (${trees.goals.length})` : ""}</p>
        {trees.goals.length === 0 && trees.loose.length === 0 ? (
          <p className="sh-muted">{external ? "Nothing filed yet. File an item below, or have your agents push to goal/<slug> or item/<id>." : "Nothing filed yet. Describe goals below and the Queen splits them into items."}</p>
        ) : (
          <div className="sh-goals">
            {trees.goals.map((g, i) => <GoalTree key={g.item.itemId} hive={hive} node={g} open={i < 3} />)}
            {trees.loose.length > 0 && (
              <details className="sh-goal" open={trees.goals.length === 0}>
                <summary><b>Other items</b> <span className="sh-muted">{trees.loose.length}</span></summary>
                <ul className="sh-tree">
                  {trees.loose.slice(0, 15).map((n) => <Row key={n.item.itemId} hive={hive} row={n} />)}
                </ul>
              </details>
            )}
          </div>
        )}
      </section>

      <div className="sh-two">
        <section className="panel" aria-label="Throughput">
          <p className="eyebrow">THROUGHPUT (24H)</p>
          <Throughput tiles={tiles} counts={counts} />
        </section>
        <section className="panel" aria-label="Blocked or failed">
          <p className="eyebrow">BLOCKED / FAILED ({blocked.length})</p>
          {blocked.length === 0 ? (
            <p className="sh-muted">Nothing is stuck.</p>
          ) : (
            <ul className="sh-tree">
              {blocked.slice(0, 8).map((r) => <Row key={r.item.itemId} hive={hive} row={r} retry />)}
            </ul>
          )}
        </section>
      </div>

      {external ? <ExternalComposer hive={hive} room={room} /> : <Composer hive={hive} room={room} />}
      <HiveFooter hive={hive} />
    </div>
  );
}

// ── autonomy ──────────────────────────────────────────────────────────────

function AutonomySelect({ hive, state }: { hive: string; state: Room["state"] }) {
  const h = state.hive;
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!h) return null;
  const set = async (autonomy: "autonomous" | "supervised" | "paused") => {
    setBusy(true);
    setErr(null);
    try {
      await api.updateSettings(hive, { autonomy });
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const degraded = h.effectiveAutonomy !== h.settings.autonomy;
  return (
    <label className={`sh-auto${degraded ? " sh-auto--degraded" : ""}`} title={err ?? "Autonomy level"}>
      <span>{autonomyLabel(h)}</span>
      <select value={h.settings.autonomy} disabled={busy} onChange={(e) => void set(e.target.value as "autonomous" | "supervised" | "paused")} aria-label="Autonomy">
        <option value="autonomous">autonomous</option>
        <option value="supervised">supervised</option>
        <option value="paused">paused</option>
      </select>
      {err && <i className="sh-auto__err">{err}</i>}
    </label>
  );
}

function ExecutorsSelect({ hive, state }: { hive: string; state: Room["state"] }) {
  const h = state.hive;
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!h) return null;
  const set = async (executors: "swarm" | "external") => {
    setBusy(true);
    setErr(null);
    try {
      await api.updateSettings(hive, { executors });
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="sh-auto" title={err ?? "Who builds: the Queen's swarm, or your own coding agents pushing over git"}>
      <span>workers</span>
      <select value={executorsMode(h)} disabled={busy} onChange={(e) => void set(e.target.value as "swarm" | "external")} aria-label="Workers">
        <option value="swarm">swarm</option>
        <option value="external">external agents</option>
      </select>
      {err && <i className="sh-auto__err">{err}</i>}
    </label>
  );
}

// ── tiles ─────────────────────────────────────────────────────────────────

function Meter({ label, fill, text, tone }: { label: string; fill: number; text: string; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div className="sh-tile">
      <p className="sh-tile__label">{label}</p>
      <div className={`sh-meter sh-meter--${tone ?? "ok"}`} role="meter" aria-label={label} aria-valuenow={Math.round(fill * 100)} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${fill * 100}%` }} />
      </div>
      <p className="sh-tile__text">{text}</p>
    </div>
  );
}

function Tiles({ tiles }: { tiles: ReturnType<typeof statusTiles> }) {
  const { slots, errorBudget, credits } = tiles;
  if (!slots && !errorBudget && !credits) return null;
  return (
    <div className="sh-tiles">
      {slots && <Meter label="Slots" fill={meterFill(slots.used, slots.total)} text={`${slots.used}/${slots.total} (lease ${slots.leased})`} tone={slots.used >= slots.total ? "warn" : "ok"} />}
      {errorBudget && (
        <Meter
          label="Error budget"
          fill={meterFill(Math.max(0, errorBudget.remaining), errorBudget.total)}
          text={errorBudget.exhausted ? "exhausted" : `${errorBudget.remaining} of ${errorBudget.total} left`}
          tone={errorBudget.exhausted ? "bad" : errorBudget.remaining <= 1 ? "warn" : "ok"}
        />
      )}
      {credits && (
        <Meter
          label="Credits today"
          fill={meterFill(credits.used, credits.limit)}
          text={`${compactNumber(credits.used)}/${compactNumber(credits.limit)}`}
          tone={credits.used >= credits.limit ? "bad" : credits.used / (credits.limit || 1) > 0.8 ? "warn" : "ok"}
        />
      )}
    </div>
  );
}

function Throughput({ tiles, counts }: { tiles: ReturnType<typeof statusTiles>; counts: ReturnType<typeof pipelineCounts> }) {
  const t = tiles.throughput;
  const c = tiles.concurrency;
  if (!t) return <p className="sh-muted">Waiting for the Queen's status.</p>;
  return (
    <>
      <dl className="sh-kv">
        <div><dt>landed</dt><dd>{t.landed24h}</dd></div>
        <div><dt>shipped</dt><dd>{t.shipped24h}</dd></div>
        <div><dt>lead p50</dt><dd>{durationText(t.leadTimeP50Ms)}</dd></div>
        <div><dt>first-try</dt><dd>{t.firstTryPassRate == null ? "–" : `${Math.round(t.firstTryPassRate * 100)}%`}</dd></div>
        {c && <div><dt>conflicts</dt><dd>{c.conflicts24h}</dd></div>}
        {c && <div><dt>bisects</dt><dd>{c.bisects24h}</dd></div>}
      </dl>
      <p className="sh-pipe">
        {(["READY", "ACTIVE", "BLOCKED", "LANDED", "SHIPPED", "FAILED"] as const).map((s) => (
          <span key={s}><b>{counts[s]}</b> {s.toLowerCase()}</span>
        ))}
      </p>
    </>
  );
}

// ── needs you ─────────────────────────────────────────────────────────────

function EscalationCard({ hive, e, items }: { hive: string; e: Escalation; items: Room["state"]["items"] }) {
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

function rowNote(r: ItemRow): string | null {
  if (r.race && r.subState === "racing") {
    const d = r.race.decidingInMs;
    return `racing best-of-${r.race.race.width} · ${r.race.passed} passed${d != null ? `, deciding ${Math.ceil(d / 1000)}s` : ""}`;
  }
  if (r.item.status === "SHIPPED") return `${durationText(r.item.updatedAt - r.item.createdAt)} lead time`;
  return r.note;
}

/** A row. `bare` renders a div for use inside an existing `<li>` (the tree node supplies the item). */
function Row({ hive, row, retry, bare }: { hive: string; row: ItemRow; retry?: boolean; bare?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (action: "retry" | "cancel") => {
    setBusy(true);
    setErr(null);
    try {
      await api.itemAction(hive, row.item.itemId, { action });
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const note = rowNote(row);
  const Tag = bare ? "div" : "li";
  return (
    <Tag className="sh-row">
      <span className={`sh-kind sh-kind--${row.item.kind}`}>{row.item.kind}</span>
      <Link className="sh-row__title" to={hrefFor.item(hive, row.item.itemId)}>{row.item.title}</Link>
      <ItemChip status={row.item.status} sub={row.subState} />
      <OriginChip badge={row.origin} />
      {note && <span className="sh-row__note">{note}</span>}
      {retry && row.item.status === "FAILED" && (
        <button type="button" className="sh-link" disabled={busy} onClick={() => void act("retry")}>{busy ? "…" : "retry ▸"}</button>
      )}
      {err && <span className="sh-err">{err}</span>}
    </Tag>
  );
}

function TreeNodes({ hive, nodes }: { hive: string; nodes: GoalNode[] }) {
  return (
    <ul className="sh-tree">
      {nodes.map((n) => (
        <li key={n.item.itemId} className="sh-tree__node">
          <Row hive={hive} row={n} bare />
          {n.children.length > 0 && <TreeNodes hive={hive} nodes={n.children} />}
        </li>
      ))}
    </ul>
  );
}

function GoalTree({ hive, node, open }: { hive: string; node: GoalNode; open: boolean }) {
  return (
    <details className="sh-goal" open={open}>
      <summary>
        <span aria-hidden="true">◆</span> <b>{node.item.title}</b>{" "}
        <span className="sh-muted">{node.total} items · {node.landed} landed · {node.shipped} shipped</span>{" "}
        <ItemChip status={node.item.status} />
      </summary>
      {node.children.length > 0 && <TreeNodes hive={hive} nodes={node.children} />}
      <Link className="sh-link" to={hrefFor.item(hive, node.item.itemId)}>open goal ▸</Link>
    </details>
  );
}

// ── composer ──────────────────────────────────────────────────────────────

function Composer({ hive, room }: { hive: string; room: Room }) {
  const [text, setText] = useState("");
  const [split, setSplit] = useState(true);
  const [bestOf, setBestOf] = useState<BestOfChoice>("auto");
  const [note, setNote] = useState<string | null>(null);
  const disabled = room.status !== "open";
  const send = (promptText: string, decompose: boolean, race: { bestOf?: number; judge?: "human" }): boolean =>
    room.send({ type: "submit_prompt", prompt: { namespace: hive, promptText, decompose, ...race } });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    const ok = send(t, split, composerRace(bestOf));
    setNote(ok ? (split ? "Sent. The Queen is splitting it into items." : "Sent.") : "Not linked to the Queen; nothing was sent.");
    if (ok) setText("");
  };
  const swarm = () => {
    const ok = send(demoSwarmPrompt(SWARM_DEMO_SIZE), true, {});
    setNote(ok ? `Swarm demo sent: ${SWARM_DEMO_SIZE} items.` : "Not linked to the Queen; nothing was sent.");
  };
  return (
    <form className="panel sh-composer" onSubmit={submit} aria-label="Composer">
      <p className="eyebrow">COMPOSER</p>
      {disabled && <p className="composer__hint">Waiting for the Queen link. Sending is disabled until it opens.</p>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="Describe the goals…  one per line works well"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
        }}
      />
      <div className="sh-composer__row">
        <label className="sh-check"><input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} /> split into items</label>
        <label className="sh-check">
          best-of{" "}
          <select value={bestOf} onChange={(e) => setBestOf(e.target.value as typeof bestOf)}>
            <option value="auto">auto</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={String(n)}>{n}</option>)}
            <option value="pick">you pick ({YOU_PICK_WIDTH})</option>
          </select>
        </label>
        <span className="sh-spacer" />
        {SHOW_DEMO && (
          <button type="button" className="btn btn--swarm sh-swarm" disabled={disabled} onClick={swarm} title={`Files one goal that splits into ${SWARM_DEMO_SIZE} items`}>
            Swarm demo ({SWARM_DEMO_SIZE})
          </button>
        )}
        <button type="submit" className="btn btn--primary" disabled={disabled || !text.trim()}>Send to Queen</button>
      </div>
      {note && <p className="sh-muted" role="status">{note}</p>}
    </form>
  );
}

/** External-agents composer: files one item (a goal with a single inbox item) for coding agents that push over git. */
function ExternalComposer({ hive, room }: { hive: string; room: Room }) {
  const [text, setText] = useState("");
  const [judge, setJudge] = useState<ExternalJudgeChoice>("auto");
  const [note, setNote] = useState<string | null>(null);
  const disabled = room.status !== "open";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    const ok = room.send({ type: "submit_prompt", prompt: externalPrompt(hive, t, judge) });
    setNote(ok ? "Filed. Agents can now push to it." : "Not linked to the Queen; nothing was sent.");
    if (ok) setText("");
  };
  return (
    <form className="panel sh-composer" onSubmit={submit} aria-label="Composer">
      <p className="eyebrow">FILE AN ITEM FOR AGENTS</p>
      {disabled && <p className="composer__hint">Waiting for the Queen link. Sending is disabled until it opens.</p>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="Describe the work for your coding agents…"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
        }}
      />
      <p className="sh-muted">Agents push to <code>item/&lt;id&gt;</code> (join this item) or <code>goal/&lt;slug&gt;</code> (a goal with one item). No Queen swarm builds it.</p>
      <div className="sh-composer__row">
        <label className="sh-check">
          judge{" "}
          <select value={judge} onChange={(e) => setJudge(e.target.value as ExternalJudgeChoice)} aria-label="Judge">
            <option value="auto">auto</option>
            <option value="pick">you pick</option>
          </select>
        </label>
        <span className="sh-spacer" />
        <button type="submit" className="btn btn--primary" disabled={disabled || !text.trim()}>File item</button>
      </div>
      {note && <p className="sh-muted" role="status">{note}</p>}
    </form>
  );
}
