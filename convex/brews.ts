// Multi-brew /perfume backend (Phase 2) — see app/perfume/DESIGN.md §§1–9.
//
// Built ADDITIVELY alongside convex/perfume.ts: the old single-bench API keeps
// compiling and its tests keep passing until Phase 3 swaps the frontend over and
// deletes the old tables. Vocabulary is enforced by DESIGN.md — brew (not bench),
// cauldron (not tray), member (not owner-profile), gift (not transfer). None of
// the DEAD WORDS (bench/pot/tuning/bottling) appear in new identifiers.
//
// Permission rule — "WHERE, not WHAT" (DESIGN.md §4 matrix): anyone identified
// may change WHERE a brew owner's items sit (moves, strike/wild plays, shared
// arrangement); only the owner (or admin) may change WHAT they own (fill from
// real stock, brew, take, gift, delete). Checks live in shared helpers below.
//
// Brew verification uses the shared engine (app/perfume/lib/engine) — the ONE
// implementation of combination equivalence + k-multiple matching. There is no
// re-implementation of the rules here.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { roleAccess, viewerDoc } from "./authRoles";
import { chargeTotals, evalReq } from "../app/perfume/lib/engine";
import {
  ALL_FREQUENCIES,
  baseIngredients,
  basePerfumes,
  fundamentals,
  pureIngredients,
} from "../app/perfume/data/base";
import type { BrewState, Ingredient, Perfume } from "../app/perfume/lib/types";

// A member is fresh (online activity indicator lit) if seen within this window.
const PRESENCE_FRESH_MS = 10_000;
const PRESENCE_SWEEP_MS = 15_000;
const MEMBER_FRESH_MS = 30_000;

// Bound on the per-(brew, member) undo/redo log.
const UNDO_LIMIT = 50;

// Bound on presence rows a single member may hold on one brew. A member has one
// cursor per open tab; past this the oldest is evicted so a hostile client can
// not flood a brew with unique-clientId heartbeats faster than the stale sweep
// clears them (DESIGN.md §9 — presence is per-brew cursor rows, not a firehose).
const PRESENCE_PER_MEMBER = 4;

// Top bar shows each member's most-recent brews plus a see-all count.
const RECENT_BREWS = 5;

const CATALOG: Record<string, Ingredient> = Object.fromEntries(
  [...baseIngredients, ...pureIngredients].map((i) => [i.key, i]),
);
const PERFUME_BY_ID: Record<string, Perfume> = Object.fromEntries(
  basePerfumes.map((p) => [p.key, p]),
);

// ── types ────────────────────────────────────────────────────────────────────

type BrewItem = Doc<"perfumeBrews">["items"][number];
type StrikePlay = Doc<"perfumeBrews">["strikePlays"][number];
type WildPlay = Doc<"perfumeBrews">["wildPlays"][number];

// ── identity ─────────────────────────────────────────────────────────────────

type Actor = { key: string; name: string; isAdmin: boolean };

// Membership is login-only (DESIGN.md §4). The caller must be a logged-in
// tom.quest user, keyed by their Convex id; a visitor (no auth) is rejected.
// The display name prefers the member's registered profile over the account
// name. Admin (Tom) is derived from users.role — never stored on the member row.
async function identify(ctx: QueryCtx | MutationCtx): Promise<Actor> {
  const user = await viewerDoc(ctx);
  if (!user) throw new Error("Sign in to join");
  const key = `user:${user._id}`;
  const member = await memberByKey(ctx, key);
  const isAdmin = roleAccess(user.role).isTom;
  return { key, name: member?.name ?? user.name ?? "User", isAdmin };
}

// ── permission helpers (mirror DESIGN.md §4 matrix) ──────────────────────────

// The party brew (owner === null) is everyone's table: brew/take/gift-scale
// actions are open to any member. An owned brew restricts WHAT to its owner (or
// admin).
function isParty(brew: Doc<"perfumeBrews">): boolean {
  return brew.owner === null;
}

// May the actor perform an owner-only (WHAT) action on this brew? Owner, party
// (anyone), or admin.
function mayOwnerAct(actor: Actor, brew: Doc<"perfumeBrews">): boolean {
  return isParty(brew) || actor.key === brew.owner || actor.isAdmin;
}

function requireOwnerAct(
  actor: Actor,
  brew: Doc<"perfumeBrews">,
  what: string,
): void {
  if (!mayOwnerAct(actor, brew)) {
    throw new Error(`Only the brew owner may ${what}`);
  }
}

// May the actor delete this brew? The owner or admin — never a random member,
// even on the party brew (only admin clears the party brew).
function requireDelete(actor: Actor, brew: Doc<"perfumeBrews">): void {
  const ok = actor.isAdmin || (!isParty(brew) && actor.key === brew.owner);
  if (!ok) throw new Error("Only the brew owner or admin may delete this brew");
}

// The member whose REAL stock a contribution draws from on this brew. On an
// owned brew that is always the owner (visitors move the owner's items); on the
// party brew each member contributes their own real stock, so it is the actor.
function stockOwnerFor(actor: Actor, brew: Doc<"perfumeBrews">): string {
  return isParty(brew) ? actor.key : (brew.owner as string);
}

// ── member helpers ───────────────────────────────────────────────────────────

async function memberByKey(
  ctx: QueryCtx | MutationCtx,
  memberKey: string,
): Promise<Doc<"perfumeMembers"> | null> {
  return await ctx.db
    .query("perfumeMembers")
    .withIndex("by_member", (q) => q.eq("memberKey", memberKey))
    .unique();
}

async function requireMember(
  ctx: MutationCtx,
  actor: Actor,
): Promise<Doc<"perfumeMembers">> {
  const member = await memberByKey(ctx, actor.key);
  if (!member) throw new Error("Join the party first");
  return member;
}

// The identify + requireMember prelude every acting mutation shares: resolve the
// logged-in caller and assert they have joined. Returns the Actor (the member
// row itself is not needed by the ~20 mutations that use this — callers that do
// need the row, e.g. setMemberIcon, keep the two-step form).
async function identifyMember(ctx: MutationCtx): Promise<Actor> {
  const actor = await identify(ctx);
  await requireMember(ctx, actor);
  return actor;
}

// Deterministic default color from the fundamentals' palette (same scheme as
// convex/perfume.ts colorFor).
function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return fundamentals[h % fundamentals.length].color;
}

// ── inventory helpers ────────────────────────────────────────────────────────

type InventoryDoc = Doc<"perfumeInventories">;

// Fungible stacks live in two sections only (perfumes are instances, not
// stacks). inventorySectionFor keys on the "pure:" prefix and never returns
// "perfumes" for an ingredient/pure key, but its return type includes it — so
// narrow here.
function stackSectionFor(itemKey: string): "ingredients" | "pures" {
  return itemKey.startsWith("pure:") ? "pures" : "ingredients";
}

async function inventoryByMember(
  ctx: QueryCtx | MutationCtx,
  memberKey: string,
): Promise<InventoryDoc | null> {
  return await ctx.db
    .query("perfumeInventories")
    .withIndex("by_member", (q) => q.eq("memberKey", memberKey))
    .unique();
}

async function ensureInventory(
  ctx: MutationCtx,
  memberKey: string,
): Promise<InventoryDoc> {
  const existing = await inventoryByMember(ctx, memberKey);
  if (existing) return existing;
  const id = await ctx.db.insert("perfumeInventories", {
    memberKey,
    ingredients: {},
    pures: {},
    perfumes: [],
    updatedAt: Date.now(),
  });
  return (await ctx.db.get(id))!;
}

function stackStockOf(inv: InventoryDoc, itemKey: string): number {
  return inv[stackSectionFor(itemKey)][itemKey] ?? 0;
}

