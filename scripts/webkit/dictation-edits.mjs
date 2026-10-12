#!/usr/bin/env node
// WebKit check for #428, in the built app (`pnpm build`) with real key events:
// what the reader deletes from the composer while dictating stays deleted.
//
// In every composer (a local session's, the one that starts a session, a
// cloud tab's, and both of the floating window's):
// - deleting with no dictation at all works;
// - Backspace over everything dictated removes it, the utterance coming back
//   in its settled form does not bring it back, and what is said next goes in.
//
// And in a session's composer:
// - Delete over the last dictated word and Cut in the middle each remove the
//   text for good, and a second edit made straight after the first is kept;
// - words spoken after a deletion go in at the caret;
// - an edit made before the first words arrive is kept (a local model's all
//   arrive when the mic closes);
// - the same holds once the mic has closed, and after a message is sent;
// - Undo brings the deleted text back, and what is said next goes after it;
// - a key pressed while holding Right Option to talk edits the draft, and the
//   result that settles afterwards does not undo the edit.
//
//   pnpm build && npx playwright install webkit && pnpm test:webkit-dictation-edits
import { launch, open, report, serve } from "./harness.mjs";

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
        emit("dictation", { kind: "final", text: window.__settled ?? "", segment: 0 });
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

const SURFACES = {
  "a session's composer": async () => {
    const page = await app({ cloud: false, localProjects: 1, localSession: true });
    await page.getByRole("button", { name: "Expand main", exact: true }).click();
    await page.getByRole("button", { name: "Local long session", exact: true }).click();
    await page.locator('[role="treeitem"][aria-label="gemini tab"]').click();
    return { page, field: await composer(page, "textarea[data-composer]") };
  },
  "the composer that starts a session": async () => {
    const page = await app({ cloud: false, localProjects: 1 });
    return { page, field: await composer(page, "textarea[data-new-session-prompt]") };
  },
  "a cloud tab's composer": async () => {
    const page = await app({ cloud: true, localProjects: 0, session: { role: "manager", lines: 2 } });
    const title = await page.evaluate(() => window.__PW_RUNTIME__.sessionTitle);
    const row = page.locator('[data-testid="cloud-session-node"]');
    await row.waitFor();
    await row.getByRole("button", { name: title, exact: true }).click();
    await page.locator('[data-testid="cloud-agent-lease"]').waitFor();
    return { page, field: await composer(page, "main textarea[data-composer]") };
  },
  "the floating window's composer": async () => {
    const page = await app({ cloud: false, localProjects: 1, localSession: true, floating: true }, { width: 520, height: 640 });
    await page.locator("[data-floating-shell]").waitFor();
    return { page, field: await composer(page, "textarea[data-composer]") };
  },
  "the floating window's start screen": async () => {
    const page = await app({ cloud: false, localProjects: 1, floating: true }, { width: 520, height: 640 });
    await page.locator("[data-floating-shell]").waitFor();
    return { page, field: await composer(page, "textarea[data-new-session-prompt]") };
  },
};

const sessionComposer = SURFACES["a session's composer"];

const hear = (page, text, segment = 0, kind = "partial") =>
  page.evaluate(([kind, text, segment]) => window.__PW_STUB__.emit("dictation", { kind, text, segment }), [kind, text, segment]);

/** The field's text once nothing more is on its way to it. */
async function settled(page, field) {
  await page.waitForTimeout(SETTLE_MS);
  return field.inputValue();
}

async function openMic(page) {
  await page.keyboard.press("Meta+Shift+D");
  await page.getByText("Listening. Speak, then press the mic again.", { exact: true }).waitFor();
}

/** Close the mic; the recogniser finishes the last utterance as `text`. */
async function closeMic(page, text = "") {
  await page.evaluate((text) => {
    window.__settled = text;
  }, text);
  await page.keyboard.press("Meta+Shift+D");
  await page.getByText(/^Listening\./).waitFor({ state: "detached" });
  await page.getByText("Finishing…", { exact: true }).waitFor({ state: "detached" });
}

/** Select `count` characters backwards from the caret, as Shift+Left does. */
async function selectBack(page, count) {
  for (let i = 0; i < count; i++) await page.keyboard.press("Shift+ArrowLeft");
}

// Every composer: deleting with no dictation, and Backspace over everything dictated.
for (const [name, surface] of Object.entries(SURFACES)) {
  const { page, field } = await surface();
  await page.keyboard.type("Fix the build");
  await selectBack(page, " build".length);
  await page.keyboard.press("Backspace");
  const afterBackspace = await settled(page, field);
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Delete");
  const afterDelete = await settled(page, field);

  await openMic(page);
  await hear(page, "Fix");
  await hear(page, "Fix the build");
  const dictated = await settled(page, field);
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Backspace");
  const afterDictatedDelete = await settled(page, field);
  // The utterance comes back settled, with the same words tidied up.
  await hear(page, "Fix the build.");
  const afterSettled = await settled(page, field);
  await hear(page, "Then run the tests", 1);
  const afterSpeech = await settled(page, field);
  failed += report(
    name,
    {
      "with no dictation, Backspace removes a selection": afterBackspace === "Fix the",
      "with no dictation, Delete removes everything selected": afterDelete === "",
      "words are dictated into it": dictated === "Fix the build",
      "Backspace over everything dictated removes it": afterDictatedDelete === "",
      "the settled utterance does not bring it back": afterSettled === "",
      "what is said next goes in": afterSpeech === "Then run the tests",
    },
    { afterBackspace, afterDelete, dictated, afterDictatedDelete, afterSettled, afterSpeech },
  );
  await page.close();
}

