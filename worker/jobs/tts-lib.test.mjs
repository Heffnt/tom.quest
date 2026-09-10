// Tests for the shared brief-clipping rule in tts-lib.mjs.
//
// This rule used to be spelled twice — once in plan-graphs.mjs (with an
// ellipsis marker and an empty-text case) and once in the retired v1 batcher
// (a bare slice with neither) — so the same brief reached the model in two
// forms depending on which planner read it. These three cases are exactly the
// ones the two old spellings disagreed about, so they are what a re-split
// would break first.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureContext,
  clip,
  convexFetch,
  declined,
  declinedLine,
  MAX_BRIEF_CHARS,
  MAX_LIFE_PER_RUN,
  JSON_ONLY_ANSWER,
  NO_ID,
  reconcileVerdicts,
  reportJobFailed,
  reportJobOk,
  ttsItemLink,
  unmatchedIdKey,
  unmatchedIdMessage,
  untriagedKey,
  untriagedMessage,
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
  const outlook = {
    name: "outlook",
    todoId: "k1",
    ruledAt: Date.UTC(2026, 8, 5, 14),
    sentence: "not worth the credential",
  };

  it("finds the ruling for this job's own name", () => {
    expect(
      declined({ declinedIntegrations: [outlook] }, "outlook"),
    ).toEqual(outlook);
  });

  it("is null for a job Tom has not declined", () => {
    expect(
      declined({ declinedIntegrations: [outlook] }, "gmail"),
    ).toBeNull();
    expect(
      declined({ declinedIntegrations: [] }, "outlook"),
    ).toBeNull();
  });

  it("matches the name however the caller spelled it", () => {
    expect(
      declined({ declinedIntegrations: [outlook] }, " Outlook "),
    ).toEqual(outlook);
  });

  it("survives a deployment that does not serve the field yet", () => {
    // A box running ahead of the deployment must not crash every poller.
    expect(declined({}, "outlook")).toBeNull();
    expect(declined(undefined, "outlook")).toBeNull();
  });
});

// ONE READ PER RUN. A poller reads its writing standard and declined list from
// one payload, and `declined` takes that payload rather than fetching its own.
describe("captureContext", () => {
  const env = { CONVEX_SITE_URL: "https://x.convex.site", TTS_WORKER_KEY: "k" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is the single GET the writing standard and declined list come from", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          writingStandard: "write standard",
          declinedIntegrations: [],
        }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const context = await captureContext(env);
    expect(declined(context, "gmail")).toBeNull();
    expect(context.writingStandard).toBe("write standard");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://x.convex.site/tts/capture-context",
    );
  });

  it("passes a missing model-of-tom block refusal to its caller unchanged", async () => {
    const refusal = "model-of-tom block write is not stored";
    const body = JSON.stringify({ error: refusal });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, text: async () => body })));

    await expect(captureContext(env)).rejects.toMatchObject({ message: refusal, status: 503, body });
  });
});

describe("convexFetch failures", () => {
  const env = { CONVEX_SITE_URL: "https://x.convex.site", TTS_WORKER_KEY: "k" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps unrelated HTTP errors in the HTTP summary", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: "invalid JSON body" }) })));

    await expect(convexFetch(env, "/tts/example")).rejects.toMatchObject({
      message: '/tts/example -> HTTP 400: {"error":"invalid JSON body"}',
      status: 400,
      body: '{"error":"invalid JSON body"}',
    });
  });
});

// A job's report about itself must never become a second unreported failure,
// and telling Tom about a bad run must never cost the run's real work.
describe("reportJobFailed / reportJobOk", () => {
  const env = { CONVEX_SITE_URL: "https://x.convex.site", TTS_WORKER_KEY: "k" };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the job, the words and the condition key", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, reported: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    expect(
      await reportJobFailed(env, {
        job: "poll-canvas",
        error: "the token is dead",
        key: "poll-canvas:canvas-auth",
      }),
    ).toEqual({ ok: true, reported: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://x.convex.site/tts/job-failed");
    expect(JSON.parse(init.body)).toEqual({
      job: "poll-canvas",
      error: "the token is dead",
      key: "poll-canvas:canvas-auth",
    });
  });

  it("swallows a refusal rather than failing twice over one failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })),
    );
    expect(await reportJobFailed(env, { job: "poll-canvas", error: "x" })).toBeNull();
    expect(await reportJobOk(env, { job: "poll-canvas", key: "k" })).toBeNull();
  });
});

