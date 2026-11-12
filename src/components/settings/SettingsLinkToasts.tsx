import { AlertCircle, CheckCircle2, Link, X } from "@/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { openSettingRow } from "@/lib/settingsLinks";
import { dismissSettingToast, useSettingToasts, type SettingToast } from "@/lib/settingsToasts";
import type { SettingId } from "./settingsRegistry";

/** Setting-link toasts (PRO-127, design 09.33): a link copied, a setting turned on by a link, or one a link can't turn on. */
export function SettingsLinkToasts() {
  return useSettingToasts().map((toast) => <SettingLinkToast key={toast.id} toast={toast} />);
}

function SettingLinkToast({ toast }: { toast: SettingToast }) {
  const Icon = toast.kind === "copied" ? Link : toast.kind === "enabled" ? CheckCircle2 : AlertCircle;
  const open = () => {
    dismissSettingToast(toast.id);
    openSettingRow(toast.settingId as SettingId);
  };
  return <div role="status" aria-label={toast.message} className="pointer-events-auto flex items-start gap-2.5 rounded-xl bg-popover p-3 text-sm text-card-foreground shadow-surface hairline animate-fade-in">
    <Icon className={cn("mt-0.5 size-4 shrink-0", toast.kind === "enabled" ? "text-add" : toast.kind === "copied" ? "text-muted-foreground" : "text-warning")} />
    <div className="min-w-0 flex-1">
      <div className="font-medium">{toast.message}</div>
      {toast.kind === "enabled" && <div className="mt-2.5 flex gap-2">
        <Button size="xs" variant="outline" className="shrink-0 whitespace-nowrap" onClick={open}>Open setting</Button>
      </div>}
    </div>
    <button type="button" aria-label="Dismiss" onClick={() => dismissSettingToast(toast.id)}
      className="rounded-sm p-0.5 text-faint hover:bg-veil-strong hover:text-foreground">
      <X className="size-3.5" />
    </button>
  </div>;
}
