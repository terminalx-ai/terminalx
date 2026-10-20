import { workStatus, type WorkCloudSession } from "@/lib/api";
import { getCloudCatalog } from "@/lib/cloudCatalog";
import { cloudSessionMark, getCloudDashboard, subscribeCloudDashboard, type CloudDashboardSession } from "@/lib/cloudDashboard";

/**
 * Cloud sessions in work status (#441). A cloud session carries no issue
 * reference, so the window hands the sessions it knows about to the native
 * publisher, which finds the issue a session's branch names in its
 * workspace's repository and publishes it as a cloud claim. Only the
 * reader's own workspaces' sessions are published: whoever created a
 * workspace is who works in it, as far as anyone can tell.
 */

/** How long the hand-over waits for the sessions to settle. */
const SETTLE_MS = 2000;

/** `owner/name` of a GitHub repository written `github.com/owner/name`. */
function githubRepository(repository: string | null): string | null {
  const [host, owner, name, ...rest] = (repository ?? "").split("/");
  return host?.toLowerCase() === "github.com" && owner && name && rest.length === 0 ? `${owner}/${name}` : null;
}

/** What is handed over of each session: nothing of its conversation. Pure. */
export function cloudWorkSessions(sessions: CloudDashboardSession[], createdBy: (orgId: string, workspaceId: string) => string | null): WorkCloudSession[] {
  return sessions
    .filter((session) => session.branch || session.worktreeName)
    .map((session) => ({
      orgId: session.orgId,
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      createdBy: createdBy(session.orgId, session.workspaceId),
      repository: githubRepository(session.repository),
      title: session.title,
      branch: session.branch ?? null,
      worktreeName: session.worktreeName ?? null,
      status: session.stopped ? "idle" : cloudSessionMark(session),
      archived: session.archived,
      modified: session.modified,
    }));
}

function creatorOf(orgId: string, workspaceId: string): string | null {
  return getCloudCatalog().orgs[orgId]?.workspaces.find((item) => item.workspace.id === workspaceId)?.workspace.createdBy ?? null;
}

let started = false;

/** Follow the cloud sessions for as long as the main window is open. */
export function bootCloudWorkClaims() {
  if (started) return;
  started = true;
  let sent = "";
  let timer: number | null = null;
  const send = () => {
    timer = null;
    const sessions = cloudWorkSessions(getCloudDashboard(), creatorOf);
    const key = JSON.stringify(sessions);
    if (key === sent) return;
    sent = key;
    void Promise.resolve()
      .then(() => workStatus.setCloud(sessions))
      .catch(() => {
        sent = "";
      });
  };
  subscribeCloudDashboard(() => {
    if (timer == null) timer = window.setTimeout(send, SETTLE_MS);
  });
  timer = window.setTimeout(send, SETTLE_MS);
}
