// The model-of-tom skills, mirrored out of WikiTom (Tom's ruling, 2026-08-29).
//
// A SKILL is a standard Claude Code skill file — WikiTom
// model-of-tom/skills/<name>/SKILL.md, YAML frontmatter (name, description)
// then markdown instructions. WikiTom is the SYSTEM OF RECORD for every one of
// them; this table is a copy, and nothing here ever writes back.
//
// WHY A COPY AT ALL: the consumers cannot read a git checkout. Convex has no
// filesystem, and the planner and batcher on the Jarvis Box are Node ESM that
// never loads TypeScript, so their half arrives over HTTP (GET
// /tts/batch-context). The copy is what lets the skill text reach a prompt.
//
// THE FALLBACK RULE: every consumer prefers the synced row and falls back to
// the hardcoded copy in convex/ttsShared.ts (WRITING_STANDARD) when the table
// is empty. GITHUB_MIRROR_TOKEN is currently scoped to ComplexMultiTrigger and
// tom.quest only, so a WikiTom read comes back 404 or 403 until Tom widens it —
// that is a logged, quiet no-op here, which is what lets the cron ship first.

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireTomOrAgent } from "./authRoles";

const SKILLS_REPO = "Heffnt/WikiTom";
const SKILLS_DIR = "model-of-tom/skills";

/**
 * The synced body of a skill, or `fallback` when nothing is synced. THE ONE
 * READ every server-side consumer goes through, so "prefer the skill, fall
 * back to the hardcoded copy" cannot mean two different things in two files.
 */
export async function skillText(
  ctx: QueryCtx | MutationCtx,
  name: string,
  fallback: string,
): Promise<string> {
  const row = await ctx.db
    .query("ttsSkills")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  const body = row?.body.trim() ?? "";
  return body === "" ? fallback : body;
}

export const internalGetSkill = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    return await ctx.db
      .query("ttsSkills")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
  },
});

// The browser's read. Closed to everyone but Tom and the read-only `agent`
// role a TTS session browses as — the skills are Tom's model of himself, not
// public text, and `agent` may look at them without changing them.
export const getSkill = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    await requireTomOrAgent(ctx, "TTS");
    return await ctx.db
      .query("ttsSkills")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
  },
});

// Wholesale replace, keyed by name: upsert what the sync read, drop what it did
// not. A skill directory removed in WikiTom must stop reaching prompts —
// nothing-is-lost governs Tom's todos, not this mirror.
export const internalReplaceSkills = internalMutation({
  args: {
    skills: v.array(
      v.object({
        name: v.string(),
        body: v.string(),
        sourcePath: v.string(),
      }),
    ),
  },
  handler: async (ctx, { skills }) => {
    const now = Date.now();
    const existing = await ctx.db.query("ttsSkills").collect();
    const byName = new Map(existing.map((r) => [r.name, r]));
    const seen = new Set<string>();
    for (const skill of skills) {
      seen.add(skill.name);
      const prior = byName.get(skill.name);
      if (prior) await ctx.db.patch(prior._id, { ...skill, syncedAt: now });
      else await ctx.db.insert("ttsSkills", { ...skill, syncedAt: now });
    }
    let deleted = 0;
    for (const prior of existing) {
      if (seen.has(prior.name)) continue;
      await ctx.db.delete(prior._id);
      deleted++;
    }
    return { upserted: skills.length, deleted };
  },
});

type ContentsEntry = { name?: unknown; path?: unknown; type?: unknown };

// The GitHub contents API on a directory returns one entry per child; a skill
// is a child DIRECTORY holding SKILL.md. No ?ref= — the default branch is the
// published state of WikiTom, and a worktree's branch is not.
export const refreshSkills = internalAction({
  args: {},
  handler: async (ctx) => {
    const token = process.env.GITHUB_MIRROR_TOKEN;
    if (!token) return;
    const headers = {
      Authorization: `Bearer ${token}`,
      "User-Agent": "tts-skills",
    };
    try {
      const listRes = await fetch(
        `https://api.github.com/repos/${SKILLS_REPO}/contents/${SKILLS_DIR}`,
        { headers: { ...headers, Accept: "application/vnd.github+json" } },
      );
      // 404 (repo or path invisible to this token) and 403 (token not scoped to
      // WikiTom) are the expected states until the token is widened: say so
      // once and leave every existing row untouched.
      if (!listRes.ok) {
        console.error(
          `TTS skills: ${SKILLS_DIR} listing failed (${listRes.status}) — rows left untouched`,
        );
        return;
      }
      const listed = (await listRes.json()) as unknown;
      if (!Array.isArray(listed)) {
        console.error(`TTS skills: ${SKILLS_DIR} is not a directory listing`);
        return;
      }
      const skills: { name: string; body: string; sourcePath: string }[] = [];
      for (const entry of listed as ContentsEntry[]) {
        if (entry?.type !== "dir" || typeof entry.name !== "string") continue;
        const sourcePath = `${SKILLS_DIR}/${entry.name}/SKILL.md`;
        const res = await fetch(
          `https://api.github.com/repos/${SKILLS_REPO}/contents/${sourcePath}`,
          { headers: { ...headers, Accept: "application/vnd.github.raw+json" } },
        );
        // A directory with no SKILL.md is not a skill; a failure on one file
        // must not cost the others their refresh.
        if (res.status === 404) continue;
        if (!res.ok) {
          console.error(`TTS skills: ${sourcePath} fetch failed (${res.status})`);
          continue;
        }
        const body = await res.text();
        if (body.trim() === "") continue;
        skills.push({ name: entry.name, body, sourcePath });
      }
      // Shape-change guard, same reasoning as the code-todo mirror: a listing
      // that yields no skills at all means the layout moved or the reads
      // failed, not that Tom deleted his model of himself. Replacing here would
      // silently drop every consumer back to the hardcoded fallback.
      if (skills.length === 0) {
        console.error(
          `TTS skills: ${SKILLS_DIR} yielded 0 skills — layout change? Rows left untouched.`,
        );
        return;
      }
      await ctx.runMutation(internal.ttsSkills.internalReplaceSkills, { skills });
    } catch (err) {
      console.error(
        `TTS skills: refresh error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});
