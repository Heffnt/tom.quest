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

export async function requireAdmin(request: Request): Promise<ServerUser> {
  const user = await currentUser(request);
  if (!user?.isAdmin) throw new Error("Admin access required");
  return user;
}

export async function requireTom(request: Request): Promise<ServerUser> {
  const user = await currentUser(request);
  if (!user?.isTom) throw new Error("Tom access required");
  return user;
}
