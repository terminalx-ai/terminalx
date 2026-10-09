import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal as Xterm } from "@xterm/xterm";
import { buildTranscript } from "@terminalx/portable/transcript";
import type { AgentEvent } from "@terminalx/portable/events";
import { Chat } from "@/components/chat/Chat";
import { Button } from "@/components/ui/button";
import { signIn, useAccount } from "@/lib/account";
import { SessionGuestClient } from "@/lib/sessionGuest";
import type { SharePerson, ShareRole, ShareState } from "@/lib/localSharing";
import { errorMessage } from "@/lib/api";

interface GuestStatus {
  admitted: boolean;
  you?: { person: SharePerson; role: ShareRole; canApprove: boolean };
  state?: ShareState;
}
interface GuestTab {
  kind?: "agent" | "terminal";
  id: string;
  title?: string;
  harness: string;
  status: string;
}

function GuestTerminal({
  client,
  tabId,
  error,
}: {
  client: SessionGuestClient;
  tabId: string;
  error: (message: string) => void;
}) {
  const node = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!node.current) return;
    const terminal = new Xterm({ disableStdin: true, cursorBlink: false, fontSize: 13, scrollback: 10_000 });
    terminal.open(node.current);
    let cancelled = false;
    let previous = "";
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const output = await client.request<{ text: string; cols: number; rows: number }>("terminal.read", { tabId });
        if (cancelled) return;
        terminal.resize(output.cols, output.rows);
        // Host dimensions are authoritative. There is no onData or resize RPC.
        if (output.text.startsWith(previous)) terminal.write(output.text.slice(previous.length));
        else {
          terminal.reset();
          terminal.write(output.text);
        }
        previous = output.text;
      } catch (e) {
        if (!cancelled) error(errorMessage(e));
      }
      if (!cancelled) timer = setTimeout(() => void read(), 1000);
    }
    void read();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      terminal.dispose();
    };
  }, [client, tabId, error]);
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-black p-3">
      <div ref={node} />
    </div>
  );
}

export function GuestSessionHost() {
  const [link, setLink] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const update = () =>
      void invoke<string | null>("session_join_pending")
        .then((pending) => {
          if (live) setLink(pending);
        })
        .catch(() => undefined);
    const subscription = listen("session_join_requested", update).catch(() => () => undefined);
    update();
    return () => {
      live = false;
      void subscription.then((unlisten) => unlisten());
    };
  }, []);
  if (!link) return null;
  return (
    <GuestSession
      key={link}
      link={link}
      leave={() => {
        setLink(null);
        void invoke("session_guest_leave");
      }}
    />
  );
}

