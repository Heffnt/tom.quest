// context.ts — GET /jarvis/context?for=<caller>: the one door a box job reads
// its context through.
//
// Each caller's payload was its own route under /tts/ (planner-context,
// capture-context, ask-context, learning-input, weekly-input, simplify-input;
// prelude-delivery, golden-input and label-input went with the evals request
// protocol, s6). They are one route now, one
// reader per caller in READERS below, each building the same bytes its old
// route built: the old routes in convex/http.ts call these readers, so the
// two spellings cannot drift while both stand. The /tts/ registrations go
// when the box's last caller spells this route.
//
// The reader names are the box's word for what it is doing (planner,
// capture, ask, learning, weekly, simplify);
// the context assembler's caller ids ("planner-context", "capture-context",
// "weekly-input", "simplify-input") are the assembler's own and stay as they
// are inside each reader.

import type { HttpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { nowContext } from "../tts";
import { SESSION_REPO_NAMES } from "../ttsShared";
import { jarvisAuth, jsonResponse } from "./auth";

/** A worker job needs the original missing-layer sentence, not a framework
 *  exception, so its nonzero exit names the deployment state to repair. */
function modelOfTomErrorResponse(error: unknown): Response {
  return jsonResponse(503, { error: error instanceof Error ? error.message : String(error) });
}

type Reader = (ctx: ActionCtx, params: URLSearchParams) => Promise<Response>;

/**
 * The planner's payload: all life todos (their graph fields, `needs` among
 * them, included), the code-todo mirror, the code briefs, Tom's recent
 * rulings, the writing standard, the vocabulary, the session repo names and
 * the server's clock. The writing standard rides along because the planner
 * is Node ESM on a box that never loads TypeScript and cannot read a WikiTom
 * checkout; Jarvis worker/jobs/plan-graphs.mjs treats a missing
 * `writingStandard` as fatal, so the field name and type do not change.
 */
export async function plannerContext(ctx: ActionCtx) {
  const [todos, mirror, briefs, recentRulings, writingStandard, vocabulary] = await Promise.all([
    ctx.runQuery(internal.tts.internalListTodos, {}),
    ctx.runQuery(internal.tts.internalListMirror, {}),
    ctx.runQuery(internal.ttsCode.internalListBriefs, {}),
    ctx.runQuery(internal.ttsRulings.internalRecentRulings, { limit: 200 }),
    ctx.runQuery(internal.ttsContext.internalContextPrelude, { caller: "planner-context" }),
    ctx.runQuery(internal.vocabulary.internalClosedVocabulary, {}),
  ]);
  return {
    todos,
    mirror,
    briefs,
    recentRulings,
    writingStandard,
    vocabulary,
    // Served for the same reason as writingStandard: the box cannot import
    // SESSION_REPOS, and serving the one home's value stops a hand-written
    // copy of the repo list appearing in worker/.
    sessionRepos: SESSION_REPO_NAMES,
    // The server's clock: the planner resolves "sept 3" against nyCalendarDay
    // and never computes a New York date of its own.
    ...nowContext(Date.now()),
  };
}

const nonempty = (value: string | null) => (value !== null && value.trim() !== "" ? value.trim() : undefined);

/** `until`, defaulting to now, as the window-ended readers take it. */
function untilOf(params: URLSearchParams): number {
  return params.has("until") ? Number(params.get("until")) : Date.now();
}

export const READERS: Record<string, Reader> = {
  planner: async (ctx) => {
    try {
      return jsonResponse(200, await plannerContext(ctx));
    } catch (error) {
      return modelOfTomErrorResponse(error);
    }
  },
  // The model-of-tom context a capture run works from, and the declined
  // integrations, before a poller captures anything.
  capture: async (ctx) => {
    let writingStandard: string;
    let declinedIntegrations;
    try {
      [writingStandard, declinedIntegrations] = await Promise.all([
        ctx.runQuery(internal.ttsContext.internalContextPrelude, { caller: "capture-context" }),
        ctx.runQuery(internal.ttsIntegrations.internalDeclinedIntegrations, {}),
      ]);
    } catch (error) {
      return modelOfTomErrorResponse(error);
    }
    return jsonResponse(200, { writingStandard, declinedIntegrations });
  },
  // What the delegate's caller sees before it asks: asks spent in the last
  // day, its cap, and every objection Tom already made about this todo.
  ask: async (ctx, params) => {
    const sessionId = nonempty(params.get("sessionId"));
    const job = nonempty(params.get("job"));
    const runnerId = nonempty(params.get("runnerId"));
    if ([sessionId, job, runnerId].filter((one) => one !== undefined).length !== 1) {
      return jsonResponse(400, { error: "exactly one of sessionId, runnerId or job is required" });
    }
    const context = await ctx.runQuery(internal.ttsAsk.internalAskContext, {
      sessionId,
      job,
      runnerId,
      todoId: nonempty(params.get("todoId")),
    });
    return jsonResponse(200, context);
  },
  // The learning step's input: the window's turns, Slack replies, rulings,
  // and the objections not yet acted on. `since` omitted means where the
  // last learning run stopped (convex/ttsNightly.ts).
  learning: async (ctx, params) => {
    const sinceRaw = params.get("since");
    const untilRaw = params.get("until");
    const since = sinceRaw === null ? undefined : Number(sinceRaw);
    const until = untilRaw === null ? NaN : Number(untilRaw);
    if (!Number.isFinite(until) || (since !== undefined && (!Number.isFinite(since) || since >= until))) {
      return jsonResponse(400, { error: "until (epoch ms) required; since, if given, before it" });
    }
    return jsonResponse(200, await ctx.runQuery(internal.ttsNightly.internalLearningInput, { since, until }));
  },
  // The Friday job's deterministic gather of the seven days ending at `until`.
  weekly: async (ctx, params) => {
    const until = untilOf(params);
    if (!Number.isFinite(until) || until <= 0) {
      return jsonResponse(400, { error: "until must be an epoch ms instant" });
    }
    let facts;
    let writingStandard: string;
    try {
      [facts, writingStandard] = await Promise.all([
        ctx.runQuery(internal.ttsWeekly.internalWeeklyInput, { until }),
        ctx.runQuery(internal.ttsContext.internalContextPrelude, { caller: "weekly-input" }),
      ]);
    } catch (error) {
      return modelOfTomErrorResponse(error);
    }
    return jsonResponse(200, { ...facts, writingStandard });
  },
  // The simplification pass's gather of the four weeks ending at `until`. It
  // asks as its own caller, "simplify-input", so its door cannot change
  // silently on the day the weekly job's does.
  simplify: async (ctx, params) => {
    const until = untilOf(params);
    if (!Number.isFinite(until) || until <= 0) {
      return jsonResponse(400, { error: "until must be an epoch ms instant" });
    }
    let facts;
    let writingStandard: string;
    try {
      [facts, writingStandard] = await Promise.all([
        ctx.runQuery(internal.ttsSimplify.internalSimplifyInput, { until }),
        ctx.runQuery(internal.ttsContext.internalContextPrelude, { caller: "simplify-input" }),
      ]);
    } catch (error) {
      return modelOfTomErrorResponse(error);
    }
    return jsonResponse(200, { ...facts, writingStandard });
  },
};

export const CONTEXT_FOR = Object.keys(READERS);

/** One reader's answer for a request already past auth: the old /tts/ routes
 *  call this so both spellings serve the same bytes. */
export async function serveContext(ctx: ActionCtx, name: string, request: Request): Promise<Response> {
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
