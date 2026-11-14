import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { Check, Copy, Loader2, RefreshCw, Smartphone, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { Segmented, Switch } from "@/components/ui/controls";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { PrivacyImage } from "@/components/ui/privacy-image";
import { PrivacyEmptyState } from "@/components/settings/DataPrivacySettings";
import { signIn, useAccount } from "@/lib/account";
import { cn } from "@/lib/cn";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { approvePairing, closePairPhone, declinePairing, generatePairing, setKeepAwake, usePairing } from "@/lib/pairing";
import type { PairingApprovalRequest, PairingConnectionMode, PairingStatus } from "@/types/pairing";
import { PairedDeviceList } from "./PairedDevices";
import { fallbackCode, minutesSeconds, pathLabel, useSecondsLeft } from "./pairingText";

const MODE_OPTIONS = [
  { value: "automatic" as const, label: "Relay and nearby" },
  { value: "local-only" as const, label: "Only this network" },
];

const MODE_COPY: Record<PairingConnectionMode, string> = {
  automatic: "Phone can be on cellular or any Wi-Fi. Nearby, it tries this Mac directly first, then falls back to Relay. Every path is end-to-end encrypted.",
  "local-only": "Phone must be on this Wi-Fi or reach this Mac through Tailscale. No Relay invite is made. The connection is end-to-end encrypted.",
};

const sectionLabel = "text-[11px] uppercase tracking-[.08em] text-faint";
const soft = "text-[12.5px] leading-[19px] text-muted-foreground";

/** The Pair a phone dialog, wherever it was opened from. It also opens by itself while a phone waits for approval. */
export function PairPhoneDialogHost() {
  const pairing = usePairing();
  const open = pairing.dialogOpen || pairing.status.pendingApproval != null;
  if (!open) return null;
  return <PairPhoneDialog />;
}

function PairPhoneDialog() {
  const privacy = useDataPrivacy();
  const pending = usePairing().status.pendingApproval;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open) return;
        // The dialog stays up while a phone waits, so closing it is an answer: the phone was not approved.
        if (pending) void declinePairing(pending.requestId);
        closePairPhone();
      }}
    >
      {/* Below the connected bar, which sits top-centre over everything (top-1.5, 28px tall). */}
      <DialogContent width="max-w-[700px]" showClose={false} className="top-10 max-h-[calc(100dvh-3.5rem)] p-0">
        <header className="flex h-14 items-center gap-2 border-b border-hairline px-5">
          <Smartphone className="size-[17px] shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 leading-4">
            <DialogTitle className="text-sm font-semibold">Pair a phone</DialogTitle>
            <DialogDescription className="truncate text-[11.5px] text-faint">
              Drive this Mac's sessions and your cloud workspaces from TerminalX for iPhone
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Close" className="ml-auto text-faint">
              <X />
            </Button>
          </DialogClose>
        </header>
        {privacy.enabled ? <div className="px-3 py-2"><PrivacyEmptyState /></div> : <PairPhoneBody />}
      </DialogContent>
    </Dialog>
  );
}

function relayUsable(signedIn: boolean, status: PairingStatus): boolean {
  return signedIn && status.relay.phase === "connected";
}

