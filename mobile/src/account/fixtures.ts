import { accountDeletionReadSchema, type AccountDeletionRead } from "./deletion";

// The read route's answer as terminalx-saas docs/account-deletion.md gives it.
export const plainRead = (): AccountDeletionRead => accountDeletionReadSchema.parse({
  graceDays: 14,
  retentionDays: 90,
  recentSignIn: true,
  blockers: [],
  deleted: {
    authMethods: ["google", "email"],
    runningWorkspaces: [],
    organizations: [{ id: "org_p", name: "Alex Rivera", isPersonal: true, workspaces: 2 }],
    leftOrganizations: [{ id: "org_2", name: "Contoso Labs" }],
    computeKeys: 1,
    agentLogins: 2,
    githubConnections: 1,
    pairedDevices: 3,
    sessions: 2,
  },
  deletion: null,
  notice: null,
});
