// The prompt the Fable writer is given. The job itself cannot be run anywhere
// but the Jarvis Box (it needs a Claude account and the WikiTom checkout), so
// its pure exports are what can be checked — and the prompt IS the part that
// decides whether the first attempt passes the verifier, which is the part
// worth pinning.
//
// Importing the module is safe: main() runs only when node was pointed at the
// file (the guard at the bottom of write-slack.mjs).
import { describe, expect, it } from "vitest";
import { answerShape, draftPrompt, formRules } from "./write-slack.mjs";

const FACTS = {
  requestId: "today:2026-09-09",
  kind: "today",
  canReply: false,
  facts: {
    kind: "today",
    day: "2026-09-09",
    canReply: false,
    facts: [
      {
        id: "todo:ph7fqh2j",
        text: "Run the first Friday triage session. Ten days late.",
        urls: ["https://tom.quest/tts?item=ph7fqh2j"],
        numbers: ["10"],
      },
    ],
  },
};

describe("the form the writer is given", () => {
  it("states every rule the verifier will mechanically enforce", () => {
    const rules = formRules("today", true);
    for (const rule of [
      "220", // the first line's cap
      "140", // a statement's cap
      'NEVER a bare "+N more"',
      "NEVER an ellipsis",
      "OUTCOMES, NEVER LOGGED EVENTS",
      "USE ONLY THE FACTS BELOW",
      "3,900",
    ]) {
      expect(rules).toContain(rule);
    }
    // The vocabulary the checker cannot see but the judge can, named as words.
    for (const word of ["plan stored", "session opened", "worker event", "digest", "focus-item"]) {
      expect(rules).toContain(word);
    }
  });

  it("allows a reply invitation only when the route is live, and forbids it otherwise", () => {
    expect(formRules("today", true)).toContain("ONE reply invitation is allowed");
    const dead = formRules("today", false);
    expect(dead).toContain("NO REPLY INVITATION");
    expect(dead).not.toContain("ONE reply invitation is allowed");
  });

  it("tells a needs-you writer that it has not been given the vendor's subject", () => {
    const rules = formRules("needs-you", false);
    expect(rules).toContain("THIS IS A NEEDS-YOU THREAD");
    expect(rules).toContain("Never print a vendor's subject line or a From");
    expect(rules).not.toContain("THIS IS THE MORNING MESSAGE");
  });
});

describe("the answer shape", () => {
  it("asks for the per-line citations the verifier reads", () => {
    const shape = answerShape();
    expect(shape).toContain('"firstLineSources"');
    expect(shape).toContain('"sources"');
    expect(shape).toContain("no source that holds it is refused");
  });
});

describe("the whole prompt", () => {
  it("puts the write layer first, then the form, then the facts", () => {
    const prompt = draftPrompt("WRITE LAYER", FACTS, []);
    expect(prompt.startsWith("WRITE LAYER")).toBe(true);
    expect(prompt.indexOf("THE FORM.")).toBeGreaterThan(prompt.indexOf("WRITE LAYER"));
    expect(prompt.indexOf("--- THE FACTS ---")).toBeGreaterThan(prompt.indexOf("THE FORM."));
    expect(prompt).toContain('"id": "todo:ph7fqh2j"');
    // Nothing about a repair turn on the first attempt.
    expect(prompt).not.toContain("YOUR LAST DRAFT WAS REFUSED");
  });

  it("carries the verifier's own complaints into the one repair turn", () => {
    const prompt = draftPrompt("WRITE LAYER", FACTS, [
      "line 2 uses the number 704, which is in no fact it cites",
    ]);
    expect(prompt).toContain("YOUR LAST DRAFT WAS REFUSED");
    expect(prompt).toContain("- line 2 uses the number 704, which is in no fact it cites");
    expect(prompt).toContain("Fix exactly these and change nothing else");
  });
});
