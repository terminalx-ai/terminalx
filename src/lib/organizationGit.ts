import { invoke } from "@tauri-apps/api/core";

export interface GitIdentity { name: string; email: string }
export interface OrganizationGitSettings {
  identity: GitIdentity | null;
  tokenConfigured: boolean;
  tokenSharedUse: "managers" | "organization" | null;
  canManage: boolean;
  contextRevision: string;
}
export const organizationGit = {
  get: () => invoke<OrganizationGitSettings>("organization_git_settings"),
  saveIdentity: (identity: GitIdentity | null, contextRevision: string) => invoke<void>("organization_git_identity_save", { identity, contextRevision }),
  saveToken: (token: string, sharedUse: "managers" | "organization", contextRevision: string) => invoke<void>("organization_github_token_save", { token, sharedUse, confirmOrganizationSharing: true, confirmMachineInstallation: true, contextRevision }),
  removeToken: (contextRevision: string) => invoke<void>("organization_github_token_remove", { contextRevision }),
};

export function validGitIdentity(name: string, email: string): boolean {
  return !!name.trim() && new TextEncoder().encode(name.trim()).length <= 200 && !/[<>\x00-\x1f\x7f]/.test(name) && new TextEncoder().encode(email.trim()).length <= 254 && /^[^\s<>@\x00-\x1f\x7f]+@[^\s<>@\x00-\x1f\x7f]+$/.test(email.trim());
}
