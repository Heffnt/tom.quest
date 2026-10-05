// tom.quest/design's record side (convex/jarvis/design.ts): the registry and
// explanation rows the box and the sessions post, and the registry diff on a
// Jarvis head's tests row with the base registry it is drawn against.

import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const JSON_HEADERS = { "Content-Type": "application/json", "X-Jarvis-Key": "k" };

type T = ReturnType<typeof convexTest>;
const post = (t: T, path: string, body: unknown) => t.fetch(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });

async function tom(t: T) {
  const id = await t.run((ctx) => ctx.db.insert("users", { name: "tom", email: "tom@example.test", role: "tom" }));
  return t.withIdentity({ subject: id });
}

/** A complete registry row: every field Jarvis scripts/check-parts.mjs requires. */
const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  type: "program",
  file: null,
  starts: [],
  reads: [],
  writes: [],
  refuses: [],
  routes: [],
  schedule: null,
  fate: { type: "kept", by: null },
  serves: [{ guarantee: "G4" }],
  designed_by: "outcomes",
  note: `The ${id} part.`,
  ...extra,
});
const PARTS = [row("ran", { schedule: "ran" }), row("idle")];

const registryBody = (sha: string, parts: Record<string, unknown>[] = PARTS) => ({
  kind: "registry",
  subject: `Jarvis@${sha}`,
  provenance: { job: "deploy" },
  data: { id: `registry:Jarvis@${sha}`, repo: "Jarvis", sha, parts, count: parts.length },
  text: `registry of Jarvis at ${sha.slice(0, 7)}: ${parts.length} parts`,
});

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

afterEach(() => vi.unstubAllEnvs());

describe("the rows the page reads", () => {
  it("takes a registry once per deployed commit, a retry answered as a duplicate, and refuses a malformed one", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const first = await (await post(t, "/jarvis/event", registryBody("bbbbbbb2"))).json();
    const again = await (await post(t, "/jarvis/event", registryBody("bbbbbbb2"))).json();
    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(again).toMatchObject({ ok: true, id: first.id, duplicate: true });
    expect((await post(t, "/jarvis/event", { ...registryBody("ccccccc3"), subject: "Jarvis@other" })).status).toBe(400);
    const rows = await t.run((ctx) => ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "registry")).collect());
    expect(rows.map((r) => r.subject)).toEqual(["Jarvis@bbbbbbb2"]);
  });

  it("takes an explanation by the session that wrote it, and refuses one with a script", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const html = "<!doctype html><html><body><h1>idle</h1></body></html>";
    const body = { kind: "explanation", subject: "idle", provenance: { session: "s1" }, data: { title: "What idle is", html }, text: "What idle is" };
    expect((await post(t, "/jarvis/event", body)).status).toBe(200);
    expect((await post(t, "/jarvis/event", { ...body, data: { title: "x", html: "<!doctype html><script></script>" } })).status).toBe(400);
  });
});

describe("the route that copies rows unchecked", () => {
  it("refuses a registry or an explanation, so the diff view's base registry stays the checked one", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const viewer = await tom(t);
    await post(t, "/jarvis/event", registryBody("aaaaaaa1"));
    const diff = { base: "aaaaaaa1", added: [], removed: ["idle"], changed: [], rows: {} };
    await post(t, "/tts/tests", { repo: "Jarvis", sha: "head1", ok: true, registryDiff: diff });
    const before = await viewer.query(api.jarvis.design.diff, { head: "Jarvis@head1" });
    expect(before).toMatchObject({ baseIsExact: true, base: { sha: "aaaaaaa1" } });

    const malformed = await post(t, "/tts/event", { kind: "registry", key: "Jarvis@aaaaaaa1", data: { parts: "not a list" } });
    expect(malformed.status).toBe(403);
    expect((await post(t, "/tts/event", { kind: "explanation", key: "idle", data: { html: "<script></script>" } })).status).toBe(403);

    const rows = await t.run((ctx) => ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "registry")).collect());
    expect(rows).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.query("dtsEvents").filter((q) => q.eq(q.field("kind"), "registry")).collect())).toEqual([]);
    expect(await viewer.query(api.jarvis.design.diff, { head: "Jarvis@head1" })).toEqual(before);
  });
});

describe("the registry diff on a head's tests row", () => {
  const diff = { base: "aaaaaaa1", added: [], removed: ["idle"], changed: ["ran"], rows: { ran: { ...PARTS[0], note: "changed" } } };

  it("is stored when well-formed, dropped when not with the row still written, and drawn against its base", async () => {
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const viewer = await tom(t);
    expect((await post(t, "/tts/tests", { repo: "Jarvis", sha: "head1", ok: true, registryDiff: diff })).status).toBe(200);
    expect((await post(t, "/tts/tests", { repo: "Jarvis", sha: "head2", ok: true, registryDiff: { ...diff, added: "ran" } })).status).toBe(200);
    // A changed id whose row holds only its id is dropped the same way.
    expect((await post(t, "/tts/tests", { repo: "Jarvis", sha: "head3", ok: true, registryDiff: { ...diff, rows: { ran: { id: "ran" } } } })).status).toBe(200);
    const rows = await t.run((ctx) => ctx.db.query("dtsEvents").collect());
    const of = (key: string) => rows.find((r) => r.kind === "tests-run" && r.key === key)?.data as Record<string, unknown>;
    expect(of("Jarvis@head1").registryDiff).toEqual(diff);
    expect(of("Jarvis@head2")).toMatchObject({ ok: true });
    expect(of("Jarvis@head2")).not.toHaveProperty("registryDiff");
    expect(of("Jarvis@head3")).toMatchObject({ ok: true });
    expect(of("Jarvis@head3")).not.toHaveProperty("registryDiff");

    expect(await viewer.query(api.jarvis.design.diff, { head: "Jarvis@head2" })).toBeNull();
    expect(await viewer.query(api.jarvis.design.diff, { head: "no-sha" })).toBeNull();
    // No registry at the base yet: the newest stands in, and says so.
    await post(t, "/jarvis/event", registryBody("bbbbbbb2"));
    expect(await viewer.query(api.jarvis.design.diff, { head: "Jarvis@head1" })).toMatchObject({ head: "Jarvis@head1", registryDiff: diff, baseIsExact: false, base: { sha: "bbbbbbb2" } });
    await post(t, "/jarvis/event", registryBody("aaaaaaa1"));
    expect(await viewer.query(api.jarvis.design.diff, { head: "Jarvis@head1" })).toMatchObject({ baseIsExact: true, base: { sha: "aaaaaaa1" } });
  });

  it("is read by Tom alone", async () => {
    const t = convexTest({ schema, modules });
    const userId = await t.run((ctx) => ctx.db.insert("users", { name: "reader", email: "reader@example.test", role: "user" }));
    const reader = t.withIdentity({ subject: userId });
    await expect(reader.query(api.jarvis.design.diff, { head: "Jarvis@head1" })).rejects.toThrow("Design access is restricted to Tom");
  });
});
