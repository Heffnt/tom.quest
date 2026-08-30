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

export async function requireUser(request: Request): Promise<ServerUser | Response> {
  const user = await currentUser(request);
  if (!user) return authError("Authentication required", 401);
  return user;
}

export async function requireAdmin(request: Request): Promise<ServerUser | Response> {
  const user = await currentUser(request);
  if (!user) return authError("Authentication required", 401);
  if (!user.isAdmin) return authError("Admin access required", 403);
  return user;
}

// The read counterpart to requireAdmin: admin and tom as before, plus the
// `agent` role a TTS session's headless browser signs in as, when `surface` is
// one of the names in convex/agentSurfaces.
//
// Use this on a GET and never on anything else. requireAdmin stays in front of
// every request that changes something — on the Turing proxy that is the
// difference between a session looking at the GPU table and a session
// cancelling a job on it.
export async function requireAdminOrAgentRead(
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
