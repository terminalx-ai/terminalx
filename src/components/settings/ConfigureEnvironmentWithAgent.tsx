import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type AgentLoginProvider, type CloudWorkspace, type CloudWorkspaceProviderId } from "@/lib/api";
import { refreshCloudWorkspaces, useCloudCatalog } from "@/lib/cloudCatalog";
import { observationsBody, preparationPrompt, type PreparationRepository } from "@/lib/environmentProposal";
import { PREPARATION_LIMIT_MINUTES, PreparationError, machineSentence, offerPreparation, stopPreparation, type PreparationOffer, type PreparationPhase, type PreparationResult } from "@/lib/environmentPreparation";
import { cancelEnvironmentRun, clearEnvironmentRun, keepEnvironmentRunFor, retryEnvironmentRun, startEnvironmentRun, useEnvironmentRun } from "@/lib/environmentRun";
import { formatMicros, providerLabel } from "@/lib/organizationCompute";
import { checkSummary, environmentErrorMessage, organizationEnvironment, type EnvironmentStatus } from "@/lib/organizationEnvironment";
import { RecipeDetails } from "./EnvironmentRecipes";

const inputClass = "h-7 min-w-0 rounded-md border border-hairline bg-background px-2 text-xs disabled:opacity-60";
const areaClass = "min-h-16 rounded-md border border-hairline bg-background px-2 py-1 font-mono text-[11px] disabled:opacity-60";
const MAX_REPOSITORIES = 5;
const AGENT_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", cursor: "Cursor" };

/** `owner/name` or `owner/name@branch`, one per line. Null when a line is neither. */
export function parseRepositories(text: string): PreparationRepository[] | null {
  const repositories: PreparationRepository[] = [];
  for (const line of text.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
    const match = line.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:@(\S+))?$/);
    if (!match) return null;
    if (repositories.some((repository) => repository.owner.toLowerCase() === match[1].toLowerCase() && repository.name.toLowerCase() === match[2].toLowerCase())) return null;
    repositories.push({ owner: match[1], name: match[2], defaultBranch: match[3] ?? "main" });
  }
  return repositories;
}

function phaseText(phase: PreparationPhase): string {
  switch (phase.step) {
    case "creating":
      return "Starting the preparation machine…";
    case "connecting":
      return "Connecting to the preparation machine…";
    case "agent":
      return phase.waitingForPermission
        ? "The agent is waiting: for an answer from you, or it has been silent for a while. Open the preparation workspace from the sidebar to look."
        : "The agent is reading the repositories and working out the setup…";
    case "verifying":
      return `TerminalX is running the proposed commands itself. ${phase.detail}…`;
    case "stopping":
      return "Stopping the preparation machine…";
  }
}

// Before the start, the steps are this screen's own. From the start on, the
// run lives in `environmentRun`, so it outlasts this screen.
type Stage = { kind: "idle" } | { kind: "offering" } | { kind: "confirm"; offer: PreparationOffer } | { kind: "saved" };

/**
 * "Configure with an agent" (PRO-20), for owners and admins. It asks before a
 * machine starts and says what that costs; the agent proposes, TerminalX
 * checks, and the machine is stopped. What comes out is a recipe to review.
 * Saving it changes nothing: applying and building stay their own presses.
 */
