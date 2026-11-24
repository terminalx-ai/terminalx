import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, type CloudScheduleWebhookTrigger } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { showError } from "@/lib/errorToasts";
import { whenText } from "@/lib/cloudSchedules";
import { useAutomationFence } from "./CloudAutomationScope";

export function WebhookPayloadHint() {
  return <p className="text-muted-foreground">Fields in the JSON body are available in the prompt as <code>{"{{payload.*}}"}</code>.</p>;
}

function WebhookCopyButton({ label, value }: { label: string; value: string }) {
  const [status, setStatus] = useState("");
  const copy = async () => {
    try {
      await copyText(value);
      setStatus("Copied");
    } catch {
      setStatus("Could not copy");
    }
  };
  return <div className="flex flex-wrap items-center gap-2">
    <Button type="button" size="xs" variant="ghost" onClick={() => void copy()}>{label}</Button>
    <span role="status" className="text-muted-foreground">{status}</span>
  </div>;
}

function WebhookSecret({ secret }: { secret: string }) {
  return <div className="flex flex-col gap-1">
    <p>Copy this secret now. It is only shown here once.</p>
    <code className="min-w-0 break-all rounded-md bg-well p-2 select-text">{secret}</code>
    <WebhookCopyButton label="Copy secret" value={secret} />
  </div>;
}

export function WebhookSecretDialog({ secret, onClose }: { secret: string; onClose: () => void }) {
  return <Dialog open onOpenChange={(open) => !open && onClose()}>
    {/* Skip the shared exit animation, which clones the dialog content on unmount. */}
    <DialogContent width="max-w-md" data-state={undefined} data-testid="webhook-secret">
      <DialogHeader>
        <DialogTitle>Webhook secret</DialogTitle>
        <DialogDescription>Set TERMINALX_WEBHOOK_SECRET in the tools that call this automation.</DialogDescription>
      </DialogHeader>
      <WebhookSecret secret={secret} />
      <Button size="sm" onClick={onClose}>Done</Button>
    </DialogContent>
  </Dialog>;
}

export function WebhookDetails({ trigger, orgId, scheduleId, disabled, onRotated }: {
  trigger: CloudScheduleWebhookTrigger;
  orgId: string;
  scheduleId: string;
  disabled: boolean;
  onRotated: (trigger: CloudScheduleWebhookTrigger) => void;
}) {
  const capture = useAutomationFence();
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [rotated, setRotated] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const { url, secretUpdatedAt } = trigger;
  const quotedUrl = "'" + url.replaceAll("'", "'\"'\"'") + "'";
  const curl = [
    "curl --request POST \\",
    '  --header "Authorization: Bearer $TERMINALX_WEBHOOK_SECRET" \\',
    "  --header 'Content-Type: application/json' \\",
    `  --data '{"ref":"main"}' ${quotedUrl}`,
  ].join("\n");

  const rotate = async () => {
    const current = capture();
    if (!current() || disabled || inFlight.current) return;
    inFlight.current = true;
    setRotating(true);
    setError(null);
    try {
      const response = await api.cloudAutomationRotateWebhookSecret(scheduleId, orgId);
      if (!current()) return;
      if (response.webhookTrigger) onRotated(response.webhookTrigger);
      setRotated(true);
      setSecret(response.webhookSecret ?? null);
      setConfirming(false);
      showError("Set the new secret in the tools that call this automation", undefined, { title: "Webhook secret rotated", tone: "success" });
    } catch {
      if (current()) setError("Could not rotate the webhook secret. Check the connection and try again.");
    } finally {
      inFlight.current = false;
      if (current()) setRotating(false);
    }
  };

  return <section className="flex min-w-0 flex-col gap-2" aria-label="Webhook details" data-testid="webhook-details">
    {rotated ? <p className="font-medium">New secret · just now</p> : secretUpdatedAt && <p className="text-muted-foreground">Secret updated {whenText(secretUpdatedAt)}</p>}
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <code className="min-w-0 break-all select-text">{url}</code>
      <WebhookCopyButton label="Copy URL" value={url} />
    </div>
    {rotated && <p>The old secret now returns 401.</p>}
    {secret && <WebhookSecretDialog secret={secret} onClose={() => setSecret(null)} />}
    <pre className="min-w-0 break-all whitespace-pre-wrap rounded-md bg-well p-2 select-text">{curl}</pre>
    <WebhookPayloadHint />
    <Button type="button" size="xs" variant="ghost" disabled={disabled} onClick={() => { setError(null); setConfirming(true); }}>
      Rotate secret
    </Button>
    <Dialog open={confirming} onOpenChange={(open) => { if (!open && !inFlight.current) setConfirming(false); }}>
      <DialogContent width="max-w-md" data-testid="webhook-rotate-confirm">
        <DialogHeader>
          <DialogTitle>Rotate the webhook secret?</DialogTitle>
          <DialogDescription>
            The old secret stops working immediately and requests using it return 401. Update the tools that call this automation with the new secret. The URL stays the same.
          </DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={rotating} onClick={() => setConfirming(false)}>Cancel</Button>
          <Button size="sm" variant="destructive" disabled={rotating || disabled} onClick={() => void rotate()}>{rotating ? "Rotating…" : "Rotate secret"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </section>;
}