// Returns a fresh {ingredients, pures} pair with n added (n may be negative);
// a stack that would drop to <=0 is removed.
function withStock(
  inv: InventoryDoc,
  itemKey: string,
  n: number,
): { ingredients: Record<string, number>; pures: Record<string, number> } {
  const ingredients = { ...inv.ingredients };
  const pures = { ...inv.pures };
  const section = stackSectionFor(itemKey) === "pures" ? pures : ingredients;
  const next = (section[itemKey] ?? 0) + n;
  if (next <= 0) delete section[itemKey];
  else section[itemKey] = next;
  return { ingredients, pures };
}

// ── brew helpers ─────────────────────────────────────────────────────────────

async function requireBrew(
  ctx: QueryCtx | MutationCtx,
  brewId: Id<"perfumeBrews">,
): Promise<Doc<"perfumeBrews">> {
  const brew = await ctx.db.get(brewId);
  if (!brew) throw new Error("Brew not found");
  return brew;
}

// Perfumes resting on the cauldron. PROD-SAFE: un-migrated prod rows carry the
// legacy `outputs` field instead of `cauldron` (see schema.ts). New code always
// writes `cauldron`; every read goes through here so pre-migration rows don't
// throw. The ship migration renames outputs→cauldron and drops `outputs`.
function restingOn(
  brew: Doc<"perfumeBrews">,
): NonNullable<Doc<"perfumeBrews">["cauldron"]> {
  return brew.cauldron ?? brew.outputs ?? [];
}

async function partyBrewDoc(
  ctx: QueryCtx | MutationCtx,
): Promise<Doc<"perfumeBrews"> | null> {
  return await ctx.db
    .query("perfumeBrews")
    .withIndex("by_owner", (q) => q.eq("owner", null))
    .first();
}

// The common fields of a freshly-inserted brew: an empty graph, no plays, no
// pin, an empty cauldron, and matching timestamps. Callers spread this and set
// `owner`/`seq` (and, for copyBrew, override items/plays/pinned).
function newBrewFields(now: number): {
  nickname: string | null;
  items: BrewItem[];
  strikePlays: StrikePlay[];
  wildPlays: WildPlay[];
  pinned: Doc<"perfumeBrews">["pinned"];
  cauldron: Doc<"perfumeBrews">["cauldron"];
  createdAt: number;
  updatedAt: number;
} {
  return {
    nickname: null,
    items: [],
    strikePlays: [],
    wildPlays: [],
    pinned: null,
    cauldron: [],
    createdAt: now,
    updatedAt: now,
  };
}

async function ensurePartyBrew(
  ctx: MutationCtx,
): Promise<Doc<"perfumeBrews">> {
  const existing = await partyBrewDoc(ctx);
  if (existing) return existing;
  const now = Date.now();
  const id = await ctx.db.insert("perfumeBrews", {
    owner: null,
    seq: 0,
    ...newBrewFields(now),
  });
  return (await ctx.db.get(id))!;
}

