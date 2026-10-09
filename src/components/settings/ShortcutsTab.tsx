import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { suspendHotkeys, useHotkey } from "@/lib/hotkeys";
import { SystemShortcutSection } from "./FloatingWindowSettings";
import {
  HOLD_CODES,
  SHORTCUT_ACTIONS,
  SHORTCUT_GROUPS,
  bindingProblem,
  bindingText,
  chordOf,
  conflictOf,
  holdBinding,
  holdCode,
  isCustomized,
  isMac,
  isModifierKey,
  keycaps,
  resetAllShortcuts,
  resetShortcut,
  saveShortcut,
  useKeymap,
  type Keymap,
  type ShortcutAction,
} from "@/lib/shortcuts";

const KEYCAP = "rounded-md bg-veil-raised px-1.5 py-0.5 font-sans text-[11px] text-muted-foreground hairline";

/**
 * Settings → Shortcuts: every shortcut with its keys, and the way to change
 * them. Click a shortcut, press the new keys, save. Keys another action has
 * are never taken silently: the row names that action and asks. A change is
 * stored at once and is the shortcut everywhere from the next keypress.
 */
export function ShortcutsTab() {
  const keymap = useKeymap();
  // The binding being changed: which action, and which of its bindings (its count for a new one).
  const [editing, setEditing] = useState<{ id: string; slot: number } | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [said, setSaid] = useState("");
  const customized = SHORTCUT_ACTIONS.some((action) => !action.fixed && isCustomized(action.id, keymap));

  return (
    <div className="flex flex-col gap-4" data-testid="shortcuts-tab">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 basis-64 text-xs leading-relaxed text-muted-foreground">
          Click a shortcut and press the new keys. Shortcuts are kept on this computer and change at once.
        </p>
        {confirmAll ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            Reset every shortcut?
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                resetAllShortcuts();
                setEditing(null);
                setConfirmAll(false);
                setSaid("All shortcuts are back to their defaults.");
              }}
            >
              Reset all
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmAll(false)}>
              Cancel
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="outline" className="shrink-0" disabled={!customized} onClick={() => setConfirmAll(true)}>
            Reset all to defaults
          </Button>
        )}
      </div>
      <SystemShortcutSection />
      {SHORTCUT_GROUPS.map((group) => (
        <section key={group} aria-label={`${group} shortcuts`}>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-faint">{group}</div>
          <ul className="flex flex-col">
            {SHORTCUT_ACTIONS.filter((action) => action.group === group).map((action) => (
              <ShortcutRow
                key={action.id}
                action={action}
                keymap={keymap}
                slot={editing?.id === action.id ? editing.slot : null}
                onEdit={(slot) => setEditing(slot == null ? null : { id: action.id, slot })}
                onSaid={setSaid}
              />
            ))}
          </ul>
        </section>
      ))}
      <p className="text-xs leading-relaxed text-muted-foreground">
        A terminal keeps the keys a shell needs, such as {isMac ? "⌃C and ⌃D" : "Ctrl+C and Ctrl+D"}: they cannot be used as shortcuts.
      </p>
      <span className="sr-only" role="status" aria-live="polite">
        {said}
      </span>
    </div>
  );
}

function Keycaps({ binding }: { binding: string }) {
  return (
    <span className="flex items-center gap-0.5">
      {holdCode(binding) != null && <span className="mr-0.5 text-[11px] text-faint">Hold</span>}
      {keycaps(binding).map((k, i) => (
        <kbd key={i} className={KEYCAP}>
          {k}
        </kbd>
      ))}
    </span>
  );
}

const spoken = (binding: string) => (holdCode(binding) != null ? `hold ${bindingText(binding)}` : bindingText(binding));

