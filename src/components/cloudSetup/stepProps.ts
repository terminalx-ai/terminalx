import type { OrganizationSummary } from "@/lib/api";
import type { OrganizationSetupRecord } from "@/lib/organizationSetup";

/** What every step after the first is given: the organization it sets up, selected and current. */
export interface StepProps {
  organization: OrganizationSummary;
  /** The organization's setup record (organizationSetup.ts). */
  record: OrganizationSetupRecord;
  /** Store a change to the record. */
  onRecord: (record: OrganizationSetupRecord) => void;
  accountEmail: string;
  /** The account's context revision: every write is fenced by it. */
  contextRevision: string;
  /** Go on to the next step. */
  onContinue: () => void;
}
