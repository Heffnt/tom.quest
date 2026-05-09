import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

export type ServerUser = {
  _id: string;
  name: string;
  email: string | null;
  role: "user" | "admin" | "tom";
  isAdmin: boolean;
  isTom: boolean;
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

export async function requireTom(request: Request): Promise<ServerUser | Response> {
  const user = await currentUser(request);
  if (!user) return authError("Authentication required", 401);
  if (!user.isTom) return authError("Tom access required", 403);
  return user;
}
