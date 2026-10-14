import { useCallback, useMemo, useState } from "react";
import { HiveFooter } from "./shell";
import { DEMO_PROMPTS } from "./demo";
import { Composer, Lanes, LedgerPanel, MainTrack, ModelBoard, ReleaseTimeline, Sites, Ticker, TopBar } from "./components";
import { isExternal } from "./homeLogic";
import { currentRelease, siteReleaseView } from "./releases";
import { buildLanes, buildSites, type AuditCard, type Lane } from "./reducer";
import type { Room } from "./room";

/** The lanes drill-down (today's War Room): lanes, release timeline, Sites, Model Board, ticker. */
export function WarRoom({ hive, room, backTo }: { hive: string; room: Room; backTo?: string }) {
  const { state, dispatch, status, latencyMs, retryAt, send } = room;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [swarming, setSwarming] = useState(false);

  const lanes = useMemo(() => buildLanes(state), [state]);
  const sites = useMemo(() => buildSites(state), [state.deployments]);
  const release = useMemo(() => currentRelease(state), [state.releases, state.releaseOrder]);
  const siteView = useMemo(() => siteReleaseView(state), [state.releases, state.releaseOrder, state.verdicts, state.canaryPeak]);
  const closeLedger = useCallback(() => setSelectedKey(null), []);
  // Re-resolve the open card from live state so a RUNNING card updates in place.
  const selected = useMemo<{ card: AuditCard; lane: Lane } | null>(() => {
    if (!selectedKey) return null;
    for (const lane of lanes) {
      const card = lane.cards.find((c) => c.key === selectedKey);
      if (card) return { card, lane };
    }
    return null;
  }, [lanes, selectedKey]);

  const submit = useCallback(
    (promptText: string) => {
      if (!send({ type: "submit_prompt", prompt: { namespace: hive, promptText } })) {
        dispatch({ type: "system", text: "Not linked to the Queen; prompt not sent.", at: Date.now() });
      }
    },
    [send, hive],
  );

  const swarm = useCallback(async () => {
    setSwarming(true);
    for (const text of DEMO_PROMPTS) {
      submit(text);
      await new Promise((r) => setTimeout(r, 250)); // keep queue order readable on screen
    }
    setSwarming(false);
  }, [submit]);

  return (
    <div className="app">
      {state.outdated && (
        <div className="update-banner" role="alert">
          <span>QueenOS was updated. Reload to get the latest War Room</span>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
      <TopBar hive={hive} status={status} latencyMs={latencyMs} retryAt={retryAt} state={state} backTo={backTo} />
      <MainTrack landed={state.landed} state={state} />
      <ReleaseTimeline hive={hive} state={state} release={release} />
      <div className="layout">
        <main className="layout__lanes">
          <Lanes lanes={lanes} selected={selectedKey} onSelect={(card) => setSelectedKey(card.key)} />
        </main>
        <aside className="layout__side">
          <Composer disabled={status !== "open"} onSubmit={submit} onSwarm={() => void swarm()} swarming={swarming} external={isExternal(state.hive)} />
          <Sites rows={sites} state={state} view={siteView} />
          {!isExternal(state.hive) && <ModelBoard stats={state.modelStats} floor={state.routerFloor} />}
          <Ticker items={state.ticker} />
        </aside>
      </div>
      {selected && <LedgerPanel card={selected.card} lane={selected.lane} onClose={closeLedger} />}
      <HiveFooter hive={hive} />
    </div>
  );
}
