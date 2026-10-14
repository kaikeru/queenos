import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ModelStats, ModelTier, RecalledMemory, RouterFloor } from "@queenos/queen-types";
import { usePersistedBool } from "./hooks";
import { OUTCOME_META, memoryChipLabel, scorePercent } from "./memory";
import { TIER_META, tierRank, buildModelBoard, formatDuration, modelLabel, tierClass, tierOf, type TierGroup } from "./models";

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
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

/** A collapsible right-sidebar panel: sticky header, body scrolls on its own when space runs out. */
function SideSection(props: { className: string; label: string; title: string; count?: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className={`${props.className} side-section panel${props.open ? "" : " side-section--closed"}`} aria-label={props.label}>
      <button type="button" className="side-section__toggle" aria-expanded={props.open} onClick={props.onToggle}>
        <span className="eyebrow">{props.title}</span>
        {props.count && <span className="side-section__count">{props.count}</span>}
        <span className="side-section__caret" aria-hidden>
          {props.open ? "▾" : "▸"}
        </span>
      </button>
      {props.open && <div className="side-section__body">{props.children}</div>}
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
  const [open, setOpen] = usePersistedBool("queenos.side.models", true);
  const groups: TierGroup[] = buildModelBoard(stats);
  const tried = groups.reduce((n, g) => n + g.rows.filter((r) => !r.untried).length, 0);
  return (
    <SideSection className="models" label="model board" title="MODEL BOARD" count={`${tried} in play`} open={open} onToggle={() => setOpen((o) => !o)}>
      <p className="models__tag">Queen routes each build to the best model on AI Gateway</p>
      {floor && <FloorLine floor={floor} />}
      {groups.map((g) => (
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
    </SideSection>
  );
}
