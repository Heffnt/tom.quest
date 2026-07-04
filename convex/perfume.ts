// Perfumer's Bench backend (see app/perfume/DESIGN.md "Backend").
//
// Permission rule — "WHERE, not WHAT": anyone identified may change where a
// bench owner's items are (inventory<->brew, strike/wild plays, shared UI);
// only the owner may change what they own (brew completion, output, import,
// transfer, pins). Party pot: contributions tracked per item; removals return
// to the contributor; brew/take open to all; wholesale clear = Tom only.
//
// Brew verification uses the shared engine (app/perfume/lib/engine) — the one
// implementation of combination equivalence + k-multiple matching. Convex
// bundles these relative imports from outside convex/.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { roleAccess, viewerDoc } from "./authRoles";
import { chargeTotals, evalReq } from "../app/perfume/lib/engine";
import {
  baseIngredients,
  basePerfumes,
  fundamentals,
  pureIngredients,
} from "../app/perfume/data/base";
import {
  DEFAULT_UI,
  inventorySectionFor,
} from "../app/perfume/lib/bench-types";
import type {
  BenchSnapshot,
  Inventory,
  PotItem,
} from "../app/perfume/lib/bench-types";
import type { BrewState, Ingredient, Perfume } from "../app/perfume/lib/types";

const PARTY_KEY = "party";
const PARTY_COLOR = "#C98A3C";
const PRESENCE_FRESH_MS = 10_000;
const PRESENCE_SWEEP_MS = 15_000;

// Anonymous caller keys are "anon:<uuid>" minted client-side (localStorage).
const ANON_KEY = /^anon:[0-9a-f-]{36}$/;

const CATALOG: Record<string, Ingredient> = Object.fromEntries(
  [...baseIngredients, ...pureIngredients].map((i) => [i.key, i]),
);
const PERFUME_BY_KEY: Record<string, Perfume> = Object.fromEntries(
  basePerfumes.map((p) => [p.key, p]),
);

// ── identity ─────────────────────────────────────────────────────────────────

type Actor = { key: string; name: string; isTom: boolean };

// Logged-in users are keyed by their Convex id; anonymous callers must supply
// a well-formed anonId. Calls with neither are rejected. The actor's display
// name prefers their bench profile (setProfile) over the account name.
async function identify(
  ctx: QueryCtx | MutationCtx,
  anonId: string | undefined,
): Promise<Actor> {
  const user = await viewerDoc(ctx);
  if (user) {
    const key = `user:${user._id}`;
    const bench = await benchByOwner(ctx, key);
    return {
      key,
      name: bench?.ownerName ?? user.name ?? "User",
      isTom: roleAccess(user.role).isTom,
    };
  }
  if (anonId !== undefined) {
    if (!ANON_KEY.test(anonId)) throw new Error("Malformed anonId");
    const bench = await benchByOwner(ctx, anonId);
    return { key: anonId, name: bench?.ownerName ?? "Visitor", isTom: false };
  }
  throw new Error("Sign in or provide anonId");
}

function requireOwner(actor: Actor, benchKey: string, what: string): void {
  if (actor.key !== benchKey) {
    throw new Error(`Only the bench owner may ${what}`);
  }
}

// ── bench helpers ────────────────────────────────────────────────────────────

async function benchByOwner(
  ctx: QueryCtx | MutationCtx,
  ownerKey: string,
): Promise<Doc<"perfumeBenches"> | null> {
  return await ctx.db
    .query("perfumeBenches")
    .withIndex("by_owner", (q) => q.eq("ownerKey", ownerKey))
    .unique();
}

async function requireBench(
  ctx: QueryCtx | MutationCtx,
  benchKey: string,
): Promise<Doc<"perfumeBenches">> {
  const bench = await benchByOwner(ctx, benchKey);
  if (!bench) throw new Error("Bench not found");
  return bench;
}

// Deterministic default profile color, drawn from the fundamentals' palette.
function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return fundamentals[h % fundamentals.length].color;
}

function emptyInventory(): Inventory {
  return { ingredients: {}, pures: {}, perfumes: {} };
}

async function createBench(
  ctx: MutationCtx,
  ownerKey: string,
  ownerName: string,
  color: string,
): Promise<Doc<"perfumeBenches">> {
  const id = await ctx.db.insert("perfumeBenches", {
    ownerKey,
    ownerName,
    color,
    pot: [],
    strikePlays: [],
    wildPlays: [],
    inventory: emptyInventory(),
    outputTray: {},
    ui: { ...DEFAULT_UI },
    updatedAt: Date.now(),
  });
  return (await ctx.db.get(id))!;
}

