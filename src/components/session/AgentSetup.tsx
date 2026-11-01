import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { READINESS_LABELS, type AgentReadiness } from "@/lib/agentReadiness";
import type { HarnessInfo } from "@/types/session";

/** The same setup instructions at first launch and in Settings → Agents. */
export function AgentSetup({ harness, value, checking, onRefresh }: {
  harness: HarnessInfo;
  value: AgentReadiness | null;
  checking: boolean;
  onRefresh: () => void;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const state = value?.state ?? (harness.available ? "unknown" : "missing");
  const command = state === "missing" ? harness.installHint : harness.id === "codex" ? "codex login" : "claude auth login";
  return <section aria-label={`${harness.name} setup`} className="min-w-0 rounded-lg bg-well p-3 text-xs">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span role="status" className="font-medium">{checking ? "Checking installation and login…" : READINESS_LABELS[state]}</span>
      {value?.version && <span className="text-muted-foreground">{harness.name} {value.version}</span>}
      {value?.checkedAt && <time dateTime={value.checkedAt} className="text-faint">Checked {new Date(value.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}
      <Button type="button" size="xs" variant="ghost" disabled={checking} onClick={onRefresh}>Check again</Button>
    </div>
    {harness.path && <p className="mt-1 break-all font-mono text-[11px] text-faint">{harness.path}</p>}
    {state === "ready" ? <p className="mt-1 text-muted-foreground">Local login found. Provider access and model availability are checked when you run a task.</p> : <>
      <p className="mt-2 text-muted-foreground">{state === "missing"
        ? "Open a terminal and run this command to install the provider's CLI with npm, then sign in. npm must already be installed."
        : state === "signed_out" ? `Open a terminal and run this command to sign in to ${harness.name}.`
        : "The login could not be verified. You can continue if your CLI already works, or sign in and check again."}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="min-w-0 break-all rounded bg-background px-2 py-1">{command}</code>
        <Button type="button" size="xs" variant="outline" onClick={() => {
          void copyText(command).then(() => setCopyStatus("Copied"), () => setCopyStatus("Could not copy. Select the command to copy it."));
        }}>Copy command</Button>
        <Button type="button" size="xs" variant="ghost" onClick={() => void openUrl(harness.installUrl)}>Setup guide</Button>
        {copyStatus && <span role="status">{copyStatus}</span>}
      </div>
      <p className="mt-2 text-faint">A TerminalX account is optional for local work. This signs in to the agent provider.</p>
    </>}
  </section>;
}
