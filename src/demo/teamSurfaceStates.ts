import type { SurfaceMessage, SurfaceStatus } from "@/components/ui/SurfaceState";

export const surfaceIds = ["presence", "profile", "mention", "following", "share", "onboarding", "billing", "automations", "ports", "desktop"] as const;
export type TeamSurfaceId = (typeof surfaceIds)[number];
export const surfaceStatuses: readonly SurfaceStatus[] = ["empty", "loading", "error", "no-access", "offline"];

type StateCopy = readonly [title: string, description: string];
interface SurfaceDesign {
  title: string;
  contract: string;
  states: Record<SurfaceStatus, StateCopy>;
}

/** Review copy, not a backend state machine. Feature owners map their authoritative responses. */
export const teamSurfaceDesigns: Record<TeamSurfaceId, SurfaceDesign> = {
  presence: {
    title: "Avatar stack and presence", contract: "PRO-133 · current workspace presence is collab/1 only",
    states: {
      empty: ["No one else is here", "Other participants appear when they open this workspace."],
      loading: ["Loading participants…", "Checking who is in this workspace."],
      error: ["Could not load participants", "Try again to refresh presence. Workspace content is unchanged."],
      "no-access": ["Participants are unavailable", "You no longer have access to this workspace."],
      offline: ["Presence is unavailable offline", "Reconnect to see who is here. A previous connection does not mean someone is online."],
    },
  },
  profile: {
    title: "Profile popover", contract: "PRO-128 · scoped roster/profile owner",
    states: {
      empty: ["Profile unavailable", "This person may have left the organization. Their messages stay in the conversation."],
      loading: ["Loading profile…", "Checking this person's details."],
      error: ["Could not load this profile", "Try again. The conversation is still available."],
      "no-access": ["You cannot view this profile", "Only details shared with your current organization are available."],
      offline: ["Profile is unavailable offline", "Reconnect to load current details. Previously loaded private details are not shown here."],
    },
  },
  mention: {
    title: "Mention chip", contract: "PRO-141 · depends on PRO-125, PRO-128 and PRO-137",
    states: {
      empty: ["No people match", "Try another name, or continue writing your message."],
      loading: ["Loading people…", "Your message stays in the composer while people load."],
      error: ["Could not check this mention", "Your draft is saved here. Try again before sending a mention notification."],
      "no-access": ["This person cannot watch this workspace", "Share it with them first. No mention notification has been sent."],
      offline: ["Mention not sent", "Your draft stays here. Reconnect to check access and send it."],
    },
  },
  following: {
    title: "Following", contract: "PRO-137 · authoritative following list; not inferred from visits",
    states: {
      empty: ["You are not following any workspaces", "Follow a workspace to keep it in this section. Following does not change access."],
      loading: ["Loading followed workspaces…", "Checking your following list."],
      error: ["Could not load Following", "Try again. Your saved following list has not been changed."],
      "no-access": ["Workspace access ended", "It is no longer available here. Ask its creator or an organization admin for access."],
      offline: ["Following is unavailable offline", "Reconnect to refresh the list. Follow and unfollow changes wait for a confirmed connection."],
    },
  },
  share: {
    title: "Share dialog", contract: "CloudShareDialog · PRO-167 levels/general access · PRO-171 group/batch save",
    states: {
      empty: ["Only people with existing access", "No additional people are invited. The creator and organization managers retain their existing rights."],
      loading: ["Loading access…", "Checking who can see and change this workspace. Changes are unavailable until this completes."],
      error: ["Could not confirm access changes", "Check the current access list before trying again. An unanswered request may already have changed access."],
      "no-access": ["You cannot change access", "Ask the workspace's creator or an organization admin. Existing access is shown only when the server allows it."],
      offline: ["Access cannot be changed offline", "Your unsaved choices stay in this dialog. Reconnect, refresh access, then review them before saving."],
    },
  },
  onboarding: {
    title: "Onboarding shell", contract: "PRO-191 · setup owner; PRO-200 owns agent login details",
    states: {
      empty: ["Set up your organization", "Connect the services you want to use. Starting a workspace is a separate step."],
      loading: ["Checking setup…", "Reading the current setup. This does not start a workspace."],
      error: ["Setup could not be checked", "Your completed steps are kept. Try this step again."],
      "no-access": ["An organization admin needs to finish setup", "You can return to your work while an admin connects the required services."],
      offline: ["Setup is unavailable offline", "Keep this window open or return later. Completed steps are kept."],
    },
  },
  billing: {
    title: "Plan badge and billing", contract: "PRO-178 payer/seat model · PRO-182 migration and capability labels",
    states: {
      empty: ["Plan details are unavailable", "No plan has been returned for this organization. This does not mean it is on a free plan."],
      loading: ["Loading plan…", "Checking the current plan and billing details."],
      error: ["Could not load billing details", "Try again. This does not confirm a change to your plan or payment."],
      "no-access": ["Billing details are restricted", "Ask an organization admin for help with billing. A plan badge does not grant billing access."],
      offline: ["Billing is unavailable offline", "Reconnect to check the current plan before making a billing change."],
    },
  },
  automations: {
    title: "Organization automations", contract: "PRO-225 page · PRO-228 fresh workspace · PRO-231 GitHub · PRO-233 webhook/API",
    states: {
      empty: ["No automations to show", "Automations you can access appear here. Clear a filter if you expected to see one."],
      loading: ["Loading automations…", "Checking runs and schedules. This does not start a run."],
      error: ["Could not load automations", "Try again. Do not repeat Run now until the outcome of the previous request is known."],
      "no-access": ["Automations are unavailable", "Ask an organization admin for access. Private automation details are not shown."],
      offline: ["Automations are unavailable offline", "Reconnect to check runs. Run, edit, pause and resume are unavailable until access is confirmed."],
    },
  },
  ports: {
    title: "Ports popover", contract: "CloudPorts · PRO-223 automatic forwarding; local loopback only",
    states: {
      empty: ["No ports are forwarded", "Start an app in this workspace, then choose a listening port to forward."],
      loading: ["Loading ports…", "Checking listening ports without starting the workspace."],
      error: ["Could not forward this port", "Check the connection and local port availability, then try again."],
      "no-access": ["You cannot forward ports", "Forwarding needs permission to use a terminal: a manager, or a driver who can approve permissions."],
      offline: ["Port forwards have ended", "They closed with the connection. Reconnect to the workspace before opening them again."],
    },
  },
  desktop: {
    title: "Cloud desktop tab", contract: "PRO-206 · VncView reuse; viewer transport/authority is not yet landed",
    states: {
      empty: ["Desktop is not running", "Open the desktop when you need it. The owning feature must explain any workspace start and cost before starting it."],
      loading: ["Connecting to the desktop…", "Waiting for the workspace. You can leave this tab while it connects."],
      error: ["Could not connect to the desktop", "Try reconnecting. The workspace's other tabs are still available."],
      "no-access": ["Desktop access is unavailable", "You need access to view this workspace. Input requires the desktop's separate edit authority."],
      offline: ["Desktop disconnected", "Reconnect to continue. Keyboard and pointer input are stopped while disconnected."],
    },
  },
};

export function surfaceMessage(surface: TeamSurfaceId, status: SurfaceStatus): SurfaceMessage {
  const [title, description] = teamSurfaceDesigns[surface].states[status];
  return { status, title, description };
}