// The next per-owner sequence number, powering the default name
// "{owner} brew {n}". The party brew keeps seq 0.
async function nextSeq(ctx: MutationCtx, owner: string): Promise<number> {
  const last = await ctx.db
    .query("perfumeBrews")
    .withIndex("by_owner_seq", (q) => q.eq("owner", owner))
    .order("desc")
    .first();
  return (last?.seq ?? 0) + 1;
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

// Every real frequency id (9 fundamentals + 17 named). Strike/wild plays and
// carried plays must name one of these — junk ids would otherwise enter the
// shared tally the whole party sees (they can never match a recipe, but they
// corrupt shared state and waste charge slots). Mirrors pinPerfume validating
// its perfumeId against the catalog.
const VALID_FREQUENCIES = new Set<string>(ALL_FREQUENCIES.map((f) => f.id));

function requireFrequency(freq: string): string {
  if (!VALID_FREQUENCIES.has(freq)) throw new Error(`Unknown frequency: ${freq}`);
  return freq;
}

function brewIngredients(items: BrewItem[]): Ingredient[] {
  return items.map((p) => requireIngredient(p.key));
}

// Project the structured plays down to the flat frequency lists the engine
// consumes: a strike play IS its struck frequency; a wild play IS its chosen
// frequency. The engine never sees who played what.
function strikeFreqs(plays: StrikePlay[]): string[] {
  return plays.map((p) => p.freq);
}
function wildFreqs(plays: WildPlay[]): string[] {
  return plays.map((p) => p.chosenFreq);
}

function brewState(brew: Doc<"perfumeBrews">): BrewState {
  return {
    ingredients: brewIngredients(brew.items),
    strikePlays: strikeFreqs(brew.strikePlays),
    wildPlays: wildFreqs(brew.wildPlays),
  };
}

// Removing items can strand strike/wild plays past the charges the remaining
// items grant — trim from the end so the state the engine sees stays legal.
function trimPlays(
  items: BrewItem[],
  strikePlays: StrikePlay[],
  wildPlays: WildPlay[],
): { strikePlays: StrikePlay[]; wildPlays: WildPlay[] } {
  const totals = chargeTotals(brewIngredients(items));
  return {
    strikePlays: strikePlays.slice(0, Math.max(0, totals.strike)),
    wildPlays: wildPlays.slice(0, Math.max(0, totals.wild)),
  };
}

// Move n copies of itemKey into `items`, drawing real stock from `inv`: stock
// first flips an existing hypothetical of that key to real (the only conversion
// path), else backs a fresh real item; past stock the copies enter hypothetical
// (real: false). Mutates `items` in place; returns the fresh inventory stacks.
function addToBrew(
  items: BrewItem[],
  inv: InventoryDoc,
  itemKey: string,
  n: number,
  contributorKey: string,
  realFromStock: boolean,
): {
  ingredients: Record<string, number>;
  pures: Record<string, number>;
  real: number;
  hypothetical: number;
  converted: number;
} {
  const ingredients = { ...inv.ingredients };
  const pures = { ...inv.pures };
  const isPure = stackSectionFor(itemKey) === "pures";
  const section = isPure ? pures : ingredients;
  let real = 0;
  let hypothetical = 0;
  let converted = 0;
  for (let i = 0; i < n; i++) {
    if (realFromStock && (section[itemKey] ?? 0) > 0) {
      section[itemKey] -= 1;
      if (section[itemKey] <= 0) delete section[itemKey];
      const idx = items.findIndex((p) => p.key === itemKey && !p.real);
      if (idx >= 0) {
        items[idx] = { key: itemKey, contributorKey, real: true };
        converted++;
      } else {
        items.push({ key: itemKey, contributorKey, real: true });
        real++;
      }
    } else {
      items.push({ key: itemKey, contributorKey, real: false });
      hypothetical++;
    }
  }
  return { ingredients, pures, real, hypothetical, converted };
}

// Credit a set of REAL brew items back to their contributors' inventories,
// grouped by (contributorKey, itemKey). The single core behind the
// return-items-to-owners step in moveItemToInventory, returnIngredients, and
// emptyBrew (hypotheticals own no stock and are never passed here).
async function creditContributors(
  ctx: MutationCtx,
  realItems: BrewItem[],
  now: number,
): Promise<void> {
  const byContributor = new Map<string, Map<string, number>>();
  for (const item of realItems) {
    const forKey =
      byContributor.get(item.contributorKey) ?? new Map<string, number>();
    forKey.set(item.key, (forKey.get(item.key) ?? 0) + 1);
    byContributor.set(item.contributorKey, forKey);
  }
  for (const [contributorKey, counts] of byContributor) {
    const inv = await ensureInventory(ctx, contributorKey);
    let ingredients = { ...inv.ingredients };
    let pures = { ...inv.pures };
    for (const [itemKey, count] of counts) {
      const next = withStock({ ...inv, ingredients, pures }, itemKey, count);
      ingredients = next.ingredients;
      pures = next.pures;
    }
    await ctx.db.patch(inv._id, { ingredients, pures, updatedAt: now });
  }
}

// Remove up to n copies of itemKey from `items` — hypotheticals first (the junk
// blocking the brew), then real newest-first. Mutates `items`; returns the
// removed REAL items (hypotheticals just vanish) grouped for crediting home.
function removeFromBrew(
  items: BrewItem[],
  itemKey: string,
  n: number,
): BrewItem[] {
  const removedReal: BrewItem[] = [];
  let remaining = n;
  for (const wantReal of [false, true]) {
    for (let i = items.length - 1; i >= 0 && remaining > 0; i--) {
      if (items[i].key !== itemKey || items[i].real !== wantReal) continue;
      const [item] = items.splice(i, 1);
      if (item.real) removedReal.push(item);
      remaining--;
    }
  }
  return removedReal;
}

// A short unique id for perfume instances (no crypto in the Convex runtime is
// needed — timestamp + counter suffices for uniqueness within a mutation).
let instanceCounter = 0;
function newInstanceId(): string {
  instanceCounter = (instanceCounter + 1) & 0xffff;
  return `inst:${Date.now().toString(36)}:${instanceCounter.toString(36)}:${Math.floor(
    Math.random() * 0xffffff,
  ).toString(36)}`;
}

// ── brew verification (engine — no re-implementation) ────────────────────────

// Resolve a base perfume by id (existence check) — the validation behind
// pinPerfume (a pin names a target perfume, no recipe index) and the base of
// requireRecipe.
function requirePerfume(perfumeId: string): Perfume {
  const perfume = PERFUME_BY_ID[perfumeId];
  if (!perfume) throw new Error(`Unknown perfume: ${perfumeId}`);
  return perfume;
}

// Resolve a perfume and validate a requirement index against its recipes — the
// shared validation behind verifyBrew. `reqIndex` keeps the `req` abbreviation
// (DESIGN.md §1: it names a position in `recipes`, not the concept).
function requireRecipe(perfumeId: string, reqIndex: number): Perfume {
  const perfume = requirePerfume(perfumeId);
  if (
    !Number.isInteger(reqIndex) ||
    reqIndex < 0 ||
    reqIndex >= perfume.recipes.length
  ) {
    throw new Error(`Invalid recipe index: ${reqIndex}`);
  }
  return perfume;
}

// Requires every item real and the effective tally perfect at exactly the
// claimed recipe and copy-count. Mirrors convex/perfume.ts verifyBrew, reading
// the new structured plays.
function verifyBrew(
  brew: Doc<"perfumeBrews">,
  perfumeId: string,
  recipeIndex: number,
  k: number,
): Perfume {
  const perfume = requireRecipe(perfumeId, recipeIndex);
  requireCount(k, "copy count");
  if (brew.items.length === 0) throw new Error("The brew is empty");
  const hypos = brew.items.filter((p) => !p.real);
  if (hypos.length > 0) {
    const counts = new Map<string, number>();
    for (const p of hypos) counts.set(p.key, (counts.get(p.key) ?? 0) + 1);
    const parts = [...counts].map(
      ([key, count]) => `${count}× ${CATALOG[key]?.name ?? key}`,
    );
    throw new Error(
      `Cannot brew: ${parts.join(", ")} ${
        hypos.length === 1 ? "is" : "are"
      } hypothetical`,
    );
  }
  const result = evalReq(
    brewState(brew),
    perfume.recipes[recipeIndex],
    recipeIndex,
  );
  if (result.status !== "perfect" || result.k !== k) {
    throw new Error(`This brew does not brew ${perfume.name} ×${k}`);
  }
  return perfume;
}

// ── shared arrangement cores (WHERE actions; forward + undo share these) ──────

// The move core behind moveItemToBrew/moveItemToInventory AND their undo/redo
// replay (applyStored) — there is no parallel reverse implementation.
//   toBrew: draw n copies from the stock owner's inventory into the brew (the
//     stock owner IS the contributor — the same member on both an owned brew
//     (the owner) and the party brew (the actor), so ONE variable serves both).
//     Non-owners on an owned brew may not spend the owner's stock (drawReal is
//     false), so their copies enter hypothetical.
//   toInventory: remove n copies (hypotheticals first), crediting removed REAL
//     items home and trimming plays past the surviving charge budget.
// Callers validate (count, ingredient) and log undo; doMove only moves.
async function doMove(
  ctx: MutationCtx,
  brew: Doc<"perfumeBrews">,
  actor: Actor,
  itemKey: string,
  n: number,
  dir: "toBrew" | "toInventory",
): Promise<void> {
  const now = Date.now();
  if (dir === "toBrew") {
    const stockOwner = stockOwnerFor(actor, brew);
    const drawReal = actor.isAdmin || actor.key === stockOwner;
    const inv = await ensureInventory(ctx, stockOwner);
    const items = [...brew.items];
    const moved = addToBrew(items, inv, itemKey, n, stockOwner, drawReal);
    await ctx.db.patch(inv._id, {
      ingredients: moved.ingredients,
      pures: moved.pures,
      updatedAt: now,
    });
    await ctx.db.patch(brew._id, { items, updatedAt: now });
  } else {
    const items = [...brew.items];
    const removedReal = removeFromBrew(items, itemKey, n);
    await creditContributors(ctx, removedReal, now);
    const plays = trimPlays(items, brew.strikePlays, brew.wildPlays);
    await ctx.db.patch(brew._id, { items, ...plays, updatedAt: now });
  }
}

// strike and wild plays are the same mechanic over two fields: one core, keyed
// by `kind`. A strike play IS its `freq`; a wild play IS its `chosenFreq`; the
// shared `freq` argument carries whichever the kind names.
type PlayKind = "strike" | "wild";

function chargeBudget(kind: PlayKind, items: BrewItem[]): number {
  const totals = chargeTotals(brewIngredients(items));
  return kind === "strike" ? totals.strike : totals.wild;
}

function playFreqOf(kind: PlayKind, play: StrikePlay | WildPlay): string {
  return kind === "strike"
    ? (play as StrikePlay).freq
    : (play as WildPlay).chosenFreq;
}

function lastPlayIndex(
  kind: PlayKind,
  plays: (StrikePlay | WildPlay)[],
  freq: string,
): number {
  for (let i = plays.length - 1; i >= 0; i--) {
    if (playFreqOf(kind, plays[i]) === freq) return i;
  }
  return -1;
}

// Write the play list back to the field the kind names (typed branch keeps the
// patch shape exact — Convex validators reject a computed-key patch).
async function patchPlays(
  ctx: MutationCtx,
  brewId: Id<"perfumeBrews">,
  kind: PlayKind,
  plays: (StrikePlay | WildPlay)[],
): Promise<void> {
  const now = Date.now();
  if (kind === "strike") {
    await ctx.db.patch(brewId, { strikePlays: plays as StrikePlay[], updatedAt: now });
  } else {
    await ctx.db.patch(brewId, { wildPlays: plays as WildPlay[], updatedAt: now });
  }
}

// Play one strike/wild if the brew's granted charges allow; over-budget is a
// silent no-op (stale optimistic clients reconcile). Returns whether it played,
// so callers push an undo entry ONLY for a real play. Serves both the forward
// mutations and undo/redo replay.
async function doPlay(
  ctx: MutationCtx,
  brew: Doc<"perfumeBrews">,
  kind: PlayKind,
  freq: string,
  byKey: string,
): Promise<boolean> {
  const plays = kind === "strike" ? brew.strikePlays : brew.wildPlays;
  if (plays.length >= chargeBudget(kind, brew.items)) return false;
  const added: StrikePlay | WildPlay =
    kind === "strike"
      ? { freq, byMemberKey: byKey }
      : { chosenFreq: freq, byMemberKey: byKey };
  await patchPlays(ctx, brew._id, kind, [...plays, added]);
  return true;
}

// The inverse of doPlay: remove the most-recent play naming `freq`. Un-playing a
// frequency that is not played is a silent no-op. Returns whether it removed one.
async function doUnplay(
  ctx: MutationCtx,
  brew: Doc<"perfumeBrews">,
  kind: PlayKind,
  freq: string,
): Promise<boolean> {
  const plays = kind === "strike" ? brew.strikePlays : brew.wildPlays;
  const idx = lastPlayIndex(kind, plays, freq);
  if (idx < 0) return false;
  await patchPlays(ctx, brew._id, kind, plays.toSpliced(idx, 1));
  return true;
}

// ── undo/redo log (per brew, per member; arrangement actions only) ───────────

// Reversible arrangement actions. Brewing, taking, and gifting are NEVER logged
// (DESIGN.md §5) — they are permanent.
type UndoAction =
  | { kind: "move"; itemKey: string; n: number; dir: "toBrew" | "toInventory" }
  | { kind: "strike"; freq: string; on: boolean }
  | { kind: "wild"; chosenFreq: string; on: boolean }
  | { kind: "pin"; before: Doc<"perfumeBrews">["pinned"]; after: Doc<"perfumeBrews">["pinned"] };

async function pushUndo(
  ctx: MutationCtx,
  brewId: Id<"perfumeBrews">,
  memberKey: string,
  action: UndoAction["kind"],
  payload: unknown,
  inverse: unknown,
): Promise<void> {
  // A fresh forward action invalidates the redo stack: drop this member's
  // undone (done=false) entries on this brew, then append.
  const entries = await ctx.db
    .query("perfumeUndo")
    .withIndex("by_brew_member", (q) =>
      q.eq("brewId", brewId).eq("memberKey", memberKey),
    )
    .collect();
  for (const e of entries) if (!e.done) await ctx.db.delete(e._id);
  const done = entries
    .filter((e) => e.done)
    .sort((a, b) => a.seq - b.seq);
  const seq = (done.length ? done[done.length - 1].seq : 0) + 1;
  await ctx.db.insert("perfumeUndo", {
    brewId,
    memberKey,
    seq,
    action,
    payload,
    inverse,
    done: true,
    at: Date.now(),
  });
  // Bound the log: prune the oldest DONE entries past UNDO_LIMIT (the new row
  // included, so drop `done.length + 1 - UNDO_LIMIT` from the front).
  const overflow = done.length + 1 - UNDO_LIMIT;
  for (let i = 0; i < overflow; i++) await ctx.db.delete(done[i]._id);
}

// ── shared validators ────────────────────────────────────────────────────────

const brewIdArg = v.id("perfumeBrews");

// ── member lifecycle ─────────────────────────────────────────────────────────

// A logged-in tom.quest user becomes a member by clicking to join. Idempotent:
// re-joining refreshes lastSeen and returns the existing row.
export const registerMember = mutation({
  args: { name: v.optional(v.string()), color: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const actor = await identify(ctx);
    const now = Date.now();
    const existing = await memberByKey(ctx, actor.key);
    if (existing) {
      const patch: Partial<Doc<"perfumeMembers">> = { lastSeenAt: now };
      if (args.name !== undefined && args.name.trim()) patch.name = args.name.trim();
      if (args.color !== undefined) patch.color = args.color;
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    const id = await ctx.db.insert("perfumeMembers", {
      memberKey: actor.key,
      name: args.name?.trim() || actor.name,
      color: args.color ?? colorFor(actor.key),
      registeredAt: now,
      lastSeenAt: now,
    });
    await ensureInventory(ctx, actor.key);
    // The party brew exists from the moment there is a party (DESIGN.md §4).
    await ensurePartyBrew(ctx);
    return id;
  },
});

// A member may remove THEMSELVES at any time (DESIGN.md §4). Their owned brews
// are handed to no one — they are deleted; the party brew is untouched.
export const leaveParty = mutation({
  args: {},
  handler: async (ctx) => {
    const actor = await identify(ctx);
    await removeMemberByKey(ctx, actor.key);
  },
});

// Admin (Tom) may remove ANY member and delete their brews (DESIGN.md §4).
export const removeMember = mutation({
  args: { memberKey: v.string() },
  handler: async (ctx, { memberKey }) => {
    const actor = await identify(ctx);
    if (!actor.isAdmin) throw new Error("Only admin may remove another member");
    await removeMemberByKey(ctx, memberKey);
  },
});

// Shared removal: deletes the member row, their owned brews, and their
// inventory. The party brew and other members are untouched. Idempotent.
async function removeMemberByKey(
  ctx: MutationCtx,
  memberKey: string,
): Promise<void> {
  const member = await memberByKey(ctx, memberKey);
  if (member) await ctx.db.delete(member._id);
  const owned = await ctx.db
    .query("perfumeBrews")
    .withIndex("by_owner", (q) => q.eq("owner", memberKey))
    .collect();
  for (const brew of owned) await deleteBrewRow(ctx, brew._id);
  const inv = await inventoryByMember(ctx, memberKey);
  if (inv) await ctx.db.delete(inv._id);
}

// Storage upload flow: the client asks for a short-lived upload URL, PUTs the
// image, then calls setMemberIcon with the returned storageId.
export const generateIconUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await identify(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const setMemberIcon = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    const actor = await identify(ctx);
    const member = await requireMember(ctx, actor);
    // Replace any prior icon so storage does not leak.
    if (member.iconStorageId && member.iconStorageId !== storageId) {
      await ctx.storage.delete(member.iconStorageId);
    }
    await ctx.db.patch(member._id, { iconStorageId: storageId });
  },
});

