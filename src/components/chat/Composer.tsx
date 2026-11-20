import { localCommands } from "@/lib/localCommands";
import { captureReviewSend, markReviewsSent, pendingReviewCount, restoreReviewSend } from "@/lib/reviewComments";
import { SetupCheckCoach } from "@/components/cloudSetup/SetupCheckCoach";
import { ContextPopover } from "./UsagePopovers";
import type { Turn } from "@/lib/transcript";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getPrefs, subscribePrefs } from "@/lib/prefs";
import { ArrowUp, AtSign, Bookmark, ChevronDown, CircleAlert, FileText, MessageSquare, Shield, ShieldAlert, ShieldCheck, SlashSquare, Square } from "@/icons";
import { showError } from "@/lib/errorToasts";
import { goalCommand, goalCommandProblem } from "@/lib/goalCommand";
import { openSettingRow } from "@/lib/settingsLinks";
import { Button } from "@/components/ui/button";
import { WithTooltip } from "@/components/ui/tooltip";
import { useRowMenu } from "@/components/ui/useRowMenu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/menu";
import { AgentMark } from "@/components/AgentMark";
import { cn } from "@/lib/cn";
import { useDictationContext } from "@/lib/dictationContext";
import { usePromptTextProps } from "@/lib/autocorrect";
import { useShortcutKeycaps } from "@/lib/hotkeys";
import { matchesShortcut } from "@/lib/shortcuts";
import { BYPASS_MODE, EFFORT_LABEL, PERMISSION_MODES, aliasRuns, effortChoices, modeIsUnguarded, modeLabel, modelForTab, modelGroups, modelNote, pendingSettingsNote, pickerMode, prettyModelId, requestAgentSettings, runningModelName, useModels } from "@/lib/models";
import { usePickerModels } from "@/lib/cloudModels";
import { ModelPickerEmpty } from "@/components/chat/ModelPickerEmpty";
import { TranscriptionInputSubmenu } from "./TranscriptionInputPicker";
import { ModelSwitchConfirm, ModelSwitchNotice } from "./ModelSwitch";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { chooseMode } from "@/lib/dialogs";
import { files as filesApi, type FileHit, type FileInput, type ImageInput, type SlashCommand } from "@/lib/api";
import type { TabEntry } from "@/types/session";
import { DictationStatus, MicButton, useDictationInto, useDictationShortcuts } from "./Dictation";
import { PickerMenu, type PickerItem } from "./PickerMenu";
import { AttachButton, DropHint, useAttachments } from "./useImageAttachments";
import { AttachmentChips } from "./ComposerAttachments";
import { beginComposerSend, finishComposerSend, returnToDraft, useComposerSend, withReturned } from "@/lib/composerSends";
import { useComposerHistory } from "./useComposerHistory";
import { usePrMention } from "./usePrMention";
import { tokenAtCaret } from "@/lib/pickers";
import type { ComposerCommandList, ComposerCommands, ComposerFiles, ComposerPrs } from "@/lib/cloudComposer";

const NO_COMMANDS: ComposerCommandList = { commands: [], note: null };

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
const savedSnippets = () => getPrefs().promptSnippets;
/** A picker row that is a saved snippet, not an agent command: its id follows. */
const SNIPPET = "snippet:";
const NO_HISTORY: string[] = [];

/**
 * The radius of the button in the composer's bottom-right corner: the box's
 * own (rounded-2xl, 20px) less its padding (p-2.5, 10px), so the two curves
 * run parallel instead of meeting at different arcs.
 */
const CORNER = "rounded-[calc(var(--radius-2xl)-10px)]";

/** A one-click next step above the input. */
export type Handoff = { label: string; prompt: string } | { label: string; run: () => void };

/** Agents by the name their models go under in the picker's empty state. */
const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", opencode: "OpenCode" };
const agentName = (id: string) => AGENT_NAMES[id] ?? id;
/** The account an agent signs in with, where it is not the agent's own. */
const SIGN_INS: Record<string, string> = { codex: "ChatGPT" };
/** The picker's Model row when the agent answered with no models. Never the button's label. */
const NONE_FOUND = "None found";
/** The permission chip's word for a mode, shorter than the menu's. */
const shortMode = (mode: string | null | undefined) => (mode === "manual" ? "Ask" : mode === BYPASS_MODE ? "Bypass" : null);

/**
 * The composer inside a session. Enter sends, Shift+Enter breaks a line.
 * While a turn runs the send button becomes Stop and a new prompt queues.
 * `/` at the start opens the command list; `@` anywhere opens the file list.
 * Any file attaches as a chip, up to 10 a message (PRO-290): images go as
 * image blocks, other files are stored with the session and sent by reference.
 * Up and Down recall the tab's earlier and later messages, as a shell does.
 */

