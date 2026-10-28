import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { localVmRequest, type LinuxInstallerView, type LinuxInstallRecord } from "@/lib/localVm";
import { computerKey, type ComputerTarget } from "@/types/computer";

export function LinuxRuntimeInstaller({ target, enabled }: { target: Extract<ComputerTarget, { kind: "linuxContainer" }>; enabled: boolean }) {
  const [view, setView] = useState<LinuxInstallerView | null>(null);
  const [record, setRecord] = useState<LinuxInstallRecord | null>(null);
  const [profile, setProfile] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  function check(result: LinuxInstallRecord) {
    if (computerKey(result.intent.binding.target) !== computerKey(target) || !result.requestKey || !result.inputDigest || !result.intent.binding.environmentId || !result.intent.binding.generation) throw new Error("Installation receipt belongs to another target or lacks its retained identity.");
  }
  async function run(action: "inspect" | "prepare" | "deliver" | "reconcile") {
    if (busy) return;
    setBusy(true); setConfirmed(false); setError(null);
    try {
      if (action === "inspect") {
        const next = await localVmRequest("computer.linuxInstaller", { target });
        if (computerKey(next.target) !== computerKey(target)) throw new Error("Installer inventory belongs to another container.");
        next.operations.forEach(check);
        setView(next); setProfile(next.profiles[0]?.id ?? "");
        setRecord(next.operations.find((item) => item.requestKey === record?.requestKey) ?? next.operations[0] ?? null);
      } else {
        let next: LinuxInstallRecord;
        if (action === "prepare") {
          key.current ??= crypto.randomUUID();
          next = await localVmRequest("computer.prepareLinuxRuntime", { target, profileId: record?.intent.profileId ?? profile, idempotencyKey: record?.requestKey ?? key.current, confirm: true });
        } else {
          if (!record) throw new Error("Inspect the original installation before continuing.");
          next = await localVmRequest(action === "deliver" ? "computer.deliverLinuxRuntime" : "computer.reconcileLinuxRuntime", { target, idempotencyKey: record.requestKey, inputDigest: record.inputDigest, confirm: true });
        }
        check(next);
        if (record && (next.requestKey !== record.requestKey || next.inputDigest !== record.inputDigest || next.intent.binding.environmentId !== record.intent.binding.environmentId || next.intent.binding.generation !== record.intent.binding.generation)) throw new Error("Original installation identity changed; inspect again.");
        setRecord(next);
        setView((current) => current ? { ...current, operations: [...current.operations.filter((item) => item.requestKey !== next.requestKey), next] } : current);
      }
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  const supported = enabled && view?.available === true;
  const originalProfile = record && view?.profiles.some((item) => item.id === record.intent.profileId);
  const action = record?.status === "staging" ? "prepare" : record?.status === "prepared" ? "deliver" : record?.status === "outcomeUnknown" ? "reconcile" : null;
  return <section aria-label="Linux runtime installer" className="space-y-2 rounded border border-border p-3">
    <Button size="xs" variant="outline" disabled={busy} onClick={() => void run("inspect")}>Inspect runtime installation</Button>
    {view ? <>
      {!view.available ? <p role="status">{view.reason} Production installation is unavailable until a verified native artifact is in the trusted catalog.</p> : null}
      {view.operations.length > 1 ? <label>Retained installation<select value={record?.requestKey ?? ""} disabled={busy} onChange={(event) => { setRecord(view.operations.find((item) => item.requestKey === event.target.value) ?? null); setConfirmed(false); }}>{view.operations.map((item) => <option key={item.requestKey} value={item.requestKey}>{item.intent.binding.environmentId} / {item.intent.binding.generation} · {item.status}</option>)}</select></label> : null}
      {record ? <>
        <p className="break-all">Environment {record.intent.binding.environmentId}<br />Generation {record.intent.binding.generation}<br />Request {record.requestKey}<br />Artifact {record.intent.runtimeSha256}</p>
        <p>Guest account: {record.intent.binding.account ? `${record.intent.binding.account.name} · UID ${record.intent.binding.account.uid} · GID ${record.intent.binding.account.gid} · ${record.intent.binding.account.home}` : "Unbound legacy preparation; delivery is unavailable."}</p>
        <p role="status">{record.status === "installed" ? "Runtime files installed and installer completion confirmed. Guest runtime activation, Codex authorization and task readiness are still separate steps." : record.status === "outcomeUnknown" ? "Installation outcome is unknown. Keep this reservation and inspect the original guest receipt; do not reinstall." : record.detail ?? "Verified artifact prepared. Review this exact account and target before delivery."}</p>
      </> : <>
        <label>Trusted runtime profile<select value={profile} disabled={busy || !supported} onChange={(event) => { setProfile(event.target.value); key.current = null; setConfirmed(false); }}>{view.profiles.map((item) => <option key={item.id} value={item.id}>{item.id} · {item.architecture}</option>)}</select></label>
      </>}
      {(!record || action) ? <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={busy || !supported} onChange={(event) => setConfirmed(event.target.checked)} />{action === "reconcile" ? "Verify only the original guest receipt and release its reservation if completion is proven. Never replay the installation." : action === "deliver" ? "Install the displayed verified artifact in this exact dedicated account. Keep runtime activation and provider authorization separate." : "Inspect the dedicated guest account and prepare this verified profile for the selected container."}</label> : null}
      {!record ? <Button size="xs" disabled={busy || !supported || !confirmed || !profile} onClick={() => void run("prepare")}>Prepare verified Linux runtime</Button> : action ? <Button size="xs" disabled={busy || !supported || !originalProfile || !record.intent.binding.account || !confirmed} onClick={() => void run(action)}>{action === "prepare" ? "Finish verified artifact staging" : action === "deliver" ? "Install prepared runtime" : "Reconcile original installation"}</Button> : null}
    </> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
