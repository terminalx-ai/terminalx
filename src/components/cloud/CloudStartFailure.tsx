import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "@/icons";
import { Button } from "@/components/ui/button";
import { getAccount, useAccount } from "@/lib/account";
import { issues, type CloudWorkspaceListItem } from "@/lib/api";
import { blankIdentity, findCloudWorkspace, getCloudCatalog, refreshCloudCatalog, repositoryOf, resumeCloudWorkspace } from "@/lib/cloudCatalog";
import { workspaceAuthority } from "@/lib/cloudCollab";
import { resuming, lifecycleErrorMessage } from "@/lib/cloudLifecycle";
import { resolveCloudStartFailure, startRecoveryAvailable } from "@/lib/cloudStartFailure";
import { errorCode } from "@/lib/cloudTerminals";
import { detailsScope } from "@/lib/cloudWorkspaceDetails";
import { managesOrganization } from "@/lib/multiOrg";
import { openAgentLogins, openOrganizationSettings, openSettingRow } from "@/lib/settingsLinks";
import { getSessionStore, startCloudSessionIn, startSessionIn, useSessionStore } from "@/lib/sessions";
import { cloudProjectKey } from "@/types/target";
import { normalizeRepositoryIdentity } from "@terminalx/portable/repositoryIdentity";

type Failure = NonNullable<ReturnType<typeof resolveCloudStartFailure>>;

