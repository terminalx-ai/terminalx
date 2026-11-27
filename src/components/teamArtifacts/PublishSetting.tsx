import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/controls";
import { RegisteredSetting } from "@/components/settings/settingsRegistry";
import { teamArtifactsPublishSetting } from "@/lib/teamArtifacts";

const TITLE = "Let agents publish team artifacts";

function refusedWords(refused: string): string {
  if (refused === "declined") return "Not turned on: you refused the confirmation.";
  if (refused === "expired") return "Not turned on: the confirmation was not answered in time.";
  if (refused === "busy") return "Not turned on: another TerminalX question is waiting for your answer. Answer it first.";
  return "Not turned on: a confirmation was refused or left unanswered a moment ago. Try again in a few minutes.";
}

/**
 * Settings > General (PRO-158): off by default. On, agents may publish
 * files from their session's folder for everyone in the organization;
 * tabs that ask before acting still ask each time.
 */
export function TeamArtifactsPublishSetting() {
  const [on, setOn] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    teamArtifactsPublishSetting.get().then((value) => { if (live) setOn(value === true); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const change = (enabled: boolean) => {
    setReason(null);
    teamArtifactsPublishSetting.set(enabled)
      .then((result) => {
        setOn(result.enabled);
        if (enabled && !result.enabled && result.refused) setReason(refusedWords(result.refused));
      })
      .catch(() => setReason("The setting could not be changed. Try again."));
  };
  return (
    <>
      <RegisteredSetting setting="general.teamArtifactsPublish"
        label={TITLE}
        description="Off: agents cannot publish. On: agents in local sessions may publish files from their session's folder to everyone in your organization, where every member can open them. Tabs that ask before acting still ask you each time."
        control={<Switch aria-label={TITLE} checked={on} onCheckedChange={change} />}
      />
      {reason && <p role="status" data-testid="team-artifacts-publish-reason" className="pb-2 text-[11px] text-amber-600 dark:text-amber-400">{reason}</p>}
    </>
  );
}
