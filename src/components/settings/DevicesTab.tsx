import { Loader2, Smartphone } from "@/icons";
import { Button } from "@/components/ui/button";
import { PairedDeviceList } from "@/components/pairing/PairedDevices";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { openPairPhone, usePairing } from "@/lib/pairing";
import { PrivacyEmptyState } from "./DataPrivacySettings";
import { RegisteredSetting } from "./settingsRegistry";

export function DevicesTab() {
  return useDataPrivacy().enabled ? <PrivacyEmptyState /> : <DevicesTabContent />;
}

function DevicesTabContent() {
  const pairing = usePairing();

  if (!pairing.ready) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading devices…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <RegisteredSetting setting="devices.pairing"><section>
        <div className="text-sm font-medium">Pair a phone</div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Scan a one-time code with TerminalX on your phone, then approve it here after comparing the fingerprint. The code is made on this Mac and never uploaded.
        </p>
        <Button className="mt-3" size="sm" variant="secondary" onClick={() => openPairPhone()}>
          <Smartphone /> Pair a phone…
        </Button>
      </section></RegisteredSetting>

      <RegisteredSetting setting="devices.paired"><section>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Each device has its own revocable credential. Revoking one ends its live connection at once; Disconnect ends it and keeps the pairing.
        </p>
        <PairedDeviceList className="mt-3 rounded-lg border border-hairline" />
      </section></RegisteredSetting>

      {pairing.status.lastError && <p role="alert" className="text-xs text-destructive">{pairing.status.lastError}</p>}
    </div>
  );
}
