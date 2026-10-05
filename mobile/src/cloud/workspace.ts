import { mergeAgentEvents, type AgentEvent } from "@terminalx/portable/events";
import { WorkspaceRpcClient, type AgentTabInfo, type WorkspaceConnectionState, type WorkspaceYou } from "@terminalx/portable/workspace";
import { collabGranted, WorkspaceCollab, type Participant, type TabLease, type WorkspaceNote } from "@terminalx/portable/workspaceCollab";
import { CloudApiError, type CloudApi, type CloudRole, type CloudWorkspace } from "./api";
import type { CommandKind, CommandScope } from "./crypto";
import { WorkspaceKeys, type SecretStorage } from "./keys";
import { CloudWorkspaceLink, type CloudLinkOptions, type CloudLinkProblem } from "./link";
import { CloudOutbox, OutboxError, type OutboxEntry, type OutboxPayload } from "./outbox";
import { CloudTranscripts, type BlobStorage } from "./transcripts";

/**
 * One cloud workspace as the phone shows it: its agent tabs and their
 * transcripts, live while the workspace runs and from the encrypted
 * checkpoints while it does not, and the commands this phone sent.
 *
 * Looking never wakes compute. Opening this, reading tabs and reading
 * transcripts make only read requests, and the connection is attempted only
 * while the list says the workspace is running. A stopped workspace is
 * started by one thing: a command the person chose to send after being told
 * it starts the workspace (`allowWake`). That covers a message written
 * earlier and still on the phone too: it is held, not delivered, until the
 * workspace is seen running or the person agrees to start it. The server
 * resumes a workspace for any command it receives, so "seen running" means
 * connected to it, or listed as running by a list read just now. Whether the
 * person may start it is the server's decision (their role), not this file's.
 */

export interface CloudTab {
  tabId: string;
  sessionId: string | null;
  title: string | null;
  status: string;
  /** Where the tab's state comes from right now. */
  source: "live" | "checkpoint";
  pendingPermissions: unknown[];
  events: AgentEvent[];
  /** The checkpoint holds only the end of a long transcript. */
  truncated: boolean;
  /** A checkpoint exists but this phone holds no key for it. */
  noKey: boolean;
}

/** Who else is here, who drives each tab, and the notes people left (`collab/1`, docs/CLOUD-SHARING.md). */
export interface CloudCollabSnapshot {
  /** False while not connected or on a runtime without `collab/1`: presence, notes and leases stay hidden. */
  available: boolean;
  /** This person's id as the runtime knows it; null until it said. */
  userId: string | null;
  participants: Participant[];
  /** The driver lease of each tab that has one. */
  leases: Record<string, TabLease>;
  /** Notes per tab, oldest first; a tab is absent until its notes were read. */
  notes: Record<string, WorkspaceNote[]>;
}

export interface CloudWorkspaceSnapshot {
  connection: WorkspaceConnectionState;
  collab: CloudCollabSnapshot;
  problem: CloudLinkProblem;
  /** This person's role: the runtime's word while connected, else the list's. */
  role: CloudRole | null;
  canApprove: boolean;
  /** Whether this phone can seal a command and open a transcript. */
  hasKey: boolean;
  tabs: CloudTab[];
  outbox: OutboxEntry[];
  /** The last thing that went wrong while reading, as a code. */
  error: string | null;
}

export class CloudSendError extends Error {
  constructor(readonly code: "read-only" | "would-wake" | "cannot-approve" | "unavailable") {
    super(code);
    this.name = "CloudSendError";
  }
}

/** While typing, presence says so at most this often, and goes back to viewing this long after the last keystroke. */
export const TYPING_REPORT_MS = 10_000;
export const TYPING_IDLE_MS = 4_000;
export const REFUSAL_REFRESH_MS = 30_000;
/** After a return to the foreground, the reconnect is not shown for this long. */
export const RESUME_QUIET_MS = 1_000;
export const OUTBOX_POLL_FIRST_MS = 1_000;
export const OUTBOX_POLL_MAX_MS = 15_000;

