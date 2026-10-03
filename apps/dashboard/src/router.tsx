import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { matchRoute, type Route } from "./route";

const EVENT = "queenos:navigate";

function subscribe(cb: () => void): () => void {
  window.addEventListener("popstate", cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(EVENT, cb);
  };
}

const snapshot = () => window.location.pathname + window.location.search;

/** Tiny History API router: the current route, re-rendering on navigation. */
export function useRoute(): Route {
  const loc = useSyncExternalStore(subscribe, snapshot);
  const q = loc.indexOf("?");
  return matchRoute(q < 0 ? loc : loc.slice(0, q), q < 0 ? "" : loc.slice(q));
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (to === snapshot()) return;
  if (opts.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(EVENT));
  window.scrollTo(0, 0);
}

export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target === "_blank") return;
    e.preventDefault();
    navigate(to);
  };
  return <a {...rest} href={to} onClick={handle} />;
}
