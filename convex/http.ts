import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

http.route({
  path: "/api/turing/register",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.TURING_REGISTRATION_SECRET;
    if (!expected) return json({ error: "registration secret missing" }, 500);
    const authorization = request.headers.get("authorization") ?? "";
    if (authorization !== `Bearer ${expected}`) {
      return json({ error: "unauthorized" }, 401);
    }

    const body = (await request.json()) as { key?: unknown; url?: unknown };
    const connectionKey = typeof body.key === "string" ? body.key : "";
    const tunnelUrl = typeof body.url === "string" ? body.url : "";
    if (!connectionKey || !validUrl(tunnelUrl)) {
      return json({ error: "invalid key or url" }, 400);
    }

    await ctx.runMutation(internal.turing.registerConnectionFromWorker, {
      connectionKey,
      tunnelUrl,
      now: Date.now(),
    });
    return json({ ok: true });
  }),
});

export default http;
