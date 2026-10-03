import { useCallback, useEffect, useId, useReducer, useRef, useState, type KeyboardEvent } from "react";
import { CharterSchema, type Charter, type WizardState } from "@queenos/queen-types";
import { api, errorMessage } from "./api";
import { useEscape } from "./hooks";
import { Link } from "./router";
import { hrefFor } from "./route";
import { ErrorNotice, Modal, Shell } from "./shell";
import {
  STEPPER,
  addTag,
  charterFormFromDraft,
  connectReducer,
  initialConnect,
  isPolling,
  lastFour,
  previewFromDraft,
  screenFor,
  stepperIndex,
  timelineFor,
  validateCharter,
  validateConnect,
  verificationFailed,
  type Screen,
} from "./wizardLogic";

const POLL_MS = 2000;

export function Wizard({ hive }: { hive: string }) {
  const [state, setState] = useState<WizardState | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reviewing, setReviewing] = useState(false);
  const [pollError, setPollError] = useState(false);
  const step = state?.step;

  const refresh = useCallback(async () => {
    try {
      const s = await api.wizard(hive);
      setState(s);
      setError(null);
      setPollError(false);
      return s;
    } catch (e) {
      setError(e);
      setPollError(true);
      return null;
    }
  }, [hive]);

  useEffect(() => {
    setState(null);
    setError(null);
    setReviewing(false);
    void refresh();
  }, [refresh]);

  // First flight: poll every 2s until the hive is ACTIVE or FAILED.
  useEffect(() => {
    if (!step || !isPolling(step)) return;
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [step, refresh]);

  // A confirmed charter leaves the review sub-view behind.
  useEffect(() => {
    if (step && step !== "DESCRIBE") setReviewing(false);
  }, [step]);

  const screen: Screen | null = state ? screenFor(state.step, reviewing) : null;

  return (
    <Shell crumbs={[{ label: "PROJECTS" }, { label: hive.toUpperCase() }, { label: "SETUP" }]}>
      {screen && <Stepper screen={screen} />}
      {error && !state ? <ErrorNotice error={error} onRetry={() => void refresh()} /> : null}
      {!state && !error && <div className="panel wiz-loading" aria-busy="true"><div className="spinner" /> Loading project…</div>}
      {state && screen && (
        <>
          {pollError && isPolling(state.step) && <p className="muted wiz-warn">Lost contact with the server; retrying…</p>}
          {screen === "describe" && <Describe hive={hive} state={state} onState={setState} onReview={() => setReviewing(true)} />}
          {screen === "review" && <Review hive={hive} state={state} onBack={() => setReviewing(false)} onState={setState} />}
          {screen === "connect" && <Connect hive={hive} state={state} onConnected={() => void refresh()} />}
          {screen === "launch" && <Launch hive={hive} state={state} onState={setState} />}
          {screen === "flight" && <Flight hive={hive} state={state} />}
          {screen === "active" && <Active hive={hive} state={state} />}
          {screen === "failed" && <Failed hive={hive} state={state} onState={setState} />}
        </>
      )}
    </Shell>
  );
}

// ── stepper ─────────────────────────────────────────────────────────────

