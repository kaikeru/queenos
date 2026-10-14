import { useMemo, useState } from "react";
import { api, errorMessage } from "./api";
import { useNow } from "./components";
import { autonomyLabel, compactNumber, durationText, executorsMode, isExternal, isSimulation, meterFill } from "./homeLogic";
import { MergeTreePanel } from "./MergeGraph.tsx";
import { Link } from "./router";
import { hrefFor } from "./route";
import { AddGoal, GoalList, GuardrailsPanel, NeedsYou, ReleaseStripRow } from "./HomePanels";
import { homeHeadline } from "./raceStatus";
import type { Room } from "./room";
import { HiveFooter, HiveHeader, ItemChip, OriginChip } from "./shell";
import { blockedOrFailed, pipelineCounts, statusTiles, type ItemRow } from "./status";
import { SwarmFloor } from "./SwarmFloor";

/**
 * The hive home (dashboard redesign §3.2): headline, ADD A GOAL beside NEEDS YOU, the MERGE TREE, the GOALS list and a
 * collapsed HIVE HEALTH. Every race label comes from raceStatus.ts.
 */
export function StatusHome({ hive, room }: { hive: string; room: Room }) {
  const { state, status, latencyMs } = room;
  const now = useNow(1000);
  const head = useMemo(() => homeHeadline(state), [state]);
  const external = isExternal(state.hive);

  return (
    <div className="app hive-page">
      {state.outdated && (
        <div className="update-banner" role="alert">
          <span>QueenOS was updated. Reload to get the latest dashboard</span>
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}
      <HiveHeader hive={hive} status={status} latencyMs={latencyMs} sim={isSimulation(state.hive)} actions={<><ExecutorsSelect hive={hive} state={state} /><AutonomySelect hive={hive} state={state} /><Link to={hrefFor.push(hive)} className="sh-link">push code ▸</Link></>} />

      <section className={`sh-head sh-hero sh-hero--${head.mood}`} aria-live="polite">
        <span className="sh-head__dot sh-hero__dot" aria-hidden="true" />
        <h2>{head.text}</h2>
      </section>

      <div className="home-top">
        <AddGoal hive={hive} room={room} />
        <NeedsYou hive={hive} state={state} now={now} />
      </div>

      <MergeTreePanel state={state} hive={hive} />

      <GoalList hive={hive} state={state} now={now} />

      <HiveHealth hive={hive} state={state} external={external} />

      <HiveFooter hive={hive} />
    </div>
  );
}

/** HIVE HEALTH, collapsed (spec §3.2 item 5): release strip, tiles, guardrails, throughput, blocked / failed, swarm floor. */
function HiveHealth({ hive, state, external }: { hive: string; state: Room["state"]; external: boolean }) {
  const tiles = useMemo(() => statusTiles(state), [state.hive]);
  const blocked = useMemo(() => blockedOrFailed(state), [state]);
  const counts = useMemo(() => pipelineCounts(state), [state.items, state.hive]);
  return (
    <details className="panel health" aria-label="Hive health">
      <summary><span className="eyebrow">HIVE HEALTH</span> <span className="sh-muted">release, budget, guardrails, throughput{blocked.length ? `, ${blocked.length} blocked or failed` : ""}</span></summary>
      <div className="health__body">
        <ReleaseStripRow state={state} />
        <Tiles tiles={tiles} />
        <GuardrailsPanel hive={hive} state={state} />
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
        {!external && <SwarmFloor state={state} hive={hive} />}
      </div>
    </details>
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

// ── blocked / failed rows ─────────────────────────────────────────────────

function rowNote(r: ItemRow): string | null {
  if (r.race && r.subState === "racing") {
    const d = r.race.decidingInMs;
    return `racing best-of-${r.race.race.width} · ${r.race.passed} passed${d != null ? `, deciding ${Math.ceil(d / 1000)}s` : ""}`;
  }
  if (r.item.status === "SHIPPED") return `${durationText(r.item.updatedAt - r.item.createdAt)} lead time`;
  return r.note;
}

/** A blocked or failed item, with retry for FAILED ones. */
function Row({ hive, row, retry }: { hive: string; row: ItemRow; retry?: boolean }) {
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
  return (
    <li className="sh-row">
      <span className={`sh-kind sh-kind--${row.item.kind}`}>{row.item.kind}</span>
      <Link className="sh-row__title" to={hrefFor.item(hive, row.item.itemId)}>{row.item.title}</Link>
      <ItemChip status={row.item.status} sub={row.subState} />
      <OriginChip badge={row.origin} />
      {note && <span className="sh-row__note">{note}</span>}
      {retry && row.item.status === "FAILED" && (
        <button type="button" className="sh-link" disabled={busy} onClick={() => void act("retry")}>{busy ? "…" : "retry ▸"}</button>
      )}
      {err && <span className="sh-err">{err}</span>}
    </li>
  );
}