// Presence + activity heartbeat. Upserts the caller's cursor on a brew (by
// clientId), refreshes their member lastSeen, and opportunistically sweeps
// cursor rows stale past PRESENCE_SWEEP_MS for the same brew.
export const heartbeat = mutation({
  args: {
    brewId: brewIdArg,
    clientId: v.string(),
    color: v.string(),
    surface: v.union(v.literal("input"), v.literal("stage"), v.literal("book")),
    x: v.number(),
    y: v.number(),
    hand: v.optional(v.object({ key: v.string(), count: v.number() })),
  },
  handler: async (ctx, args) => {
    const actor = await identify(ctx);
    const now = Date.now();
    const member = await memberByKey(ctx, actor.key);
    if (member) await ctx.db.patch(member._id, { lastSeenAt: now });
    const rows = await ctx.db
      .query("perfumeBrewPresence")
      .withIndex("by_brew", (q) => q.eq("brewId", args.brewId))
      .collect();
    let mine: Doc<"perfumeBrewPresence"> | null = null;
    // Track this member's OTHER surviving rows on the brew so a flood of unique
    // clientIds cannot grow the table without bound (the stale sweep alone
    // never fires on fresh rows). Newest-first.
    const minesurvivors: Doc<"perfumeBrewPresence">[] = [];
    for (const row of rows) {
      if (row.clientId === args.clientId) {
        mine = row;
        continue;
      }
      if (row.updatedAt < now - PRESENCE_SWEEP_MS) {
        await ctx.db.delete(row._id);
        continue;
      }
      if (row.memberKey === actor.key) minesurvivors.push(row);
    }
    const fields = {
      memberKey: actor.key,
      name: member?.name ?? actor.name,
      color: args.color,
      surface: args.surface,
      x: args.x,
      y: args.y,
      hand: args.hand,
      updatedAt: now,
    };
    if (mine) await ctx.db.patch(mine._id, fields);
    else {
      // Cap this member's rows on this brew: evict their oldest until inserting
      // one more stays within PRESENCE_PER_MEMBER.
      minesurvivors.sort((a, b) => b.updatedAt - a.updatedAt);
      for (let i = minesurvivors.length - 1; i >= PRESENCE_PER_MEMBER - 1; i--) {
        await ctx.db.delete(minesurvivors[i]._id);
      }
      await ctx.db.insert("perfumeBrewPresence", {
        brewId: args.brewId,
        clientId: args.clientId,
        ...fields,
      });
    }
  },
});

// ── brew lifecycle ───────────────────────────────────────────────────────────

