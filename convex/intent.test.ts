import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { isIntentSourcePath } from "./intent";
import { assembleContext } from "./ttsContext";
import { contextPublication, expectedPrefix } from "../scripts/context-fixture.mjs";

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

// ── intent.agentView ─────────────────────────────────────────────────────────
// The base is scripts/context-fixture.mjs's invented pages. Every expected
// grant block and skill block below is written out by hand: one rendered by
// calling the renderer would assert only that the renderer is itself.

const VIEW_COMMIT = "0123abcd0123abcd0123abcd0123abcd0123abcd";
const PROVENANCE = (paths: string) =>
  `<!-- generated from WikiTom ${paths} at commit ${VIEW_COMMIT} — do not edit -->`;

/** Four published skills, their bodies invented, as the skills door stores
 *  them. `know-intent` joins its two pages the way the publisher does. */
const VIEW_SKILLS = [
  {
    name: "write",
    group: "write" as const,
    description: "Load before writing anything Tom reads.",
    body: "# Writing\n\nBe plain.",
    references: [{ name: "ground.md", path: "model-of-tom/ground.md", body: "# Ground" }],
    sourcePaths: ["model-of-tom/writing.md"],
  },
  {
    name: "know-intent",
    group: "know" as const,
    description: "What Tom wants to be true.",
    body: "── model-of-tom/intent.md ──\n# Intent\n\n- Ship the fleet.\n\n── model-of-tom/priorities.md ──\n# Priorities\n\n- He rules.",
    references: [],
    sourcePaths: ["model-of-tom/intent.md", "model-of-tom/priorities.md"],
  },
  {
    name: "know-week",
    group: "know" as const,
    description: "Tom's recurring week.",
    body: "# Schedule\n\n- Monday — practice.",
    references: [],
    sourcePaths: ["model-of-tom/schedule.md"],
  },
  {
    name: "know-research",
    group: "know" as const,
    description: "Tom's research.",
    body: "# Research",
    references: [],
    sourcePaths: ["model-of-tom/areas/research.md"],
  },
];

async function seedAgentView(t: ReturnType<typeof convexTest>) {
  const publication = contextPublication(VIEW_COMMIT);
  await t.run(async (ctx) => {
    await ctx.db.insert("modelOfTomPublication", {
      key: "current",
      commit: VIEW_COMMIT,
      committedAt: 1,
      pushed: true,
      operate: publication.layers.operate,
      headers: publication.headers.filter(
        (header: { layers: string[] }) => header.layers.join(",") === "operate",
      ),
    });
    for (const skill of VIEW_SKILLS) {
      await ctx.db.insert("ttsSkills", { ...skill, commit: VIEW_COMMIT, syncedAt: 1, pushed: true });
    }
  });
}

/** A skill block as `tts search skills <name>` heads it, over the SKILL.md
 *  body; `file` is the whole SKILL.md, frontmatter included, whose bytes the
 *  head counts. */
function skillBlock(head: string, description: string, file: string, body: string): string {
  return `${head} ${new TextEncoder().encode(file).length}B\ndescription="${description}"\n\n${body}`;
}

describe("intent.agentView", () => {
  it("is restricted to Tom", async () => {
    const t = convexTest(schema, modules);
    await expect(t.query(api.intent.agentView, { caller: "planner-context" }))
      .rejects.toThrow(/Authentication required/);
  });

  it("gives planner-context the exact prefix and grants its prompt carries, then each granted body", async () => {
    const t = convexTest(schema, modules);
    await seedAgentView(t);
    const view = await (await asTom(t)).query(api.intent.agentView, { caller: "planner-context" });
    const assembled = await t.run(async (ctx) =>
      assembleContext(ctx, { kind: "none" }, { reachesTom: true, caller: "planner-context" }));

    expect(view?.prefix).toBe(assembled.prefix);
    expect(view?.prefix).toBe(expectedPrefix(VIEW_COMMIT, { write: false }));
    expect(view?.grants).toBe(assembled.grants);
    expect(view?.grants).toBe([
      `SKILLS (WikiTom commit ${VIEW_COMMIT})`,
      "granted: write, know-intent",
      "Load each granted skill before you act on what it covers. `tts-search skills` lists the rest.",
    ].join("\n"));

    expect(view?.listing).toBe([
      "- tom-know-intent: What Tom wants to be true.",
      "- tom-know-research: Tom's research.",
      "- tom-know-week: Tom's recurring week.",
      "- tom-write: Load before writing anything Tom reads.",
    ].join("\n"));

    const writeBody = `${PROVENANCE("model-of-tom/writing.md")}\n\n# Writing\n\nBe plain.\n\n## References\n\n`
      + "The following files are beside this SKILL.md; read the ones relevant to the task:\n- `ground.md`";
    const writeFile = `---\nname: tom-write\ndescription: "Load before writing anything Tom reads."\n---\n\n${writeBody}\n`;
    const intentBody = `${PROVENANCE("model-of-tom/intent.md, model-of-tom/priorities.md")}\n\n`
      + "── model-of-tom/intent.md ──\n# Intent\n\n- Ship the fleet.\n\n── model-of-tom/priorities.md ──\n# Priorities\n\n- He rules.";
    const intentFile = `---\nname: tom-know-intent\ndescription: "What Tom wants to be true."\n---\n\n${intentBody}\n`;
    expect(view?.skills).toEqual([
      { name: "write", text: skillBlock("write [write]", "Load before writing anything Tom reads.", writeFile, writeBody) },
      { name: "know-intent", text: skillBlock("know-intent [know]", "What Tom wants to be true.", intentFile, intentBody) },
    ]);
  });

  it("gives each subjectless caller its own grants", async () => {
    const t = convexTest(schema, modules);
    await seedAgentView(t);
    const tom = await asTom(t);
    const names = async (caller: string) =>
      (await tom.query(api.intent.agentView, { caller }))?.skills.map((skill) => skill.name);
    expect(await names("time-notes")).toEqual(["write", "know-week"]);
    expect(await names("laptop")).toEqual(["write"]);
  });

  it("refuses a caller that runs with a subject", async () => {
    const t = convexTest(schema, modules);
    await seedAgentView(t);
    await expect((await asTom(t)).query(api.intent.agentView, { caller: "planner" }))
      .rejects.toThrow(/not planner/);
  });

  it("is null until a night has posted the base", async () => {
    const t = convexTest(schema, modules);
    expect(await (await asTom(t)).query(api.intent.agentView, { caller: "laptop" })).toBeNull();
  });
});
