import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Loader2, QrCode, RotateCw, Smartphone, Trash2 } from "lucide-react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { generatePairing, revokePairing, usePairing } from "@/lib/pairing";
import type { PairedDevice } from "@/types/pairing";

function useCountdown(expiresAt: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (expiresAt == null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  return expiresAt == null ? 0 : Math.max(0, Math.ceil((expiresAt - now) / 1_000));
}

function fallbackCode(pairingUrl: string): string {
  try {
    return new URL(pairingUrl).searchParams.get("code") ?? pairingUrl;
  } catch {
    return pairingUrl;
  }
}

function lastSeen(device: PairedDevice): string {
  if (!device.lastSeenAt) return "Not connected yet";
  return `Last seen ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(device.lastSeenAt))}`;
}

export function DevicesTab() {
  const pairing = usePairing();
  const offer = pairing.status.activePairing;
  const remaining = useCountdown(offer?.expiresAt ?? null);
  const expired = Boolean(offer && remaining === 0);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const code = useMemo(() => (offer ? fallbackCode(offer.pairingUrl) : ""), [offer]);

  useEffect(() => {
    let current = true;
    setQrDataUrl(null);
    if (offer && !expired) {
      void QRCode.toDataURL(offer.pairingUrl, { errorCorrectionLevel: "M", margin: 2, width: 220 })
        .then((url) => {
          if (current) setQrDataUrl(url);
        })
        .catch(() => {
          if (current) setQrDataUrl(null);
        });
    }
    return () => {
      current = false;
    };
  }, [expired, offer]);

  const copyCode = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  if (!pairing.ready) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading devices…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="text-sm font-medium">Pair a phone</div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Scan a one-time code with TerminalX on your phone. The QR image is made on this Mac; it is never uploaded.
        </p>
        {!offer || expired ? (
          <Button className="mt-3" size="sm" disabled={pairing.busy} onClick={() => void generatePairing()}>
            {pairing.busy ? <Loader2 className="animate-spin" /> : <QrCode />}
            {expired ? "Generate a new code" : "Create pairing code"}
          </Button>
        ) : (
          <div className="mt-3 rounded-lg border border-hairline bg-well p-3">
            <div className="flex gap-4">
              <div className="flex size-[132px] shrink-0 items-center justify-center overflow-hidden rounded-md bg-white">
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="TerminalX phone pairing QR code" className="size-full" />
                ) : (
                  <Loader2 className="size-5 animate-spin text-black/50" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium">Ready for {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}</div>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {offer.transport === "relay" ? "Available securely over the TerminalX relay." : "Available on this local network."}
                </p>
                <Button className="mt-3" variant="outline" size="xs" onClick={() => void copyCode()}>
                  {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy pairing code"}
                </Button>
                <Button className="mt-2" variant="ghost" size="xs" disabled={pairing.busy} onClick={() => void generatePairing()}>
                  <RotateCw /> Regenerate
                </Button>
              </div>
            </div>
            <div className="mt-3 rounded-md bg-background/60 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-faint break-all" aria-label="Pairing code">
              {code}
            </div>
          </div>
        )}
      </section>

      <section>
        <div className="text-sm font-medium">Paired devices</div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Each device has its own revocable credential. Revoking one disconnects its live connection immediately.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          {pairing.status.devices.length === 0 ? (
            <div className="rounded-lg border border-hairline px-3 py-4 text-center text-xs text-faint">No paired devices</div>
          ) : (
            pairing.status.devices.map((device) => (
              <div key={device.id} className="flex items-center gap-3 rounded-lg border border-hairline px-3 py-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-well text-muted-foreground">
                  <Smartphone className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{device.label}</div>
                  <div className="mt-0.5 truncate text-[11px] text-faint">
                    {device.platform} · {device.scope} · {lastSeen(device)}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Revoke ${device.label}`}
                  disabled={pairing.busy}
                  onClick={() => void revokePairing(device.id)}
                >
                  <Trash2 />
                </Button>
              </div>
            ))
          )}
        </div>
      </section>

      {pairing.status.lastError && <p className="text-xs text-destructive">{pairing.status.lastError}</p>}
    </div>
  );
}
