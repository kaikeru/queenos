import { useCallback, useMemo, useReducer, useState } from "react";
import { DEMO_PROMPTS } from "./demo";
import { Composer, Lanes, LedgerPanel, MainTrack, Sites, Ticker, TopBar } from "./components";
import { buildLanes, buildSites, initialState, reducer, type AuditCard, type Lane } from "./reducer";
import { useQueenSocket } from "./useQueenSocket";

export function WarRoom({ hive, backTo }: { hive: string; backTo?: string }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { status, latencyMs, retryAt, send } = useQueenSocket(hive, dispatch);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [swarming, setSwarming] = useState(false);

  const lanes = useMemo(() => buildLanes(state), [state]);
  const sites = useMemo(() => buildSites(state), [state.deployments]);
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
      <TopBar hive={hive} status={status} latencyMs={latencyMs} retryAt={retryAt} state={state} backTo={backTo} />
      <MainTrack landed={state.landed} state={state} />
      <div className="layout">
        <main className="layout__lanes">
          <Lanes lanes={lanes} selected={selectedKey} onSelect={(card) => setSelectedKey(card.key)} />
        </main>
        <aside className="layout__side">
          <Composer disabled={status !== "open"} onSubmit={submit} onSwarm={() => void swarm()} swarming={swarming} />
          <Sites rows={sites} state={state} />
          <Ticker items={state.ticker} />
        </aside>
      </div>
      {selected && <LedgerPanel card={selected.card} lane={selected.lane} onClose={closeLedger} />}
    </div>
  );
}
