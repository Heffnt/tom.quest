// rulings.ts — POST /jarvis/ruling: a ruling from Tom's own words (ruling 15,
// 2026-09-05), the door the rulings table keeps apart from POST /jarvis/event
// because what makes a write here legitimate is not the box's key but the turn
// it cites: only a turn Tom typed backs a ruling.
//
// Body: { inboundId, verdict, subjectType, subjectId, quote, sentence? }: the
// claudeInbound row Tom typed, one of the four verdicts, "life" | "code", the
// subject's id (a code subject is "<repo> <externalId>"), one whole sentence
// of Tom's turn verbatim (provenance only), and, on revise alone, the
// ruling's own sentence, the redirect, which is another (or the same) whole
// sentence of that turn. The checks that make it Tom's pen and not the
// agent's (the row is Tom-authored, the quote and the redirect are whole
// sentences of it, the subject exists and is what the turn's session was
// about, the row has not ruled on this subject before) live in
// ttsRulings.internalRecordRulingFromTomWords; each refusal comes back as a
// 400 with its reason.
//
// A claudeInbound row carries `author`; that is the proof. A claudeMessages
// row (a laptop or desktop session's turn, read from its agent file) carries
// none: a turn Tom typed, a task notification and an agent's brief to a
// launched run are all stored as kind "user" with the same fields, so the row
// cannot show who wrote it, and this door refuses one by name rather than as
// an unknown id.
//
// STANDING RULINGS (Tom, 2026-10-04: "I dont want to have to say yes multiple
// times. if I say it is good once then that holds as long as there is not new
// information that would probably change my ruling if I understood it.").
// A standing ruling is an event of kind `ruling` (shared/jarvis-events.mjs),
// not a row of the rulings table: that table takes one of four verdicts on
// one todo or code subject, and his rulings are open text with a scope.
//
// POST /jarvis/standing-ruling. Body { sentence, scope, question,
// provenance: { threadMessageId } | { session } }. The sentence is his,
// verbatim; with a threadMessageId it must occur in that thread-message row's
// text, which only Tom writes. A session's turns carry no author in the
// record (above), so a ruling citing a session rests on the poster's word.
// Answers { ok: true, id, duplicate }: the same sentence posted again with
// the same scope and provenance is a retry, answered with the first row's id
// and duplicate true, and writes no second row.
//
// POST /jarvis/standing-ruling/new-information. Body { rulingId, type, id }:
// type "sentence" (id: a later ruling row of his in the same scope),
// "diagnosis" (id: a diagnosis row whose subject is the ruling's scope) or
// "measure" (id: a quality-check row whose subject is the ruling's scope, a
// measure that crossed his target). A ruling scoped "all" takes a diagnosis
// or measure row of any subject. The ruling's data gets standing false and
// supersededBy the id, and the next digest lists it. Answers { ok: true,
// rulingId, supersededBy, listed }; the same post again answers the same
// with duplicate: true.
//
// The asker's read is standingRulings below, served on GET
// /jarvis/context?for=ask&scope=<scope> (convex/ttsAsk.ts).

import { v } from "convex/values";
import { httpAction, internalMutation } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { isRulingVerdict } from "../ttsRulings";
import { nyCalendarDayKey } from "../ttsShared";
import { MIB, ReadBudget, readWithin } from "../readBudget";
import { sha256Hex } from "../ttsSignoff";
import { jarvisAuth, jsonResponse } from "./auth";
import { listForDigest } from "./outbox";
import { insertEvent } from "./record";