export interface CloudWorkspaceSessionOptions {
  scope: CommandScope;
  api: Pick<CloudApi, "open" | "enqueue" | "commandStatuses" | "cancelCommand" | "checkpoint" | "checkpoints"> & Partial<Pick<CloudApi, "doNotWake">>;
  secrets: SecretStorage;
  storage: BlobStorage;
  /** The workspace as the list last had it; null when it is not listed. */
  listed: () => CloudWorkspace | null;
  /**
   * Read the list again now. True when this workspace's organization was
   * read, so `listed()` is current; false when it could not be.
   */
  refreshList?: () => Promise<boolean>;
  clientInstallationId: string;
  appVersion: string;
  /**
   * The API refused an attachment the list said was possible (access taken
   * away, or the workspace stopped meanwhile): the list is out of date.
   * Called at most once in `REFUSAL_REFRESH_MS`.
   */
  onRefused?: () => void;
  link?: Partial<Pick<CloudLinkOptions, "createSocket" | "random" | "now">>;
}

const isEvent = (value: unknown): value is AgentEvent => !!value && typeof value === "object" && typeof (value as AgentEvent).seq === "number" && !!(value as AgentEvent).payload;

export class CloudWorkspaceSession {
  readonly keys: WorkspaceKeys;
  readonly outbox: CloudOutbox;
  readonly transcripts: CloudTranscripts;
  readonly client: WorkspaceRpcClient;
  readonly collab: WorkspaceCollab;
  /** Who this connection is, as the runtime last said (`rpc.hello`, `collab.state`, `collab.you`). */
  private you: WorkspaceYou | null = null;
  private participants: Participant[] = [];
  private readonly leases = new Map<string, TabLease>();
  private readonly notes = new Map<string, WorkspaceNote[]>();
  private refusedAt = -Infinity;
  private typing: { tabId: string; reportedAt: number; idle: ReturnType<typeof setTimeout> | null } | null = null;
  private readonly link: CloudWorkspaceLink;
  private readonly tabs = new Map<string, CloudTab>();
  private readonly listeners = new Set<() => void>();
  private readonly stops: (() => void)[] = [];
  private readonly viewing = new Map<string, { stop: (() => void) | null; count: number }>();
  private snapshot: CloudWorkspaceSnapshot;
  private error: string | null = null;
  private started = false;
  private closed = false;
  private paused = false;
  /** The live connection as it was when the app left the foreground, shown until it is back or a moment has passed. */
  private held: WorkspaceConnectionState | null = null;
  private heldTimer: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setTimeout> | null = null;
  private pollDelay = OUTBOX_POLL_FIRST_MS;

