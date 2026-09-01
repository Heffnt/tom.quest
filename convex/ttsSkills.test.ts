import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { skillText } from "./ttsSkills";
import { WRITING_SKILL, WRITING_STANDARD } from "./ttsShared";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const WRITING_BODY = `---
name: writing-to-tom
description: Load before writing anything Tom will read.
---

# Writing to Tom

Use one fixed term per concept and reuse it exactly.`;

async function withTom(t: ReturnType<typeof convexTest>) {
  const tomId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "tom", email: "tom@tom.quest", role: "tom" }),
  );
  return t.withIdentity({ subject: tomId });
}

async function replace(
  t: ReturnType<typeof convexTest>,
  skills: { name: string; body: string; sourcePath: string }[],
) {
  return await t.mutation(internal.ttsSkills.internalReplaceSkills, { skills });
}

function skill(name: string, body: string) {
  return { name, body, sourcePath: `model-of-tom/skills/${name}/SKILL.md` };
}

const allSkills = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => ctx.db.query("ttsSkills").collect());

describe("internalReplaceSkills", () => {
  it("inserts a row per skill, carrying the file verbatim", async () => {
    const t = convexTest({ schema, modules });
    expect(await replace(t, [skill(WRITING_SKILL, WRITING_BODY)])).toEqual({
      upserted: 1,
      deleted: 0,
    });

    const rows = await allSkills(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(WRITING_SKILL);
    expect(rows[0].body).toBe(WRITING_BODY); // frontmatter included
    expect(rows[0].sourcePath).toBe(
      "model-of-tom/skills/writing-to-tom/SKILL.md",
    );
    expect(rows[0].syncedAt).toBeGreaterThan(0);
  });

  // witness: insert instead of patching a known name and the table grows one
  // row per sync, after which the by_name read is ambiguous and throws.
  it("updates a known name in place rather than adding a second row", async () => {
    const t = convexTest({ schema, modules });
    await replace(t, [skill(WRITING_SKILL, WRITING_BODY)]);
    const first = (await allSkills(t))[0];

    const rewritten = `${WRITING_BODY}\n\nNever paraphrase for variety.`;
    expect(await replace(t, [skill(WRITING_SKILL, rewritten)])).toEqual({
      upserted: 1,
      deleted: 0,
    });
    const rows = await allSkills(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toBe(first._id);
    expect(rows[0].body).toBe(rewritten);
  });

  // WikiTom is the system of record: a skill directory removed there stops
  // reaching prompts here.
  it("drops a row whose skill is no longer in the sync", async () => {
    const t = convexTest({ schema, modules });
    await replace(t, [
      skill(WRITING_SKILL, WRITING_BODY),
      skill("kept-dates", "# Kept dates"),
    ]);
    expect(await replace(t, [skill(WRITING_SKILL, WRITING_BODY)])).toEqual({
      upserted: 1,
      deleted: 1,
    });
    expect((await allSkills(t)).map((r) => r.name)).toEqual([WRITING_SKILL]);
  });
});

describe("skillText", () => {
  it("returns the fallback when nothing is synced", async () => {
    const t = convexTest({ schema, modules });
    const text = await t.run(async (ctx) =>
      skillText(ctx, WRITING_SKILL, WRITING_STANDARD),
    );
    expect(text).toBe(WRITING_STANDARD);
  });

  it("prefers the synced skill over the fallback", async () => {
    const t = convexTest({ schema, modules });
    await replace(t, [skill(WRITING_SKILL, WRITING_BODY)]);
    const text = await t.run(async (ctx) =>
      skillText(ctx, WRITING_SKILL, WRITING_STANDARD),
    );
    expect(text).toBe(WRITING_BODY);
  });

  // A row synced from an empty or whitespace-only file would otherwise put a
  // prompt on no standard at all — worse than the stale fallback.
  it("falls back when the synced body is blank", async () => {
    const t = convexTest({ schema, modules });
    await replace(t, [skill(WRITING_SKILL, "   \n  ")]);
    const text = await t.run(async (ctx) =>
      skillText(ctx, WRITING_SKILL, WRITING_STANDARD),
    );
    expect(text).toBe(WRITING_STANDARD);
  });

  it("falls back for a name that was never synced", async () => {
    const t = convexTest({ schema, modules });
    await replace(t, [skill("kept-dates", "# Kept dates")]);
    const text = await t.run(async (ctx) =>
      skillText(ctx, WRITING_SKILL, WRITING_STANDARD),
    );
    expect(text).toBe(WRITING_STANDARD);
  });
});

describe("getSkill", () => {
  it("serves Tom the synced row", async () => {
    const t = convexTest({ schema, modules });
    await replace(t, [skill(WRITING_SKILL, WRITING_BODY)]);
    const row = await (await withTom(t)).query(api.ttsSkills.getSkill, {
      name: WRITING_SKILL,
    });
    expect(row?.body).toBe(WRITING_BODY);
  });

  it("returns null for a name with no row", async () => {
    const t = convexTest({ schema, modules });
    const row = await (await withTom(t)).query(api.ttsSkills.getSkill, {
      name: WRITING_SKILL,
    });
    expect(row).toBeNull();
  });

  // The skills are Tom's model of himself; the gate is the same one every
  // other TTS surface uses.
  it("rejects a signed-out reader and a non-Tom user", async () => {
    const t = convexTest({ schema, modules });
    await replace(t, [skill(WRITING_SKILL, WRITING_BODY)]);
    await expect(
      t.query(api.ttsSkills.getSkill, { name: WRITING_SKILL }),
    ).rejects.toThrow(/Authentication required/);

    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "someone", email: "s@x.dev", role: "user" }),
    );
    await expect(
      t
        .withIdentity({ subject: userId })
        .query(api.ttsSkills.getSkill, { name: WRITING_SKILL }),
    ).rejects.toThrow(/restricted to Tom/);
  });
});

// ── The batch-context half (the planner's only channel) ──────────────────────
// worker/jobs/plan-graphs.mjs treats a missing `writingStandard` as fatal and
// form-batches.mjs reads the same payload, so the field must keep its name and
// its type whichever source answers.
describe("GET /tts/batch-context writing standard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function fetchStandard(t: ReturnType<typeof convexTest>) {
    const res = await t.fetch("/tts/batch-context", {
      method: "GET",
      headers: { "X-TTS-Key": "s3cret" },
    });
    expect(res.status).toBe(200);
    return (await res.json()).writingStandard;
  }

  it("serves the hardcoded copy while nothing is synced", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    expect(await fetchStandard(t)).toBe(WRITING_STANDARD);
  });

  it("serves the synced skill once it exists", async () => {
    vi.stubEnv("TTS_WORKER_KEY", "s3cret");
    const t = convexTest({ schema, modules });
    await replace(t, [skill(WRITING_SKILL, WRITING_BODY)]);
    expect(await fetchStandard(t)).toBe(WRITING_BODY);
  });
});