// Delete over the last word: the draft is then one the dictation wrote a moment earlier.
{
  const { page, field } = await sessionComposer();
  await field.fill("Notes:");
  await openMic(page);
  await hear(page, "Fix");
  await hear(page, "Fix the");
  await hear(page, "Fix the build");
  const dictated = await settled(page, field);
  await selectBack(page, " build".length);
  await page.keyboard.press("Delete");
  const afterDelete = await settled(page, field);
  await hear(page, "Fix the build");
  const afterSettled = await settled(page, field);
  await hear(page, "and ship it", 1);
  const afterSpeech = await settled(page, field);
  failed += report(
    "Delete over the last dictated word",
    {
      "the words were dictated after the typed text": dictated === "Notes: Fix the build",
      "the word is removed": afterDelete === "Notes: Fix the",
      "the settled utterance does not bring it back": afterSettled === "Notes: Fix the",
      "what is said next goes in at the caret": afterSpeech === "Notes: Fix the and ship it",
    },
    { dictated, afterDelete, afterSettled, afterSpeech },
  );
  await page.close();
}

// Cut in the middle, then a second edit straight after it.
{
  const { page, field } = await sessionComposer();
  await openMic(page);
  await hear(page, "Fix the build please");
  const dictated = await settled(page, field);
  await selectBack(page, "please".length);
  await page.keyboard.press("Meta+X");
  const afterCut = await settled(page, field);
  await selectBack(page, "build ".length);
  await page.keyboard.press("Backspace");
  const afterSecond = await settled(page, field);
  await hear(page, "Fix the build, please.");
  const afterSettled = await settled(page, field);
  await hear(page, "Fix the build, please. Now");
  const afterSpeech = await settled(page, field);
  failed += report(
    "Cut, then a second edit straight after it",
    {
      "the words were dictated": dictated === "Fix the build please",
      "the cut removes the selection": afterCut === "Fix the build ",
      "the second edit is kept": afterSecond === "Fix the ",
      "the settled utterance brings neither back": afterSettled === "Fix the ",
      "a word added to the same utterance goes in at the caret": afterSpeech === "Fix the Now",
    },
    { dictated, afterCut, afterSecond, afterSettled, afterSpeech },
  );
  await page.close();
}

// A local model says nothing until the mic closes: what the reader does before then is kept.
{
  const { page, field } = await sessionComposer();
  await field.fill("Old notes");
  await openMic(page);
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("New:");
  const edited = await settled(page, field);
  await closeMic(page, "Fix the build.");
  const afterFinal = await settled(page, field);
  failed += report(
    "an edit made before the first words arrive",
    {
      "the reader's edit is in the field": edited === "New:",
      "the words go after it, and what was deleted stays deleted": afterFinal === "New: Fix the build.",
    },
    { edited, afterFinal },
  );
  await page.close();
}

// Once the mic has closed.
{
  const { page, field } = await sessionComposer();
  await openMic(page);
  await hear(page, "Fix the build");
  await closeMic(page, "Fix the build.");
  const dictated = await settled(page, field);
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Backspace");
  const afterDelete = await settled(page, field);
  await page.keyboard.press("Meta+Z");
  const afterUndo = await settled(page, field);
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("Run the tests");
  const afterTyping = await settled(page, field);
  failed += report(
    "deleting after the mic has closed",
    {
      "the final words were kept": dictated === "Fix the build.",
      "the selection is removed": afterDelete === "",
      "Undo brings it back": afterUndo === "Fix the build.",
      "deleted again, the reader can type on": afterTyping === "Run the tests",
    },
    { dictated, afterDelete, afterUndo, afterTyping },
  );
  await page.close();
}

// Sending a dictated message, with the mic open and with it closed.
for (const close of [false, true]) {
  const { page, field } = await sessionComposer();
  await openMic(page);
  await hear(page, "Fix the build");
  if (close) await closeMic(page);
  const dictated = await settled(page, field);
  await field.press("Enter");
  const afterSend = await settled(page, field);
  const checks = {
    "the words were dictated": dictated === "Fix the build",
    "the composer is empty once it is sent": afterSend === "",
  };
  const detail = { dictated, afterSend };
  if (!close) {
    // The sent utterance settles, and the next message is dictated into the empty composer.
    await hear(page, "Fix the build.");
    detail.afterSettled = await settled(page, field);
    await hear(page, "Then run the tests", 1);
    detail.afterSpeech = await settled(page, field);
    checks["the sent utterance settling does not bring it back"] = detail.afterSettled === "";
    checks["the next message is dictated into the empty composer"] = detail.afterSpeech === "Then run the tests";
  }
  failed += report(`sending a dictated message, mic ${close ? "closed" : "still open"}`, checks, detail);
  await page.close();
}

// Undo, then more speech. One ⌘Z in Playwright's WebKit undoes every step the
// field remembers, in any page, so each Undo here follows a single edit.
{
  const { page, field } = await sessionComposer();
  await openMic(page);
  await hear(page, "Fix the build");
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Backspace");
  const afterDelete = await settled(page, field);
  await page.keyboard.press("Meta+Z");
  const afterUndo = await settled(page, field);
  await hear(page, "Fix the build.");
  const afterSettled = await settled(page, field);
  await hear(page, "Then run the tests", 1);
  const afterSpeech = await settled(page, field);
  failed += report(
    "Undo after a deletion",
    {
      "the selection is removed": afterDelete === "",
      "Undo brings it back": afterUndo === "Fix the build",
      "it is not said twice when the utterance settles": afterSettled === "Fix the build",
      "what is said next goes after it, not over it": afterSpeech === "Fix the build Then run the tests",
    },
    { afterDelete, afterUndo, afterSettled, afterSpeech },
  );
  await page.close();
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
