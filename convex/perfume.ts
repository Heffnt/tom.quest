import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { requireViewerId, viewerDoc } from "./authRoles";

// Canonical token ids of the Three Feifs system: 9 fundamentals + 17 named
// frequencies. Kept in sync with app/perfume/data/base.json. User-created
// content may only reference these — junk tokens are rejected so the shared
// public catalog can't be polluted.
const KNOWN_TOKENS = new Set<string>([
  "A", "C", "D", "E", "En", "Ev", "I", "N", "T",
  "Ignetium", "Crallax", "Yonescope", "Chrysipil", "Letchettin", "Silentix",
  "Draconil", "Myddenic", "Persimmious", "Albutian", "Korastic", "Lythillious",
  "Malvesian", "Laternical", "Thurmistic", "Ontoligin", "Saspacian",
]);

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function cleanTokens(tokens: string[]): string[] {
  for (const t of tokens) {
    if (!KNOWN_TOKENS.has(t)) throw new Error(`Unknown frequency: ${t}`);
  }
  return tokens;
}
function boundedString(value: string, max: number, label: string): string {
  const v2 = value.trim();
  if (v2.length > max) throw new Error(`${label} must be ${max} characters or fewer`);
  return v2;
}

// PUBLIC reads — anyone (authed or not) can list all ingredients/recipes.
// Newest-first; ordered by the built-in _creationTime index, so this is bounded
// and cheap. The `listMine*` queries below guarantee a creator always sees their
// own rows even if the global list exceeds the cap.
export const listIngredients = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("perfumeIngredients").order("desc").take(500);
  },
});

export const listRecipes = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("perfumeRecipes").order("desc").take(500);
  },
});

// The viewer's own creations (empty for signed-out viewers), via the by_user
// index — never hidden by the global 500-row cap.
export const listMineIngredients = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await ctx.db
      .query("perfumeIngredients")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
  },
});

export const listMineRecipes = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await ctx.db
      .query("perfumeRecipes")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
  },
});

// MUTATIONS — auth-gated. The creator is derived server-side; userId is never
// accepted as an argument. All free-form input is validated/bounded so a single
// authed user cannot degrade the shared catalog for everyone.

export const addIngredient = mutation({
  args: {
    name: v.string(),
    emits: v.array(v.string()),
    minus: v.number(),
    plus: v.number(),
    color: v.string(),
  },
  handler: async (ctx, { name, emits, minus, plus, color }) => {
    const userId = await requireViewerId(ctx);
    const me = await viewerDoc(ctx);
    const creatorName = me?.name ?? "Anonymous";

    const trimmedName = boundedString(name, 80, "Ingredient name");
    if (trimmedName.length === 0) throw new Error("Ingredient name is required");
    if (!Number.isInteger(minus) || minus < 0 || minus > 9) {
      throw new Error("Strikes must be an integer between 0 and 9");
    }
    if (!Number.isInteger(plus) || plus < 0 || plus > 9) {
      throw new Error("Wildcards must be an integer between 0 and 9");
    }
    if (!HEX_COLOR.test(color)) throw new Error("Color must be a hex value");
    const cleanedEmits = cleanTokens(emits.slice(0, 12));

    return await ctx.db.insert("perfumeIngredients", {
      userId,
      creatorName,
      name: trimmedName,
      emits: cleanedEmits,
      minus,
      plus,
      color,
      createdAt: Date.now(),
    });
  },
});

export const addRecipe = mutation({
  args: {
    name: v.string(),
    school: v.string(),
    tier: v.union(
      v.literal("simple"),
      v.literal("advanced"),
      v.literal("legendary"),
    ),
    req: v.array(v.string()),
    desc: v.string(),
  },
  handler: async (ctx, { name, school, tier, req, desc }) => {
    const userId = await requireViewerId(ctx);
    const me = await viewerDoc(ctx);
    const creatorName = me?.name ?? "Anonymous";

    const trimmedName = boundedString(name, 80, "Recipe name");
    if (trimmedName.length === 0) throw new Error("Recipe name is required");
    if (req.length < 1 || req.length > 40) {
      throw new Error("A recipe needs between 1 and 40 required frequencies");
    }
    const cleanedReq = cleanTokens(req);

    return await ctx.db.insert("perfumeRecipes", {
      userId,
      creatorName,
      name: trimmedName,
      school: boundedString(school, 60, "School") || "Custom",
      tier,
      req: cleanedReq,
      desc: boundedString(desc, 500, "Description"),
      createdAt: Date.now(),
    });
  },
});

export const removeIngredient = mutation({
  args: { id: v.id("perfumeIngredients") },
  handler: async (ctx, { id }) => {
    const userId = await requireViewerId(ctx);
    const row = await ctx.db.get(id);
    if (!row || row.userId !== userId) throw new Error("Not found");
    await ctx.db.delete(id);
  },
});

export const removeRecipe = mutation({
  args: { id: v.id("perfumeRecipes") },
  handler: async (ctx, { id }) => {
    const userId = await requireViewerId(ctx);
    const row = await ctx.db.get(id);
    if (!row || row.userId !== userId) throw new Error("Not found");
    await ctx.db.delete(id);
  },
});
