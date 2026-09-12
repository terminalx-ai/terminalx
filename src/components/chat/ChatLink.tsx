import { useCallback, useEffect, useMemo, useRef, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";
import type { ExtraProps } from "streamdown";
import {
  chatLinkCanOpenInternally,
  chatLinkCopyValue,
  inspectChatFile,
  openChatLink,
  openChatLinkExternally,
  originalChatHref,
  parseChatLink,
  revealChatLink,
  type ChatLinkContext,
} from "@/lib/chatLinks";
import type { LocalPathInfo } from "@/lib/api";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/menu";

type Props = AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps & { context: ChatLinkContext };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ChatLink({ context, href = "", children, className, node: _node, ...props }: Props) {
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
  const info = inspected?.identity === identity ? inspected.info : null;

  useEffect(() => {
    setError(null);
    setInspected(null);
    setInspecting(null);
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

  const anchor = (
    <a
      {...props}
      href={href}
      target={undefined}
      rel={undefined}
      className={`wrap-anywhere font-medium text-primary underline ${className ?? ""}`}
      data-streamdown="link"
      aria-invalid={destination.kind === "rejected" || undefined}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        run(() => openChatLink(destination, context));
      }}
      onAuxClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        run(() => openChatLink(destination, context));
      }}
    >
      {children}
    </a>
  );

  return (
    <span className="contents">
      <ContextMenu onOpenChange={(open) => open && inspect()}>
        <ContextMenuTrigger asChild>{anchor}</ContextMenuTrigger>
        <ContextMenuContent>
          {destination.kind === "web" ? <>
            <ContextMenuItem onSelect={() => run(() => openChatLink(destination, context))}>Open internally</ContextMenuItem>
            <ContextMenuItem onSelect={() => run(() => openChatLinkExternally(destination, context))}>Open in default browser</ContextMenuItem>
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
      {error && <span role="alert" className="ml-1 text-xs text-destructive">Could not open link: {error}</span>}
    </span>
  );
}

export function chatLinkComponent(context: ChatLinkContext) {
  return function RoutedChatLink(props: AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) {
    return <ChatLink {...props} context={context} />;
  };
}
