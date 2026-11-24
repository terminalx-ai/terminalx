// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AccessCodeScreen from "../app/access-code";
import { ACCEPTED_PAUSE_MS, ACCESS_CODE_TEXT, accessCodeRouting, type AccessCodeAnswer } from "./auth/access-code";
import { appearance, stage } from "./ui/testing/kit";
import { themePalette } from "./ui/theme";

// PRO-551: the beta access code after sign-in on the phone (board 25.08), and the two answers
// the server's contract (PRO-550) adds to the board: too many tries, and a sign-in that has ended.

const mocks = vi.hoisted(() => ({
  app: {} as any,
  clipboard: "",
  /** Each code sent, and the answer it is waiting for. */
  sent: [] as { code: string; answer(value: unknown): void }[],
  /** Android's back button: what the page answers when it is pressed (true: handled, the page stays). */
  back: [] as (() => boolean)[],
}));
vi.mock("expo-router", () => ({
  // The page's header as the stack draws it: its title, and what it puts at the start (Cancel).
  Stack: { Screen: ({ options }: { options: { title: string; headerLeft?: () => React.ReactNode } }) => <div data-testid="header"><span data-testid="header-title">{options.title}</span>{options.headerLeft?.()}</div> },
}));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }) }));
vi.mock("@mobile/ui/theme", async (actual) => (await import("@mobile/ui/testing/kit")).boardTheme(await actual()));
vi.mock("lucide-react-native", async () => (await import("@mobile/ui/testing/kit")).namedIcons());
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(), getStringAsync: vi.fn(async () => mocks.clipboard) }));
vi.mock("react-native", async () => {
  const native = await import("@mobile/ui/testing/native");
  return {
    ...native, KeyboardAvoidingView: native.View, Keyboard: { addListener: () => ({ remove: () => undefined }) },
    BackHandler: { addEventListener: (_event: string, listener: () => boolean) => { mocks.back.push(listener); return { remove: () => { mocks.back.splice(mocks.back.indexOf(listener), 1); } }; } },
  };
});

const page = stage();
const text = () => page.container.textContent ?? "";
const field = () => page.container.querySelector<HTMLInputElement>('[data-testid="access-code-field"] input')!;
const button = (label: string) => [...page.container.querySelectorAll<HTMLElement>('[role="button"]')].find((entry) => entry.textContent === label || entry.getAttribute("aria-label") === label) ?? null;
const cont = () => page.byId("access-code-continue");
const off = (element: Element | null) => element?.getAttribute("aria-disabled") === "true";
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

/** The app as the screen sees it while a sign-in is held: the address only, never the ticket. */
function held(fields: Record<string, unknown> = {}) {
  mocks.sent = [];
  mocks.app = {
    online: true,
    signingIn: false,
    accessCode: { id: 1, email: "alex@example.com" },
    redeemAccessCode: vi.fn((code: string) => new Promise<AccessCodeAnswer>((resolve) => mocks.sent.push({ code, answer: resolve as (value: unknown) => void }))),
    cancelAccessCode: vi.fn(),
    finishAccessCode: vi.fn(),
    signIn: vi.fn(async () => undefined),
    ...fields,
  };
}
const show = async () => { await page.show(<AccessCodeScreen />); await settle(); };
const type = async (value: string) => { await page.type(field(), value); await settle(); };
const press = async (element: Element | null) => { await page.press(element); await settle(); };
/** Android's back: true when the page keeps itself. */
const androidBack = () => mocks.back.at(-1)!();
/** Answers the last code sent. */
const answer = async (value: AccessCodeAnswer) => { await act(async () => mocks.sent.at(-1)!.answer(value)); await settle(); };

beforeEach(() => { held(); mocks.clipboard = ""; });
afterEach(() => { vi.useRealTimers(); });

