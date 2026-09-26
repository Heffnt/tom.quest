// intent.ts — what the /intent page reads from the record beside his lines,
// and the one write it makes.
//
// A DELEGATE DECISION is an event of kind `decision` (Jarvis `jarvis decide`
// posts it; its data names the question, the options, the decision, the
// reason, and `restedOn`: the lines, rulings and evidence entries it rested
// on, in the spellings the delegate's prompt asks for — `ruling:<id>`,
// `model-of-tom/<page>.md#<Heading>`, `model-of-tom/evidence/<page>.md:<heading>`).
// The page shows each decision beside the lines it rested on, as a
// disagreement candidate: a decision taken as he would have, until he says
// otherwise.
//
// AN EVAL RUN is an event of kind `eval-run` (Jarvis worker/jobs/evals.mjs):
// one set, its items each `{ name, pass, note }`. A rule item is named
// `rule/ruling-<last 8 of the ruling id>`, so it names a ruling line of the
// page; the page shows the pass rate beside that line and a failing item as a
// disagreement he settles.
//
// SETTLING is his act, recorded as an event of kind `disagreement-settled`
// with `provenance.user: "tom"` (the page is Tom-gated). When the decision
// was about a todo, the same act writes his ruling on that todo through
// insertRuling, the one implementation every ruling door calls, so the
// planner and the delegate read it where they read every ruling. A decision
// with no todo (a job's question) and an eval item have no ruling subject
// the rulings table takes tonight, so the event is the record of the
// settlement; the digest prints its text.

import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { requireTom } from "../authRoles";
import { insertRuling } from "../ttsRulings";
import { insertEvent } from "./record";

const SURFACE = "Intent";

/** The most decisions, settlements and eval runs one read takes. */
const DECISIONS_MAX = 200;
const SETTLED_MAX = 500;
const EVAL_RUNS_MAX = 60;

export type Decision = {
  id: string;
  at: number;
  askId: string;
  caller: string;
  question: string;
  options: string[];
  decision: string | null;
  reason: string | null;
  restedOn: string[];
  wouldChange: string | null;
  refused: boolean;
  refusedBecause: string | null;
  model: string | null;
  todoId: string | null;
  settled: Settlement | null;
};

type Settlement = {
  at: number;
  verdict: "approve" | "revise";
  sentence: string | null;
  rulingId: string | null;
};

export type EvalItem = {
  name: string;
  /** The newest eval-run that reported the item: what a settlement settles. */
  runId: string;
  set: string;
  pass: boolean | null;
  note: string;
  at: number;
  model: string | null;
  /** Over the runs read: how often this item passed, and how often it ran. */
  passed: number;
  runs: number;
  settled: Settlement | null;
};

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const strs = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : [];

/** The subject spelling a settlement carries, one per thing settled. */
const decisionSubject = (askId: string) => `decision:${askId}`;
/** An eval item's settlement names the run it settled, so the same item
 *  failing in a later run is open again. */
const evalSubject = (runId: string, itemName: string) => `eval:${runId}:${itemName}`;

async function settlements(ctx: QueryCtx): Promise<Map<string, Settlement>> {
  const rows = await ctx.db
    .query("events")
    .withIndex("by_kind_at", (q) => q.eq("kind", "disagreement-settled"))
    .order("desc")
    .take(SETTLED_MAX);
  const bySubject = new Map<string, Settlement>();
  for (const row of rows) {
    if (row.subject === undefined || bySubject.has(row.subject)) continue;
    const data = (row.data ?? {}) as { verdict?: unknown; sentence?: unknown; rulingId?: unknown };
    if (data.verdict !== "approve" && data.verdict !== "revise") continue;
    bySubject.set(row.subject, { at: row.at, verdict: data.verdict, sentence: str(data.sentence), rulingId: str(data.rulingId) });
  }
  return bySubject;
}

function decisionOf(row: Doc<"events">, settled: Map<string, Settlement>): Decision | null {
  const data = (row.data ?? {}) as Record<string, unknown>;
  // The askId is the row's subject: every writer files the decision under
  // it (Jarvis worker/jobs/delegate.mjs posts it as the key, which the record
  // stores as the subject), and settle and the objection resolver find it
  // there.
  const askId = row.subject ?? null;
  const question = str(data.question);
  if (askId === null || question === null) return null;
  return {
    id: row._id,
    at: row.at,
    askId,
    caller: str(data.caller) ?? "unknown",
    question,
    options: strs(data.options),
    decision: str(data.decision),
    reason: str(data.reason),
    restedOn: strs(data.restedOn),
    wouldChange: str(data.wouldChange),
    refused: data.refused === true,
    refusedBecause: str(data.refusedBecause),
    model: str(data.model),
    todoId: str(data.todoId),
    settled: settled.get(decisionSubject(askId)) ?? null,
  };
}

/** Every delegate decision in the record, newest first, with his settlement
 *  of it when he has made one. */
export const decisions = query({
  args: {},
  handler: async (ctx): Promise<Decision[]> => {
    await requireTom(ctx, SURFACE);
    const [rows, settled] = await Promise.all([
      ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "decision")).order("desc").take(DECISIONS_MAX),
      settlements(ctx),
    ]);
    return rows.map((row) => decisionOf(row, settled)).filter((one): one is Decision => one !== null);
  },
});