  constructor(private readonly options: CloudWorkspaceSessionOptions) {
    this.keys = new WorkspaceKeys(options.scope, options.secrets);
    this.outbox = new CloudOutbox({ scope: options.scope, api: options.api, keys: this.keys, storage: options.storage, random: options.link?.random, now: options.link?.now });
    this.transcripts = new CloudTranscripts(options.scope, options.api, this.keys, options.storage);
    this.link = new CloudWorkspaceLink({
      api: options.api,
      target: { orgId: options.scope.organizationId, workspaceId: options.scope.workspaceId },
      clientInstallationId: options.clientInstallationId,
      workspaceState: () => options.listed()?.state ?? null,
      appVersion: options.appVersion,
      ...options.link,
    });
    this.client = new WorkspaceRpcClient(this.link);
    this.collab = new WorkspaceCollab(this.client, () => `${(options.link?.now ?? Date.now)().toString(36)}-${Math.random().toString(36).slice(2)}`);
    this.snapshot = this.build();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CloudWorkspaceSnapshot => this.snapshot;

  /** Read what is kept, then what the API has, and connect if the workspace is running. */
  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    this.stops.push(this.outbox.subscribe(() => this.publish()));
    this.stops.push(this.client.onState((state) => void this.connectionChanged(state)));
    this.stops.push(
      this.client.onNotification((notification) => {
        if (notification.event !== "session.tabs") return;
        const tabs = (notification.params as { tabs?: AgentTabInfo[] }).tabs;
        if (Array.isArray(tabs)) this.applyLive(tabs);
      }),
    );
    this.stops.push(
      this.collab.onEvent((event) => {
        if (event.type === "presence") this.participants = event.participants;
        else if (event.type === "lease") this.setLease(event.tabId, event.lease);
        else if (event.type === "note") this.addNotes(event.note.tabId, [event.note]);
        else if (event.type === "you") {
          const before = this.you?.role ?? null;
          this.you = event.you;
          // Access given, changed or taken away while connected: bring everything in line with the new role.
          if (before !== event.you.role) {
            void this.reconcile();
            // Access taken away: the list says so too, and what this phone kept goes with it.
            if (this.unshared()) void this.options.refreshList?.().catch(() => false);
          }
        }
        this.publish();
      }),
    );
    await Promise.all([this.keys.load(), this.outbox.load()]);
    this.publish();
    // The app may have gone to the background while the above was read: then nothing connects until it is back (`resume`).
    if (!this.paused) this.link.start();
    await this.readCheckpoints();
    // Only what the server already has is followed. What never left the phone
    // waits: delivering it could start a workspace that has stopped since.
    if (this.followable()) this.startPolling();
  }

  /** The list was read again (the workspace may have started, stopped, or been taken away). */
  listChanged(): void {
    this.link.listChanged();
    if (this.followable()) this.startPolling();
    this.publish();
  }

  /** Whether the list should be read again soon: the workspace is changing state, or was asked to start. */
  get changing(): boolean {
    const state = this.options.listed()?.state ?? null;
    if (state === "provisioning" || state === "resuming" || state === "suspending") return true;
    // A command the server took for a stopped workspace starts it: the list says when it runs.
    return state === "suspended" && this.outbox.awaiting;
  }

  /** The app left the foreground: let go of the connection. Nothing is forgotten. */
  pause(): void {
    if (this.closed) return;
    // Nothing is polled or posted from the background, also not by a list read that finishes later.
    this.paused = true;
    if (this.poll) clearTimeout(this.poll);
    this.poll = null;
    // What was shown as live stays shown as it was: the phone lets go of the connection (a backgrounded phone
    // holds none and asks nothing), and on return takes it up again before anyone needs to see a difference.
    const before = this.client.connection;
    if (before.state === "connected") this.held = before;
    this.link.close();
  }

  /** Back in the foreground. */
  resume(): void {
    if (this.closed) return;
    this.paused = false;
    // Not started yet: `start` connects by itself when it gets there.
    if (!this.started) return;
    if (this.held) {
      if (this.heldTimer) clearTimeout(this.heldTimer);
      // Longer than this and it is said: "Connecting…", as for any other reconnect.
      this.heldTimer = setTimeout(() => this.dropHeld(), RESUME_QUIET_MS);
    }
    this.link.start();
    if (this.followable()) this.startPolling();
  }

  /** The quiet moment after a return is over (or the connection is back): what is shown is what is. */
  private dropHeld(): void {
    if (this.heldTimer) clearTimeout(this.heldTimer);
    this.heldTimer = null;
    if (!this.held) return;
    this.held = null;
    if (this.client.connection.state !== "connected") void this.connectionChanged(this.client.connection);
    else this.publish();
  }

  /** The person asked to connect again after the link stopped trying. */
  reconnect(): void {
    if (this.closed) return;
    this.link.reconnect();
  }

