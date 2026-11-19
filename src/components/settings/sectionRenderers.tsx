import { OrchestratorTab } from "./OrchestratorSettings";
import type { ReactNode } from "react";
import type { SettingId, SettingsSection } from "./settingsRegistry";
import { AccountTab } from "./AccountTab";
import { DevicesTab } from "./DevicesTab";
import { OrganizationsTab } from "./OrganizationsTab";
import { GeneralTab, AppearanceTab, AgentsTab, IntegrationsTab, AboutTab } from "./SettingsSections";
import { TranscriptionTab } from "./TranscriptionTab";
import { MergedCleanupSettings } from "./MergedCleanupSettings";
import { RepositoriesTab, type ProjectPage } from "./RepositoriesTab";
import { StorageTab } from "./StorageTab";
import { RecoveryIncidentSettings } from "./RecoveryIncidentSettings";
import { ShortcutsTab } from "./ShortcutsTab";
import { ExperimentalTab } from "./ExperimentalSettings";
import { AdvancedTab } from "./AdvancedSettings";
import { EnvironmentSettings } from "./EnvironmentSettings";
import { RegisteredSetting } from "./settingsRegistry";
import { EnvironmentsTab } from "@/components/localVm/EnvironmentsTab";
import { ProjectTemplatesSettings } from "./ProjectTemplatesSettings";
import { MachinesSettings } from "@/components/machines/MachinesSettings";

interface SectionContext {
  onOpenSkills?: () => void;
  onOpenUsage?: () => void;
  projectPath?: string;
  /** The project page open in the sidebar (PRO-387). */
  projectPage?: ProjectPage;
  row?: string | null;
  openRequest?: number;
  onSelectRow?: (row: SettingId) => void;
}
/** The state adapters mount only for the selected section. Their stores and lifetimes are unchanged. */
export const settingsSectionRenderers: Record<SettingsSection, (context: SectionContext) => ReactNode> = {
  account: () => <AccountTab />,
  devices: () => <DevicesTab />,
  machines: () => <MachinesSettings showIntroduction={false} />,
  general: ({ onOpenUsage }) => <GeneralTab onOpenUsage={onOpenUsage} />,
  appearance: () => <AppearanceTab />,
  organizations: ({ row, openRequest }) => <OrganizationsTab initialRow={row} openRequest={openRequest} />,
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
