import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../src/styles/app.css";
import { ProviderControls } from "../../../src/components/settings/ProviderControls";
import {
  api,
  type CloudProviderConnection,
  type CloudProviderSummary,
} from "../../../src/lib/api";

let scenario = "admin";
let connection: CloudProviderConnection;
function reset(value: string) {
  scenario = value;
  connection = {
    provider: "machine0",
    state:
      value === "revoked" || value === "cleanup"
        ? "attention-required"
        : "connected",
    canManage: value !== "member",
    credentialFingerprint: "sha256:fixture",
    credentialVersion: 3,
    providerAccount: "Acme Compute (original account)",
    connectedAt: 1789948800000,
    lastValidatedAt: 1789948800000,
    operationsBlocked: value === "cleanup",
    disconnectDisposition: value === "cleanup" ? "destroy" : null,
    resources: [
      {
        id: "fixture-workspace",
        name: "Running build workspace",
        state: value === "cleanup" ? "attention-required" : "ready",
        kind: "workspace",
        releaseDisposition: null,
        activeHourlyMicros: 120000,
        suspendedMonthlyMicros: 3000000,
        currency: "USD",
        operationState: value === "cleanup" ? "failed" : "running",
        cleanupRequired: value === "cleanup",
      },
    ],
  };
}
reset("admin");
api.cloudProviders = async () => ({
  providers: [
    {
      id: "machine0",
      displayName: "Machine0",
      availability:
        connection.state === "connected" ? "available" : "attention-required",
      canManage: scenario !== "member",
      connection: null,
      capabilities: {
        suspend: true,
        resume: true,
        releaseDisposition: "destroyed",
        locationSelection: "required",
        sourceSelection: "required",
        pricing: "provider-rate",
      },
    } as CloudProviderSummary,
  ],
});
api.cloudProvider = async () =>
  scenario === "member"
    ? {
        provider: "machine0",
        state: "attention-required",
        canManage: false,
        credentialFingerprint: null,
        connectedAt: null,
        lastValidatedAt: null,
      }
    : structuredClone(connection);
api.cloudProviderConnect = async () => {
  if (scenario === "mismatch")
    throw { code: "cloud_provider_account_mismatch" };
  if (scenario === "invalid")
    throw { code: "cloud_provider_credential_invalid" };
  connection = {
    ...connection,
    credentialVersion: (connection.credentialVersion ?? 0) + 1,
    state: connection.disconnectDisposition
      ? "attention-required"
      : "connected",
    lastValidatedAt: Date.now(),
  };
  if (scenario === "cleanup") {
    scenario = "repaired";
  }
  return structuredClone(connection);
};
api.cloudProviderDisconnect = async (_provider, _revision, disposition) => {
  connection.operationsBlocked = true;
  connection.disconnectDisposition = disposition;
  if (scenario === "cleanup") {
    connection.state = "attention-required";
  } else if (disposition === "destroy") {
    connection.state = "not-connected";
    connection.resources = [];
  } else {
    connection.state = "not-connected";
    connection.resources![0].operationState = "succeeded";
  }
  return structuredClone(connection);
};
function Fixture() {
  const [revision, setRevision] = useState(0);
  return (
    <main className="mx-auto max-w-2xl p-6 text-foreground">
      <h1 className="text-lg font-semibold">
        TerminalX · Organization compute
      </h1>
      <p className="my-2 text-xs text-muted-foreground">
        PRO-9 controlled UI fixture · no live credentials or provider resources
      </p>
      <label className="text-xs">
        Test scenario{" "}
        <select
          aria-label="Test scenario"
          className="rounded border border-hairline bg-background p-2"
          onChange={(event) => {
            reset(event.target.value);
            setRevision(revision + 1);
          }}
        >
          <option value="admin">Admin / same-account rotation</option>
          <option value="member">Member / invalidated connection</option>
          <option value="mismatch">Wrong provider account</option>
          <option value="invalid">Invalid replacement key</option>
          <option value="revoked">Revoked key during running job</option>
          <option value="cleanup">Cleanup unavailable / retry</option>
        </select>
      </label>
      <ProviderControls key={revision} contextRevision="fixture-org-v1" />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
