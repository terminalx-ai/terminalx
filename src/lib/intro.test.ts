import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { INTRO_LAST_STEP, finishIntro, introDue, resetIntroForTests, setIntroStep, showIntro, useIntroOpen } from "./intro";

const signedOut = { ready: true, status: { state: "signed-out" as const } };

beforeEach(() => {
  resetIntroForTests();
  setPrefs({ introSlides: false, introStep: 0, introDone: false });
});

it("is due only on a signed-out first run with its switch on", () => {
  expect(introDue({ introSlides: false, introDone: false }, signedOut)).toBe(false);
  expect(introDue({ introSlides: true, introDone: false }, signedOut)).toBe(true);
  expect(introDue({ introSlides: true, introDone: true }, signedOut)).toBe(false);
  expect(introDue({ introSlides: true, introDone: false }, { ready: false, status: { state: "signed-out" } })).toBe(false);
  expect(introDue({ introSlides: true, introDone: false }, { ready: true, status: { state: "signed-in" } })).toBe(false);
  expect(introDue({ introSlides: true, introDone: false }, { ready: true, status: { state: "signing-in" } })).toBe(false);
});

it("saves the step where a relaunch reads it, kept within the slides", () => {
  setIntroStep(2);
  expect(getPrefs().introStep).toBe(2);
  expect(JSON.parse(localStorage.getItem("raccoon.prefs") ?? "{}").introStep).toBe(2);
  setIntroStep(9);
  expect(getPrefs().introStep).toBe(INTRO_LAST_STEP);
  setIntroStep(-1);
  expect(getPrefs().introStep).toBe(0);
});

it("opens again from Help only while its switch is on, at the first slide", () => {
  const { result } = renderHook(() => useIntroOpen());
  act(() => showIntro());
  expect(result.current).toBe(false);
  setPrefs({ introSlides: true, introDone: true, introStep: 2 });
  act(() => showIntro());
  expect(result.current).toBe(true);
  expect(getPrefs().introStep).toBe(0);
});

it("never comes back on its own once finished", () => {
  setPrefs({ introSlides: true, introStep: 2 });
  const { result } = renderHook(() => useIntroOpen());
  act(() => showIntro());
  act(() => finishIntro());
  expect(result.current).toBe(false);
  expect(getPrefs().introDone).toBe(true);
  expect(introDue(getPrefs(), signedOut)).toBe(false);
});
