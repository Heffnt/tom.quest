// design.ts — tom.quest/design's reads.
//
// THE PAGE DRAWS THE REGISTRY THE BOX DEPLOYED. The registry is Jarvis
// worker/parts.json, one row per part; the box's deploy job posts it as one
// `registry` event per deployed commit (shared/jarvis-events.mjs), and the
// newest such row is the running system. Nothing here stores a copy: every
// answer is computed from rows on each read.
//
//   page   the newest registry, each part's use state (partStates.ts) and the
//          counts the page's strip shows.
//   part   one part's panel: its row, the sentences its `serves` entries name
//          (read from the model-of-tom files the record holds), its state and
//          the row behind it, and Tom's sentences in scope part:<id>, every
//          read under one byte budget.
//   diff   what a Jarvis head does to the registry: the `registryDiff` the
//          box posts on the head's tests row, and the base registry it
//          applies to.
//
// A STORED REGISTRY ROW IS A CHECKED ONE: POST /jarvis/event, the one route
// that writes the type, runs shared/jarvis-events.mjs validateEvent on it,
// and POST /tts/event refuses it (JARVIS_EVENT_ONLY_KINDS).
//
// THE GATE IS requireTom, label "Design".

import { v } from "convex/values";
import { query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { requireTom } from "../authRoles";
import { commitKey } from "../ttsShared";
import { TESTS_RUN } from "../ttsMerge";
import { headings } from "../../shared/markdown-sections.mjs";
import { registryDiffOf } from "../../shared/jarvis-events.mjs";
import { removedStillRun, servesOnlyOutcomes } from "../../shared/parts-drawing.mjs";
import { getWithin, MIB, ReadBudget, readWithin } from "../readBudget";
import type { ReadCut } from "../readBudget";
import { IN_USE_DAYS, readPartStates, WORKING_AFTER_DAYS } from "./partStates";

const SURFACE = "Design";
const REGISTRY = "registry";
/** A part's state whose reads were cut by the byte budget. */
const PARTIAL = "partial";
/**
 * THE PANEL'S READS SHARE ONE BYTE BUDGET (convex/readBudget.ts), the size of
 * the digest's gather (convex/ttsDigest.ts GATHER_BYTES): a row count does
 * not bound the bytes a run or an event row holds. Each read has a named
 * allotment within it and reads one row at a time, so the query stays under
 * Convex's 16 MiB read limit; a read the budget stopped is a cut, answered
 * with the panel and shown on it, and the measure it fed is marked partial.
 */
const PANEL_BYTES = 11 * MIB;
const ALLOT = {
  registry: { what: "registry rows", bytes: MIB },
  states: { what: "rows behind the use state", bytes: 3 * MIB },
  stateRow: { what: "the row behind the state", bytes: MIB },
  serves: { what: "model-of-tom files", bytes: 2 * MIB },
  rulings: { what: "rulings in the part's scope", bytes: MIB },
} as const;
const ALL = Number.POSITIVE_INFINITY;

/** One registry row, in the fields this module and the page read. */
export type RegistryRow = {
  id: string;
  name: string;
  type: string;
  file: string | null;
  starts: string[];
  reads: string[];
  writes: string[];
  refuses: string[];
  routes: string[];
  schedule: string | null;
  fate: { type: string; by: string | null };
  serves: Record<string, unknown>[];
  designed_by: string;
  note?: string;
  place?: Record<string, unknown>;
};

type RegistryData = { repo: string; sha: string; parts: RegistryRow[]; count: number };

async function newestRegistry(ctx: QueryCtx): Promise<Doc<"events"> | null> {
  return await ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", REGISTRY)).order("desc").first();
}

const registryOf = (row: Doc<"events">) => {
  const data = row.data as RegistryData;
  return { id: row._id, subject: row.subject ?? "", sha: data.sha, at: row.at, parts: data.parts };
};

/** The part refs partStates maps rows by. The record holds no list of the
 *  files a pull request changed (the pullRequests mirror has none), so no
 *  landing is passed and a state is read from its rows alone. */
const refOf = (row: RegistryRow) => ({ id: row.id, schedule: row.schedule ?? null, file: row.file ?? null });

export const page = query({
  args: {},
  handler: async (ctx) => {
    await requireTom(ctx, SURFACE);
    const row = await newestRegistry(ctx);
    if (row === null) return { registry: null };
    const registry = registryOf(row);
    const answered = await readPartStates(ctx, registry.parts.map(refOf), [], Date.now());
    // A state whose reads stopped at partStates' byte budget is not
    // definitive: it is "partial", drawn with no use fill and counted as
    // partial, never as unverified or issue.
    const states: Record<string, string> = Object.fromEntries(answered.map((s) => [s.part, s.capped ? PARTIAL : s.state]));
    const parts = registry.parts;
    return {
      registry,
      states,
      counts: {
        parts: parts.length,
        unverified: Object.values(states).filter((state) => state === "unverified").length,
        issue: Object.values(states).filter((state) => state === "issue").length,
        partial: Object.values(states).filter((state) => state === PARTIAL).length,
        removedStillRun: parts.filter(removedStillRun).length,
        noSentence: parts.filter(servesOnlyOutcomes).length,
      },
    };
  },
});

// ── One part's sentences ────────────────────────────────────────────────────

type Said = { date: string; source: string; sentence: string };

/** One serves item, resolved against the model-of-tom files the record holds. */
export type Serves =
  | { form: "evidence"; ref: string; file: string; line: string | null; said: Said[] }
  | { form: "guarantee"; label: string; line: string | null }
  | { form: "outcomes"; outcomes: string[] };

const EVIDENCE_DIR = "model-of-tom/evidence/";

/** A `said:` line: `<date> · <source> · "<sentence>"`. */
function saidOf(text: string): Said | null {
  const parts = text.split(" · ");
  if (parts.length < 3) return null;
  const quoted = parts.slice(2).join(" · ").trim();
  return { date: parts[0].trim(), source: parts[1].trim(), sentence: quoted.replace(/^"/, "").replace(/"$/, "") };
}

/**
 * The entry of an evidence file a serves reference names, "<file>#<heading>#
 * <the first eight words of the entry's line, or its line number>", the way
 * Jarvis scripts/check-parts.mjs resolves it: its line and its said entries.
 * A heading may itself hold a "#", so each heading of the file is tried.
 */
export function evidenceEntry(body: string, rest: string): { line: string; said: Said[] } | null {
  const lines = body.split("\n");
  const headingAt = new Map<number, string>(
    (headings(lines) as { index: number; level: number; text: string }[]).filter((h) => h.level >= 2).map((h) => [h.index, h.text]),
  );
  let heading: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    heading = headingAt.get(i) ?? heading;
    const entry = /^- line:\s*(.*)$/.exec(lines[i]);
    if (entry === null || heading === null || !rest.startsWith(`${heading}#`)) continue;
    const key = rest.slice(heading.length + 1);
    const words = entry[1].trim().split(/\s+/).slice(0, 8).join(" ");
    if (/^\d+$/.test(key) ? Number(key) !== i + 1 : key !== words) continue;
    const said: Said[] = [];
    for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) {
      const m = /^\s+said:\s*(.*)$/.exec(lines[j]);
      const parsed = m === null ? null : saidOf(m[1]);
      if (parsed !== null) said.push(parsed);
    }
    return { line: entry[1].trim(), said };
  }
  return null;
}