  /**
   * Deliver what is still on the phone. To a stopped workspace only with
   * `allowWake`: delivering starts it.
   */
  async deliverHeld(options: { allowWake?: boolean } = {}): Promise<void> {
    const verdict = await this.mayPost(!!options.allowWake);
    if (verdict === "would-wake" || verdict === "unavailable") throw new CloudSendError(verdict);
    if (verdict === "post" || verdict === "post-no-wake") await this.outbox.sync({ deliver: true, wake: verdict === "post" });
    if (verdict === "post-no-wake" && this.outbox.stopped) throw this.stoppedMeanwhile();
    if (this.followable()) this.startPolling();
  }

  /**
   * Look at a tab: its checkpoint is brought up to date and, while connected,
   * it streams live. Returns the function that stops looking.
   */
  view(tabId: string): () => void {
    const entry = this.viewing.get(tabId) ?? { stop: null, count: 0 };
    entry.count += 1;
    this.viewing.set(tabId, entry);
    if (entry.count === 1) {
      if (this.client.connection.state === "connected") {
        void this.stream(tabId);
        this.present(tabId, "viewing");
        void this.loadNotes(tabId);
      } else void this.readCheckpoint(tabId);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      entry.count -= 1;
      if (entry.count > 0) return;
      entry.stop?.();
      this.viewing.delete(tabId);
    };
  }

  /** A prompt for the agent. To a stopped workspace only with `allowWake`: it starts the workspace. */
  send(tabId: string, text: string, options: { allowWake?: boolean } = {}): Promise<OutboxEntry> {
    return this.command(tabId, "send", { text }, options);
  }

  steer(tabId: string, text: string): Promise<OutboxEntry> {
    return this.command(tabId, "steer", { text }, {});
  }

  stop(tabId: string): Promise<OutboxEntry> {
    return this.command(tabId, "stop", {}, {});
  }

  /**
   * Answer a permission request. The right to approve is its own right
   * (contract §21.4): a viewer who has it may answer, a driver who lacks it
   * may not. One decision per request.
   */
  decide(tabId: string, decision: { requestId: string; optionId: string }): Promise<OutboxEntry> {
    if (!this.snapshot.canApprove) return Promise.reject(new CloudSendError("cannot-approve"));
    return this.command(tabId, "permission-decision", decision, {});
  }

  /** The person is typing in this tab's composer: others see it, at most every ten seconds. */
  typingIn(tabId: string): void {
    if (!this.collab.available) return;
    const now = Date.now();
    if (this.typing?.idle) clearTimeout(this.typing.idle);
    const reportedAt = this.typing?.tabId === tabId ? this.typing.reportedAt : 0;
    const report = now - reportedAt >= TYPING_REPORT_MS;
    this.typing = {
      tabId,
      reportedAt: report ? now : reportedAt,
      idle: setTimeout(() => {
        this.typing = null;
        this.present(tabId, "viewing");
      }, TYPING_IDLE_MS),
    };
    if (report) this.present(tabId, "typing");
  }

  /** A note for the people here. It is never sent to the agent and is kept only by the runtime. */
  async postNote(tabId: string, text: string): Promise<WorkspaceNote> {
    if (!this.collab.available) throw new CloudSendError("unavailable");
    const note = await this.collab.postNote(tabId, text);
    this.addNotes(tabId, [note]);
    this.publish();
    return note;
  }

  /** Take the tab's input lease ("the wheel"). Refused by the runtime while someone else holds it. */
  async takeWheel(tabId: string): Promise<void> {
    this.setLease(tabId, await this.collab.acquireLease(tabId));
    this.publish();
  }

  async releaseWheel(tabId: string): Promise<void> {
    await this.collab.releaseLease(tabId);
    this.setLease(tabId, null);
    this.publish();
  }

  /** Managers only: take the lease from whoever holds it. */
  async takeOverWheel(tabId: string): Promise<void> {
    this.setLease(tabId, await this.collab.takeOverLease(tabId));
    this.publish();
  }

