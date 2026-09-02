import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTom, roleAccess, viewerDoc } from "./authRoles";

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
    const normalized = username.toLowerCase().replace(/[^a-z0-9]/g, "");
    const allowedUsername = (process.env.TOM_USERNAME ?? "tom")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    if (normalized !== allowedUsername) {
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
// promoteToAdmin, which took a raw Id<"users"> — so it was reachable only from
// the Convex dashboard, only for promotion, and there was no way to take a
// role back at all. Granting the new read-only `agent` role needs a pen, and
// so does the mistake that follows a grant.
//
// promoteToAdmin has since been DELETED: this mutation covers everything it
// did and reverses it too, and it was the last Tom-only mutation in the
// codebase hand-writing its own gate instead of calling requireTom — the
// counter-example to the claim at authRoles.ts:57-59. What went with it is
// promoting by raw Id from the Convex dashboard when the username is unknown.
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
    const normalized = username.toLowerCase().replace(/[^a-z0-9]/g, "");
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

