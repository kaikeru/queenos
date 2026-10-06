import { useState, type FormEvent } from "react";
import { GUARDRAIL_DEFAULTS, GUARDRAIL_MAX } from "@queenos/queen-types";
import { api, errorMessage } from "./api";
import { GUARDRAIL_FIELDS, guardrailPatch, parseGuardrail, type GuardrailKey } from "./homeLogic";
import { releaseStrip } from "./releases";
import { Link } from "./router";
import { hrefFor } from "./route";
import type { State } from "./reducer";

/** One-line current-release row for the status home: phase timeline, who shipped it, prod link. */
export function ReleaseStripRow({ hive, state }: { hive: string; state: State }) {
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
        {release.phase === "SHIPPED" && prodUrl && (
          <a className="rstrip__prod" href={prodUrl} target="_blank" rel="noreferrer" title={prodUrl}>prod ▸</a>
        )}
        <Link className="sh-link rstrip__more" to={hrefFor.lanes(hive)}>lanes ▸</Link>
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
