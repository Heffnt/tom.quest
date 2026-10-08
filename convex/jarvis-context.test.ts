import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import schema from "./schema";

// From the convex root, as every other test: convex-test names modules by
// their path under convex/, so a glob from a subdirectory finds none of them.
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

// EVERY FIXTURE HERE IS INVENTED. His pages are private to WikiTom and this
// repository is public.

const KEY = { "X-Jarvis-Key": "k" };

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /jarvis/context", () => {
  it("exposes the delegate's two readers", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    expect((await t.fetch("/jarvis/context?for=ask&job=delegate", { headers: KEY })).status).toBe(200);
    const unknown = await t.fetch("/jarvis/context?for=nope", { headers: KEY });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe("for must be one of planner, ask");
    expect((await t.fetch("/jarvis/context?for=learning", { headers: KEY })).status).toBe(400);
    expect((await t.fetch("/tts/learning-input", { headers: { "X-TTS-Key": "k" } })).status).toBe(404);
  });

  it("answers the delegate's view with the missing-layer sentence when no model-of-tom is stored", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const response = await t.fetch("/jarvis/context?for=planner", { headers: KEY });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "model-of-tom layer operate is not stored" });
  });

  it("does not register retired planner and learning aliases", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    for (const [path, method] of [
      ["/tts/prepare-todo", "POST"],
      ["/tts/rulings", "GET"],
      ["/tts/ruling-applied", "POST"],
      ["/tts/ask-context", "GET"],
      ["/tts/planner-context", "GET"],
      ["/tts/repo-rules", "POST"],
      ["/tts/learning-input", "GET"],
      ["/tts/simplify-input", "GET"],
      ["/tts/simplify-open", "GET"],
      ["/tts/removals-open", "GET"],
      ["/tts/learning-objections-consumed", "POST"],
      ["/tts/repo-proposals", "GET"],
      ["/tts/repo-proposal-applied", "POST"],
      ["/tts/repo-proposal-dropped", "POST"],
    ] as const) {
      expect((await t.fetch(path, { method, headers: { "X-TTS-Key": "k" } })).status).toBe(404);
    }
    for (const name of ["work-queue", "learning", "simplify"]) {
      expect((await t.fetch(`/jarvis/context?for=${name}`, { headers: KEY })).status).toBe(400);
    }
  });
});
