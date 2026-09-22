import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { isIntentSourcePath } from "./intent";

// EVERY FIXTURE HERE IS INVENTED. His pages are private to WikiTom and this
// repository is public.

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const KEY = { "X-TTS-Key": "s3cret", "Content-Type": "application/json" };
const COMMIT = "a".repeat(40);

async function asTom(t: ReturnType<typeof convexTest>) {
  const id = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: id });
}

function source(path: string, body: string, repo = "WikiTom") {
  return { repo, path, body, bytes: body.length, commit: COMMIT, syncedAt: 1_700_000_000_000 };
}

async function post(t: ReturnType<typeof convexTest>, files: unknown[]) {
  return await t.fetch("/tts/intent-sources", {
    method: "POST",
    headers: KEY,
    body: JSON.stringify({ files }),
  });
}

describe("isIntentSourcePath", () => {
  it("takes a relative path inside a repository", () => {
    expect(isIntentSourcePath("vqc/steering.yaml")).toBe(true);
    expect(isIntentSourcePath("model-of-tom/evidence/intent.md")).toBe(true);
  });

  it("refuses anything that leaves the checkout", () => {
    expect(isIntentSourcePath("/etc/passwd")).toBe(false);
    expect(isIntentSourcePath("../secrets/next.env")).toBe(false);
    expect(isIntentSourcePath("vqc/../../x")).toBe(false);
    expect(isIntentSourcePath("")).toBe(false);
    expect(isIntentSourcePath(7)).toBe(false);
  });
});

describe("POST /tts/intent-sources", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is behind the worker key like every other pen", async () => {
    const t = convexTest(schema, modules);
    expect((await post(t, [source("vqc/steering.yaml", "- id: a\n  correction: b\n")])).status).toBe(503);
  });

  it("replaces every row, so a file it stops sending leaves none behind", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest(schema, modules);
    const first = await post(t, [
      source("tts/spec.md", "# Spec\n"),
      source("vqc/steering.yaml", "- id: a\n  correction: b\n", "tom.quest"),
    ]);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, files: 2, deleted: 0 });

    const second = await post(t, [source("tts/spec.md", "# Spec, later\n")]);
    expect(await second.json()).toMatchObject({ ok: true, files: 1, deleted: 2 });
    const rows = await t.run(async (ctx) => ctx.db.query("intentSources").collect());
    expect(rows.map((row) => row.path)).toEqual(["tts/spec.md"]);
    expect(rows[0].body).toBe("# Spec, later\n");
  });

  it.each([
    [[], "files (non-empty array) required"],
    [[{ ...source("tts/spec.md", "# Spec\n"), path: "../escape.md" }], "must be a relative path"],
    [[{ ...source("tts/spec.md", "  \n") }], "non-empty string"],
    [[{ ...source("tts/spec.md", "# Spec\n"), commit: "short" }], "40 hex characters"],
    [[{ ...source("tts/spec.md", "# Spec\n"), repo: " " }], "repo"],
    [[source("tts/spec.md", "# Spec\n"), source("tts/spec.md", "# Again\n")], "posted twice"],
  ])("refuses a malformed post (%#)", async (files, message) => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest(schema, modules);
    const res = await post(t, files);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(message);
  });

  // `--only=post` from an older checkout is a supported run, and it must not
  // roll the page back to a night that has already been superseded.
  it("refuses a post whose sources are older than the stored ones", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest(schema, modules);
    await post(t, [{ ...source("tts/spec.md", "# Spec, tonight\n"), syncedAt: 2_000 }]);
    const stale = await post(t, [{ ...source("tts/spec.md", "# Spec, last week\n"), syncedAt: 1_000 }]);
    expect(stale.status).toBe(400);
    expect(((await stale.json()) as { error: string }).error).toContain("older than the stored one");
    const rows = await t.run(async (ctx) => ctx.db.query("intentSources").collect());
    expect(rows[0].body).toBe("# Spec, tonight\n");
  });

  // A rerun at the same commit is the same bodies, so it replaces.
  it("takes a post at the same commit time", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest(schema, modules);
    await post(t, [{ ...source("tts/spec.md", "# Spec\n"), syncedAt: 2_000 }]);
    const again = await post(t, [{ ...source("vqc/adoption.md", "# adoption\n"), syncedAt: 2_000 }]);
    expect(again.status).toBe(200);
    const rows = await t.run(async (ctx) => ctx.db.query("intentSources").collect());
    expect(rows.map((row) => row.path)).toEqual(["vqc/adoption.md"]);
  });

  // A refused post must leave what the page is reading exactly as it was.
  it("leaves the store alone when a later file is malformed", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest(schema, modules);
    await post(t, [source("tts/spec.md", "# Spec\n")]);
    await post(t, [source("vqc/adoption.md", "# adoption\n"), { ...source("x", "y"), bytes: -1 }]);
    const rows = await t.run(async (ctx) => ctx.db.query("intentSources").collect());
    expect(rows.map((row) => row.path)).toEqual(["tts/spec.md"]);
  });
});

