import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export type UserRole = "user" | "admin" | "tom";

export type RoleAccess = {
  role: UserRole;
  isAdmin: boolean;
  isTom: boolean;
};

type AuthCtx = QueryCtx | MutationCtx;

export function roleAccess(role: UserRole | undefined): RoleAccess {
  const resolved = role ?? "user";
  return {
    role: resolved,
    isAdmin: resolved === "admin" || resolved === "tom",
    isTom: resolved === "tom",
  };
}

export async function viewerDoc(ctx: AuthCtx): Promise<Doc<"users"> | null> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  return await ctx.db.get(userId);
}

export async function requireViewerId(ctx: AuthCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Authentication required");
  return userId;
}

export async function requireViewer(ctx: AuthCtx): Promise<{
  userId: Id<"users">;
  user: Doc<"users"> | null;
  access: RoleAccess;
}> {
  const userId = await requireViewerId(ctx);
  const user = await ctx.db.get(userId);
  return { userId, user, access: roleAccess(user?.role) };
}