describe.each(["dark", "light"] as const)("the access code screen in %s", (scheme) => {
  beforeEach(() => { appearance.scheme = scheme; });
  const palette = () => themePalette(scheme === "light" ? "Den" : "Ember", scheme);

  it("empty: the console's sentence, the account the code is for, Paste, and Continue off", async () => {
    await show();
    expect(page.byId("header-title")?.textContent).toBe("Access code");
    expect(button("Cancel")).not.toBeNull();
    expect(off(button("Cancel"))).toBe(false);
    expect(text()).toContain("TerminalX is in private beta. Enter your access code to create an account.");
    expect(page.byId("access-code-account")?.textContent).toBe("alex@example.comThe code is used for this account.");
    expect(field().placeholder).toBe("10 letters and digits");
    expect(text()).toContain("Capitals or not, it is the same code.");
    expect(button("Paste Access code")).not.toBeNull();
    // The owner's answer (2026-11-24): without a code there is nothing to do but Cancel, said plainly.
    expect(page.byId("access-code-no-code")?.textContent).toBe(ACCESS_CODE_TEXT.noCode);
    expect(off(cont())).toBe(true);
    expect(cont()?.textContent).toBe("Continue");
    expect(page.byId("access-code-offline")).toBeNull();
    expect(page.styleOf(field().parentElement).borderColor).toBe(palette().border);
  });

  it("typing: capitals on, no autocorrect, monospaced once typed, Continue on; nothing is sent until Continue", async () => {
    await show();
    await type("K7QM2");
    expect(field().value).toBe("K7QM2");
    expect(page.styleOf(field()).fontFamily).toBe("Menlo");
    expect(button("Paste Access code")).toBeNull();
    expect(off(cont())).toBe(false);
    expect(mocks.app.redeemAccessCode).not.toHaveBeenCalled();
  });

  it("entered by Paste: the space around the code is gone", async () => {
    mocks.clipboard = "  K7QM2X9TRB \n";
    await show();
    await press(button("Paste Access code"));
    expect(field().value).toBe("K7QM2X9TRB");
    expect(off(cont())).toBe(false);
  });

  it("checking: the field is locked, Continue shows the wait, and Cancel is off because the code may be spent", async () => {
    await show();
    await type("K7QM2X9TRB");
    await press(cont());
    expect(mocks.app.redeemAccessCode).toHaveBeenCalledWith("K7QM2X9TRB");
    expect(cont()?.textContent).toBe("Checking the code…");
    expect(cont()?.getAttribute("aria-busy")).toBe("true");
    expect(off(cont())).toBe(true);
    expect(field().disabled).toBe(true);
    expect(off(button("Cancel"))).toBe(true);
    await press(button("Cancel"));
    expect(mocks.app.cancelAccessCode).not.toHaveBeenCalled();
    // A second press, or Go on the keyboard, sends nothing more.
    await press(cont());
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(mocks.app.redeemAccessCode).toHaveBeenCalledTimes(1);
  });

  it("Go on the keyboard is Continue", async () => {
    await show();
    await type("K7QM2X9TRB");
    await act(async () => { field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(mocks.app.redeemAccessCode).toHaveBeenCalledWith("K7QM2X9TRB");
  });

  it("accepted: said with the address, without Cancel, then the app is told to close the page", async () => {
    vi.useFakeTimers();
    await show();
    await type("K7QM2X9TRB");
    await press(cont());
    await answer({ status: "accepted" });
    expect(page.byId("access-code-accepted")?.textContent).toContain("Access code accepted");
    expect(text()).toContain("Signed in as alex@example.com.");
    expect(page.icon("CircleCheck")?.getAttribute("data-color")).toBe(palette().success);
    expect(button("Cancel")).toBeNull();
    expect(page.byId("access-code-field")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(ACCEPTED_PAUSE_MS - 1); });
    expect(mocks.app.finishAccessCode).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(mocks.app.finishAccessCode).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["invalid", "That access code is not valid. Check it and try again."],
    ["expired", "That access code has expired. Enter a different one."],
    ["exhausted", "That access code has been fully used. Enter a different one."],
  ] as const)("%s: one sentence under the field, in the danger colour and announced; Continue off until the field changes", async (refusal, sentence) => {
    await show();
    await type("K7QM2X9TR8");
    await press(cont());
    await answer({ status: refusal });
    const line = page.byText(sentence);
    expect(line?.getAttribute("role")).toBe("alert");
    expect(page.styleOf(line).color).toBe(palette().danger);
    expect(text()).not.toContain("Capitals or not, it is the same code.");
    expect(field().value).toBe("K7QM2X9TR8");
    expect(field().disabled).toBe(false);
    expect(document.activeElement).toBe(field());
    expect(off(cont())).toBe(true);
    // No notice: nothing went wrong but the code.
    expect(page.container.querySelector('[data-testid^="access-code-"][role="alert"]')).toBeNull();
    // Fixing it: the first change takes the sentence away and turns Continue back on.
    await type("K7QM2X9TRB");
    expect(text()).not.toContain(sentence);
    expect(text()).toContain("Capitals or not, it is the same code.");
    expect(off(cont())).toBe(false);
  });

  it("offline: a notice with its own mark above the account, Continue off, and Try again sends once there is a network", async () => {
    held({ online: false });
    await show();
    await type("K7QM2X9TRB");
    const notice = page.byId("access-code-offline")!;
    expect(notice.textContent).toContain("Offline. The code was not sent.");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(notice.querySelector('[data-icon="WifiOff"]')?.getAttribute("data-color")).toBe(palette().warning);
    // Above the form: before the account card.
    expect(notice.compareDocumentPosition(page.byId("access-code-account")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(off(cont())).toBe(true);
    await press(cont());
    expect(mocks.app.redeemAccessCode).not.toHaveBeenCalled();
    await press(button("Try again"));
    expect(mocks.app.redeemAccessCode).not.toHaveBeenCalled();
    expect(off(button("Try again"))).toBe(true);
    mocks.app = { ...mocks.app, online: true };
    await show();
    expect(mocks.app.redeemAccessCode).toHaveBeenCalledWith("K7QM2X9TRB");
    expect(page.byId("access-code-offline")).toBeNull();
    expect(cont()?.textContent).toBe("Checking the code…");
  });

  it("offline with nothing entered: Try again is off", async () => {
    held({ online: false });
    await show();
    expect(off(button("Try again"))).toBe(true);
  });

  it("no answer or a server error: a danger notice that says a second try is safe; the code stays, and Try again sends it again", async () => {
    await show();
    await type("K7QM2X9TRB");
    await press(cont());
    await answer({ status: "unanswered", reason: "redeem_failed_500" });
    const notice = page.byId("access-code-unanswered")!;
    expect(notice.textContent).toContain("The code could not be checked. Try again: a code is never used twice for the same account.");
    expect(notice.querySelector('[data-icon="CircleAlert"]')?.getAttribute("data-color")).toBe(palette().danger);
    // Nothing under the field: nothing is wrong with the code.
    expect(text()).toContain("Capitals or not, it is the same code.");
    expect(field().value).toBe("K7QM2X9TRB");
    expect(off(cont())).toBe(false);
    await press(button("Try again"));
    expect(mocks.app.redeemAccessCode).toHaveBeenCalledTimes(2);
    expect(mocks.app.redeemAccessCode).toHaveBeenLastCalledWith("K7QM2X9TRB");
    expect(page.byId("access-code-unanswered")).toBeNull();
  });

  it("an answer lost while the phone went offline is said as offline", async () => {
    await show();
    await type("K7QM2X9TRB");
    await press(cont());
    mocks.app = { ...mocks.app, online: false };
    await answer({ status: "unanswered", reason: "redeem_unreachable" });
    expect(page.byId("access-code-offline")).not.toBeNull();
    expect(page.byId("access-code-unanswered")).toBeNull();
  });

  it("too many tries: Continue and Try again wait out the server's seconds, counted down, then send again", async () => {
    vi.useFakeTimers();
    await show();
    await type("K7QM2X9TRB");
    await press(cont());
    await answer({ status: "rate_limited", retryAfter: 3 });
    await act(async () => { vi.advanceTimersByTime(0); });
    const notice = page.byId("access-code-waiting")!;
    expect(notice.textContent).toContain("Too many tries. Wait a moment, then try again.");
    expect(notice.querySelector('[data-icon="CircleAlert"]')?.getAttribute("data-color")).toBe(palette().warning);
    expect(button("Try again in 0:03")).not.toBeNull();
    expect(off(button("Try again in 0:03"))).toBe(true);
    expect(off(cont())).toBe(true);
    // The code is not what was wrong: nothing under the field, and it can still be changed.
    expect(text()).toContain("Capitals or not, it is the same code.");
    expect(field().disabled).toBe(false);
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(button("Try again in 0:02")).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(off(button("Try again"))).toBe(false);
    expect(off(cont())).toBe(false);
    await press(button("Try again"));
    expect(mocks.app.redeemAccessCode).toHaveBeenCalledTimes(2);
  });

  it("a sign-in that has ended: the field locks, and Sign in again starts sign-in over", async () => {
    await show();
    await type("K7QM2X9TRB");
    await press(cont());
    await answer({ status: "ticket_dead" });
    const notice = page.byId("access-code-ended")!;
    expect(notice.textContent).toContain("This sign-in has ended. Sign in again to enter your code.");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(field().disabled).toBe(true);
    expect(off(cont())).toBe(true);
    expect(off(button("Cancel"))).toBe(false);
    await press(button("Sign in again"));
    expect(mocks.app.signIn).toHaveBeenCalledTimes(1);
  });

  it("a sign-in that has ended, while the new one is under way: Sign in again waits", async () => {
    await show();
    await type("K7QM2X9TRB");
    await press(cont());
    await answer({ status: "ticket_dead" });
    mocks.app = { ...mocks.app, signingIn: true };
    await show();
    expect(off(button("Sign in again"))).toBe(true);
  });

  it("a new sign-in held again starts a fresh form, for the address it is for", async () => {
    await show();
    await type("K7QM2X9TRB");
    await press(cont());
    await answer({ status: "ticket_dead" });
    mocks.app = { ...mocks.app, accessCode: { id: 2, email: "alex@work.example" } };
    await show();
    expect(page.byId("access-code-ended")).toBeNull();
    expect(field().value).toBe("");
    expect(field().disabled).toBe(false);
    expect(page.byId("access-code-account")?.textContent).toContain("alex@work.example");
  });

  it("Cancel drops the held sign-in: the person is signed out", async () => {
    await show();
    await type("K7QM2");
    await press(button("Cancel"));
    expect(mocks.app.cancelAccessCode).toHaveBeenCalledTimes(1);
    expect(mocks.app.redeemAccessCode).not.toHaveBeenCalled();
  });

  it("a long address wraps and is never cut short", async () => {
    held({ accessCode: { id: 1, email: "alexandra.montgomery-fitzwilliam@engineering.northwind-logistics.example" } });
    await show();
    const email = page.byText("alexandra.montgomery-fitzwilliam@engineering.northwind-logistics.example");
    expect(email).not.toBeNull();
    expect(email?.getAttribute("data-lines")).toBeNull();
  });

  it("with no hold, nothing is asked", async () => {
    held({ accessCode: null });
    await show();
    expect(page.byId("access-code-field")).toBeNull();
    expect(button("Cancel")).toBeNull();
  });

  it("offline, a Try again waiting for the network is let go when the field is emptied: nothing is sent", async () => {
    held({ online: false });
    await show();
    await type("K7QM2X9TRB");
    await press(button("Try again"));
    await type("");
    mocks.app = { ...mocks.app, online: true };
    await show();
    expect(mocks.app.redeemAccessCode).not.toHaveBeenCalled();
    expect(cont()?.textContent).toBe("Continue");
  });

  it("Android's back is Cancel: the page goes, and the page going drops the hold", async () => {
    await show();
    expect(androidBack()).toBe(false);
    // The stack takes the page away: that is a Cancel, so the next sign-in opens the page again.
    await page.show(null);
    expect(mocks.app.cancelAccessCode).toHaveBeenCalledTimes(1);
  });

  it("Android's back does nothing while the code is checked, or once it was accepted", async () => {
    await show();
    await type("K7QM2X9TRB");
    await press(cont());
    expect(androidBack()).toBe(true);
    await answer({ status: "accepted" });
    expect(androidBack()).toBe(true);
  });

  it("closed by the app once the hold is over, the page cancels nothing", async () => {
    await show();
    mocks.app = { ...mocks.app, accessCode: null };
    await show();
    await page.show(null);
    expect(mocks.app.cancelAccessCode).not.toHaveBeenCalled();
  });
});

// The root layout's part (_layout.tsx): when the page opens and how it closes.
describe("opening and closing the access code page", () => {
  const at = (fields: Partial<Parameters<typeof accessCodeRouting>[0]>) => accessCodeRouting({ holdId: null, shownFor: null, onPage: false, signedIn: false, canGoBack: true, ...fields });

  it("opens once for each hold", () => {
    expect(at({ holdId: 1 })).toBe("open");
    expect(at({ holdId: 1, shownFor: 1, onPage: true })).toBe("stay");
    // Shown and since taken away (Android's back): the same hold is not forced back on.
    expect(at({ holdId: 1, shownFor: 1 })).toBe("stay");
  });

  it("a new hold opens the page again, even when the last one's page was taken away while it stood", () => {
    expect(at({ holdId: 2, shownFor: 1 })).toBe("open");
    // Already showing: the page starts a fresh form itself.
    expect(at({ holdId: 2, shownFor: 1, onPage: true })).toBe("stay");
  });

  it("closes onto the Cloud tab once signed in, back where it came from otherwise", () => {
    expect(at({ onPage: true, signedIn: true })).toBe("to-cloud");
    expect(at({ onPage: true })).toBe("back");
    expect(at({})).toBe("stay");
  });

  it("reached with no hold and nothing under it (a link, a launch route), it goes to the tabs", () => {
    expect(at({ onPage: true, canGoBack: false })).toBe("to-tabs");
    expect(at({ onPage: true, canGoBack: false, signedIn: true })).toBe("to-cloud");
  });
});
