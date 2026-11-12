import { AlertCircle, CheckCircle2, Link } from "@/icons";
import { cn } from "@/lib/cn";
import { openSettingRow } from "@/lib/settingsLinks";
import { dismissSettingToast, useSettingToasts, type SettingToast } from "@/lib/settingsToasts";
import type { SettingId } from "./settingsRegistry";

/** Setting-link toasts (PRO-127, design 09.33): a link copied, a setting turned on by a link, or one a link can't turn on. */
export function SettingsLinkToasts() {
  return useSettingToasts().map((toast) => <SettingLinkToast key={toast.id} toast={toast} />);
}

/** One line: what happened and, for a setting a link turned on, the way to it. Each goes by itself (SETTING_TOAST_MS). */
function SettingLinkToast({ toast }: { toast: SettingToast }) {
  const Icon = toast.kind === "copied" ? Link : toast.kind === "enabled" ? CheckCircle2 : AlertCircle;
  const open = () => {
    dismissSettingToast(toast.id);
    openSettingRow(toast.settingId as SettingId);
  };
  return <div role="status" aria-label={toast.message} className="pointer-events-auto flex min-h-10 items-center gap-2 rounded-lg bg-popover px-3 py-2 text-[12.5px] text-card-foreground shadow-surface hairline animate-fade-in">
    <Icon className={cn("size-3.5 shrink-0", toast.kind === "enabled" ? "text-add" : toast.kind === "copied" ? "text-muted-foreground" : "text-warning")} />
    <span className="min-w-0">{toast.message}</span>
    {toast.kind === "enabled" && <button type="button" onClick={open}
      className="ml-auto shrink-0 whitespace-nowrap rounded-sm pl-3 font-medium text-accent outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring">Open setting</button>}
  </div>;
}