  async cancel(clientCommandId: string): Promise<void> {
    await this.outbox.cancel(clientCommandId);
  }

  /** Stop and let go of the connection. What is kept on the phone stays. */
  close(): void {
    this.closed = true;
    if (this.heldTimer) clearTimeout(this.heldTimer);
    this.heldTimer = null;
    if (this.poll) clearTimeout(this.poll);
    this.poll = null;
    if (this.typing?.idle) clearTimeout(this.typing.idle);
    this.typing = null;
    for (const entry of this.viewing.values()) entry.stop?.();
    this.viewing.clear();
    for (const stop of this.stops.splice(0)) stop();
    this.transcripts.dispose();
    this.client.close();
  }

  /** Forget everything of this workspace on this phone (deleted, access removed, signed out). */
  async purge(): Promise<void> {
    const tabIds = [...this.tabs.keys()];
    this.close();
    await Promise.all([this.keys.clear(), this.outbox.clear(), ...tabIds.map((tabId) => this.transcripts.forget(tabId))]);
  }

  // ---- internals -----------------------------------------------------------

  private async command(tabId: string, kind: CommandKind, payload: OutboxPayload, options: { allowWake?: boolean }): Promise<OutboxEntry> {
    const { role } = this.snapshot;
    // A viewer reads. The server and the runtime refuse too; this saves the round trip and says why.
    // A decision needs the right to approve (checked by the caller), not a role that may send.
    if (kind !== "permission-decision" && role !== "manager" && role !== "driver") throw new CloudSendError(role === "viewer" ? "read-only" : "unavailable");
    if (role === null || role === "none") throw new CloudSendError("unavailable");
    const verdict = await this.mayPost(!!options.allowWake);
    if (verdict === "would-wake" || verdict === "unavailable") throw new CloudSendError(verdict);
    // "hold": whether the workspace runs is not known just now, so the command is kept and not posted.
    const entry = await this.outbox.enqueue(tabId, kind, payload, { post: verdict !== "hold", wake: verdict !== "post-no-wake" }).catch((error: unknown) => {
      throw error instanceof OutboxError && error.code === "stopped" ? this.stoppedMeanwhile() : error;
    });
    if (this.client.connection.state === "connected") void this.client.nudgeMailbox().catch(() => undefined);
    if (this.followable()) this.startPolling();
    return entry;
  }

  /**
   * Whether a command may be posted now. The server starts a stopped
   * workspace for any command, so without the person's agreement one is
   * posted in a way that cannot start it:
   *
   * - "post-no-wake": with `wake: false`, to a server that knows it. The
   *   server refuses a workspace that is not running and stores nothing, so
   *   one stopped a moment ago is never started by this.
   * - against an older server, only to a workspace seen running: connected
   *   to, or listed as running by a list read for this question (what was
   *   read earlier may be stale: it can have been stopped from elsewhere
   *   since).
   */
  private async mayPost(allowWake: boolean): Promise<"post" | "post-no-wake" | "hold" | "would-wake" | "unavailable"> {
    const stateNow = () => this.options.listed()?.state ?? null;
    if (stateNow() === null || stateNow() === "archived") return "unavailable";
    if (allowWake) return "post";
    if (await this.options.api.doNotWake?.().catch(() => false)) {
      const listed = stateNow();
      if (listed === null || listed === "archived") return "unavailable";
      // Listed as stopped and not connected: ask without a request that would be refused.
      if (this.client.connection.state !== "connected" && (listed === "suspended" || listed === "suspending")) return "would-wake";
      return "post-no-wake";
    }
    if (this.client.connection.state === "connected") return "post";
    const fresh = this.options.refreshList ? await this.options.refreshList().catch(() => false) : true;
    const state = stateNow();
    if (state === null || state === "archived") return "unavailable";
    if (state === "suspended" || state === "suspending") return "would-wake";
    return fresh ? "post" : "hold";
  }

