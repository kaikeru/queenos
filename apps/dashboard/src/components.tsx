import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "./router";
import { ApiError, api, errorMessage } from "./api";
import { useEscape } from "./hooks";
import { phaseHeadline, shortVersion, tapButtonState, tapErrorMessage, timelineSteps, type SiteReleaseView } from "./releases";
import { CANARY_STEPS, type ModelStats, type RecalledMemory, type ModelTier, type Release, type RouterFloor, type SentinelVerdict } from "@queenos/queen-types";
import {
  PHASE_FLOW,
  excerpt,
  lanesNewestFirst,
  letterOf,
  previewView,
  releaseLetters,
  type AuditCard,
  type SiteRow,
  type Lane,
  type LaneTrain,
  type LandedCommit,
  type State,
  type TickerItem,
} from "./reducer";
import { DEMO_PROMPTS } from "./demo";
import { OUTCOME_META, laneMemories, memoryChipLabel, scorePercent } from "./memory";
import { TIER_META, tierRank, buildModelBoard, formatDuration, modelLabel, tierClass, tierOf, type TierGroup } from "./models";
import type { ConnStatus } from "./useQueenSocket";

const ROLE_LABEL: Record<AuditCard["role"], string> = {
  BUILDER: "Builder",
  REVIEWER: "Reviewer",
  GATEKEEPER: "Gatekeeper",
  SCRIBE: "Scribe",
  POLICY: "Policy",
  SECURITY: "Security",
  LANDER: "Lander",
};

const ROLE_GLYPH: Record<AuditCard["role"], string> = {
  BUILDER: "⚒",
  REVIEWER: "◎",
  GATEKEEPER: "⛨",
  SCRIBE: "✎",
  POLICY: "§",
  SECURITY: "⚠",
  LANDER: "⇪",
};

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });
const short = (sha: string) => sha.slice(0, 7);

// ── top bar ───────────────────────────────────────────────────────────────

export function TopBar(props: { hive: string; status: ConnStatus; latencyMs: number | null; retryAt: number | null; state: State; backTo?: string }) {
  const now = useNow();
  const { state } = props;
  const prompts = Object.values(state.prompts);
  const count = (s: string) => prompts.filter((p) => p.status === s).length;
  const active = prompts.filter((p) => p.status === "BUILDING" || p.status === "IN_TRAIN" || p.status === "QUEUED").length;
  const label =
    props.status === "open"
      ? `LINKED${props.latencyMs !== null ? ` · ${props.latencyMs}ms` : ""}`
      : props.status === "connecting"
        ? "CONNECTING"
        : `RECONNECTING${props.retryAt ? ` · ${Math.max(0, Math.ceil((props.retryAt - now) / 1000))}s` : ""}`;
  return (
    <header className="topbar">
      <div className="brand">
        {props.backTo && <Link to={props.backTo} className="backlink" aria-label="Back to projects">← Projects</Link>}
        <span className="brand__mark">♛</span>
        <div>
          <h1>QUEENOS</h1>
          <p>WAR ROOM · hive <b>{props.hive}</b></p>
        </div>
      </div>
      <dl className="stats">
        <Stat label="ACTIVE" value={active} tone="warn" />
        <Stat label="MERGED" value={count("MERGED")} tone="ok" />
        <Stat label="EJECTED" value={count("EJECTED")} tone="bad" />
        <Stat label="FAILED" value={count("FAILED")} tone="bad" />
      </dl>
      <div className={`conn conn--${props.status}`} role="status">
        <i />
        {label}
      </div>
    </header>
  );
}

function Stat(props: { label: string; value: number; tone: "ok" | "warn" | "bad" }) {
  return (
    <div className={`stat stat--${props.tone}`}>
      <dd>{props.value}</dd>
      <dt>{props.label}</dt>
    </div>
  );
}

// ── main track ────────────────────────────────────────────────────────────

