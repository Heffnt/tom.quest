// What the daemon does with a hosted run between turns (hosted.mjs): the
// orchestrator lives until it asks to compact, and a worker ends once the
// server says its outcome is recorded or nothing it asked is still open. The
// case this file exists for: a worker is never ended on a poll sent before
// its own turn ended, since that poll cannot have seen the elevation the turn
// just raised.

import { describe, expect, it } from "vitest";

import {
  WORKER_ANSWER_WAIT_MS,
  asksToCompact,
  hostedIdleVerdict,
  hostedTurnEnd,
  listedCodexModels,
  runEnvelope,
} from "../hosted.mjs";

describe("asksToCompact", () => {
  it("reads the word only as the last non-empty line", () => {
    expect(asksToCompact("Document rewritten.\n\nJARVIS-COMPACT\n")).toBe(true);
    expect(asksToCompact("JARVIS-COMPACT")).toBe(true);
    expect(asksToCompact("I will send JARVIS-COMPACT later.")).toBe(false);
    expect(asksToCompact("JARVIS-COMPACT\nand then more")).toBe(false);
    expect(asksToCompact("")).toBe(false);
    expect(asksToCompact(undefined)).toBe(false);
  });
});

describe("hostedTurnEnd", () => {
  it("compacts only the orchestrator, only on a clean turn that asks", () => {
    expect(hostedTurnEnd({ environment: "orchestrator", failed: false, finalText: "done\nJARVIS-COMPACT" })).toBe("compact");
    expect(hostedTurnEnd({ environment: "orchestrator", failed: true, finalText: "JARVIS-COMPACT" })).toBe("idle");
    expect(hostedTurnEnd({ environment: "orchestrator", failed: false, finalText: "answered two elevations" })).toBe("idle");
    expect(hostedTurnEnd({ environment: "worker", failed: false, finalText: "JARVIS-COMPACT" })).toBe("idle");
  });
});

describe("hostedIdleVerdict", () => {
  const base = { environment: "worker", pendingTurn: false, outcomeRecorded: false, openElevations: 0, idleSince: 1_000, polledAt: 2_000, now: 2_000 };

  it("never decides on a poll sent before the turn ended", () => {
    expect(hostedIdleVerdict({ ...base, polledAt: 900 })).toBe("wait");
    expect(hostedIdleVerdict({ ...base, polledAt: 1_000 })).toBe("wait");
    expect(hostedIdleVerdict({ ...base, idleSince: undefined })).toBe("wait");
  });

  it("delivers a waiting message before anything ends", () => {
    expect(hostedIdleVerdict({ ...base, pendingTurn: true, outcomeRecorded: true })).toBe("wait");
  });

  it("ends a worker whose outcome is recorded, or that has nothing open", () => {
    expect(hostedIdleVerdict({ ...base, outcomeRecorded: true, openElevations: 2 })).toBe("end");
    expect(hostedIdleVerdict(base)).toBe("end");
  });

  it("keeps a worker waiting on an answer, up to the wait", () => {
    expect(hostedIdleVerdict({ ...base, openElevations: 1 })).toBe("wait");
    expect(hostedIdleVerdict({ ...base, openElevations: 1, now: 1_000 + WORKER_ANSWER_WAIT_MS })).toBe("end-waited");
  });

  it("never ends the orchestrator", () => {
    expect(hostedIdleVerdict({ ...base, environment: "orchestrator", outcomeRecorded: true })).toBe("wait");
  });
});

describe("runEnvelope", () => {
  it("names the orchestrator's runs as its own environment", () => {
    expect(runEnvelope("autonomous", "orchestrator")).toEqual({ origin: "orchestrator", kind: "job", environment: "orchestrator" });
    expect(runEnvelope("autonomous", "worker")).toEqual({ origin: "daemon", kind: "job", environment: "worker" });
    expect(runEnvelope("autonomous", undefined)).toEqual({ origin: "daemon", kind: "job", environment: "worker" });
    expect(runEnvelope("interactive", undefined)).toEqual({ origin: "session", kind: "session", environment: "session" });
  });
});

describe("listedCodexModels", () => {
  it("keeps the slugs the catalog lists for use", () => {
    const catalog = JSON.stringify({
      models: [
        { slug: "gpt-6-astra", visibility: "list" },
        { slug: "gpt-reserve", visibility: "hide" },
        { slug: "gpt-5.6-sol", visibility: "list" },
      ],
    });
    expect(listedCodexModels(catalog)).toEqual(["gpt-6-astra", "gpt-5.6-sol"]);
    expect(() => listedCodexModels("{}")).toThrow(/no model list/);
  });
});
