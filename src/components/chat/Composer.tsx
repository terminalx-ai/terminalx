import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, AtSign, ChevronDown, FileText, SlashSquare, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { useRowMenu } from "@/components/ui/useRowMenu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { AgentMark } from "@/components/AgentMark";
import { cn } from "@/lib/cn";
import { useShortcutKeycaps } from "@/lib/hotkeys";
import { matchesShortcut } from "@/lib/shortcuts";
import { EFFORT_LABEL, PERMISSION_MODES, aliasRuns, modeIsUnguarded, modeLabel, modelForTab, modelGroups, modelNote, pendingSettingsNote, pickerMode, prettyModelId, runningModelName, useModels } from "@/lib/models";
import { usePickerModels } from "@/lib/cloudModels";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { chooseMode } from "@/lib/dialogs";
import { files as filesApi, type FileHit, type ImageInput, type SlashCommand } from "@/lib/api";
import type { TabEntry } from "@/types/session";
import { DictationStatus, MicButton, useDictationInto, useDictationShortcuts } from "./Dictation";
import { PickerMenu, type PickerItem } from "./PickerMenu";
import { AttachButton, AttachmentThumbs, DropHint, useImageAttachments } from "./useImageAttachments";
import { useComposerHistory } from "./useComposerHistory";
import { tokenAtCaret } from "@/lib/pickers";
import type { ComposerCommandList, ComposerCommands, ComposerFiles } from "@/lib/cloudComposer";

const commandCache = new Map<string, ComposerCommandList>();
const NO_COMMANDS: ComposerCommandList = { commands: [], note: null };

const commandsAsked = new Map<string, Promise<ComposerCommandList>>();

/** A local tab's commands: asked of the harness once per directory. */
function localCommands(cwd: string, harness: string): ComposerCommands {
  const key = `${cwd}|${harness}`;
  return {
    key,
    known: () => commandCache.get(key) ?? null,
    load: () => {
      const known = commandCache.get(key);
      if (known) return Promise.resolve(known);
      const pending = commandsAsked.get(key);
      if (pending) return pending;
      const asked = filesApi
        .slashCommands(cwd, harness)
        .then((commands) => {
          const list = { commands, note: null };
          commandCache.set(key, list);
          return list;
        })
        .finally(() => commandsAsked.delete(key));
      commandsAsked.set(key, asked);
      return asked;
    },
  };
}

/** Break the line at the caret, through the input event the draft is read from. */
export function insertNewLine(el: HTMLTextAreaElement) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const next = el.value.slice(0, start) + "\n" + el.value.slice(end);
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.setSelectionRange(start + 1, start + 1);
}
// Matches the textarea's max-h-60: about ten lines before it scrolls.
const MAX_HEIGHT = 240;
const NO_HISTORY: string[] = [];
/** The least of its label the permission picker shows: about a first word ("Bypass…"). With less room it shows none. */
const PERMISSION_LABEL_MIN_CHARS = 9;

/** A one-click next step above the input. */
export type Handoff = { label: string; prompt: string } | { label: string; run: () => void };

/**
 * The composer inside a session. Enter sends, Shift+Enter breaks a line.
 * While a turn runs the send button becomes Stop and a new prompt queues.
 * `/` at the start opens the command list; `@` anywhere opens the file list.
 * Images attach as blocks; any other dropped file becomes an `@path` mention.
 * Up and Down recall the tab's earlier and later messages, as a shell does.
 */