async function servesOf(ctx: QueryCtx, serves: Record<string, unknown>[], budget: ReadBudget): Promise<Serves[]> {
  const files = budget.allot(ALLOT.serves.what, ALLOT.serves.bytes);
  const bodies = new Map<string, string | null>();
  const bodyOf = async (path: string) => {
    if (!bodies.has(path)) {
      const row = await getWithin(files, () => ctx.db.query("intentSources").withIndex("by_path", (q) => q.eq("path", path)).first());
      bodies.set(path, row?.body ?? null);
    }
    return bodies.get(path) ?? null;
  };
  const out: Serves[] = [];
  for (const item of serves) {
    if (typeof item.evidence === "string") {
      const ref = item.evidence;
      const cut = ref.indexOf("#");
      const file = cut < 0 ? ref : ref.slice(0, cut);
      const body = cut < 0 ? null : await bodyOf(`${EVIDENCE_DIR}${file}`);
      const found = body === null ? null : evidenceEntry(body, ref.slice(cut + 1));
      out.push({ form: "evidence", ref, file, line: found?.line ?? null, said: found?.said ?? [] });
    } else if (typeof item.guarantee === "string") {
      const rules = await getWithin(files, () => ctx.db.query("modelOfTomFiles").withIndex("by_name", (q) => q.eq("name", "agent-rules")).first());
      const label = item.guarantee;
      const line = rules === null || rules === undefined ? null : (new RegExp(`^- ${label} (.*)$`, "m").exec(rules.body)?.[1] ?? null);
      out.push({ form: "guarantee", label, line });
    } else if (Array.isArray(item.outcomes)) {
      out.push({ form: "outcomes", outcomes: item.outcomes.filter((o): o is string => typeof o === "string") });
    }
  }
  return out;
}

