// An organization's cloud computer name and colour (PRO-370), kept on the
// server for every member. Unset, the name is derived from the organization
// and the colour is the accent.

import { invoke } from "@tauri-apps/api/core";
import type { AccountStatus, OrganizationSummary } from "@/lib/api";

export const COMPUTER_COLORS = [
  { id: "orange", label: "Orange", css: "var(--accent)" },
  { id: "blue", label: "Blue", css: "#5ab0e8" },
  { id: "green", label: "Green", css: "#4fc26b" },
  { id: "violet", label: "Violet", css: "#a78bfa" },
  { id: "red", label: "Red", css: "#f06a6a" },
  { id: "gray", label: "Gray", css: "#8b8d93" },
] as const;
export type ComputerColor = (typeof COMPUTER_COLORS)[number]["id"];

export const COMPUTER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** A server value is never used as CSS: only a known colour's own value. */
export function computerColorCss(color: string | null | undefined): string {
  return (COMPUTER_COLORS.find((item) => item.id === color) ?? COMPUTER_COLORS[0]).css;
}

/** "Procyon Labs" → "procyon-labs-cloud"; at most 40 characters. */
export function suggestedComputerName(organizationName: string): string {
  const base = organizationName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 33)
    .replace(/-+$/g, "");
  return base ? `${base}-cloud` : "cloud";
}

export function computerNameOf(organization: Pick<OrganizationSummary, "name" | "computerName">): string {
  return organization.computerName || suggestedComputerName(organization.name);
}

/** Save the name and colour (owners and admins). Returns the account with them applied. */
export function saveComputerIdentity(organizationId: string, contextRevision: string, computerName: string | null, computerColor: ComputerColor | null): Promise<AccountStatus> {
  return invoke<AccountStatus>("organization_computer_save", { organizationId, contextRevision, computerName, computerColor });
}