// SILENCE USED TO MEAN "SKIP". Each poller looked its batch up in a map keyed
// by the ids the MODEL returned, and a miss read as "not captured" — so a
// garbled id dropped a mail, the cursor advanced past it, and the only trace
// was a count one lower.
describe("reconcileVerdicts", () => {
  const yes = (id, statement) => ({ id, capture: true, statement });
  const no = (id) => ({ id, capture: false });

  it("gives every answered item its verdict and leaves nothing unresolved", () => {
    const { byId, unmatched, unresolved } = reconcileVerdicts(
      ["a", "b", "c"],
      [yes("a", "Reply to Sarah"), no("b"), yes("c", "Pay the invoice")],
    );
    expect(unresolved).toEqual([]);
    expect(unmatched).toEqual([]);
    expect(byId.get("a")).toMatchObject({ capture: true, statement: "Reply to Sarah" });
    expect(byId.get("b")).toEqual({ capture: false });
  });

  it("names the item a garbled id lost AND the garbled id itself", () => {
    // "b1" for "b": the mail has no verdict and the answer carries an id that
    // was never in the batch. Both are facts, and both are reported.
    const { byId, unmatched, unresolved } = reconcileVerdicts(
      ["a", "b", "c"],
      [no("a"), yes("b1", "Reply to Sarah"), no("c")],
    );
    expect(unresolved).toEqual(["b"]);
    expect(unmatched).toEqual(["b1"]);
    expect(byId.has("b")).toBe(false);
  });

  it("leaves an item the model simply did not mention unresolved", () => {
    const { unresolved, unmatched } = reconcileVerdicts(["a", "b"], [no("a")]);
    expect(unresolved).toEqual(["b"]);
    expect(unmatched).toEqual([]);
  });

  it("keeps the batch's own order, so the caller can stop at the oldest", () => {
    expect(reconcileVerdicts(["a", "b", "c", "d"], [no("c")]).unresolved).toEqual([
      "a",
      "b",
      "d",
    ]);
  });

  it("treats a claim with no statement as no verdict at all", () => {
    // "capture: true" with nothing to write claims an action and names none.
    // Reading it as a skip would lose the item exactly the way silence did.
    for (const answer of [
      { id: "a", capture: true },
      { id: "a", capture: true, statement: "   " },
      { id: "a" },
      { id: "a", capture: "yes" },
    ]) {
      expect(reconcileVerdicts(["a"], [answer]).unresolved).toEqual(["a"]);
    }
    // Whereas an explicit no is a complete verdict.
    expect(reconcileVerdicts(["a"], [no("a")]).unresolved).toEqual([]);
  });

  it("collects an answer that names no id under one stand-in, deduped", () => {
    const { unmatched, unresolved } = reconcileVerdicts(
      ["a"],
      [{ capture: false }, { id: "", capture: false }, { id: "zz", capture: false }],
    );
    expect(unmatched).toEqual([NO_ID, "zz"]);
    expect(unresolved).toEqual(["a"]);
  });

  it("survives an answer that is not a list of objects", () => {
    expect(reconcileVerdicts(["a"], undefined).unresolved).toEqual(["a"]);
    expect(reconcileVerdicts(["a"], [null, 7, "b"]).unresolved).toEqual(["a"]);
  });
});

describe("what an untriaged item is reported as", () => {
  it("is keyed on the item, so a mail retried every tick is one row", () => {
    // The cursor holds at the oldest untriaged item, so the same mail comes
    // back every ten minutes until a run answers for it. Keyed on the mail,
    // that is one row (convex/ttsJobs.ts); keyed on the run it would be one
    // row every ten minutes, for ever.
    expect(untriagedKey("poll-gmail", "gmail:message:18f0a1")).toBe(
      "poll-gmail:untriaged:gmail:message:18f0a1",
    );
    expect(unmatchedIdKey("poll-gmail", "18f0a1x")).toBe(
      "poll-gmail:unmatched-id:18f0a1x",
    );
    // Model output, clipped: an id can come back arbitrarily long.
    expect(unmatchedIdKey("poll-gmail", "x".repeat(500))).toHaveLength(
      "poll-gmail:unmatched-id:".length + 80,
    );
  });

  it("says what was skipped and what the cursor is doing about it", () => {
    const message = untriagedMessage(
      "poll-gmail",
      '"Lab meeting Friday" from Sarah Chen',
      "gmail:message:18f0a1",
    );
    expect(message).toContain("Lab meeting Friday");
    expect(message).toContain("gmail:message:18f0a1");
    expect(message).toContain("read again next run");
    expect(unmatchedIdMessage("poll-canvas", "991x")).toContain('"991x"');
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


describe("JSON_ONLY_ANSWER", () => {
  it("is the one JSON instruction every worker prompt shares", () => {
    expect(JSON_ONLY_ANSWER).toBe("Answer ONLY a JSON object, no prose, no code fences:");
  });
});
