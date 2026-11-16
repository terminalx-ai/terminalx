import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import { refreshAccount, useAccount } from "@/lib/account";
import { defaultOrgId } from "@/lib/cloudCatalog";
import { FLOW_LABELS, FLOW_STEPS, flowOf, moveFlow, type CloudSetupTarget, type FlowStep } from "@/lib/cloudSetupFlow";
import { hasEscapeOverlay, useHotkey } from "@/lib/hotkeys";
import { loadSetups, newSetup, saveSetup, setupFor, type OrganizationSetupRecord } from "@/lib/organizationSetup";
import { cn } from "@/lib/cn";
import { LeaveGuardContext, type LeaveGuard } from "./FlowLayout";
import { OrganizationStep } from "./OrganizationStep";
import { GithubStep } from "./GithubStep";
import { ComputeStep } from "./ComputeStep";
import { LoginsStep } from "./LoginsStep";
import { EnvironmentStep } from "./EnvironmentStep";
import { InviteStep } from "./InviteStep";
import type { StepProps } from "./stepProps";

/** Fields, and controls that take Enter themselves, keep it: the step's main button does not. */
const OWNS_ENTER = "input, textarea, select, button, a, [contenteditable=''], [contenteditable='true'], [role='listbox'], [role='menu']";

/**
 * The full-window cloud setup (PRO-370, Superdesign 12.01–12.07): create an
 * organization, then connect GitHub, compute and agent logins, build the
 * environment and invite the team. Progress is kept on the organization's
 * setup record as the person goes, so "Finish later" (or Esc) returns to
 * Settings and the organization's row there resumes at the same step.
 *
 * Every step after the first acts on the organization being set up, which
 * the service keeps as the person's selected organization: it is selected
 * before those steps are shown, and they are never shown for another.
 */
