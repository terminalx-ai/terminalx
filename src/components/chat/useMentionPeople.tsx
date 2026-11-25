import { createContext, useContext, useEffect, useMemo } from "react";
import { useAccount } from "@/lib/account";
import { useDataPrivacy } from "@/lib/dataPrivacy";
import { featureFlags, useFeatureFlag } from "@/lib/featureFlags";
import { readOrganizationRoster, useOrganizationRoster } from "@/lib/organizationRoster";
import { phase2Ready } from "@/lib/phase2Readiness";
import { mentionPeople, type MentionPerson } from "@/lib/mentions";

const NONE: MentionPerson[] = [];

/**
 * Who can be @mentioned in an organization's shared sessions (PRO-141): its
 * roster (PRO-128), while the server says mentions are ready there and data
 * privacy is off. Empty otherwise, so `@` lists files only, as before.
 */
export function useMentionPeople(orgId: string | null | undefined, selfUserId: string | null | undefined): MentionPerson[] {
  const { status } = useAccount();
  const privacy = useDataPrivacy().enabled;
  const roster = useFeatureFlag(featureFlags.teamRoster, orgId ?? undefined);
  const ready = !!orgId && !privacy && roster && phase2Ready(status, orgId, "mentions");
  const { roster: members } = useOrganizationRoster(ready ? orgId : undefined, ready);
  useEffect(() => {
    if (ready && orgId) void readOrganizationRoster(orgId).catch(() => {});
  }, [ready, orgId]);
  return useMemo(() => (ready ? mentionPeople(members?.members, selfUserId) : NONE), [ready, members, selfUserId]);
}

/** The people a transcript draws `@Name` chips for: the session's organization's, set by the tab view. */
export const MentionPeopleContext = createContext<readonly MentionPerson[]>(NONE);
export const useTranscriptMentionPeople = () => useContext(MentionPeopleContext);
