import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "./router";
import {
  PHASE_FLOW,
  excerpt,
  letterOf,
  previewView,
  type AuditCard,
  type SiteRow,
  type Lane,
  type LaneTrain,
  type LandedCommit,
  type State,
  type TickerItem,
} from "./reducer";
import { DEMO_PROMPTS } from "./demo";
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
        {landed.map((c) => (
          <div className="commit commit--landed" key={c.trainId} title={`train ${c.trainId}`}>
            <i />
            <code>{short(c.sha)}</code>
            <span>
              {letterOf(state, c.promptId)} · {excerpt(state.prompts[c.promptId]?.promptText ?? "", 22)}
            </span>
          </div>
        ))}
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
      {props.lanes.map((lane) => (
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

export function Chip({ value }: { value: string }) {
  return <span className={`chip chip--${value.toLowerCase()}`}>{value.replace("_", " ")}</span>;
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
            <li key={p} className={train.status === "EJECTED" ? (i <= idx ? "done" : "") : i < idx ? "done" : i === idx ? "now" : ""} title={p} />
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
              <dd>{p.model}</dd>
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

/** Compact per-environment view of deployments (previews today; staging/canary/prod from P3). */
export function Sites({ rows, state }: { rows: SiteRow[]; state: State }) {
  return (
    <section className="sites panel" aria-label="sites">
      <p className="eyebrow">SITES</p>
      <ul className="sites__list">
        {rows.map((row) => (
          <li key={row.environment} className={`site${row.configured ? "" : " site--off"}`}>
            <div className="site__head">
              <b>{row.environment}</b>
              {!row.configured ? (
                <span className="site__muted">not configured</span>
              ) : row.environment === "preview" ? (
                <span className="site__muted">
                  {row.deployments.length} active{row.retired ? ` · ${row.retired} torn down` : ""}
                </span>
              ) : null}
            </div>
            {row.configured &&
              row.deployments.slice(0, 6).map((d) => {
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
            {row.environment === "preview" && row.configured && row.deployments.length === 0 && <div className="site__muted">no live previews</div>}
          </li>
        ))}
      </ul>
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
          <li key={t.id} className={`tick tick--${t.kind}`}>
            <time>{clock(t.at)}</time>
            <span className="tick__kind">{t.kind === "scribe" ? "SCRIBE" : t.kind === "error" ? "ERR" : t.kind === "system" ? "SYS" : "EVT"}</span>
            <span className="tick__text">{t.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