  /** The server refused a `wake: false` command: the workspace stopped since the list was read. */
  private stoppedMeanwhile(): CloudSendError {
    void this.options.refreshList?.().catch(() => false);
    return new CloudSendError("would-wake");
  }

  /** Whether the outbox has anything to follow or deliver without asking the person. */
  private followable(): boolean {
    if (this.closed || this.paused) return false;
    if (this.outbox.awaiting) return true;
    const state = this.options.listed()?.state ?? null;
    return this.outbox.unsent && state !== null && state !== "archived" && state !== "suspended" && state !== "suspending";
  }

  /** Read command states, and deliver what is unsent only when that starts nothing. */
  private async syncOutbox(): Promise<boolean> {
    if (this.paused) return false;
    const verdict = this.outbox.unsent ? await this.mayPost(false) : "hold";
    const deliver = verdict === "post" || verdict === "post-no-wake";
    // Deciding took a request (the list read). If the app went to the background meanwhile, nothing is
    // posted or polled now; and the check is made again before each message, so none leaves after that moment.
    if (this.paused) return false;
    const changed = await this.outbox.sync({ deliver: deliver && (() => !this.paused), wake: verdict !== "post-no-wake" });
    // Refused as stopped: the list is behind. Once it says so, nothing is delivered until the person agrees.
    if (verdict === "post-no-wake" && this.outbox.stopped) void this.options.refreshList?.().catch(() => false);
    return changed;
  }

  private async connectionChanged(state: WorkspaceConnectionState): Promise<void> {
    if (this.closed) return;
    if (state.state === "connected") {
      this.held = null;
      if (this.heldTimer) clearTimeout(this.heldTimer);
      this.heldTimer = null;
    }
    // Away, or just back: what was shown stays as it was until the connection is back or the quiet moment ends.
    if (state.state !== "connected" && this.held) return;
    if (state.state !== "connected") {
      // What the runtime said of each tab is now the last known state, not the live one.
      for (const tab of this.tabs.values()) tab.source = "checkpoint";
      // Who is here and who drives is only known while connected.
      this.you = null;
      this.participants = [];
      this.leases.clear();
      this.publish();
      const problem = this.link.problem;
      if (state.state === "stopped" && problem?.kind === "api" && !problem.unreachable) {
        const now = Date.now();
        if (now - this.refusedAt >= REFUSAL_REFRESH_MS) {
          this.refusedAt = now;
          this.options.onRefused?.();
        }
      }
      return;
    }
    this.you = state.you ?? null;
    this.publish();
    await this.reconcile();
  }

