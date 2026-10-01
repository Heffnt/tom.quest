// push.ts — the backend half of web push to Tom's phone and desktop.
//
// A browser's PushSubscription is one row of the record (kind
// "push-subscription"): the subject is its endpoint, so a later save or a
// "gone" report under the same endpoint supersedes it, and liveSubscriptions
// reads only each endpoint's newest row through events.by_kind_subject_at.
// The key-authed POST /jarvis/push is the box's door to send a notification;
// /push's page and service worker (a later task) call the Tom-gated
// functions here.

import { v } from "convex/values";
import { httpAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireTom } from "./authRoles";
import { insertEvent } from "./jarvis/record";
import { jarvisAuth, jsonResponse } from "./jarvis/auth";

/** The error when the VAPID pair is missing from the Convex environment. */
export const VAPID_UNSET =
  "VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not set in the Convex environment";

const PUSH_KIND = "push-subscription";

/** The VAPID pair from the environment, or null when either side is unset. */
export function vapidKeys(): { publicKey: string; privateKey: string } | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey };
}

/** The public VAPID key the browser needs to subscribe; Tom-only. */
export const vapidPublicKey = query({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    await requireTom(ctx, "Push");
    return vapidKeys()?.publicKey ?? null;
  },
});

const subscriptionValidator = v.object({
  endpoint: v.string(),
  expirationTime: v.optional(v.union(v.number(), v.null())),
  keys: v.object({ p256dh: v.string(), auth: v.string() }),
});

/** Save one browser's subscription; Tom-only. Appends one event, no other table. */
export const saveSubscription = mutation({
  args: { subscription: subscriptionValidator },
  handler: async (ctx, args) => {
    const user = await requireTom(ctx, "Push");
    await insertEvent(ctx, {
      kind: PUSH_KIND,
      subject: args.subscription.endpoint,
      data: { live: true, subscription: args.subscription },
      provenance: { user: String(user) },
    });
  },
});

/** Every live subscription: each endpoint's newest row, kept when live. */
export const liveSubscriptions = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("events")
      .withIndex("by_kind_subject_at", (q) => q.eq("kind", PUSH_KIND))
      .collect();
    const latest = new Map<string, { at: number; live: boolean; subscription: unknown }>();
    for (const row of rows) {
      const data = (row.data ?? {}) as Record<string, unknown>;
      const prior = latest.get(row.subject ?? "");
      if (prior === undefined || row.at > prior.at) {
        latest.set(row.subject ?? "", {
          at: row.at,
          live: data.live === true,
          subscription: data.subscription,
        });
      }
    }
    const live: unknown[] = [];
    for (const entry of latest.values()) {
      if (entry.live) live.push(entry.subscription);
    }
    return live;
  },
});

/** Record that a push service refused one endpoint as gone. */
export const markGone = internalMutation({
  args: { endpoint: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    await insertEvent(ctx, {
      kind: PUSH_KIND,
      subject: args.endpoint,
      data: { live: false, reason: args.reason },
      provenance: { job: "push" },
    });
  },
});

/** Send a test notification to this device's subscription only; Tom-only. */
export const requestTest = mutation({
  args: { endpoint: v.string() },
  handler: async (ctx, args) => {
    await requireTom(ctx, "Push");
    if (vapidKeys() === null) throw new Error(VAPID_UNSET);
    await ctx.scheduler.runAfter(0, internal.pushSend.sendToAll, {
      title: "tom.Quest",
      body: "Test notification from /push",
      url: "/push",
      only: args.endpoint,
    });
  },
});

const MAX_TITLE = 200;
const MAX_BODY = 1000;

/** POST /jarvis/push — the box's door to send a notification to every live
 *  subscription. Body { title, body?, url? }. */
export const pushRoute = httpAction(async (ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { ok: false, error: "invalid JSON body" });
  }
  const parsed = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const title = parsed.title;
  const parsedBody = parsed.body;
  const parsedUrl = parsed.url;
  if (typeof title !== "string" || title.length === 0 || title.length > MAX_TITLE) {
    return jsonResponse(400, { ok: false, error: `title must be a non-empty string of at most ${MAX_TITLE} characters` });
  }
  if (parsedBody !== undefined && (typeof parsedBody !== "string" || parsedBody.length > MAX_BODY)) {
    return jsonResponse(400, { ok: false, error: `body, when given, is a string of at most ${MAX_BODY} characters` });
  }
  if (
    parsedUrl !== undefined &&
    (typeof parsedUrl !== "string" || (!parsedUrl.startsWith("/") && !parsedUrl.startsWith("https://")))
  ) {
    return jsonResponse(400, { ok: false, error: 'url, when given, is a string starting with "/" or "https://"' });
  }
  if (vapidKeys() === null) {
    return jsonResponse(503, { ok: false, error: VAPID_UNSET });
  }
  const result = await ctx.runAction(internal.pushSend.sendToAll, {
    title,
    body: typeof parsedBody === "string" ? parsedBody : "",
    url: typeof parsedUrl === "string" ? parsedUrl : "/",
  });
  return jsonResponse(200, { ok: true, ...result });
});
