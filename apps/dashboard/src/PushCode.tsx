import { useMemo, useRef, useState, type FormEvent } from "react";
import type { GitToken, GitTokenMintResult } from "@queenos/queen-types";

import { api, errorMessage, isAuthError } from "./api";
import { useResource } from "./hooks";
import { relativeTime } from "./lanes";
import { pushSteps, sortTokens, tokenApiUnavailable, tokenState } from "./pushLogic";
import { ErrorNotice } from "./shell";

// Mock mode answers no git-token API (and has no POST actions): show the instructions only.
const MOCK = import.meta.env.VITE_MOCK_API === "1";
const date = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/** Copy to the clipboard; false when the browser refuses (insecure context, permission). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ text, label = "Copy", onFail }: { text: string; label?: string; onFail?: () => void }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    if (await copyText(text)) {
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } else onFail?.();
  };
  return (
    <button type="button" className="btn push__copy" onClick={() => void copy()} aria-label={label}>
      {done ? "Copied" : label}
    </button>
  );
}

/** `/p/:hive/push`: mint and revoke git tokens, plus copyable clone and push instructions. */
export function PushCode({ hive, origin = window.location.origin }: { hive: string; origin?: string }) {
  const steps = useMemo(() => pushSteps(origin, hive), [origin, hive]);
  return (
    <div className="push">
      <section className="panel">
        <p className="eyebrow">PUSH CODE</p>
        <h2 className="push__title">Push to {hive} with plain git</h2>
        <p className="sh-muted">
          Every push is a Submission: the swarm gates it, queues it and lands it like drone code. A token is your git password; it acts as you
          (Access identity), lasts 30 days and can be revoked here at any time.
        </p>
      </section>
      {MOCK ? (
        <section className="panel">
          <p className="eyebrow">GIT TOKENS</p>
          <p className="sh-muted" role="status">Mock mode has no git-token API. Mint tokens on the deployed dashboard; the instructions below still apply.</p>
        </section>
      ) : (
        <Tokens />
      )}
      <section className="panel" aria-label="Instructions">
        <p className="eyebrow">INSTRUCTIONS</p>
        <ol className="push__steps">
          {steps.map((s) => (
            <li key={s.title}>
              <b>{s.title}</b>
              <div className="push__cmd">
                <pre><code>{s.cmd}</code></pre>
                <CopyButton text={s.cmd} label={`Copy ${s.title.toLowerCase()} command`} />
              </div>
              {s.note && <p className="sh-muted">{s.note}</p>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Tokens() {
  const list = useResource(() => api.gitTokens(), "git-tokens");
  // The secret lives only in this component's state: never logged, never persisted. Cleared on "Done" or unmount.
  const [minted, setMinted] = useState<GitTokenMintResult | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const now = Date.now();
  const tokens = useMemo(() => (list.data ? sortTokens(list.data, Date.now()) : []), [list.data]);

  const mint = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      setMinted(await api.mintGitToken(label.trim() || undefined));
      setLabel("");
      list.reload();
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  };

  if (list.error && !list.data) {
    if (isAuthError(list.error)) return <ErrorNotice error={list.error} />;
    return (
      <section className="panel">
        <p className="eyebrow">GIT TOKENS</p>
        {tokenApiUnavailable(list.error) ? (
          <p className="sh-muted" role="status">
            Git tokens are not available here ({errorMessage(list.error)}). The sim runs without the edge: mint tokens on the deployed dashboard.
          </p>
        ) : (
          <ErrorNotice error={list.error} onRetry={list.reload} />
        )}
      </section>
    );
  }

  return (
    <section className="panel" aria-label="Git tokens">
      <p className="eyebrow">GIT TOKENS{list.data ? ` (${tokens.filter((t) => tokenState(t, now) === "active").length} active)` : ""}</p>
      {minted ? (
        <NewToken minted={minted} onDone={() => setMinted(null)} />
      ) : (
        <form className="push__mint" onSubmit={(e) => void mint(e)}>
          <input type="text" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="label (optional), e.g. laptop" aria-label="Token label" />
          <button type="submit" className="btn btn--primary" disabled={busy}>{busy ? "Minting…" : "Mint token"}</button>
        </form>
      )}
      {Boolean(err) && <p className="sh-err" role="alert">{errorMessage(err)}</p>}
      {list.loading && !list.data ? (
        <p className="sh-muted">Loading tokens…</p>
      ) : tokens.length === 0 ? (
        <p className="sh-muted">No tokens yet.</p>
      ) : (
        <ul className="push__tokens">
          {tokens.map((t) => <TokenRow key={t.id} t={t} now={now} onRevoked={list.reload} />)}
        </ul>
      )}
    </section>
  );
}

function NewToken({ minted, onDone }: { minted: GitTokenMintResult; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [manual, setManual] = useState(false);
  return (
    <div className="push__new" role="status">
      <p className="push__warn">
        <b>Copy this token now.</b> It will not be shown again; only its hash is stored. Use it as the git password.
      </p>
      <div className="push__cmd">
        <input
          ref={input}
          className="push__secret"
          type="text"
          readOnly
          value={minted.token}
          aria-label="New git token"
          autoComplete="off"
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
        />
        <CopyButton
          text={minted.token}
          label="Copy token"
          onFail={() => {
            setManual(true);
            input.current?.select();
          }}
        />
      </div>
      {manual && <p className="sh-muted">Clipboard unavailable: the token is selected, press Cmd/Ctrl+C.</p>}
      <p className="sh-muted">
        {minted.label ? `"${minted.label}" · ` : ""}scopes {minted.scopes.join(", ")} · expires {date(minted.expiresAt)}
      </p>
      <button type="button" className="btn" onClick={onDone}>Done, hide it</button>
    </div>
  );
}

function TokenRow({ t, now, onRevoked }: { t: GitToken; now: number; onRevoked: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const state = tokenState(t, now);
  const revoke = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.revokeGitToken(t.id);
      onRevoked();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  return (
    <li className={`push__token push__token--${state}`}>
      <div className="push__token-main">
        <b>{t.label || <span className="sh-muted">no label</span>}</b>{" "}
        <span className={`chip chip--sm push__state--${state}`}>{state}</span>
        <p className="sh-muted">
          created {date(t.createdAt)} · last used {t.lastUsedAt ? relativeTime(t.lastUsedAt, now) : "never"} ·{" "}
          {state === "revoked" && t.revokedAt ? `revoked ${relativeTime(t.revokedAt, now)}` : `${state === "expired" ? "expired" : "expires"} ${date(t.expiresAt)}`} · {t.scopes.join(", ")}
        </p>
      </div>
      {state === "active" &&
        (confirm ? (
          <span className="push__actions">
            <button type="button" className="btn btn--danger" disabled={busy} onClick={() => void revoke()}>{busy ? "…" : "Confirm revoke"}</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(false)}>Keep</button>
          </span>
        ) : (
          <button type="button" className="btn btn--danger" onClick={() => setConfirm(true)}>Revoke</button>
        ))}
      {err && <p className="sh-err" role="alert">{err}</p>}
    </li>
  );
}
