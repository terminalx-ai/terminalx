import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles/app.css";
import { TeamSurfaceExamples, type TeamPreviewData } from "./TeamSurfaceExamples";
import { surfaceStatuses } from "./teamSurfaceStates";
import type { SurfaceStatus } from "@/components/ui/SurfaceState";
import type { Presence } from "@/components/ui/avatar";

const inputClass = "min-h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-foreground";

function TeamDesign() {
  const [state, setState] = useState<"ready" | SurfaceStatus>("empty");
  const [mode, setMode] = useState("dark");
  const [canAct, setCanAct] = useState(false);
  const [names, setNames] = useState("");
  const [presence, setPresence] = useState<Presence>("unknown");
  const [values, setValues] = useState({ workspace: "", organization: "", plan: "", automation: "", port: "", remotePort: "" });
  const [forwardState, setForwardState] = useState<"forwarded" | "opening" | "closed">("closed");
  const [details, setDetails] = useState({ email: "", role: "", joined: "", seats: "", payer: "", nextCharge: "", trigger: "", runs: "", lastRun: "", nextRun: "", created: "" });
  const [lastAction, setLastAction] = useState("No preview action yet.");
  const port = Number(values.port);
  const remotePort = Number(values.remotePort);
  const data: TeamPreviewData = { ...values, forwardState, remotePort: Number.isInteger(remotePort) && remotePort >= 1 && remotePort <= 65535 ? remotePort : null, profile: { email: details.email, role: details.role, joined: details.joined }, billing: { seats: details.seats, payer: details.payer, nextCharge: details.nextCharge }, schedule: { trigger: details.trigger, runs: details.runs, lastRun: details.lastRun, nextRun: details.nextRun, created: details.created }, people: names.split("\n").map((name) => name.trim()).filter(Boolean).map((name, i) => ({ id: String(i), name, presence })), port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null };
  return (
    <main className="h-full overflow-auto bg-background p-4 text-foreground sm:p-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-2"><h1 className="text-lg font-semibold">Team surface design review</h1><p className="max-w-3xl text-sm text-muted-foreground">PRO-248 · Development fixture. Enter local labels to inspect ready layouts; no customer data is bundled, stored or sent. Buttons report a preview action only. Product approval and actual feature integration remain separate.</p><a href="#surfaces" className="text-sm underline focus-visible:outline-2 focus-visible:outline-foreground">Skip review controls</a></header>
        <fieldset className="grid grid-cols-1 gap-3 rounded-xl border border-hairline p-4 sm:grid-cols-3"><legend className="px-1 text-sm font-medium">Review controls</legend>
          <label className="space-y-1 text-xs">Surface state<select className={inputClass} value={state} onChange={(e) => setState(e.target.value as typeof state)}>{["ready", ...surfaceStatuses].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label className="space-y-1 text-xs">Appearance<select className={inputClass} value={mode} onChange={(e) => { setMode(e.target.value); document.body.dataset.mode = e.target.value; }}><option>dark</option><option>light</option></select></label>
          <label className="space-y-1 text-xs">Presence supplied by caller<select className={inputClass} value={presence} onChange={(e) => setPresence(e.target.value as Presence)}>{["unknown", "online", "away", "offline"].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label className="space-y-1 text-xs">Names for this preview (one per line)<textarea className={inputClass} value={names} onChange={(e) => setNames(e.target.value)} autoComplete="off" /></label>
          {(Object.keys(values) as (keyof typeof values)[]).map((key) => <label key={key} className="space-y-1 text-xs">{key === "remotePort" ? "Workspace port for this preview (1–65535)" : key === "port" ? "Local port for this preview (1–65535)" : `${key[0].toUpperCase()}${key.slice(1)} label for this preview`}<input name={key} className={inputClass} value={values[key]} onChange={(e) => setValues({ ...values, [key]: e.target.value })} autoComplete="off" inputMode={(key === "port" || key === "remotePort") ? "numeric" : "text"} /></label>)}
          <label className="space-y-1 text-xs">Forward state supplied by caller<select className={inputClass} value={forwardState} onChange={(e) => setForwardState(e.target.value as typeof forwardState)}><option value="closed">Forward ended</option><option value="opening">Opening</option><option value="forwarded">Forwarded</option></select></label>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={canAct} onChange={(e) => setCanAct(e.target.checked)} />Caller allows preview actions</label>
        </fieldset>
        <details className="rounded-xl border border-hairline p-4"><summary className="text-sm font-medium focus-visible:outline-2 focus-visible:outline-foreground">Optional returned details for ready designs</summary><p className="my-2 text-xs text-muted-foreground">Supply display-ready values locally. Prices, currencies, dates, roles and plan limits are not invented by this fixture.</p><div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{(Object.keys(details) as (keyof typeof details)[]).map((key) => <label key={key} className="space-y-1 text-xs">{key.replace(/([A-Z])/g, " $1")}<input name={key} className={inputClass} value={details[key]} onChange={(e) => setDetails({ ...details, [key]: e.target.value })} autoComplete="off" /></label>)}</div></details>
        <p role="status" aria-atomic="true" className="text-xs text-muted-foreground">{lastAction}</p>
        <div id="surfaces" tabIndex={-1}><TeamSurfaceExamples data={data} state={state} canAct={canAct} onAction={(action) => setLastAction(`Preview action: ${action}. No external action was taken.`)} /></div>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<TeamDesign />);
