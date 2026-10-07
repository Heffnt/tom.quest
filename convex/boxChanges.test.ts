import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { boxChangeFaults, boxChangeLines, type BoxChange } from "./boxChanges";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const change = (over: Partial<BoxChange> = {}): BoxChange => ({
  source: "sudo",
  why: "ran-as-root",
  command: "sudo systemctl restart tts-session-host",
  user: "jarvis",
  at: Date.UTC(2026, 9, 7),
  ...over,
});

describe("box changes", () => {
  it("rejects a malformed box-change body", () => {
    expect(boxChangeFaults({ source: "sudo", why: "ran-as-root" })).toContain("data.user must be a non-empty string");
  });

  it("summarizes changes for the history page", () => {
    expect(boxChangeLines([change({ agentId: "codex:box:one" })])).toEqual([
      expect.objectContaining({ id: "box:agent:codex:box:one", text: expect.stringContaining("root command") }),
    ]);
  });

  it("records a valid box change through the record route", async () => {
    vi.stubEnv("JARVIS_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    try {
      const response = await t.fetch("/jarvis/event", {
        method: "POST",
        headers: { "X-TTS-Key": "s3cret", "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "box-change", at: change().at, provenance: { job: "box-watch" }, data: change() }),
      });
      expect(response.status).toBe(200);
      const rows = await t.run((ctx) => ctx.db.query("events").collect());
      expect(rows.some((row) => row.kind === "box-change")).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
