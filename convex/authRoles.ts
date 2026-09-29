import { getAuthUserId } from "@convex-dev/auth/server";
import { isAgentReadableSurface } from "./agentSurfaces";
import { canSee, PAGE_ACCESS, type PageSlug } from "./pageAccess";
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

// `agent` FAILS CLOSED HERE, and that is the whole security argument. Every
// gate in this codebase — roughly 217 call sites — asks isAdmin or isTom and
// nothing else, so returning false for both means the new role is denied
// everywhere by default and is admitted only where a later commit says so out
// loud. The alternative, making `agent` imply `admin` so /turing worked with
// no further edits, was passed over: it would hand the role every admin write
// on day one, which is the exact harm this role exists to remove.
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


async function requireViewer(ctx: AuthCtx): Promise<{
  userId: Id<"users">;
  user: Doc<"users"> | null;
  access: RoleAccess;
}> {
  const userId = await requireViewerId(ctx);
  const user = await ctx.db.get(userId);
  return { userId, user, access: roleAccess(user?.role) };
}

// WHILE THE GATES MOVE FROM LABELS TO PAGES: a gate names either a page slug
// (resolved through convex/pageAccess.ts) or, until its module moves, the
// label it always named (resolved through convex/agentSurfaces.ts).
function isPageSlug(target: string): target is PageSlug {
  return Object.prototype.hasOwnProperty.call(PAGE_ACCESS, target);
}

// The one Tom gate. `target` names the page (or, until moved, the label) so a
// denial says what was denied. Every Tom-only Convex module calls this —
// never a local copy — so a change to the Tom check has exactly one home.
export async function requireTom(
  ctx: AuthCtx,
  target: PageSlug | string,
): Promise<Id<"users">> {
  const { userId, access } = await requireViewer(ctx);
  const name = isPageSlug(target) ? PAGE_ACCESS[target].label : target;
  if (!access.isTom) throw new Error(`${name} access is restricted to Tom`);
  return userId;
}

// The read gate, sibling to requireTom above, which stays the WRITE gate.
// Admits a caller who is Tom or `agent` and may see the page by its row in
// convex/pageAccess.ts. Query handlers that a TTS session must be able to look
// at call this; every mutation, action and internal function keeps calling
// requireTom, so "may look at /jarvis" never becomes "may change /jarvis".
//
// The denial message is deliberately IDENTICAL to requireTom's: a refused
// caller learns that the surface is closed to it, not which of two gates
// closed it.
export async function requireTomOrAgent(
  ctx: AuthCtx,
  target: PageSlug | string,
): Promise<Id<"users">> {
  const { userId, access } = await requireViewer(ctx);
  if (isPageSlug(target)) {
    if ((access.isTom || access.isAgent) && canSee(access.role, target)) return userId;
    throw new Error(`${PAGE_ACCESS[target].label} access is restricted to Tom`);
  }
  if (access.isTom) return userId;
  if (access.isAgent && isAgentReadableSurface(target)) return userId;
  throw new Error(`${target} access is restricted to Tom`);
}
