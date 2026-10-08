// context.ts — GET /jarvis/context?for=<caller>: the one door a box job reads
// its context through.
//
// Two readers remain, both the delegate's (Jarvis worker/jobs/delegate.mjs):
// "planner", the view it decides from, and "ask", its cap and Tom's standing
// rulings. The planner, the work queue, the nightly learning and the
// simplification pass that read the others are removed.

import type { HttpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { jarvisAuth, jsonResponse } from "./auth";
import { isRulingScope } from "../../shared/jarvis-events.mjs";

/** A worker job needs the original missing-layer sentence, not a framework
 *  exception, so its nonzero exit names the deployment state to repair. */
function modelOfTomErrorResponse(error: unknown): Response {
  return jsonResponse(503, { error: error instanceof Error ? error.message : String(error) });
}

type Reader = (ctx: ActionCtx, params: URLSearchParams) => Promise<Response>;

const nonempty = (value: string | null) => (value !== null && value.trim() !== "" ? value.trim() : undefined);

const READERS: Record<string, Reader> = {
  // The delegate's view: the writing standard (the model-of-tom prefix every
  // planning agent was given), which it treats as required, and the life
  // todos, to find the one a question names. Named "planner" because the
  // planner first read it and the deployed delegate asks for it by that name;
  // the rest of the planner's payload went with the planner.
  planner: async (ctx) => {
    try {
      const [todos, writingStandard] = await Promise.all([
        ctx.runQuery(internal.tts.internalListTodos, {}),
        ctx.runQuery(internal.ttsContext.internalContextPrelude, {}),
      ]);
      return jsonResponse(200, { todos, writingStandard });
    } catch (error) {
      return modelOfTomErrorResponse(error);
    }
  },
  // The delegate still reads its cap, objections, standing rulings, and Tom's
  // latest-turn timestamp through this reader. POST /tts/ask remains the
  // decision pen.
  ask: async (ctx, params) => {
    const sessionId = nonempty(params.get("sessionId"));
    const job = nonempty(params.get("job"));
    if ((sessionId === undefined) === (job === undefined)) {
      return jsonResponse(400, { error: "exactly one of sessionId or job is required" });
    }
    const scopes = params.getAll("scope");
    const bad = scopes.find((scope) => !isRulingScope(scope));
    if (bad !== undefined) {
      return jsonResponse(400, { error: `scope "${bad}" is not all, part:<id>, class:<name> or repo:<repository>` });
    }
    const context = await ctx.runQuery(internal.ttsAsk.internalAskContext, {
      sessionId,
      job,
      todoId: nonempty(params.get("todoId")),
      scopes,
    });
    return jsonResponse(200, context);
  },
};

const CONTEXT_FOR = Object.keys(READERS);

/** One reader's answer for a request already past auth. */
async function serveContext(ctx: ActionCtx, name: string, request: Request): Promise<Response> {
  const reader = READERS[name];
  if (reader === undefined) {
    return jsonResponse(400, { error: `for must be one of ${CONTEXT_FOR.join(", ")}` });
  }
  return await reader(ctx, new URL(request.url).searchParams);
}

export const getContext = httpAction(async (ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  const name = new URL(request.url).searchParams.get("for") ?? "";
  return await serveContext(ctx, name, request);
});

export function register(http: HttpRouter): void {
  http.route({ path: "/jarvis/context", method: "GET", handler: getContext });
}
