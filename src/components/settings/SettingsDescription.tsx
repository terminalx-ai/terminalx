import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "@/icons";
import { repoFile } from "@/lib/repo";
import { SETTINGS_SECTIONS, type SettingsSection } from "./settingsRegistry";

/** The Machines guide (PRO-360): add a Mac, add a server, start a session there, offline, update and remove. */
export const MACHINES_GUIDE_URL = repoFile("docs/MACHINES-GUIDE.md");

/** Opens the guide in the browser; the same link sits in the page's description and in the first-run card. */
export function MachinesGuideLink() {
  return (
    <button
      type="button"
      onClick={() => void openUrl(MACHINES_GUIDE_URL)}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm text-[12.5px] text-muted-foreground underline decoration-hairline-strong underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      Machines guide <ExternalLink className="size-3" aria-hidden />
    </button>
  );
}

/** Shared by Settings headers and standalone sections so their introductions stay in sync. */
export function SettingsDescription({ section, id, className = "" }: { section: SettingsSection; id?: string; className?: string }) {
  return <p id={id} className={`text-[13px] text-muted-foreground ${className}`}>
    {SETTINGS_SECTIONS[section].subtitle}{section === "machines" && <> <MachinesGuideLink /></>}
  </p>;
}
