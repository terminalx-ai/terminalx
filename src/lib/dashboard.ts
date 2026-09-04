import type { SessionEntry } from "@/types/session";
import type { Buckets as PortableBuckets } from "@terminalx/portable/dashboard";

export {
  bucketSessions,
  COLUMNS,
  DONE_PAGE,
  hasFilters,
  isUnread,
  matchesFilters,
  matchesQuery,
  NO_FILTERS,
  sessionColumn,
  toggleFilter,
  workspaceName,
} from "@terminalx/portable/dashboard";
export type {
  BucketOptions,
  ColumnId,
  DashboardFilters,
  DashboardSession,
  DashboardTab,
  DashboardTabStatus,
} from "@terminalx/portable/dashboard";

export type Buckets = PortableBuckets<SessionEntry>;
