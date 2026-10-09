import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Segmented, SettingRow, Switch } from "@/components/ui/controls";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { bootFloating, saveFloatingSettings, useFloating } from "@/lib/floating";
import { suspendHotkeys } from "@/lib/hotkeys";
import { bindingText, chordOf, conflictOf, isMac, isModifierKey, keycaps, useKeymap } from "@/lib/shortcuts";

const KEYCAP = "rounded-md bg-veil-raised px-1.5 py-0.5 font-sans text-[11px] text-muted-foreground hairline";
/** What the window's shortcut is when the reader has not chosen one; the same default the backend has. */
export const DEFAULT_FLOATING_SHORTCUT = "alt+shift+space";

/** A chord the system could register for every app: it needs a modifier other than Shift. */
function systemWideProblem(chord: string): string | null {
  const parts = chord.split("+");
  if (!parts.some((part) => part === "mod" || part === "ctrl" || part === "alt" || part === "meta")) {
    return `A system-wide shortcut needs ${isMac ? "⌘, ⌃ or ⌥" : "Ctrl, Alt or the Windows key"}: without one it would take the key from every other app.`;
  }
  return null;
}

/**
 * Settings → Shortcuts → System-wide: the one shortcut that works from any
 * app. It shows and hides the floating chat window. Unlike the shortcuts
 * below it, the system registers it, so it can be refused (another app has
 * it, or the desktop does not allow it): that is said here, and the shortcut
 * can be changed or turned off.
 */
export function SystemShortcutSection() {
  const { status } = useFloating();
  const keymap = useKeymap();
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const recorder = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    void bootFloating();
  }, []);
  // The app's own shortcuts stay out of the way while keys are being recorded.
  useEffect(() => {
    if (!recording) return;
    recorder.current?.focus();
    return suspendHotkeys();
  }, [recording]);

  const apply = async (shortcut: string) => {
    setSaving(true);
    setProblem(null);
    try {
      await saveFloatingSettings({ shortcut });
      setRecording(false);
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Tab leaves the box; Escape gives up; every other key is the shortcut.
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      setRecording(false);
      setProblem(null);
      return;
    }
    if (isModifierKey(e.nativeEvent)) return;
    const chord = chordOf(e.nativeEvent);
    if (!chord) return;
    const refused = systemWideProblem(chord);
    if (refused) return setProblem(refused);
    void apply(chord);
  };

  const shortcut = status?.shortcut ?? null;
  // Registered for every app, it is pressed before the window's own shortcuts see it.
  const shadowed = shortcut ? conflictOf(shortcut, "app.quickChat", keymap) : null;
  return (
    <section aria-label="System-wide shortcuts" data-testid="system-shortcuts">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-faint">System-wide</div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-1.5" data-system-shortcut="floating.toggle">
        <div className="min-w-0 flex-1 basis-56">
          <div className="text-[13px]">Show or hide the floating chat window</div>
          <div className="text-xs leading-relaxed text-muted-foreground">Works from any app, whether or not TerminalX has the focus.</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {recording ? (
            <button
              ref={recorder}
              type="button"
              onKeyDown={onKeyDown}
              onBlur={() => setRecording(false)}
              aria-label="Press the new shortcut"
              className="rounded-md border border-ring bg-well px-2 py-1 text-xs text-muted-foreground outline-none"
            >
              {saving ? "Saving…" : "Press the keys…"}
            </button>
          ) : shortcut ? (
            <button type="button" onClick={() => setRecording(true)} className="flex items-center gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/40" aria-label={`Change ${bindingText(shortcut)}`} title="Click to change">
              {keycaps(shortcut).map((cap, index) => (
                <kbd key={index} className={cn(KEYCAP, status?.shortcutError && "text-warning")}>{cap}</kbd>
              ))}
            </button>
          ) : (
            <span className="text-xs text-faint">Off</span>
          )}
          {!recording && (
            <>
              <Button size="sm" variant="outline" disabled={!status || saving} onClick={() => setRecording(true)}>
                {shortcut ? "Change" : "Set"}
              </Button>
              {shortcut ? (
                <Button size="sm" variant="ghost" disabled={saving} onClick={() => void apply("")}>
                  Turn off
                </Button>
              ) : (
                <Button size="sm" variant="ghost" disabled={!status || saving} onClick={() => void apply(DEFAULT_FLOATING_SHORTCUT)}>
                  Use {bindingText(DEFAULT_FLOATING_SHORTCUT)}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {(problem || status?.shortcutError) && (
        <p role="alert" className="rounded-md bg-warning/10 px-2.5 py-1.5 text-xs leading-relaxed text-warning" data-testid="system-shortcut-error">
          {problem ?? status?.shortcutError}
        </p>
      )}
      {!problem && !status?.shortcutError && shadowed && shortcut && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {bindingText(shortcut)} is also “{shadowed.label}” inside TerminalX. The system-wide shortcut is pressed first, so that one will not run.
        </p>
      )}
    </section>
  );
}

const RETENTION: { id: string; label: string; days: number }[] = [
  { id: "7", label: "7 days", days: 7 },
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days", days: 90 },
  { id: "0", label: "For ever", days: 0 },
];

/** Settings → General: how the floating window sits among other windows, and how long idle quick chats are kept. */
export function QuickChatSettings() {
  const { status } = useFloating();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void bootFloating();
  }, []);
  const save = (patch: { alwaysOnTop?: boolean; retentionDays?: number }) => {
    setError(null);
    saveFloatingSettings(patch).catch((e: unknown) => setError(errorMessage(e)));
  };
  const days = status?.retentionDays ?? 30;
  // A number of days set some other way (the settings file) is shown as it is, beside the usual choices.
  const options = RETENTION.some((option) => option.days === days) ? RETENTION : [...RETENTION, { id: String(days), label: `${days} days`, days }];
  return (
    <div data-testid="quick-chat-settings">
      <div className="mb-1 mt-3 text-xs font-medium uppercase tracking-wide text-faint">Quick chats</div>
      <SettingRow
        label="Keep the floating window on top"
        description="The floating chat window stays above other apps’ windows. Off lets it go behind them like any other window; the pin in the window does the same."
        control={<Switch checked={status?.alwaysOnTop ?? true} disabled={!status} onCheckedChange={(value) => save({ alwaysOnTop: value })} />}
      />
      <SettingRow
        label="Keep idle quick chats for"
        description="A quick chat nobody has touched for this long is deleted with its scratch folder. Pinned and archived chats, and one with a terminal still running, are kept. You can always delete one by hand."
        stacked
        control={<Segmented value={String(days)} options={options.map((option) => ({ value: option.id, label: option.label }))} onChange={(value) => save({ retentionDays: Number(value) })} />}
      />
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