// Create a new empty brew owned by the caller, with a fresh per-owner seq.
export const createBrew = mutation({
  args: { nickname: v.optional(v.string()) },
  handler: async (ctx, { nickname }) => {
    const actor = await identifyMember(ctx);
    const now = Date.now();
    const id = await ctx.db.insert("perfumeBrews", {
      owner: actor.key,
      seq: await nextSeq(ctx, actor.key),
      ...newBrewFields(now),
      nickname: nickname?.trim() || null,
    });
    return id;
  },
});

// Copy another brew's CONTENTS as all-hypothetical into a fresh brew the copier
// owns (DESIGN.md §4: "copies start hypothetical; the copier fills from their
// own inventory"). Plays are carried; pin is carried; the cauldron is NOT (it
// belongs to the source). The copier gets a fresh per-owner seq.
export const copyBrew = mutation({
  args: { brewId: brewIdArg },
  handler: async (ctx, { brewId }) => {
    const actor = await identifyMember(ctx);
    const src = await requireBrew(ctx, brewId);
    const now = Date.now();
    const items: BrewItem[] = src.items.map((p) => ({
      key: p.key,
      real: false, // copies start hypothetical
      contributorKey: actor.key,
    }));
    // Re-attribute plays to the copier so they own the arrangement they
    // receive. Drop any play naming an unknown frequency (defence in depth: a
    // corrupted source must not seed junk into the copy's shared tally), then
    // trim to the copied items' charge budget so the plays <= granted-charges
    // invariant holds from the start, not only after the next move/trim.
    const trimmed = trimPlays(
      items,
      src.strikePlays.filter((p) => VALID_FREQUENCIES.has(p.freq)),
      src.wildPlays.filter((p) => VALID_FREQUENCIES.has(p.chosenFreq)),
    );
    const strikePlays = trimmed.strikePlays.map((p) => ({
      freq: p.freq,
      byMemberKey: actor.key,
    }));
    const wildPlays = trimmed.wildPlays.map((p) => ({
      chosenFreq: p.chosenFreq,
      byMemberKey: actor.key,
    }));
    const id = await ctx.db.insert("perfumeBrews", {
      owner: actor.key,
      seq: await nextSeq(ctx, actor.key),
      ...newBrewFields(now),
      items,
      strikePlays,
      wildPlays,
      pinned: src.pinned,
    });
    return id;
  },
});

// Explicit ownership handoff (DESIGN.md §4). Only the current owner (or admin)
// may hand off; the party brew has no owner to hand off. Ownership travels with
// the object — its items' contributor attribution is left as-is (history).
export const handoffBrew = mutation({
  args: { brewId: brewIdArg, toMemberKey: v.string() },
  handler: async (ctx, { brewId, toMemberKey }) => {
    const actor = await identify(ctx);
    const brew = await requireBrew(ctx, brewId);
    if (isParty(brew)) throw new Error("The party brew has no owner to hand off");
    requireOwnerAct(actor, brew, "hand off this brew");
    const target = await memberByKey(ctx, toMemberKey);
    if (!target) throw new Error("Handoff target is not a member");
    await ctx.db.patch(brew._id, { owner: toMemberKey, updatedAt: Date.now() });
  },
});

export const deleteBrew = mutation({
  args: { brewId: brewIdArg },
  handler: async (ctx, { brewId }) => {
    const actor = await identify(ctx);
    const brew = await requireBrew(ctx, brewId);
    requireDelete(actor, brew);
    await deleteBrewRow(ctx, brewId);
  },
});

// Delete a brew and its dependent undo/presence rows. Does NOT return the
// brew's real items to inventory — DESIGN.md has no such rule for deletion, and
// "Return ingredients" is the explicit control for that. Callers wanting return
// call returnIngredients first.
async function deleteBrewRow(
  ctx: MutationCtx,
  brewId: Id<"perfumeBrews">,
): Promise<void> {
  const undos = await ctx.db
    .query("perfumeUndo")
    .withIndex("by_brew_member", (q) => q.eq("brewId", brewId))
    .collect();
  for (const u of undos) await ctx.db.delete(u._id);
  const presence = await ctx.db
    .query("perfumeBrewPresence")
    .withIndex("by_brew", (q) => q.eq("brewId", brewId))
    .collect();
  for (const p of presence) await ctx.db.delete(p._id);
  await ctx.db.delete(brewId);
}

// ANY member may nickname ANY brew (DESIGN.md §4 — nicknames are not
// owner-restricted). Blank clears back to the default "{owner} brew {n}".
export const nicknameBrew = mutation({
  args: { brewId: brewIdArg, nickname: v.string() },
  handler: async (ctx, { brewId, nickname }) => {
    await identifyMember(ctx);
    const brew = await requireBrew(ctx, brewId);
    await ctx.db.patch(brew._id, {
      nickname: nickname.trim() || null,
      updatedAt: Date.now(),
    });
  },
});

// Pin exactly ONE target PERFUME to a brew (DESIGN.md §5). The pin lives on the
// brew so everyone viewing it sees the ghost nodes; the engine's closest path
// picks which recipe of that perfume to steer toward, so no recipe index is
// stored. Per the §4 permission matrix pinning changes shared brew state, so it
// is an owner-act: allowed on your own brew, on the party brew, or by admin —
// NOT on another member's owned brew. Undoable.
export const pinPerfume = mutation({
  args: {
    brewId: brewIdArg,
    perfumeId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { brewId, perfumeId }) => {
    const actor = await identifyMember(ctx);
    const brew = await requireBrew(ctx, brewId);
    requireOwnerAct(actor, brew, "pin a perfume");
    if (perfumeId) requirePerfume(perfumeId);
    const pinned = perfumeId ? { perfumeId } : null;
    const before = brew.pinned;
    await ctx.db.patch(brew._id, { pinned, updatedAt: Date.now() });
    await pushUndo(
      ctx,
      brewId,
      actor.key,
      "pin",
      { pinned },
      { pinned: before },
    );
  },
});

// ── item moves (WHERE — open to any member per the matrix) ───────────────────

// Add n copies into the brew. Real copies draw from the STOCK OWNER's real
// stock (owner on an owned brew; the caller on the party brew) — non-owners on
// an owned brew get hypotheticals only, since they may not touch the owner's
// stock. Owner/party callers draw real; excess enters hypothetical.
export const moveItemToBrew = mutation({
  args: { brewId: brewIdArg, itemKey: v.string(), n: v.number() },
  handler: async (ctx, { brewId, itemKey, n }) => {
    const actor = await identifyMember(ctx);
    requireCount(n, "count");
    requireIngredient(itemKey);
    const brew = await requireBrew(ctx, brewId);
    await doMove(ctx, brew, actor, itemKey, n, "toBrew");
    await pushUndo(
      ctx,
      brewId,
      actor.key,
      "move",
      { itemKey, n, dir: "toBrew" },
      { itemKey, n, dir: "toInventory" },
    );
  },
});

// Remove n copies from the brew — hypotheticals first, then real newest-first.
// Real items return to their CONTRIBUTOR's inventory; hypotheticals vanish.
export const moveItemToInventory = mutation({
  args: { brewId: brewIdArg, itemKey: v.string(), n: v.number() },
  handler: async (ctx, { brewId, itemKey, n }) => {
    const actor = await identifyMember(ctx);
    requireCount(n, "count");
    const brew = await requireBrew(ctx, brewId);
    await doMove(ctx, brew, actor, itemKey, n, "toInventory");
    await pushUndo(
      ctx,
      brewId,
      actor.key,
      "move",
      { itemKey, n, dir: "toInventory" },
      { itemKey, n, dir: "toBrew" },
    );
  },
});

// ── strike / wild plays (WHERE — open to any member) ─────────────────────────

// Playing past the brew's granted charges is a silent no-op (stale optimistic
// clients reconcile), as is un-playing a frequency that is not played. Plays
// record WHO played them so per-member undo can target its own.
export const playStrike = mutation({
  args: { brewId: brewIdArg, freq: v.string() },
  handler: async (ctx, { brewId, freq }) => {
    const actor = await identifyMember(ctx);
    requireFrequency(freq);
    const brew = await requireBrew(ctx, brewId);
    if (await doPlay(ctx, brew, "strike", freq, actor.key)) {
      await pushUndo(ctx, brewId, actor.key, "strike", { freq, on: true }, { freq, on: false });
    }
  },
});

