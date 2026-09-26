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

import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { isRulingVerdict } from "../ttsRulings";
import { jarvisAuth, jsonResponse } from "./auth";

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
