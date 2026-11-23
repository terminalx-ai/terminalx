import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, errorMessage, type CloudWorkspaceProviderSelection, type CloudWorkspaceQuote, type CloudWorkspaceSetup } from "@/lib/api";
import { createErrorMessage, createWorkspace, isClientError, launchInput, preflightCreate, repositoriesInput, CreateRefused, type CreateForm, type PendingCreate } from "@/lib/cloudCreate";
import { finishFlow } from "@/lib/cloudSetupFlow";
import { creatableProviders } from "@/lib/hiddenProviders";
import { formatMicros } from "@/lib/organizationCompute";
import { organizationGithubApp } from "@/lib/organizationGithubApp";
import { resendable, unsettledRequest } from "@/lib/organizationSetup";
import { selectCloudWorkspace } from "@/lib/sessions";
import { setupCheckMessage, startSetupCheckDraft } from "@/lib/setupCheckDraft";
import { agentLoginUsable } from "@/components/settings/OrganizationAgentLogins";
import { cloudWorkspaceKey } from "@/types/target";
import { PrimaryButton, StepError } from "./FlowLayout";
import type { StepProps } from "./stepProps";

type Prepared = { form: CreateForm; pending: PendingCreate; quote: CloudWorkspaceQuote; message: string };

const NAME = "Setup check";

/** A resend uses the kept request; the form is not read for it. */
const RESEND_FORM: CreateForm = { name: NAME, provider: null, repositories: [], prompt: "", agent: "claude", model: "", effort: "", mode: "", accessMode: "private" };

function failureText(failure: unknown): string {
  if (failure instanceof CreateRefused) return createErrorMessage(failure.code, failure.detail, true);
  if (isClientError(failure)) return createErrorMessage(failure.code);
  return errorMessage(failure);
}

/** The choice made in the flow, where the provider still offers it; its own default otherwise. */
function selection(setup: CloudWorkspaceSetup, machine: StepProps["record"]["machine"]): CloudWorkspaceProviderSelection {
  const pick = <T extends { id: string }>(list: readonly T[], id: string | undefined, fallback: string) => (id && list.some((item) => item.id === id) ? id : fallback);
  return {
    ...setup.defaults,
    sourceId: pick(setup.sources, machine?.sourceId, setup.defaults.sourceId),
    locationId: pick(setup.locations, machine?.locationId, setup.defaults.locationId),
    machineClassId: pick(setup.machineClasses, machine?.machineClassId, setup.defaults.machineClassId),
  };
}

/**
 * The flow's last actions (12.06): "Finish and open the setup check" makes
 * the "Setup check" workspace on the machine chosen in the flow, from every
 * repository chosen in GitHub, after showing its price. Its agent starts
 * without a prompt: the check message waits in its composer with a coach
 * mark (12.07), and is sent only by the person. The create request is kept
 * on the setup record before it is sent, so a retry is the same workspace.
 * "Go to sessions" finishes without it.
 */