describe("intent.lines", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is restricted to Tom", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.intent.lines, {})).rejects.toThrow(/Authentication required/);
    const stranger = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "someone", email: "someone@tom.quest", role: "admin" }),
    );
    await expect(t.withIdentity({ subject: stranger }).query(api.intent.lines, {}))
      .rejects.toThrow(/restricted to Tom/);
  });

  it("reads all four kinds out of the homes that already hold them", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("modelOfTomFiles", {
        name: "intent",
        sourcePath: "model-of-tom/intent.md",
        body: "# Intent\n\n## What to protect\n\n- The record of him is his.\n",
        syncedAt: 10,
        commit: COMMIT,
      });
      await ctx.db.insert("intentSources", source(
        "model-of-tom/evidence/intent.md",
        "## What to protect\n\n- line: The record of him is his.\n  said: 2026-09-05 · a session · \"it is mine\"\n",
      ));
      await ctx.db.insert("intentSources", source(
        "vqc/steering.yaml",
        "- id: say-it-once\n  kind: preference\n  owner: tom\n  created: 2026-08-25\n  correction: Say it once.\n",
        "tom.quest",
      ));
      await ctx.db.insert("repoRules", {
        repo: "tom.quest", path: "app/AGENTS.md",
        body: "# app\n\n## ui\n\n- No explainer text in product UI.\n",
        bytes: 1, commit: COMMIT, syncedAt: 10,
      });
      await ctx.db.insert("dtsRulings", {
        subjectType: "code", repo: "tom.quest", externalId: "x",
        verdict: "approve", sentence: "ship it", ruledAt: Date.UTC(2026, 8, 20),
      });
      await ctx.db.insert("runLabels", {
        runId: "claude:box:abcdefgh", source: "ruling", actor: "tom", polarity: "good",
        meaning: "the brief names the file it changes", judgment: true,
        ref: "ruling:1", at: Date.UTC(2026, 8, 21),
      });
    });
    const { lines, sources, capped } = await (await asTom(t)).query(api.intent.lines, {});
    expect(capped).toBe(false);

    const kinds = lines.map((line) => line.kind);
    expect(new Set(kinds)).toEqual(new Set(["direction", "standing-rule", "ruling", "label"]));

    const direction = lines.find((line) => line.kind === "direction")!;
    expect(direction).toMatchObject({
      text: "The record of him is his.",
      section: "What to protect",
      voice: "his",
      source: "model-of-tom/intent.md",
      locator: "line 5",
    });
    expect(direction.evidence[0].form).toBe("said");

    // The act is his; the WORDING of a label is an agent's, so the page must
    // not put it on screen under his name.
    const label = lines.find((line) => line.kind === "label")!;
    expect(label).toMatchObject({ voice: "unattributed", section: "good", source: "runLabels" });

    // Newest first, and the undated AGENTS.md rule last.
    expect(lines[0].kind).toBe("label");
    expect(lines[lines.length - 1].source).toBe("tom.quest app/AGENTS.md");

    expect(sources.map((row) => row.name)).toContain("vqc/steering.yaml");
    expect(sources.find((row) => row.name === "dtsRulings")?.lines).toBe(1);
  });

  it("renders a page whose evidence file has not been posted, with nothing claimed about it", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("modelOfTomFiles", {
        name: "priorities",
        sourcePath: "model-of-tom/priorities.md",
        body: "# Priorities\n\n## Rules\n\n- Never rank his work by a guess.\n",
        syncedAt: 10,
      });
    });
    const { lines } = await (await asTom(t)).query(api.intent.lines, {});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "standing-rule", voice: "unattributed", at: null });
  });

  it("returns nothing at all, rather than failing, while the record holds no sources", async () => {
    const t = convexTest(schema, modules);
    const { lines, sources } = await (await asTom(t)).query(api.intent.lines, {});
    expect(lines).toEqual([]);
    expect(sources.map((row) => row.name)).toEqual(["dtsRulings", "runLabels"]);
  });
});