function PairPhoneBody() {
  const account = useAccount();
  const pairing = usePairing();
  const { status } = pairing;
  const signedIn = account.status.state === "signed-in";
  const [mode, setMode] = useState<PairingConnectionMode>(() => status.activePairing?.connectionMode ?? "automatic");
  const canGenerate = (next: PairingConnectionMode) => next === "local-only" || relayUsable(signedIn, status);

  // Opening the dialog is asking for a code: make one unless a live one for this path is already showing.
  // While the path cannot make one yet (Relay down, signed out) keep waiting, so the code appears once it can.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !pairing.ready || !account.ready || pairing.busy) return;
    // A phone already waits on the code: after the answer the dialog offers a new code rather than making one.
    if (status.pendingApproval) {
      asked.current = true;
      return;
    }
    const offer = status.activePairing;
    const live = offer && offer.connectionMode === mode && offer.expiresAt > Date.now();
    if (!live && !canGenerate(mode)) return;
    asked.current = true;
    if (!live) void generatePairing(mode);
  });

  const changeMode = (next: PairingConnectionMode) => {
    if (next === mode) return;
    setMode(next);
    if (canGenerate(next)) void generatePairing(next);
  };

  return (
    <>
      <div className="grid grid-cols-[250px_minmax(0,1fr)]">
        <div className="grid content-start justify-items-center gap-3 border-r border-hairline p-5">
          {status.pendingApproval ? (
            <ApprovalPrompt request={status.pendingApproval} />
          ) : (
            <CodeColumn mode={mode} signedIn={signedIn} canGenerate={canGenerate(mode)} />
          )}
        </div>
        <div className="grid min-w-0 content-start gap-3 p-5">
          <div className={sectionLabel} id="pair-path-label">How the phone reaches this Mac</div>
          <Segmented
            aria-label="How the phone reaches this Mac"
            value={mode}
            onChange={changeMode}
            options={MODE_OPTIONS}
            disabled={pairing.busy || status.pendingApproval != null}
            className="justify-self-start"
          />
          <p className={soft}>{MODE_COPY[mode]}</p>
          {mode === "automatic" && <RelayLine signedIn={signedIn} accountReady={account.ready} accountBusy={account.busy} status={status} />}
          <div className={cn(sectionLabel, "mt-1")}>On the phone</div>
          <ol className={cn(soft, "grid list-decimal gap-1 pl-4")}>
            <li>Open TerminalX and tap Pair a Mac</li>
            <li>Scan this code, then compare the fingerprint</li>
            <li>Approve here when the phone asks</li>
          </ol>
          <label className="mt-1 flex items-center gap-3">
            <span className="text-[12.5px]">Keep this Mac awake while a phone is connected</span>
            <Switch
              className="ml-auto"
              aria-label="Keep this Mac awake while a phone is connected"
              checked={status.keepAwake}
              onCheckedChange={(enabled) => void setKeepAwake(enabled)}
            />
          </label>
          {status.lastError && <p role="alert" className="text-xs text-destructive">{status.lastError}</p>}
        </div>
      </div>
      <PairedDeviceList className="border-t border-hairline" />
    </>
  );
}

function RelayLine({ signedIn, accountReady, accountBusy, status }: { signedIn: boolean; accountReady: boolean; accountBusy: boolean; status: PairingStatus }) {
  if (accountReady && !signedIn) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="size-1.5 shrink-0 rounded-full bg-faint" aria-hidden />
        <span className="min-w-0 flex-1">Sign in to pair through Relay, or choose Only this network.</span>
        <Button size="xs" variant="outline" disabled={accountBusy} onClick={() => void signIn()}>
          {accountBusy ? <Loader2 className="animate-spin" /> : null} Sign in
        </Button>
      </div>
    );
  }
  const { phase, message } = status.relay;
  const ready = phase === "connected";
  const text = ready
    ? "Relay is ready"
    : phase === "connecting"
      ? "Relay is connecting…"
      : (message ?? "Relay is not connected");
  return (
    <div className="grid gap-1" data-testid="relay-status">
      <div className="flex items-start gap-2 text-[12.5px] leading-[19px]">
        <span
          aria-hidden
          className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", ready ? "bg-add" : phase === "connecting" ? "bg-warning" : "bg-destructive")}
        />
        <span>{text}</span>
      </div>
      {!ready && <p className="pl-3.5 text-[11.5px] text-faint">Choose Only this network to pair a phone nearby meanwhile.</p>}
    </div>
  );
}