export function Composer({
  tab,
  cwd,
  commands: givenCommands,
  files: givenFiles,
  remote = false,
  busy,
  draft,
  onDraftChange,
  onSend,
  history = NO_HISTORY,
  onStop,
  onSetModel,
  onSetEffort,
  onSetMode,
  contextUsed,
  reportedModel,
  modelsAreLocal = true,
  modelClient,
  contextMax,
  handoffs,
  disabledReason,
  disabled = false,
  settingsLockedReason = null,
  settingsNote = null,
  settingsNoteWarning = false,
  canStop = true,
  autoFocus,
}: {
  tab: TabEntry;
  cwd?: string;
  /** Where the `/` list comes from when the tab does not run in `cwd` on this computer (a cloud tab: its runtime). */
  commands?: ComposerCommands | null;
  /** Where the `@` list comes from for such a tab. Without it and without `cwd` there is no file list. */
  files?: ComposerFiles | null;
  /** The tab runs on another machine (a cloud workspace): a file dropped from this computer is not mentioned to it. */
  remote?: boolean;
  busy: boolean;
  draft: string;
  onDraftChange: (v: string) => void;
  onSend: (text: string, images: ImageInput[]) => Promise<void> | void;
  /** The messages already sent in this tab, oldest first, for Up and Down to recall (`sentMessages`). */
  history?: string[];
  onStop: () => void;
  onSetModel: (id: string) => void;
  onSetEffort: (e: string | null) => void;
  onSetMode: (m: string) => void;
  contextUsed?: number;
  /** The full model id the session last said it ran (an alias like `opus` resolved). */
  reportedModel?: string | null;
  /** False for cloud: use modelClient, or aliases only until the workspace answers. */
  modelsAreLocal?: boolean;
  /** The workspace that supplies cloud model choices, while connected. */
  modelClient?: WorkspaceRpcClient | null;
  contextMax?: number;
  /** One-click next steps above the input: a prompt put in the composer for the reader to send, or (`run`) something the app does itself. */
  handoffs?: Handoff[];
  disabledReason?: string | null;
  /** Nothing can be typed or sent (shown with `disabledReason`); stopping stays with the owner. */
  disabled?: boolean;
  /** Set when this reader may not change the model, effort or mode (a shared cloud workspace); the pickers are disabled with it. */
  settingsLockedReason?: string | null;
  /** Said under the pickers when a chosen model, effort or mode has not reached the agent yet (a cloud tab: it rides with the next message). */
  settingsNote?: string | null;
  /** The note reports a change that was not applied, rather than one on its way. */
  settingsNoteWarning?: boolean;
  /** False hides Stop (someone else drives this tab, or this reader may only watch). */
  canStop?: boolean;
  autoFocus?: boolean;
}) {
  const { models: listed, refresh: refreshPickerModels } = usePickerModels(useModels(tab.harness), !modelsAreLocal, modelClient, tab.harness);
  const model = modelForTab(listed, tab.model);
  // What may be chosen here, plus what the tab is already on if that is not among them.
  const models = useMemo(() => model && !listed.some((m) => m.id === model.id) ? [...listed, model] : listed, [listed, model?.id]);
  const [caret, setCaret] = useState(0);
  const commandSource = useMemo(() => givenCommands ?? (cwd ? localCommands(cwd, tab.harness) : null), [givenCommands?.key, cwd, tab.harness]);
  const [commandList, setCommandList] = useState<ComposerCommandList>(() => commandSource?.known() ?? NO_COMMANDS);
  const firstLoad = useRef<ComposerCommands | null>(null);
  const commands: SlashCommand[] = commandList.commands;
  const fileSource = useMemo<ComposerFiles | null>(
    () => givenFiles ?? (cwd ? { key: cwd, search: (query, limit) => filesApi.search(cwd, query, limit) } : null),
    [givenFiles?.key, cwd],
  );
  const [fileHits, setFileHits] = useState<FileHit[]>([]);
  const [highlight, setHighlight] = useState<{ list: string | null; row: number }>({ list: null, row: 0 });
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // The model and permission pickers open on a click and an accessibility press too.
  const modelMenu = useRowMenu({ onOpenChange: (open) => open && void refreshPickerModels() });
  const modeMenu = useRowMenu();
  const ref = useRef<HTMLTextAreaElement>(null);
  // A file dropped from this computer can be mentioned only to an agent that runs here.
  const mentionDropped = !remote;
  const attach = useImageAttachments({ textareaRef: ref, draft, onDraftChange, mentionFiles: mentionDropped });
  const { attachments } = attach;

  // Grow with content, up to ~10 lines. Tabs that are not selected stay
  // mounted under display: none, where scrollHeight reads 0; a measurement
  // taken there must not stick, or the box collapses to its padding once the
  // tab is shown. Keep the intrinsic one-row height instead and measure again
  // when the textarea is actually laid out.
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const previous = el.style.height;
    el.style.height = "0px";
    const content = el.scrollHeight;
    el.style.height = content > 0 ? Math.min(content, MAX_HEIGHT) + "px" : previous;
  }, []);

  // autoFocus follows the selected tab, so a switch re-fits before paint.
  useLayoutEffect(fit, [fit, draft, autoFocus]);

  // A hidden textarea is laid out at 0×0. The observer fires when it gains a
  // box and when its width changes (lines re-wrap). Resizing the observed
  // element inside its own notification is reported as an observer loop and
  // deferred a frame regardless, so take that frame explicitly.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [fit]);

  // Until the web fonts settle the fallback face measures short, and the
  // explicit height hides that from the observer; fit once more when they do.
  useEffect(() => {
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) fit();
    });
    return () => {
      cancelled = true;
    };
  }, [fit]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus, tab.id]);

  // Slash commands come from the harness once per directory (a cloud tab's, from its runtime).
  useEffect(() => {
    if (!commandSource) {
      setCommandList(NO_COMMANDS);
      return;
    }
    const known = commandSource.known();
    setCommandList(known ?? NO_COMMANDS);
    let cancelled = false;
    firstLoad.current = commandSource;
    const settled = () => {
      if (firstLoad.current === commandSource) firstLoad.current = null;
    };
    commandSource
      .load()
      .then((list) => {
        if (!cancelled) setCommandList(list);
      })
      .catch(() => {})
      .finally(settled);
    return () => {
      cancelled = true;
    };
  }, [commandSource]);

  const dictation = useDictationInto(tab.id, draft, onDraftChange, ref);
  useDictationShortcuts(dictation, !!autoFocus);
  const keysOf = useShortcutKeycaps();

  const token = useMemo(() => tokenAtCaret(draft, caret), [draft, caret]);
  const tokenKey = token ? `${token.kind}:${token.start}` : null;
  // A list that came back empty or failed (a cloud tab's CLI had not answered yet) is asked for
  // again when the reader starts a command; a source that already has its list answers from it.
  const startingCommand = token?.kind === "slash" && commands.length === 0;
  useEffect(() => {
    // Its first reading is still on its way: that answer is the one to wait for.
    if (!startingCommand || !commandSource || firstLoad.current === commandSource) return;
    let cancelled = false;
    commandSource
      .load()
      .then((list) => {
        if (!cancelled && list.commands.length) setCommandList(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [startingCommand, commandSource]);
  const recall = useComposerHistory({
    id: tab.id,
    history,
    draft,
    onDraftChange,
    field: ref,
    // A recalled `/command` or `@file` is a message, not a search: its menu stays shut until the reader types.
    onRecall: (text) => {
      const recalled = tokenAtCaret(text, text.length);
      setCaret(text.length);
      setDismissedToken(recalled ? `${recalled.kind}:${recalled.start}` : null);
    },
  });
  const pickerOpen = !!token && dismissedToken !== tokenKey && (token.kind === "mention" ? !!fileSource : commands.length > 0 || !!commandList.note);

  // File hits follow the query, lightly debounced.
  useEffect(() => {
    if (!token || token.kind !== "mention" || !fileSource) return;
    let cancelled = false;
    const id = window.setTimeout(() => {
      fileSource
        .search(token.query, 30)
        .then((h) => !cancelled && setFileHits(h))
        .catch(() => {});
    }, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [token?.kind, token?.query, fileSource]);

  const items: PickerItem[] = useMemo(() => {
    if (!token) return [];
    if (token.kind === "slash") {
      const q = token.query.toLowerCase();
      return commands
        .filter((c) => c.name.toLowerCase().includes(q))
        .slice(0, 30)
        .map((c) => ({ id: c.name, label: `/${c.name}`, detail: c.description, hint: c.argumentHint ?? (c.source !== "builtin" ? c.source : undefined), icon: <SlashSquare className="size-3.5" /> }));
    }
    return fileHits.map((h) => ({ id: h.path, label: h.name, detail: h.path, icon: <FileText className="size-3.5" /> }));
  }, [token, commands, fileHits]);

  // The highlighted row belongs to the list it was chosen in: another token, or a list of another
  // length, starts at its first row. That is read off while rendering, never reset in an effect. A
  // reset in an effect runs a task after the new rows are on screen, and undid an arrow pressed in
  // between (the key was answered, then the late reset put the highlight back).
  const listKey = `${tokenKey}|${items.length}`;
  const highlighted = highlight.list === listKey ? highlight.row : 0;
  const setHighlighted = useCallback(
    (next: number | ((row: number) => number)) =>
      setHighlight((was) => {
        const row = was.list === listKey ? was.row : 0;
        return { list: listKey, row: typeof next === "function" ? next(row) : next };
      }),
    [listKey],
  );

  const complete = useCallback(
    (item: PickerItem) => {
      if (!token) return;
      const replacement = token.kind === "slash" ? `/${item.id} ` : `@${item.id} `;
      const before = draft.slice(0, token.start);
      const after = draft.slice(caret);
      const next = before + replacement + after;
      onDraftChange(next);
      const pos = before.length + replacement.length;
      requestAnimationFrame(() => {
        const el = ref.current;
        if (el) {
          el.focus({ preventScroll: true });
          el.setSelectionRange(pos, pos);
          setCaret(pos);
        }
      });
    },
    [token, draft, caret, onDraftChange],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if ((!text && !attachments.length) || sending || disabled) return;
    setSending(true);
    try {
      await onSend(text, attach.images);
    } catch {
      // The owning tab renders the send error. Keep the draft and attachments
      // here so the reader can retry without selecting them again.
      return;
    } finally {
      setSending(false);
    }
    // Sending a recalled message gives back the draft that was set aside for it.
    onDraftChange(recall.sent());
    attach.clear();
    ref.current?.focus({ preventScroll: true });
  }, [draft, attachments, attach, sending, disabled, onSend, onDraftChange, recall.sent]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen && items.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlighted((h) => (h + 1) % items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlighted((h) => (h - 1 + items.length) % items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        complete(items[highlighted]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedToken(tokenKey);
        return;
      }
    }
    // An open menu owns the arrows (the pickers above, the model and permission menus); dictation owns the draft.
    if (!pickerOpen && !modelMenu.open && !modeMenu.open && !dictation.dictating && recall.onKeyDown(e)) return;
    if (e.nativeEvent.isComposing) return;
    if (matchesShortcut(e.nativeEvent, "composer.send")) {
      e.preventDefault();
      void send();
      return;
    }
    // Enter that is not Send already breaks the line; any other key for New line has to do it itself.
    if (matchesShortcut(e.nativeEvent, "composer.newLine") && e.key !== "Enter") {
      e.preventDefault();
      insertNewLine(e.currentTarget);
    }
  };

  const placeholder = busy ? "Send a follow-up (it queues until the agent pauses)" : "Ask, build, or describe the next step";
  // The model picker's label, and its tooltip: the whole of it when the button has to truncate.
  // An alias reads as the version it is running, once someone has said which.
  const modelName = model ? runningModelName(model, reportedModel) : tab.model ? prettyModelId(tab.model) : "Model";
  const runs = model ? aliasRuns(model, reportedModel) : null;
  const effortName = tab.effort && model?.efforts.length ? (EFFORT_LABEL[tab.effort] ?? tab.effort) : null;
  // A level the agent reported that this model's list does not carry is still the one in use.
  const efforts = model?.efforts.length && tab.effort && !model.efforts.includes(tab.effort) ? [...model.efforts, tab.effort] : (model?.efforts ?? []);
  // The pickers show what the agent is running. A choice it has not confirmed yet is said beside them, not shown as made.
  const pendingNote = pendingSettingsNote(tab, models, busy);
  const modelTitle = `Model: ${model?.alias ? `${model.label} (latest${runs ? `, running ${prettyModelId(runs)}` : ""})` : modelName}${effortName ? ` · ${effortName}` : ""}`;
  const permissionLabel = modeLabel(tab.permissionMode);
  // The picker's own id for the tab's mode; none when the agent reported one the picker does not offer (#417).
  const pickedMode = pickerMode(tab.permissionMode)?.id;
  const pct = contextUsed && contextMax ? Math.min(100, Math.round((contextUsed / contextMax) * 100)) : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-4 pt-2">
      {disabledReason && <div className="mb-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">{disabledReason}</div>}
      <DictationStatus dictation={dictation} />
      <div
        className={cn(
          "relative rounded-2xl bg-composer glass p-2.5 shadow-surface hairline focus-within:ring-1 focus-within:ring-ring/40",
          attach.dragging && "ring-2 ring-accent/60",
        )}
        {...attach.dropZoneProps}
      >
        {pickerOpen && (
          <PickerMenu
            items={items}
            highlighted={highlighted}
            onPick={complete}
            onHover={setHighlighted}
            title={token?.kind === "slash" ? "Commands" : "Files"}
            empty={token?.kind === "slash" ? "No matching command" : "No matching file"}
            note={token?.kind === "slash" ? commandList.note : null}
          />
        )}
        <DropHint dragging={attach.dragging} mentionFiles={mentionDropped} />
        {!busy && !draft && handoffs && handoffs.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5 px-1" aria-label="Next steps">
            {handoffs.map((h) => (
              <button
                key={h.label}
                type="button"
                onClick={() => {
                  if ("run" in h) return h.run();
                  onDraftChange(h.prompt);
                  requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
                }}
                className="rounded-full bg-veil-raised px-2.5 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-veil-strong hover:text-foreground"
              >
                {h.label}
              </button>
            ))}
          </div>
        )}
        <AttachmentThumbs attach={attach} />
        {attach.notice && (
          <div className="mb-1 px-1.5 text-xs text-warning" role="status" data-testid="attach-notice">
            {attach.notice}
          </div>
        )}
        <textarea
          ref={ref}
          data-composer
          value={draft}
          onChange={(e) => {
            onDraftChange(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissedToken(null);
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
          placeholder={placeholder}
          className="max-h-60 w-full resize-none bg-transparent px-1.5 py-1 text-[14px] leading-relaxed outline-none placeholder:text-faint"
        />
        <div className="mt-1 flex items-center gap-1" data-composer-toolbar>
          {/* Nothing can be sent: attaching and dictating into it are off too. */}
          <AttachButton attach={attach} disabled={disabled} />
          <MicButton dictation={dictation} disabled={disabled} />
          {fileSource && (
            <WithTooltip label="Mention a file">
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                aria-label="Mention a file"
                onClick={() => {
                  const sep = draft && !/\s$/.test(draft) ? " " : "";
                  const next = draft + sep + "@";
                  onDraftChange(next);
                  setDismissedToken(null);
                  requestAnimationFrame(() => {
                    ref.current?.focus({ preventScroll: true });
                    ref.current?.setSelectionRange(next.length, next.length);
                    setCaret(next.length);
                  });
                }}
              >
                <AtSign />
              </Button>
            </WithTooltip>
          )}

          <DropdownMenu {...modelMenu.root}>
            <DropdownMenuTrigger asChild {...modelMenu.trigger}>
              {/* In a narrow composer the label truncates inside the button; its icon and chevron stay (`min-w-12`). */}
              <Button variant="ghost" size="sm" className="min-w-12 shrink gap-1.5 overflow-hidden px-2 text-muted-foreground" disabled={!!settingsLockedReason} title={settingsLockedReason ?? modelTitle} aria-label={settingsLockedReason ? `Model: ${settingsLockedReason}` : undefined}>
                <AgentMark id={tab.harness} className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate text-foreground">{modelName}</span>
                {/* An alias and the same version pinned read alike otherwise. */}
                {model?.alias ? <span className="shrink-0 text-faint">latest</span> : null}
                {effortName ? <span className="min-w-0 truncate text-faint">{effortName}</span> : null}
                <ChevronDown className="size-3 text-faint" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[14rem]">
              <DropdownMenuLabel>Model</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={model?.id ?? ""} onValueChange={onSetModel}>
                {modelGroups(models).map((group) => (
                  <Fragment key={group.title ?? "models"}>
                    {group.title ? <DropdownMenuLabel className="pt-2">{group.title}</DropdownMenuLabel> : null}
                    {group.models.map((m) => {
                      // The ticked alias says what this session reported; the rest, what the CLI listed.
                      const note = m.id === tab.requestedModel ? "switching…" : m.id === model?.id && runs ? `latest · ${prettyModelId(runs)}` : modelNote(m, models);
                      return (
                        <DropdownMenuRadioItem key={m.id} value={m.id} disabled={!modelsAreLocal && !listed.some((choice) => choice.id === m.id)}>
                          {m.label}
                          {note ? <span className="ml-1.5 text-faint">{note}</span> : null}
                        </DropdownMenuRadioItem>
                      );
                    })}
                  </Fragment>
                ))}
              </DropdownMenuRadioGroup>
              {model && efforts.length ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Effort</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={tab.effort ?? model.defaultEffort ?? ""} onValueChange={(v) => onSetEffort(v)}>
                    {efforts.map((e) => (
                      <DropdownMenuRadioItem key={e} value={e}>
                        {EFFORT_LABEL[e] ?? e}
                        {e === tab.requestedEffort ? <span className="ml-1.5 text-faint">switching…</span> : null}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu {...modeMenu.root}>
            <DropdownMenuTrigger asChild {...modeMenu.trigger}>
              {/*
                In a narrow composer the label truncates down to about its first word, never to a
                single letter: with no room for that it wraps out of sight below the button's one
                line, leaving the mode's dot and the chevron. The tooltip names the mode either way.
              */}
              <Button variant="ghost" size="sm" className="min-w-11 shrink gap-1.5 overflow-hidden px-2 text-muted-foreground" disabled={!!settingsLockedReason} title={settingsLockedReason ?? `Permission mode: ${permissionLabel}`} aria-label={settingsLockedReason ? `Permission mode: ${settingsLockedReason}` : undefined} data-testid="permission-mode">
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    modeIsUnguarded(tab.permissionMode) ? "bg-destructive" : pickedMode === "plan" ? "bg-info" : "bg-add",
                  )}
                />
                <span className="flex h-5 min-w-0 flex-wrap content-start overflow-hidden leading-5">
                  {/* Holds the one visible line, so a label that does not fit starts below it. */}
                  <span aria-hidden className="h-5 w-0 shrink-0" />
                  <span className="grow basis-0 truncate" style={{ minWidth: `${Math.min(permissionLabel.length, PERMISSION_LABEL_MIN_CHARS) * 0.8}ch` }} data-testid="permission-mode-label">
                    {permissionLabel}
                  </span>
                </span>
                <ChevronDown className="size-3 text-faint" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[16rem]">
              <DropdownMenuLabel>Permissions</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={pickedMode ?? tab.permissionMode} onValueChange={(v) => chooseMode(tab.harness, v, onSetMode)}>
                {/* A mode set in the terminal that the picker does not offer is still the one in force. */}
                {!pickedMode && (
                  <DropdownMenuRadioItem value={tab.permissionMode} className="flex-col items-start gap-0" data-testid="permission-mode-reported">
                    <span>{permissionLabel}</span>
                    <span className="text-[11px] text-faint">Set in the terminal.</span>
                  </DropdownMenuRadioItem>
                )}
                {PERMISSION_MODES.map((m) => (
                  <DropdownMenuRadioItem key={m.id} value={m.id} className="flex-col items-start gap-0">
                    <span>
                      {m.label}
                      {m.id === tab.requestedPermissionMode ? <span className="ml-1.5 text-faint">switching…</span> : null}
                    </span>
                    <span className="text-[11px] text-faint">{m.hint}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {pct != null && (
              <WithTooltip label={`Context ${pct}% used (${Math.round((contextUsed ?? 0) / 1000)}k of ${Math.round((contextMax ?? 0) / 1000)}k)`}>
                <div className="relative size-4" aria-label={`Context ${pct}%`}>
                  <svg viewBox="0 0 16 16" className="size-4 -rotate-90">
                    <circle cx="8" cy="8" r="6" fill="none" stroke="var(--hairline-strong)" strokeWidth="2" />
                    <circle
                      cx="8"
                      cy="8"
                      r="6"
                      fill="none"
                      stroke={pct > 85 ? "var(--destructive)" : pct > 65 ? "var(--warning)" : "var(--ink-muted)"}
                      strokeWidth="2"
                      strokeDasharray={`${(pct / 100) * 37.7} 37.7`}
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
              </WithTooltip>
            )}
            {busy && canStop ? (
              <WithTooltip label="Stop" keys={keysOf("session.stop")}>
                <Button size="icon-sm" variant="secondary" aria-label="Stop" onClick={onStop}>
                  <Square className="size-3 fill-current" />
                </Button>
              </WithTooltip>
            ) : null}
            <WithTooltip label={busy ? "Queue" : "Send"} keys={keysOf("composer.send")}>
              <Button
                size="icon-sm"
                variant={draft.trim() || attachments.length ? "accent" : "secondary"}
                aria-label="Send"
                disabled={disabled || sending || (!draft.trim() && !attachments.length)}
                onClick={() => void send()}
              >
                <ArrowUp />
              </Button>
            </WithTooltip>
          </div>
        </div>
      </div>
      {pendingNote && (
        <div className="mt-1.5 px-2 text-[11px] text-muted-foreground" role="status" data-testid="composer-settings-pending">
          {pendingNote}
        </div>
      )}
      {settingsNote && (
        <div className={cn("mt-1.5 px-2 text-[11px]", settingsNoteWarning ? "text-warning" : "text-muted-foreground")} role="status" data-testid="composer-settings-note">
          {settingsNote}
        </div>
      )}
    </div>
  );
}