export const postRuling = httpAction(async (ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.inboundId !== "string" || b.inboundId === "") {
    return jsonResponse(400, { error: "inboundId (non-empty string) required" });
  }
  if (!isRulingVerdict(b.verdict)) {
    return jsonResponse(400, {
      error: "verdict must be one of approve, revise, session, archive",
    });
  }
  if (b.subjectType !== "life" && b.subjectType !== "code") {
    return jsonResponse(400, {
      error: "subjectType must be one of life, code",
    });
  }
  if (typeof b.subjectId !== "string" || b.subjectId === "") {
    return jsonResponse(400, { error: "subjectId (non-empty string) required" });
  }
  if (typeof b.quote !== "string" || b.quote.trim() === "") {
    return jsonResponse(400, { error: "quote (non-empty string) required" });
  }
  if (b.sentence !== undefined && typeof b.sentence !== "string") {
    return jsonResponse(400, { error: "sentence must be a string when given" });
  }
  try {
    const id = await ctx.runMutation(
      internal.ttsRulings.internalRecordRulingFromTomWords,
      {
        inboundId: b.inboundId,
        verdict: b.verdict,
        subjectType: b.subjectType,
        subjectId: b.subjectId,
        quote: b.quote,
        sentence: b.sentence,
      },
    );
    return jsonResponse(200, { ok: true, id });
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

const RULING = "ruling";

/** The new information that ends a standing ruling, by the type the poster
 *  names, and the kind of the row that must carry it. "diagnosis" and
 *  "quality-check" join EVENT_KINDS with the rows that write them; until
 *  then only a later sentence can be recorded. */
const NEW_INFORMATION = {
  sentence: "ruling",
  diagnosis: "diagnosis",
  measure: "quality-check",
} as const;
type NewInformationType = keyof typeof NEW_INFORMATION;

/** The bytes of ruling rows one ask may read, across its scopes. A read of
 *  standing rows only, by bytes and not by a row count (convex/readBudget.ts),
 *  so ended rulings cannot crowd a standing one out of the answer. */
const STANDING_BYTES = 4 * MIB;

type StandingRuling = {
  id: string;
  at: number;
  scope: string;
  sentence: string;
  question: string;
  provenance: { threadMessageId?: string; session?: string };
};

type RulingData = {
  sentence: string;
  scope: string;
  question: string;
  provenance: { threadMessageId?: string; session?: string };
  standing: boolean;
  supersededBy?: string;
};

const rulingData = (row: Doc<"events">) => (row.data ?? {}) as RulingData;

/**
 * The rulings that stand in the given scopes and in "all", newest first: what
 * an asker reads before it asks. The index holds data.standing, so a
 * superseded ruling (standing false) is never read. `complete` is false when
 * the byte budget stopped a read with rows possibly left.
 */
export async function standingRulings(
  ctx: QueryCtx,
  scopes: readonly string[],
): Promise<{ rulings: StandingRuling[]; complete: boolean }> {
  const wanted = [...new Set([...scopes, "all"])];
  const budget = ReadBudget.of(STANDING_BYTES);
  const rows: Doc<"events">[] = [];
  // One scope after another, never in parallel: reads under one budget run
  // in turn (convex/readBudget.ts).
  for (const scope of wanted) {
    rows.push(
      ...(await readWithin(
        budget.allot(`standing rulings in ${scope}`, STANDING_BYTES),
        ctx.db
          .query("events")
          .withIndex("by_kind_subject_standing_at", (q) =>
            q.eq("kind", RULING).eq("subject", scope).eq("data.standing", true),
          )
          .order("desc"),
        Number.POSITIVE_INFINITY,
      )),
    );
  }
  const rulings = rows
    .sort((a, b) => b.at - a.at)
    .map((row) => {
      const d = rulingData(row);
      return { id: row._id, at: row.at, scope: d.scope, sentence: d.sentence, question: d.question, provenance: d.provenance };
    });
  return { rulings, complete: budget.cuts().length === 0 };
}

/** Write one standing ruling, after checking the sentence against the thread
 *  message it cites. */
export const recordStanding = internalMutation({
  args: {
    sentence: v.string(),
    scope: v.string(),
    question: v.string(),
    provenance: v.union(v.object({ threadMessageId: v.string() }), v.object({ session: v.string() })),
  },
  handler: async (ctx, args): Promise<{ id: Id<"events">; duplicate: boolean }> => {
    // His words exactly as posted: not trimmed or normalised, so what is
    // checked against the thread message, hashed and stored are the same
    // bytes, and a space the message does not hold is refused.
    const sentence = args.sentence;
    if (sentence.trim() === "") throw new Error("sentence (non-empty string) required");
    if ("threadMessageId" in args.provenance) {
      const id = ctx.db.normalizeId("events", args.provenance.threadMessageId);
      const message = id === null ? null : await ctx.db.get(id);
      if (message === null || message.kind !== "thread-message") {
        throw new Error(`no thread message ${args.provenance.threadMessageId} in the record`);
      }
      if (!(message.text ?? "").includes(sentence)) {
        throw new Error("the sentence does not occur verbatim in the thread message it cites");
      }
    }
    // A RETRY IS NOT A SECOND RULING. A worker that lost the answer to a
    // write posts it again; a second row would stay standing after the first
    // is superseded. The key is where he said it, the scope and the
    // sentence's bytes, so the retry finds the first row (standing or not)
    // on events.by_kind_data_id and is answered with its id. The parts are
    // JSON-encoded as one array before hashing: a session id and a scope may
    // each hold a colon, and joined by one they could spell another ruling's
    // key ("a" with "part:all" and "a:part" with "all").
    const source = "threadMessageId" in args.provenance
      ? ["thread", args.provenance.threadMessageId]
      : ["session", args.provenance.session];
    const key = `ruling:${await sha256Hex(JSON.stringify([...source, args.scope, sentence]))}`;
    const earlier = await ctx.db
      .query("events")
      .withIndex("by_kind_data_id", (q) => q.eq("kind", RULING).eq("data.id", key))
      .first();
    if (earlier !== null) return { id: earlier._id, duplicate: true };
    const id = await insertEvent(ctx, {
      kind: RULING,
      subject: args.scope,
      provenance: "session" in args.provenance ? { session: args.provenance.session } : {},
      data: { id: key, sentence, scope: args.scope, question: args.question.trim(), provenance: args.provenance, standing: true },
      text: sentence,
    });
    return { id, duplicate: false };
  },
});

/** The digest's sentence for a ruling that no longer stands. */
function supersededStatement(ruling: Doc<"events">, type: NewInformationType, by: Doc<"events">): string {
  const d = rulingData(ruling);
  const because =
    type === "sentence"
      ? `a later sentence of yours in the same scope replaced it: "${(by.data as RulingData).sentence}"`
      : type === "diagnosis"
        ? `a diagnosis named a defect in this scope (${by._id})`
        : `a measure you set a target on crossed it (${by._id})`;
  // The reason comes before his old sentence: a digest line is cut at a
  // clause boundary (convex/ttsCompose.ts statement), and the reason is what
  // the line exists to say.
  return `Your ruling of ${nyCalendarDayKey(ruling.at)} in scope ${d.scope} no longer stands, because ${because}; it said "${d.sentence}".`;
}

/** Record new information against one standing ruling: it stops standing,
 *  names the row that ended it, and goes on the next digest. */
async function supersede(
  ctx: MutationCtx,
  { rulingId, type, id }: { rulingId: string; type: NewInformationType; id: string },
): Promise<{ rulingId: string; supersededBy: string; listed: boolean; duplicate?: true }> {
  const rulingKey = ctx.db.normalizeId("events", rulingId);
  const ruling = rulingKey === null ? null : await ctx.db.get(rulingKey);
  if (ruling === null || ruling.kind !== RULING) throw new Error(`no ruling ${rulingId} in the record`);
  const byKey = ctx.db.normalizeId("events", id);
  const by = byKey === null ? null : await ctx.db.get(byKey);
  if (by === null || by.kind !== NEW_INFORMATION[type]) {
    throw new Error(`a ${type} is recorded by a ${NEW_INFORMATION[type]} row; ${id} is not one`);
  }
  const d = rulingData(ruling);
  if (d.supersededBy === by._id) return { rulingId: ruling._id, supersededBy: by._id, listed: false, duplicate: true };
  if (d.standing !== true || d.supersededBy !== undefined) {
    throw new Error(`ruling ${rulingId} no longer stands; it was superseded by ${d.supersededBy ?? "an earlier row"}`);
  }
  if (type === "sentence") {
    const later = rulingData(by);
    if (by._id === ruling._id || later.scope !== d.scope || by.at < ruling.at || later.standing !== true) {
      throw new Error("a later sentence is a standing ruling in the same scope, written after the one it replaces");
    }
  } else if (d.scope !== "all" && by.subject !== d.scope) {
    throw new Error(`a ${type} row in scope ${d.scope} names it as its subject`);
  }
  await ctx.db.patch(ruling._id, { data: { ...d, standing: false, supersededBy: by._id } });
  const { listed } = await listForDigest(ctx, {
    section: "superseded",
    rulingId: ruling._id,
    statement: supersededStatement(ruling, type, by),
  });
  return { rulingId: ruling._id, supersededBy: by._id, listed };
}

export const recordNewInformation = internalMutation({
  args: {
    rulingId: v.string(),
    type: v.union(v.literal("sentence"), v.literal("diagnosis"), v.literal("measure")),
    id: v.string(),
  },
  handler: async (ctx, args) => await supersede(ctx, args),
});

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

export const postStandingRuling = httpAction(async (ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  const b = await jsonBody(request);
  if (b === null) return jsonResponse(400, { error: "invalid JSON body" });
  if (!nonEmpty(b.sentence)) return jsonResponse(400, { error: "sentence (non-empty string) required" });
  if (!nonEmpty(b.scope)) return jsonResponse(400, { error: "scope (non-empty string) required" });
  if (!nonEmpty(b.question)) return jsonResponse(400, { error: "question (non-empty string) required" });
  const from = (b.provenance ?? {}) as Record<string, unknown>;
  const keys = Object.keys(from);
  const provenance =
    keys.length === 1 && keys[0] === "threadMessageId" && nonEmpty(from.threadMessageId)
      ? { threadMessageId: from.threadMessageId }
      : keys.length === 1 && keys[0] === "session" && nonEmpty(from.session)
        ? { session: from.session }
        : null;
  if (provenance === null) {
    return jsonResponse(400, { error: "provenance is { threadMessageId } or { session }, one non-empty string" });
  }
  try {
    const { id, duplicate } = await ctx.runMutation(internal.jarvis.rulings.recordStanding, {
      sentence: b.sentence,
      scope: b.scope,
      question: b.question,
      provenance,
    });
    return jsonResponse(200, { ok: true, id, duplicate });
  } catch (e) {
    return jsonResponse(400, { error: e instanceof Error ? e.message : String(e) });
  }
});

export const postNewInformation = httpAction(async (ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  const b = await jsonBody(request);
  if (b === null) return jsonResponse(400, { error: "invalid JSON body" });
  if (!nonEmpty(b.rulingId)) return jsonResponse(400, { error: "rulingId (non-empty string) required" });
  if (!nonEmpty(b.id)) return jsonResponse(400, { error: "id (non-empty string) required" });
  if (b.type !== "sentence" && b.type !== "diagnosis" && b.type !== "measure") {
    return jsonResponse(400, { error: "type must be one of sentence, diagnosis, measure" });
  }
  try {
    const result = await ctx.runMutation(internal.jarvis.rulings.recordNewInformation, {
      rulingId: b.rulingId,
      type: b.type,
      id: b.id,
    });
    return jsonResponse(200, { ok: true, ...result });
  } catch (e) {
    return jsonResponse(400, { error: e instanceof Error ? e.message : String(e) });
  }
});
