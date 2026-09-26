// routes.ts — the box's routes into the record, under /jarvis/.
//
// POST /jarvis/event: the one write door for every kind of event. Body
// { kind, at?, provenance?, subject?, data?, text? }, checked against
// shared/jarvis-events.mjs (the same file the box imports), written by
// events.ts record, which runs the kind's hook. Answers { ok, id } and what
// the hook said (a job-failed's `reported`, a job-ok's `recovered`).
//
// GET /jarvis/events?kind=&since=&subject=&limit=: the read, newest first.
//
// HOW AN AREA ADDS A ROUTE: a handler here (or in its own file under
// convex/jarvis/), one line in register() below. convex/http.ts calls
// register once; nothing else in http.ts changes for a new /jarvis/ route.
// Every /tts/* route not re-registered here is also served under /jarvis/*
// by http.ts's prefix loop, so an area moves by writing its /jarvis/ handler
// here, which takes precedence over the loop's copy.

import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { jarvisAuth, jsonResponse } from "./auth";
import { checkEvent } from "./record";
import { register as registerContext } from "./context";
import { postRuling } from "./rulings";

export const postEvent = httpAction(async (ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const checked = checkEvent(body);
  if (!checked.ok) return jsonResponse(400, { error: checked.error });
  try {
    const { id, result } = await ctx.runMutation(internal.jarvis.events.record, checked.event);
    return jsonResponse(200, { ok: true, id, ...(typeof result === "object" && result !== null ? result : {}) });
  } catch (e) {
    return jsonResponse(400, { error: e instanceof Error ? e.message : String(e) });
  }
});

function optionalNumber(value: string | null): number | undefined | null {
  if (value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export const getEvents = httpAction(async (ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") || undefined;
  const subject = url.searchParams.get("subject") || undefined;
  const since = optionalNumber(url.searchParams.get("since"));
  const limit = optionalNumber(url.searchParams.get("limit"));
  if (since === null || limit === null) return jsonResponse(400, { error: "since and limit, when given, are numbers" });
  const events = await ctx.runQuery(internal.jarvis.events.list, { kind, subject, since, limit });
  return jsonResponse(200, { ok: true, events });
});

/** Every /jarvis/ route the record serves, one line each. */
export function register(http: HttpRouter): void {
  http.route({ path: "/jarvis/event", method: "POST", handler: postEvent });
  http.route({ path: "/jarvis/events", method: "GET", handler: getEvents });
  registerContext(http); // GET /jarvis/context?for=<caller> (context.ts)
  http.route({ path: "/jarvis/ruling", method: "POST", handler: postRuling });
}
