import { useRef, useState } from "react";
import { LoaderCircle } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/api";
import { usePickerModels } from "@/lib/cloudModels";
import type { CloudSessionModel } from "@/lib/cloudSession";
import { cn } from "@/lib/cn";
import { useModels } from "@/lib/models";
import type { TabEntry } from "@/types/session";

/**
 * Continue a machine session's tab in a new agent tab of the same session,
 * on the machine (`machine/10`, PRO-408). The context is read on the machine
 * (`session.prepareContinuation`), the new tab is added there and sent the
 * prompt; its agent reads the machine's own transcript. Nothing of the
 * conversation is read on this computer, and nothing is started here.
 *
 * The agent and model are the machine's (its `agents/1` list); they start as
 * the source tab's.
 */
export function MachineContinuationDialog({ cloud, source, onClose }: { cloud: CloudSessionModel; source: TabEntry; onClose: () => void }) {
  const name = cloud.machine?.name ?? "the machine";
  const { models } = usePickerModels(useModels(), true, cloud.client);
  const agents = cloud.agents;
  const [agent, setAgent] = useState(() => (agents.some((candidate) => candidate.id === source.harness) ? source.harness : (agents[0]?.id ?? source.harness)));
  const own = models.filter((model) => model.harness === agent);
  const sameAgent = agent === source.harness;
  const [chosenModel, setChosenModel] = useState<string | null>(null);
  // The source's model while the agent is the source's; otherwise the machine's default for that agent.
  const model = chosenModel ?? (sameAgent && source.model ? source.model : (own.find((candidate) => candidate.isDefault)?.id ?? own[0]?.id ?? ""));
  const [context, setContext] = useState<"focused" | "full">("focused");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);
  const blocked = cloud.continueBlocked ?? (cloud.continueInNewTab ? null : `${name} runs an older TerminalX. Update it to use Continue in a new tab from here.`);

  const start = async () => {
    if (once.current || blocked || !cloud.continueInNewTab) return;
    once.current = true;
    setStarting(true);
    setError(null);
    try {
      await cloud.continueInNewTab({
        sourceTabId: source.id,
        agent,
        model: model || undefined,
        // The source's effort and mode carry over to the same agent and model; another starts at its defaults.
        effort: sameAgent && model === source.model ? (source.effort ?? null) : null,
        mode: source.permissionMode || undefined,
        context,
      });
      onClose();
    } catch (cause) {
      // Nothing was added when the context could not be read; a failure after that leaves the new tab to look at.
      setError(errorMessage(cause));
      once.current = false;
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !starting) onClose(); }}>
      <DialogContent width="max-w-[30rem]" className="p-6" showClose={!starting}>
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Continue in a New Tab</DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            Opens a new agent tab in this session on {name} that carries over this tab's context. Its agent reads the conversation there; this tab stays open.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-5 flex flex-col gap-3" role="group" aria-label="New tab settings">
          <label className="flex flex-col gap-1.5 text-xs font-medium">
            Agent
            <select aria-label="Agent" className="h-8 rounded-md border bg-background px-2 text-xs" disabled={starting} value={agent} onChange={(event) => { setAgent(event.target.value); setChosenModel(null); }}>
              {agents.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium">
            Model
            <select aria-label="Model" className="h-8 rounded-md border bg-background px-2 text-xs" disabled={starting} value={model} onChange={(event) => setChosenModel(event.target.value)}>
              {/* The source's model stays choosable even when the machine's list has not named it yet. */}
              {model && !own.some((candidate) => candidate.id === model) && <option value={model}>{model}</option>}
              {!model && <option value="">The agent's default</option>}
              {own.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
            </select>
          </label>
          <fieldset disabled={starting} className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-xs font-medium text-foreground">Context</legend>
            <div className="grid h-8 grid-cols-2 gap-0.5 rounded-md bg-veil-raised p-0.5 text-xs">
              <Choice checked={context === "focused"} onChange={() => setContext("focused")} label="Recent context" />
              <Choice checked={context === "full"} onChange={() => setContext("full")} label="Full transcript" />
            </div>
            <p className="text-xs text-faint">
              {context === "focused"
                ? "Recent status and the workspace; older history is read only when needed."
                : `Reads the whole saved history on ${name} first: slower, and uses more context.`}
            </p>
          </fieldset>
        </div>
        {blocked && <p role="note" className="mt-4 text-xs text-muted-foreground" data-testid="machine-continue-blocked">{blocked}</p>}
        {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
        <DialogFooter className="mt-6">
          <Button variant="ghost" disabled={starting} onClick={onClose}>Cancel</Button>
          <Button disabled={starting || !!blocked || !agents.length} onClick={() => void start()}>
            {starting ? <><LoaderCircle className="size-4 animate-spin" />Starting…</> : "Continue in New Tab"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One side of a two-way choice drawn as a segmented control; a real radio underneath. */
function Choice({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className={cn("flex cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40", checked && "bg-card text-foreground shadow-sm")}>
      <input type="radio" name="machine-continuation-mode" checked={checked} onChange={onChange} className="sr-only" />
      {label}
    </label>
  );
}