function GuestSession({ link, leave }: { link: string; leave: () => void }) {
  const { status: account } = useAccount();
  const [client, setClient] = useState<SessionGuestClient | null>(null);
  const [status, setStatus] = useState<GuestStatus | null>(null);
  const [tabs, setTabs] = useState<GuestTab[]>([]);
  const [title, setTitle] = useState("Shared session");
  const [tabId, setTabId] = useState("");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [terminal, setTerminal] = useState(false);
  const [error, setError] = useState("");
  const [closed, setClosed] = useState(false);
  const [sending, setSending] = useState(false);
  const selected = useRef(tabId);
  selected.current = tabId;
  useEffect(() => {
    if (account.state !== "signed-in") return;
    let cancelled = false;
    let connection: SessionGuestClient | null = null;
    void SessionGuestClient.join(link, (reason) => {
      if (!cancelled) {
        setError(reason);
        setClosed(true);
        setClient(null);
        setEvents([]);
        setStatus(null);
      }
    })
      .then(async (joined) => {
        connection = joined;
        if (cancelled) {
          joined.close();
          return;
        }
        joined.subscribe((method, value) => {
          if (cancelled) return;
          if (method === "share.changed") setStatus(value as GuestStatus);
          if (method === "session.event") {
            const event = (value as { event: AgentEvent }).event;
            if (event.sessionId === joined.sessionId && event.tabId === selected.current)
              setEvents((current) => mergeEvents(current, [event]));
          }
        });
        setClient(joined);
        setStatus(await joined.request<GuestStatus>("session.status"));
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
      connection?.close();
      setClient(null);
    };
  }, [link, account.state]);
  useEffect(() => {
    if (!client || !status?.admitted) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function list() {
      try {
        const result = await client!.request<{ title?: string; tabs: GuestTab[] }>("session.tabs.list");
        if (cancelled) return;
        setTitle(result.title || "Shared session");
        setTabs(result.tabs);
        setTabId((current) => (result.tabs.some((tab) => tab.id === current) ? current : (result.tabs[0]?.id ?? "")));
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
      if (!cancelled) timer = setTimeout(() => void list(), 2000);
    }
    void list();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, status?.admitted]);
  useEffect(() => {
    setEvents([]);
    if (!client || !tabId || !status?.admitted || tabs.find((tab) => tab.id === tabId)?.kind === "terminal") return;
    let cancelled = false;
    const received: AgentEvent[] = [];
    const subscription = client.subscribe((method, params) => {
      if (method === "session.event") {
        const event = (params as { event: AgentEvent }).event;
        if (event.tabId === tabId) received.push(event);
      }
    });
    async function load() {
      let after = 0;
      for (;;) {
        const result = await client!.request<{ events: AgentEvent[]; hasMore: boolean }>("session.tail", {
          tabId,
          after,
        });
        if (cancelled) return;
        setEvents((current) => mergeEvents(current, [...result.events, ...received]));
        if (!result.hasMore || result.events.length === 0) return;
        after = result.events.at(-1)!.seq;
      }
    }
    void load().catch((e) => {
      if (!cancelled) setError(errorMessage(e));
    });
    return () => {
      cancelled = true;
      subscription();
    };
  }, [client, tabId, status?.admitted]);
  useEffect(() => {
    if (!client || !tabId || !status?.admitted) return;
    const heartbeat = () =>
      void client.request("presence.heartbeat", { tabId, typing: text.length > 0 || note.length > 0 }).catch(() => undefined);
    heartbeat();
    const timer = setInterval(heartbeat, 10_000);
    return () => clearInterval(timer);
  }, [client, tabId, status?.admitted, text.length > 0, note.length > 0]);
  const tab = tabs.find((t) => t.id === tabId);
  const shell = tab?.kind === "terminal";
  const busy = tab?.status === "in_progress" || tab?.status === "waiting";
  const transcript = useMemo(() => buildTranscript(events, busy), [events, busy]);
  const lease = status?.state?.leases.find((l) => l.tabId === tabId);
  const anotherDrives = !!lease && lease.holder.userId !== status?.you?.person.userId;
  const canDrive = status?.you?.role === "driver" && !closed && !anotherDrives && !shell;
  async function run(method: string, params: object = {}) {
    if (!client) return;
    setSending(true);
    setError("");
    try {
      await client.request(method, { tabId, ...params });
      return true;
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  }
  return (
    <section aria-label="Shared session" className="fixed inset-0 z-40 flex flex-col bg-background">
      <header
        className="flex h-14 shrink-0 items-center gap-3 border-b border-hairline px-5 pl-24"
        data-tauri-drag-region="deep"
      >
        <h1 className="min-w-0 flex-1 truncate font-medium">{title}</h1>
        <span className="text-xs text-muted-foreground">
          {status?.you?.role === "viewer" ? "Read only" : status?.you ? "Can drive" : "Joining"}
        </span>
        <Button variant="outline" onClick={leave}>
          Leave session
        </Button>
      </header>
      {error && (
        <p role="alert" className="px-5 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {account.state !== "signed-in" ? (
        <div className="m-auto space-y-4 text-center">
          <p>Sign in to your TerminalX account to join this session.</p>
          <Button onClick={() => void signIn()}>Sign in and join</Button>
        </div>
      ) : !status?.admitted ? (
        <div className="m-auto text-sm text-muted-foreground">
          {closed
            ? "Your access to this session ended."
            : status
              ? "Waiting for the host to admit your verified account…"
              : error
                ? "This session could not be joined."
                : "Connecting to the host…"}
        </div>
      ) : (
        <>
          <nav
            className="flex shrink-0 flex-wrap gap-2 border-b border-hairline px-4 py-2"
            aria-label="Shared session tabs"
          >
            {tabs.map((t) => (
              <Button
                key={t.id}
                size="sm"
                variant={t.id === tabId ? "secondary" : "ghost"}
                onClick={() => setTabId(t.id)}
              >
                {t.title || t.harness}
              </Button>
            ))}
            <Button size="sm" variant="outline" disabled={shell} onClick={() => setTerminal(!terminal)}>
              {terminal ? "Chat" : "Terminal"}
            </Button>
          </nav>
          <div className="flex shrink-0 flex-wrap gap-3 border-b border-hairline px-4 py-2 text-xs">
            {status.state?.people.map((p) => (
              <span key={p.person.userId}>
                {p.person.displayName}
                {p.typing ? " · typing" : " · viewing"}
              </span>
            ))}
            {lease && <strong>{lease.holder.displayName} is driving</strong>}
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {(terminal || shell) && client ? (
                <GuestTerminal client={client} tabId={tabId} error={setError} />
              ) : (
                <Chat
                  sessionId={client?.sessionId ?? ""}
                  transcript={transcript}
                  stream={[]}
                  live={busy}
                  onAnswerPermission={(requestId, optionId) => void run("permission.respond", { requestId, optionId })}
                  onAnswerQuestions={() => setError("Questions are answered by the host.")}
                  answering={sending}
                  answerBlockedReason={status.you?.canApprove ? null : "Permission decisions stay with the host."}
                  askDetail
                  footer={null}
                />
              )}
              <form
                className="shrink-0 space-y-2 border-t border-hairline p-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run("session.send", { text }).then((sent) => {
                    if (sent) setText("");
                  });
                }}
              >
                <textarea
                  aria-label="Prompt to agent"
                  disabled={!canDrive || sending}
                  className="min-h-20 w-full resize-y rounded-lg border border-hairline bg-card p-3 text-sm"
                  placeholder={
                    anotherDrives
                      ? `${lease?.holder.displayName} is driving this tab`
                      : canDrive
                        ? "Send a prompt to the host's agent"
                        : "Read only"
                  }
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
                <div className="flex gap-2">
                  <Button type="submit" disabled={!canDrive || sending || !text.trim()}>
                    {busy ? "Queue follow-up" : "Send"}
                  </Button>
                  {busy && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!canDrive || sending || !text.trim()}
                      onClick={() =>
                        void run("session.steer", { text }).then((sent) => {
                          if (sent) setText("");
                        })
                      }
                    >
                      Steer
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={!canDrive || sending}
                    onClick={() => void run("session.stop")}
                  >
                    Stop
                  </Button>
                  {lease?.holder.userId === status.you?.person.userId && (
                    <Button type="button" variant="ghost" onClick={() => void run("steerLease.release")}>
                      Release control
                    </Button>
                  )}
                </div>
                {status.state?.queue
                  .filter((q) => q.tabId === tabId)
                  .map((q, i) => (
                    <p className="text-xs text-muted-foreground" key={i}>
                      Queued · {q.author.displayName}: {q.text}
                    </p>
                  ))}
              </form>
            </div>
            <aside className="flex w-64 shrink-0 flex-col border-l border-hairline p-3">
              <h2 className="mb-3 text-sm font-medium">Notes to people</h2>
              <div className="min-h-0 flex-1 overflow-y-auto space-y-3">
                {status.state?.notes.map((n) => (
                  <p key={n.id} className="whitespace-pre-wrap text-xs">
                    <strong>{n.author.displayName}</strong>
                    <br />
                    {n.text}
                  </p>
                ))}
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void client
                    ?.request("chat.post", { text: note })
                    .then(() => setNote(""))
                    .catch((e) => setError(errorMessage(e)));
                }}
              >
                <textarea
                  aria-label="Note to people"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  className="w-full rounded-md border border-hairline p-2 text-sm"
                />
                <Button size="sm" disabled={!note.trim()} type="submit">
                  Post note
                </Button>
              </form>
            </aside>
          </div>
        </>
      )}
    </section>
  );
}
function mergeEvents(current: AgentEvent[], next: AgentEvent[]) {
  const events = new Map(current.map((event) => [event.seq, event]));
  for (const event of next) events.set(event.seq, event);
  return [...events.values()].sort((a, b) => a.seq - b.seq);
}
