import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Cloud, Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import { refreshAccount, useAccount } from "@/lib/account";
import { defaultOrgId } from "@/lib/cloudCatalog";
import { creatableProviders } from "@/lib/hiddenProviders";
import { hasEscapeOverlay } from "@/lib/hotkeys";
import { organizationGithubApp } from "@/lib/organizationGithubApp";
import { loadSetups, newSetup, saveSetup, setupFor, type OrganizationSetupRecord } from "@/lib/organizationSetup";
import { selectCloudWorkspace } from "@/lib/sessions";
import { cloudWorkspaceKey } from "@/types/target";
import { ComputerColorPicker } from "./ComputerColorPicker";
import { OrganizationAgentLogins, agentLoginUsable } from "./OrganizationAgentLogins";
import { OrganizationGithubApp } from "./OrganizationGithubApp";
import { OrganizationOnboarding } from "./OrganizationOnboarding";
import { OrganizationSetupSteps } from "./OrganizationSetupSteps";
import { ProviderControls } from "./ProviderControls";

const STEPS = ["Get started", "Cloud computer", "Connect GitHub", "Agents", "You're all set"];

/** The same organization controls, given a whole window and an explicit finish. */
export function CloudSetupFlow({ organizationId, onExit, onFinish }: { organizationId: string | null; onExit: () => void; onFinish: () => void }) {
  const { status } = useAccount();
  const email = status.identity?.email ?? "";
  const revision = status.context?.revision ?? "";
  const organizations = status.organizations ?? [];
  const [target, setTarget] = useState(organizationId ?? defaultOrgId(status));
  const org = organizations.find((item) => item.id === target);
  const manager = org?.role === "owner" || org?.role === "admin";
  const [creating, setCreating] = useState(!org);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [record, setRecord] = useState<OrganizationSetupRecord | null>(() => setupFor(loadSetups(email), target));
  const primary = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const root = useRef<HTMLElement>(null);
  const current = useRef({ email, target, revision });
  current.current = { email, target, revision };
  const persist = (next: OrganizationSetupRecord) => { saveSetup(email, next); setRecord(next); };

  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => {
    setRecord(setupFor(loadSetups(email), target));
    setStep(0);
    setError(null);
  }, [email, target]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || hasEscapeOverlay()) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); onExit(); }
      if (event.key === "Enter" && !event.shiftKey && root.current?.contains(event.target as Node) && !(event.target as HTMLElement).closest("textarea,select,button,a,[contenteditable=true],input")) {
        event.preventDefault(); primary.current?.click();
      }
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [onExit]);

  const next = async () => {
    if (flight.current || !org || !manager) return;
    flight.current = true; setBusy(true); setError(null);
    const identity = current.current;
    try {
      if (defaultOrgId(status) !== org.id) {
        await api.organizationSelect(org.id, revision);
        await refreshAccount();
      }
      // Existing compute/GitHub controls act on the selected organization. Never render
      // them before selection has succeeded, and recheck facts when continuing.
      if (step === 1 && !creatableProviders((await api.cloudProviders()).providers).length)
        throw new Error("Connect a provider and allow new machines to continue.");
      if (step === 2 && !(await organizationGithubApp.summary()).repositories.some((repository) => repository.state === "accessible" && repository.cloneUrl))
        throw new Error("Connect GitHub and select at least one accessible repository to continue.");
      if (step === 3) {
        const logins = (await api.cloudAgentLogins(org.id)).credentials;
        if (!logins.some(agentLoginUsable)) throw new Error("Connect at least one agent to continue.");
      }
      if (current.current.email !== identity.email || current.current.target !== identity.target) return;
      const kept = record ?? { ...newSetup(org.name, crypto.randomUUID()), organizationId: org.id, step: "compute" as const };
      persist(step === 3 ? { ...kept, logins: "connected" } : kept);
      setStep((value) => Math.min(value + 1, STEPS.length - 1));
    } catch (failure) { if (current.current.email === identity.email && current.current.target === identity.target) setError(errorMessage(failure)); }
    finally { flight.current = false; setBusy(false); }
  };

  const ready = record?.step === "done" && record.workspace?.id;
  return <main ref={root} className="flex h-full min-w-0 flex-1 flex-col bg-background" aria-label="Cloud setup" data-testid="cloud-setup-flow">
    <header data-tauri-drag-region="deep" className="flex h-(--titlebar-h) shrink-0 items-center gap-2 border-b border-hairline pl-[78px] pr-4">
      <Button variant="ghost" size="sm" onClick={onExit}><ArrowLeft /> Settings</Button>
      <span className="ml-auto text-xs text-muted-foreground">Esc to Settings</span>
    </header>
    <div className="min-h-0 flex-1 overflow-auto px-6 py-10">
      <div className="mx-auto max-w-2xl">
        <ol aria-label="Setup progress" className="mb-10 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
          {STEPS.map((label, index) => <li key={label} aria-current={index === step ? "step" : undefined} className={index === step ? "font-medium text-foreground" : ""}>
            {index < step ? <Check className="mr-1 inline size-3" aria-label="Complete" /> : `${index + 1}. `}{label}
          </li>)}
        </ol>
        <Cloud className="mb-4 size-8 text-accent" />
        <h1 tabIndex={-1} ref={heading} className="mb-3 text-3xl font-semibold tracking-tight outline-none">{STEPS[step]}</h1>
        <p className="mb-6 text-sm text-muted-foreground">{step === 0 ? "Give your team a cloud computer, connect its repositories, and sign in your agents." : org?.name}</p>
        {step === 0 && <div className="space-y-4">
          {!creating && <>
            <label className="block text-sm">Organization<select aria-label="Setup organization" className="mt-2 block h-9 w-full rounded-md border border-hairline bg-background px-2" value={target ?? ""} onChange={(event) => setTarget(event.target.value)}>
              {organizations.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.role})</option>)}
            </select></label>
            {!manager && <p role="status" className="text-sm">An owner or administrator can finish cloud setup for this organization.</p>}
            <Button variant="ghost" onClick={() => setCreating(true)}>Create another organization</Button>
          </>}
          {creating && <OrganizationOnboarding organizationName={null} organizationId={null} accountEmail={email} contextRevision={revision} organizations={organizations} startWithCreation
            onCreated={(id) => { setTarget(id); setCreating(false); }} />}
        </div>}
        {step > 0 && org && manager && defaultOrgId(status) === org.id && <>
          {step === 1 && <div className="space-y-5"><ComputerColorPicker organizationId={org.id} name={org.name} /><ProviderControls contextRevision={revision} /></div>}
          {step === 2 && <OrganizationGithubApp contextRevision={revision} />}
          {step === 3 && <OrganizationAgentLogins contextRevision={revision} organizationId={org.id} organizationName={org.name} reveal={false} />}
          {step === 4 && record && <>
            <p className="mb-4 text-sm text-muted-foreground">Create your setup workspace to check the environment. Your first message will be an editable draft; you choose when to send it.</p>
            <OrganizationSetupSteps key={`${email}:${org.id}:${revision}`} record={record} organizationId={org.id} organizationName={org.name} contextRevision={revision} onRecord={persist} guided />
          </>}
        </>}
        {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
        <footer className="mt-8 flex items-center gap-3 border-t border-hairline pt-5">
          {step > 0 && <Button variant="ghost" disabled={busy} onClick={() => { setStep(step - 1); setError(null); }}>Back</Button>}
          {step < 4 ? <Button ref={primary} disabled={busy || creating || !manager} onClick={() => void next()}>{busy && <Loader2 className="animate-spin" />}Continue</Button>
            : <Button ref={primary} disabled={!ready} onClick={() => { if (ready && org) { selectCloudWorkspace(cloudWorkspaceKey(org.id, ready)); onFinish(); } }}>Go to workspaces</Button>}
          <span className="text-xs text-muted-foreground">↵ continues</span>
        </footer>
      </div>
    </div>
  </main>;
}
