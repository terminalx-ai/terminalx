import { RegisteredSetting } from "./settingsRegistry";
import { thisComputer } from "@/lib/platform";
import { useState } from "react";
import { Lock, MinusCircle } from "@/icons";
import { Switch } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { PRIVACY_MESSAGE, setDataPrivacy, useDataPrivacy } from "@/lib/dataPrivacy";

export function PrivacyEmptyState() {
  return <p role="status" className="px-2 py-4 text-xs text-muted-foreground">{PRIVACY_MESSAGE}</p>;
}

/** What data privacy mode turns off, each with what it covers (design 14.20). */
const TURNED_OFF: readonly { label: string; detail: string }[] = [
  { label: "Cloud workspaces", detail: "organisation sections in the sidebar, sharing, previews and the cloud desktop" },
  { label: "Organisations", detail: "their pages, members and the work status teammates see" },
  { label: "Remote control and pairing", detail: "phones and other computers that control this one" },
  { label: "MCP servers from organisation config", detail: "servers an organisation adds to your agents" },
  { label: "External logging", detail: `error reports sent from ${thisComputer}` },
];

/**
 * Data privacy mode on Account (PRO-375): a row while it is off and yours to
 * change, a card listing what it turns off once it is on or an organisation
 * manages it. A managed switch reads as on and locked, not greyed out.
 */
export function DataPrivacySettings() {
  const privacy = useDataPrivacy();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = privacy.enabled || privacy.managed;
  const locked = privacy.ready && privacy.managed;
  return (
    <div className={cn(card && "my-2 rounded-lg border border-hairline bg-card px-4 py-2")} data-testid="data-privacy-settings">
      <RegisteredSetting
        setting="account.dataPrivacy"
        titleAccessory={privacy.managed ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-well px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground">
            <Lock className="size-3" aria-hidden /> Managed by your organisation
          </span>
        ) : undefined}
        control={<Switch
          aria-label="Data privacy mode"
          checked={privacy.ready && privacy.enabled}
          disabled={!privacy.ready || privacy.managed || busy}
          // The warning token stays amber across palettes (design 14.20).
          className={cn(locked && "disabled:opacity-100 data-[state=checked]:bg-warning/70")}
          onCheckedChange={(enabled) => {
            setBusy(true);
            setError(null);
            void setDataPrivacy(enabled).catch((cause: unknown) => setError(String(cause))).finally(() => setBusy(false));
          }}
        />}
      />
      {card && (
        <div className="pb-2">
          <p className="mt-2 text-[11px] font-medium uppercase tracking-wider text-faint">Turned off while it’s on</p>
          <ul className="mt-2 flex flex-col gap-1.5 text-xs text-muted-foreground">
            {TURNED_OFF.map((item) => (
              <li key={item.label} className="flex items-start gap-2">
                <MinusCircle className="mt-px size-3.5 shrink-0 text-faint" aria-hidden />
                <span><span>{item.label}</span>: {item.detail}</span>
              </li>
            ))}
          </ul>
          {privacy.managed && (
            <p role="status" className="mt-3 text-xs text-faint">Set by a configuration profile from your organisation’s IT. Ask them to change it.</p>
          )}
        </div>
      )}
      {(error || privacy.error) && <p role="alert" className="mb-2 text-xs text-destructive">{error || privacy.error}</p>}
    </div>
  );
}
