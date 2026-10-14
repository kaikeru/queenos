import { useEffect } from "react";
import { Home } from "./Home";
import { NewProject } from "./NewProject";
import { Wizard } from "./Wizard";
import { useRoom } from "./room";
import { StatusHome } from "./StatusHome";
import { GoalPage } from "./GoalPage";
import { QueuePage } from "./QueuePage";
import { TraceView } from "./TraceView";
import { EventLog } from "./EventLog";
import { Metrics } from "./Metrics";
import { PushCode } from "./PushCode";
import { Link, navigate, useRoute } from "./router";
import { hrefFor, type Route } from "./route";
import { isSimulation } from "./homeLogic";
import { HiveFooter, HiveHeader, Shell } from "./shell";

type HiveRoute = Extract<Route, { name: "warroom" }>;

/** One live room per hive: the socket and state persist while the user moves between its pages. */
function HiveRoot({ route }: { route: HiveRoute }) {
  const { hive, page } = route;
  const room = useRoom(hive);
  const { state, status, latencyMs } = room;
  const id = route.id ?? "";
  // The lanes page is gone: /p/<hive>/lanes renders home and swaps the URL.
  useEffect(() => {
    if (route.redirectTo) navigate(route.redirectTo, { replace: true });
  }, [route.redirectTo]);
  if (page === "status") return <StatusHome hive={hive} room={room} />;
  const crumbs: Record<string, { label: string }[]> = {
    queue: [{ label: "queue" }],
    item: [{ label: "goal" }],
    trace: [{ label: "trace" }, { label: id.slice(0, 8) }],
    events: [{ label: "events" }],
    metrics: [{ label: "metrics" }],
    push: [{ label: "push code" }],
  };
  return (
    <div className="app hive-page">
      {state.outdated && (
        <div className="update-banner" role="alert">
          <span>QueenOS was updated. Reload to get the latest dashboard</span>
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}
      <HiveHeader hive={hive} crumbs={crumbs[page]} status={status} latencyMs={latencyMs} sim={isSimulation(state.hive)} />
      {page === "queue" && <QueuePage hive={hive} state={state} />}
      {page === "item" && <GoalPage hive={hive} itemId={id} state={state} />}
      {page === "trace" && <TraceView hive={hive} traceId={id} state={state} />}
      {page === "events" && <EventLog hive={hive} state={state} />}
      {page === "metrics" && <Metrics hive={hive} state={state} />}
      {page === "push" && <PushCode hive={hive} />}
      <HiveFooter hive={hive} />
    </div>
  );
}

export function App() {
  const route = useRoute();
  switch (route.name) {
    case "home":
      return <Home />;
    case "new":
      return <NewProject />;
    case "setup":
      return <Wizard key={route.hive} hive={route.hive} />;
    case "warroom":
      return <HiveRoot key={route.hive} route={route} />;
    case "notfound":
      return (
        <Shell>
          <div className="empty">
            <h2>Page not found</h2>
            <p>{route.path}</p>
            <Link to={hrefFor.home()} className="btn btn--primary">Back to projects</Link>
          </div>
        </Shell>
      );
  }
}
