// The two strings poll-gmail.mjs writes that something else reads back: the
// stable source id it stamps on a todo, and the one line a #tts thread opens
// with. The job itself cannot be run anywhere yet (the GMAIL_* keys are unset
// on the Jarvis Box), so its pure exports are what can be checked — and they
// are exactly the parts a later reader depends on.
//
// Importing the job module is safe: it only calls main() when node was pointed
// at the file (the `invokedDirectly` guard at the bottom of poll-gmail.mjs).
import { describe, expect, it } from "vitest";
// A plain-JS worker job (deployed to the Jarvis Box as .mjs); the test reads
// its pure exports, which TypeScript infers straight from the source.
import {
  messageProvenance,
  messageSourceId,
  needsTomLine,
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

  it("is what the #tts thread is deduped on, so both spell it once", () => {
    // The dedupe key handed to POST /tts/needs-tom is the source id itself,
    // not a second string built beside it: one mail, one thread, forever.
    expect(messageProvenance("42").startsWith(messageSourceId("42"))).toBe(true);
  });
});

describe("the line a #tts thread opens with", () => {
  it("is the sender, the subject, and the todo's link — and nothing else", () => {
    expect(
      needsTomLine("Sarah Chen <sarah@wpi.edu>", "Lab meeting Friday", "k123"),
    ).toBe(
      "Needs you today — Sarah Chen <sarah@wpi.edu>: Lab meeting Friday\n" +
        "https://tom.quest/tts?item=k123",
    );
  });
});
