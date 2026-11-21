/**
 * Slack and Telegram as a bot's channels (PRO-481): what the Channels rows say, the dialog that connects a service
 * with the owner's own app or bot and links a chat with a one-time code, and "Also sends to" beside the send button
 * of the bot's home chat (design 23.04). The tokens are typed here and go to the window's own command, which checks
 * them with the service and keeps them with the bots' other logins; nothing here reads them back.
 */
import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, Hash, Loader2, Send } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/menu";
import { WithTooltip } from "@/components/ui/tooltip";
import { botsApi, errorMessage } from "@/lib/api";
import { chatAppName, refreshChatApps, setChatApps, useChatApps } from "@/lib/botChatApps";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/time";
import type { Bot } from "@/types/bots";
import type { BotChatAppsView, ChatAppService, ChatAppServiceView } from "@/types/botChatApps";

export const CHAT_APP_ICON = { slack: Hash, telegram: Send } as const;

/** What a service's row in Channels says: its state, whether it is on, and the line after it. */
export function chatAppRow(bot: Pick<Bot, "name">, service: ChatAppService, view: ChatAppServiceView | undefined): { state: string; on: boolean; detail: string } {
  if (!view || !view.connected) {
    return {
      state: "Not connected",
      on: false,
      detail: service === "slack" ? `Message ${bot.name} in Slack` : `Message ${bot.name} from your phone's chat app`,
    };
  }
  if (view.state === "failing") return { state: "Can't reach it", on: false, detail: view.why || `${chatAppName(service)} did not answer` };
  const places = view.links.map((link) => (link.direct ? "Direct chat" : link.name));
  const where = places.length ? places.join(", ") : "No chat linked yet";
  const how = service === "slack" ? "replies in the thread it was asked in" : "replies in the chat it was asked in";
  return { state: view.state === "connecting" ? "Connecting…" : "Connected", on: view.state !== "connecting", detail: places.length ? `${where} · ${how}` : `${view.account?.name ?? ""} · ${where}` };
}

const FIELD = "h-8 w-full min-w-0 rounded-md border border-hairline bg-transparent px-2 font-mono text-[12.5px] outline-none focus:border-ring";

const STEPS: Record<ChatAppService, { title: string; steps: string[]; fields: { key: string; label: string; placeholder: string }[] }> = {
  telegram: {
    title: "Your own Telegram bot",
    steps: [
      "In Telegram, open @BotFather and send /newbot. Give it a name and a username ending in “bot”.",
      "BotFather answers with the bot's token. Paste it below.",
      "Then link a chat: open the bot and send it the code TerminalX shows you. In a group, add the bot and send /link@yourbot and the code.",
    ],
    fields: [{ key: "token", label: "Bot token", placeholder: "123456789:AAE…" }],
  },
  slack: {
    title: "Your own Slack app",
    steps: [
      "At api.slack.com/apps, create an app from scratch in your workspace.",
      "Socket Mode: turn it on, and make an app-level token with connections:write (it starts xapp-).",
      "OAuth & Permissions: add the bot scopes chat:write, im:history, app_mentions:read, users:read, users:read.email and channels:read.",
      "Event Subscriptions: subscribe the bot to message.im and app_mention. Interactivity: turn it on. App Home: let people send messages from the Messages tab.",
      "Install the app to the workspace, and paste its bot token (xoxb-) and app-level token below.",
    ],
    fields: [
      { key: "botToken", label: "Bot token", placeholder: "xoxb-…" },
      { key: "appToken", label: "App-level token", placeholder: "xapp-…" },
    ],
  },
};

const MESSAGE_STATE: Record<string, string> = { waiting: "Waiting", delivered: "Reached it", notAccepted: "Not accepted", failed: "Didn't reach it" };

