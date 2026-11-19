import { reportPath, type PreviewRequest, type ServerPreview, type Submission } from "@terminalx/portable/supportReports";
import { readSession, refreshStoredSession } from "../auth/native";
import { AUTH_CONFIG } from "../auth/protocol";

async function send<T>(owner: string | undefined, action: "preview" | "submit", data: PreviewRequest | Submission, authorize?: () => Promise<void>): Promise<T> {
  const held = await readSession();
  if (!held || held.user.userId !== owner) throw new Error("unauthorized");
  const refreshed = await refreshStoredSession(held);
  const current = await readSession();
  if (!current || refreshed.status === "rejected" || current.user.userId !== owner || current.accessToken !== refreshed.session.accessToken) {
    throw new Error("unauthorized");
  }
  if (authorize) await authorize();
  const endpoint = new URL(reportPath + "/" + action, AUTH_CONFIG.sessionEndpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { Authorization: "Bearer " + current.accessToken, "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "unavailable");
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export const supportApi = {
  preview: (owner: string | undefined, request: PreviewRequest) => send<ServerPreview>(owner, "preview", request),
  submit: (owner: string | undefined, request: Submission, authorize: () => Promise<void>) => send<{ reference: string }>(owner, "submit", request, authorize),
};