export function Composer({
  tab,
  sendScope = tab.id,
  cwd,
  commands: givenCommands,
  files: givenFiles,
  prs = null,
  remote = false,
  attachFiles,
  busy,
  setupRunning = false,
  draft,
  onDraftChange,
  onSend,
  followUps,
  sentAfter,
  history = NO_HISTORY,
  onStop,
  onSetModel,
  onSetEffort,
  onSetMode,
  agentHandoff,
  hasConversation = false,
  contextUsed,
  reportedModel,
  modelsAreLocal = true,
  modelClient,
  contextMax,
  turns = NO_TURNS,
  compacting = false,
  handoffs,
  disabledReason,
  disabled = false,
  heldReason = null,
  settingsLockedReason = null,
  modelLockedReason = null,
  modeLockedReason = null,
  settingsNote = null,
  settingsNoteWarning = false,
  canStop = true,
  stopMode = "stop",
  autoFocus,
  onOpenCodexTab,
}: {
  tab: TabEntry;
  /** Stable backend/tab identity; pending sends survive view replacement. */
  sendScope?: string;
  cwd?: string;
  /** Where the `/` list comes from when the tab does not run in `cwd` on this computer (a cloud tab: its runtime). */
  commands?: ComposerCommands | null;
  /** Where the `@` list comes from for such a tab. Without it and without `cwd` there is no file list. */
  files?: ComposerFiles | null;
  /**
   * Where the `#` list comes from for such a tab (its runtime's `gh`, #1329).
   * Without it a remote tab has no `#` list; a local tab asks this computer in `cwd`.
   */
  prs?: ComposerPrs | null;
  /**
   * The tab runs on another computer (a cloud workspace, a machine): a file
   * dropped from this one is not mentioned to it by its path here; it is
   * attached, when the tab takes files.
   */
  remote?: boolean;
  /**
   * Files other than images attach (PRO-290; on a machine, PRO-407; in a
   * cloud workspace, #1329). Defaults to `!remote`.
   */
  attachFiles?: boolean;
  busy: boolean;
  setupRunning?: boolean;
  draft: string;
  onDraftChange: (v: string) => void;
  /** `files`: what is attached besides images (PRO-290), passed only when there are any; the caller stores them with the session. */
  onSend: (text: string, images: ImageInput[], alternate?: boolean, files?: FileInput[]) => Promise<void> | void;
  followUps?: "now" | "hold";
  /** The tab's newest event, read as Send is pressed: the sent message's own event comes after it (#727). */
  sentAfter?: () => number;
  /** The messages already sent in this tab, oldest first, for Up and Down to recall (`sentMessages`). */
  history?: string[];
  onStop: () => void;
  onSetModel: (id: string) => void;
  onSetEffort: (e: string | null) => void;
  onSetMode: (m: string) => void;
  agentHandoff?: { name: string; id: string; run: () => void };
  hasConversation?: boolean;
  contextUsed?: number;
  /** The full model id the session last said it ran (an alias like `opus` resolved). */
  reportedModel?: string | null;
  /** False for cloud: use modelClient, or aliases only until the workspace answers. */
  modelsAreLocal?: boolean;
  /** The workspace that supplies cloud model choices, while connected. */
  modelClient?: WorkspaceRpcClient | null;
  contextMax?: number;
  turns?: readonly Turn[];
  compacting?: boolean;
  /** One-click next steps above the input: a prompt put in the composer for the reader to send, or (`run`) something the app does itself. */
  handoffs?: Handoff[];
  disabledReason?: string | null;
  /** Nothing can be typed or sent (shown with `disabledReason`); stopping stays with the owner. */
  disabled?: boolean;
  /**
   * Typing stays, sending waits (21.09): a machine that is away. The draft is
   * kept as typed and goes nowhere until the person sends it once the machine
   * is back; nothing is queued on this computer. Shown as the input's placeholder.
   */
  heldReason?: string | null;
  /** Set when this reader may not change the model, effort or mode (a shared cloud workspace); the pickers are disabled with it. */
  settingsLockedReason?: string | null;
  /** Set when the model and effort cannot be changed from here whoever asks (an agent started by hand that takes them only at startup, #437). */
  modelLockedReason?: string | null;
  /** The same for the permission mode. */
  modeLockedReason?: string | null;
  /** Said under the pickers when a chosen model, effort or mode has not reached the agent yet (a cloud tab: it rides with the next message). */
  settingsNote?: string | null;
  /** The note reports a change that was not applied, rather than one on its way. */
  settingsNoteWarning?: boolean;
  /** False hides Stop (someone else drives this tab, or this reader may only watch). */
  canStop?: boolean;
  /**
   * What `onStop` does now, which is what the control says (#427).
   * `interrupt`: Escape for the agent, and its process stays. `force`: the
   * interrupt went unanswered, so this press ends the process. `stop`: the
   * hard stop where there is no interrupt to send first.
   */
  stopMode?: "interrupt" | "force" | "stop";
  autoFocus?: boolean;
  /** Opens a Codex tab beside this one: offered when a `/goal` is typed to an agent without goals (PRO-380). */
  onOpenCodexTab?: () => void;
}) {
  const { models: listed, refresh: refreshPickerModels, loaded: modelsLoaded } = usePickerModels(useModels(tab.harness), !modelsAreLocal, modelClient, tab.harness);
  const model = modelForTab(listed, tab.model);
  // What may be chosen here, plus what the tab is already on if that is not among them.
  const models = useMemo(() => model && !listed.some((m) => m.id === model.id) ? [...listed, model] : listed, [listed, model?.id]);
  const [caret, setCaret] = useState(0);
  const [retryingModels, setRetryingModels] = useState(false);
  const retryModels = () => {
    setRetryingModels(true);
    void Promise.resolve(refreshPickerModels()).finally(() => setRetryingModels(false));
  };
  // The agent listed nothing: the session's own model is still named, but there is nothing to choose.
  const noModels = listed.length === 0;
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
  const sending = !!useComposerSend(sendScope).pending;
  // A send outlives its composer: one that fails after this one has gone puts its message back in the saved draft.
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The model and permission pickers open on a click and an accessibility press too.
  const modelMenu = useRowMenu({ onOpenChange: (open) => open && void refreshPickerModels() });
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  // A model picked mid-chat waits for the reader's word (the prompt cache is rebuilt); once given, it can be undone.
  const [confirmModel, setConfirmModel] = useState<string | null>(null);
  const [switched, setSwitched] = useState<{ to: string; from: string } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const textProps = usePromptTextProps();
  // A file dropped from this computer can be mentioned only to an agent that runs here.
  const mentionDropped = !remote;
  const attach = useAttachments({ textareaRef: ref, draft, onDraftChange, mentionFiles: mentionDropped, anyFile: attachFiles ?? !remote });
  // Refused chips stay above the draft but are never sent, and alone do not make a message.
  const sendable = useMemo(() => attach.attachments.filter((a) => !a.refused), [attach.attachments]);

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

  const dictationContext = useDictationContext(tab.id, cwd, remote, draft, caret);
  const dictation = useDictationInto(tab.id, draft, onDraftChange, ref, dictationContext);
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
  // A remote tab's `#` list is its runtime's: a picked pull request's context file is read there and attached as a file.
  const prSource = remote ? (attach.imagesOnly ? null : prs) : (cwd ?? null);
  const prMention = usePrMention(!disabled && dismissedToken !== tokenKey ? prSource : null, draft, caret, onDraftChange, ref, setCaret, { onAttachFile: (file) => void attach.addInputs([file]) });
  // Prompts kept from a turn's menu (PRO-379), offered beside the agent's commands.
  const snippets = useSyncExternalStore(subscribePrefs, savedSnippets, savedSnippets);
  const pickerOpen = !!token && token.kind !== "pr" && dismissedToken !== tokenKey && (token.kind === "mention" ? !!fileSource : commands.length > 0 || snippets.length > 0 || !!commandList.note);

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
      const saved = snippets
        .filter((snippet) => snippet.name.includes(q))
        .map((snippet) => ({ id: `${SNIPPET}${snippet.id}`, label: `/${snippet.name}`, detail: snippet.text.split("\n")[0], hint: "Snippet", icon: <Bookmark className="size-3.5" /> }));
      return [...saved, ...commands
        .filter((c) => c.name.toLowerCase().includes(q))
        .slice(0, 30)
        .map((c) => ({ id: c.name, label: `/${c.name}`, detail: c.description, hint: c.argumentHint ?? (c.source !== "builtin" ? c.source : undefined), icon: <SlashSquare className="size-3.5" /> }))];
    }
    return fileHits.map((h) => ({ id: h.path, label: h.name, detail: h.path, icon: <FileText className="size-3.5" /> }));
  }, [token, commands, fileHits, snippets]);

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
      const snippet = token.kind === "slash" && item.id.startsWith(SNIPPET) ? snippets.find((saved) => `${SNIPPET}${saved.id}` === item.id) : undefined;
      const replacement = snippet ? snippet.text : token.kind === "slash" ? `/${item.id} ` : `@${item.id} `;
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
    [token, draft, caret, onDraftChange, snippets],
  );

  const [reviewReceiptError, setReviewReceiptError] = useState<{ message: string; retry: () => Promise<void> } | null>(null);
  // "/goal" with nothing after it was pressed in a Codex chat: it stays, said wrong, until the text changes (PRO-380, 03.20).
  const [emptyGoal, setEmptyGoal] = useState(false);
  const goalMissing = emptyGoal && isEmptyGoal(draft);
  const send = useCallback(async (alternate = false) => {
    const text = draft.trim();
    if ((!text && !sendable.length) || disabled || heldReason || prMention.attaching) return;
    const goalProblem = goalCommandProblem(text, tab.harness, !!sendable.length, commands);
    if (goalProblem) {
      // Goals are Codex's (#256): a bare "/goal" says nothing to set, and another agent has none to set.
      if (goalProblem === "empty") {
        setEmptyGoal(true);
        return;
      }
      if (goalProblem === "unsupported") {
        const name = tab.title?.trim();
        showError(`${name ? `“${name}”` : "This tab"} runs ${agentName(tab.harness)}, which has no goals. Your text is still in the composer`, undefined, {
          title: "Goals work in Codex chats only",
          icon: "target",
          copy: false,
          key: `goal-codex-only:${tab.id}`,
          actions: onOpenCodexTab ? [{ label: "Open a Codex tab", icon: "bot", run: onOpenCodexTab }] : undefined,
        });
        return;
      }
    }
    const previews = sendable.flatMap((a) => (a.image && a.previewUrl ? [{ url: a.previewUrl, name: a.name }] : []));
    const fileNames = sendable.flatMap((a) => (a.file ? [{ name: a.name }] : []));
    const operation = beginComposerSend(sendScope, { text, images: previews, ...(fileNames.length ? { files: fileNames } : {}), pressedAt: Date.now(), afterSeq: sentAfter?.() ?? 0 });
    if (!operation) return;
    // The message goes to the chat at once, drawn as sending, and the composer
    // is free for the next one (#727): what was set aside to send a recalled
    // message comes back, or nothing. Failing, the message comes back here.
    const reviewSend = captureReviewSend(tab.id, text);
    setSwitched(null);
    const completeHistory = recall.captureSend();
    // Bind this send's learnable correction before the draft is cleared.
    const learnOnSuccess = dictation.prepareSend(text);
    onDraftChange(completeHistory() ?? "");
    const images = attach.setAside();
    ref.current?.focus({ preventScroll: true });
    try {
      // Files go with their own argument; a message without any is sent exactly as before.
      if (images.files.length) await onSend(text, images.images, alternate, images.files);
      else if (alternate) await onSend(text, images.images, true);
      else await onSend(text, images.images);
    } catch (error) {
      // Back in the composer; into the tab's saved draft once this one has gone.
      if (mounted.current) {
        const back = withReturned(latestDraft.current, text);
        if (back !== latestDraft.current) onDraftChange(back);
      } else returnToDraft(tab.id, text);
      restoreReviewSend(tab.id, text, reviewSend);
      images.settle(false);
      // Keep terminal failure with the same owner so a remounted tab sees it.
      finishComposerSend(sendScope, operation, error);
      return;
    }
    images.settle(true);
    void markReviewsSent(reviewSend).catch((error) => {
      if (mounted.current) setReviewReceiptError({ retry: () => markReviewsSent(reviewSend), message: String(error) });
    });
    // Learning belongs to this accepted send even if a newer draft is visible.
    learnOnSuccess();
    finishComposerSend(sendScope, operation);
  }, [draft, sendable, attach, disabled, heldReason, prMention.attaching, onSend, sentAfter, onDraftChange, recall.captureSend, sendScope, tab.id, tab.harness, tab.title, commands, onOpenCodexTab, dictation.prepareSend]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (prMention.onKeyDown(e)) return;
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
    if (!pickerOpen && !prMention.open && !modelMenu.open && !modeMenuOpen && !dictation.dictating && recall.onKeyDown(e)) return;
    if (matchesShortcut(e.nativeEvent, "composer.send")) {
      e.preventDefault();
      void send();
      return;
    }
    if (followUps && matchesShortcut(e.nativeEvent, "composer.sendAlternate")) {
      e.preventDefault();
      void send(true);
      return;
    }
    // Enter that is not Send already breaks the line; any other key for New line has to do it itself.
    if (matchesShortcut(e.nativeEvent, "composer.newLine") && e.key !== "Enter") {
      e.preventDefault();
      insertNewLine(e.currentTarget);
    }
  };

  const alternateKeys = keysOf("composer.sendAlternate").join("+");
  const sendLabel = busy && followUps === "hold" ? "Hold until the turn ends" : "Send";
  const sendHint = busy && followUps && alternateKeys
    ? `${sendLabel} · ${alternateKeys} ${followUps === "hold" ? "interrupts and sends" : "holds until the turn ends"}`
    : sendLabel;
  const placeholder = heldReason ? heldReason : busy ? (followUps === "hold" ? "Hold a follow-up until the turn ends" : "Send a follow-up — it waits until the agent pauses") : "Ask, build, or describe the next step";
  // The model picker's label, and its tooltip: the whole of it when the button has to truncate.
  // An alias reads as the version it is running, once someone has said which.
  const noModelsFound = noModels && modelsLoaded && !retryingModels;
  // It keeps the session's own model when the agent lists none: "None found" is said in the menu, not here.
  const modelName = model ? runningModelName(model, reportedModel) : tab.model ? prettyModelId(tab.model) : "Model";
  const runs = model ? aliasRuns(model, reportedModel) : null;
  const effortName = tab.effort && (noModels || model?.efforts.length) ? (EFFORT_LABEL[tab.effort] ?? tab.effort) : null;
  // A level the agent reported that this model's list does not carry is still the one in use.
  const efforts = effortChoices(model, tab.effort);
  // The pickers show what the agent is running. A choice it has not confirmed yet is said beside them, not shown as made.
  // A switch said with its Undo below is not said twice.
  const pendingNote = pendingSettingsNote(switched && tab.requestedModel === switched.to ? { ...tab, requestedModel: null } : tab, models, busy);
  const modelTitle = `Model: ${model?.alias ? `${model.label} (latest${runs ? `, running ${prettyModelId(runs)}` : ""})` : modelName}${effortName ? ` · ${effortName}` : ""}`;
  const permissionLabel = modeLabel(tab.permissionMode);
  const modelLock = settingsLockedReason ?? modelLockedReason;
  const modeLock = settingsLockedReason ?? modeLockedReason;
  // The picker's own id for the tab's mode; none when the agent reported one the picker does not offer (#417).
  const pickedMode = pickerMode(tab.permissionMode)?.id;
  // Once there is a conversation, a new model rebuilds the prompt cache: asked first. Before the first turn it applies at once.
  const midChat = hasConversation || history.length > 0 || busy;
  const labelOf = (id: string) => models.find((m) => m.id === id)?.label ?? prettyModelId(id);
  const pickModel = (id: string) => {
    if (id === model?.id) return;
    if (midChat) setConfirmModel(id);
    else onSetModel(id);
  };
  const confirmSwitch = () => {
    if (!confirmModel) return;
    setSwitched({ to: confirmModel, from: model?.id ?? tab.model ?? "" });
    setConfirmModel(null);
    onSetModel(confirmModel);
  };
  const undoSwitch = () => {
    if (switched?.from) onSetModel(switched.from);
    setSwitched(null);
  };
  // A model set from elsewhere ends the offer to undo this one.
  useEffect(() => {
    setSwitched((was) => (was && tab.model !== was.from ? null : was));
  }, [tab.model]);
  useEffect(() => {
    setConfirmModel(null);
    setSwitched(null);
  }, [tab.id]);
  const modelRowValue = noModels ? (noModelsFound ? NONE_FOUND : "Loading…") : modelName;
  const percent = contextUsed != null && contextMax != null && contextMax > 0 ? Math.min(100, Math.max(0, Math.round(contextUsed / contextMax * 100))) : null;

  // Review comments added from a diff wait in the draft (PRO-392): said above the box until they are sent or removed.
  const reviewsReady = pendingReviewCount(tab.id, draft);

  return (
    <div className="@container mx-auto w-full max-w-3xl px-6 pb-4 pt-2" data-tab-composer={tab.id}>
      {disabledReason && <div className="mb-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">{disabledReason}</div>}
      <DictationStatus dictation={dictation} />
      {reviewsReady > 0 && (
        <div data-testid="review-comments-ready" className="mb-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <MessageSquare aria-hidden className="size-3.5 shrink-0 text-mention" />
          <span className="shrink-0">{reviewsReady} review {reviewsReady === 1 ? "comment" : "comments"} ready to send</span>
          <span className="min-w-0 truncate text-faint">· {reviewsReady === 1 ? "it goes" : "they go"} to the agent as one message</span>
        </div>
      )}
      {reviewReceiptError && <div role="alert" className="mb-2 text-xs text-warning">Message accepted, but review comments could not be marked Sent: {reviewReceiptError.message} <button type="button" onClick={() => void reviewReceiptError.retry().then(() => setReviewReceiptError(null), (error) => setReviewReceiptError({ ...reviewReceiptError, message: String(error) }))}>Retry marking Sent</button></div>}
      {confirmModel && <ModelSwitchConfirm model={labelOf(confirmModel)} onCancel={() => setConfirmModel(null)} onConfirm={confirmSwitch} />}
      <div
        className={cn(
          "relative rounded-2xl bg-composer p-2.5 shadow-surface hairline focus-within:ring-1 focus-within:ring-ring/40",
          // An outline: the box's hairline is a box-shadow, which a ring would replace.
          goalMissing && "outline outline-1 -outline-offset-1 outline-destructive/70 focus-within:ring-0",
          attach.dragging && "ring-2 ring-accent/60",
        )}
        // What stays in the corner of the window (the clean-up indicator) keeps off this box.
        data-composer-box
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
        {prMention.menu}
        <DropHint dragging={attach.dragging} mentionFiles={!attach.imagesOnly} />
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
        <AttachmentChips attach={attach} />
        {attach.notice && (
          <div className="mb-1 px-1.5 text-xs text-warning" role="status" data-testid="attach-notice">
            {attach.notice}
          </div>
        )}
        <textarea
          ref={ref}
          data-composer
          {...textProps}
          value={draft}
          onChange={(e) => {
            onDraftChange(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissedToken(null);
            if (emptyGoal && !isEmptyGoal(e.target.value)) setEmptyGoal(false);
          }}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          aria-invalid={goalMissing || undefined}
          aria-describedby={goalMissing ? `${tab.id}-goal-missing` : undefined}
          rows={1}
          placeholder={placeholder}
          className="max-h-60 w-full resize-none scrollbar-visible bg-transparent px-1.5 py-1 text-[14px] leading-relaxed outline-none placeholder:text-faint"
        />
        <div className="mt-1 flex items-center gap-1" data-composer-toolbar>
          <DropdownMenu {...modelMenu.root}>
            <DropdownMenuTrigger asChild {...modelMenu.trigger}>
              {/* In a narrow composer the label truncates inside the button; its icon and chevron stay (`min-w-12`). */}
              <Button variant="ghost" size="sm" className="min-w-12 shrink gap-1.5 overflow-hidden px-2 text-muted-foreground" disabled={!!modelLock} title={modelLock ?? modelTitle} aria-label={modelLock ? `Model: ${modelLock}` : undefined} data-testid="model-picker">
                <AgentMark id={tab.harness} className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate text-foreground">{modelName}</span>
                {/* The effort is a setting of its own, a step quieter than the model. */}
                {effortName ? <span className="min-w-0 truncate text-muted-foreground">{effortName}</span> : null}
                <ChevronDown className="size-3 text-faint" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[15rem]">
              <DropdownMenuSub>
                <DropdownMenuSubTrigger data-testid="model-picker-agent">
                  <span className="flex-1">Agent</span>
                  <span className="ml-auto max-w-[10rem] truncate pl-3 text-[12px] text-faint">{agentName(tab.harness)}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-[15rem]">
                  <DropdownMenuLabel>Agent</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={tab.harness}>
                    <DropdownMenuRadioItem value={tab.harness}>
                      <AgentMark id={tab.harness} decorative />
                      {agentName(tab.harness)}
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                  {agentHandoff && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={agentHandoff.run}>
                        <AgentMark id={agentHandoff.id} decorative />
                        <span>Hand off to {agentHandoff.name}<span className="block text-xs text-faint">Opens in a new tab</span></span>
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger data-testid="model-picker-model">
                  <span className="flex-1">Model</span>
                  <span className={cn("ml-auto max-w-[10rem] truncate pl-3 text-[12px]", noModelsFound ? "text-destructive" : "text-faint")} data-testid="model-picker-model-value">{modelRowValue}</span>
                </DropdownMenuSubTrigger>
                {noModels ? (
                  // The card stands beside the Model row, where the models would be.
                  <DropdownMenuSubContent className="w-80 p-0">
                    <ModelPickerEmpty
                      agent={agentName(tab.harness)}
                      signIn={SIGN_INS[tab.harness]}
                      other={agentHandoff?.name}
                      loading={!modelsLoaded}
                      retrying={retryingModels}
                      onRetry={retryModels}
                      onOpenSettings={requestAgentSettings}
                    />
                  </DropdownMenuSubContent>
                ) : (
                  <DropdownMenuSubContent className="min-w-[14rem] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto">
                    <DropdownMenuRadioGroup value={model?.id ?? ""} onValueChange={pickModel}>
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
                  </DropdownMenuSubContent>
                )}
              </DropdownMenuSub>
              {model && efforts.length ? (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger data-testid="model-picker-effort">
                    <span className="flex-1">Effort</span>
                    <span className="ml-auto max-w-[10rem] truncate pl-3 text-[12px] text-faint">{effortName ?? (model.defaultEffort ? (EFFORT_LABEL[model.defaultEffort] ?? model.defaultEffort) : "Default")}</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-[12rem]">
                    <DropdownMenuRadioGroup value={tab.effort ?? model.defaultEffort ?? ""} onValueChange={(v) => onSetEffort(v)}>
                      {efforts.map((e) => (
                        <DropdownMenuRadioItem key={e} value={e}>
                          {EFFORT_LABEL[e] ?? e}
                          {e === tab.requestedEffort ? <span className="ml-1.5 text-faint">switching…</span> : null}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>

          <PermissionChip
            onOpen={setModeMenuOpen}
            microphone={dictation.available === true}
            permissions={{
              label: permissionLabel,
              tone: modeIsUnguarded(tab.permissionMode) ? "danger" : pickedMode === "plan" ? "plan" : null,
              lock: modeLock,
              picked: pickedMode ?? null,
              reported: tab.permissionMode,
              requested: tab.requestedPermissionMode ?? null,
              onChoose: (mode) => chooseMode(tab.harness, mode, onSetMode),
            }}
          />

          <div className="ml-auto flex shrink-0 items-center gap-1">
            <ContextPopover tab={tab} used={contextUsed} max={contextMax} reportedModel={reportedModel} local={modelsAreLocal && !remote}
              turns={turns} compacting={compacting} compactDisabled={disabled || !!heldReason || busy || sending}
              onCompact={() => onSend("/compact", [])} />
            {percent != null && <span aria-hidden className="-ml-1 pr-1 text-[11.5px] tabular-nums text-muted-foreground" data-testid="context-percent">{percent}%</span>}
            {fileSource && (
              <WithTooltip label="Mention a file" keys={["@"]}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  aria-label="Mention a file"
                  disabled={disabled}
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
            {/* Nothing can be sent: attaching and dictating into it are off too. */}
            <AttachButton attach={attach} disabled={disabled} />
            <MicButton dictation={dictation} disabled={disabled} />
            {/* One button: Stop while the agent works and nothing is typed, Send (a queued message while it works) once something is. Stop's shortcut works either way. */}
            {/* What is on its way is drawn in the chat, as sending (#727); the button waits for it. */}
            {!sending && busy && canStop && !draft.trim() && !sendable.length ? (
              <WithTooltip label={stopMode === "force" ? "Stop session" : "Stop"} keys={keysOf(stopMode === "interrupt" ? "session.interrupt" : "session.stop")}>
                <Button
                  size="icon-sm"
                  className={CORNER}
                  variant={stopMode === "force" ? "destructive" : "secondary"}
                  aria-label={stopMode === "force" ? "Stop session" : "Stop"}
                  onClick={onStop}
                >
                  <Square className="size-3 fill-current" />
                </Button>
              </WithTooltip>
            ) : (
              <SetupCheckCoach tabId={tab.id}>
                <WithTooltip label={sending ? "Sending…" : (heldReason ?? sendHint)} keys={keysOf("composer.send")}>
                  <Button
                    size="icon-sm"
                    className={CORNER}
                    variant={draft.trim() || sendable.length ? "accent" : "secondary"}
                    aria-label={sending ? "Sending" : "Send"}
                    aria-busy={sending}
                    disabled={disabled || !!heldReason || sending || prMention.attaching || (!draft.trim() && !sendable.length)}
                    onClick={() => void send()}
                  >
                    <ArrowUp />
                  </Button>
                </WithTooltip>
              </SetupCheckCoach>
            )}
          </div>
        </div>
      </div>
      {goalMissing ? (
        <div id={`${tab.id}-goal-missing`} role="alert" className="flex items-center gap-1.5 px-1 pt-1.5 text-[11.5px] text-destructive" data-testid="goal-missing">
          <CircleAlert aria-hidden className="size-3 shrink-0" />
          Type a goal after /goal, like “/goal ship saved views with tests”
        </div>
      ) : busy && followUps && alternateKeys && !heldReason && !disabled ? (
        // What Return and the other chord do with a follow-up while the agent works (PRO-380, 03.12).
        // One line, cut short rather than pushing the composer up (the whole of it is the tooltip), and none in a
        // narrow composer, where it would be a stub and its line is the room an approval's buttons need.
        <div className="truncate px-1 pt-1.5 text-[11.5px] text-faint @max-[34rem]:hidden" data-testid="follow-up-hint"
          title={`${keysOf("composer.send").join("")} ${followUps === "hold" ? "holds it for after the turn" : "sends it to the agent now"} · ${alternateKeys.replaceAll("+", "")} ${followUps === "hold" ? "sends now and interrupts" : "holds it for after the turn"} · change the default in Settings › Agents › Follow-ups`}>
          {keysOf("composer.send").join("")} {followUps === "hold" ? "holds it for after the turn" : "sends it to the agent now"}
          {" · "}{keysOf("composer.sendAlternate").join("")} {followUps === "hold" ? "sends now and interrupts" : "holds it for after the turn"}
          {" · "}change the default in{" "}
          <button type="button" className="underline-offset-2 hover:text-muted-foreground hover:underline" onClick={() => openSettingRow("agents.followUps")}>Settings › Agents › Follow-ups</button>
        </div>
      ) : null}
      {switched && tab.requestedModel === switched.to && <ModelSwitchNotice model={labelOf(switched.to)} onUndo={undoSwitch} />}
      {setupRunning && <div className="mt-1.5 px-2 text-[11px] text-muted-foreground" role="status">Setup running</div>}
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

/** The permission mode, as its chip shows and changes it. */
interface PermissionChoice {
  label: string;
  /** A mode worth seeing without opening the menu: one that asks nothing (danger), or plan. */
  tone: "danger" | "plan" | null;
  /** Why it cannot be changed from here, if it cannot. */
  lock: string | null;
  /** The picker's own id for the tab's mode; none when the agent reported one the picker does not offer (#417). */
  picked: string | null;
  reported: string;
  requested: string | null;
  onChoose: (mode: string) => void;
}

/** The permission row's icon: a shield, open to warning in a mode that asks nothing, and tinted for plan. */
function PermissionIcon({ tone }: { tone: PermissionChoice["tone"] }) {
  if (tone === "danger") return <ShieldAlert className="text-destructive" data-testid="permission-mode-icon" />;
  if (tone === "plan") return <Shield className="text-info" data-testid="permission-mode-icon" />;
  return <ShieldCheck data-testid="permission-mode-icon" />;
}

/**
 * The permission mode as a chip beside the model (`Ask ⌄`): the mode in force
 * is always on screen, and its menu picks another.
 */
function PermissionChip({ permissions: p, onOpen, microphone }: { permissions: PermissionChoice; onOpen: (open: boolean) => void; microphone: boolean }) {
  // Opens on a click and an accessibility press too, like the model picker.
  const menu = useRowMenu({ onOpenChange: onOpen });
  const short = shortMode(p.picked) ?? p.label;
  return (
    <DropdownMenu {...menu.root}>
      <DropdownMenuTrigger asChild {...menu.trigger} disabled={!!p.lock}>
        <Button
          variant="ghost"
          size="sm"
          className={cn("shrink-0 gap-1.5 px-2", p.tone === "danger" ? "text-destructive" : p.tone === "plan" ? "text-info" : "text-muted-foreground")}
          title={p.lock ?? `Permission mode: ${p.label}`}
          aria-label={`Permission mode: ${p.lock ?? p.label}`}
          data-testid="permission-mode"
        >
          <PermissionIcon tone={p.tone} />
          <span className="max-w-40 truncate" data-testid="permission-mode-label">{short}</span>
          <ChevronDown className="size-3 text-faint" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[16rem]">
        <DropdownMenuLabel>Permissions</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={p.picked ?? p.reported} onValueChange={p.onChoose}>
          {/* A mode set in the terminal that the picker does not offer is still the one in force. */}
          {!p.picked && (
            <DropdownMenuRadioItem value={p.reported} className="flex-col items-start gap-0" data-testid="permission-mode-reported">
              <span>{p.label}</span>
              <span className="text-[11px] text-faint">Set in the terminal.</span>
            </DropdownMenuRadioItem>
          )}
          {PERMISSION_MODES.map((m) => (
            <DropdownMenuRadioItem key={m.id} value={m.id} className="flex-col items-start gap-0">
              <span>
                {m.label}
                {m.id === p.requested ? <span className="ml-1.5 text-faint">switching…</span> : null}
              </span>
              <span className="text-[11px] text-faint">{m.hint}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {microphone && <><DropdownMenuSeparator /><TranscriptionInputSubmenu /></>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const NO_TURNS: readonly Turn[] = [];


const isEmptyGoal = (draft: string) => goalCommand(draft) === "";
