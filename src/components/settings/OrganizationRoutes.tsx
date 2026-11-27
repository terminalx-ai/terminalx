import { useCallback, useEffect, useRef, useState } from "react";
import { Building, Ellipsis, Loader2, Waypoints } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/menu";
import { useAccount } from "@/lib/account";
import { api, type OrganizationRoute, type OrganizationRoutes as Routes } from "@/lib/api";
import { phase2Ready } from "@/lib/phase2Readiness";
import { routeErrorMessage } from "@/lib/agentRoutes";

/**
 * Organization routes (PRO-310, design 12.18): custom providers owners and
 * admins set for everyone in the organization, each for the cloud
 * workspaces on one repository. Such a route takes precedence over members'
 * own logins and routes; removing it hands new sessions back to them.
 * Everyone sees the rows; only owners and admins get the row menu. Behind
 * its readiness key, off by default.
 */
export const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex" };
/** The login a member connects for an agent, as the dialog names it. */
const LOGIN_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };

/** The repository's own name, as the screens show it. */
export const repositoryName = (repository: string) => repository.split("/").pop() || repository;

export function OrganizationRoutes({ contextRevision, organizationId, organizationName, renderAdd }: {
  contextRevision: string;
  organizationId: string;
  organizationName: string;
  /** The add control, for owners and admins (PRO-310 add form). */
  renderAdd?: (props: { routes: Routes; onAdded: (routes: Routes) => void }) => React.ReactNode;
}) {
  const { status } = useAccount();
  const ready = phase2Ready(status, organizationId, "organizationRoutes");
  const [data, setData] = useState<Routes | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<OrganizationRoute | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.cloudOrganizationRoutes(organizationId));
      setError(null);
    } catch (failure) {
      setError(routeErrorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => {
    if (ready) void load();
  }, [load, ready]);

  if (!ready) return null;

  const remove = async (route: OrganizationRoute) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setData(await api.cloudOrganizationRouteRemove(route.id, contextRevision, organizationId));
      setRemoving(null);
      setNotice(`Route removed. New ${AGENT_NAMES[route.provider] ?? route.provider} sessions on ${repositoryName(route.repository)} use each member's own login.`);
    } catch (failure) {
      setRemoving(null);
      setError(routeErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2" data-testid="organization-routes" aria-labelledby="organization-routes-title">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 id="organization-routes-title" className="text-sm font-medium">Organization routes</h3>
          <p className="text-xs text-muted-foreground">Set by owners and admins for everyone in {organizationName}.</p>
        </div>
        {data?.canManage && renderAdd?.({ routes: data, onAdded: (routes) => { setData(routes); setNotice(null); setError(null); } })}
      </div>

      {loading && !data && (
        <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Loading routes…
        </p>
      )}
      {data && data.routes.length === 0 && <p className="text-xs text-muted-foreground" data-testid="organization-routes-empty">No routes.</p>}
      {data && data.routes.length > 0 && (
        <ul className="flex flex-col gap-2">
          {data.routes.map((route) => (
            <RouteRow key={route.id} route={route} organizationName={organizationName} canManage={data.canManage} busy={busy} onRemove={() => { setNotice(null); setRemoving(route); }} />
          ))}
        </ul>
      )}
      {notice && <p role="status" className="text-xs text-muted-foreground" data-testid="organization-routes-notice">{notice}</p>}
      {error && (
        <p role="alert" className="flex items-center gap-2 text-xs text-destructive" data-testid="organization-routes-error">
          {error}
          <Button size="xs" variant="ghost" disabled={loading} onClick={() => void load()}>Retry</Button>
        </p>
      )}
      {removing && <RemoveRouteDialog route={removing} busy={busy} onClose={() => setRemoving(null)} onConfirm={() => void remove(removing)} />}
    </section>
  );
}

function RouteRow({ route, organizationName, canManage, busy, onRemove }: {
  route: OrganizationRoute;
  organizationName: string;
  canManage: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  const agent = AGENT_NAMES[route.provider] ?? route.provider;
  return (
    <li className="rounded-lg border border-hairline px-3 py-2.5 text-xs" data-testid="organization-route" data-route={route.id}>
      <div className="flex items-center gap-2">
        <Waypoints className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-medium">Custom provider for {agent}</span>
        <span className="inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-[11px] text-muted-foreground" data-testid="organization-route-badge">
          <Building className="size-3" aria-hidden /> Set by {organizationName}
        </span>
        {canManage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="ml-auto" size="icon-xs" variant="ghost" aria-label={`Route actions for ${agent} on ${route.repository}`} disabled={busy}>
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem className="text-destructive" onSelect={onRemove}>Remove route…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <p className="mt-1.5 break-words text-muted-foreground">
        {agent} in {repositoryName(route.repository)} workspaces goes through <code className="font-mono">{route.settings.baseUrl}</code>. It takes precedence over members’ own logins.
      </p>
    </li>
  );
}

export function RemoveRouteDialog({ route, busy, onClose, onConfirm }: {
  route: OrganizationRoute;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const submitted = useRef(false);
  useEffect(() => { if (!busy) submitted.current = false; }, [busy]);
  const agent = AGENT_NAMES[route.provider] ?? route.provider;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy && !submitted.current) onClose(); }}>
      <DialogContent className="max-w-md" data-testid="organization-route-remove">
        <DialogHeader>
          <DialogTitle>Disconnect custom provider?</DialogTitle>
          <DialogDescription>Remove the custom route? {agent} goes back to each member’s own login.</DialogDescription>
        </DialogHeader>
        <p className="break-words rounded-md border border-hairline px-3 py-2 text-xs">
          Route <code className="font-mono">{route.settings.baseUrl}</code> for workspaces on {repositoryName(route.repository)}. Members without their own {LOGIN_NAMES[route.provider] ?? agent} login can’t start {agent} there until they connect one.
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => {
            if (submitted.current) return;
            submitted.current = true;
            onConfirm();
          }}>
            {busy && <Loader2 className="animate-spin" />}
            Remove route
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
