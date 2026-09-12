// Tests for the supplemental caps (worker/jobs/context-relevance.mjs).
//
// What is pinned here is THE CUT ITSELF: a brief past the cap keeps its head,
// stops at a HEADING rather than mid-thought, and ends with the one sentence
// saying where the rest is. The two prompt builders — convex/claudeSessions.ts
// and app/lib/tts-session-prompt.ts — both carry whatever briefForPrompt
// returns, so a cut that landed mid-line or lost its pointer would ship to a
// run with no other way to find the brief.
//
// The relevance cut these tests used to cover — the rule-9 AGENTS.md ordering
// and the fetchable block's collapsed search line — went with the know-layer
// expansion; the routing they tested lives in skill-router.test.mjs now.

import { describe, expect, it } from "vitest";

import { BRIEF_SOURCE, briefForPrompt, byteLength, SUPPLEMENTAL_CAPS, truncateSupplemental } from "./context-relevance.mjs";

const NOTE = `… (fetch the rest: ${BRIEF_SOURCE})`;

/** A brief with a heading every 50 lines, comfortably past the cap. */
function longBrief() {
  const lines = ["# The brief", ""];
  for (let section = 0; section < 8; section += 1) {
    lines.push(`## Section ${section}`, "");
    for (let line = 0; line < 50; line += 1) {
      lines.push(`- a long line of brief, long enough to matter (${section}.${line}).`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

describe("briefForPrompt", () => {
  it("carries a brief under the cap byte for byte", () => {
    const brief = "# Short\n\n- One line.\n";
    const carried = briefForPrompt(brief);
    expect(carried).toEqual({ text: brief, truncated: false, bytes: byteLength(brief) });
  });

  it("cuts at the last heading before the cap and says where the rest is", () => {
    const brief = longBrief();
    const carried = briefForPrompt(brief);
    expect(carried.truncated).toBe(true);
    expect(carried.bytes).toBe(byteLength(brief));
    expect(byteLength(carried.text)).toBeLessThanOrEqual(SUPPLEMENTAL_CAPS.brief);
    // The head, not the tail: a brief reads forward.
    expect(carried.text.startsWith("# The brief")).toBe(true);
    expect(carried.text.endsWith(NOTE)).toBe(true);
    // What was kept is a PREFIX of the brief — nothing rewritten, nothing
    // reordered — and what follows it opens with a heading, which is what
    // "the cut lands between sections" means.
    const body = carried.text.slice(0, carried.text.length - NOTE.length - 1);
    expect(brief.startsWith(body)).toBe(true);
    expect(brief.slice(body.length).trimStart().startsWith("## ")).toBe(true);
  });

  it("treats an absent brief as empty rather than throwing", () => {
    expect(briefForPrompt(undefined)).toEqual({ text: "", truncated: false, bytes: 0 });
  });
});

describe("truncateSupplemental keep: tail", () => {
  it("keeps a transcript's END, under the cap, behind the pointer line", () => {
    const transcript = Array.from({ length: 2000 }, (_, i) => `turn ${i}: a line of transcript.`).join("\n");
    const cut = truncateSupplemental(transcript, SUPPLEMENTAL_CAPS.transcript, {
      keep: "tail",
      where: "the workspace's .tts-transcript.md",
    });
    expect(cut.truncated).toBe(true);
    expect(byteLength(cut.text)).toBeLessThanOrEqual(SUPPLEMENTAL_CAPS.transcript);
    expect(cut.text.startsWith("… (fetch the rest: the workspace's .tts-transcript.md)\n")).toBe(true);
    // A session's end is where it was going.
    expect(cut.text.endsWith("turn 1999: a line of transcript.")).toBe(true);
  });
});