export const unplayStrike = mutation({
  args: { brewId: brewIdArg, freq: v.string() },
  handler: async (ctx, { brewId, freq }) => {
    const actor = await identifyMember(ctx);
    const brew = await requireBrew(ctx, brewId);
    if (await doUnplay(ctx, brew, "strike", freq)) {
      await pushUndo(ctx, brewId, actor.key, "strike", { freq, on: false }, { freq, on: true });
    }
  },
});

export const playWild = mutation({
  args: { brewId: brewIdArg, chosenFreq: v.string() },
  handler: async (ctx, { brewId, chosenFreq }) => {
    const actor = await identifyMember(ctx);
    requireFrequency(chosenFreq);
    const brew = await requireBrew(ctx, brewId);
    if (await doPlay(ctx, brew, "wild", chosenFreq, actor.key)) {
      await pushUndo(ctx, brewId, actor.key, "wild", { chosenFreq, on: true }, { chosenFreq, on: false });
    }
  },
});

export const unplayWild = mutation({
  args: { brewId: brewIdArg, chosenFreq: v.string() },
  handler: async (ctx, { brewId, chosenFreq }) => {
    const actor = await identifyMember(ctx);
    const brew = await requireBrew(ctx, brewId);
    if (await doUnplay(ctx, brew, "wild", chosenFreq)) {
      await pushUndo(ctx, brewId, actor.key, "wild", { chosenFreq, on: false }, { chosenFreq, on: true });
    }
  },
});

// ── brew-scale controls (DESIGN.md §5) ───────────────────────────────────────

// Fill from inventory: turn every hypothetical in the brew real, drawing from
// the relevant inventory (the owner's on an owned brew; each contributor's on
// the party brew). A hypothetical with no backing stock stays hypothetical.
export const fillFromInventory = mutation({
  args: { brewId: brewIdArg },
  handler: async (ctx, { brewId }) => {
    const actor = await identifyMember(ctx);
    const brew = await requireBrew(ctx, brewId);
    requireOwnerAct(actor, brew, "fill this brew");
    const items = [...brew.items];
    const now = Date.now();
    // Group hypotheticals by the inventory they draw from: the owner's on an
    // owned brew, otherwise each hypothetical's own contributor.
    const invCache = new Map<string, InventoryDoc>();
    const getInv = async (key: string): Promise<InventoryDoc> => {
      const cached = invCache.get(key);
      if (cached) return cached;
      const inv = await ensureInventory(ctx, key);
      invCache.set(key, inv);
      return inv;
    };
    let filled = 0;
    for (let i = 0; i < items.length; i++) {
      if (items[i].real) continue;
      const drawKey = isParty(brew) ? items[i].contributorKey : (brew.owner as string);
      const inv = await getInv(drawKey);
      if (stackStockOf(inv, items[i].key) <= 0) continue;
      const stacks = withStock(inv, items[i].key, -1);
      const patched: InventoryDoc = { ...inv, ...stacks };
      invCache.set(drawKey, patched);
      items[i] = { ...items[i], real: true };
      filled++;
    }
    for (const inv of invCache.values()) {
      await ctx.db.patch(inv._id, {
        ingredients: inv.ingredients,
        pures: inv.pures,
        updatedAt: now,
      });
    }
    await ctx.db.patch(brew._id, { items, updatedAt: now });
    return { filled };
  },
});

// Return ingredients: return every REAL item in the brew to its contributor's
// inventory, leaving hypotheticals in place (they own no stock).
export const returnIngredients = mutation({
  args: { brewId: brewIdArg },
  handler: async (ctx, { brewId }) => {
    const actor = await identifyMember(ctx);
    const brew = await requireBrew(ctx, brewId);
    requireOwnerAct(actor, brew, "return this brew's ingredients");
    const now = Date.now();
    const remaining = brew.items.filter((it) => !it.real);
    await creditContributors(ctx, brew.items.filter((it) => it.real), now);
    const plays = trimPlays(remaining, brew.strikePlays, brew.wildPlays);
    await ctx.db.patch(brew._id, { items: remaining, ...plays, updatedAt: now });
  },
});

// Empty brew: clear all items and plays. Real items are RETURNED to their
// contributors first (conservation — no mutation destroys items except
// brewing), then the brew is left empty.
export const emptyBrew = mutation({
  args: { brewId: brewIdArg },
  handler: async (ctx, { brewId }) => {
    const actor = await identifyMember(ctx);
    const brew = await requireBrew(ctx, brewId);
    requireOwnerAct(actor, brew, "empty this brew");
    const now = Date.now();
    await creditContributors(ctx, brew.items.filter((it) => it.real), now);
    await ctx.db.patch(brew._id, {
      items: [],
      strikePlays: [],
      wildPlays: [],
      updatedAt: now,
    });
  },
});

// ── brewing (WHAT — owner or party; engine-verified) ─────────────────────────

// Brew: verify via the engine (k-multiples), reject if any hypothetical is
// present, consume the owner's real ingredients FOREVER, replace each consumed
// real item in place with its hypothetical twin (the graph describes a plan
// after completion), and append k perfume instances to the cauldron with
// brewedBy = the caller and witnesses = members with live presence on this brew.
export const brew = mutation({
  args: {
    brewId: brewIdArg,
    perfumeId: v.string(),
    recipeIndex: v.number(),
    k: v.number(),
  },
  handler: async (ctx, { brewId, perfumeId, recipeIndex, k }) => {
    const actor = await identifyMember(ctx);
    const brewDoc = await requireBrew(ctx, brewId);
    requireOwnerAct(actor, brewDoc, "brew");
    verifyBrew(brewDoc, perfumeId, recipeIndex, k);
    const now = Date.now();
    // Consume real ingredients forever: each real item becomes its hypothetical
    // twin in place (same key/contributor, real=false). No inventory is
    // credited — consumption is permanent (DESIGN.md §3).
    const items: BrewItem[] = brewDoc.items.map((p) =>
      p.real ? { ...p, real: false } : p,
    );
    // Witnesses: members with fresh presence on this brew at completion.
    const witnesses = await liveMemberKeys(ctx, brewId, now);
    // Flat provenance (DESIGN.md §1,§9): the perfume records who brewed it and
    // who witnessed it — no ownership chain.
    const instance = {
      instanceId: newInstanceId(),
      perfumeId,
      count: k,
      brewedByKey: actor.key,
      witnesses,
      brewedAt: now,
    };
    await ctx.db.patch(brewDoc._id, {
      items,
      cauldron: [...restingOn(brewDoc), instance],
      updatedAt: now,
    });
    return { instanceId: instance.instanceId };
  },
});

// Members with fresh presence on the brew — the witness set at completion.
async function liveMemberKeys(
  ctx: MutationCtx,
  brewId: Id<"perfumeBrews">,
  now: number,
): Promise<string[]> {
  const rows = await ctx.db
    .query("perfumeBrewPresence")
    .withIndex("by_brew", (q) => q.eq("brewId", brewId))
    .collect();
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.updatedAt > now - PRESENCE_FRESH_MS) keys.add(row.memberKey);
  }
  return [...keys];
}