function ShortcutRow({
  action,
  keymap,
  slot,
  onEdit,
  onSaid,
}: {
  action: ShortcutAction;
  keymap: Keymap;
  /** The binding being changed, when this row is the one being edited. */
  slot: number | null;
  onEdit: (slot: number | null) => void;
  onSaid: (text: string) => void;
}) {
  const bindings = keymap[action.id];
  const row = useRef<HTMLLIElement>(null);
  // A default this row needs that another action uses now: Reset asks before taking it.
  const [resetConflict, setResetConflict] = useState<{ owner: ShortcutAction; binding: string } | null>(null);
  const custom = !action.fixed && isCustomized(action.id, keymap);

  const focusRow = () => requestAnimationFrame(() => row.current?.querySelector<HTMLElement>("button[data-binding]")?.focus());
  const close = () => {
    onEdit(null);
    focusRow();
  };
  const reset = (replace: boolean) => {
    const result = resetShortcut(action.id, { replace });
    if (!result.ok && "conflict" in result) {
      setResetConflict({ owner: result.conflict, binding: result.binding });
      return;
    }
    setResetConflict(null);
    onEdit(null);
    onSaid(`${action.label} is back to its default.`);
    focusRow();
  };

  return (
    <li ref={row} className="flex flex-col py-1 text-[13px]" data-shortcut={action.id}>
      <div className="flex min-w-0 items-center gap-3">
        <span className="min-w-0 flex-1">{action.label}</span>
        <span className="flex shrink-0 items-center gap-1">
          {action.fixed ? (
            <>
              <span className="px-1" title="Typed in the composer">
                <Keycaps binding={bindings[0]} />
              </span>
              {/* The width of a Reset button, so these keys line up with the rows above. */}
              <Button variant="ghost" size="xs" disabled aria-hidden tabIndex={-1} className="invisible">
                Reset
              </Button>
            </>
          ) : (
            <>
              {bindings.map((binding, i) => (
                <button
                  key={binding}
                  type="button"
                  data-binding
                  aria-label={`${action.label}: ${spoken(binding)}. Change`}
                  aria-expanded={slot === i}
                  onClick={() => onEdit(slot === i ? null : i)}
                  className={cn(
                    "rounded-md px-1 py-0.5 outline-none transition-colors hover:bg-veil-raised focus-visible:ring-2 focus-visible:ring-ring/40",
                    slot === i && "bg-selected",
                  )}
                >
                  <Keycaps binding={binding} />
                </button>
              ))}
              {!bindings.length && (
                <button
                  type="button"
                  data-binding
                  aria-label={`${action.label}: no shortcut. Set one`}
                  aria-expanded={slot === 0}
                  onClick={() => onEdit(slot === 0 ? null : 0)}
                  className={cn(
                    "rounded-md px-1.5 py-0.5 text-[11px] text-faint outline-none transition-colors hover:bg-veil-raised hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
                    slot === 0 && "bg-selected",
                  )}
                >
                  Not set
                </button>
              )}
              <Button variant="ghost" size="xs" disabled={!custom} aria-label={`Reset ${action.label}`} className={cn(!custom && "invisible")} onClick={() => reset(false)}>
                Reset
              </Button>
            </>
          )}
        </span>
      </div>
      {resetConflict && (
        <div className="mt-1 flex flex-wrap items-center justify-end gap-1.5 rounded-md bg-well p-2 text-xs" role="alert">
          <span className="min-w-0 text-warning">
            {bindingText(resetConflict.binding)} is used by “{resetConflict.owner.label}” now.
          </span>
          <Button size="sm" variant="accent" onClick={() => reset(true)}>
            Replace
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setResetConflict(null)}>
            Cancel
          </Button>
        </div>
      )}
      {slot != null && !action.fixed && <ShortcutEditor action={action} bindings={bindings} slot={slot} keymap={keymap} onClose={close} onSaid={onSaid} />}
    </li>
  );
}

/**
 * The recorder under a row. While its box has the focus every key is the
 * reader's new shortcut, so the app's own shortcuts are off; Tab and Shift+Tab
 * still move the focus, which is how the keyboard leaves it. A modifier key
 * pressed and released on its own is a held key (dictation only).
 */
