import { describe, expect, it } from "vitest";
import {
  sessionsMissingProjectAgents,
  sessionsMissingWikiTom,
} from "./instructions-loaded-report.mjs";

describe("instructions-loaded report", () => {
  it("finds sessions that loaded no model-of-tom file", () => {
    const lines = [
      { session: "complete", path: "C:/Users/heffn/Desktop/WikiTom/model-of-tom/agent-rules.md" },
      { session: "missing", path: "C:/Users/heffn/Desktop/tom.quest/AGENTS.md" },
    ];

    expect(sessionsMissingWikiTom(lines)).toEqual(["missing"]);
  });

  it("ignores sessions outside every managed repo root", () => {
    const lines = [
      {
        session: "out-of-scope",
        cwd: "C:/Users/heffn/Desktop/elsewhere",
        path: "C:/Users/heffn/Desktop/elsewhere/notes.md",
      },
    ];

    expect(sessionsMissingProjectAgents(lines)).toEqual([]);
  });
});
