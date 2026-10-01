"use node";

// A node action: web-push needs Node's crypto (VAPID signing and payload
// encryption), which the default Convex runtime does not provide.

import { v } from "convex/values";
import webpush from "web-push";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { VAPID_UNSET, vapidKeys } from "./push";

/** Send one notification to every live subscription. */
export const sendToAll = internalAction({
  args: { title: v.string(), body: v.string(), url: v.string() },
  handler: async (ctx, args): Promise<{ sent: number; failed: number; gone: number; errors: string[] }> => {
    const keys = vapidKeys();
    if (keys === null) throw new Error(VAPID_UNSET);
    webpush.setVapidDetails("https://tom.quest", keys.publicKey, keys.privateKey);
    const subscriptions = await ctx.runQuery(internal.push.liveSubscriptions, {});
    const payload = JSON.stringify({ title: args.title, body: args.body, url: args.url });
    const result = { sent: 0, failed: 0, gone: 0, errors: [] as string[] };
    for (const subscription of subscriptions as Array<{ endpoint: string }>) {
      try {
        await webpush.sendNotification(
          subscription as Parameters<typeof webpush.sendNotification>[0],
          payload,
          { TTL: 86400 },
        );
        result.sent += 1;
      } catch (error) {
        const statusCode =
          typeof error === "object" && error !== null && "statusCode" in error
            ? (error as { statusCode?: unknown }).statusCode
            : undefined;
        if (statusCode === 404 || statusCode === 410) {
          result.gone += 1;
          await ctx.runMutation(internal.push.markGone, {
            endpoint: subscription.endpoint,
            reason: `push service answered ${statusCode}`,
          });
        } else {
          result.failed += 1;
          const host = safeHost(subscription.endpoint);
          const reason =
            statusCode !== undefined
              ? String(statusCode)
              : error instanceof Error
                ? error.message
                : String(error);
          result.errors.push(`${host}: ${reason}`);
        }
      }
    }
    return result;
  },
});

/** The endpoint's host only; never the endpoint itself, never a key. */
function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unknown-host";
  }
}
