import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireTom, roleAccess, viewerDoc } from "./authRoles";
import { insertEvent } from "./jarvis/record";

// The login widget's username as the "email" index holds it: sign-up derives
// the synthetic email `${normalized}@tom.quest` from it (convex/auth.ts).
function normalizeUsername(username: string): string {
  return username.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// The one username setTomByUsername may promote, normalized the same way.
function tomUsername(): string {
  return normalizeUsername(process.env.TOM_USERNAME ?? "tom");
}

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewerDoc(ctx);
    if (!user) return null;
    const access = roleAccess(user.role);
    return {
      _id: user._id,
      name: user.name ?? "User",
      email: user.email ?? null,
      role: access.role,
      isAdmin: access.isAdmin,
      isTom: access.isTom,
      isAgent: access.isAgent,
    };
  },
});

export const setTomByUsername = mutation({
  args: { username: v.string(), setupSecret: v.string() },
  handler: async (ctx, { username, setupSecret }) => {
    const expectedSecret = process.env.TOM_SETUP_SECRET;
    if (!expectedSecret || setupSecret !== expectedSecret) {
      throw new Error("Tom setup is not authorized");
    }
    const normalized = normalizeUsername(username);
    if (normalized !== tomUsername()) {
      throw new Error("Only the configured Tom username can be promoted this way");
    }
    const existingTom = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("role"), "tom"))
      .first();
    if (existingTom) {
      throw new Error("Tom account is already configured");
    }
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", `${normalized}@tom.quest`))
      .unique();
    if (!user) throw new Error("User not found");
    await ctx.db.patch(user._id, { role: "tom" });
    return user._id;
  },
});

// Tom's pen for a user's role, by the name he typed into the login widget.
//
// WHY IT EXISTS: before this, the only two writers of users.role were
// setTomByUsername (a one-shot bootstrap that refuses once a Tom exists) and
// promoteToAdmin, which takes a raw Id<"users"> — so it is reachable only from
// the Convex dashboard, only for promotion, and there was no way to take a
// role back at all. Granting the new read-only `agent` role needs a pen, and
// so does the mistake that follows a grant.
//
// The username is the one from the widget: sign-up derives the synthetic email
// `${username}@tom.quest`, and that is what the "email" index holds.
//
// TWO REFUSALS, both deliberate:
//   - `tom` is not in the args union, so this can never MINT a Tom. That stays
//     setTomByUsername's one-shot job, guarded by TOM_SETUP_SECRET.
//   - an account already at `tom` is refused outright, so a typo'd username
//     cannot demote Tom out of his own site and lock every Tom gate.
export const setRoleByUsername = mutation({
  args: {
    username: v.string(),
    role: v.union(v.literal("user"), v.literal("admin"), v.literal("agent")),
  },
  handler: async (ctx, { username, role }) => {
    await requireTom(ctx, "User roles");
    const normalized = normalizeUsername(username);
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", `${normalized}@tom.quest`))
      .unique();
    if (!user) throw new Error("User not found");
    if (user.role === "tom") {
      throw new Error("The Tom account's role cannot be changed here");
    }
    await ctx.db.patch(user._id, { role });
    return user._id;
  },
});

export const promoteToAdmin = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const viewer = await viewerDoc(ctx);
    if (!roleAccess(viewer?.role).isTom) {
      throw new Error("Only Tom can promote admins");
    }
    await ctx.db.patch(userId, { role: "admin" });
  },
});

// The event kind grantAgentRole writes (shared/jarvis-events.mjs EVENT_KINDS).
export const ROLE_GRANTED = "role-granted";

// The deploy credential's pen for the read-only `agent` role: an internal
// mutation, so no browser can call it; `npx convex run` with the deploy
// credential can. It is setRoleByUsername's `agent` grant without the
// signed-in caller, and it asserts no identity: the record's row names the
// agent run that asked (provenance.agentId), not a person.
//
// WHAT IT REFUSES, each before anything is written:
//   - a username that normalizes to TOM_USERNAME, whatever role that account
//     holds now, so the name setTomByUsername promotes is never an agent;
//   - an account at `tom`, under any username;
//   - an account at `admin`: taking an admin down to a reader is a decision
//     about that person, not a grant, and setRoleByUsername is its pen;
//   - an unknown username, an empty one, and an empty agentId.
//
// IDEMPOTENT: an account already at `agent` is answered { changed: false }
// and no second event is written, because nothing happened.
export const grantAgentRole = internalMutation({
  args: { username: v.string(), agentId: v.string() },
  handler: async (ctx, { username, agentId }) => {
    const normalized = normalizeUsername(username);
    if (!normalized) throw new Error("username must contain letters or numbers");
    if (agentId.trim() === "") throw new Error("agentId names the run that asks for the grant");
    if (normalized === tomUsername()) {
      throw new Error("The Tom username cannot be given the agent role");
    }
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", `${normalized}@tom.quest`))
      .unique();
    if (!user) throw new Error("User not found");
    if (user.role === "tom") throw new Error("The Tom account's role cannot be changed here");
    if (user.role === "admin") throw new Error("An admin's role is not changed by this grant");
    if (user.role === "agent") return { userId: user._id, changed: false };
    const previousRole = user.role ?? "user";
    await ctx.db.patch(user._id, { role: "agent" });
    await insertEvent(ctx, {
      kind: ROLE_GRANTED,
      provenance: { agentId },
      subject: user._id,
      data: { userId: user._id, username: normalized, role: "agent", previousRole },
      text: `${normalized} was given the agent role (was ${previousRole})`,
    });
    return { userId: user._id, changed: true };
  },
});
