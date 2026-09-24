import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  channelFor,
  feedIsPrivate,
  privateFeedNames,
  type ModelFamily,
  type NarrowListItem,
  type SessionModel,
  SESSION_REPOS,
} from "./ttsShared";

// ── The private calendar feeds ───────────────────────────────────────────────
// There is no state of TTS_ICS_FEEDS in which the answer is "name everything".
// The mirrored rows outlive the variable: clearing it stops the fetch but
// leaves every ttsCalendarEvents row in place, so an absent variable once meant
// "nothing is private" and Tom's family calendar printed in the morning
// message.
describe("privateFeedNames", () => {
  const feeds = JSON.stringify([
    { name: "google", url: "https://example.invalid/g.ics" },
    { name: "family", url: "https://example.invalid/f.ics", private: true },
  ]);

  it("names the feeds marked private, and only those", () => {
    const privateFeeds = privateFeedNames(feeds);
    expect(privateFeeds).toEqual(new Set(["family"]));
    expect(feedIsPrivate("family", privateFeeds)).toBe(true);
    expect(feedIsPrivate("google", privateFeeds)).toBe(false);
  });

  it("treats an unreadable variable as every feed being private", () => {
    expect(privateFeedNames("{not json")).toBe("all");
    expect(privateFeedNames(JSON.stringify({ name: "google" }))).toBe("all");
  });

  it("treats an absent or empty variable as every feed being private", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(privateFeedNames(raw)).toBe("all");
      expect(feedIsPrivate("google", privateFeedNames(raw))).toBe(true);
      // Including a row whose feed name is gone from the config entirely.
      expect(feedIsPrivate(undefined, privateFeedNames(raw))).toBe(true);
    }
  });
});

// ── The six channels ─────────────────────────────────────────────────────────
// Only the morning falls back to SLACK_TTS_CHANNEL_ID. Every other kind
// answers null, because the Slack door's default target is that same variable
// and a fallback would put the message in #tts-today.
describe("channelFor", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("answers each channel's own variable", () => {
    vi.stubEnv("SLACK_TTS_NEEDS_YOU_CHANNEL_ID", "C0NEEDSYOU");
    vi.stubEnv("SLACK_TTS_BROKEN_CHANNEL_ID", "C0BROKEN");
    vi.stubEnv("SLACK_TTS_SIMPLIFY_CHANNEL_ID", "C0SIMPLIFY");
    expect(channelFor("needsYou")).toBe("C0NEEDSYOU");
    expect(channelFor("broken")).toBe("C0BROKEN");
    expect(channelFor("simplify")).toBe("C0SIMPLIFY");
  });

  it("falls back to SLACK_TTS_CHANNEL_ID for the morning and nothing else", () => {
    vi.stubEnv("SLACK_TTS_CHANNEL_ID", "C0TTS");
    vi.stubEnv("SLACK_TTS_TODAY_CHANNEL_ID", "");
    vi.stubEnv("SLACK_TTS_NEEDS_YOU_CHANNEL_ID", "");
    vi.stubEnv("SLACK_TTS_DECISIONS_CHANNEL_ID", "");
    vi.stubEnv("SLACK_TTS_HOURLY_CHANNEL_ID", "");
    vi.stubEnv("SLACK_TTS_BROKEN_CHANNEL_ID", "");
    vi.stubEnv("SLACK_TTS_SIMPLIFY_CHANNEL_ID", "");
    expect(channelFor("today")).toBe("C0TTS");
    expect(channelFor("needsYou")).toBeNull();
    expect(channelFor("decisions")).toBeNull();
    expect(channelFor("hourly")).toBeNull();
    expect(channelFor("broken")).toBeNull();
    expect(channelFor("simplify")).toBeNull();
  });
});

// ── The session constants keep their literal types ──────────────────────────
// Their one home is shared/session-constants.mjs, plain ESM whose tables carry
// a JSDoc `@type {const}` cast. If that cast stopped being read, SessionModel
// would widen to string and every check below would still compile at runtime,
// so these are type assertions: the root `tsc -p tsconfig.json` fails on them.
describe("the session constants' types", () => {
  it("keep every table's literal keys and values", () => {
    expectTypeOf<SessionModel>().toEqualTypeOf<
      "opus" | "sonnet" | "fable" | "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-6-astra"
    >();
    expectTypeOf<ModelFamily>().toEqualTypeOf<"claude" | "codex">();
    expectTypeOf<keyof typeof SESSION_REPOS>().toEqualTypeOf<"tom.quest" | "ComplexMultiTrigger" | "WikiTom" | "Jarvis">();
    expectTypeOf<NarrowListItem["id"]>().toEqualTypeOf<
      "money" | "message-in-his-name" | "irreversible-deletion" | "credential"
    >();
  });
});
