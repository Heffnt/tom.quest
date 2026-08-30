import { getAuthUserId } from "@convex-dev/auth/server";
import { isAgentReadableSurface } from "./agentSurfaces";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export type UserRole = "user" | "admin" | "tom" | "agent";

export type RoleAccess = {
  role: UserRole;
  isAdmin: boolean;
  isTom: boolean;
  isAgent: boolean;
};

type AuthCtx = QueryCtx | MutationCtx;

// `agent` gets isAdmin: false and isTom: false. That is the load-bearing line
// of the whole role: every gate in this codebase asks one of those two
// questions, so all of them deny `agent` by default and none of them had to be
// edited to stay safe. The role reaches exactly what requireTomOrAgent (below)
// and the GET-only branch of the Turing proxy hand it, and nothing else.
export function roleAccess(role: UserRole | undefined): RoleAccess {
  const resolved = role ?? "user";
  return {
    role: resolved,
    isAdmin: resolved === "admin" || resolved === "tom",
    isTom: resolved === "tom",
    isAgent: resolved === "agent",
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

// The one Tom gate. `label` names the surface in the error ("Forge", "TTS") so
// a denial says what was denied. Every Tom-only Convex module calls this —
// never a local copy — so a change to the Tom check has exactly one home.
export async function requireTom(
  ctx: AuthCtx,
  label: string,
): Promise<Id<"users">> {
  const { userId, access } = await requireViewer(ctx);
  if (!access.isTom) throw new Error(`${label} access is restricted to Tom`);
  return userId;
}

// The read gate for a Tom-only surface. Tom always passes; `agent` — a TTS
// session's headless browser — passes only when `label` is one of the surfaces
// listed in ./agentSurfaces.
//
// Call this from `query` handlers only. requireTom above stays the write gate,
// and every mutation, action and internal function keeps calling it, so a
// session that signs in can read the page it is looking at and cannot change
// anything on it. Putting this on a mutation would silently undo that.
export async function requireTomOrAgent(
  ctx: AuthCtx,
  label: string,
): Promise<Id<"users">> {
  const { userId, access } = await requireViewer(ctx);
  if (access.isTom) return userId;
  if (access.isAgent && isAgentReadableSurface(label)) return userId;
  throw new Error(`${label} access is restricted to Tom`);
}