function Stepper({ screen }: { screen: Screen }) {
  const idx = stepperIndex(screen);
  return (
    <nav aria-label="Setup progress">
      <ol className="stepper">
        {STEPPER.map((s, i) => {
          const st = i < idx ? "done" : i === idx ? (screen === "failed" ? "failed" : "current") : "todo";
          return (
            <li key={s.screen} className={`stepper__item stepper__item--${st}`} aria-current={st === "current" || st === "failed" ? "step" : undefined}>
              <span className="stepper__dot">{st === "done" ? "✓" : st === "failed" ? "!" : i + 1}</span>
              <span className="stepper__label">{s.label}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ── 1. describe ─────────────────────────────────────────────────────────

const SUGGESTIONS = [
  "A status page that pings my sites every minute and shows uptime.",
  "A URL shortener with click analytics on Durable Objects.",
  "A webhook relay that fans GitHub events out to Slack.",
];

function Describe(props: { hive: string; state: WizardState; onState: (s: WizardState) => void; onReview: () => void }) {
  const { hive, state } = props;
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const preview = previewFromDraft(state.charterDraft);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [state.messages.length, pending]);

  async function send(t: string) {
    const msg = t.trim();
    if (!msg || pending) return;
    setPending(msg);
    setText("");
    setError(null);
    try {
      props.onState(await api.sendMessage(hive, msg));
    } catch (e) {
      setError(e);
      setText(msg);
    } finally {
      setPending(null);
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(text);
    }
  };

  return (
    <div className="wiz-grid">
      <section className="panel chat" aria-label="Describe your project">
        <p className="eyebrow">STEP 1 · DESCRIBE</p>
        <div className="chat__log" ref={logRef} role="log" aria-live="polite">
          <div className="msg msg--assistant">
            <span className="msg__who">QUEEN</span>
            <p>Tell me what you want to build. I will turn it into a hive charter you can review and edit.</p>
          </div>
          {state.messages.map((m, i) => (
            <div key={i} className={`msg msg--${m.role}`}>
              <span className="msg__who">{m.role === "user" ? "YOU" : "QUEEN"}</span>
              <p>{m.content}</p>
            </div>
          ))}
          {pending && (
            <>
              <div className="msg msg--user"><span className="msg__who">YOU</span><p>{pending}</p></div>
              <div className="msg msg--assistant" aria-label="The Queen is thinking"><span className="msg__who">QUEEN</span><p className="typing"><i /><i /><i /></p></div>
            </>
          )}
          {state.messages.length === 0 && !pending && (
            <div className="chat__suggest">
              {SUGGESTIONS.map((s) => <button key={s} className="chip-btn" onClick={() => void send(s)}>{s}</button>)}
            </div>
          )}
        </div>
        <ErrorNotice error={error} />
        <div className="chat__input">
          <label htmlFor={inputId} className="sr-only">Message to the Queen</label>
          <textarea id={inputId} rows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder="Describe your project…  (Enter to send, Shift+Enter for a new line)" maxLength={4000} disabled={!!pending} />
          <button className="btn btn--primary" onClick={() => void send(text)} disabled={!text.trim() || !!pending}>Send</button>
        </div>
        <p className="hint">🔒 Do not paste secrets or API tokens here. Credentials go in the Connect Cloudflare step, straight to the vault.</p>
      </section>

      <aside className="panel preview" aria-label="Live charter preview">
        <p className="eyebrow">CHARTER · LIVE PREVIEW</p>
        <CharterCard preview={preview} />
        <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(preview.completeness * 100)} aria-label="Charter completeness">
          <i style={{ width: `${preview.completeness * 100}%` }} />
        </div>
        <button className={`btn btn--big ${preview.completeness === 1 ? "btn--primary" : ""}`} onClick={props.onReview}>
          Review charter →
        </button>
        {preview.completeness < 1 && <p className="muted small">The charter fills in as you chat. You can also fill the rest by hand.</p>}
      </aside>
    </div>
  );
}

function Tags({ items, empty }: { items: string[]; empty: string }) {
  return items.length ? (
    <span className="tags">{items.map((t) => <code key={t} className="tag">{t}</code>)}</span>
  ) : (
    <span className="ph">{empty}</span>
  );
}

function CharterCard({ preview: p }: { preview: ReturnType<typeof previewFromDraft> }) {
  return (
    <dl className="charter">
      <div><dt>NAME</dt><dd>{p.name ?? <span className="ph">…</span>}</dd></div>
      <div><dt>DESCRIPTION</dt><dd>{p.description ?? <span className="ph">waiting for your description…</span>}</dd></div>
      <div><dt>STACK</dt><dd><Tags items={["cloudflare-workers", "worker-starter", "javascript"]} empty="" /></dd></div>
      <div><dt>ENVIRONMENTS</dt><dd><Tags items={["preview", ...(p.staging === false ? [] : ["staging"]), ...(p.prod === false ? [] : ["prod (human tap)"])]} empty="" /></dd></div>
      <div><dt>ALLOWED DEPS</dt><dd><Tags items={p.allowedDeps} empty="none yet" /></dd></div>
      <div><dt>ALLOWED HOSTS</dt><dd><Tags items={p.allowedHosts} empty="none yet" /></dd></div>
      <div><dt>FIRST PROMPT</dt><dd>{p.firstPrompt ? <blockquote>{p.firstPrompt}</blockquote> : <span className="ph">drafted once the plan is clear…</span>}</dd></div>
    </dl>
  );
}

// ── 2. review charter ──────────────────────────────────────────────────

function TagInput(props: { id: string; label: string; value: string[]; onChange: (v: string[]) => void; placeholder: string; error?: string }) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    if (draft.trim()) props.onChange(addTag(props.value, draft));
    setDraft("");
  };
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      <div className="taginput">
        {props.value.map((t) => (
          <span key={t} className="tag tag--rm">
            <code>{t}</code>
            <button type="button" aria-label={`Remove ${t}`} onClick={() => props.onChange(props.value.filter((x) => x !== t))}>×</button>
          </span>
        ))}
        <input
          id={props.id}
          value={draft}
          placeholder={props.value.length ? "" : props.placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit();
            } else if (e.key === "Backspace" && !draft && props.value.length) props.onChange(props.value.slice(0, -1));
            else if (e.key === "Escape") setDraft("");
          }}
        />
      </div>
      <small className={props.error ? "field__err" : "field__hint"}>{props.error ?? "Press Enter to add"}</small>
    </div>
  );
}

