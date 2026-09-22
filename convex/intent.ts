// THE INTENT SURFACE'S READ, and the door the nightly posts its missing
// sources through.
//
// HIS INTENT IS WRITTEN IN FOUR KINDS OF PLACE and this module reads all four
// in one query:
//
//   direction     — model-of-tom/intent.md: what he wants to be true. The
//                   Directions section is his own; the three below it are
//                   written from his words, each with an evidence entry.
//   standing-rule — model-of-tom/priorities.md and agent-rules.md, every
//                   repository's AGENTS.md, and vqc/steering.yaml.
//   ruling        — the dtsRulings table, and the dated notes of tts/spec.md
//                   and vqc/adoption.md that quote a ruling of his.
//   label         — the runLabels table: what he said about a run's output.
//
// NOTHING IS COPIED. Every line comes out of the body the record already holds,
// parsed at read time by convex/intentParse.ts. The one thing this module adds
// is the join: a line, its evidence, its date and where it is written.
//
// THE GATE IS `requireTom`. These are his own pages, his rulings and his
// judgments; the `agent` account reads none of it (convex/agentSurfaces.ts
// names "TTS" and "Turing" only).

import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { requireTom } from "./authRoles";
import {
  type IntentLine,
  parseAdoptionRulings,
  parseModelOfTomPage,
  parseRepoRules,
  parseSpecRevisions,
  parseSteering,
} from "./intentParse";

/** The label every gate in this module names, so a denial says which surface. */
const SURFACE = "Intent";

/** The most source files one post may carry. Six today; a post past this is a
 *  publisher bug rather than a bigger WikiTom. */
export const INTENT_SOURCES_MAX = 32;

/**
 * A path inside a repository: relative, no drive letter, no `.` or `..`
 * segment. Deliberately NOT a list of the six files the publisher sends — the
 * page reads the paths it knows and ignores the rest, so adding a source is a
 * publisher change rather than a schema change, and the check here is only that
 * the string names a file in a checkout.
 */
export function isIntentSourcePath(path: unknown): path is string {
  return typeof path === "string"
    && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(path)
    && !path.split("/").some((segment) => segment === "." || segment === "..");
}

/** The most rulings the page reads. dtsRulings is append-only at Tom's own
 *  pace, so this is a year of them and not a window. */
const RULINGS_MAX = 500;

/** The most labels the page reads, per source. */
const LABELS_MAX = 250;

/** The model-of-tom pages whose lines are intent, and which kind each is.
 *  `evidence` is the file that says what each line rests on; the two are read
 *  together or the line arrives with nothing behind it. */
const MODEL_OF_TOM_PAGES = [
  { name: "intent", path: "model-of-tom/intent.md", kind: "direction" as const },
  { name: "priorities", path: "model-of-tom/priorities.md", kind: "standing-rule" as const },
  { name: "agent-rules", path: "model-of-tom/agent-rules.md", kind: "standing-rule" as const },
];

const LABEL_SOURCES = ["ruling", "objection", "session-reply", "digest-reaction"] as const;

// ── The door ─────────────────────────────────────────────────────────────────

/**
 * Every row of `intentSources` replaced in one post, the way the model-of-tom
 * files are replaced: a file the publisher stops sending leaves no stale row
 * behind, so the page never shows a source the checkout no longer has.
 */
export const internalReplaceIntentSources = internalMutation({
  args: {
    files: v.array(v.object({
      repo: v.string(),
      path: v.string(),
      body: v.string(),
      bytes: v.number(),
      commit: v.string(),
      syncedAt: v.number(),
    })),
  },
  handler: async (ctx, { files }) => {
    if (files.length === 0) throw new Error("no files posted — store left as it was");
    if (files.length > INTENT_SOURCES_MAX) {
      throw new Error(`at most ${INTENT_SOURCES_MAX} intent sources per post — got ${files.length}`);
    }
    const seen = new Set<string>();
    for (const file of files) {
      if (file.repo.trim() === "") throw new Error(`repo for ${file.path} is required`);
      if (file.path.trim() === "") throw new Error("path is required");
      if (seen.has(file.path)) throw new Error(`path posted twice: ${file.path}`);
      if (file.body.trim() === "") throw new Error(`body for ${file.path} must be non-empty`);
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
        throw new Error(`bytes for ${file.path} must be a nonnegative integer`);
      }
      if (!Number.isFinite(file.syncedAt)) throw new Error(`syncedAt for ${file.path} must be finite`);
      if (file.commit.trim() === "") throw new Error(`commit for ${file.path} is required`);
      seen.add(file.path);
    }
    const existing = await ctx.db.query("intentSources").collect();
    for (const row of existing) await ctx.db.delete(row._id);
    for (const file of files) await ctx.db.insert("intentSources", file);
    return { files: files.length, deleted: existing.length };
  },
});

// ── The read ─────────────────────────────────────────────────────────────────

/** Where one source stands in the record, so the page can say what it read and
 *  how old that is. */
type IntentSourceRow = {
  name: string;
  repo: string;
  commit: string | null;
  syncedAt: number | null;
  lines: number;
};

/**
 * Every line of his intent, from every place it is written, newest first.
 *
 * NEWEST FIRST AND UNDATED LAST. A line's date is when it was last said, not
 * when its file was last synced: an `AGENTS.md` rule and a line whose evidence
 * carries no readable date have no date at all, and sorting those to the end
 * keeps "what changed lately" at the top, which is what the page is for.
 */
