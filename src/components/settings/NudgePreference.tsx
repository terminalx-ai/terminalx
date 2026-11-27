import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/controls";
import { getAccount, useAccount } from "@/lib/account";
import { api } from "@/lib/api";
import { getDataPrivacy, useDataPrivacy } from "@/lib/dataPrivacy";
import { phase2Ready } from "@/lib/phase2Readiness";

export function NudgePreference() {
  const { status } = useAccount();
  const privacy = useDataPrivacy();
  const org = status.identity?.organizationId;
  const revision = status.context?.revision;
  if (!org || !revision || !privacy.ready || privacy.enabled || !phase2Ready(status, org, "nudges")) return null;
  return <NudgePreferenceSwitch key={JSON.stringify([org, revision])} org={org} revision={revision} />;
}

function NudgePreferenceSwitch({ org, revision }: { org: string; revision: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isCurrent = () => {
    const { status } = getAccount();
    const privacy = getDataPrivacy();
    return status.context?.revision === revision && status.identity?.organizationId === org
      && privacy.ready && !privacy.enabled && phase2Ready(status, org, "nudges");
  };

  useEffect(() => {
    let active = true;
    void api.nudgePreference(org).then((preference) => {
      if (active && isCurrent()) setEnabled(preference.enabled);
    }, () => {
      if (active && isCurrent()) setError("Could not read the Nudges preference.");
    });
    return () => { active = false; };
  }, [org, revision]);

  const change = async (on: boolean) => {
    if (saving || !isCurrent()) return;
    setSaving(true);
    setError(null);
    try {
      const preference = await api.nudgePreferenceSet(org, on);
      if (isCurrent()) setEnabled(preference.enabled);
    } catch {
      if (isCurrent()) setError("Could not update the Nudges preference.");
    } finally {
      if (isCurrent()) setSaving(false);
    }
  };

  return (
    <div className="border-b border-hairline py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">Nudges</div>
          <p className="text-xs text-muted-foreground">Receive nudges from teammates in this organization.</p>
        </div>
        <Switch aria-label="Nudges" checked={enabled ?? false} disabled={enabled === null || saving} onCheckedChange={(on) => void change(on)} />
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
