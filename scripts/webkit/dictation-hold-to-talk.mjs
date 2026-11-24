#!/usr/bin/env node
// WebKit check for #428, in the built app (`pnpm build`) with real key events,
// split from dictation-edits.mjs: a key pressed while holding Right Option to
// talk edits the draft, and the result that settles afterwards does not undo the
// edit.
//
// On a Mac only (run-all.mjs `macOnly`). Holding Right Option to talk is the
// Mac's key (`hold:AltRight`, src/lib/shortcuts.ts), and the edit the check
// makes is Option+Backspace, deleting the word before the caret. WebKit on Linux
// has no editing key while Alt is held: Alt+Backspace there deletes nothing, so
// the edit this checks is never made.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/dictation-hold-to-talk.mjs
import { launch, open, openConversation, report, serve, tab } from "./harness.mjs";

const server = await serve();
const browser = await launch();
let failed = 0;

/** Long enough for a write the dictation still had in hand to land. */
const SETTLE_MS = 150;
const VIEWPORT = { width: 1280, height: 760 };

/** A page of the app with the recogniser stubbed: the microphone opens and closes, and the script says what is heard. */
async function app(fixture, viewport = VIEWPORT) {
  const page = await open(browser, server.url, fixture, viewport);
  await page.evaluate(() => {
    const { answers, emit } = window.__PW_STUB__;
    answers.dictation_start = () => {
      setTimeout(() => emit("dictation", { kind: "listening" }), 0);
      return null;
    };
    // Stopping delivers the last utterance as it settled (empty when it had settled already), then the stop itself.
    answers.dictation_stop = () => {
      setTimeout(() => {
        emit("dictation", { kind: "final", text: window.__settled ?? "", raw: window.__settledRaw, segment: 0 });
        emit("dictation", { kind: "stopped" });
      }, 0);
      return null;
    };
    answers.send_message = { queued: true, events: [] };
  });
  return page;
}

/** The composer on screen, focused, with its mic there. */
async function composer(page, selector) {
  const field = page.locator(`${selector}:visible`);
  await field.waitFor();
  await field.click();
  await page.getByRole("button", { name: "Dictate", exact: true }).locator("visible=true").waitFor();
  return field;
}

/** A session's composer, as dictation-edits.mjs opens it. */
async function sessionComposer() {
  const page = await app({ cloud: false, localProjects: 1, localSession: true });
  await openConversation(page, "Local long session");
  await tab(page, "gemini tab").click();
  return { page, field: await composer(page, "textarea[data-composer]") };
}

const hear = (page, text, segment = 0, kind = "partial") =>
  page.evaluate(([kind, text, segment]) => window.__PW_STUB__.emit("dictation", { kind, text, segment }), [kind, text, segment]);

/** The field's text once nothing more is on its way to it. */
async function settled(page, field) {
  await page.waitForTimeout(SETTLE_MS);
  return field.inputValue();
}

// Hold Right Option to talk: another key ends the dictation, and still edits the draft.
{
  const { page, field } = await sessionComposer();
  await page.keyboard.down("AltRight");
  await page.getByText("Listening. Speak, then release the key.", { exact: true }).waitFor();
  await hear(page, "Fix the build");
  const dictated = await settled(page, field);
  await page.evaluate(() => {
    window.__settled = "Fix the build.";
  });
  // Option+Backspace: the word before the caret.
  await page.keyboard.press("Backspace");
  await page.keyboard.up("AltRight");
  await page.getByText(/^Listening\./).waitFor({ state: "detached" });
  await page.getByText("Finishing…", { exact: true }).waitFor({ state: "detached" });
  const afterDelete = await settled(page, field);
  failed += report(
    "a key pressed while holding Right Option to talk",
    {
      "the words were dictated": dictated === "Fix the build",
      "the edit is kept when the dictation it ended settles": afterDelete === "Fix the ",
    },
    { dictated, afterDelete },
  );
  await page.close();
}

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
