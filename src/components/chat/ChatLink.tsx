import { useCallback, useEffect, useMemo, useRef, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";
import type { ExtraProps } from "streamdown";
import { Popover } from "radix-ui";
import {
  BLOCKED_EXTERNAL_PATH_MESSAGE,
  chatLinkCanOpenInternally,
  chatLinkCopyValue,
  chatLinkNeedsExternalOpen,
  inspectChatFile,
  isBlockedExternalPath,
  isCitedFileHref,
  openChatLink,
  openChatLinkExternally,
  openChatLinkInBrowser,
  originalChatHref,
  parseChatLink,
  revealChatLink,
  type ChatLinkContext,
} from "@/lib/chatLinks";
import { openFile } from "@/lib/editors";
import { getPrefs, setPrefs, usePrefs } from "@/lib/prefs";
import type { LocalPathInfo } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/menu";
import { copyText } from "@/lib/clipboard";
import { fileManager, isMac, revealInFileManager } from "@/lib/platform";
import { citedFileKind, type CitedFileKind } from "@/lib/codexCitations";
import { File, FileImage, FilePdf, FileSpreadsheet, FileText, Presentation } from "@/icons";

/** `file`: drawn as the chip of a file the agent handed over (#776), not as an inline link. */
type Props = AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps & { context?: ChatLinkContext; file?: boolean };
const EXTERNAL_CONTEXT: ChatLinkContext = { sessionId: "", cwd: "" };

const BROWSER_NAMES = { system: "System Browser", terminalx: "TerminalX Browser" };
const FILE_ICONS: Record<CitedFileKind, typeof File> = { spreadsheet: FileSpreadsheet, presentation: Presentation, pdf: FilePdf, image: FileImage, document: FileText, file: File };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ChatLink({ context = EXTERNAL_CONTEXT, href = "", children, className, file, node: _node, ...props }: Props) {
  const prefs = usePrefs();
  const hasWorkspace = !!context.cwd && !!context.sessionId;
  const browserPreference = hasWorkspace ? prefs.linkBrowser : "system";
  const primaryBrowser = browserPreference === "terminalx" ? "terminalx" : "system";
  const alternateBrowser = primaryBrowser === "system" ? "terminalx" : "system";
  const originalHref = originalChatHref(href);
  const destination = useMemo(() => parseChatLink(originalHref), [originalHref]);
  const identity = `${context.sessionId}\0${context.cwd}\0${context.basePath ?? ""}\0${originalHref}`;
  const element = useRef<HTMLAnchorElement>(null);
  const currentIdentity = useRef(identity);
  const request = useRef(0);
  if (currentIdentity.current !== identity) {
    currentIdentity.current = identity;
    request.current++;
  }
  const [error, setError] = useState<string | null>(null);
  const [inspected, setInspected] = useState<{ identity: string; info: LocalPathInfo } | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [chooserIdentity, setChooserIdentity] = useState<string | null>(null);
  const [confirmExternal, setConfirmExternal] = useState<{ identity: string; info: LocalPathInfo } | null>(null);
  const [rememberChoice, setRememberChoice] = useState(false);
  const asksForBrowser = destination.kind === "web" && browserPreference === "ask";
  const chooserOpen = asksForBrowser && chooserIdentity === identity;
  const confirmOpen = destination.kind === "local" && confirmExternal?.identity === identity ? confirmExternal.info : null;
  const popoverOpen = chooserOpen || !!confirmOpen;
  const info = inspected?.identity === identity ? inspected.info : null;

  useEffect(() => {
    setError(null);
    setInspected(null);
    setInspecting(null);
    setChooserIdentity(null);
    setConfirmExternal(null);
    setRememberChoice(false);
  }, [identity]);

  const run = useCallback((action: () => Promise<void>) => {
    setError(null);
    const actionIdentity = identity;
    void action().catch((e) => {
      if (currentIdentity.current === actionIdentity) setError(message(e));
    });
  }, [identity]);

  const inspect = useCallback(() => {
    if (destination.kind !== "local") return;
    const sequence = ++request.current;
    setError(null);
    setInspecting(identity);
    setInspected(null);
    void inspectChatFile(destination, context)
      .then((next) => {
        if (request.current === sequence && currentIdentity.current === identity) setInspected({ identity, info: next });
      })
      .catch((e) => {
        if (request.current === sequence && currentIdentity.current === identity) setError(message(e));
      })
      .finally(() => {
        if (request.current === sequence && currentIdentity.current === identity) setInspecting(null);
      });
  }, [context, destination, identity]);

  const copy = useCallback(() => {
    run(() => copyText(chatLinkCopyValue(destination, info ?? undefined)));
  }, [destination, info, run]);

  const requestExternalOpen = useCallback((resolved: LocalPathInfo) => {
    setError(null);
    if (isBlockedExternalPath(resolved.path)) {
      setError(BLOCKED_EXTERNAL_PATH_MESSAGE);
      return;
    }
    setConfirmExternal({ identity, info: resolved });
  }, [identity]);

  const activate = (alternate = false) => {
    const browser = hasWorkspace ? getPrefs().linkBrowser : "system";
    if (destination.kind === "web") {
      if (alternate && hasWorkspace) {
        // In ask mode the alternate keeps the explicit TerminalX shortcut.
        run(() => openChatLinkInBrowser(destination, context, browser === "terminalx" ? "system" : "terminalx"));
        return;
      }
      if (browser === "ask") {
        setError(null);
        setRememberChoice(false);
        setChooserIdentity(identity);
        return;
      }
      run(() => openChatLinkInBrowser(destination, context, browser));
      return;
    }
    if (destination.kind === "local") {
      run(async () => {
        const resolved = await inspectChatFile(destination, context);
        if (currentIdentity.current !== identity) return;
        if (!chatLinkNeedsExternalOpen(resolved)) {
          openFile(context.sessionId, resolved.root, resolved.rel, destination.line ? { line: destination.line, col: destination.col } : undefined, context.cwd);
          return;
        }
        requestExternalOpen(resolved);
      });
      return;
    }
    run(() => openChatLink(destination, context, element.current));
  };

  const confirmAndOpenExternal = () => {
    const target = confirmOpen;
    setConfirmExternal(null);
    if (!target || destination.kind !== "local") return;
    run(() => openChatLinkExternally(destination, context, target));
  };

  const revealConfirmed = () => {
    const target = confirmOpen;
    setConfirmExternal(null);
    if (!target || destination.kind !== "local") return;
    run(() => revealChatLink(destination, context, target));
  };

  const chooseBrowser = (browser: "system" | "terminalx") => {
    setChooserIdentity(null);
    if (rememberChoice) setPrefs({ linkBrowser: browser, linkBrowserChosen: true });
    run(() => openChatLinkInBrowser(destination, context, browser));
  };

  const anchor = (
    <a
      {...props}
      ref={element}
      href={href}
      target={undefined}
      rel={undefined}
      className={file
        ? `inline-flex h-7 max-w-full items-center gap-1.5 rounded-md px-2 align-middle text-[12.5px] font-medium text-foreground ring-1 ring-hairline-strong transition-colors hover:bg-veil-raised ${className ?? ""}`
        : `wrap-anywhere font-medium text-primary underline ${className ?? ""}`}
      data-streamdown="link"
      data-file-chip={file || undefined}
      // A link's own title (a cited file's full path) comes first; a website link adds how to choose a browser.
      title={destination.kind === "web" ? `${props.title ? `${props.title}\n` : ""}${asksForBrowser ? "Choose a browser" : `Open in ${BROWSER_NAMES[primaryBrowser]}`}${hasWorkspace ? `; ${isMac ? "⇧⌘" : "Shift+Ctrl"}-click to open in ${BROWSER_NAMES[alternateBrowser]}` : ""}` : props.title}
      aria-haspopup={asksForBrowser ? "dialog" : undefined}
      aria-expanded={asksForBrowser ? chooserOpen : undefined}
      tabIndex={props.tabIndex ?? (asksForBrowser ? 0 : undefined)}
      aria-invalid={destination.kind === "rejected" || undefined}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        activate(event.shiftKey && (event.metaKey || event.ctrlKey));
      }}
      onAuxClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        activate();
      }}
    >
      {file ? <>
        <FileIcon kind={citedFileKind(originalHref)} />
        <span className="min-w-0 truncate">{children}</span>
      </> : children}
    </a>
  );

  return (
    <span className="contents">
      <Popover.Root open={popoverOpen} onOpenChange={(open) => { if (!open) { setChooserIdentity(null); setConfirmExternal(null); } }}>
        <ContextMenu onOpenChange={(open) => {
          if (open) {
            setChooserIdentity(null);
            setConfirmExternal(null);
            inspect();
          }
        }}>
          {destination.kind === "web" || destination.kind === "local" ? (
            <Popover.Trigger asChild>
              <ContextMenuTrigger asChild>{anchor}</ContextMenuTrigger>
            </Popover.Trigger>
          ) : <ContextMenuTrigger asChild>{anchor}</ContextMenuTrigger>}
          <ContextMenuContent>
            {destination.kind === "web" ? <>
              <ContextMenuItem onSelect={() => run(() => openChatLinkInBrowser(destination, context, primaryBrowser))}>Open in {BROWSER_NAMES[primaryBrowser]}</ContextMenuItem>
              {prefs.linkActions && hasWorkspace && <ContextMenuItem onSelect={() => run(() => openChatLinkInBrowser(destination, context, alternateBrowser))}>Open in {BROWSER_NAMES[alternateBrowser]}</ContextMenuItem>}
            </> : destination.kind === "application" ? (
              <ContextMenuItem onSelect={() => run(() => openChatLink(destination, context))}>Open with default application</ContextMenuItem>
            ) : destination.kind === "local" ? inspecting === identity ? (
              <ContextMenuItem disabled>Checking destination…</ContextMenuItem>
            ) : info ? <>
              {info.kind === "directory" ? (
                <ContextMenuItem onSelect={() => requestExternalOpen(info)}>Open in {fileManager}</ContextMenuItem>
              ) : <>
                {chatLinkCanOpenInternally(info) && (
                  <ContextMenuItem onSelect={() => openFile(context.sessionId, info.root, info.rel, destination.line ? { line: destination.line, col: destination.col } : undefined, context.cwd)}>Open internally</ContextMenuItem>
                )}
                {!isBlockedExternalPath(info.path) && (
                  <ContextMenuItem onSelect={() => requestExternalOpen(info)}>Open with default application</ContextMenuItem>
                )}
                <ContextMenuItem onSelect={() => run(() => revealChatLink(destination, context, info))}>{revealInFileManager}</ContextMenuItem>
              </>}
            </> : (
              <ContextMenuItem disabled>Destination unavailable</ContextMenuItem>
            ) : destination.kind === "rejected" ? (
              <ContextMenuItem disabled>{destination.reason}</ContextMenuItem>
            ) : null}
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={copy}>{destination.kind === "local" ? "Copy path" : "Copy link"}</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <Popover.Portal>
          {confirmOpen ? (
            <Popover.Content
              aria-label="Confirm external open"
              sideOffset={4}
              align="start"
              collisionPadding={8}
              className="z-(--z-menu) flex max-w-[min(28rem,calc(100vw-16px))] flex-col gap-2 rounded-lg bg-popover p-3 text-popover-foreground shadow-surface hairline animate-fade-in"
              onClick={(event) => event.stopPropagation()}
            >
              <p className="text-xs font-medium text-foreground">
                {confirmOpen.kind === "directory" ? `Open this folder in ${fileManager}?` : "Open this file with its default application?"}
              </p>
              <code className="break-all rounded bg-well px-2 py-1 font-mono text-[11px] text-muted-foreground" data-testid="confirm-external-path">
                {confirmOpen.path}
              </code>
              <div className="flex flex-wrap items-center justify-end gap-1.5 pt-1">
                <Button tabIndex={0} size="xs" variant="ghost" onClick={() => setConfirmExternal(null)}>Cancel</Button>
                {confirmOpen.kind === "file" && (
                  <Button tabIndex={0} size="xs" variant="outline" onClick={revealConfirmed}>{revealInFileManager}</Button>
                )}
                <Button tabIndex={0} size="xs" variant="secondary" onClick={confirmAndOpenExternal}>
                  {confirmOpen.kind === "directory" ? `Open in ${fileManager}` : "Open"}
                </Button>
              </div>
            </Popover.Content>
          ) : (
            <Popover.Content
              aria-label="Open website link"
              sideOffset={4}
              align="start"
              collisionPadding={8}
              className="z-(--z-menu) flex flex-col rounded-lg bg-popover p-1 text-popover-foreground shadow-surface hairline animate-fade-in"
              onClick={(event) => event.stopPropagation()}
            >
              {/* Explicit tab stops also work with macOS WebKit's default keyboard navigation. */}
              <Button tabIndex={0} variant="ghost" className="justify-start text-popover-foreground" onClick={() => chooseBrowser("system")}>Open in system browser</Button>
              <Button tabIndex={0} variant="ghost" className="justify-start text-popover-foreground" onClick={() => chooseBrowser("terminalx")}>Open in TerminalX browser</Button>
              <label className="mt-1 flex cursor-pointer items-center gap-2 border-t border-hairline px-3 py-2 text-xs">
                <input type="checkbox" tabIndex={0} checked={rememberChoice} onChange={(event) => setRememberChoice(event.target.checked)} className="accent-primary" />
                Remember my choice
              </label>
            </Popover.Content>
          )}
        </Popover.Portal>
      </Popover.Root>
      {error && <span role="alert" className="ml-1 text-xs text-destructive">Could not open link: {error}</span>}
    </span>
  );
}

function FileIcon({ kind }: { kind: CitedFileKind }) {
  const Icon = FILE_ICONS[kind];
  return <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
}

export function chatLinkComponent(context?: ChatLinkContext) {
  return function RoutedChatLink(props: AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) {
    return <ChatLink {...props} context={context} file={isCitedFileHref(props.href)} />;
  };
}
