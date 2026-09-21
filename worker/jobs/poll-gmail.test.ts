// The strings poll-gmail.mjs writes that something else reads back: the stable
// source id it stamps on a todo, and the triage prompt. The job no longer
// writes any message text — the needs-you thread is composed in
// convex/ttsSlack.ts from the todo and the verdict's reason (slack-design.md
// §4.5) — so there is no line here to check any more. The job itself cannot be
// run anywhere yet (the GMAIL_* keys are unset on the Jarvis Box), so its pure
// exports are what can be checked.
//
// Importing the job module is safe: it only calls main() when node was pointed
// at the file (the `invokedDirectly` guard at the bottom of poll-gmail.mjs).
import { describe, expect, it } from "vitest";
// A plain-JS worker job (deployed to the Jarvis Box as .mjs); the test reads
// its pure exports, which TypeScript infers straight from the source.
import fs from "node:fs";
import {
  captureBody,
  messageProvenance,
  messageSourceId,
  gmailTriagePrompt,
} from "./poll-gmail.mjs";

describe("the stable source id of a mail", () => {
  it("names the Gmail message id first, then the link", () => {
    // The id LEADS so a reader can tell the producers apart by eye and a
    // machine can key on the message without parsing a URL fragment — the
    // same shape poll-canvas writes for announcements and convex/ttsCanvas.ts
    // for assignments.
    expect(messageSourceId("18f0a1")).toBe("gmail:message:18f0a1");
    expect(messageProvenance("18f0a1")).toBe(
      "gmail:message:18f0a1 https://mail.google.com/mail/u/0/#all/18f0a1",
    );
  });

  it("leads the provenance, so the capture names its mail once", () => {
    expect(messageProvenance("42").startsWith(messageSourceId("42"))).toBe(true);
  });
});

// Tom, 2026-09-21: "workers should not reach me at all directly." The mail
// pollers opened a #tts-needs-you thread per mail judged to need him today;
// that morning twelve opened for stale GitHub failure mail.
describe("needing Tom today", () => {
  it("rides the capture as a judgement and a reason", () => {
    expect(captureBody("m1", { capture: true, statement: "Pay the invoice", needsTomToday: true, why: "it is due tomorrow" })).toEqual({
      statement: "Pay the invoice",
      source: "email",
      provenance: messageProvenance("m1"),
      needsTomToday: true,
      why: "it is due tomorrow",
    });
    expect(captureBody("m2", { capture: true, statement: "Read it", needsTomToday: false, why: "" })).not.toHaveProperty("needsTomToday");
  });

  it("opens no needs-you thread from either mail poller", () => {
    for (const file of ["poll-gmail.mjs", "poll-outlook.mjs"]) {
      const source = fs.readFileSync(`worker/jobs/${file}`, "utf8");
      expect(source).not.toContain('"/tts/needs-tom"');
      expect(source).not.toContain("needs-you-thread");
    }
  });
});

describe("the Gmail triage prompt", () => {
  it("begins with the writing standard and puts mail data last", () => {
    const prompt = gmailTriagePrompt("WRITE STANDARD", [{ id: "m1", from: "A", subject: "S", snippet: "body" }]);
    expect(prompt.startsWith("WRITE STANDARD")).toBe(true);
    expect(prompt.lastIndexOf('"m1"')).toBeGreaterThan(prompt.indexOf("Emails:"));
    expect(prompt).not.toContain("Do not invent details");
    expect(prompt).not.toContain("deadline inside 48 hours");
    expect(prompt).toContain('Include "why" only when');
  });

  // The one sentence §4.5 adds: `why` is no longer a log-file note, it is the
  // first line of the message that asks Tom to settle the thing.
  it("says that why is printed to Tom beside the item, and forbids the sender and the subject", () => {
    const prompt = gmailTriagePrompt("WRITE STANDARD", [{ id: "m1", from: "A", subject: "S", snippet: "body" }]);
    expect(prompt).toContain('"why" IS PRINTED TO TOM');
    expect(prompt).toContain("half a sentence he can read");
    expect(prompt).toContain("never name the sender or quote the subject line");
  });
});
