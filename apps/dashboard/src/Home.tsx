import type { Project } from "@queenos/queen-types";
import { api } from "./api";
import { useResource } from "./hooks";
import { Link } from "./router";
import { hrefFor } from "./route";
import { ErrorNotice, Shell, StatusChip } from "./shell";

/** ACTIVE projects open the War Room; everything else resumes in the wizard. */
export function projectHref(p: Pick<Project, "hive" | "status">): string {
  return p.status === "ACTIVE" ? hrefFor.warroom(p.hive) : hrefFor.setup(p.hive);
}

const host = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/$/, "");

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function ProjectCard({ p }: { p: Project }) {
  const links = (["prod", "staging", "preview"] as const).filter((k) => p.urls[k]);
  const cta = p.status === "ACTIVE" ? "Open War Room" : p.status === "FAILED" ? "Fix & retry" : "Continue setup";
  return (
    <article className={`pcard pcard--${p.status.toLowerCase()}`}>
      <Link to={projectHref(p)} className="pcard__main">
        <div className="pcard__top">
          <h2>{p.name}</h2>
          <StatusChip status={p.status} />
        </div>
        <code className="pcard__slug">{p.hive}</code>
        <p className="pcard__desc">{p.description || "No charter yet. Pick up where you left off."}</p>
        <div className="pcard__foot">
          <span>updated {ago(p.updatedAt)}</span>
          <span className="pcard__cta">{cta} →</span>
        </div>
      </Link>
      {links.length > 0 && (
        <ul className="pcard__links">
          {links.map((k) => (
            <li key={k}>
              <span className="pcard__env">{k}</span>
              <a href={p.urls[k]!} target="_blank" rel="noreferrer">{host(p.urls[k]!)}</a>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

export function Home() {
  const projects = useResource(api.projects, "projects");
  const list = projects.data ?? [];
  return (
    <Shell
      actions={
        <Link to={hrefFor.new()} className="btn btn--primary btn--big">
          ＋ New project
        </Link>
      }
    >
      <div className="page-head">
        <h2>Your projects</h2>
        <p className="muted">Each project is a hive: a repo, a merge train and a swarm of drones. Start one and the Queen takes it from there.</p>
      </div>
      <ErrorNotice error={projects.error} onRetry={projects.reload} />
      {projects.loading && !projects.data ? (
        <div className="pgrid" aria-busy="true" aria-label="Loading projects">
          {[0, 1, 2].map((i) => <div key={i} className="pcard pcard--skeleton" />)}
        </div>
      ) : !projects.error && list.length === 0 ? (
        <div className="empty">
          <h2>No projects yet</h2>
          <p>Describe what you want to build and QueenOS will spin up a hive for it.</p>
          <Link to={hrefFor.new()} className="btn btn--primary btn--big">＋ New project</Link>
        </div>
      ) : (
        <div className="pgrid">
          {list.map((p) => <ProjectCard key={p.hive} p={p} />)}
        </div>
      )}
    </Shell>
  );
}