  /** Bring keys, tabs, presence and the outbox in line with the runtime, for the role this person has now. */
  private async reconcile(): Promise<void> {
    if (this.closed || this.client.connection.state !== "connected") return;
    try {
      if (collabGranted(this.client.connection)) {
        try {
          const collab = await this.collab.state();
          this.you = collab.you;
          this.participants = collab.participants;
          this.leases.clear();
          for (const lease of collab.leases) this.setLease(lease.tabId, lease);
        } catch {
          // Refused for someone with no role; `you` from the hello stands.
        }
      }
      // Not shared with this person: the runtime refuses everything, so nothing is asked.
      if (this.unshared()) {
        // And nothing of it is held in memory either: no conversation, no tab titles, no notes, no one's presence.
        for (const entry of this.viewing.values()) {
          entry.stop?.();
          entry.stop = null;
        }
        this.tabs.clear();
        this.notes.clear();
        this.leases.clear();
        this.participants = [];
        this.error = null;
        this.publish();
        return;
      }
      // The key comes first: without it nothing can be sealed or opened.
      await this.keys.refresh(this.client).catch(() => undefined);
      this.applyLive(await this.client.listAgentTabs());
      // A checkpoint this phone could not open before it was handed the key opens now.
      for (const tab of [...this.tabs.values()]) if (tab.noKey) void this.readCheckpoint(tab.tabId);
      for (const [tabId, entry] of this.viewing) {
        if (!entry.stop) void this.stream(tabId);
        this.present(tabId, "viewing");
        void this.loadNotes(tabId);
      }
      if (await this.syncOutbox().catch(() => false)) this.publish();
      if (this.followable()) this.startPolling();
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.publish();
  }

  /**
   * The runtime keeps a member list and this person is not on it. A runtime
   * from before sharing reports role `none` with `listed: false`: that says
   * nothing about access, and everything is asked as before.
   */
  private unshared(): boolean {
    return this.you?.role === "none" && this.you.listed !== false;
  }

  private present(tabId: string, activity: "viewing" | "typing"): void {
    if (!this.collab.available || this.unshared()) return;
    void this.collab.updatePresence({ tabId, activity }).catch(() => undefined);
  }

  private async loadNotes(tabId: string): Promise<void> {
    if (!this.collab.available || this.unshared()) return;
    try {
      const { notes } = await this.collab.listNotes(tabId, { limit: 100 });
      this.addNotes(tabId, notes);
      this.publish();
    } catch {
      // Notes are an extra: the conversation stands without them.
    }
  }

  private addNotes(tabId: string, incoming: WorkspaceNote[]): void {
    const byId = new Map((this.notes.get(tabId) ?? []).map((note) => [note.id, note]));
    for (const note of incoming) if (note.tabId === tabId) byId.set(note.id, note);
    this.notes.set(tabId, [...byId.values()].sort((left, right) => left.createdAt - right.createdAt));
  }

  private setLease(tabId: string, lease: TabLease | null | undefined): void {
    if (lease && typeof lease.holderId === "string") this.leases.set(tabId, lease);
    else this.leases.delete(tabId);
  }

  private applyLive(tabs: AgentTabInfo[]): void {
    const seen = new Set<string>();
    for (const info of tabs) {
      seen.add(info.tabId);
      const tab = this.tab(info.tabId);
      tab.sessionId = info.sessionId || tab.sessionId;
      tab.title = info.title ?? tab.title;
      tab.status = info.status;
      tab.pendingPermissions = info.pendingPermissions ?? [];
      tab.source = "live";
      if (info.lease !== undefined) this.setLease(info.tabId, info.lease);
    }
    // The runtime's list is the tabs there are: one it no longer names was closed.
    for (const tabId of [...this.tabs.keys()]) {
      if (seen.has(tabId)) continue;
      this.tabs.delete(tabId);
      void this.transcripts.forget(tabId);
    }
    this.publish();
  }

  private async stream(tabId: string): Promise<void> {
    const entry = this.viewing.get(tabId);
    const tab = this.tabs.get(tabId);
    if (!entry || entry.stop || !tab?.sessionId) return;
    entry.stop = () => undefined;
    try {
      const stop = await this.client.subscribeSession(
        tab.sessionId,
        tabId,
        (raw) => {
          if (!isEvent(raw)) return;
          const current = this.tabs.get(tabId);
          if (!current) return;
          current.events = mergeAgentEvents(current.events, [raw]);
          this.publish();
        },
        {
          onStatus: (change) => {
            const current = this.tabs.get(tabId);
            if (!current) return;
            current.status = change.status;
            this.publish();
          },
        },
      );
      if (this.viewing.get(tabId) === entry) entry.stop = stop;
      else stop();
    } catch {
      entry.stop = null;
      // Not streaming: the checkpoint is what there is.
      void this.readCheckpoint(tabId);
    }
  }

  /** Every tab the API has a checkpoint for, each opened from what is kept and then from the API. */
  private async readCheckpoints(): Promise<void> {
    let metas;
    try {
      metas = await this.options.api.checkpoints(this.options.scope.organizationId, this.options.scope.workspaceId);
    } catch (error) {
      this.error = error instanceof CloudApiError ? error.code : "cloud_workspace_unavailable";
      this.publish();
      return;
    }
    await Promise.all(metas.map((meta) => this.readCheckpoint(meta.tabId)));
  }

  private async readCheckpoint(tabId: string): Promise<void> {
    let read;
    try {
      read = await this.transcripts.cached(tabId);
      if (read.kind === "transcript") this.applyCheckpoint(tabId, read);
      read = await this.transcripts.refresh(tabId);
    } catch (error) {
      this.error = error instanceof CloudApiError ? error.code : "cloud_workspace_transcript_unreadable";
      this.publish();
      return;
    }
    if (this.closed) return;
    if (read.kind === "none") return;
    this.applyCheckpoint(tabId, read);
  }

  private applyCheckpoint(tabId: string, read: Awaited<ReturnType<CloudTranscripts["refresh"]>>): void {
    const live = this.tabs.get(tabId)?.source === "live";
    const tab = this.tab(tabId);
    if (read.kind === "no-key") {
      tab.noKey = tab.events.length === 0;
      this.publish();
      return;
    }
    if (read.kind !== "transcript") return;
    const { projection } = read;
    tab.noKey = false;
    tab.sessionId = tab.sessionId ?? projection.sessionId;
    tab.events = mergeAgentEvents(tab.events, projection.events.filter(isEvent));
    tab.truncated = projection.truncated;
    // While connected the runtime's own word on status and title stands.
    if (!live) {
      tab.title = projection.title ?? projection.session?.title ?? tab.title;
      tab.status = projection.status;
      tab.pendingPermissions = projection.pendingPermissions;
    }
    this.publish();
  }

  private tab(tabId: string): CloudTab {
    let tab = this.tabs.get(tabId);
    if (!tab) {
      tab = { tabId, sessionId: null, title: null, status: "idle", source: "checkpoint", pendingPermissions: [], events: [], truncated: false, noKey: false };
      this.tabs.set(tabId, tab);
    }
    return tab;
  }

  private startPolling(): void {
    this.pollDelay = OUTBOX_POLL_FIRST_MS;
    if (this.poll || this.closed) return;
    const tick = async () => {
      this.poll = null;
      const changed = await this.syncOutbox().catch(() => false);
      if (this.closed || !this.followable()) return;
      this.pollDelay = changed ? OUTBOX_POLL_FIRST_MS : Math.min(OUTBOX_POLL_MAX_MS, this.pollDelay * 2);
      this.poll = setTimeout(() => void tick(), this.pollDelay);
    };
    this.poll = setTimeout(() => void tick(), this.pollDelay);
  }

  private build(): CloudWorkspaceSnapshot {
    const actual = this.client?.connection ?? { state: "idle" as const };
    const connection = this.held && actual.state !== "connected" ? this.held : actual;
    const listed = this.options.listed();
    const said = connection.state === "connected" ? (this.you ?? connection.you ?? null) : null;
    const you = said && said.listed !== false ? said : (listed?.you ?? null);
    const available = collabGranted(connection);
    return {
      connection,
      collab: {
        available,
        userId: said?.userId ?? null,
        participants: available ? (this.participants ?? []) : [],
        leases: available ? Object.fromEntries(this.leases ?? []) : {},
        notes: Object.fromEntries(this.notes ?? []),
      },
      problem: this.link?.problem ?? null,
      role: (you?.role as CloudRole | undefined) ?? null,
      canApprove: you?.canApprove === true,
      hasKey: !!this.keys?.current(),
      tabs: [...(this.tabs?.values() ?? [])].map((tab) => ({ ...tab })),
      outbox: this.outbox?.entries() ?? [],
      error: this.error,
    };
  }

  private publish(): void {
    if (this.closed) return;
    this.snapshot = this.build();
    for (const listener of [...this.listeners]) listener();
  }
}
