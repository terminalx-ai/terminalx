/**
 * The words of boards 25.01 (first run on the Cloud tab) and 25.02 (the
 * organization), word for word. The server answers the phone with a code and
 * no sentence, so every sentence here is the phone's; names (an organization,
 * a provider, an agent) are the server's. A refusal the boards have no
 * sentence for is said by `refusalText`, never by its code.
 */

// ── 25.01, the Cloud tab ──

export const INTRO = "A cloud workspace is a machine where your agents keep working while your phone is in your pocket. Four steps set one up.";

export const STEP_TITLES = { organization: "Organization", compute: "Connect compute", agents: "Sign your agents in", launch: "Launch a workspace" } as const;

export const ORGANIZATION_DETAIL = "Workspaces belong to an organization.";
export const organizationDetail = (name: string) => `${ORGANIZATION_DETAIL} Yours is ${name}.`;
export const COMPUTE_DETAIL = "The provider account your workspaces run on.";
export const AGENTS_DETAIL = "What Codex, Claude Code and Cursor sign in with there.";
export const LAUNCH_DETAIL = "Pick a size, see the price, start working.";
export const LAUNCH_WAITS = "Waits for compute.";

/** A finished step says what it holds: "Boat · connected", "Codex, Claude Code · connected". */
export const connected = (names: readonly string[]) => `${names.join(", ")} · connected`;
/** A provider with nothing to connect that the server offers as it is (TerminalX Cloud). */
export const readyToUse = (names: readonly string[]) => `${names.join(", ")} · ready to use`;
/** The provider list reports attention-required: the stored key failed its last check. */
export const keyRejected = (provider: string) => `${provider} rejected the stored key on its last check.`;

export const COULD_NOT_BE_READ = "Could not be read. Pull down to try again.";
export const PULL_TO_READ = "Pull down to read it again.";
export const OFFLINE_NOTE = "Setup carries on when the phone is back online. Nothing you finished is lost.";

export const BUTTONS = {
  start: "Start setup",
  compute: "Continue: connect compute",
  agents: "Continue: sign your agents in",
  launch: "Launch a workspace",
  fixKey: "Fix the provider key",
} as const;

/** The + in the title. */
export const LAUNCH_ANOTHER = "Launch a workspace";

/** 25.01, a member of an organization that has no compute: the console's sentence. */
export const noComputeTitle = (organization: string) => `${organization} has no compute yet`;
export const NO_COMPUTE_DETAIL = "An organization owner or admin must connect compute. You can launch a workspace once they have.";

/** 25.01, an organization still being set up, folded under the ones with workspaces. */
export const FOLD_TITLE = "Set up cloud workspaces";
export const stepsDone = (done: number, of: number) => `${done} of ${of} steps done`;

// ── 25.02, the organization ──

export const ORGANIZATION_TITLE = "Organization";
export const CHOOSE_INTRO = "Cloud workspaces, the compute they run on and the agent logins they use belong to an organization.";
export const CHOOSE_SEVERAL = "Choose the organization to set up.";
export const PERSONAL_ALONE = "Just you. A personal organization cannot have members.";
export const CREATE_ROW = "Create an organization";
export const CREATE_ROW_DETAIL = "For a team: invite people later and share workspaces with them.";
/** Against a server without the phone's create route (no `organizations.create.mobile.v1`). */
export const CREATE_ELSEWHERE = "To create an organization for a team, use the TerminalX desktop app or the web console. Your account service does not take it from the phone yet.";
/**
 * The same, for an account with no organization at all (PRO-524: one made on
 * the phone has none until the desktop app or the web console makes it).
 */
export const CREATE_ELSEWHERE_FIRST = "To create an organization, use the TerminalX desktop app or the web console. Your account service does not take it from the phone yet.";
export const CONTINUE_PERSONAL = "Continue with the personal one";
export const continueWith = (organization: string) => `Continue with ${organization}`;
export const COMPUTE_CONNECTED = "compute connected";
export const ADMIN_SETS_UP = "an owner or admin sets it up";
export const PERSONAL = "Personal";

export const NEW_ORGANIZATION_TITLE = "New organization";
export const NAME_LABEL = "Organization name";
export const NAME_HELPER = "2 to 60 characters. You can invite people after it is set up.";
export const NAME_ERROR = "Use 2 to 60 characters.";
export const CREATE = "Create organization";
export const CREATING = "Creating…";
export const NOT_CREATED = "The organization was not created. Check your connection and try again.";

// ── 25.02, the organization's page ──

export const CLOUD_WORKSPACES = "Cloud workspaces";
export const COMPUTE_ROW = "Compute";
export const LOGINS_ROW = "Agent logins";
export const NOT_CONNECTED = "Not connected";
export const MANAGED_BY = "Owners and admins manage these. Members use them when they launch a workspace.";
