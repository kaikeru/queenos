import { useEffect, useRef, type ReactNode } from "react";
import { api, errorMessage, isAuthError } from "./api";
import { SIM_BADGE_TEXT } from "./homeLogic";
import { attemptChipText, type OriginBadge } from "./origin";
import { useEscape, useResource } from "./hooks";
import { Link } from "./router";
import { hrefFor } from "./route";
import type { ConnStatus } from "./useQueenSocket";

/** Header shared by the projects home and the wizard: brand, crumbs, signed-in user. */
export function Shell(props: { crumbs?: { label: string; to?: string }[]; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  const me = useResource(api.me, "me");
  return (
    <div className="app shell">
      <header className="topbar">
        <Link to="/" className="brand brand--link" aria-label="QueenOS projects">
          <span className="brand__mark">♛</span>
          <div>
            <h1>QUEENOS</h1>
            <p>
              {props.crumbs?.length ? (
                props.crumbs.map((c, i) => (
                  <span key={i}>
                    {i > 0 && " / "}
                    <b>{c.label}</b>
                  </span>
                ))
              ) : (
                <>AUTONOMOUS GIT · <b>PROJECTS</b></>
              )}
            </p>
          </div>
        </Link>
        {props.actions}
        <div className="whoami" title={me.error ? errorMessage(me.error) : "Signed in via Cloudflare Access"}>
          <i className={me.data ? "whoami__dot whoami__dot--ok" : "whoami__dot"} />
          <span>{me.data ? me.data.email : me.error ? "not signed in" : "…"}</span>
        </div>
      </header>
      <div className="shell__body">{props.children}</div>
    </div>
  );
}

export function ErrorNotice(props: { error: unknown; onRetry?: () => void }) {
  if (!props.error) return null;
  const auth = isAuthError(props.error);
  return (
    <div className={`notice ${auth ? "notice--auth" : "notice--error"}`} role="alert">
      <b>{auth ? "Not signed in" : "Something went wrong"}</b>
      <span>{auth ? "Reload to sign in with Cloudflare Access." : errorMessage(props.error)}</span>
      {auth ? (
        <button className="btn" onClick={() => window.location.reload()}>Reload</button>
      ) : (
        props.onRetry && <button className="btn" onClick={props.onRetry}>Retry</button>
      )}
    </div>
  );
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(props.onClose);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => prev?.focus?.();
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal panel" role="dialog" aria-modal="true" aria-label={props.title} tabIndex={-1} ref={ref}>
        <div className="modal__head">
          <h2>{props.title}</h2>
          <button className="icon-btn" onClick={props.onClose} aria-label="Close">✕</button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

export function StatusChip({ status }: { status: string }) {
  return <span className={`chip chip--${status.toLowerCase()}`}>{status}</span>;
}

/** Status chip for a work-item status (WORK_STATUSES), reusing the train chip palette. */
export function ItemChip({ status, sub }: { status: string; sub?: string | null }) {
  return <span className={`chip chip--w-${status.toLowerCase()}`}>{sub ? `${status} · ${sub}` : status}</span>;
}

/** Whose code: drone, human:<email>, agent:<name>. */
export function OriginChip({ badge }: { badge: OriginBadge | null }) {
  if (!badge) return null;
  return (
    <span className={`chip chip--sm origin origin--${badge.kind}`} title={badge.title}>
      {badge.text}
      {badge.claim && <span className="origin__claim sh-muted"> claims {badge.claim}</span>}
      {badge.attempt && <span className="origin__attempt sh-muted"> · {attemptChipText(badge.attempt)}</span>}
    </span>
  );
}

/** Header for hive pages: brand, breadcrumbs, link state, page actions. */
export function HiveHeader(props: { hive: string; crumbs?: { label: string; to?: string }[]; status: ConnStatus; latencyMs: number | null; actions?: ReactNode; sim?: boolean }) {
  const label = props.status === "open" ? `linked${props.latencyMs !== null ? ` ${props.latencyMs}ms` : ""}` : props.status;
  return (
    <header className="hh">
      <Link to={hrefFor.home()} className="hh__brand" aria-label="QueenOS projects">
        <span className="brand__mark">♛</span>
        <b>QUEENOS</b>
      </Link>
      <nav className="hh__crumbs" aria-label="Breadcrumbs">
        <Link to={hrefFor.status(props.hive)}>{props.hive}</Link>
        {props.crumbs?.map((c, i) => (
          <span key={i}>
            {" / "}
            {c.to ? <Link to={c.to}>{c.label}</Link> : <b>{c.label}</b>}
          </span>
        ))}
      </nav>
      <div className="hh__right">
        {props.sim && <span className="sim-badge" role="status" title="This hive runs scripted executors, not real builds">{SIM_BADGE_TEXT}</span>}
        {props.actions}
        <div className={`conn conn--${props.status}`} role="status">
          <i />
          {label}
        </div>
      </div>
    </header>
  );
}

/** Drill-down links shown at the foot of every hive page. */
export function HiveFooter({ hive }: { hive: string }) {
  return (
    <footer className="hf">
      <Link to={hrefFor.status(hive)}>status ▸</Link>
      <Link to={hrefFor.queue(hive)}>queue ▸</Link>
      <Link to={hrefFor.events(hive)}>events ▸</Link>
      <Link to={hrefFor.metrics(hive)}>metrics ▸</Link>
      <Link to={hrefFor.push(hive)}>push code ▸</Link>
    </footer>
  );
}
