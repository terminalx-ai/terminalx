import { useState } from "react";
import { SettingRow, Switch } from "@/components/ui/controls";
import { PRIVACY_MESSAGE, setDataPrivacy, useDataPrivacy } from "@/lib/dataPrivacy";

export function PrivacyEmptyState() {
  return <p role="status" className="px-2 py-4 text-xs text-muted-foreground">{PRIVACY_MESSAGE}</p>;
}

export function DataPrivacySettings() {
  const privacy = useDataPrivacy();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <SettingRow
        label="Data privacy mode"
        description="Keep TerminalX cloud and remote features off on this Mac. Your agents still use their own network connections. Your sign-in stays saved."
        control={<Switch aria-label="Data privacy mode" checked={privacy.ready && privacy.enabled} disabled={!privacy.ready || privacy.managed || busy} onCheckedChange={(enabled) => {
          setBusy(true);
          setError(null);
          void setDataPrivacy(enabled).catch((cause: unknown) => setError(String(cause))).finally(() => setBusy(false));
        }} />}
      />
      <p className="text-xs text-muted-foreground">Turns off:</p>
      <ul className="mb-3 mt-1 list-disc pl-5 text-xs text-muted-foreground">
        <li>Cloud workspaces</li>
        <li>Organisations</li>
        <li>Remote control and pairing</li>
        <li>MCP servers from organisation config</li>
        <li>External logging</li>
      </ul>
      {privacy.managed && <p role="status" className="mb-3 text-xs text-muted-foreground">Managed by your organisation</p>}
      {(error || privacy.error) && <p role="alert" className="mb-3 text-xs text-destructive">{error || privacy.error}</p>}
    </div>
  );
}