// Take a perfume instance off the cauldron into the taker's inventory. The
// perfume keeps its original flat provenance ({brewedBy, witnesses}) — taking
// does NOT extend an ownership chain. Owner-only on an owned brew; anyone on the
// party brew. Taking is permanent (not undoable). A count>1 instance splits:
// one copy is taken, the rest stay on the cauldron.
export const takeFromCauldron = mutation({
  args: { brewId: brewIdArg, instanceId: v.string() },
  handler: async (ctx, { brewId, instanceId }) => {
    const actor = await identifyMember(ctx);
    const brew = await requireBrew(ctx, brewId);
    requireOwnerAct(actor, brew, "take from the cauldron");
    const resting_ = restingOn(brew);
    const idx = resting_.findIndex((o) => o.instanceId === instanceId);
    if (idx < 0) throw new Error("No such perfume on the cauldron");
    const resting = resting_[idx];
    const now = Date.now();
    const cauldron = [...resting_];
    if (resting.count > 1) cauldron[idx] = { ...resting, count: resting.count - 1 };
    else cauldron.splice(idx, 1);
    await ctx.db.patch(brew._id, { cauldron, updatedAt: now });
    // Append a fresh perfume instance to the taker's inventory, carrying the
    // brew's flat provenance unchanged (no ownership chain).
    const inv = await ensureInventory(ctx, actor.key);
    const perfumes = [
      ...inv.perfumes,
      {
        instanceId: newInstanceId(),
        perfumeId: resting.perfumeId,
        brewedByKey: resting.brewedByKey,
        witnesses: resting.witnesses,
        brewedAt: resting.brewedAt,
      },
    ];
    await ctx.db.patch(inv._id, { perfumes, updatedAt: now });
  },
});

// ── inventory import (WHAT — own stock declaration; not a gift) ──────────────

// Declare the caller's OWN fungible stock from a client-parsed sheet. Ports the
// old bench importInventory exactly: owner-only (a member may only rewrite their
// OWN inventory), each row validated (unknown item → throw; count must be a
// non-negative integer), and mode chooses whether to REPLACE the whole stack set
// or MERGE additively onto the current stacks. This is a stock declaration, not
// a transfer — no gift event is written and no other member's inventory is
// touched. Only fungible stacks (ingredients + pures) are declarable; perfumes
// are provenance-bearing instances, never stack counts, so they are not imported.
export const importInventory = mutation({
  args: {
    rows: v.array(v.object({ key: v.string(), count: v.number() })),
    mode: v.union(v.literal("merge"), v.literal("replace")),
  },
  handler: async (ctx, { rows, mode }) => {
    // Owner-only: a member imports onto their OWN inventory. identifyMember is
    // the identity gate — the caller is by construction the owner of the row
    // they write, so there is no cross-member target to authorize.
    const actor = await identifyMember(ctx);
    for (const row of rows) {
      if (!CATALOG[row.key]) throw new Error(`Unknown item: ${row.key}`);
      if (!Number.isInteger(row.count) || row.count < 0) {
        throw new Error(`Invalid count for ${row.key}: ${row.count}`);
      }
    }
    const inv = await ensureInventory(ctx, actor.key);
    // replace starts from empty stacks; merge keeps the current ones.
    const ingredients: Record<string, number> =
      mode === "replace" ? {} : { ...inv.ingredients };
    const pures: Record<string, number> =
      mode === "replace" ? {} : { ...inv.pures };
    for (const row of rows) {
      if (row.count === 0) continue;
      const section = stackSectionFor(row.key) === "pures" ? pures : ingredients;
      section[row.key] = (section[row.key] ?? 0) + row.count;
    }
    await ctx.db.patch(inv._id, { ingredients, pures, updatedAt: Date.now() });
  },
});

// ── gifting (WHAT — own items; instant; permanent) ───────────────────────────

// Gift a stack of an ingredient/pure to another member: instant, moves counts
// only — there is NO gift history (DESIGN.md §1). The sender must own the stock;
// sending more than held is rejected (no clamping).
export const giftItem = mutation({
  args: { toMemberKey: v.string(), itemKey: v.string(), n: v.number() },
  handler: async (ctx, { toMemberKey, itemKey, n }) => {
    const actor = await identifyMember(ctx);
    requireCount(n, "count");
    if (toMemberKey === actor.key) throw new Error("Cannot gift to yourself");
    if (!CATALOG[itemKey]) throw new Error(`Unknown item: ${itemKey}`);
    const target = await memberByKey(ctx, toMemberKey);
    if (!target) throw new Error("Gift target is not a member");
    const from = await ensureInventory(ctx, actor.key);
    if (stackStockOf(from, itemKey) < n) {
      throw new Error(`Not enough ${itemKey} to gift`);
    }
    const to = await ensureInventory(ctx, toMemberKey);
    const now = Date.now();
    const fromStacks = withStock(from, itemKey, -n);
    await ctx.db.patch(from._id, { ...fromStacks, updatedAt: now });
    const toStacks = withStock(to, itemKey, n);
    await ctx.db.patch(to._id, { ...toStacks, updatedAt: now });
  },
});

// Gift a perfume INSTANCE to another member. The perfume keeps its original flat
// provenance ({brewedBy, witnesses}) — gifting does NOT extend an ownership
// chain. The instance moves whole (perfumes are not fungible). Permanent.
export const giftPerfume = mutation({
  args: { toMemberKey: v.string(), instanceId: v.string() },
  handler: async (ctx, { toMemberKey, instanceId }) => {
    const actor = await identifyMember(ctx);
    if (toMemberKey === actor.key) throw new Error("Cannot gift to yourself");
    const target = await memberByKey(ctx, toMemberKey);
    if (!target) throw new Error("Gift target is not a member");
    const from = await ensureInventory(ctx, actor.key);
    const idx = from.perfumes.findIndex((p) => p.instanceId === instanceId);
    if (idx < 0) throw new Error("You do not hold that perfume");
    const now = Date.now();
    const [instance] = from.perfumes.slice(idx, idx + 1);
    const fromPerfumes = from.perfumes.filter((_, i) => i !== idx);
    await ctx.db.patch(from._id, { perfumes: fromPerfumes, updatedAt: now });
    const to = await ensureInventory(ctx, toMemberKey);
    // The instance moves whole, keeping its original flat provenance; no
    // ownership chain is extended (and any legacy `owners` field is not carried).
    await ctx.db.patch(to._id, {
      perfumes: [
        ...to.perfumes,
        {
          instanceId: instance.instanceId,
          perfumeId: instance.perfumeId,
          brewedByKey: instance.brewedByKey,
          witnesses: instance.witnesses,
          brewedAt: instance.brewedAt,
        },
      ],
      updatedAt: now,
    });
  },
});

// ── undo / redo (per member, per brew; arrangement actions only) ─────────────

// Undo the caller's most recent DONE action on this brew; redo the most recent
// UNDONE one. Only arrangement actions are logged (moves, strike/wild, pin) —
// brewing, taking, gifting are never undoable (DESIGN.md §5). The two directions
// are ONE parametrized step differing only by: scan order (newest-first to undo,
// oldest-first to redo), which entries are eligible (done vs undone), which
// stored arg is applied (the inverse vs the forward payload), and the done-flag
// to write back. Applying does NOT push a new undo entry — we flip the flag.
async function stepHistory(
  ctx: MutationCtx,
  brewId: Id<"perfumeBrews">,
  actor: Actor,
  dir: "undo" | "redo",
): Promise<boolean> {
  const undoing = dir === "undo";
  const entries = await ctx.db
    .query("perfumeUndo")
    .withIndex("by_brew_member", (q) =>
      q.eq("brewId", brewId).eq("memberKey", actor.key),
    )
    .order(undoing ? "desc" : "asc")
    .collect();
  const entry = entries.find((e) => e.done === undoing);
  if (!entry) return false;
  await applyStored(ctx, brewId, actor, entry.action, undoing ? entry.inverse : entry.payload);
  await ctx.db.patch(entry._id, { done: !undoing });
  return true;
}

export const undo = mutation({
  args: { brewId: brewIdArg },
  handler: async (ctx, { brewId }) => {
    const actor = await identifyMember(ctx);
    return { undone: await stepHistory(ctx, brewId, actor, "undo") };
  },
});

export const redo = mutation({
  args: { brewId: brewIdArg },
  handler: async (ctx, { brewId }) => {
    const actor = await identifyMember(ctx);
    return { redone: await stepHistory(ctx, brewId, actor, "redo") };
  },
});

