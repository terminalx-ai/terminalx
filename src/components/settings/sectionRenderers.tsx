import { lazy, type ReactNode } from "react";
import { OrchestratorTab } from "./OrchestratorSettings";
import type { SettingId, SettingsSection } from "./settingsRegistry";
import { AccountTab } from "./AccountTab";
import { OrganizationsTab } from "./OrganizationsTab";
import type { OrganizationPage } from "./OrganizationSettings";
import { GeneralTab, AppearanceTab, AgentsTab, IntegrationsTab, AboutTab } from "./SettingsSections";
import { RepositoriesTab, type ProjectPage } from "./RepositoriesTab";
import { ExperimentalTab } from "./ExperimentalSettings";
import { RegisteredSetting } from "./settingsRegistry";

const DevicesTab = lazy(() => import("./DevicesTab").then((m) => ({ default: m.DevicesTab })));
const TranscriptionTab = lazy(() => import("./TranscriptionTab").then((m) => ({ default: m.TranscriptionTab })));
const MergedCleanupSettings = lazy(() => import("./MergedCleanupSettings").then((m) => ({ default: m.MergedCleanupSettings })));
const StorageTab = lazy(() => import("./StorageTab").then((m) => ({ default: m.StorageTab })));
const RecoveryIncidentSettings = lazy(() => import("./RecoveryIncidentSettings").then((m) => ({ default: m.RecoveryIncidentSettings })));
const ShortcutsTab = lazy(() => import("./ShortcutsTab").then((m) => ({ default: m.ShortcutsTab })));
const AdvancedTab = lazy(() => import("./AdvancedSettings").then((m) => ({ default: m.AdvancedTab })));
const EnvironmentSettings = lazy(() => import("./EnvironmentSettings").then((m) => ({ default: m.EnvironmentSettings })));
const EnvironmentsTab = lazy(() => import("@/components/localVm/EnvironmentsTab").then((m) => ({ default: m.EnvironmentsTab })));
const ProjectTemplatesSettings = lazy(() => import("./ProjectTemplatesSettings").then((m) => ({ default: m.ProjectTemplatesSettings })));
const MachinesSettings = lazy(() => import("@/components/machines/MachinesSettings").then((m) => ({ default: m.MachinesSettings })));
const StatsUsageView = lazy(() => import("@/components/stats/StatsUsageView").then((m) => ({ default: m.StatsUsageView })));

interface SectionContext {
  onOpenSkills?: () => void;
  projectPath?: string;
  /** The project page open in the sidebar (PRO-387). */
  projectPage?: ProjectPage;
  row?: string | null;
  openRequest?: number;
  onSelectRow?: (row: SettingId) => void;
  /** The organization, and its page, open in the menu (PRO-464); none: the list of organizations. */
  organizationId?: string;
  organizationPage?: OrganizationPage;
  onOpenOrganization?: (organizationId: string | null) => void;
}
/** The state adapters mount only for the selected section. Their stores and lifetimes are unchanged. */
export const settingsSectionRenderers: Record<SettingsSection, (context: SectionContext) => ReactNode> = {
  account: () => <AccountTab />,
  devices: () => <DevicesTab />,
  machines: () => <MachinesSettings showIntroduction={false} />,
  stats: () => <StatsUsageView />,
  general: () => <GeneralTab />,
  appearance: () => <AppearanceTab />,
  organizations: ({ organizationId, organizationPage, onOpenOrganization }) => <OrganizationsTab organizationId={organizationId} page={organizationPage} onOpenOrganization={onOpenOrganization} />,
  agents: ({ onOpenSkills }) => <AgentsTab onOpenSkills={onOpenSkills} showIntroduction={false} />,
  orchestrator: () => <OrchestratorTab />,
  environment: () => <EnvironmentSettings />,
  localVms: () => <RegisteredSetting setting="localVms.tasks"><section><EnvironmentsTab /></section></RegisteredSetting>,
  transcription: () => <TranscriptionTab />,
  integrations: () => <IntegrationsTab />,
  projects: () => <ProjectTemplatesSettings />,
  repositories: ({ projectPath, projectPage }) => <RepositoriesTab projectPath={projectPath} page={projectPage} />,
  storage: () => <><MergedCleanupSettings /><div className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-faint">Leftovers</div><StorageTab /><RecoveryIncidentSettings /></>,
  shortcuts: () => <ShortcutsTab />,
  experimental: () => <ExperimentalTab />,
  advanced: () => <AdvancedTab />,
  about: () => <AboutTab />,
};