export function ConfigureEnvironmentWithAgent({ status, organizationId, onSaved }: { status: EnvironmentStatus; organizationId: string | null; onSaved: () => void }) {
  const provider = status.provider as CloudWorkspaceProviderId;
  const [local, setStage] = useState<Stage>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const run = useEnvironmentRun();
  const [repositoryText, setRepositoryText] = useState("");
  const [agent, setAgent] = useState<AgentLoginProvider | "">("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [saving, setSaving] = useState(false);
  const [machineBusy, setMachineBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const startKey = useRef<string | null>(null);
  // Given to the agent to copy into its proposal, so a file that was already in a repository is not taken for its answer.
  const [token, setToken] = useState("");
  const mounted = useRef(true);
  const catalog = useCloudCatalog();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A run belongs to the account and organization it was started under.
  useEffect(() => keepEnvironmentRunFor(status.contextRevision), [status.contextRevision]);
  // Another provider is another environment: nothing of a half-made start carries over.
  useEffect(() => {
    setStage({ kind: "idle" });
    setError(null);
  }, [provider]);

  // A run for this provider takes the screen over; one for another provider only blocks a second start.
  const mine = run.kind !== "none" && run.provider === provider;
  const stage: Stage | { kind: "running"; phase: PreparationPhase } | { kind: "review"; result: PreparationResult; baseRevision: number } =
    mine && run.kind === "running" ? { kind: "running", phase: run.phase } : mine && run.kind === "review" ? { kind: "review", result: run.result, baseRevision: run.baseRevision } : local;
  const runMessage = mine && run.kind === "ended" ? run.message : null;
  const canRetry = mine && run.kind === "ended" && run.retry !== null;
  // A run or an unsaved proposal for another provider is not thrown away from here.
  const busyElsewhere = !mine && (run.kind === "running" || run.kind === "review");
  const refresh = () => void refreshCloudWorkspaces(organizationId).catch(() => undefined);

  const machines: CloudWorkspace[] = (organizationId ? (catalog.orgs[organizationId]?.workspaces ?? []) : [])
    .map((item) => item.workspace)
    .filter((workspace) => workspace.preparation && workspace.provider === provider && workspace.state !== "destroyed" && !workspace.deletedAt);

  const begin = async () => {
    if (busyElsewhere) return;
    clearEnvironmentRun();
    setError(null);
    setStage({ kind: "offering" });
    setRepositoryText((status.template?.definition.repositories ?? []).map((repository) => `${repository.owner}/${repository.name}@${repository.defaultBranch}`).join("\n"));
    try {
      const offer = await offerPreparation(provider);
      if (!mounted.current) return;
      setAgent(offer.agents[0] ?? "");
      startKey.current = crypto.randomUUID();
      setToken(crypto.randomUUID());
      setStage({ kind: "confirm", offer });
    } catch (failure) {
      if (!mounted.current) return;
      setError(failure instanceof PreparationError ? failure.message : "TerminalX could not price a preparation machine. Nothing was started.");
      setStage({ kind: "idle" });
    }
  };

  const repositories = parseRepositories(repositoryText);
  const repositoryProblem =
    repositories === null
      ? "Write one repository per line as owner/name, or owner/name@branch."
      : repositories.length === 0
        ? "Name at least one repository."
        : repositories.length > MAX_REPOSITORIES
          ? `A preparation machine takes at most ${MAX_REPOSITORIES} repositories.`
          : null;

  const start = (offer: PreparationOffer) => {
    if (!repositories || repositoryProblem || !agent || !startKey.current || !token) return;
    setError(null);
    const started = startEnvironmentRun(
      { offer: { ...offer, contextRevision: status.contextRevision }, agent, repositories, idempotencyKey: startKey.current, token },
      { baseRevision: status.template?.revision ?? 0, onChange: refresh },
    );
    if (!started) {
      setError("Another preparation run is in progress. Wait for it or cancel it first.");
      return;
    }
    startKey.current = null;
    setStage({ kind: "idle" });
  };

  const save = async (result: PreparationResult, baseRevision: number) => {
    setSaving(true);
    setError(null);
    try {
      await organizationEnvironment.proposeRecipe(
        provider,
        { baseRevision, definition: result.proposal.definition, observations: observationsBody(result.observations), sourceWorkspaceId: result.workspaceId },
        status.contextRevision,
      );
      clearEnvironmentRun();
      if (!mounted.current) return;
      setStage({ kind: "saved" });
      onSaved();
    } catch (failure) {
      if (mounted.current) setError(environmentErrorMessage(failure));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const machineAction = async (workspace: CloudWorkspace, action: "stop" | "delete") => {
    setMachineBusy(`${action}:${workspace.id}`);
    setError(null);
    try {
      if (action === "stop") {
        // Stop only ever stops. What the server answered is what is said.
        const outcome = await stopPreparation(workspace);
        if (outcome !== "stopping" && mounted.current) setError(machineSentence(outcome));
      } else await api.cloudWorkspaceDelete(workspace.id, true, workspace.orgId);
      setConfirmDelete(null);
    } catch {
      if (mounted.current) setError("TerminalX could not delete that machine. Try again.");
    } finally {
      if (mounted.current) setMachineBusy(null);
      void refreshCloudWorkspaces(organizationId).catch(() => undefined);
    }
  };

  const name = providerLabel(provider);

  return (
    <section className="mt-3 flex flex-col gap-1.5" aria-label="Configure with an agent">
      <div className="text-xs font-medium text-muted-foreground">Configure with an agent</div>
      {(error ?? runMessage) && (
        <p className="text-xs text-destructive" role="alert">
          {error ?? runMessage}
        </p>
      )}
      {canRetry && local.kind === "idle" && (
        <div>
          <Button size="xs" variant="outline" onClick={() => retryEnvironmentRun(refresh)}>
            Try again (the same machine, not a second one)
          </Button>
        </div>
      )}

      {stage.kind === "idle" && (
        <>
          <p className="text-[11px] text-muted-foreground">
            An agent reads your repositories on a temporary machine and proposes the machine script and each repository's setup. TerminalX then runs the proposed install, lint, test, build and start commands itself and records how each ended. You review the result as a recipe; nothing changes until you apply it.
          </p>
          <div>
            <Button size="sm" variant="outline" className="h-7" disabled={busyElsewhere} onClick={() => void begin()}>
              Configure with an agent…
            </Button>
            {busyElsewhere && <span className="ml-2 text-[11px] text-muted-foreground">{run.kind === "running" ? "A preparation run for another provider is in progress." : "A proposal for another provider is waiting to be saved or discarded there."}</span>}
          </div>
        </>
      )}

      {stage.kind === "offering" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Checking the price and the running limit. Nothing is started yet.
        </div>
      )}

      {stage.kind === "confirm" && (
        <div className="flex flex-col gap-2 rounded-md border border-hairline p-2" aria-label="Before the machine starts">
          <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px]">
            <li>
              This starts a cloud machine on the organization's {name} account. {name} bills that account for it: about {formatMicros(stage.offer.quote.activeHourlyMicros, stage.offer.quote.currency)} an hour
              {stage.offer.quote.pricing === "estimate" ? " (an estimate)" : ""}, plus what the agent's own usage costs.
            </li>
            <li>
              It counts toward the running limit: {stage.offer.running} of {stage.offer.runningLimit} are running now.
            </li>
            <li>
              It is stopped when the agent and the checks have finished, when you cancel, or after {PREPARATION_LIMIT_MINUTES} minutes, whichever comes first. The server enforces the {PREPARATION_LIMIT_MINUTES} minutes even if this app is closed.
            </li>
            <li>The machine is private to you and is given none of the organization's configured secrets. A check that needs one will fail and be reported as failing.</li>
            <li>The organization's login for the agent you choose, and read access to the repositories you name, are placed on the machine for the agent to use.</li>
            <li>The agent runs with permissions bypassed and reads whatever the repositories contain. Name only repositories you trust.</li>
          </ul>
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            Repositories (one per line: owner/name, or owner/name@branch)
            <textarea aria-label="Repositories to prepare" className={areaClass} value={repositoryText} onChange={(event) => setRepositoryText(event.target.value)} />
          </label>
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            Agent
            <select aria-label="Agent" className={inputClass} value={agent} onChange={(event) => setAgent(event.target.value as AgentLoginProvider)}>
              {stage.offer.agents.map((option) => (
                <option key={option} value={option}>
                  {AGENT_LABEL[option] ?? option}
                </option>
              ))}
            </select>
          </label>
          <div>
            <Button size="xs" variant="ghost" aria-expanded={showPrompt} onClick={() => setShowPrompt(!showPrompt)}>
              {showPrompt ? "Hide what the agent is asked" : "Show what the agent is asked"}
            </Button>
            {showPrompt && repositories && repositories.length > 0 && (
              <pre className="mt-1 whitespace-pre-wrap break-words rounded-md bg-well px-2 py-1 font-mono text-[11px]" aria-label="What the agent is asked">
                {preparationPrompt(repositories, token)}
              </pre>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className="h-7" disabled={Boolean(repositoryProblem) || !agent} onClick={() => start(stage.offer)}>
              Start the machine
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setStage({ kind: "idle" })}>
              Cancel
            </Button>
            {repositoryProblem && <span className="text-[11px] text-destructive">{repositoryProblem}</span>}
          </div>
        </div>
      )}

      {stage.kind === "running" && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-hairline p-2" role="status">
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          <p className="min-w-0 flex-1 text-[11px]">{phaseText(stage.phase)}</p>
          <Button size="xs" variant="outline" disabled={stage.phase.step === "stopping"} onClick={cancelEnvironmentRun}>
            Cancel and stop the machine
          </Button>
        </div>
      )}

      {stage.kind === "review" && (
        <div className="flex flex-col gap-3 rounded-md border border-hairline p-2" aria-label="Proposed recipe">
          <p className="text-[11px]">
            The agent's proposal, against the current template (revision {stage.baseRevision}). {machineSentence(stage.result.machine)} {checkSummary(stage.result.observations)}
          </p>
          {stage.result.sources
            .filter((source) => source.agentCheckout === "differs")
            .map((source) => (
              <p key={`${source.owner}/${source.name}`} className="text-[11px] text-amber-600 dark:text-amber-400" role="note">
                The agent's own copy of {source.owner}/{source.name} had commits or changed files that are not on GitHub. They were not checked: the results below are for {source.branch} as GitHub has it
                {source.commit ? ` (${source.commit.slice(0, 12)})` : ""}.
              </p>
            ))}
          <RecipeDetails definition={stage.result.proposal.definition} observations={stage.result.observations} current={status.template?.definition ?? null} />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className="h-7" disabled={saving} onClick={() => void save(stage.result, stage.baseRevision)}>
              {saving ? <Loader2 className="animate-spin" /> : "Save as a recipe"}
            </Button>
            <Button size="sm" variant="ghost" className="h-7" disabled={saving} onClick={clearEnvironmentRun}>
              Discard
            </Button>
            <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">Saving stores the proposal for review. It does not change the template and builds nothing.</span>
          </div>
        </div>
      )}

      {stage.kind === "saved" && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-[11px]" role="status">
            Saved as a recipe below. Apply it to change the template, then build a version; each is its own step.
          </p>
          <Button size="xs" variant="ghost" onClick={() => setStage({ kind: "idle" })}>
            Done
          </Button>
        </div>
      )}

      {machines.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="Preparation machines">
          {machines.map((workspace) => {
            const expired = (workspace.preparation?.stopAfter ?? 0) <= Date.now();
            const running = workspace.state === "ready" || workspace.state === "provisioning";
            return (
              <li key={workspace.id} className="rounded-md border border-hairline p-2 text-[11px]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="font-medium">Preparation machine</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {workspace.name} · {running ? (expired ? "being stopped" : `running, stopped by ${new Date(workspace.preparation!.stopAfter).toLocaleTimeString()}`) : workspace.state === "suspended" ? "stopped" : workspace.state}
                    </span>
                  </span>
                  <span className="flex gap-2">
                    {workspace.state === "ready" && (
                      <Button size="xs" variant="outline" disabled={Boolean(machineBusy)} onClick={() => void machineAction(workspace, "stop")}>
                        {machineBusy === `stop:${workspace.id}` ? <Loader2 className="animate-spin" /> : "Stop"}
                      </Button>
                    )}
                    {confirmDelete !== workspace.id && (
                      <Button size="xs" variant="ghost" disabled={Boolean(machineBusy)} onClick={() => setConfirmDelete(workspace.id)}>
                        Delete…
                      </Button>
                    )}
                  </span>
                </div>
                {!running && <p className="mt-1 text-muted-foreground">A preparation machine cannot be started again after its time limit. Delete it when you no longer need what is on it.</p>}
                {confirmDelete === workspace.id && (
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <p className="min-w-0 flex-1">Delete this preparation machine and everything on it? Saved recipes are kept.</p>
                    <Button size="xs" disabled={Boolean(machineBusy)} onClick={() => void machineAction(workspace, "delete")}>
                      {machineBusy === `delete:${workspace.id}` ? <Loader2 className="animate-spin" /> : "Delete"}
                    </Button>
                    <Button size="xs" variant="ghost" disabled={Boolean(machineBusy)} onClick={() => setConfirmDelete(null)}>
                      Cancel
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
