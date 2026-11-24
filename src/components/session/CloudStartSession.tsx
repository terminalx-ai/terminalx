import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { CloudStartLog } from "@/components/cloud/CloudStartLog";
import { CloudStartProgress } from "@/components/cloud/CloudStartProgress";
import { getAccount, useAccount } from "@/lib/account";
import { api, type AccountStatus, type CloudWorkspaceOperation, type CloudWorkspaceStartProgress } from "@/lib/api";
import { cloudOrgArg, findCloudWorkspace, liveCloudOrgIds, useCloudCatalog } from "@/lib/cloudCatalog";
import type { CloudSessionModel } from "@/lib/cloudSession";
import { cloudProviderLabel } from "@/lib/cloudProviders";
import { cloudStartOperation, cloudStartPhase, cloudStartProgressReady, cloudStartSteps } from "@/lib/cloudStartProgress";
import { privacyEnabled, useDataPrivacy } from "@/lib/dataPrivacy";
import { managesOrganization } from "@/lib/multiOrg";
import { parseCloudWorkspaceKey } from "@/types/target";

const POLL_MS = 2000;
// The timing route takes a row lock. Wait after each response and never overlap requests.
const TIMING_POLL_MS = 12000;

function accountScope(status: AccountStatus) {
  return status.identity && JSON.stringify([status.identity.email, status.context?.account, status.context?.scope, status.context?.revision]);
}

function startAccess(status: AccountStatus, orgId: string) {
  return !privacyEnabled() && cloudStartProgressReady(status, orgId) && liveCloudOrgIds(status).includes(orgId);
}

interface StartScope {
  cancelInFlight: boolean;
}

interface CloudStartView {
  label: string;
  card: ComponentProps<typeof CloudStartProgress>;
  logs: CloudWorkspaceOperation["logs"];
  connected: boolean;
  events?: CloudWorkspaceStartProgress["events"];
}

