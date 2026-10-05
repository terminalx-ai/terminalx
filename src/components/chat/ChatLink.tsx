import { useCallback, useEffect, useMemo, useRef, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";
import type { ExtraProps } from "streamdown";
import { Popover } from "radix-ui";
import {
  chatLinkCanOpenInternally,
  chatLinkCopyValue,
  inspectChatFile,
  openChatLink,
  openChatLinkExternally,
  openChatLinkInBrowser,
  originalChatHref,
  parseChatLink,
  revealChatLink,
  type ChatLinkContext,
} from "@/lib/chatLinks";
import { getPrefs, setPrefs, usePrefs } from "@/lib/prefs";
import type { LocalPathInfo } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/menu";

type Props = AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps & { context?: ChatLinkContext };
const EXTERNAL_CONTEXT: ChatLinkContext = { sessionId: "", cwd: "" };

const BROWSER_NAMES = { system: "System Browser", terminalx: "TerminalX Browser" };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ChatLink({ context = EXTERNAL_CONTEXT, href = "", children, className, node: _node, ...props }: Props) {
  const prefs = usePrefs();
  const hasWorkspace = !!context.cwd && !!context.sessionId;
  const browserPreference = hasWorkspace ? prefs.linkBrowser : "system";
  const primaryBrowser = browserPreference === "terminalx" ? "terminalx" : "system";
  const alternateBrowser = primaryBrowser === "system" ? "terminalx" : "system";
  const originalHref = originalChatHref(href);
  const destination = useMemo(() => parseChatLink(originalHref), [originalHref]);
  const identity = `${context.sessionId}\0${context.cwd}\0${context.basePath ?? ""}\0${originalHref}`;
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
  const [rememberChoice, setRememberChoice] = useState(false);
  const asksForBrowser = destination.kind === "web" && browserPreference === "ask";
  const chooserOpen = asksForBrowser && chooserIdentity === identity;
  const info = inspected?.identity === identity ? inspected.info : null;

  useEffect(() => {
    setError(null);
    setInspected(null);
    setInspecting(null);
    setChooserIdentity(null);
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
    run(async () => navigator.clipboard.writeText(chatLinkCopyValue(destination, info ?? undefined)));
  }, [destination, info, run]);

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
    run(() => openChatLink(destination, context));
  };

  const chooseBrowser = (browser: "system" | "terminalx") => {
    setChooserIdentity(null);
    if (rememberChoice) setPrefs({ linkBrowser: browser, linkBrowserChosen: true });
    run(() => openChatLinkInBrowser(destination, context, browser));
  };

  const anchor = (
    <a
      {...props}
      href={href}
      target={undefined}
      rel={undefined}
      className={`wrap-anywhere font-medium text-primary underline ${className ?? ""}`}
      data-streamdown="link"
      title={destination.kind === "web" ? `${asksForBrowser ? "Choose a browser" : `Open in ${BROWSER_NAMES[primaryBrowser]}`}${hasWorkspace ? `; ${navigator.platform.toLowerCase().includes("mac") ? "⇧⌘" : "Shift+Ctrl"}-click to open in ${BROWSER_NAMES[alternateBrowser]}` : ""}` : undefined}
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
      {children}
    </a>
  );

  return (
    <span className="contents">
      <Popover.Root open={chooserOpen} onOpenChange={(open) => { if (!open) setChooserIdentity(null); }}>
        <ContextMenu onOpenChange={(open) => {
          if (open) {
            setChooserIdentity(null);
            inspect();
          }
        }}>
          {destination.kind === "web" ? (
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
                <ContextMenuItem onSelect={() => run(() => openChatLink(destination, context))}>Open in file manager</ContextMenuItem>
              ) : <>
                {chatLinkCanOpenInternally(info) && (
                  <ContextMenuItem onSelect={() => run(() => openChatLink(destination, context))}>Open internally</ContextMenuItem>
                )}
                <ContextMenuItem onSelect={() => run(() => openChatLinkExternally(destination, context, info))}>Open with default application</ContextMenuItem>
                <ContextMenuItem onSelect={() => run(() => revealChatLink(destination, context, info))}>Reveal in file manager</ContextMenuItem>
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
          <Popover.Content
            aria-label="Open website link"
            sideOffset={4}
            align="start"
            collisionPadding={8}
            className="z-(--z-menu) flex flex-col rounded-lg bg-popover glass p-1 text-popover-foreground shadow-surface hairline animate-fade-in"
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
        </Popover.Portal>
      </Popover.Root>
      {error && <span role="alert" className="ml-1 text-xs text-destructive">Could not open link: {error}</span>}
    </span>
  );
}

export function chatLinkComponent(context?: ChatLinkContext) {
  return function RoutedChatLink(props: AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) {
    return <ChatLink {...props} context={context} />;
  };
}