/** Connect a service, link its chats with a code, see what came, and disconnect. */
export function ChatAppDialog({ bot, service, onClose }: { bot: Bot; service: ChatAppService; onClose: () => void }) {
  const view = useChatApps(bot.id);
  const shown = view?.services.find((entry) => entry.service === service);
  const name = chatAppName(service);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const steps = STEPS[service];

  const act = async (what: string, run: () => Promise<BotChatAppsView | unknown>) => {
    setBusy(what);
    setError(null);
    try {
      const answer = await run();
      if (answer && typeof answer === "object" && "services" in answer) setChatApps(bot.id, answer as BotChatAppsView);
      else await refreshChatApps(bot.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };
  const connect = () => act("connect", async () => {
    const tokens = Object.fromEntries(steps.fields.map((field) => [field.key, (values[field.key] ?? "").trim()]));
    await botsApi.chatAppConnect(bot.id, service, tokens);
    setValues({});
    return botsApi.chatApps(bot.id);
  });
  const ready = steps.fields.every((field) => (values[field.key] ?? "").trim().length > 0);

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent width="max-w-[30rem]" className="p-4" data-testid={`bot-chat-app-dialog-${service}`}>
        <DialogTitle className="mr-8 text-sm font-semibold">{shown?.connected ? `${name} · ${shown.account?.name ?? ""}` : `Connect ${name}`}</DialogTitle>
        <DialogDescription className="mt-1 text-xs leading-[18px] text-muted-foreground">
          {`Messages from a chat you link reach ${bot.name}; its replies, reports and questions come back there. Messages from any other chat are refused and never reach it.`}
        </DialogDescription>

        {!shown?.connected ? (
          <form className="mt-3 flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (ready && !busy) void connect(); }}>
            <div className="text-[12.5px] font-medium text-foreground">{steps.title}</div>
            <ol className="list-decimal space-y-1 pl-4 text-xs leading-[18px] text-muted-foreground">
              {steps.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
            {steps.fields.map((field) => (
              <label key={field.key} className="flex flex-col gap-1 text-xs text-muted-foreground">
                {field.label}
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={values[field.key] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(event) => setValues((old) => ({ ...old, [field.key]: event.target.value }))}
                  className={FIELD}
                  data-testid={`bot-chat-app-${service}-${field.key}`}
                />
              </label>
            ))}
            <p className="text-[11.5px] leading-4 text-faint">Kept on this Mac with the bots' other logins, readable by you alone; never in the bot's settings or its chats.</p>
            {error && <p role="alert" className="text-xs text-destructive" data-testid="bot-chat-app-error">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
              <Button type="submit" size="sm" disabled={!ready || !!busy} data-testid="bot-chat-app-connect">
                {busy === "connect" && <Loader2 className="animate-spin" />}
                {busy === "connect" ? "Checking…" : "Connect"}
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {shown.state === "failing" && <p role="alert" className="text-xs text-destructive">{shown.why || `${name} did not answer.`}</p>}
            <div>
              <div className="mb-1 text-[12px] font-medium text-muted-foreground">Linked chats</div>
              {shown.links.length === 0 ? (
                <p className="text-xs text-faint">None yet: make a code and send it from the chat to link.</p>
              ) : (
                <ul className="rounded-md border border-hairline px-2.5" data-testid="bot-chat-app-links">
                  {shown.links.map((link) => (
                    <li key={link.chat} className="flex min-h-8 items-center gap-2 border-t border-hairline py-1 text-[12.5px] first:border-t-0">
                      <span className="min-w-0 flex-1 truncate">{link.direct ? "Direct chat" : link.name}</span>
                      <span className="shrink-0 text-[11.5px] text-faint">{`by ${link.by} · ${relativeTime(link.linked)}`}</span>
                      <Button variant="ghost" size="xs" disabled={!!busy} onClick={() => void act(`unlink:${link.chat}`, () => botsApi.chatAppUnlink(bot.id, service, link.chat))} aria-label={`Unlink ${link.direct ? "the direct chat" : link.name}`}>Unlink</Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {shown.code ? (
              <div className="rounded-md border border-hairline bg-card/60 p-2.5" data-testid="bot-chat-app-code">
                <div className="text-xs text-muted-foreground">
                  {service === "telegram" ? `Send this code to ${shown.account?.name ?? "the bot"} from the chat to link, or open the link on your phone.` : `Send this code to the app in a direct message, or mention it with the code in a channel it is in.`}
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="font-mono text-[18px] tracking-[0.2em] text-foreground">{shown.code.code}</span>
                  <WithTooltip label={copied ? "Copied" : "Copy the code"}>
                    <Button variant="ghost" size="icon-xs" aria-label="Copy the code" onClick={() => { void navigator.clipboard?.writeText(shown.code!.code); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }}>
                      {copied ? <Check /> : <Copy />}
                    </Button>
                  </WithTooltip>
                  {shown.code.link && <Button variant="outline" size="xs" onClick={() => void openUrl(shown.code!.link!)}>Open in Telegram</Button>}
                  {shown.code.expires && <span className="ml-auto text-[11.5px] text-faint">{`Good for 10 minutes`}</span>}
                </div>
              </div>
            ) : (
              <div>
                <Button variant="outline" size="sm" disabled={!!busy} onClick={() => void act("link", () => botsApi.chatAppLink(bot.id, service))} data-testid="bot-chat-app-link">
                  {busy === "link" && <Loader2 className="animate-spin" />}Link a chat
                </Button>
              </div>
            )}
            <Activity view={view} service={service} />
            {error && <p role="alert" className="text-xs text-destructive" data-testid="bot-chat-app-error">{error}</p>}
            <div className="flex items-center justify-between gap-2">
              <Button variant="ghost" size="sm" className="text-destructive" disabled={!!busy} onClick={() => void act("disconnect", () => botsApi.chatAppDisconnect(bot.id, service))} data-testid="bot-chat-app-disconnect">Disconnect</Button>
              <Button size="sm" onClick={onClose}>Done</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The newest messages from the service: who, where and what became of them, never what they said. */
function Activity({ view, service }: { view: BotChatAppsView | null; service: string }) {
  const rows = (view?.activity ?? []).filter((message) => message.service === service).slice(0, 5);
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[12px] font-medium text-muted-foreground">Lately</div>
      <ul className="rounded-md border border-hairline px-2.5" data-testid="bot-chat-app-activity">
        {rows.map((message, index) => (
          <li key={`${message.at}:${index}`} className="flex min-h-8 items-center gap-2 border-t border-hairline py-1 text-[12px] first:border-t-0">
            <span className={cn("w-[96px] shrink-0", message.state === "delivered" ? "text-muted-foreground" : "text-faint")}>{MESSAGE_STATE[message.state] ?? message.state}</span>
            <span className="min-w-0 flex-1 truncate text-faint" title={message.why || undefined}>
              {`${message.by} · ${message.direct ? "Direct chat" : message.chat}${message.why ? ` · ${message.why}` : ""}`}
            </span>
            <span className="shrink-0 text-[11.5px] text-faint">{relativeTime(message.at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * "Also sends to" beside the send button of a bot's home chat (design 23.04): the linked direct chats its replies to
 * what you write here also go to. Shown only when one is linked.
 */
export function AlsoSendsTo({ botId }: { botId: string }) {
  const view = useChatApps(botId);
  const [busy, setBusy] = useState(false);
  if (!view) return null;
  const linked = view.services.filter((service) => service.connected && service.links.some((link) => link.direct));
  if (linked.length === 0) return null;
  const chosen = view.alsoSendsTo.filter((service) => linked.some((entry) => entry.service === service));
  const toggle = (service: string, on: boolean) => {
    const next = on ? [...chosen, service] : chosen.filter((known) => known !== service);
    setBusy(true);
    void botsApi.chatAppAlsoSends(botId, next).then((answer) => setChatApps(botId, answer), () => void refreshChatApps(botId)).finally(() => setBusy(false));
  };
  const first = chosen[0];
  const Icon = first ? CHAT_APP_ICON[first as ChatAppService] ?? Send : Send;
  return (
    <DropdownMenu>
      <WithTooltip label="Where its replies to this chat also go">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs" className={cn("gap-1 text-[11.5px]", chosen.length ? "text-muted-foreground" : "text-faint")} disabled={busy} data-testid="bot-also-sends-to">
            <span>Also sends to</span>
            <Icon />
            <span>{chosen.length ? chosen.map(chatAppName).join(", ") : "nowhere"}</span>
          </Button>
        </DropdownMenuTrigger>
      </WithTooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Its replies here also go to your</DropdownMenuLabel>
        {linked.map((service) => (
          <DropdownMenuCheckboxItem key={service.service} checked={chosen.includes(service.service)} onCheckedChange={(on) => toggle(service.service, on === true)} data-testid={`bot-also-sends-to-${service.service}`}>
            {`${chatAppName(service.service)} direct chat`}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