// Create-on-demand for benches credited by party removals/takes — the
// contributor may never have called ensureBench from this device.
async function ensureBenchFor(
  ctx: MutationCtx,
  ownerKey: string,
  fallbackName: string,
): Promise<Doc<"perfumeBenches">> {
  const existing = await benchByOwner(ctx, ownerKey);
  if (existing) return existing;
  return await createBench(ctx, ownerKey, fallbackName, colorFor(ownerKey));
}

function snapshotOf(bench: Doc<"perfumeBenches">): BenchSnapshot {
  return {
    benchKey: bench.ownerKey,
    ownerName: bench.ownerName,
    color: bench.color,
    pot: bench.pot,
    strikePlays: bench.strikePlays,
    wildPlays: bench.wildPlays,
    inventory: bench.inventory,
    outputTray: bench.outputTray,
    ui: bench.ui,
  };
}

async function partyDoc(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"perfumePartyBrew"> | null> {
  return await ctx.db.query("perfumePartyBrew").first();
}

async function ensureParty(ctx: MutationCtx): Promise<Doc<"perfumePartyBrew">> {
  const existing = await partyDoc(ctx);
  if (existing) return existing;
  const id = await ctx.db.insert("perfumePartyBrew", {
    items: [],
    strikePlays: [],
    wildPlays: [],
    outputTray: {},
    updatedAt: Date.now(),
  });
  return (await ctx.db.get(id))!;
}

// ── inventory + pot helpers ──────────────────────────────────────────────────

// Ingredient keys and perfume keys share the "base:" prefix but never collide
// (ingredient names vs slugged perfume ids); perfumes get their own section.
function sectionFor(itemKey: string): keyof Inventory {
  return PERFUME_BY_KEY[itemKey] ? "perfumes" : inventorySectionFor(itemKey);
}

function cloneInventory(inv: Inventory): Inventory {
  return {
    ingredients: { ...inv.ingredients },
    pures: { ...inv.pures },
    perfumes: { ...inv.perfumes },
  };
}

function stockOf(inv: Inventory, itemKey: string): number {
  return inv[sectionFor(itemKey)][itemKey] ?? 0;
}

function addStock(inv: Inventory, itemKey: string, n: number): void {
  const section = inv[sectionFor(itemKey)];
  const next = (section[itemKey] ?? 0) + n;
  if (next <= 0) delete section[itemKey];
  else section[itemKey] = next;
}

function requireCount(n: number, what: string): number {
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid ${what}: ${n}`);
  return n;
}

function requireIngredient(itemKey: string): Ingredient {
  const ing = CATALOG[itemKey];
  if (!ing) throw new Error(`Unknown ingredient: ${itemKey}`);
  return ing;
}

function potIngredients(items: PotItem[]): Ingredient[] {
  return items.map((p) => requireIngredient(p.key));
}

// Strike/wild plays are capped by the charges the pot items grant (recomputed
// with the shared engine). Removing items can strand plays past the cap —
// trim from the end so the state the engine sees stays legal.
function trimPlays(
  items: PotItem[],
  strikePlays: string[],
  wildPlays: string[],
): { strikePlays: string[]; wildPlays: string[] } {
  const totals = chargeTotals(potIngredients(items));
  return {
    strikePlays: strikePlays.slice(0, Math.max(0, totals.strike)),
    wildPlays: wildPlays.slice(0, Math.max(0, totals.wild)),
  };
}

// Move n copies of itemKey from `inv` into `pot`: stock first flips existing
// hypotheticals of that key to real (the only conversion path), then backs new
// real items; past stock the copies enter as hypotheticals (real: false).
function addToPot(
  pot: PotItem[],
  inv: Inventory,
  itemKey: string,
  n: number,
  contributorKey: string,
  contributorName: string,
): { real: number; hypothetical: number; converted: number } {
  let real = 0;
  let hypothetical = 0;
  let converted = 0;
  for (let i = 0; i < n; i++) {
    if (stockOf(inv, itemKey) > 0) {
      addStock(inv, itemKey, -1);
      const idx = pot.findIndex((p) => p.key === itemKey && !p.real);
      if (idx >= 0) {
        pot[idx] = { key: itemKey, contributorKey, contributorName, real: true };
        converted++;
      } else {
        pot.push({ key: itemKey, contributorKey, contributorName, real: true });
        real++;
      }
    } else {
      pot.push({ key: itemKey, contributorKey, contributorName, real: false });
      hypothetical++;
    }
  }
  return { real, hypothetical, converted };
}

// Remove up to n copies of itemKey from `pot` — hypotheticals first (they are
// the junk blocking the brew), then real items newest-first. Returns the
// removed real items (hypotheticals just vanish).
function removeFromPot(pot: PotItem[], itemKey: string, n: number): PotItem[] {
  const removedReal: PotItem[] = [];
  let remaining = n;
  for (const wantReal of [false, true]) {
    for (let i = pot.length - 1; i >= 0 && remaining > 0; i--) {
      if (pot[i].key !== itemKey || pot[i].real !== wantReal) continue;
      const [item] = pot.splice(i, 1);
      if (item.real) removedReal.push(item);
      remaining--;
    }
  }
  return removedReal;
}

// Server-side brew verification via the shared engine — no re-implementation
// of matching. Requires every pot item real and the effective tally perfect at
// exactly the claimed tuning and copy-count.
function verifyBrew(
  items: PotItem[],
  strikePlays: string[],
  wildPlays: string[],
  perfumeKey: string,
  tuningIndex: number,
  k: number,
): Perfume {
  const perfume = PERFUME_BY_KEY[perfumeKey];
  if (!perfume) throw new Error(`Unknown perfume: ${perfumeKey}`);
  if (!Number.isInteger(tuningIndex) || tuningIndex < 0 || tuningIndex >= perfume.reqs.length) {
    throw new Error(`Invalid tuning index: ${tuningIndex}`);
  }
  requireCount(k, "copy count");
  if (items.length === 0) throw new Error("The pot is empty");
  const hypos = items.filter((p) => !p.real);
  if (hypos.length > 0) {
    const counts = new Map<string, number>();
    for (const p of hypos) counts.set(p.key, (counts.get(p.key) ?? 0) + 1);
    const parts = [...counts].map(
      ([key, count]) => `${count}× ${CATALOG[key]?.name ?? key}`,
    );
    throw new Error(
      `Cannot brew: ${parts.join(", ")} ${hypos.length === 1 ? "is" : "are"} hypothetical`,
    );
  }
  const brew: BrewState = {
    ingredients: potIngredients(items),
    strikePlays,
    wildPlays,
  };
  const result = evalReq(brew, perfume.reqs[tuningIndex], tuningIndex);
  if (result.status !== "perfect" || result.k !== k) {
    throw new Error(`The pot does not brew ${perfume.name} ×${k}`);
  }
  return perfume;
}

async function logEvent(
  ctx: MutationCtx,
  benchKey: string,
  actor: Actor,
  action: string,
  detail: unknown,
): Promise<void> {
  await ctx.db.insert("perfumeEvents", {
    benchKey,
    actorKey: actor.key,
    actorName: actor.name,
    action,
    detail,
    at: Date.now(),
  });
}

// ── shared arg validators ────────────────────────────────────────────────────

const anonId = v.optional(v.string());

const uiPatch = v.object({
  inputTab: v.optional(
    v.union(v.literal("ingredients"), v.literal("frequencies")),
  ),
  inputSearch: v.optional(v.string()),
  inputFilters: v.optional(v.array(v.string())),
  perfumeSearch: v.optional(v.string()),
  perfumeFilters: v.optional(v.array(v.string())),
  expanded: v.optional(v.array(v.string())),
  pins: v.optional(v.array(v.string())), // owner-only
});

// ── bench lifecycle ──────────────────────────────────────────────────────────

export const ensureBench = mutation({
  args: { anonId, name: v.optional(v.string()), color: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const actor = await identify(ctx, args.anonId);
    const existing = await benchByOwner(ctx, actor.key);
    if (existing) return snapshotOf(existing);
    const bench = await createBench(
      ctx,
      actor.key,
      args.name?.trim() || actor.name,
      args.color ?? colorFor(actor.key),
    );
    await logEvent(ctx, actor.key, actor, "ensureBench", { created: true });
    return snapshotOf(bench);
  },
});

export const setProfile = mutation({
  args: { anonId, name: v.optional(v.string()), color: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const actor = await identify(ctx, args.anonId);
    const bench = await ensureBenchFor(ctx, actor.key, actor.name);
    const patch: Partial<Doc<"perfumeBenches">> = { updatedAt: Date.now() };
    if (args.name !== undefined && args.name.trim()) {
      patch.ownerName = args.name.trim();
    }
    if (args.color !== undefined) patch.color = args.color;
    await ctx.db.patch(bench._id, patch);
    await logEvent(ctx, actor.key, actor, "setProfile", {
      name: patch.ownerName,
      color: patch.color,
    });
  },
});

// Shared browse UI: whitelisted fields, last-write-wins. Pins are owner-only —
// the one WHAT field on the UI doc.
export const updateUI = mutation({
  args: { benchKey: v.string(), patch: uiPatch, anonId },
  handler: async (ctx, { benchKey, patch, anonId }) => {
    const actor = await identify(ctx, anonId);
    const bench = await requireBench(ctx, benchKey);
    if (patch.pins !== undefined) {
      requireOwner(actor, benchKey, "edit pins");
    }
    await ctx.db.patch(bench._id, {
      ui: { ...bench.ui, ...patch },
      updatedAt: Date.now(),
    });
    await logEvent(ctx, benchKey, actor, "updateUI", {
      fields: Object.keys(patch),
    });
  },
});

// ── bench pot moves (WHERE — open to anyone identified) ─────────────────────

export const moveToBrew = mutation({
  args: { benchKey: v.string(), itemKey: v.string(), n: v.number(), anonId },
  handler: async (ctx, { benchKey, itemKey, n, anonId }) => {
    const actor = await identify(ctx, anonId);
    requireCount(n, "count");
    requireIngredient(itemKey);
    const bench = await requireBench(ctx, benchKey);
    const pot = [...bench.pot];
    const inventory = cloneInventory(bench.inventory);
    // On a personal bench the contributor is always the owner — visitors move
    // the owner's items, never their own.
    const moved = addToPot(pot, inventory, itemKey, n, bench.ownerKey, bench.ownerName);
    await ctx.db.patch(bench._id, { pot, inventory, updatedAt: Date.now() });
    await logEvent(ctx, benchKey, actor, "moveToBrew", { itemKey, n, ...moved });
  },
});

export const moveToInventory = mutation({
  args: { benchKey: v.string(), itemKey: v.string(), n: v.number(), anonId },
  handler: async (ctx, { benchKey, itemKey, n, anonId }) => {
    const actor = await identify(ctx, anonId);
    requireCount(n, "count");
    const bench = await requireBench(ctx, benchKey);
    const pot = [...bench.pot];
    const removedReal = removeFromPot(pot, itemKey, n);
    const inventory = cloneInventory(bench.inventory);
    // Real items return to their contributor — on a personal bench that is
    // always the owner. Hypotheticals just vanish.
    addStock(inventory, itemKey, removedReal.length);
    const plays = trimPlays(pot, bench.strikePlays, bench.wildPlays);
    await ctx.db.patch(bench._id, {
      pot,
      inventory,
      ...plays,
      updatedAt: Date.now(),
    });
    await logEvent(ctx, benchKey, actor, "moveToInventory", {
      itemKey,
      n,
      returned: removedReal.length,
    });
  },
});

// ── strike/wild plays (open; benchKey may be "party") ───────────────────────

type PotState = {
  items: PotItem[];
  strikePlays: string[];
  wildPlays: string[];
  save: (fields: { strikePlays?: string[]; wildPlays?: string[] }) => Promise<void>;
};

async function potState(ctx: MutationCtx, benchKey: string): Promise<PotState> {
  if (benchKey === PARTY_KEY) {
    const party = await ensureParty(ctx);
    return {
      items: party.items,
      strikePlays: party.strikePlays,
      wildPlays: party.wildPlays,
      save: (fields) =>
        ctx.db.patch(party._id, { ...fields, updatedAt: Date.now() }),
    };
  }
  const bench = await requireBench(ctx, benchKey);
  return {
    items: bench.pot,
    strikePlays: bench.strikePlays,
    wildPlays: bench.wildPlays,
    save: (fields) =>
      ctx.db.patch(bench._id, { ...fields, updatedAt: Date.now() }),
  };
}

// Playing past the pot's granted charges is a silent no-op (stale optimistic
// clients reconcile), as is un-playing a frequency that is not played.
export const playStrike = mutation({
  args: { benchKey: v.string(), freq: v.string(), anonId },
  handler: async (ctx, { benchKey, freq, anonId }) => {
    const actor = await identify(ctx, anonId);
    const state = await potState(ctx, benchKey);
    if (state.strikePlays.length >= chargeTotals(potIngredients(state.items)).strike) return;
    await state.save({ strikePlays: [...state.strikePlays, freq] });
    await logEvent(ctx, benchKey, actor, "playStrike", { freq });
  },
});

export const unplayStrike = mutation({
  args: { benchKey: v.string(), freq: v.string(), anonId },
  handler: async (ctx, { benchKey, freq, anonId }) => {
    const actor = await identify(ctx, anonId);
    const state = await potState(ctx, benchKey);
    const idx = state.strikePlays.lastIndexOf(freq);
    if (idx < 0) return;
    await state.save({ strikePlays: state.strikePlays.toSpliced(idx, 1) });
    await logEvent(ctx, benchKey, actor, "unplayStrike", { freq });
  },
});

export const playWild = mutation({
  args: { benchKey: v.string(), freq: v.string(), anonId },
  handler: async (ctx, { benchKey, freq, anonId }) => {
    const actor = await identify(ctx, anonId);
    const state = await potState(ctx, benchKey);
    if (state.wildPlays.length >= chargeTotals(potIngredients(state.items)).wild) return;
    await state.save({ wildPlays: [...state.wildPlays, freq] });
    await logEvent(ctx, benchKey, actor, "playWild", { freq });
  },
});

export const unplayWild = mutation({
  args: { benchKey: v.string(), freq: v.string(), anonId },
  handler: async (ctx, { benchKey, freq, anonId }) => {
    const actor = await identify(ctx, anonId);
    const state = await potState(ctx, benchKey);
    const idx = state.wildPlays.lastIndexOf(freq);
    if (idx < 0) return;
    await state.save({ wildPlays: state.wildPlays.toSpliced(idx, 1) });
    await logEvent(ctx, benchKey, actor, "unplayWild", { freq });
  },
});

// ── owner-only bench actions (WHAT) ─────────────────────────────────────────

export const brewPerfume = mutation({
  args: {
    benchKey: v.string(),
    perfumeKey: v.string(),
    tuningIndex: v.number(),
    k: v.number(),
    anonId,
  },
  handler: async (ctx, { benchKey, perfumeKey, tuningIndex, k, anonId }) => {
    const actor = await identify(ctx, anonId);
    requireOwner(actor, benchKey, "brew");
    const bench = await requireBench(ctx, benchKey);
    const perfume = verifyBrew(
      bench.pot,
      bench.strikePlays,
      bench.wildPlays,
      perfumeKey,
      tuningIndex,
      k,
    );
    const outputTray = { ...bench.outputTray };
    outputTray[perfumeKey] = (outputTray[perfumeKey] ?? 0) + k;
    await ctx.db.patch(bench._id, {
      pot: [],
      strikePlays: [],
      wildPlays: [],
      outputTray,
      updatedAt: Date.now(),
    });
    await logEvent(ctx, benchKey, actor, "brewPerfume", {
      perfumeKey,
      name: perfume.name,
      tuningIndex,
      k,
    });
  },
});

export const takeOutput = mutation({
  args: { benchKey: v.string(), perfumeKey: v.string(), n: v.number(), anonId },
  handler: async (ctx, { benchKey, perfumeKey, n, anonId }) => {
    const actor = await identify(ctx, anonId);
    requireOwner(actor, benchKey, "take output");
    requireCount(n, "count");
    const bench = await requireBench(ctx, benchKey);
    const available = bench.outputTray[perfumeKey] ?? 0;
    const taken = Math.min(n, available);
    if (taken > 0) {
      const outputTray = { ...bench.outputTray };
      if (taken === available) delete outputTray[perfumeKey];
      else outputTray[perfumeKey] = available - taken;
      const inventory = cloneInventory(bench.inventory);
      addStock(inventory, perfumeKey, taken);
      await ctx.db.patch(bench._id, {
        outputTray,
        inventory,
        updatedAt: Date.now(),
      });
    }
    await logEvent(ctx, benchKey, actor, "takeOutput", { perfumeKey, n, taken });
    return { taken };
  },
});

export const importInventory = mutation({
  args: {
    benchKey: v.string(),
    rows: v.array(v.object({ itemKey: v.string(), count: v.number() })),
    mode: v.union(v.literal("merge"), v.literal("replace")),
    anonId,
  },
  handler: async (ctx, { benchKey, rows, mode, anonId }) => {
    const actor = await identify(ctx, anonId);
    requireOwner(actor, benchKey, "import inventory");
    const bench = await requireBench(ctx, benchKey);
    for (const row of rows) {
      if (!CATALOG[row.itemKey] && !PERFUME_BY_KEY[row.itemKey]) {
        throw new Error(`Unknown item: ${row.itemKey}`);
      }
      if (!Number.isInteger(row.count) || row.count < 0) {
        throw new Error(`Invalid count for ${row.itemKey}: ${row.count}`);
      }
    }
    const inventory =
      mode === "replace" ? emptyInventory() : cloneInventory(bench.inventory);
    for (const row of rows) addStock(inventory, row.itemKey, row.count);
    await ctx.db.patch(bench._id, { inventory, updatedAt: Date.now() });
    await logEvent(ctx, benchKey, actor, "importInventory", {
      mode,
      rows: rows.length,
    });
  },
});

// Transactional pair move: Convex mutations are atomic, so both inventories
// commit together or not at all. Sending items you lack is rejected outright
// (no clamping) — a partial transfer would misreport what arrived.
export const transfer = mutation({
  args: {
    benchKey: v.string(),
    toOwnerKey: v.string(),
    itemKey: v.string(),
    n: v.number(),
    anonId,
  },
  handler: async (ctx, { benchKey, toOwnerKey, itemKey, n, anonId }) => {
    const actor = await identify(ctx, anonId);
    requireOwner(actor, benchKey, "transfer items");
    requireCount(n, "count");
    if (toOwnerKey === benchKey) throw new Error("Cannot transfer to yourself");
    if (!CATALOG[itemKey] && !PERFUME_BY_KEY[itemKey]) {
      throw new Error(`Unknown item: ${itemKey}`);
    }
    const bench = await requireBench(ctx, benchKey);
    if (stockOf(bench.inventory, itemKey) < n) {
      throw new Error(`Not enough ${itemKey} to send`);
    }
    const toBench = await requireBench(ctx, toOwnerKey);
    const fromInventory = cloneInventory(bench.inventory);
    addStock(fromInventory, itemKey, -n);
    const toInventory = cloneInventory(toBench.inventory);
    addStock(toInventory, itemKey, n);
    const now = Date.now();
    await ctx.db.patch(bench._id, { inventory: fromInventory, updatedAt: now });
    await ctx.db.patch(toBench._id, { inventory: toInventory, updatedAt: now });
    await logEvent(ctx, benchKey, actor, "transfer", { toOwnerKey, itemKey, n });
  },
});

// ── party pot ────────────────────────────────────────────────────────────────

// Contributions come from the CALLER's own bench inventory; past their stock
// the copies enter as hypotheticals credited to the caller.
export const partyMoveToBrew = mutation({
  args: { itemKey: v.string(), n: v.number(), anonId },
  handler: async (ctx, { itemKey, n, anonId }) => {
    const actor = await identify(ctx, anonId);
    requireCount(n, "count");
    requireIngredient(itemKey);
    const party = await ensureParty(ctx);
    const bench = await ensureBenchFor(ctx, actor.key, actor.name);
    const items = [...party.items];
    const inventory = cloneInventory(bench.inventory);
    const moved = addToPot(items, inventory, itemKey, n, actor.key, bench.ownerName);
    const now = Date.now();
    await ctx.db.patch(party._id, { items, updatedAt: now });
    await ctx.db.patch(bench._id, { inventory, updatedAt: now });
    await logEvent(ctx, PARTY_KEY, actor, "partyMoveToBrew", {
      itemKey,
      n,
      ...moved,
    });
  },
});

// Anyone may move any item out; real items return to their CONTRIBUTOR's
// bench inventory, hypotheticals just vanish.
export const partyMoveToInventory = mutation({
  args: { itemKey: v.string(), n: v.number(), anonId },
  handler: async (ctx, { itemKey, n, anonId }) => {
    const actor = await identify(ctx, anonId);
    requireCount(n, "count");
    const party = await ensureParty(ctx);
    const items = [...party.items];
    const removedReal = removeFromPot(items, itemKey, n);
    const byContributor = new Map<string, { name: string; count: number }>();
    for (const item of removedReal) {
      const entry = byContributor.get(item.contributorKey) ?? {
        name: item.contributorName,
        count: 0,
      };
      entry.count++;
      byContributor.set(item.contributorKey, entry);
    }
    const now = Date.now();
    for (const [contributorKey, { name, count }] of byContributor) {
      const bench = await ensureBenchFor(ctx, contributorKey, name);
      const inventory = cloneInventory(bench.inventory);
      addStock(inventory, itemKey, count);
      await ctx.db.patch(bench._id, { inventory, updatedAt: now });
    }
    const plays = trimPlays(items, party.strikePlays, party.wildPlays);
    await ctx.db.patch(party._id, { items, ...plays, updatedAt: now });
    await logEvent(ctx, PARTY_KEY, actor, "partyMoveToInventory", {
      itemKey,
      n,
      returned: removedReal.length,
    });
  },
});

export const partyBrew = mutation({
  args: {
    perfumeKey: v.string(),
    tuningIndex: v.number(),
    k: v.number(),
    anonId,
  },
  handler: async (ctx, { perfumeKey, tuningIndex, k, anonId }) => {
    const actor = await identify(ctx, anonId);
    const party = await ensureParty(ctx);
    const perfume = verifyBrew(
      party.items,
      party.strikePlays,
      party.wildPlays,
      perfumeKey,
      tuningIndex,
      k,
    );
    const outputTray = { ...party.outputTray };
    outputTray[perfumeKey] = (outputTray[perfumeKey] ?? 0) + k;
    await ctx.db.patch(party._id, {
      items: [],
      strikePlays: [],
      wildPlays: [],
      outputTray,
      updatedAt: Date.now(),
    });
    await logEvent(ctx, PARTY_KEY, actor, "partyBrew", {
      perfumeKey,
      name: perfume.name,
      tuningIndex,
      k,
    });
  },
});

// Open to all identified callers; the take credits the CALLER's bench.
export const partyTake = mutation({
  args: { perfumeKey: v.string(), n: v.number(), anonId },
  handler: async (ctx, { perfumeKey, n, anonId }) => {
    const actor = await identify(ctx, anonId);
    requireCount(n, "count");
    const party = await ensureParty(ctx);
    const available = party.outputTray[perfumeKey] ?? 0;
    const taken = Math.min(n, available);
    if (taken > 0) {
      const outputTray = { ...party.outputTray };
      if (taken === available) delete outputTray[perfumeKey];
      else outputTray[perfumeKey] = available - taken;
      const bench = await ensureBenchFor(ctx, actor.key, actor.name);
      const inventory = cloneInventory(bench.inventory);
      addStock(inventory, perfumeKey, taken);
      const now = Date.now();
      await ctx.db.patch(party._id, { outputTray, updatedAt: now });
      await ctx.db.patch(bench._id, { inventory, updatedAt: now });
    }
    await logEvent(ctx, PARTY_KEY, actor, "partyTake", { perfumeKey, n, taken });
    return { taken };
  },
});

// Wholesale clear (Tom only). Items are returned to their contributors, not
// destroyed — no mutation may create or destroy items except import and brew.
export const partyClear = mutation({
  args: { anonId },
  handler: async (ctx, { anonId }) => {
    const actor = await identify(ctx, anonId);
    if (!actor.isTom) throw new Error("Only Tom may clear the party pot");
    const party = await ensureParty(ctx);
    const byContributor = new Map<string, { name: string; items: string[] }>();
    for (const item of party.items) {
      if (!item.real) continue;
      const entry = byContributor.get(item.contributorKey) ?? {
        name: item.contributorName,
        items: [],
      };
      entry.items.push(item.key);
      byContributor.set(item.contributorKey, entry);
    }
    const now = Date.now();
    for (const [contributorKey, { name, items }] of byContributor) {
      const bench = await ensureBenchFor(ctx, contributorKey, name);
      const inventory = cloneInventory(bench.inventory);
      for (const key of items) addStock(inventory, key, 1);
      await ctx.db.patch(bench._id, { inventory, updatedAt: now });
    }
    await ctx.db.patch(party._id, {
      items: [],
      strikePlays: [],
      wildPlays: [],
      updatedAt: now,
    });
    await logEvent(ctx, PARTY_KEY, actor, "partyClear", {
      returned: party.items.filter((i) => i.real).length,
    });
  },
});

// ── presence ─────────────────────────────────────────────────────────────────

// Ephemeral cursor telemetry (~20Hz per client) — deliberately NOT logged to
// perfumeEvents. Upserts by (benchKey, clientId) and opportunistically sweeps
// rows stale past 15s for the same bench.
export const presenceUpdate = mutation({
  args: {
    benchKey: v.string(),
    clientId: v.string(),
    name: v.string(),
    color: v.string(),
    surface: v.union(v.literal("input"), v.literal("stage"), v.literal("book")),
    x: v.number(),
    y: v.number(),
    hand: v.optional(v.object({ key: v.string(), count: v.number() })),
    anonId,
  },
  handler: async (ctx, args) => {
    await identify(ctx, args.anonId);
    const now = Date.now();
    const rows = await ctx.db
      .query("perfumePresence")
      .withIndex("by_bench", (q) => q.eq("benchKey", args.benchKey))
      .collect();
    let mine: Doc<"perfumePresence"> | null = null;
    for (const row of rows) {
      if (row.clientId === args.clientId) mine = row;
      else if (row.updatedAt < now - PRESENCE_SWEEP_MS) await ctx.db.delete(row._id);
    }
    const fields = {
      name: args.name,
      color: args.color,
      surface: args.surface,
      x: args.x,
      y: args.y,
      hand: args.hand,
      updatedAt: now,
    };
    if (mine) await ctx.db.patch(mine._id, fields);
    else {
      await ctx.db.insert("perfumePresence", {
        benchKey: args.benchKey,
        clientId: args.clientId,
        ...fields,
      });
    }
  },
});

// ── queries ──────────────────────────────────────────────────────────────────

// Tabs: the party entry first, then every logged-in user's bench. Anonymous
// benches exist but never get a tab.
export const listBenches = query({
  args: {},
  handler: async (ctx) => {
    const benches = await ctx.db.query("perfumeBenches").collect();
    return [
      { benchKey: PARTY_KEY, ownerName: "Party", color: PARTY_COLOR },
      ...benches
        .filter((b) => b.ownerKey.startsWith("user:"))
        .map((b) => ({
          benchKey: b.ownerKey,
          ownerName: b.ownerName,
          color: b.color,
        })),
    ];
  },
});

// Spectating is open: any caller may read any bench. A bench that has not
// been created yet reads as an empty default snapshot (ensureBench persists
// it once the owner acts).
export const getBench = query({
  args: { benchKey: v.string() },
  handler: async (ctx, { benchKey }): Promise<BenchSnapshot> => {
    if (benchKey === PARTY_KEY) throw new Error("Use getParty for the party pot");
    const bench = await benchByOwner(ctx, benchKey);
    if (bench) return snapshotOf(bench);
    let ownerName = "Visitor";
    if (benchKey.startsWith("user:")) {
      const userId = ctx.db.normalizeId("users", benchKey.slice("user:".length));
      const user = userId ? await ctx.db.get(userId) : null;
      ownerName = user?.name ?? "User";
    } else if (!ANON_KEY.test(benchKey)) {
      throw new Error("Unknown bench");
    }
    return {
      benchKey,
      ownerName,
      color: colorFor(benchKey),
      pot: [],
      strikePlays: [],
      wildPlays: [],
      inventory: emptyInventory(),
      outputTray: {},
      ui: { ...DEFAULT_UI },
    };
  },
});

// The party pot as a BenchSnapshot so the same components render it; its
// inventory is always empty (contributions come from personal benches) and
// browse UI is local, so the snapshot carries defaults.
export const getParty = query({
  args: {},
  handler: async (ctx): Promise<BenchSnapshot> => {
    const party = await partyDoc(ctx);
    return {
      benchKey: PARTY_KEY,
      ownerName: "Party",
      color: PARTY_COLOR,
      pot: party?.items ?? [],
      strikePlays: party?.strikePlays ?? [],
      wildPlays: party?.wildPlays ?? [],
      inventory: emptyInventory(),
      outputTray: party?.outputTray ?? {},
      ui: { ...DEFAULT_UI },
    };
  },
});

export const presenceList = query({
  args: { benchKey: v.string() },
  handler: async (ctx, { benchKey }) => {
    const cutoff = Date.now() - PRESENCE_FRESH_MS;
    const rows = await ctx.db
      .query("perfumePresence")
      .withIndex("by_bench", (q) => q.eq("benchKey", benchKey))
      .collect();
    return rows
      .filter((row) => row.updatedAt > cutoff)
      .map((row) => ({
        clientId: row.clientId,
        name: row.name,
        color: row.color,
        surface: row.surface,
        x: row.x,
        y: row.y,
        hand: row.hand,
        updatedAt: row.updatedAt,
      }));
  },
});
