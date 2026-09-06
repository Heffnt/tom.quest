// Tests for the shared brief-clipping rule in tts-lib.mjs.
//
// This rule used to be spelled twice — once in plan-graphs.mjs (with an
// ellipsis marker and an empty-text case) and once in form-batches.mjs (a bare
// slice with neither) — so the same brief reached the model in two forms
// depending on which planner read it. These three cases are exactly the ones
// the two old spellings disagreed about, so they are what a re-split would
// break first.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clip,
  declined,
  declinedLine,
  MAX_BRIEF_CHARS,
  MAX_LIFE_PER_RUN,
  ttsItemLink,
} from "./tts-lib.mjs";

describe("clip", () => {
  it("returns text shorter than the limit unchanged and unmarked", () => {
    expect(clip("a short brief", MAX_BRIEF_CHARS)).toBe("a short brief");
  });

  it("returns text exactly at the limit unchanged and unmarked", () => {
    const exact = "x".repeat(MAX_BRIEF_CHARS);
    expect(clip(exact, MAX_BRIEF_CHARS)).toBe(exact);
  });

  it("cuts text over the limit and marks the cut with an ellipsis", () => {
    const long = "y".repeat(MAX_BRIEF_CHARS + 50);
    const clipped = clip(long, MAX_BRIEF_CHARS);
    expect(clipped).toBe(`${"y".repeat(MAX_BRIEF_CHARS)}…`);
    // The marker is appended after the slice, so the result is one character
    // longer than the limit. The limit bounds the source text, not the output.
    expect(clipped).toHaveLength(MAX_BRIEF_CHARS + 1);
  });

  it("maps empty and missing text to null, never to an empty string", () => {
    // A blank field would read to the model as a claim that the todo HAS an
    // empty brief; null drops the field from the JSON instead.
    expect(clip("", MAX_BRIEF_CHARS)).toBeNull();
    expect(clip(undefined, MAX_BRIEF_CHARS)).toBeNull();
    expect(clip(null, MAX_BRIEF_CHARS)).toBeNull();
  });

  it("honours a caller-supplied limit other than MAX_BRIEF_CHARS", () => {
    // plan-graphs.mjs calls the same function with its preview limits.
    expect(clip("abcdef", 3)).toBe("abc…");
  });
});

describe("planner input bounds", () => {
  it("holds the values both planners were spelling separately", () => {
    expect(MAX_LIFE_PER_RUN).toBe(80);
    expect(MAX_BRIEF_CHARS).toBe(400);
  });
});

describe("the item link", () => {
  it("is the one URL shape worker/ writes", () => {
    // convex/ttsShared.ts ttsItemLink is the same string server-side; a job
    // that spells it itself is the drift this helper exists to stop.
    expect(ttsItemLink("k17abc")).toBe("https://tom.quest/tts?item=k17abc");
  });
});

// An integration Tom declines is an archived todo with his ruling on it
// (convex/ttsIntegrations.ts). Every poller asks this first and stands down
// when the answer is not null.
describe("declined", () => {
  const env = { CONVEX_SITE_URL: "https://x.convex.site", TTS_WORKER_KEY: "k" };
  const outlook = {
    name: "outlook",
    todoId: "k1",
    ruledAt: Date.UTC(2026, 8, 5, 14),
    sentence: "not worth the credential",
  };

  function serving(body) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
      })),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("finds the ruling for this job's own name", async () => {
    serving({ captureTriage: "rules", declinedIntegrations: [outlook] });
    expect(await declined(env, "outlook")).toEqual(outlook);
  });

  it("is null for a job Tom has not declined", async () => {
    serving({ captureTriage: "rules", declinedIntegrations: [outlook] });
    expect(await declined(env, "gmail")).toBeNull();
    serving({ captureTriage: "rules", declinedIntegrations: [] });
    expect(await declined(env, "outlook")).toBeNull();
  });

  it("matches the name however the caller spelled it", async () => {
    serving({ captureTriage: "rules", declinedIntegrations: [outlook] });
    expect(await declined(env, " Outlook ")).toEqual(outlook);
  });

  it("survives a deployment that does not serve the field yet", async () => {
    // A box running ahead of the deployment must not crash every poller.
    serving({ captureTriage: "rules" });
    expect(await declined(env, "outlook")).toBeNull();
  });
});

describe("declinedLine", () => {
  it("says who declined it, when, and why", () => {
    expect(
      declinedLine("poll-outlook", {
        ruledAt: Date.UTC(2026, 8, 5, 14),
        sentence: "not worth the credential",
      }),
    ).toBe(
      "[poll-outlook] declined by Tom on 2026-09-05: not worth the credential — skipping",
    );
  });

  it("drops the reason when he gave none", () => {
    expect(
      declinedLine("poll-canvas", { ruledAt: Date.UTC(2026, 8, 5, 14), sentence: null }),
    ).toBe("[poll-canvas] declined by Tom on 2026-09-05 — skipping");
  });
});