export function MainTrack({ landed, state }: { landed: LandedCommit[]; state: State }) {
  return (
    <section className="main-track" aria-label="main branch">
      <div className="main-track__label">
        <b>main</b>
        <span>{landed.length} landed</span>
      </div>
      <div className="main-track__rail">
        <div className="commit commit--root" title="initial commit">
          <i />
          <span>root</span>
        </div>
        {landed.map((c) => {
          const label = `${letterOf(state, c.promptId)} · ${state.prompts[c.promptId]?.promptText ?? ""}`;
          return (
            <div className="commit commit--landed" key={c.trainId} title={`train ${c.trainId}: ${label}`}>
              <i />
              <code>{short(c.sha)}</code>
              <span title={label}>{label}</span>
            </div>
          );
        })}
        {landed.length === 0 && <div className="main-track__empty">waiting for the first landing…</div>}
      </div>
    </section>
  );
}

// ── swimlanes ─────────────────────────────────────────────────────────────

export function Lanes(props: { lanes: Lane[]; selected: string | null; onSelect: (card: AuditCard, lane: Lane) => void }) {
  if (props.lanes.length === 0) {
    return (
      <div className="empty">
        <h2>The queue is empty</h2>
        <p>
          Submit a prompt, or hit <b>Launch demo swarm</b> to put four agents on the merge train at once.
        </p>
      </div>
    );
  }
  return (
    <div className="lanes">
      {lanesNewestFirst(props.lanes).map((lane) => (
        <LaneRow key={lane.prompt.promptId} {...props} lane={lane} />
      ))}
    </div>
  );
}