export function CloudSetupFlow({ target, onExit, onDone }: { target: CloudSetupTarget; onExit: () => void; onDone: () => void }) {
  const { status } = useAccount();
  const email = status.identity?.email ?? "";
  const revision = status.context?.revision ?? "";
  const memberships = status.organizations ?? [];
  const [records, setRecords] = useState<OrganizationSetupRecord[]>(() => (email ? loadSetups(email) : []));
  const [organizationId, setOrganizationId] = useState<string | null>(target.kind === "resume" ? target.organizationId : null);
  const persist = useCallback(
    (next: OrganizationSetupRecord) => {
      if (!email) return;
      saveSetup(email, next);
      setRecords(loadSetups(email));
    },
    [email],
  );
  // A creation asked for and not yet answered is resumed, never asked for twice.
  const creation = records.find((record) => !record.organizationId) ?? null;
  const organization = organizationId ? memberships.find((org) => org.id === organizationId) : undefined;
  const record = organizationId ? setupFor(records, organizationId) : creation;

  // An organization resumed without a record of this flow (set up from an older version, or on another Mac) gets one.
  useEffect(() => {
    if (!organization || record || !email) return;
    persist({ ...newSetup(organization.name, crypto.randomUUID()), organizationId: organization.id, step: "compute", flow: { step: "github", passed: ["organization"], finishedAt: null } });
  }, [organization, record, email, persist]);

  const step: FlowStep = organization && record ? (flowOf(record)?.step ?? "github") : "organization";
  const passed = new Set<FlowStep>(organization ? [...(flowOf(record)?.passed ?? []), "organization"] : []);

  // The steps after the first act on the selected organization: select this one first.
  const active = defaultOrgId(status);
  const [selecting, setSelecting] = useState<{ error: string | null } | null>(null);
  const selectFlight = useRef(false);
  const select = useCallback(async () => {
    if (!organization || selectFlight.current) return;
    selectFlight.current = true;
    setSelecting({ error: null });
    try {
      await api.organizationSelect(organization.id, revision);
      await refreshAccount();
      setSelecting(null);
    } catch (failure) {
      setSelecting({ error: errorMessage(failure) });
    } finally {
      selectFlight.current = false;
    }
  }, [organization, revision]);
  const needsSelection = Boolean(organization && step !== "organization" && active !== organization.id);
  useEffect(() => {
    if (needsSelection && !selecting) void select();
  }, [needsSelection, selecting, select]);

  // A step that holds the person back (the Environment step's unbuilt changes) is asked before any way out.
  const guard = useRef<LeaveGuard | null>(null);
  const registerGuard = useCallback((next: LeaveGuard | null) => {
    guard.current = next;
  }, []);
  const leave = useCallback((action: () => void) => {
    if (guard.current && !guard.current(action)) return;
    action();
  }, []);

  const go = (next: FlowStep) => {
    if (!record || !organization || next === step) return;
    leave(() => persist(moveFlow(record, next)));
  };
  const goNext = () => {
    const next = FLOW_STEPS[FLOW_STEPS.indexOf(step) + 1];
    if (next) go(next);
  };
  const finishLater = () => leave(onExit);

  useHotkey("escape", () => {
    if (hasEscapeOverlay()) return false;
    finishLater();
  });

  // Enter presses the step's main button, unless a field or another control has the focus.
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const handle = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.defaultPrevented || event.isComposing || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
      const from = event.target instanceof Element ? event.target : null;
      if (from?.closest(OWNS_ENTER) || hasEscapeOverlay()) return;
      const primary = node.querySelector<HTMLButtonElement>("[data-cloud-setup-primary]");
      if (!primary || primary.disabled) return;
      event.preventDefault();
      primary.click();
    };
    node.addEventListener("keydown", handle);
    return () => node.removeEventListener("keydown", handle);
  }, []);

  const created = (id: string) => {
    if (email) setRecords(loadSetups(email));
    setOrganizationId(id);
  };

  const gone = organizationId !== null && status.state === "signed-in" && !organization;
  const props: StepProps | null =
    organization && record ? { organization, record, onRecord: persist, accountEmail: email, contextRevision: revision, onContinue: goNext } : null;

  return (
    <LeaveGuardContext.Provider value={registerGuard}>
      <main ref={root} className="relative flex h-full min-w-0 flex-1 bg-background" aria-label="Cloud setup" data-testid="cloud-setup-flow" data-step={step}>
        <div data-tauri-drag-region="deep" className="absolute inset-x-0 top-0 h-(--titlebar-h)" />
        <Button variant="ghost" size="sm" className="absolute top-1.5 right-3 z-10 text-[12.5px]" onClick={finishLater}>
          Finish later
        </Button>
        <nav aria-label="Setup steps" className="mt-[72px] ml-7 w-[220px] shrink-0">
          <div className="mb-4 flex items-center gap-2 px-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-[6px] bg-foreground font-mono text-[9px] font-bold text-background" aria-hidden>
              {">_"}
            </span>
            <span className="text-[12.5px] text-muted-foreground">Cloud setup</span>
          </div>
          <ol className="grid gap-0.5">
            {FLOW_STEPS.map((name, index) => {
              const current = name === step;
              const done = passed.has(name) && !current;
              const reachable = Boolean(props) && name !== "organization";
              return (
                <li key={name}>
                  <button
                    type="button"
                    disabled={!reachable || current}
                    aria-current={current ? "step" : undefined}
                    onClick={() => go(name)}
                    className={cn(
                      "flex h-8 w-full items-center gap-3 rounded-md px-3 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                      current ? "bg-selected font-medium text-foreground" : "text-muted-foreground",
                      reachable && !current && "hover:bg-veil-raised hover:text-foreground",
                    )}
                  >
                    <span className="grid w-3.5 place-items-center">
                      {done ? <Check className="size-3.5 text-add" aria-label="done" /> : <span className={cn("text-[12px]", current ? "font-medium" : "text-faint")}>{index + 1}</span>}
                    </span>
                    {FLOW_LABELS[name]}
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="mt-6 px-3 text-[11.5px] leading-[17px] text-faint">Progress is saved as you go. Esc returns to Settings.</p>
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto pt-[72px] pr-10 pb-16 pl-[132px] max-xl:pl-16">
          {gone ? (
            <div role="status" className="max-w-[660px] text-sm text-muted-foreground">
              You are no longer a member of this organization, so its setup cannot go on here.
              <div className="mt-4">
                <Button size="sm" variant="outline" onClick={onExit}>
                  Back to Settings
                </Button>
              </div>
            </div>
          ) : step === "organization" || !props ? (
            <OrganizationStep accountEmail={email} contextRevision={revision} creation={creation} onRecord={persist} onCreated={created} />
          ) : needsSelection ? (
            <div role="status" className="flex max-w-[660px] items-center gap-2 text-sm text-muted-foreground">
              {selecting?.error ? (
                <>
                  <span className="text-destructive">
                    {props.organization.name} could not be selected: {selecting.error}
                  </span>
                  <Button size="sm" variant="outline" onClick={() => void select()}>
                    Try again
                  </Button>
                </>
              ) : (
                <>
                  <Loader2 className="size-4 animate-spin" /> Selecting {props.organization.name}…
                </>
              )}
            </div>
          ) : step === "github" ? (
            <GithubStep key={`${organizationId}:${revision}`} {...props} />
          ) : step === "compute" ? (
            <ComputeStep key={`${organizationId}:${revision}`} {...props} />
          ) : step === "logins" ? (
            <LoginsStep key={`${organizationId}:${revision}`} {...props} />
          ) : step === "environment" ? (
            <EnvironmentStep key={`${organizationId}:${revision}`} {...props} />
          ) : (
            <InviteStep key={`${organizationId}:${revision}`} {...props} onDone={onDone} />
          )}
        </div>
      </main>
    </LeaveGuardContext.Provider>
  );
}