export const lines = query({
  args: {},
  handler: async (ctx): Promise<{
    lines: IntentLine[];
    sources: IntentSourceRow[];
    capped: boolean;
  }> => {
    await requireTom(ctx, SURFACE);
    const out: IntentLine[] = [];
    const sources: IntentSourceRow[] = [];

    const bodyOf = new Map<string, { repo: string; body: string; commit: string | null; syncedAt: number | null }>();
    for (const page of MODEL_OF_TOM_PAGES) {
      const row = await ctx.db.query("modelOfTomFiles")
        .withIndex("by_name", (q) => q.eq("name", page.name)).unique();
      if (row === null) continue;
      bodyOf.set(row.sourcePath, {
        repo: "WikiTom",
        body: row.body,
        commit: row.commit ?? null,
        syncedAt: row.syncedAt,
      });
    }
    for (const row of await ctx.db.query("intentSources").collect()) {
      bodyOf.set(row.path, { repo: row.repo, body: row.body, commit: row.commit, syncedAt: row.syncedAt });
    }

    const record = (name: string, repo: string, commit: string | null, syncedAt: number | null, parsed: IntentLine[]) => {
      out.push(...parsed);
      sources.push({ name, repo, commit, syncedAt, lines: parsed.length });
    };

    for (const page of MODEL_OF_TOM_PAGES) {
      const file = bodyOf.get(page.path);
      if (file === undefined) continue;
      const evidencePath = page.path.replace("model-of-tom/", "model-of-tom/evidence/");
      record(page.path, file.repo, file.commit, file.syncedAt, parseModelOfTomPage({
        path: page.path,
        body: file.body,
        // A page whose evidence file has not been posted still renders; every
        // one of its lines then reads as unattributed, which is true of what
        // the record holds rather than true of the line.
        evidence: bodyOf.get(evidencePath)?.body ?? "",
        kind: page.kind,
      }));
    }

    const steering = bodyOf.get("vqc/steering.yaml");
    if (steering !== undefined) {
      record("vqc/steering.yaml", steering.repo, steering.commit, steering.syncedAt,
        parseSteering({ path: "vqc/steering.yaml", body: steering.body }));
    }
    const spec = bodyOf.get("tts/spec.md");
    if (spec !== undefined) {
      record("tts/spec.md", spec.repo, spec.commit, spec.syncedAt,
        parseSpecRevisions({ path: "tts/spec.md", body: spec.body }));
    }
    const adoption = bodyOf.get("vqc/adoption.md");
    if (adoption !== undefined) {
      record("vqc/adoption.md", adoption.repo, adoption.commit, adoption.syncedAt,
        parseAdoptionRulings({ path: "vqc/adoption.md", body: adoption.body }));
    }

    for (const row of await ctx.db.query("repoRules").collect()) {
      record(`${row.repo} ${row.path}`, row.repo, row.commit, row.syncedAt,
        parseRepoRules({ repo: row.repo, path: row.path, body: row.body }));
    }

    // HIS RULINGS. The line is the sentence he gave; a ruling recorded from a
    // button carries none, and its verdict is then the whole of what he said.
    const rulings = await ctx.db.query("dtsRulings")
      .withIndex("by_ruled").order("desc").take(RULINGS_MAX + 1);
    const rulingsCapped = rulings.length > RULINGS_MAX;
    const ruled: IntentLine[] = rulings.slice(0, RULINGS_MAX).map((row) => ({
      id: `dtsRulings/${row._id}`,
      kind: "ruling" as const,
      text: row.sentence ?? row.verdict,
      section: row.subjectType,
      voice: "his" as const,
      source: "dtsRulings",
      locator: row._id,
      at: row.ruledAt,
      dateText: null,
      // The quote is the provenance of a ruling written from his own words in a
      // session turn: the one sentence of his the agent read as the ruling.
      evidence: row.provenance === undefined
        ? []
        : [{ form: "quote", text: row.provenance.quote, date: null }],
    }));
    record("dtsRulings", "record", null, rulings[0]?.ruledAt ?? null, ruled);

    // HIS LABELS. `meaning` is an agent's present-tense wording of what he did
    // about a run's output; the act itself — the ruling, the objection, the
    // reply, the reaction — is his, and the writer refuses any actor but him.
    let labelsCapped = false;
    const labelled: IntentLine[] = [];
    for (const source of LABEL_SOURCES) {
      const rows = await ctx.db.query("runLabels")
        .withIndex("by_source_at", (q) => q.eq("source", source))
        .order("desc").take(LABELS_MAX + 1);
      if (rows.length > LABELS_MAX) labelsCapped = true;
      for (const row of rows.slice(0, LABELS_MAX)) {
        labelled.push({
          id: `runLabels/${row._id}`,
          kind: "label",
          text: row.meaning,
          section: row.polarity,
          voice: "his",
          source: "runLabels",
          locator: row.runId,
          at: row.at,
          dateText: null,
          evidence: [{ form: source, text: row.ref, date: null }],
        });
      }
    }
    record("runLabels", "record", null, labelled[0]?.at ?? null, labelled);

    out.sort((left, right) => {
      if (left.at === right.at) return left.id.localeCompare(right.id);
      if (left.at === null) return 1;
      if (right.at === null) return -1;
      return right.at - left.at;
    });
    sources.sort((left, right) => left.name.localeCompare(right.name));
    return { lines: out, sources, capped: rulingsCapped || labelsCapped };
  },
});
