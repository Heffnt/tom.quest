import { internalQuery, query } from "./_generated/server";
import { requireTomOrAgent } from "./authRoles";

// TTS code-todo BRIEFS — ground-up briefs for open code todos (from the
// dtsCodeTodoMirror's repos). Their one writer was the planner's brief pass
// over ComplexMultiTrigger's vqc/todos.yaml, retired when CMT adoption ruling
// 70 moved CMT's todos into TTS; the 31 CMT rows here are records, and
// nothing writes a new brief (POST /tts/code-briefs went on 2026-09-26).
// Tom's rulings on them live in the unified ttsRulings table
// (ttsRulings.ts, ratified 2026-08-28), and worker jobs read pending rulings
// back from there to apply/execute them. Tom-facing functions are Tom-gated
// (tts.ts pattern).

// ── Tom-facing queries ───────────────────────────────────────────────────────

// Everything, always (spec §6): one brief per open code todo — the table stays
// small, so a full collect is fine and lets the client group/join freely.
export const listCodeBriefs = query({
  args: {},
  handler: async (ctx) => {
    await requireTomOrAgent(ctx, "TTS");
    return await ctx.db.query("dtsCodeBriefs").collect();
  },
});

// ── Internal: the worker's read (GET /tts/planner-context in http.ts) ─────────

export const internalListBriefs = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("dtsCodeBriefs").collect();
  },
});
