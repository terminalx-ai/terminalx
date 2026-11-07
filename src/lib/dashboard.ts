import type { SessionEntry } from "@/types/session";
import type { Buckets as PortableBuckets } from "@terminalx/portable/dashboard";

export {
  bucketSessions,
  DASHBOARD_STATES,
  filterSessions,
  TABLE_COLUMNS,
  toggleTableColumn,
  nextDashboardSort,
  sortDashboardRows,
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
  DashboardState,
  DashboardSort,
  DashboardTableRow,
  TableColumnId,
  DashboardFilters,
  DashboardSession,
  DashboardTab,
  DashboardTabStatus,
} from "@terminalx/portable/dashboard";

export type Buckets = PortableBuckets<SessionEntry>;