function Review(props: { hive: string; state: WizardState; onBack: () => void; onState: (s: WizardState) => void }) {
  const [form, setForm] = useState<Charter>(() => charterFormFromDraft(props.hive, props.state.charterDraft));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const id = useId();

  const patch = (p: Partial<Charter>) => {
    const next = { ...form, ...p };
    setForm(next);
    if (submitted) {
      const v = validateCharter(next);
      setErrors(v.ok ? {} : v.errors);
    }
  };

  async function confirm() {
    setSubmitted(true);
    const v = validateCharter(form);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    setError(null);
    try {
      props.onState(await api.confirmCharter(props.hive, v.charter));
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  const err = (k: string) => (submitted ? errors[k] : undefined);
  const errList = Object.entries(errors);

  return (
    <form className="panel form" onSubmit={(e) => { e.preventDefault(); void confirm(); }} noValidate>
      <p className="eyebrow">STEP 2 · REVIEW CHARTER</p>
      <h2 className="form__title">Review the hive charter</h2>
      <p className="muted">This is the contract your drones and gatekeepers follow. Edit anything, then confirm.</p>

      <div className="form__cols">
        <div className="field">
          <label htmlFor={`${id}-name`}>Name</label>
          <input id={`${id}-name`} value={form.name} onChange={(e) => patch({ name: e.target.value })} aria-invalid={!!err("name")} maxLength={120} />
          <small className="field__err">{err("name")}</small>
        </div>
        <div className="field">
          <label htmlFor={`${id}-hive`}>Hive</label>
          <input id={`${id}-hive`} className="mono" value={form.hive} readOnly aria-readonly="true" />
        </div>
      </div>

      <div className="field">
        <label htmlFor={`${id}-desc`}>Description</label>
        <textarea id={`${id}-desc`} rows={3} value={form.description} onChange={(e) => patch({ description: e.target.value })} aria-invalid={!!err("description")} />
        <small className={err("description") ? "field__err" : "field__hint"}>{err("description") ?? `${form.description.length}/2000`}</small>
      </div>

      <div className="form__cols">
        <TagInput id={`${id}-deps`} label="Allowed dependencies" value={form.policy.allowedDeps} onChange={(v) => patch({ policy: { ...form.policy, allowedDeps: v } })} placeholder="hono, zod…" error={err("policy.allowedDeps")} />
        <TagInput id={`${id}-hosts`} label="Allowed outbound hosts" value={form.policy.allowedHosts} onChange={(v) => patch({ policy: { ...form.policy, allowedHosts: v } })} placeholder="api.example.com…" error={err("policy.allowedHosts")} />
      </div>

      <fieldset className="field toggles">
        <legend>Environments</legend>
        <label className="toggle"><input type="checkbox" checked disabled /> <span>Preview <em>always on</em></span></label>
        <label className="toggle"><input type="checkbox" checked={form.environments.staging} onChange={(e) => patch({ environments: { ...form.environments, staging: e.target.checked } })} /> <span>Staging</span></label>
        <label className="toggle"><input type="checkbox" checked={form.environments.prod} onChange={(e) => patch({ environments: { ...form.environments, prod: e.target.checked } })} /> <span>Production <em>ships on a human tap</em></span></label>
      </fieldset>

      <div className="field">
        <label htmlFor={`${id}-fp`}>First prompt</label>
        <textarea id={`${id}-fp`} rows={4} value={form.firstPrompt} onChange={(e) => patch({ firstPrompt: e.target.value })} aria-invalid={!!err("firstPrompt")} />
        <small className={err("firstPrompt") ? "field__err" : "field__hint"}>{err("firstPrompt") ?? "Submitted to the merge train as soon as the hive exists."}</small>
      </div>

      <div className="field">
        <span className="label">Stack <em className="muted">(fixed for now)</em></span>
        <div className="tags tags--ro">
          <code className="tag">{form.stack.target}</code>
          <code className="tag">{form.stack.template}</code>
          <code className="tag">{form.stack.language}</code>
          <code className="tag">secrets: {form.secrets.join(", ")}</code>
        </div>
      </div>

      {submitted && errList.length > 0 && (
        <div className="notice notice--error" role="alert"><b>Fix {errList.length} field{errList.length > 1 ? "s" : ""} to continue</b><span>{errList.map(([k, m]) => `${k}: ${m}`).join(" · ")}</span></div>
      )}
      <ErrorNotice error={error} />
      <div className="form__actions">
        <button type="button" className="btn" onClick={props.onBack}>← Back to chat</button>
        <button type="submit" className="btn btn--primary btn--big" disabled={busy}>{busy ? "Saving…" : "Confirm charter →"}</button>
      </div>
    </form>
  );
}

// ── 3. connect cloudflare ──────────────────────────────────────────────

function Connect(props: { hive: string; state: WizardState; onConnected: () => void }) {
  const { hive } = props;
  const vault = props.state.vault;
  const [form, dispatch] = useReducer(connectReducer, initialConnect);
  const [touched, setTouched] = useState(false);
  const [help, setHelp] = useState(false);
  const [opening, setOpening] = useState(false);
  const [tplError, setTplError] = useState<unknown>(null);
  const id = useId();

  const status = form.status ?? vault;
  const connected = status?.connected === true;
  const v = validateConnect(form);
  const errs = !v.ok && touched && form.phase === "idle" ? v.errors : {};

  async function openCloudflare() {
    setOpening(true);
    setTplError(null);
    try {
      const { url } = await api.tokenTemplate();
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setTplError(e);
    } finally {
      setOpening(false);
    }
  }

  async function submit() {
    setTouched(true);
    if (!v.ok || form.phase === "submitting") return;
    const { accountId, apiToken } = v.payload;
    // Clear the token from state immediately, whatever the result.
    dispatch({ type: "submit" });
    try {
      const result = await api.connectCloudflare(hive, accountId, apiToken);
      dispatch({ type: "result", status: result });
      if (result.connected) props.onConnected();
    } catch (e) {
      const body = (e as { body?: { checks?: unknown } }).body;
      dispatch({ type: "error", message: errorMessage(e), status: body && Array.isArray(body.checks) ? (body as never) : null });
    }
  }

  return (
    <div className="wiz-grid wiz-grid--connect">
      <form className="panel form" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate autoComplete="off">
        <p className="eyebrow">STEP 3 · CONNECT CLOUDFLARE</p>
        <h2 className="form__title">Give your hive a place to deploy</h2>
        <p className="muted">QueenOS deploys previews, staging and production to <b>your</b> Cloudflare account. The token is stored encrypted and is never shown again. <button type="button" className="linkish" onClick={() => setHelp(true)}>What does it need?</button></p>

        {connected ? (
          <div className="connected" role="status">
            <span className="connected__tick">✓</span>
            <div>
              <b>Connected to account {lastFour(status!.accountId)} ✓</b>
              <p className="muted small">Token verified and stored in the vault. It cannot be read back.</p>
            </div>
          </div>
        ) : (
          <>
            <ol className="guide">
              <li>
                <button type="button" className="btn btn--primary" onClick={() => void openCloudflare()} disabled={opening}>
                  {opening ? "Opening…" : "Open Cloudflare to create a token ↗"}
                </button>
                <span className="muted small">The template is pre-filled with the permissions QueenOS needs.</span>
              </li>
              <li className="muted small">Copy your <b>Account ID</b> from the Cloudflare dashboard sidebar and the new token from the confirmation page.</li>
            </ol>
            <ErrorNotice error={tplError} />
            <div className="field">
              <label htmlFor={`${id}-acct`}>Account ID</label>
              <input id={`${id}-acct`} className="mono" value={form.accountId} onChange={(e) => dispatch({ type: "edit", field: "accountId", value: e.target.value })} placeholder="32 hex characters" spellCheck={false} autoComplete="off" autoCapitalize="none" aria-invalid={!!errs.accountId} />
              <small className="field__err">{errs.accountId}</small>
            </div>
            <div className="field">
              <label htmlFor={`${id}-tok`}>API token</label>
              <input id={`${id}-tok`} className="mono" type="password" name="cf-api-token" value={form.apiToken} onChange={(e) => dispatch({ type: "edit", field: "apiToken", value: e.target.value })} placeholder="Paste once; it is cleared after you submit" autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" aria-invalid={!!errs.apiToken} />
              <small className="field__err">{errs.apiToken}</small>
            </div>
            {form.error && <div className="notice notice--error" role="alert"><b>Could not verify</b><span>{form.error}</span></div>}
            <div className="form__actions">
              <button type="submit" className="btn btn--primary btn--big" disabled={form.phase === "submitting"}>
                {form.phase === "submitting" ? "Verifying…" : verificationFailed(status) ? "Try again" : "Verify & connect"}
              </button>
            </div>
          </>
        )}
        {connected && props.state.step === "CHARTER_READY" && (
          <div className="form__actions"><button type="button" className="btn btn--primary" onClick={props.onConnected}>Continue →</button></div>
        )}
      </form>

      <aside className="panel checks" aria-label="Verification checks" aria-live="polite">
        <p className="eyebrow">VERIFICATION</p>
        {form.phase === "submitting" ? (
          <p className="checks__wait"><span className="spinner" /> Checking the token against Cloudflare…</p>
        ) : status && status.checks.length ? (
          <ul className="checklist">
            {status.checks.map((c) => (
              <li key={c.name} className={c.ok ? "check check--ok" : "check check--bad"}>
                <span className="check__mark" aria-label={c.ok ? "passed" : "failed"}>{c.ok ? "✓" : "✗"}</span>
                <div><b>{c.name}</b>{c.detail && <p>{c.detail}</p>}</div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">After you submit, QueenOS verifies the token is active, matches the account, and can upload Workers.</p>
        )}
      </aside>
      {help && (
        <Modal title="Token permissions" onClose={() => setHelp(false)}>
          <p className="muted">The Cloudflare template pre-selects what a hive needs. Nothing else is requested.</p>
          <ul className="plain">
            <li><b>Account · Workers Scripts · Edit</b>: deploy preview, staging and production Workers.</li>
            <li><b>Account · Account Settings · Read</b>: confirm the token belongs to this account.</li>
          </ul>
          <p className="muted small">Press Escape to close.</p>
        </Modal>
      )}
    </div>
  );
}

// ── 4. launch ──────────────────────────────────────────────────────────

function Launch(props: { hive: string; state: WizardState; onState: (s: WizardState) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const parsed = CharterSchema.safeParse(props.state.charterDraft);
  const c = parsed.success ? parsed.data : null;

  async function launch() {
    setBusy(true);
    setError(null);
    try {
      props.onState(await api.launch(props.hive));
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <section className="panel launch">
      <p className="eyebrow">STEP 4 · LAUNCH</p>
      <h2 className="form__title">Ready for liftoff</h2>
      <dl className="summary">
        <div><dt>PROJECT</dt><dd>{c?.name ?? props.hive}</dd></div>
        <div><dt>HIVE</dt><dd><code>{props.hive}</code></dd></div>
        <div><dt>CLOUDFLARE</dt><dd>account {lastFour(props.state.vault?.accountId ?? null)} <span className="ok">✓ verified</span></dd></div>
        <div><dt>ENVIRONMENTS</dt><dd><Tags items={["preview", ...(c?.environments.staging === false ? [] : ["staging"]), ...(c?.environments.prod === false ? [] : ["prod"])]} empty="" /></dd></div>
        <div><dt>ALLOWED DEPS</dt><dd><Tags items={c?.policy.allowedDeps ?? []} empty="none" /></dd></div>
        <div className="summary__wide"><dt>FIRST PROMPT</dt><dd>{c ? <blockquote>{c.firstPrompt}</blockquote> : <span className="ph">n/a</span>}</dd></div>
      </dl>
      <p className="muted">Launching creates the repo, seeds the Worker starter, and submits your first prompt to the merge train.</p>
      <ErrorNotice error={error} />
      <button className="btn btn--launch" onClick={() => void launch()} disabled={busy}>
        {busy ? <><span className="spinner spinner--sm" /> Launching…</> : <>♛ Launch hive</>}
      </button>
    </section>
  );
}

// ── 5. first flight ────────────────────────────────────────────────────

function Flight({ hive, state }: { hive: string; state: WizardState }) {
  const items = timelineFor(state.step);
  return (
    <section className="panel flight">
      <p className="eyebrow">STEP 5 · FIRST FLIGHT</p>
      <h2 className="form__title">Your hive is waking up</h2>
      <p className="muted">The Queen is building your first version. This usually takes under a minute.</p>
      <ol className="timeline" aria-live="polite">
        {items.map((it) => (
          <li key={it.label} className={`tl tl--${it.state}`}>
            <span className="tl__dot">{it.state === "done" ? "✓" : it.state === "active" ? <span className="spinner spinner--sm" /> : ""}</span>
            <span className="tl__label">{it.label}</span>
            <span className="tl__state">{it.state === "done" ? "done" : it.state === "active" ? "in progress" : "waiting"}</span>
          </li>
        ))}
      </ol>
      <div className="form__actions">
        <Link to={hrefFor.warroom(hive)} className="btn btn--primary">Watch in the War Room →</Link>
      </div>
    </section>
  );
}

// ── 6. active ──────────────────────────────────────────────────────────

function Active({ hive, state }: { hive: string; state: WizardState }) {
  return (
    <section className="panel celebrate">
      <div className="celebrate__crown" aria-hidden="true">♛</div>
      <h2>Your hive is live</h2>
      <p className="muted">The first preview is deployed. The swarm is ready for more prompts.</p>
      {state.previewUrl && (
        <a className="celebrate__url" href={state.previewUrl} target="_blank" rel="noreferrer">{state.previewUrl.replace(/^https?:\/\//, "")} ↗</a>
      )}
      <div className="form__actions form__actions--center">
        <Link to={hrefFor.warroom(hive)} className="btn btn--primary btn--big">Open War Room →</Link>
        <Link to={hrefFor.home()} className="btn btn--big">All projects</Link>
      </div>
    </section>
  );
}

// ── 7. failed ──────────────────────────────────────────────────────────

function Failed(props: { hive: string; state: WizardState; onState: (s: WizardState) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEscape(() => setError(null), !!error);
  async function retry() {
    setBusy(true);
    setError(null);
    try {
      props.onState(await api.launch(props.hive));
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }
  return (
    <section className="panel failed">
      <p className="eyebrow">LAUNCH FAILED</p>
      <h2 className="form__title">Something went wrong creating the hive</h2>
      <pre className="failed__err">{props.state.lastError ?? "Unknown error"}</pre>
      <ErrorNotice error={error} />
      <div className="form__actions">
        <Link to={hrefFor.home()} className="btn">Back to projects</Link>
        <button className="btn btn--primary btn--big" onClick={() => void retry()} disabled={busy}>{busy ? "Retrying…" : "Retry launch"}</button>
      </div>
    </section>
  );
}