export function FinishActions({ organization, record, onRecord, onDone }: StepProps & { onDone: () => void }) {
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(record);
  current.current = record;
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const orgId = organization.id;

  const open = (workspaceId: string, message: string | null) => {
    onRecord(finishFlow(current.current));
    if (message) startSetupCheckDraft(orgId, workspaceId, message);
    selectCloudWorkspace(cloudWorkspaceKey(orgId, workspaceId));
    onDone();
  };

  const prepare = async () => {
    setBusy(true);
    setError(null);
    try {
      // Made already (an earlier finish): open that one, never a second.
      const made = current.current.workspace?.id;
      if (made) {
        const listed = await api.cloudWorkspaces(orgId).then((response) => response.workspaces.some((item) => item.workspace.id === made && item.workspace.state !== "destroyed"), () => true);
        if (listed) return open(made, null);
      }
      if (unsettledRequest(current.current))
        throw new Error("An earlier request for the setup check was never answered. Open the organization's workspaces to see whether it was made before asking again.");
      const [providers, github, logins] = await Promise.all([
        api.cloudProviders().then((response) => creatableProviders(response.providers)),
        organizationGithubApp.summary().then((summary) => summary.repositories.filter((repository) => repository.state === "accessible" && repository.cloneUrl)),
        api.cloudAgentLogins(orgId).then((response) => response.credentials.filter(agentLoginUsable).map((login) => login.provider), () => []),
      ]);
      const provider = providers.find((item) => item.id === current.current.machine?.provider) ?? providers[0];
      if (!provider) throw new CreateRefused("cloud_provider_connection_required");
      if (!github.length) throw new CreateRefused("cloud_workspace_repository_credential_required");
      const message = setupCheckMessage(github.map((repository) => repository.fullName));
      const form: CreateForm = {
        name: NAME,
        provider: provider.id,
        repositories: github.map((repository) => ({ cloneUrl: repository.cloneUrl!, fullName: repository.fullName, ref: "" })),
        prompt: "",
        agent: logins.find((agent) => agent === "claude" || agent === "codex") ?? "claude",
        model: "",
        effort: "",
        mode: "",
        accessMode: "private",
      };
      await preflightCreate(api, form, orgId);
      const setup = await api.cloudWorkspaceSetup(provider.id, orgId);
      const quote = await api.cloudWorkspaceQuote({ provider: provider.id, ...selection(setup, current.current.machine) }, orgId);
      const idempotencyKey = crypto.randomUUID();
      const pending: PendingCreate = {
        idempotencyKey,
        createdAt: Date.now(),
        request: { name: form.name, quoteId: quote.id, accessMode: form.accessMode, confirmProviderSpend: true, idempotencyKey, repositories: repositoriesInput(form), launch: launchInput(form) },
      };
      if (mounted.current) setPrepared({ form, pending, quote, message });
    } catch (failure) {
      if (mounted.current) setError(failureText(failure));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const create = async (form: CreateForm, pending: PendingCreate, message: string) => {
    setBusy(true);
    setError(null);
    onRecord({ ...current.current, agent: "required", workspace: { pending, id: null } });
    try {
      const snapshot = await createWorkspace(api, form, {
        pending,
        orgId,
        onPending: (kept) => {
          // A definite refusal made nothing: the next try is a new request.
          if (!kept && !current.current.workspace?.id) onRecord({ ...current.current, workspace: null });
        },
        onCreated: (made) => onRecord({ ...current.current, workspace: { pending: null, id: made.workspace.id } }),
      });
      open(snapshot.workspace.id, message);
    } catch (failure) {
      if (mounted.current) {
        setPrepared(null);
        setError(failureText(failure));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  // A request kept from before (lost answer, quit): resent as the same create.
  const unsent = resendable(record);
  const quote = prepared?.quote;
  return (
    <div className="w-full">
      {prepared && quote ? (
        <div className="rounded-lg border border-hairline bg-card p-3 text-[12.5px]" data-testid="setup-check-confirm">
          <p>
            Create “{NAME}” on {quote.configuration.machineClassLabel} · {quote.configuration.locationLabel}, with {prepared.form.repositories.map((repository) => repository.fullName.split("/").pop()).join(", ")}:{" "}
            <span className="font-mono">{formatMicros(quote.activeHourlyMicros, quote.currency)}</span> per hour while it runs. The check message waits in its composer for you to send.
          </p>
          <div className="mt-3 flex gap-2">
            <PrimaryButton busy={busy} disabled={busy} onClick={() => void create(prepared.form, prepared.pending, prepared.message)}>
              Create and open
            </PrimaryButton>
            <Button variant="outline" className="h-9" disabled={busy} onClick={() => setPrepared(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {unsent ? (
            <PrimaryButton busy={busy} disabled={busy} onClick={() => void create(RESEND_FORM, unsent, setupCheckMessage(unsent.request.repositories?.map((repository) => repository.cloneUrl.replace(/\.git$/, "")) ?? []))}>
              Resume creating the setup check
            </PrimaryButton>
          ) : (
            <PrimaryButton busy={busy} disabled={busy} onClick={() => void prepare()}>
              Finish and open the setup check
            </PrimaryButton>
          )}
          <Button
            variant="outline"
            className="h-9 text-[12.5px]"
            disabled={busy}
            onClick={() => {
              onRecord(finishFlow(current.current));
              onDone();
            }}
          >
            Go to sessions
          </Button>
        </div>
      )}
      <StepError>{error}</StepError>
    </div>
  );
}