/**
 * The eval items as the newest run of each set reports them, with each
 * item's pass count over the runs read. One row per item name; a set that
 * ran more than once contributes every run to `passed`/`runs` and its newest
 * run's `pass`, `note`, `at` and `model`.
 */
export const evalItems = query({
  args: {},
  handler: async (ctx): Promise<EvalItem[]> => {
    await requireTom(ctx, SURFACE);
    const [runs, settled] = await Promise.all([
      ctx.db.query("events").withIndex("by_kind_at", (q) => q.eq("kind", "eval-run")).order("desc").take(EVAL_RUNS_MAX),
      settlements(ctx),
    ]);
    const items = new Map<string, EvalItem>();
    for (const run of runs) {
      const data = (run.data ?? {}) as { set?: unknown; model?: unknown; items?: unknown };
      // The set is the row's subject (Jarvis worker/jobs/evals.mjs posts it so).
      const set = run.subject;
      if (set === undefined || !Array.isArray(data.items)) continue;
      for (const raw of data.items) {
        const item = (raw ?? {}) as { name?: unknown; pass?: unknown; note?: unknown };
        const name = str(item.name);
        if (name === null) continue;
        const pass = item.pass === true ? true : item.pass === false ? false : null;
        const known = items.get(name);
        if (known === undefined) {
          items.set(name, {
            name,
            runId: run._id,
            set,
            pass,
            note: str(item.note) ?? "",
            at: run.at,
            model: str(data.model),
            passed: pass === true ? 1 : 0,
            runs: pass === null ? 0 : 1,
            settled: settled.get(evalSubject(run._id, name)) ?? null,
          });
        } else if (pass !== null) {
          known.passed += pass ? 1 : 0;
          known.runs += 1;
        }
      }
    }
    return [...items.values()];
  },
});

/**
 * His settlement of one disagreement: `approve` (the decision stands, or the
 * ruling the item tests stands) or `revise` with his sentence. Writes the
 * event; writes his ruling on the todo too when the decision names one.
 */
export const settle = mutation({
  args: {
    subject: v.string(),
    verdict: v.union(v.literal("approve"), v.literal("revise")),
    sentence: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTom(ctx, SURFACE);
    const sentence = args.sentence?.trim() ?? "";
    if (args.verdict === "revise" && sentence === "") throw new Error("revise needs his sentence");
    const askId = args.subject.startsWith("decision:") ? args.subject.slice("decision:".length) : null;
    // eval:<the eval-run's id>:<item name>. A Convex id holds no colon, so
    // the first one ends it.
    const evalRef = args.subject.startsWith("eval:") ? args.subject.slice("eval:".length) : null;
    const colon = evalRef === null ? -1 : evalRef.indexOf(":");
    const item = evalRef === null || colon <= 0 ? null : evalRef.slice(colon + 1);
    if ((askId === null || askId === "") && (item === null || item === "")) {
      throw new Error("subject is decision:<askId> or eval:<eval-run id>:<item name>");
    }
    if (item !== null && evalRef !== null) {
      const runId = ctx.db.normalizeId("events", evalRef.slice(0, colon));
      const run = runId === null ? null : await ctx.db.get(runId);
      const items = (run?.data as { items?: unknown } | undefined)?.items;
      if (run === null || run.kind !== "eval-run" || !Array.isArray(items) || !items.some((one) => (one as { name?: unknown } | null)?.name === item)) {
        throw new Error(`no eval run ${evalRef.slice(0, colon)} reporting ${item} in the record`);
      }
    }
    let rulingId: string | null = null;
    let line: string;
    if (askId !== null) {
      const decision = await ctx.db
        .query("events")
        .withIndex("by_subject_at", (q) => q.eq("subject", askId))
        .order("desc")
        .filter((q) => q.eq(q.field("kind"), "decision"))
        .first();
      if (decision === null) throw new Error(`no decision ${askId} in the record`);
      const data = (decision.data ?? {}) as { todoId?: unknown; decision?: unknown; refused?: unknown };
      // A refused or unanswered decision took nothing in his name: accepting it
      // would write an approve ruling that ratifies nothing he was shown.
      if (args.verdict === "approve" && (data.refused === true || typeof data.decision !== "string")) {
        throw new Error(`decision ${askId} was refused or not answered; there is nothing to accept`);
      }
      const todoId = typeof data.todoId === "string" ? ctx.db.normalizeId("dtsTodos", data.todoId) : null;
      if (todoId !== null) {
        rulingId = await insertRuling(ctx, { todoId, verdict: args.verdict, ...(sentence === "" ? {} : { sentence }) });
      }
      const taken = typeof data.decision === "string" ? data.decision : "(refused)";
      line = args.verdict === "approve"
        ? `Tom accepted the delegate's decision "${taken}" (${askId}).`
        : `Tom objected to the delegate's decision "${taken}" (${askId}): ${sentence}`;
    } else {
      line = args.verdict === "approve"
        ? `Tom let the ruling behind eval item ${item} stand.`
        : `Tom ruled on eval item ${item}: ${sentence}`;
    }
    const id = await insertEvent(ctx, {
      kind: "disagreement-settled",
      provenance: { user: "tom" },
      subject: args.subject,
      data: { subject: args.subject, verdict: args.verdict, sentence: sentence === "" ? null : sentence, rulingId },
      text: line,
    });
    return { id, rulingId };
  },
});
