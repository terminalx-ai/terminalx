import { describe, expect, it, vi } from "vitest";

vi.mock("./AppProvider", () => ({ useApp: () => ({ activeHost: null }) }));

import { botsOffDetail, hostWords } from "./host-words";

describe("the words for a paired computer", () => {
  it("names each system's computer as that system does", () => {
    expect(hostWords("macos").your).toBe("your Mac");
    expect(hostWords("windows").This).toBe("This PC");
    expect(hostWords("linux").the).toBe("the computer");
  });

  it("calls a computer whose system is not known a plain computer", () => {
    for (const platform of [undefined, null, "", "freebsd", "darwin"]) {
      expect(hostWords(platform)).toEqual({ computer: "computer", your: "your computer", Your: "Your computer", this: "this computer", This: "This computer", the: "the computer", The: "The computer" });
    }
  });

  it("does not tell a Windows computer's owner to turn Bots on", () => {
    expect(botsOffDetail("windows")).toBe("Bots are not available on Windows yet.");
    expect(botsOffDetail("macos")).toBe("Turn them on on your Mac in Settings → Experimental → Bots.");
    expect(botsOffDetail(undefined)).toBe("Turn them on on your computer in Settings → Experimental → Bots.");
  });
});
