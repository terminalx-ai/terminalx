import { useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { localVmRequest, type AttachmentReport } from "@/lib/localVm";
import { computerKey, type ComputerContext, type ComputerTarget } from "@/types/computer";

export function MacosAttachment({ target, context, onChecked }: { context: ComputerContext; target: Extract<ComputerTarget, { kind: "macosGuest" }>; onChecked: (available: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [report, setReport] = useState<AttachmentReport | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  async function run(action: "check" | "inspect" | "release") {
    if (busy) return;
    setBusy(true); setError(null); setConfirmed(false); onChecked(false);
    const binding = report?.binding;
    if (action !== "check") setReport(null);
    try {
      if (action === "check") {
        setDetail(null);
        const result = await localVmRequest("computer.checkAttachment", { target, ...context });
        if (computerKey(result.target) !== computerKey(target)) throw new Error("Readiness belongs to another guest. Check the selected environment again.");
        onChecked(result.available === true); setDetail(result.detail);
      } else {
        if (action === "release" && (!binding || binding.environmentId !== target.environmentId || binding.generation !== target.generation)) throw new Error("An exact retained attachment binding is required.");
        const result = action === "inspect" ? await localVmRequest("computer.attachment", { target })
          : await localVmRequest("computer.reconcileAttachment", { target, binding, confirm: true });
        if (computerKey(result.target) !== computerKey(target) || result.binding && (result.binding.environmentId !== target.environmentId || result.binding.generation !== target.generation)) throw new Error("Ownership receipt belongs to another guest.");
        setReport(result);
      }
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <section aria-label="macOS desktop attachment" className="space-y-2 rounded border border-border p-3">
    <p className="break-all">Environment {target.environmentId}<br />Generation {target.generation}</p>
    <p>Attach guest desktop tools to this tab, or use Run task in VM for guest shell and files. Desktop attachment stays in the background.</p>
    <div className="flex gap-2"><Button size="xs" disabled={busy} onClick={() => void run("check")}>Check macOS desktop tools</Button><Button size="xs" variant="outline" disabled={busy} onClick={() => void run("inspect")}>Inspect retained attachment</Button></div>
    {detail ? <p role="status">{detail}</p> : null}
    {report ? <p role="status">{report.status === "unreserved" ? "No retained host attachment. Check guest tools before attaching." : report.detail}</p> : null}
    {report?.binding ? <p className="break-all">Lease {report.binding.leaseId}<br />Parent {report.binding.sessionId} / {report.binding.tabId}<br />Conversation {report.binding.conversation ?? "New conversation"}</p> : null}
    {report?.status === "releaseAvailable" && report.binding ? <div className="space-y-2"><label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Release the displayed guest lease after a fresh guest check. Keep all receipts and any unknown outcomes; replay no input.</label><Button size="xs" disabled={busy || !confirmed} onClick={() => void run("release")}>Release this retained attachment</Button></div> : null}
    {report?.status === "fenced" ? <p>The guest has not proved release. Missing host processes and elapsed time cannot unlock it.</p> : null}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
  </section>;
}