export function useCloudStart(
  cloud: CloudSessionModel | undefined,
  draft?: { orgId: string; workspaceId: string } | null,
): CloudStartView | null {
  const catalog = useCloudCatalog();
  const { status } = useAccount();
  const privacy = useDataPrivacy();
  const orgId = cloud?.orgId ?? draft?.orgId ?? "";
  const workspaceId = cloud?.workspaceId ?? draft?.workspaceId ?? "";
  const org = catalog.orgs[orgId];
  const item = findCloudWorkspace(catalog, orgId, workspaceId);
  const workspace = item?.workspace;
  const launch = workspace?.launch;
  const account = accountScope(status);
  const eligible = (cloud || draft) && !cloud?.machine && !cloud?.locked && !cloud?.asleep && !privacy.enabled
    && account && startAccess(status, orgId) && catalog.owner === status.identity?.email
    && (!status.context?.revision || !catalog.revision || status.context.revision === catalog.revision)
    && org?.source === "live" && workspace?.orgId === orgId && workspace.you?.role !== "none";
  const sessionId = cloud ? parseCloudWorkspaceKey(cloud.session.id)?.sessionId : null;
  // Before there is a session ID, only the create form holding this target can show the launch.
  const isLaunchSession = cloud ? !!sessionId && launch?.sessionId === sessionId : !!draft && !launch?.sessionId;
  const phase = eligible && isLaunchSession && item ? cloudStartPhase(item) : null;
  const createOperation = cloudStartOperation(item);
  const orgManager = managesOrganization(status, orgId) === true;
  const workspaceManager = workspace?.you ? workspace.you.role === "manager" : workspace?.authority === "manage";
  const mayCancel = workspaceManager && (orgManager || status.memberWorkspaces === true) && (!cloud?.connected || cloud.manage);
  // SaaS getOperationUnviewed lets authorized members read operation status,
  // including completed cleanup. It attaches raw output only for organization managers.
  const mayReadLogs = workspaceManager && orgManager && (!cloud?.connected || cloud.manage);
  const operationId = createOperation?.id;
  const scopeKey = phase ? JSON.stringify([account, orgId, workspaceId, sessionId, launch?.launchId, operationId, mayCancel, mayReadLogs]) : null;
  const scope = useMemo<StartScope | null>(() => scopeKey ? { cancelInFlight: false } : null, [scopeKey]);
  const [update, setUpdate] = useState<{ scope: StartScope; operation?: CloudWorkspaceOperation; busy?: boolean; error?: string } | null>(null);
  const [timing, setTiming] = useState<{ scope: StartScope; reply: CloudWorkspaceStartProgress } | null>(null);
  const current = useRef<StartScope | null>(null);
  useLayoutEffect(() => {
    current.current = scope;
    setUpdate(null);
    setTiming(null);
    return () => { current.current = null; };
  }, [scope]);
  const active = scope && update?.scope === scope ? update : null;
  const operationState = active?.operation?.state;
  const displayedPhase: ReturnType<typeof cloudStartPhase> = operationState === "canceled" ? "canceled" : operationState === "cancel-requested" && phase !== "canceled" ? "canceling" : phase;
  const canCancel = mayCancel && displayedPhase !== "canceling" && displayedPhase !== "canceled"
    && createOperation?.cancelable && (createOperation.state === "queued" || createOperation.state === "running")
    && (!operationState || operationState === "queued" || operationState === "running");
  const confirmingCancellation = mayCancel && displayedPhase === "canceling";
  const polling = displayedPhase !== "canceled" && !active?.busy && (mayReadLogs || confirmingCancellation);

  useEffect(() => {
    if (!scope || !operationId || !polling) return;
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    const canPoll = () => {
      const now = getAccount().status;
      return !closed && current.current === scope && !scope.cancelInFlight && accountScope(now) === account && startAccess(now, orgId)
        && (mayReadLogs ? managesOrganization(now, orgId) : managesOrganization(now, orgId) || now.memberWorkspaces === true);
    };
    const poll = async () => {
      if (!canPoll()) return;
      try {
        const snapshot = await api.cloudWorkspaceOperation(operationId, cloudOrgArg(orgId));
        if (canPoll() && snapshot.workspace.orgId === orgId && snapshot.workspace.id === workspaceId
          && snapshot.operation.workspaceId === workspaceId && snapshot.operation.id === operationId) {
          const operation = mayReadLogs ? snapshot.operation : { ...snapshot.operation, logs: undefined };
          setUpdate((previous) => ({ ...(previous?.scope === scope ? previous : null), scope, operation }));
        }
      } catch {
        // The organization catalog still supplies the launch status when a poll is unavailable.
      }
      if (!closed) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => { closed = true; clearTimeout(timer); };
  }, [account, mayReadLogs, operationId, orgId, polling, scope, workspaceId]);

  const readTiming = displayedPhase !== "canceled" && displayedPhase !== "canceling" && !active?.busy && !org?.error;
  useEffect(() => {
    if (!scope || !operationId || !readTiming) return;
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    const canRead = () => {
      const status = getAccount().status;
      return !closed && current.current === scope && accountScope(status) === account && startAccess(status, orgId);
    };
    const poll = async () => {
      if (!canRead()) return;
      try {
        const reply = await api.cloudWorkspaceStartProgress(orgId, workspaceId, operationId);
        if (!canRead()) return;
        setTiming(reply.organizationId === orgId && reply.workspaceId === workspaceId && reply.operation.id === operationId
          ? { scope, reply } : null);
      } catch (error) {
        if (!canRead()) return;
        setTiming(null);
        const status = (error as { status?: number } | null)?.status;
        if (status === 401 || status === 403 || status === 404) return;
      }
      timer = setTimeout(() => void poll(), TIMING_POLL_MS);
    };
    void poll();
    return () => { closed = true; clearTimeout(timer); };
  }, [account, operationId, orgId, readTiming, scope, workspaceId]);

  const progress = readTiming && timing?.scope === scope ? timing?.reply : undefined;
  if (!scope || !displayedPhase || !item) return null;
  const canUseCancel = () => {
    const now = getAccount().status;
    return current.current === scope && accountScope(now) === account && startAccess(now, orgId)
      && (managesOrganization(now, orgId) || now.memberWorkspaces === true);
  };
  const cancel = async () => {
    if (!canCancel || !operationId || scope.cancelInFlight || !canUseCancel()) return;
    scope.cancelInFlight = true;
    setUpdate({ scope, busy: true });
    try {
      const snapshot = await api.cloudWorkspaceOperationCancel(operationId, cloudOrgArg(orgId));
      if (!canUseCancel()) return;
      if (snapshot.workspace.orgId !== orgId || snapshot.workspace.id !== workspaceId
        || snapshot.operation.workspaceId !== workspaceId || snapshot.operation.id !== operationId) throw new Error();
      const canceled = snapshot.operation.state === "canceled" || snapshot.operation.state === "cancel-requested";
      const operation = mayReadLogs ? snapshot.operation : { ...snapshot.operation, logs: undefined };
      setUpdate({ scope, operation, error: canceled ? undefined : "This start can no longer be canceled." });
    } catch {
      if (canUseCancel()) {
        setUpdate({ scope, error: "Couldn’t confirm cancellation. Check the workspace’s status." });
      }
    } finally {
      scope.cancelInFlight = false;
    }
  };

  return {
    label: displayedPhase === "canceled" ? "Canceled" : displayedPhase === "canceling" || active?.busy ? "Canceling…" : "Starting…",
    card: {
      name: cloud?.workspaceName ?? item.workspace.name,
      phase: displayedPhase,
      steps: cloudStartSteps(item, displayedPhase, cloud?.location.provider ?? cloudProviderLabel(item.workspace.provider), progress),
      hasPrompt: launch?.hasPrompt === true,
      cancel: canCancel ? () => void cancel() : undefined,
      cancelBusy: active?.busy === true,
      error: active?.error ?? null,
    },
    logs: mayReadLogs ? active?.operation?.logs : undefined,
    connected: cloud?.connected ?? false,
    events: progress?.events,
  };
}

export function CloudStartSession({ start }: { start: CloudStartView }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto p-4 sm:p-6">
        <CloudStartProgress {...start.card} />
      </div>
      {start.card.phase !== "canceled" && <CloudStartLog logs={start.logs} events={start.events} connected={start.connected} />}
    </div>
  );
}