/** The left column without a phone waiting: the code, how long it lasts, and a way to make another. */
function CodeColumn({ mode, signedIn, canGenerate }: { mode: PairingConnectionMode; signedIn: boolean; canGenerate: boolean }) {
  const pairing = usePairing();
  const active = pairing.status.activePairing;
  const offer = active?.connectionMode === mode ? active : null;
  const generationError = pairing.generationError?.connectionMode === mode ? pairing.generationError.message : null;
  const remaining = useSecondsLeft(offer?.expiresAt ?? null);
  const expired = Boolean(offer && remaining === 0);
  const [qr, setQr] = useState<{ url: string; image: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const code = useMemo(() => (offer ? fallbackCode(offer.pairingUrl) : ""), [offer]);

  useEffect(() => {
    if (!offer || expired) return;
    let current = true;
    // Dense relay offers need a full quiet zone and a bitmap that scales with the number of modules.
    void QRCode.toDataURL(offer.pairingUrl, { errorCorrectionLevel: "M", margin: 4, scale: 8 })
      .then((image) => {
        if (current) setQr({ url: offer.pairingUrl, image });
      })
      .catch(() => {
        if (current) setQr(null);
      });
    return () => {
      current = false;
    };
  }, [expired, offer]);

  const copyCode = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  const showing = offer && !expired && !generationError;
  const image = showing && qr?.url === offer.pairingUrl ? qr.image : null;

  return (
    <>
      <div
        data-testid="pairing-code"
        className={cn(
          "flex size-[210px] items-center justify-center overflow-hidden rounded-xl",
          showing ? "bg-white p-1" : "border border-dashed border-hairline-strong bg-well p-4 text-center",
        )}
      >
        {showing ? (
          image ? (
            <PrivacyImage src={image} alt="TerminalX phone pairing QR code" className="size-full" />
          ) : (
            <Loader2 className="size-5 animate-spin text-black/50" />
          )
        ) : (
          <EmptyCode expired={expired} busy={pairing.busy} error={generationError} mode={mode} signedIn={signedIn} />
        )}
      </div>
      {showing && <div className="text-xs text-muted-foreground" aria-live="polite">Expires in {minutesSeconds(remaining)}</div>}
      {expired && !generationError && <div className="text-xs text-muted-foreground">Expired</div>}
      {showing && offer.connectionMode === "automatic" && !offer.directAvailable && (
        <p className="text-center text-[11px] text-faint">Nearby connections are unavailable right now. This code works through Relay.</p>
      )}
      <Button variant="outline" size="sm" disabled={pairing.busy || !canGenerate} onClick={() => void generatePairing(mode)}>
        {pairing.busy ? <Loader2 className="animate-spin" /> : <RefreshCw />} Generate a new code
      </Button>
      {showing && (
        <Button variant="ghost" size="xs" onClick={() => void copyCode()}>
          {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy code"}
        </Button>
      )}
    </>
  );
}

function EmptyCode({ expired, busy, error, mode, signedIn }: { expired: boolean; busy: boolean; error: string | null; mode: PairingConnectionMode; signedIn: boolean }) {
  if (error) return <p role="alert" className="text-xs text-destructive">{error}</p>;
  if (busy) return <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Making a code" />;
  const [title, detail] = expired
    ? ["This code has expired", "It can no longer be scanned. Generate a new code to pair a phone."]
    : mode === "automatic" && !signedIn
      ? ["No code yet", "Sign in to pair through Relay, or choose Only this network."]
      : mode === "automatic"
        ? ["No code yet", "A Relay code needs Relay. Choose Only this network to pair nearby."]
        : ["No code yet", "Generate a code to pair a phone."];
  return (
    <div className="grid gap-1">
      <div className="text-[12.5px] font-medium">{title}</div>
      <div className="text-[11.5px] leading-4 text-muted-foreground">{detail}</div>
    </div>
  );
}

/** A phone scanned the code and waits: the person compares the fingerprint with the phone's, then answers. */
function ApprovalPrompt({ request }: { request: PairingApprovalRequest }) {
  const pairing = usePairing();
  const remaining = useSecondsLeft(request.expiresAt);
  const device = pairing.status.devices.find((entry) => entry.id === request.deviceId);
  const name = device?.label.trim() ? device.label : "A phone";
  return (
    <section role="group" aria-label="Approve this phone" data-testid="pairing-approval" className="grid w-full justify-items-center gap-3 text-center">
      <div className="grid gap-1">
        <div className="text-[13px] font-medium">{name} wants to pair</div>
        <p className="text-[11.5px] leading-4 text-muted-foreground">Approve only if the phone shows the same fingerprint.</p>
      </div>
      <div className="grid w-full gap-0.5 rounded-xl bg-well py-3 font-mono text-[20px] leading-7 tracking-[.06em]" aria-label={`Fingerprint ${request.fingerprint}`}>
        {fingerprintLines(request.fingerprint).map((line) => (
          <span key={line} aria-hidden>{line}</span>
        ))}
      </div>
      <div className="text-[11.5px] text-faint">
        Scanned {pathLabel(request.transport)} · declines in {minutesSeconds(remaining)}
      </div>
      <div className="grid w-full grid-cols-2 gap-2">
        <Button variant="outline" size="sm" disabled={pairing.busy} onClick={() => void declinePairing(request.requestId)}>
          Decline
        </Button>
        <Button size="sm" disabled={pairing.busy || remaining === 0} onClick={() => void approvePairing(request.requestId)}>
          Approve
        </Button>
      </div>
    </section>
  );
}

/** "CEF4·2468·FE26·9E4B" as two lines of two groups, so it fits the column and reads in halves. */
function fingerprintLines(fingerprint: string): string[] {
  const groups = fingerprint.split("·");
  if (groups.length < 4) return [fingerprint];
  const half = Math.ceil(groups.length / 2);
  return [groups.slice(0, half).join("·"), groups.slice(half).join("·")];
}