function ShortcutEditor({
  action,
  bindings,
  slot,
  keymap,
  onClose,
  onSaid,
}: {
  action: ShortcutAction;
  bindings: string[];
  slot: number;
  keymap: Keymap;
  onClose: () => void;
  onSaid: (text: string) => void;
}) {
  const recorder = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const [recording, setRecording] = useState(false);
  const [captured, setCaptured] = useState<string | null>(null);
  /** The modifier that is down on its own, which becomes a held key if it comes up that way. */
  const solo = useRef<string | null>(null);
  const existing = bindings[slot];

  useEffect(() => {
    recorder.current?.focus();
  }, []);

  // The app's shortcuts stay out of the way only while keys are being recorded.
  useEffect(() => {
    if (!recording) return;
    return suspendHotkeys();
  }, [recording]);

  // Outside the recorder, Escape cancels this change instead of closing Settings.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const cancel = useCallback(() => closeRef.current(), []);
  useHotkey("escape", cancel);

  const own = captured != null && captured !== existing && bindings.includes(captured);
  const problem = captured == null ? null : own ? `${bindingText(captured)} is already a shortcut for this.` : bindingProblem(action.id, captured);
  const conflict = captured == null || problem ? null : conflictOf(captured, action.id, keymap);

  // Keys that can be saved hand the focus to the button that saves them; keys that cannot stay in the box to be pressed again.
  useEffect(() => {
    if (captured != null && !problem) confirm.current?.focus();
  }, [captured, problem]);

  const save = (replace: boolean) => {
    if (captured == null || problem) return;
    const next = [...bindings];
    next[slot] = captured;
    const result = saveShortcut(action.id, next, { replace });
    if (!result.ok) return;
    onSaid(`${action.label} is now ${spoken(captured)}.`);
    onClose();
  };
  const remove = () => {
    const result = saveShortcut(action.id, bindings.filter((_, i) => i !== slot));
    if (!result.ok) return;
    onSaid(`${spoken(existing)} no longer runs ${action.label}.`);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Tab leaves the box; every other key is the shortcut.
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    const native = e.nativeEvent;
    if (isModifierKey(native)) {
      const family = e.code.replace(/(Left|Right)$/, "");
      const others = (family !== "Alt" && e.altKey) || (family !== "Control" && e.ctrlKey) || (family !== "Shift" && e.shiftKey) || (family !== "Meta" && e.metaKey);
      solo.current = !others && (HOLD_CODES as readonly string[]).includes(e.code) ? e.code : null;
      return;
    }
    solo.current = null;
    const chord = chordOf(native);
    if (chord) setCaptured(chord);
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (solo.current && e.code === solo.current) setCaptured(holdBinding(e.code));
    solo.current = null;
  };

  const hint = action.hold
    ? `Press the keys together, or press and release one modifier key on its own (such as ${isMac ? "Right ⌥" : "Right Ctrl"}) to hold it to talk. Tab leaves the box.`
    : "Press the keys together. Tab leaves the box.";

  return (
    <div className="mt-1 flex flex-col items-end gap-1.5 rounded-md bg-well p-2" role="group" aria-label={`Change the shortcut for ${action.label}`} data-testid="shortcut-editor">
      <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5">
        <button
          ref={recorder}
          type="button"
          aria-label={`New keys for ${action.label}. Press them now; Tab leaves without recording`}
          onFocus={() => setRecording(true)}
          onBlur={() => {
            setRecording(false);
            solo.current = null;
          }}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          className={cn(
            "flex h-7 min-w-40 items-center justify-center rounded-md bg-background px-2 text-xs text-muted-foreground outline-none hairline",
            recording && "ring-2 ring-ring/40",
          )}
        >
          {captured != null ? <Keycaps binding={captured} /> : recording ? "Press the new keys…" : "Click, then press the new keys"}
        </button>
        {conflict ? (
          <Button ref={confirm} size="sm" variant="accent" onClick={() => save(true)}>
            Replace
          </Button>
        ) : (
          <Button ref={confirm} size="sm" variant="accent" disabled={captured == null || !!problem} onClick={() => save(false)}>
            Save
          </Button>
        )}
        {existing && (
          <Button size="sm" variant="ghost" onClick={remove}>
            Remove
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {problem ? (
        <p className="text-right text-xs leading-relaxed text-destructive" role="alert">
          {problem}
        </p>
      ) : conflict && captured != null ? (
        <p className="text-right text-xs leading-relaxed text-warning" role="alert">
          {bindingText(captured)} is already used by “{conflict.label}”. Replace takes it from there; Cancel keeps both as they are.
        </p>
      ) : (
        <p className="text-right text-xs leading-relaxed text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
