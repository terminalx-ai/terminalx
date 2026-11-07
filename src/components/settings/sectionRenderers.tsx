import type { ReactNode } from "react";
import type { SettingsSection } from "./settingsRegistry";
import { AccountTab } from "./AccountTab";
import { DevicesTab } from "./DevicesTab";
import { OrganizationsTab } from "./OrganizationsTab";
import { GeneralTab, AppearanceTab, AgentsTab, IntegrationsTab, AboutTab } from "./SettingsSections";
import { TranscriptionTab } from "./TranscriptionTab";
import { MergedCleanupSettings } from "./MergedCleanupSettings";
import { RepositoriesTab } from "./RepositoriesTab";
import { StorageTab } from "./StorageTab";
import { ShortcutsTab } from "./ShortcutsTab";
import { ExperimentalTab } from "./ExperimentalSettings";
import { EnvironmentSettings } from "./EnvironmentSettings";

interface SectionContext {
  onOpenSkills?: () => void;
  onOpenUsage?: () => void;
  projectPath?: string;
  row?: string | null;
  openRequest?: number;
}
/** The state adapters mount only for the selected section. Their stores and lifetimes are unchanged. */
export const settingsSectionRenderers: Record<SettingsSection, (context: SectionContext) => ReactNode> = {
  account: () => <AccountTab />,
  devices: () => <DevicesTab />,
  general: () => <GeneralTab />,
  appearance: ({ onOpenUsage }) => <AppearanceTab onOpenUsage={onOpenUsage} />,
  organizations: ({ row, openRequest }) => <OrganizationsTab initialRow={row} openRequest={openRequest} />,
  agents: ({ onOpenSkills }) => <AgentsTab onOpenSkills={onOpenSkills} />,
  environment: () => <EnvironmentSettings />,
  transcription: () => <TranscriptionTab />,
  integrations: () => <IntegrationsTab />,
  repositories: ({ projectPath, row }) => <RepositoriesTab projectPath={projectPath} row={row} />,
  storage: () => <><MergedCleanupSettings /><div className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-faint">Leftovers</div><StorageTab /></>,
  shortcuts: () => <ShortcutsTab />,
  experimental: () => <ExperimentalTab />,
  about: () => <AboutTab />,
};
