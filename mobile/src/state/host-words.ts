import { platformFamily, profileFor } from "@terminalx/portable/platformProfiles";
import { useApp } from "./AppProvider";

/**
 * What the phone calls a paired computer, in that computer's own words: "your
 * Mac", "your PC", "your computer". A computer whose system is not known yet
 * (an older desktop, or before it has connected) is a plain computer.
 */
export interface HostWords {
  /** "Mac", "PC", "computer". */
  computer: string;
  /** "your Mac". */
  your: string;
  /** "Your Mac". */
  Your: string;
  /** "this Mac". */
  this: string;
  /** "This Mac". */
  This: string;
  /** "the Mac". */
  the: string;
  /** "The Mac". */
  The: string;
}

export function hostWords(platform: string | null | undefined): HostWords {
  const family = platformFamily(platform);
  const computer = family ? profileFor(family).computerWord : "computer";
  return { computer, your: `your ${computer}`, Your: `Your ${computer}`, this: `this ${computer}`, This: `This ${computer}`, the: `the ${computer}`, The: `The ${computer}` };
}

/** Why a computer's bots are off, and what to do there: Windows has no Bots yet. */
export function botsOffDetail(platform: string | null | undefined): string {
  if (platformFamily(platform) === "windows") return "Bots are not available on Windows yet.";
  return `Turn them on on ${hostWords(platform).your} in Settings → Experimental → Bots.`;
}

/** The words for the computer this phone is connected to, or would connect to. */
export function useHostWords(): HostWords {
  return hostWords(useApp().activeHost?.platform);
}