export function CloudStartFailure({ item, failure, onInspect, onDiagnostics }: {
  item: CloudWorkspaceListItem;
  failure: Failure | null;
  onInspect: () => void;
  onDiagnostics?: () => void;
}) {
  const { workspace, latestOperation } = item;
  const { status } = useAccount();
  const admin = managesOrganization(status, workspace.orgId) === true;
  const scope = detailsScope();
  const { projects } = useSessionStore();
  const identity = failure ? repositoryOf(item, getCloudCatalog().createMemory)?.identity : null;
  const [local, setLocal] = useState<{ scope: string; identity: string; projects: typeof projects; path: string } | null>(null);
  useEffect(() => {
    if (!identity?.startsWith("github.com/")) return;
    let active = true;
    const candidates = projects.filter((project) => project.kind !== "folder" && !project.archived);
    void Promise.all(candidates.map(async ({ path }) => {
      const repo = await issues.githubRepo(path).catch(() => null);
      return repo && normalizeRepositoryIdentity(`github.com/${repo}`) === identity ? path : null;
    })).then((matches) => {
      if (!active || detailsScope() !== scope || !startRecoveryAvailable(getAccount().status, workspace.orgId)) return;
      const path = matches.find(Boolean);
      setLocal(path ? { scope, identity, projects, path } : null);
    });
    return () => { active = false; };
  }, [identity, projects, scope, workspace.orgId]);

  const localPath = local?.scope === scope && local.identity === identity && local.projects === projects ? local.path : null;
  const pending = useRef(false);
  const mounted = useRef(false);
  const shownFailure = useRef(failure);
  shownFailure.current = failure;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [retrying, setRetrying] = useState(false);
  const [retry, setRetry] = useState<{ operationId: string; code: string } | null>(null);
  const [error, setError] = useState<{ operationId: string; updatedAt: number; message: string } | null>(null);
  const current = () => {
    if (!mounted.current || detailsScope() !== scope || !startRecoveryAvailable(getAccount().status, workspace.orgId)) return null;
    const latest = findCloudWorkspace(getCloudCatalog(), workspace.orgId, workspace.id);
    return latest?.workspace.you?.role === "none" ? null : latest;
  };

  const retryResume = async () => {
    const latest = current();
    const failed = latest && resolveCloudStartFailure(latest);
    const operation = latest?.latestOperation;
    if (pending.current || !failure?.retryResume || !failed?.retryResume || failed.attention.code !== failure.attention.code
      || !latest || !operation || operation.id !== latestOperation?.id || operation.updatedAt !== latestOperation.updatedAt) return;
    pending.current = true;
    setRetrying(true);
    setError(null);
    setRetry(null);
    try {
      await resumeCloudWorkspace(latest);
      const accepted = current()?.latestOperation;
      if (accepted?.action === "resume" && accepted.id !== operation.id) {
        setRetry({ operationId: accepted.id, code: failed.attention.code });
      }
      if (current()) await refreshCloudCatalog(workspace.orgId);
    } catch (e) {
      if (current()) setError({ operationId: operation.id, updatedAt: operation.updatedAt, message: lifecycleErrorMessage(errorCode(e)) });
    } finally {
      pending.current = false;
      if (current()) setRetrying(false);
    }
  };

  const openLocal = async () => {
    if (!localPath || !identity || !current()) return;
    // A checkout can have moved or changed remotes since the card was shown.
    const repo = await issues.githubRepo(localPath).catch(() => null);
    const latest = current();
    if (!latest || !shownFailure.current || !resolveCloudStartFailure(latest) || repositoryOf(latest, getCloudCatalog().createMemory)?.identity !== identity) return;
    if (!getSessionStore().projects.some((project) => project.path === localPath && project.kind !== "folder" && !project.archived)
      || !repo || normalizeRepositoryIdentity(`github.com/${repo}`) !== identity) {
      setLocal((match) => match?.path === localPath ? null : match);
      return;
    }
    startSessionIn(localPath, null);
  };

  if (retrying || (resuming(item) && latestOperation?.transportAction !== "restart")) {
    return <p role="status" className="shrink-0 border-b border-hairline px-4 py-3 text-xs text-muted-foreground">Resuming workspace…</p>;
  }
  if (!failure) return null;
  const repeated = retry && latestOperation?.action === "resume" && latestOperation.state === "failed"
    && latestOperation.id === retry.operationId && latestOperation.errorCode === retry.code;
  const retryError = error && latestOperation?.id === error.operationId && latestOperation.updatedAt === error.updatedAt ? error.message : null;
  const { attention } = failure;
  const signIn = attention.recovery.action === "open-agent-logins";
  const provider = attention.recovery.action === "open-provider-settings";
  const createAgain = attention.recovery.action === "create-workspace" && workspaceAuthority(workspace).lifecycle;
  return (
    <section aria-label={failure.title} data-testid="cloud-start-failure" className="max-h-full min-h-0 min-w-0 overflow-y-auto border-b border-hairline bg-well px-4 py-3 text-xs">
      <div role="status" className="flex min-w-0 items-start gap-2.5">
        <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 space-y-1 wrap-break-word">
          <h2 className="text-sm font-medium text-foreground">{failure.title}</h2>
          <p>{attention.message}</p>
          <p className="text-muted-foreground">
            {failure.githubAccess ? "An organization owner or admin can grant this repository access in Settings → Organizations → GitHub." : attention.recovery.instructions}
          </p>
          {failure.retryResume && <p className="text-muted-foreground">Retrying resumes this workspace. Check the session before sending your first message again.</p>}
          {localPath && workspace.launch?.hasPrompt !== false && <p className="text-muted-foreground">To continue on this Mac, enter your message in the new session.</p>}
          {(retryError || repeated) && <p role="alert" className="text-destructive">Couldn't retry the workspace. {retryError ?? attention.message}</p>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 [&_button]:max-w-full [&_button]:whitespace-normal">
        {failure.retryResume && <Button size="xs" variant="outline" onClick={() => void retryResume()}>Retry resume</Button>}
        {onDiagnostics && admin && <Button size="xs" variant="outline" onClick={() => {
          if (current() && managesOrganization(getAccount().status, workspace.orgId) === true) onDiagnostics();
        }}>View diagnostics</Button>}
        {localPath && <Button size="xs" variant="outline" onClick={() => void openLocal()}>Run on this Mac instead</Button>}
        {admin && (failure.githubAccess || signIn || provider) && <Button size="xs" variant="outline" onClick={() => {
          if (!current() || managesOrganization(getAccount().status, workspace.orgId) !== true) return;
          if (signIn) openAgentLogins(workspace.orgId);
          else {
            // Settings consumes the organization request when its page mounts.
            openOrganizationSettings(workspace.orgId);
            if (failure.githubAccess) openSettingRow("organizations.github");
          }
        }}>{failure.githubAccess ? "Fix GitHub access" : attention.recovery.label}</Button>}
        {createAgain && <Button size="xs" variant="outline" onClick={() => {
          const latest = current();
          if (!latest || !workspaceAuthority(latest.workspace).lifecycle
            || resolveCloudStartFailure(latest)?.attention.recovery.action !== "create-workspace") return;
          const repository = repositoryOf(latest, getCloudCatalog().createMemory);
          startCloudSessionIn(cloudProjectKey(workspace.orgId, repository?.identity ?? blankIdentity(workspace.name)));
        }}>{attention.recovery.label}</Button>}
        <Button size="xs" variant="ghost" onClick={() => { if (current()) onInspect(); }}>Open session</Button>
      </div>
    </section>
  );
}
