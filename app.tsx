import { useEffect, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./rpc.ts";
import "./app.css";

type Fleet = {
  head: string;
  calls: string[];
  landed: string[];
  ready: Array<{
    id: string;
    status: string;
    shape: string;
    task: string;
    threadId: string;
    prUrl: string;
  }>;
  running: Array<{
    id: string;
    status: string;
    shape: string;
    task: string;
    threadId: string;
    prUrl: string;
  }>;
  next: string[];
  afk: boolean;
  quiet: boolean;
  supervision: boolean;
};

function FleetBoard() {
  const rpc = useRpc<typeof rpcContract>();
  const nav = useBbNavigate();
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setFleet(await rpc.call("fleet", null));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "fleet failed");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useRealtime("fleet", () => {
    void load();
  });

  if (error !== null && fleet === null) {
    return <p className="fm-muted">{error}</p>;
  }
  if (fleet === null) {
    return <p className="fm-muted">Loading fleet…</p>;
  }

  return (
    <div className="fm-board">
      <header className="fm-head">
        <strong>Fleet</strong>
        <span className="fm-muted">
          {fleet.afk ? "AFK · " : ""}
          {fleet.quiet ? "quiet · " : ""}
          {fleet.supervision ? "supervision on" : "supervision off"}
        </span>
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
      </header>
      <p>{fleet.head}</p>
      <Section title="Captain's Call" items={fleet.calls} empty="Nothing needs you." />
      <Section title="Recently Landed" items={fleet.landed} empty="No recent completions." />
      <h2>Ready to review</h2>
      {fleet.ready.length === 0 ? (
        <p className="fm-muted">Nothing waiting.</p>
      ) : (
        <ul>
          {fleet.ready.map((crew) => (
            <li key={crew.id}>
              <button type="button" className="fm-link" onClick={() => nav.toThread(crew.threadId)}>
                {crew.id}
              </button>{" "}
              [{crew.shape}] {crew.task}
              {crew.prUrl !== "" ? (
                <>
                  {" "}
                  · <a href={crew.prUrl}>{crew.prUrl}</a>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <h2>Underway</h2>
      {fleet.running.length === 0 ? (
        <p className="fm-muted">Nothing underway.</p>
      ) : (
        <ul>
          {fleet.running.map((crew) => (
            <li key={crew.id}>
              <button type="button" className="fm-link" onClick={() => nav.toThread(crew.threadId)}>
                {crew.id}
              </button>{" "}
              [{crew.status}] {crew.task}
            </li>
          ))}
        </ul>
      )}
      <Section title="Charted Next" items={fleet.next} empty="Nothing queued." />
    </div>
  );
}

function Section({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <>
      <h2>{title}</h2>
      {items.length === 0 ? (
        <p className="fm-muted">{empty}</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function HeaderChip() {
  const rpc = useRpc<typeof rpcContract>();
  const [label, setLabel] = useState("Fleet");

  useEffect(() => {
    void rpc.call("fleet", null).then((fleet) => {
      setLabel(`${fleet.running.length} underway · ${fleet.ready.length} ready`);
    });
  }, [rpc]);

  useRealtime("fleet", () => {
    void rpc.call("fleet", null).then((fleet) => {
      setLabel(`${fleet.running.length} underway · ${fleet.ready.length} ready`);
    });
  });

  return <span className="fm-chip">{label}</span>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "fleet",
    title: "Fleet",
    icon: "Ship",
    path: "fleet",
    component: FleetBoard,
  });
  app.slots.experimental_threadHeaderAction({
    id: "fleet-chip",
    title: "Fleet",
    component: HeaderChip,
  });
});
