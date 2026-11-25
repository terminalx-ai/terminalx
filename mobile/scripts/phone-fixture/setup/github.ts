import { githubService, northwind, northwindGrants } from "../../../src/cloud/testing/github";
import type { SetupHandler } from "./types";

/**
 * Connect GitHub and choose repositories (25.11), answered in memory by the
 * same account service the screen tests use, which follows the server's
 * contract (terminalx-saas `docs/mobile-github-app.md`). Used with
 * `fixtureLaunch`, which gives Northwind its compute and agent logins.
 *
 * | `fixtureGithub` | Northwind's GitHub App |
 * | --- | --- |
 * | `none` | nothing connected: an owner sees Connect GitHub |
 * | `member` | nothing connected, read by a member |
 * | `connected` | northwind-labs connected, no repositories chosen yet |
 * | `chosen` | northwind-labs connected, six repositories chosen |
 * | `slow` | `chosen`, and the status takes 6 s to answer |
 * | `unread` | the status cannot be read |
 *
 * The sign-in sheet opens the real github.com, where nobody is signed in, so
 * no attempt finishes by itself. `fixtureGithubEnds: <how>` ends a started
 * attempt 6 s later the way the browser's pages would: `connected`,
 * `canceled` (Cancel on the confirmation page) or an error code of the
 * contract (`github_installation_pending_approval`, …).
 */
const ORG = "org-northwind";
const ENDS_AFTER_MS = 6_000;
const service = githubService();
let state: string | undefined;
const started = new Map<string, number>();

export const handle: SetupHandler = async ({ method, path, query, body, argument, json }) => {
  const github = argument("fixtureGithub");
  if (!github) return undefined;
  const scoped = new RegExp(`^/v1/mobile/orgs/${ORG}(/github-app(?:/.*)?)$`).exec(path);
  if (!scoped) return undefined;
  if (state !== github) {
    state = github;
    if (github === "connected" || github === "chosen" || github === "slow") service.connectInstallation(northwind, northwindGrants);
    if (github === "chosen" || github === "slow") service.choose(["checkout", "api", "web", "infra", "mobile", "docs"]);
  }
  const route = scoped[1]!;
  if (route === "/github-app") {
    if (github === "unread") return json(503, { error: "cloud_workspace_unavailable" });
    if (github === "slow") await new Promise((resolve) => setTimeout(resolve, 6_000));
  }
  // What the browser's pages would have done by now.
  const ends = argument("fixtureGithubEnds");
  for (const [attemptId, at] of started) {
    if (!ends || Date.now() - at < ENDS_AFTER_MS || service.state.attempts.get(attemptId)?.state !== "waiting") continue;
    service.finish(attemptId, ends === "connected" ? { connected: northwind } : ends === "canceled" ? { canceled: "confirmation_page" } : { failed: ends });
  }
  const asked = query.toString();
  const answer = service.handle({ method, path: asked ? `${route}?${asked}` : route, headers: {}, body: body ?? undefined }, github === "member" ? "member" : "owner");
  if (!answer || typeof answer === "string") return undefined;
  const made = (answer.body as { attemptId?: string } | undefined)?.attemptId;
  if (made && route === "/github-app/connect-attempts") started.set(made, Date.now());
  return json(answer.status ?? 200, answer.body);
};
