import { Home } from "./Home";
import { NewProject } from "./NewProject";
import { Wizard } from "./Wizard";
import { WarRoom } from "./WarRoom";
import { Link, useRoute } from "./router";
import { hrefFor } from "./route";
import { Shell } from "./shell";

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
      return <WarRoom key={route.hive} hive={route.hive} backTo={route.legacy ? undefined : hrefFor.home()} />;
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
