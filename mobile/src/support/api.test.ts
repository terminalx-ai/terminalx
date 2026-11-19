import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { supportApi } from "./api";

const { readSession, refreshStoredSession } = vi.hoisted(() => ({ readSession: vi.fn(), refreshStoredSession: vi.fn() }));
vi.mock("../auth/native", () => ({ readSession, refreshStoredSession }));

const session = { user: { userId: "one" }, accessToken: "test-access-token", expiresAt: Date.now() + 60_000 };
const fetchMock = vi.fn();
const input = { to: Date.now(), hours: 24, server: true } as const;

beforeEach(() => {
  vi.clearAllMocks();
  readSession.mockResolvedValue(session);
  refreshStoredSession.mockResolvedValue({ status: "fresh", session });
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ key: "source-preview" })));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

it("uses the signed-in owner's bearer on the authenticated HTTPS preview route", async () => {
  await expect(supportApi.preview("one", input)).resolves.toEqual({ key: "source-preview" });
  const [url, request] = fetchMock.mock.calls[0]!;
  expect(String(url)).toBe("https://login.terminalx.ai/v1/support/preview");
  expect(request.headers.Authorization).toBe("Bearer " + session.accessToken);
  expect(JSON.parse(request.body)).toEqual(input);
});

it("refuses to send after the account changes during credential refresh", async () => {
  readSession.mockResolvedValueOnce(session).mockResolvedValueOnce({ ...session, user: { userId: "two" } });
  await expect(supportApi.preview("one", input)).rejects.toThrow("unauthorized");
  expect(fetchMock).not.toHaveBeenCalled();
});