// ── One part ────────────────────────────────────────────────────────────────

/** One part's panel under `budget`; the query below passes PANEL_BYTES. */
async function readPart(ctx: QueryCtx, id: string, now: number, budget: ReadBudget) {
  const [newest] = await readWithin(
    budget.allot(ALLOT.registry.what, ALLOT.registry.bytes),
    ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", REGISTRY)).order("desc"),
    1,
  );
  if (newest === undefined) return null;
  const registry = registryOf(newest);
  const row = registry.parts.find((p) => p.id === id);
  if (row === undefined) return null;
  const names = Object.fromEntries(registry.parts.map((p) => [p.id, p.name]));

  const [answered] = await readPartStates(ctx, [refOf(row)], [], now, budget.allot(ALLOT.states.what, ALLOT.states.bytes));
  // A landing the record holds no row for is answered as "<repo>#<pull
  // request>", which names no row.
  const behindId = answered.row === null ? null : ctx.db.normalizeId("events", answered.row.id);
  const behind = behindId === null ? null : await getWithin(budget.allot(ALLOT.stateRow.what, ALLOT.stateRow.bytes), () => ctx.db.get(behindId));
  const state = {
    state: answered.state,
    // The state's reads stopped at the budget: the word is not definitive.
    partial: answered.capped,
    row: answered.row === null ? null : { ...answered.row, agentId: behind?.provenance?.agentId ?? null },
    inUseDays: IN_USE_DAYS,
    workingAfterDays: WORKING_AFTER_DAYS,
  };

  const scope = `part:${id}`;
  const rulingRows = await readWithin(
    budget.allot(ALLOT.rulings.what, ALLOT.rulings.bytes),
    ctx.db
      .query("events")
      .withIndex("by_kind_subject_at", (q) => q.eq("kind", "ruling").eq("subject", scope))
      .order("desc"),
    ALL,
  );
  const rulings = rulingRows.map((r) => {
    const d = r.data as { sentence: string; standing: boolean; supersededAt?: number };
    return { id: r._id, at: r.at, sentence: d.sentence, standing: d.standing === true, supersededAt: d.supersededAt ?? null };
  });
  rulings.sort((a, b) => Number(b.standing) - Number(a.standing) || b.at - a.at);


  const serves = await servesOf(ctx, row.serves, budget);
  const cuts: ReadCut[] = budget.cuts().filter((cut) => cut.by === "bytes");
  return {
    registry: { subject: registry.subject, sha: registry.sha, at: registry.at },
    row,
    names,
    serves,
    state,
    rulings,
    cuts,
  };
}

export const part = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    await requireTom(ctx, SURFACE);
    return await readPart(ctx, id, Date.now(), ReadBudget.of(PANEL_BYTES));
  },
});

// ── The diff view ───────────────────────────────────────────────────────────

export const diff = query({
  args: { head: v.string() },
  handler: async (ctx, { head }) => {
    await requireTom(ctx, SURFACE);
    const at = head.indexOf("@");
    if (at <= 0) return null;
    const key = commitKey(head.slice(0, at), head.slice(at + 1));
    // The newest tests row that carries a registry diff. A commit holds at
    // most two tests rows (convex/ttsMerge.ts internalRecordTests: the box's
    // red row may follow a green one), and that red row carries no diff, so
    // the newest row alone would hide the diff of a head the box has failed.
    // Two rows by construction, so take(2) is the whole key.
    const tests = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) => q.eq("kind", TESTS_RUN).eq("key", key))
      .order("desc")
      .take(2);
    const registryDiff =
      tests
        .map((row) => registryDiffOf((row.data as { registryDiff?: unknown } | undefined)?.registryDiff))
        .find((diff) => diff !== null) ?? null;
    if (registryDiff === null) return null;
    const exact = await ctx.db
      .query("events")
      .withIndex("by_kind_subject_at", (q) => q.eq("kind", REGISTRY).eq("subject", `Jarvis@${registryDiff.base}`))
      .order("desc")
      .first();
    const base = exact ?? (await newestRegistry(ctx));
    return {
      head: key,
      registryDiff,
      base: base === null ? null : registryOf(base),
      baseIsExact: exact !== null,
    };
  },
});

