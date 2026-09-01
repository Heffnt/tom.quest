import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { isAgentReadableSurface } from "@/convex/agentSurfaces";

export type ServerUser = {
  _id: string;
  name: string;
  email: string | null;
  role: "user" | "admin" | "tom" | "agent";
  isAdmin: boolean;
  isTom: boolean;
  isAgent: boolean;
};

export function convexClient(): ConvexHttpClient {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    throw new Error(
      "NEXT_PUBLIC_CONVEX_URL is not set. Set it in .env.local for dev or in Vercel project envs for prod.",
    );
  }
  return new ConvexHttpClient(convexUrl);
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

export async function currentUser(request: Request): Promise<ServerUser | null> {
  const token = bearerToken(request);
  if (!token) return null;
  const client = convexClient();
  client.setAuth(token);
  return await client.query(api.users.viewer, {});
}

function authError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

// This module gates on ROLE, not on mere sign-in: the two guards below are
// admin-or-above and Tom-only. There is deliberately no signed-in-any-role
// guard, because no route wanted one. A route that needs "any signed-in user"
// calls currentUser() and returns its own 401.
export async function requireAdmin(request: Request): Promise<ServerUser | Response> {
  const user = await currentUser(request);
  if (!user) return authError("Authentication required", 401);
  if (!user.isAdmin) return authError("Admin access required", 403);
  return user;
}

// The read half of requireAdmin, for route handlers that serve BOTH a read
// and a write through one proxy function. Admits admins (and therefore Tom)
// always, and the read-only `agent` role only when `surface` is named in
// convex/agentSurfaces.ts. A handler that mutates upstream state must keep
// calling requireAdmin — see app/api/turing/[...path]/route.ts, where GET
// takes this gate and POST/DELETE do not.
export async function requireAdminOrAgent(
  request: Request,
  surface: string,
): Promise<ServerUser | Response> {
  const user = await currentUser(request);
  if (!user) return authError("Authentication required", 401);
  if (user.isAdmin) return user;
  if (user.isAgent && isAgentReadableSurface(surface)) return user;
  return authError("Admin access required", 403);
}

export async function requireTom(request: Request): Promise<ServerUser | Response> {
  const user = await currentUser(request);
  if (!user) return authError("Authentication required", 401);
  if (!user.isTom) return authError("Tom access required", 403);
  return user;
}
