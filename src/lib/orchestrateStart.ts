import { useExperimentalSettings } from "@/lib/experimentalSettings";

/**
 * Orchestrate (PRO-337): start a session that leads an orchestration run. It
 * starts exactly as an ordinary start does; its first prompt then asks the lead
 * to plan a run, and any run it stores waits for the person's Approve
 * (`orchestrateStart` on the session entry), whatever
 * `orchestrator.requireApproval` says.
 */

/** What the lead is asked when a person presses Plan a run, or starts with Orchestrate. The lead decides whether splitting helps at all. */
export const PLAN_A_RUN_PROMPT =
  "Plan an orchestration run for the task we are working on. First decide whether splitting it helps: do not split work whose steps each need the one before, or that fits in one session. If it does help, write the plan as a JSON file and store it with `terminalx runs create --from <plan.json> --json` (the plan's fields and rules are under \"Orchestration runs\" in `terminalx skills get terminalx-cli`). Then tell me the plan is ready and stop: I approve it in the Run view before any worker starts. If splitting does not help, say why and go on in this session.";

/** The Orchestrate button's tooltip: what it does, and that the run asks first. */
export const ORCHESTRATE_TITLE =
  "Start this session as an orchestration lead: it plans a run that splits the work across worker sessions. The run waits for your Approve before any worker starts.";

/** Where a start could lead a run: a session of a git project on this computer, not a cloud session, a quick chat or a compact window. */
export interface LeadPlace {
  local: boolean;
  git: boolean;
  cloud?: boolean;
  quick?: boolean;
  compact?: boolean;
}

/** Whether a start offers Orchestrate: Settings → Experimental → Orchestration runs is on, and the session could lead a run (`SessionView`'s `canLead` and `isGit`). */
export function orchestrateOffered(orchestratorRuns: boolean | undefined, place: LeadPlace): boolean {
  return orchestratorRuns === true && place.local && place.git && !place.cloud && !place.quick && !place.compact;
}

/** {@link orchestrateOffered}, kept current with the Experimental switch. A start that could never lead reads no setting. */
export function useOrchestrateOffered(place: LeadPlace): boolean {
  const possible = orchestrateOffered(true, place);
  return orchestrateOffered(useExperimentalSettings(possible)?.orchestratorRuns, place);
}

/** The first prompt of an Orchestrate start: everything the ordinary start sends, then the plan-a-run request, last. */
export function orchestratePrompt(prompt: string): string {
  const said = prompt.trim();
  return said ? `${said}\n\n${PLAN_A_RUN_PROMPT}` : PLAN_A_RUN_PROMPT;
}
