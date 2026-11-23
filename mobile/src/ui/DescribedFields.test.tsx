// @vitest-environment jsdom
import { act, createRef } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { CloudProviderCredentialField } from "@mobile/cloud/api";
import { DescribedFields, type DescribedFieldsHandle } from "./DescribedFields";
import { stage } from "./testing/kit";

// PRO-542: a provider's credential form, drawn from its descriptor (25.03).
const mocks = vi.hoisted(() => ({ paste: vi.fn(async () => "") }));
vi.mock("expo-clipboard", () => ({ getStringAsync: mocks.paste }));
vi.mock("react-native", () => import("@mobile/ui/testing/native"));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());

const page = stage();
const KEY = "a37_live_4f1d0c2b9e";
const HELPER = "Sent once, encrypted at rest, and never shown again, here or anywhere.";
const agent37: CloudProviderCredentialField[] = [{ name: "apiKey", kind: "secret", label: "Agent37 API key", helpUrl: "https://agent37.com/dashboard/cloud/api-keys" }];
const described: CloudProviderCredentialField[] = [{ name: "accountId", kind: "text", label: "Account ID" }, { name: "token", kind: "secret", label: "API token", helpUrl: "https://provider.example/keys" }];
const inputOf = (name: string) => page.byId(`described-field-${name}`)!.querySelector("input") as HTMLInputElement | null;

beforeEach(() => { mocks.paste.mockReset().mockResolvedValue(""); });

it("draws one field per credential field, in the server's order and under its labels", async () => {
  await page.show(<DescribedFields testID="fields" fields={described} helper={HELPER} onOpenHelp={() => undefined} />);
  const fields = [...page.byId("fields")!.children] as HTMLElement[];
  expect(fields.map((field) => field.dataset.testid)).toEqual(["described-field-accountId", "described-field-token"]);
  expect(inputOf("accountId")!.getAttribute("aria-label")).toBe("Account ID");
  expect(inputOf("accountId")!.placeholder).toBe("Account ID");
  expect(inputOf("accountId")!.type).toBe("text");
  expect(inputOf("token")!.type).toBe("password");
  expect(inputOf("token")!.getAttribute("data-controlled")).toBeNull();
  // The line on what happens to the secret sits under the last field only.
  expect(fields[0].textContent).not.toContain(HELPER);
  expect(fields[1].textContent).toContain(HELPER);
});

it("offers Paste on a secret field only, and the help link only where the field has an address", async () => {
  const open = vi.fn();
  await page.show(<DescribedFields fields={described} onOpenHelp={open} />);
  expect(page.byLabel("Paste Account ID")).toBeNull();
  expect(page.byLabel("Paste API token")).not.toBeNull();
  const links = page.container.querySelectorAll("[role='link']");
  expect(links).toHaveLength(1);
  expect(links[0].textContent).toBe("Get a key");
  await page.press(links[0]);
  expect(open).toHaveBeenCalledExactlyOnceWith("https://provider.example/keys");
});

it("draws no link when there is nothing to open it with", async () => {
  await page.show(<DescribedFields fields={agent37} />);
  expect(page.container.querySelector("[role='link']")).toBeNull();
});

it("says the form is ready only once every field has something in it, and not again until that changes", async () => {
  const ready = vi.fn();
  mocks.paste.mockResolvedValue(KEY);
  await page.show(<DescribedFields fields={described} onReadyChange={ready} />);
  await page.type(inputOf("accountId"), "acct_81");
  expect(ready).not.toHaveBeenCalled();
  await page.press(page.byLabel("Paste API token"));
  expect(ready).toHaveBeenCalledExactlyOnceWith(true);
  await page.type(inputOf("accountId"), "acct_812");
  expect(ready).toHaveBeenCalledTimes(1);
  await page.type(inputOf("accountId"), "   ");
  expect(ready).toHaveBeenLastCalledWith(false);
  expect(ready).toHaveBeenCalledTimes(2);
});

it("hands the form every value by name for the request, and never draws the secret", async () => {
  const handle = createRef<DescribedFieldsHandle>();
  mocks.paste.mockResolvedValue(KEY);
  await page.show(<DescribedFields ref={handle} fields={described} />);
  await page.type(inputOf("accountId"), " acct_81 ");
  await page.press(page.byLabel("Paste API token"));
  expect(handle.current!.read()).toEqual({ accountId: "acct_81", token: KEY });
  expect(page.container.innerHTML).not.toContain(KEY);
  expect(page.byLabel("API token")!.textContent).toBe("•".repeat(24));
  // What is typed in a text field stays visible, as the descriptor asks.
  expect(inputOf("accountId")!.value).toBe(" acct_81 ");
});

it("empties a rejected key and focuses its field, keeping the others, and shows the refusal under it", async () => {
  const handle = createRef<DescribedFieldsHandle>();
  const ready = vi.fn();
  mocks.paste.mockResolvedValue(KEY);
  await page.show(<DescribedFields ref={handle} fields={described} helper={HELPER} onReadyChange={ready} />);
  await page.type(inputOf("accountId"), "acct_81");
  await page.press(page.byLabel("Paste API token"));
  await act(async () => { handle.current!.clear("token"); handle.current!.focus("token"); });
  await page.show(<DescribedFields ref={handle} fields={described} helper={HELPER} onReadyChange={ready} errors={{ token: "Agent37 rejected that key. Paste it again, or make a new one." }} />);
  expect(handle.current!.read()).toEqual({ accountId: "acct_81", token: "" });
  expect(ready).toHaveBeenLastCalledWith(false);
  expect(document.activeElement).toBe(inputOf("token"));
  const alert = page.container.querySelector("[role='alert']")!;
  expect(alert.textContent).toBe("Agent37 rejected that key. Paste it again, or make a new one.");
  expect(page.byId("described-field-token")!.contains(alert)).toBe(true);
  expect(page.container.textContent).not.toContain(HELPER);
  await act(async () => handle.current!.clear());
  expect(handle.current!.read()).toEqual({ accountId: "", token: "" });
});

it("locks every field while the key is being checked", async () => {
  await page.show(<DescribedFields fields={described} disabled />);
  expect(inputOf("accountId")!.disabled).toBe(true);
  expect(inputOf("token")!.disabled).toBe(true);
  expect(page.byLabel("Paste API token")).toBeNull();
});

it("draws nothing for a provider with nothing to connect", async () => {
  await page.show(<DescribedFields testID="fields" fields={[]} />);
  expect(page.container.innerHTML).toBe("");
});