// Apply a stored arrangement action (forward for redo, inverse for undo) by
// REPLAYING it through the same doMove/doPlay cores the forward mutations use —
// there is no parallel reverse implementation. The caller flips the entry's
// done flag; nothing here logs a new undo entry.
async function applyStored(
  ctx: MutationCtx,
  brewId: Id<"perfumeBrews">,
  actor: Actor,
  action: string,
  arg: unknown,
): Promise<void> {
  const brew = await requireBrew(ctx, brewId);
  if (action === "move") {
    const a = arg as { itemKey: string; n: number; dir: "toBrew" | "toInventory" };
    await doMove(ctx, brew, actor, a.itemKey, a.n, a.dir);
    return;
  }
  if (action === "strike" || action === "wild") {
    const a = arg as { freq?: string; chosenFreq?: string; on: boolean };
    const freq = action === "strike" ? a.freq! : a.chosenFreq!;
    if (a.on) await doPlay(ctx, brew, action, freq, actor.key);
    else await doUnplay(ctx, brew, action, freq);
    return;
  }
  if (action === "pin") {
    const a = arg as { pinned: Doc<"perfumeBrews">["pinned"] };
    await ctx.db.patch(brew._id, { pinned: a.pinned, updatedAt: Date.now() });
    return;
  }
}

// ── queries ──────────────────────────────────────────────────────────────────

// All members with an activity-freshness flag for the online indicator.
export const listMembers = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const members = await ctx.db.query("perfumeMembers").collect();
    // The client can never resolve a storageId to a servable URL — only the
    // Convex runtime can (ctx.storage.getUrl). Resolve each uploaded icon here so
    // avatars render the image; members with no icon carry a null url.
    return await Promise.all(
      members.map(async (m) => ({
        memberKey: m.memberKey,
        name: m.name,
        color: m.color,
        iconStorageId: m.iconStorageId ?? null,
        iconUrl: m.iconStorageId
          ? await ctx.storage.getUrl(m.iconStorageId)
          : null,
        registeredAt: m.registeredAt,
        lastSeenAt: m.lastSeenAt,
        fresh: m.lastSeenAt > now - MEMBER_FRESH_MS,
      })),
    );
  },
});

// Top-bar data: brews grouped by member with YOU first, each member's most
// recent RECENT_BREWS plus a total count, and the party brew alongside. Callers
// unable to identify still see the grouping (viewerKey null → no "you first").
export const listBrews = query({
  args: {},
  handler: async (ctx) => {
    let viewerKey: string | null = null;
    try {
      viewerKey = (await identify(ctx)).key;
    } catch {
      viewerKey = null;
    }
    const all = await ctx.db.query("perfumeBrews").collect();
    const party = all.find((b) => b.owner === null) ?? null;
    const owned = all.filter((b) => b.owner !== null);
    const byOwner = new Map<string, Doc<"perfumeBrews">[]>();
    for (const b of owned) {
      const key = b.owner as string;
      (byOwner.get(key) ?? byOwner.set(key, []).get(key)!).push(b);
    }
    const members = await ctx.db.query("perfumeMembers").collect();
    const nameOf = new Map(members.map((m) => [m.memberKey, m.name]));
    const groups = [...byOwner.entries()].map(([ownerKey, brews]) => {
      const sorted = [...brews].sort((a, b) => b.updatedAt - a.updatedAt);
      return {
        ownerKey,
        ownerName: nameOf.get(ownerKey) ?? ownerKey,
        total: sorted.length,
        recent: sorted.slice(0, RECENT_BREWS).map(brewSummary),
      };
    });
    // You first, then the rest by most-recent activity.
    groups.sort((a, b) => {
      if (a.ownerKey === viewerKey) return -1;
      if (b.ownerKey === viewerKey) return 1;
      const at = a.recent[0]?.updatedAt ?? 0;
      const bt = b.recent[0]?.updatedAt ?? 0;
      return bt - at;
    });
    return {
      party: party ? brewSummary(party) : null,
      groups,
    };
  },
});

// The see-all popover opens older brews past the RECENT_BREWS listBrews returns.
// This returns ALL of one member's brews, most-recent first, as the same brew
// summaries — so a member with many brews can reach the ones the top bar trims.
// Reading is open (spectating); the party brew (owner null) is never a member's.
export const listAllBrews = query({
  args: { memberKey: v.string() },
  handler: async (ctx, { memberKey }) => {
    const brews = await ctx.db
      .query("perfumeBrews")
      .withIndex("by_owner", (q) => q.eq("owner", memberKey))
      .collect();
    return brews
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(brewSummary);
  },
});

// A brew's default name is "{owner} brew {n}" (n = seq); the nickname overrides.
function brewSummary(brew: Doc<"perfumeBrews">) {
  return {
    brewId: brew._id,
    owner: brew.owner,
    nickname: brew.nickname,
    seq: brew.seq,
    itemCount: brew.items.length,
    hasHypotheticals: brew.items.some((p) => !p.real),
    cauldronCount: restingOn(brew).reduce((n, o) => n + o.count, 0),
    // The pin is a target PERFUME now (DESIGN.md §5); any legacy `recipeIndex`
    // on un-migrated rows is ignored — normalize to the {perfumeId} shape.
    pinned: brew.pinned ? { perfumeId: brew.pinned.perfumeId } : null,
    updatedAt: brew.updatedAt,
  };
}

// A brew by id, for deep links (/perfume/b/[id]). Reading is open to anyone;
// permission gates only mutations. A bad deep link — a malformed id string or an
// id pointing at a deleted/nonexistent brew — resolves to `null` rather than
// throwing, so the client can show a graceful "brew not found" state instead of
// crashing the whole route. `brewId` is a plain string here (not v.id) precisely
// so a malformed value reaches this handler to be normalized, instead of being
// rejected by the arg validator (which would throw into useQuery during render).
export const getBrew = query({
  args: { brewId: v.string() },
  handler: async (ctx, { brewId }) => {
    const id = ctx.db.normalizeId("perfumeBrews", brewId);
    if (!id) return null;
    return await ctx.db.get(id);
  },
});

// The party brew doc (or null before it is first created).
export const getPartyBrew = query({
  args: {},
  handler: async (ctx) => await partyBrewDoc(ctx),
});

// A member's inventory. Reading is open (spectating). A member with no
// inventory row yet reads as empty.
export const getInventory = query({
  args: { memberKey: v.string() },
  handler: async (ctx, { memberKey }) => {
    const inv = await inventoryByMember(ctx, memberKey);
    if (inv) return inv;
    return {
      memberKey,
      ingredients: {} as Record<string, number>,
      pures: {} as Record<string, number>,
      perfumes: [] as InventoryDoc["perfumes"],
      updatedAt: 0,
    };
  },
});

// Live presence rows on a brew (stage cursors + witness feed). Only fresh rows;
// a cursor off-stage keeps its frozen last position until it ages out.
export const presenceList = query({
  args: { brewId: brewIdArg },
  handler: async (ctx, { brewId }) => {
    const cutoff = Date.now() - PRESENCE_FRESH_MS;
    const rows = await ctx.db
      .query("perfumeBrewPresence")
      .withIndex("by_brew", (q) => q.eq("brewId", brewId))
      .collect();
    return rows
      .filter((row) => row.updatedAt > cutoff)
      .map((row) => ({
        clientId: row.clientId,
        memberKey: row.memberKey,
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

// Whether the caller can undo/redo on a brew (drives the toolbar affordances).
export const undoState = query({
  args: { brewId: brewIdArg },
  handler: async (ctx, { brewId }) => {
    let key: string | null = null;
    try {
      key = (await identify(ctx)).key;
    } catch {
      return { canUndo: false, canRedo: false };
    }
    const entries = await ctx.db
      .query("perfumeUndo")
      .withIndex("by_brew_member", (q) =>
        q.eq("brewId", brewId).eq("memberKey", key!),
      )
      .collect();
    return {
      canUndo: entries.some((e) => e.done),
      canRedo: entries.some((e) => !e.done),
    };
  },
});