function LaneRow({ lane, selected, onSelect }: { lane: Lane; selected: string | null; onSelect: (c: AuditCard, l: Lane) => void }) {
  const attempts = Math.max(1, ...lane.cards.map((c) => c.attempt));
  const cardsByAttempt = new Map<number, AuditCard[]>();
  for (const c of lane.cards) cardsByAttempt.set(c.attempt, [...(cardsByAttempt.get(c.attempt) ?? []), c]);
  return (
    <section className={`lane lane--${lane.prompt.status.toLowerCase()}`}>
      <header className="lane__head">
        <span className="badge">{lane.letter}</span>
        <div className="lane__title">
          <h3 title={lane.prompt.promptText}>{lane.prompt.promptText}</h3>
          <p>
            <code>{lane.prompt.promptId.slice(0, 8)}</code> · queued {clock(lane.prompt.createdAt)}
            {attempts > 1 && <b className="rework-tag"> · ATTEMPT {attempts}</b>}
          </p>
        </div>
        <Chip value={lane.prompt.status} />
      </header>

      <div className="cars">
        {lane.trains.length === 0 && <span className="cars__empty">no train yet</span>}
        {lane.trains.map((lt) => (
          <TrainCar key={lt.train.trainId} lt={lt} />
        ))}
      </div>

      <MemoryRecall memories={laneMemories(lane.trains)} />

      <div className="cards">
        {lane.cards.length === 0 && <span className="cards__empty">no drones dispatched</span>}
        {[...cardsByAttempt.entries()].map(([attempt, cards]) => (
          <div className="cards__group" key={attempt}>
            {attempts > 1 && <div className="cards__attempt">{attempt === 1 ? "ATTEMPT 1" : `ATTEMPT ${attempt} · REBUILD`}</div>}
            <div className="cards__row">
              {cards.map((c) => (
                <CardView key={c.key} card={c} active={selected === c.key} onClick={() => onSelect(c, lane)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** "🧠 N memories recalled" chip that expands into the hive memories fed to the builder. */
export function MemoryRecall({ memories }: { memories: RecalledMemory[] }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<Record<string, boolean>>({});
  if (memories.length === 0) return null;
  return (
    <div className="memories">
      <button type="button" className="memories__chip" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">🧠</span> {memoryChipLabel(memories.length)} <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <ul className="memories__list">
          {memories.map((m) => {
            const meta = OUTCOME_META[m.outcome];
            const expanded = !!full[m.memoryId];
            return (
              <li key={m.memoryId} className={`memory memory--${meta.cls}`}>
                <div className="memory__top">
                  <span className={`chip memory__outcome memory__outcome--${meta.cls}`}>{meta.label}</span>
                  <span className="memory__score" title="cosine similarity to this prompt">
                    {scorePercent(m.score)}% match
                  </span>
                </div>
                <p className="memory__prompt">{m.promptText}</p>
                <p className={`memory__text${expanded ? "" : " memory__text--clamp"}`}>{m.text}</p>
                <button type="button" className="memory__more" onClick={() => setFull((f) => ({ ...f, [m.memoryId]: !expanded }))}>
                  {expanded ? "show less" : "show more"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function Chip({ value }: { value: string }) {
  return <span className={`chip chip--${value.toLowerCase()}`}>{value.replace("_", " ")}</span>;
}

/** Segment state: finished trains are fully done (green) or red up to the failure; only live trains pulse. */
function phaseClass(status: string, i: number, idx: number): string {
  if (status === "MERGED") return "done";
  if (status === "EJECTED") return i <= idx ? "done" : "";
  return i < idx ? "done" : i === idx ? "now" : "";
}

/** One speculative train: cumulative cars (A+B+C), status chip and phase pipeline. */
function TrainCar({ lt }: { lt: LaneTrain }) {
  const { train } = lt;
  const phase = train.phase;
  const idx = phase ? PHASE_FLOW.indexOf(phase as (typeof PHASE_FLOW)[number]) : -1;
  const cls = ["car", `car--${train.status.toLowerCase()}`, lt.current ? "car--current" : "car--old", lt.generation > 1 ? "car--rebuilt" : ""];
  return (
    <article className={cls.join(" ")}>
      <div className="car__top">
        <Chip value={train.status} />
        {lt.generation > 1 && <span className="car__gen">REBUILD #{lt.generation - 1}</span>}
        {lt.ejectKind && <span className="car__eject">{lt.ejectKind === "superseded" ? "SUPERSEDED" : "FAILED"}</span>}
      </div>
      {train.model && <ModelChip model={train.model} reason={train.modelReason} escalated={lt.escalated} />}
      <div className="car__cars" title={`train ${train.trainId}`}>
        {lt.cars.map((letter, i) => (
          <span key={`${letter}${i}`} className={`car__unit${i === lt.cars.length - 1 ? " car__unit--tail" : ""}`}>
            {letter}
          </span>
        ))}
      </div>
      {phase && (
        <ol className="phases" aria-label={`phase ${phase}`}>
          {PHASE_FLOW.map((p, i) => (
            <li key={p} className={phaseClass(train.status, i, idx)} title={p} />
          ))}
        </ol>
      )}
      <div className="car__meta">
        {phase ? phase.replace("_", " ") : train.status}
        {train.headSha && <code> · {short(train.headSha)}</code>}
      </div>
      <PreviewLink lt={lt} />
      {train.status === "EJECTED" && train.reason && <div className="car__reason">{excerpt(train.reason.replace(/prompt [0-9a-f-]{36}/, "a prompt"), 70)}</div>}
    </article>
  );
}

export function TierBadge({ tier }: { tier: ModelTier }) {
  return (
    <span className={tierClass(tier)} title={TIER_META[tier].hint}>
      {TIER_META[tier].label}
    </span>
  );
}

/** The router's pick for a train: model label, tier badge and (secondary line) why. */
export function ModelChip({ model, reason, escalated }: { model: string; reason?: string | null; escalated?: boolean }) {
  const tier = tierOf(model);
  return (
    <div className={`mchip${tier ? ` mchip--${tier}` : ""}${escalated ? " mchip--escalated" : ""}`} title={reason ? `${model}\n${reason}` : model}>
      <div className="mchip__row">
        <span className="mchip__name">{modelLabel(model)}</span>
        {tier && <TierBadge tier={tier} />}
        {escalated && <span className="mchip__esc">▲ ESCALATED</span>}
      </div>
      {reason && <div className="mchip__reason">{reason}</div>}
    </div>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The train's Worker Preview: "deploying…" while DEPLOYING, then a link (struck through once torn down). */
function PreviewLink({ lt }: { lt: LaneTrain }) {
  const v = previewView(lt.train, lt.preview);
  switch (v.kind) {
    case "none":
      return null;
    case "deploying":
      return (
        <div className="car__preview car__preview--deploying">
          <i /> deploying preview…
        </div>
      );
    case "live":
      return (
        <a className="car__preview car__preview--live" href={v.url} target="_blank" rel="noreferrer" title={v.url}>
          ↗ {hostOf(v.url)}
        </a>
      );
    case "failed":
      return (
        <div className="car__preview car__preview--failed" title={v.summary ?? undefined}>
          preview failed{v.summary ? `: ${excerpt(v.summary, 40)}` : ""}
        </div>
      );
    case "gone":
      return (
        <div className="car__preview car__preview--gone" title={v.url ?? undefined}>
          preview torn down
        </div>
      );
  }
}

function CardView({ card, active, onClick }: { card: AuditCard; active: boolean; onClick: () => void }) {
  const now = useNow();
  const elapsed = Math.max(0, Math.round(((card.endedAt ?? now) - card.startedAt) / 1000));
  return (
    <button type="button" className={`acard acard--${card.status.toLowerCase()}${active ? " acard--active" : ""}`} onClick={onClick}>
      <span className="acard__glyph" aria-hidden>
        {ROLE_GLYPH[card.role]}
      </span>
      <span className="acard__role">{ROLE_LABEL[card.role]}</span>
      <span className="acard__status">{card.status}</span>
      <span className="acard__time">{elapsed}s</span>
    </button>
  );
}

// ── Cognitive Ledger panel ────────────────────────────────────────────────

export function LedgerPanel({ card, lane, onClose }: { card: AuditCard; lane: Lane; onClose: () => void }) {
  const p = card.payload;
  // Escape closes the drawer from anywhere (the drawer never takes focus, so a
  // handler on the <aside> itself would not fire).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <aside className="ledger" role="dialog" aria-label="Cognitive Ledger">
      <header className="ledger__head">
        <div>
          <p className="eyebrow">COGNITIVE LEDGER</p>
          <h2>
            {ROLE_LABEL[card.role]} <Chip value={card.status} />
          </h2>
          <p className="ledger__sub">
            [{lane.letter}] {excerpt(lane.prompt.promptText, 60)} · attempt {card.attempt}
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close ledger">
          ✕
        </button>
      </header>
      {!p ? (
        <div className="ledger__empty">
          <div className="spinner" />
          <p>The drone is still working. Its ledger entry is written to Git Notes when it finishes.</p>
        </div>
      ) : (
        <div className="ledger__body">
          <dl className="kv">
            <div>
              <dt>MODEL</dt>
              <dd className="kv__model" title={p.model}>
                {modelLabel(p.model)}
                {tierOf(p.model) && <TierBadge tier={tierOf(p.model) as ModelTier} />}
              </dd>
            </div>
            <div>
              <dt>TEMPERATURE</dt>
              <dd>{p.temperature.toFixed(2)}</dd>
            </div>
            <div>
              <dt>RESULT</dt>
              <dd className={p.result === "success" ? "ok" : "bad"}>{p.result.toUpperCase()}</dd>
            </div>
            <div>
              <dt>EXEC TIME</dt>
              <dd>{(p.executionTimeMs / 1000).toFixed(1)}s</dd>
            </div>
          </dl>
          <h4>Task prompt</h4>
          <blockquote>{p.taskPrompt}</blockquote>
          <h4>Reasoning steps</h4>
          <ol className="steps">
            {p.reasoningSteps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <h4>Discarded paths</h4>
          {p.discardedPaths.length === 0 ? (
            <p className="muted">None. The first path was taken.</p>
          ) : (
            <ul className="discarded">
              {p.discardedPaths.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          )}
          <details>
            <summary>git_notes_payload (raw)</summary>
            <pre>{JSON.stringify(p, null, 2)}</pre>
          </details>
        </div>
      )}
    </aside>
  );
}

// ── composer ──────────────────────────────────────────────────────────────

export function Composer(props: { disabled: boolean; onSubmit: (text: string) => void; onSwarm: () => void; swarming: boolean }) {
  const [text, setText] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    props.onSubmit(t);
    setText("");
  };
  return (
    <form className="composer panel" onSubmit={submit}>
      <p className="eyebrow">PROMPT COMPOSER</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Describe a change for the swarm…  (add [fail] to make the sim fail it once)"
        rows={3}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
        }}
      />
      <div className="composer__row">
        <button type="submit" className="btn btn--primary" disabled={props.disabled || !text.trim()}>
          Submit prompt
        </button>
        <button type="button" className="btn btn--swarm" disabled={props.disabled || props.swarming} onClick={props.onSwarm}>
          {props.swarming ? "Launching…" : `Launch demo swarm (${DEMO_PROMPTS.length})`}
        </button>
      </div>
    </form>
  );
}

// ── sites ─────────────────────────────────────────────────────────────────

const STATUS_TONE: Record<string, string> = { PENDING: "building", LIVE: "merged", FAILED: "failed", TORN_DOWN: "" };

const VERDICT_TONE = { PROMOTE: "ok", ROLLBACK: "bad" } as const;

function VerdictLine({ verdict }: { verdict: SentinelVerdict | null }) {
  if (!verdict) return <div className="site__muted">no verdict yet</div>;
  return (
    <div className={`site__verdict site__verdict--${VERDICT_TONE[verdict.verdict]}`} title={verdict.summary}>
      <b>{verdict.verdict}</b> {excerpt(verdict.summary, 90)}
    </div>
  );
}

const PHASE_CHIP: Record<string, string> = {
  STAGING: "building",
  VALIDATING: "testing",
  AWAITING_TAP: "queued",
  CANARY: "testing",
  SHIPPED: "merged",
  FAILED: "failed",
  ROLLED_BACK: "failed",
  SUPERSEDED: "",
};

function UrlLink({ url }: { url: string | null }) {
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" title={url}>
      {hostOf(url)}
    </a>
  ) : (
    <span className="site__muted">no URL yet</span>
  );
}

/** Per-environment view: previews from deployments; staging, canary and prod from releases (P3). */
export function Sites({ rows, state, view }: { rows: SiteRow[]; state: State; view: SiteReleaseView }) {
  const byEnv = Object.fromEntries(rows.map((r) => [r.environment, r]));
  const preview = byEnv.preview;
  return (
    <section className="sites panel" aria-label="sites">
      <p className="eyebrow">SITES</p>
      <ul className="sites__list">
        {preview && (
          <li className="site">
            <div className="site__head">
              <b>preview</b>
              <span className="site__muted">
                {preview.deployments.length} active{preview.retired ? ` · ${preview.retired} torn down` : ""}
              </span>
            </div>
            {preview.deployments.slice(0, 6).map((d) => {
              const train = d.trainId ? state.trains[d.trainId] : undefined;
              const cars = train ? train.includedPrompts.map((id) => letterOf(state, id)).join("+") : d.deploymentId;
              return (
                <div key={d.deploymentId} className="site__row">
                  <span className={`chip chip--sm chip--${STATUS_TONE[d.status] ?? ""}`}>{d.status === "PENDING" ? "DEPLOYING" : d.status.replace("_", " ")}</span>
                  <span className="site__cars">{cars}</span>
                  {d.url && d.status === "LIVE" ? (
                    <a href={d.url} target="_blank" rel="noreferrer" title={d.url}>
                      {hostOf(d.url)}
                    </a>
                  ) : (
                    <span className="site__muted">{d.summary ? excerpt(d.summary, 36) : d.commitSha ? short(d.commitSha) : ""}</span>
                  )}
                </div>
              );
            })}
            {preview.deployments.length === 0 && <div className="site__muted">no live previews</div>}
          </li>
        )}

        <li className={`site site--staging${view.staging ? "" : " site--off"}`}>
          <div className="site__head">
            <b>staging</b>
            {view.staging ? <span className={`chip chip--sm chip--${PHASE_CHIP[view.staging.phase] ?? ""}`}>{view.staging.phase.replace("_", " ")}</span> : <span className="site__muted">no release yet</span>}
          </div>
          {view.staging && (
            <>
              <div className="site__row site__row--url"><UrlLink url={view.staging.url} /></div>
              <VerdictLine verdict={view.staging.verdict} />
            </>
          )}
        </li>

        <li className={`site site--canary${view.canary ? "" : " site--off"}${view.canary?.live ? " site--live" : ""}${view.canary?.phase === "ROLLED_BACK" ? " site--rolledback" : ""}`}>
          <div className="site__head">
            <b>canary</b>
            {view.canary ? (
              <span className={`chip chip--sm chip--${PHASE_CHIP[view.canary.phase] ?? ""}`}>{view.canary.phase === "CANARY" ? `${view.canary.percent}%` : view.canary.phase.replace("_", " ")}</span>
            ) : (
              <span className="site__muted">idle</span>
            )}
          </div>
          {view.canary && (
            <>
              <CanaryBar percent={view.canary.percent} rolledBack={view.canary.phase === "ROLLED_BACK"} shipped={view.canary.phase === "SHIPPED"} />
              <div className="site__versions">
                <span>candidate <code>{view.canary.candidate ?? "n/a"}</code></span>
                <span>stable <code>{view.canary.stable ?? "n/a"}</code></span>
              </div>
              <VerdictLine verdict={view.canary.verdict} />
            </>
          )}
        </li>

        <li className={`site site--prod${view.prod ? "" : " site--off"}`} title={view.prod?.tappedBy ? `shipped by ${view.prod.tappedBy}` : undefined}>
          <div className="site__head">
            <b>prod</b>
            {!view.prod && <span className="site__muted">nothing shipped yet</span>}
          </div>
          {view.prod && (
            <>
              <div className="site__row site__row--url"><UrlLink url={view.prod.url} /></div>
              <div className="site__versions">
                <span>stable <code>{view.prod.stable ?? "n/a"}</code></span>
              </div>
            </>
          )}
        </li>
      </ul>
    </section>
  );
}

/** Progress across the canary steps with the current one lit. */
export function CanaryBar({ percent, rolledBack, shipped }: { percent: number; rolledBack: boolean; shipped: boolean }) {
  return (
    <ol className={`cbar${rolledBack ? " cbar--bad" : ""}${shipped ? " cbar--done" : ""}`} aria-label={`canary at ${percent}%`}>
      {CANARY_STEPS.map((s, i) => {
        const prev = CANARY_STEPS[i - 1] ?? 0;
        const reached = percent >= s;
        const current = !shipped && percent > prev && percent <= s;
        return (
          <li key={s} className={`${reached ? "reached" : ""}${current ? " current" : ""}`}>
            <i />
            <span>{s}%</span>
          </li>
        );
      })}
    </ol>
  );
}

// ── release timeline ──────────────────────────────────────────────────────

export function ReleaseTimeline(props: { hive: string; state: State; release: Release | null; onTapped?: () => void }) {
  const { release, state } = props;
  const [modal, setModal] = useState(false);
  const [pending, setPending] = useState(false);
  const [sentFor, setSentFor] = useState<string | null>(null);
  const [error, setError] = useState<{ status: number; text: string } | null>(null);
  const closeModal = () => {
    if (!pending) setModal(false);
  };
  useEscape(closeModal, modal);

  // A new phase means the tap landed (or went stale): drop the local "sent" lock.
  const phase = release?.phase;
  useEffect(() => {
    setSentFor(null);
    setPending(false);
  }, [phase, release?.releaseId]);

  if (!release) {
    return (
      <section className="rtl rtl--empty panel" aria-label="release timeline">
        <p className="eyebrow">RELEASE</p>
        <p className="muted">No release yet. When trains land on main, the Queen cuts a release and walks it up the ladder.</p>
      </section>
    );
  }
  const steps = timelineSteps(release, state.canaryPeak[release.releaseId] ?? 0);
  const letters = release.trainIds.length ? releaseLetters(state, release) : "no trains";
  const tap = tapButtonState(release, { pending, sentFor });
  const stagingVerdict = state.verdicts[release.releaseId]?.staging ?? null;

  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      await api.tapRelease(props.hive, release.releaseId);
      setSentFor(release.releaseId);
      setModal(false);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      setError({ status, text: tapErrorMessage(status, errorMessage(e)) });
    } finally {
      setPending(false);
    }
  };

  return (
    <section className={`rtl rtl--${release.phase.toLowerCase()} panel`} aria-label="release timeline">
      <header className="rtl__head">
        <div>
          <p className="eyebrow">RELEASE</p>
          <h2>
            <code>{short(release.headSha)}</code>
            <span className="rtl__trains" title={`${release.trainIds.length} trains`}>
              {letters.split("+").map((l, i) => (
                <span key={`${l}${i}`} className="car__unit car__unit--tail">
                  {l}
                </span>
              ))}
            </span>
          </h2>
          <p className="rtl__headline">{phaseHeadline(release)}</p>
        </div>
        {tap.visible && (
          <button
            type="button"
            className="tap-btn"
            disabled={!tap.enabled}
            onClick={() => {
              setError(null);
              setModal(true);
            }}
          >
            {tap.label}
          </button>
        )}
      </header>

      <ol className="rtl__steps">
        {steps.map((s) => (
          <li key={s.key} className={`rstep rstep--${s.state}${s.percent ? " rstep--canary" : ""}`} aria-current={s.state === "now" ? "step" : undefined}>
            <i>{s.state === "done" ? "✓" : s.state === "bad" ? "✕" : ""}</i>
            <span>{s.label}</span>
          </li>
        ))}
      </ol>

      {release.summary && <p className="rtl__summary">{release.summary}</p>}
      {release.phase === "ROLLED_BACK" && <div className="rtl__banner rtl__banner--bad">ROLLED BACK{release.stableVersionId ? ` to ${shortVersion(release.stableVersionId)}` : ""}</div>}
      {release.phase === "SHIPPED" && <div className="rtl__banner rtl__banner--ok">SHIPPED{release.tappedBy ? ` by ${release.tappedBy}` : ""}</div>}
      {sentFor === release.releaseId && error === null && release.phase === "AWAITING_TAP" && <p className="muted">Tap sent. Waiting for the Queen to start the canary…</p>}

      {modal && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeModal()}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="tap-title">
            <p className="eyebrow">SHIP TO PRODUCTION</p>
            <h2 id="tap-title">
              Ship release <code>{short(release.headSha)}</code>?
            </h2>
            <dl className="modal__facts">
              <div>
                <dt>TRAINS</dt>
                <dd>
                  {letters}
                  <ul>
                    {release.trainIds.map((id) => {
                      const t = state.trains[id];
                      const tail = t?.includedPrompts.at(-1);
                      return (
                        <li key={id}>
                          [{tail ? letterOf(state, tail) : "?"}] {tail ? excerpt(state.prompts[tail]?.promptText ?? "", 60) : id.slice(0, 8)}
                        </li>
                      );
                    })}
                  </ul>
                </dd>
              </div>
              <div>
                <dt>STAGING VERDICT</dt>
                <dd>
                  <VerdictLine verdict={stagingVerdict} />
                </dd>
              </div>
              <div>
                <dt>PLAN</dt>
                <dd>Canary at {CANARY_STEPS.join(" → ")}%, Sentinel checks every step, automatic rollback on a bad verdict.</dd>
              </div>
            </dl>
            {error && (
              <p className="modal__error" role="alert">
                {error.text}
              </p>
            )}
            <div className="modal__actions">
              <button type="button" className="btn" onClick={closeModal} disabled={pending}>
                Cancel
              </button>
              <button type="button" className="btn btn--ship" onClick={() => void confirm()} disabled={pending} autoFocus>
                {pending ? "Sending…" : "Confirm: ship it"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ── telemetry ticker ──────────────────────────────────────────────────────

export function Ticker({ items }: { items: TickerItem[] }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: 0 });
  }, [items[0]?.id]);
  return (
    <section className="ticker panel" aria-label="telemetry">
      <p className="eyebrow">
        TELEMETRY <span className="live">● LIVE</span>
      </p>
      <ol ref={ref}>
        {items.length === 0 && <li className="ticker__empty">Silence on the wire.</li>}
        {items.map((t) => (
          <li key={t.id} className={`tick tick--${t.kind}${t.tone ? ` tick--${t.tone}` : ""}`}>
            <time>{clock(t.at)}</time>
            <span className="tick__kind">{t.kind === "scribe" ? "SCRIBE" : t.kind === "error" ? "ERR" : t.kind === "system" ? "SYS" : t.kind === "sentinel" ? "SENT" : t.kind === "model" ? "MDL" : "EVT"}</span>
            <span className="tick__text">{t.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ── model board ───────────────────────────────────────────────────────────

export function floorLine(f: RouterFloor): string {
  // probeIn is null exactly when the floor is already at the lowest builder tier: nothing to back off to.
  if (f.probeIn === null) return "at the lowest tier";
  return `${f.streak}/${f.backoffAfter} clean builds to back off · probe in ${f.probeIn}`;
}

/** Compact router floor line; flashes red when raised, green when backed off. */
function FloorLine({ floor }: { floor: RouterFloor }) {
  const prev = useRef(floor.tier);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (prev.current === floor.tier) return;
    setFlash(tierRank(floor.tier) > tierRank(prev.current) ? "up" : "down");
    prev.current = floor.tier;
    const t = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(t);
  }, [floor.tier]);
  return (
    <p className={`models__floor${flash ? ` models__floor--${flash}` : ""}`} title="Cheapest tier the Queen will route builds to right now">
      <span>Floor:</span> <TierBadge tier={floor.tier} /> <span className="models__floor-text">{floorLine(floor)}</span>
    </p>
  );
}

export function ModelBoard({ stats, floor }: { stats: ModelStats[]; floor?: RouterFloor | null }) {
  const [open, setOpen] = useState(true);
  const groups: TierGroup[] = buildModelBoard(stats);
  const tried = groups.reduce((n, g) => n + g.rows.filter((r) => !r.untried).length, 0);
  return (
    <section className="models panel" aria-label="model board">
      <button type="button" className="models__toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="eyebrow">MODEL BOARD</span>
        <span className="models__count">{tried} in play</span>
        <span className="models__caret" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      <p className="models__tag">Queen routes each build to the best model on AI Gateway</p>
      {floor && <FloorLine floor={floor} />}
      {open &&
        groups.map((g) => (
          <div className="mtier" key={g.tier}>
            <div className="mtier__head">
              <TierBadge tier={g.tier} />
              <span>{TIER_META[g.tier].hint}</span>
            </div>
            <ul>
              {g.rows.map((r) => (
                <li key={r.model.id} className={`mrow${r.untried ? " mrow--untried" : ""}${r.leader ? " mrow--leader" : ""}`} title={r.model.id}>
                  <span className="mrow__name">
                    {r.leader && (
                      <b className="mrow__crown" title="Leading its tier">
                        ★
                      </b>
                    )}
                    {r.model.label}
                  </span>
                  {r.untried ? (
                    <span className="mrow__untried">untried</span>
                  ) : (
                    <>
                      <span
                        className="mrow__bar"
                        role="meter"
                        aria-label={`${r.model.label} pass rate`}
                        aria-valuemin={0}
                        aria-valuemax={r.attempts}
                        aria-valuenow={r.passes}
                      >
                        <i style={{ width: `${Math.round((r.passRate ?? 0) * 100)}%` }} />
                      </span>
                      <span className="mrow__pct">{Math.round((r.passRate ?? 0) * 100)}%</span>
                      <span className="mrow__n" title="passes / attempts">
                        {r.passes}/{r.attempts}
                      </span>
                      <span className="mrow__ms" title="average build time">
                        {formatDuration(r.avgBuildMs)}
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
    </section>
  );
}
