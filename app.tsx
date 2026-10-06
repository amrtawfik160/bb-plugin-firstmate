import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./rpc.ts";
import {
  isRoutineReasoningRow,
  paneTimelineNoiseDecision,
} from "./lib/timeline-noise.ts";
import "./app.css";
import { createFleetRefresh } from "./lib/fleet-refresh.ts";

type Fleet = {
  deliveries:Array<{ id:string;url:string;owner:string|null;status:string;blocker:string;nextAction:string;freshness:string;ownerNeeded:boolean;deliverySatisfiedAt?:number|null;workers:string[];failures:Array<{id:string;name:string;url:string;resolvedAt:number|null;accounting?:{scope:string;taskId:string;worker:string}}> }>;
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
  captain: boolean;
};

function useFleet(threadId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queue = useRef<ReturnType<typeof createFleetRefresh> | null>(null);
  useEffect(() => {
    let disposed = false;
    setFleet(null);
    setError(null);
    const refresh = createFleetRefresh(async () => {
      try {
        const value = await rpc.call("fleet", { threadId });
        if (!disposed) { setFleet(value); setError(null); }
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : "fleet failed");
      }
    });
    queue.current = refresh;
    refresh.refresh();
    return () => { disposed = true; refresh.dispose(); queue.current = null; };
  }, [rpc, threadId]);
  const load = useCallback(() => queue.current?.refresh(), []);
  useRealtime("fleet", load);
  return { fleet, error, load };
}

function FleetBoard() {
  const nav = useBbNavigate();
  const { threadId } = useBbContext();
  const { fleet, error, load } = useFleet(threadId);

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
      <h2>PR health and delivery</h2>
      {fleet.deliveries.length === 0 ? <p className="fm-muted">No pending PR health or delivery.</p> : <ul>{fleet.deliveries.map(r => <li key={r.id}>
        <a href={r.url}>{r.id}</a> [{r.status}{r.freshness === "stale" ? ", stale" : ""}{r.ownerNeeded ? ", owner needed" : ""}] Owner: {r.owner ? <button type="button" className="fm-link" onClick={() => nav.toThread(r.owner!)}>{r.owner}</button> : "unassigned"}.
        {" "}{r.deliverySatisfiedAt ? "Agreed delivery satisfied. " : ""}{r.blocker} Next: {r.nextAction}
        {(r.failures ?? []).filter(f=>f.resolvedAt===null).length>0 && <ul>{(r.failures ?? []).filter(f=>f.resolvedAt===null).map(f=><li key={f.id}>
          {f.url ? <a href={f.url}>{f.name}</a> : f.name}. {f.accounting ? `${f.accounting.scope} follow-up: ${f.accounting.taskId}` : "Unaccounted failure; inspect separately."}
          {" "}Worker: {f.accounting?.worker || r.workers.at(-1) ? <button type="button" className="fm-link" onClick={()=>nav.toThread((f.accounting?.worker ?? r.workers.at(-1))!)}>{f.accounting?.worker ?? r.workers.at(-1)}</button> : "unknown"}
        </li>)}</ul>}
      </li>)}</ul>}
      <h2>Ready to review</h2>
      {fleet.ready.length === 0 ? (
        <p className="fm-muted">Nothing waiting.</p>
      ) : (
        <ul>
          {fleet.ready.map((crew) => (
            <li key={crew.id}>
              {crew.threadId ? <button type="button" className="fm-link" onClick={() => nav.toThread(crew.threadId)}>
                {crew.id}
              </button> : <span>{crew.id}</span>}{" "}
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
              {crew.threadId ? <button type="button" className="fm-link" onClick={() => nav.toThread(crew.threadId)}>
                {crew.id}
              </button> : <span>{crew.id}</span>}{" "}
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

function HeaderChip({ threadId }: { threadId: string }) {
  const { fleet } = useFleet(threadId);
  if (!fleet?.captain) return null;
  const label = `${fleet.running.length} underway · ${fleet.ready.length} ready`;
  return <span className="fm-chip">{label}</span>;
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "quiet-captain-timeline",
    mount({ signal }) {
      const concealed = new Map<HTMLElement, { display: string; priority: string }>();
      let frame: number | null = null;
      // No settings hook exists yet, so live captain rows keep the hide path.
      const progressUi = false;

      const unconceal = (row: HTMLElement) => {
        const previous = concealed.get(row);
        if (previous === undefined) return;
        if (previous.display === "") row.style.removeProperty("display");
        else row.style.setProperty("display", previous.display, previous.priority);
        concealed.delete(row);
      };

      const restore = (row: HTMLElement) => {
        unconceal(row);
        if (row.hasAttribute("data-firstmate-timeline-noise")) {
          row.removeAttribute("data-firstmate-timeline-noise");
        }
      };

      const reconcile = () => {
        frame = null;
        const captainPanes = new Set(
          [...document.querySelectorAll<HTMLElement>(".fm-chip")]
            .map((chip) => chip.closest<HTMLElement>("[data-split-pane-id]"))
            .filter((pane): pane is HTMLElement => pane !== null),
        );
        for (const row of concealed.keys()) {
          if (!row.isConnected) concealed.delete(row);
        }
        for (const node of document.querySelectorAll<HTMLElement>("[data-timeline-row-id]")) {
          // Turn and bundle rows contain their child work rows. Only classify a
          // leaf so hiding one tool never removes the surrounding conversation.
          if (node.querySelector("[data-timeline-row-id]") !== null) {
            restore(node);
            continue;
          }
          const inCaptainPane = [...captainPanes].some((pane) => pane.contains(node));
          const text = node.textContent ?? "";
          const genericExpandableWork = inCaptainPane && (
            node.querySelector(
              'button[aria-label="Show details"], button[aria-label="Hide details"]',
            ) !== null || isRoutineReasoningRow(text)
          );
          const decision = paneTimelineNoiseDecision({
            text,
            inCaptainPane,
            genericExpandableWork,
            progressUi,
          });
          if (decision === "progress") {
            unconceal(node);
            if (node.getAttribute("data-firstmate-timeline-noise") !== "progress") {
              node.setAttribute("data-firstmate-timeline-noise", "progress");
            }
            continue;
          }
          if (decision !== "hide" || !inCaptainPane) {
            restore(node);
            continue;
          }
          if (!concealed.has(node)) {
            concealed.set(node, {
              display: node.style.getPropertyValue("display"),
              priority: node.style.getPropertyPriority("display"),
            });
          }
          if (node.getAttribute("data-firstmate-timeline-noise") !== "hidden") {
            node.setAttribute("data-firstmate-timeline-noise", "hidden");
          }
          if (
            node.style.getPropertyValue("display") !== "none" ||
            node.style.getPropertyPriority("display") !== "important"
          ) {
            node.style.setProperty("display", "none", "important");
          }
        }
      };

      const schedule = () => {
        if (frame !== null || signal.aborted) return;
        frame = window.requestAnimationFrame(reconcile);
      };
      const observer = new MutationObserver(schedule);
      // BB virtualizes timeline rows and can rewrite a row's style or identity
      // after it mounts. Watch those rewrites so routine work stays concealed.
      observer.observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "aria-label", "data-timeline-row-id"],
      });
      schedule();

      return () => {
        observer.disconnect();
        if (frame !== null) window.cancelAnimationFrame(frame);
        for (const row of [...concealed.keys()]) restore(row);
        for (const row of document.querySelectorAll<HTMLElement>("[data-firstmate-timeline-noise]")) {
          row.removeAttribute("data-firstmate-timeline-noise");
        }
      };
    },
  });
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
