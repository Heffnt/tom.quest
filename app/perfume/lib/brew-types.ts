// Shared contracts for the multi-brew /perfume data layer. See DESIGN.md
// §§1,4,5,9. This is the coordination surface between the brew stores
// (Convex/local), the center-stage brew graph, and the panels — the vocabulary
// here is binding (brew/member/cauldron/gift, never bench/pot/tuning).

// ── inventory ────────────────────────────────────────────────────────────────
// A held perfume instance (DESIGN.md §9 "Perfumes are instances"): its
// provenance travels with it — who brewed it, who witnessed it, when, and the
// ownership chain (oldest→newest) as it was gifted between members. This is the
// inventory counterpart to OutputInstance (which rests on the cauldron); the two
// feed the SAME provenance tooltip (lib/provenance.ts).
export type PerfumeInstance = {
  instanceId: string;
  perfumeId: string;
  brewedByKey: string;
  witnesses: string[];
  brewedAt: number;
  owners: OwnerHop[]; // ownership chain oldest→newest
};

// Fungible-stack counts keyed by catalog item key ("base:<name>" | "pure:<id>").
// Perfumes are NOT stacks in the multi-brew model (they are instances); the
// `perfumes` section here is the projected COUNT view the legacy input panel
// still renders, derived from `perfumeInstances` — which is kept ALONGSIDE it so
// the panels can surface each instance's provenance on hover (DESIGN.md §1,§9).
export type Inventory = {
  ingredients: Record<string, number>;
  pures: Record<string, number>;
  perfumes: Record<string, number>;
  perfumeInstances: PerfumeInstance[];
};

export const EMPTY_INVENTORY: Inventory = Object.freeze({
  ingredients: {},
  pures: {},
  perfumes: {},
  perfumeInstances: [],
});

// The count-bearing inventory sections (the fungible-stack records). This is a
// strict subset of `keyof Inventory` — it EXCLUDES `perfumeInstances` (an array,
// not a count record), so anything indexing `inv[section][itemKey]` types
// against a StackSection, never the whole key set.
export type StackSection = "ingredients" | "pures" | "perfumes";

export function inventorySectionFor(itemKey: string): StackSection {
  return itemKey.startsWith("pure:") ? "pures" : "ingredients";
}

// ── shared browse UI (mirrored across viewers of a brew) ─────────────────────
// The pin lives on the brew object (DESIGN.md §5), so it is NOT part of the
// shared browse UI here — `pins` is gone; use BrewSnapshot.pinned.
export type SharedUI = {
  inputTab: "ingredients" | "frequencies";
  inputSearch: string;
  inputFilters: string[]; // frequency ids + "type:<t>" entries; AND semantics
  perfumeSearch: string;
  perfumeFilters: string[];
  expanded: string[]; // perfume keys with the recipes fold open
};

export const DEFAULT_UI: SharedUI = Object.freeze({
  inputTab: "ingredients",
  inputSearch: "",
  inputFilters: [],
  perfumeSearch: "",
  perfumeFilters: [],
  expanded: [],
});

// ── members ──────────────────────────────────────────────────────────────────
// A registered member, with the activity freshness the online indicator reads.
// memberKey follows the "user:<id>" convention (membership is login-only).
export type MemberInfo = {
  memberKey: string;
  name: string;
  color: string;
  iconStorageId: string | null; // uploaded icon, if any
  iconUrl: string | null; // server-resolved servable URL for iconStorageId
  registeredAt: number;
  lastSeenAt: number;
  fresh: boolean; // lastSeen within the activity window (server-computed)
};

// ── brews grouped by member (top bar) ────────────────────────────────────────
// A brew's default name is "{owner} brew {seq}"; nickname overrides it.
export type BrewSummary = {
  brewId: string;
  owner: string | null; // memberKey, or null for the party brew
  nickname: string | null;
  seq: number;
  itemCount: number;
  hasHypotheticals: boolean;
  cauldronCount: number;
  pinned: PinnedPerfume;
  updatedAt: number;
};

// One member's brews for the top bar: their 5 most recent plus the total count.
export type BrewGroup = {
  ownerKey: string;
  ownerName: string;
  total: number;
  recent: BrewSummary[];
};

// The whole top bar: brews grouped by member (you first, server-ordered) with
// the party brew alongside.
export type BrewIndex = {
  party: BrewSummary | null;
  groups: BrewGroup[];
};

// ── the open brew ────────────────────────────────────────────────────────────
export type BrewKey = string; // a brew id, or the "party" sentinel client-side

// One item in the brew graph. contributor is who tossed it in (the owner on an
// owned brew, whoever added it on the party brew). real=false marks a
// hypothetical (beyond the contributor's stock) — visible, dashed, blocks
// brewing.
export type BrewItem = {
  key: string; // catalog item key
  contributorKey: string;
  contributorName: string;
  real: boolean;
};

// A strike play: the struck frequency, and who played it (per-member undo).
export type StrikePlay = { freq: string; byMemberKey: string };
// A wild play: the chosen frequency, and who played it.
export type WildPlay = { chosenFreq: string; byMemberKey: string };

// The pinned PERFUME lives on the brew (everyone viewing sees the ghost nodes).
// A pin names a target perfume; the engine's closest path picks which recipe of
// it to steer toward (DESIGN.md §5), so no recipe index is stored.
export type PinnedPerfume = { perfumeId: string } | null;

// One ownership hop in a perfume instance's chain, oldest→newest.
export type OwnerHop = { key: string; at: number };

// A perfume instance resting on the cauldron until taken. Provenance travels
// with it: who brewed it, who witnessed it, and its ownership chain.
export type OutputInstance = {
  instanceId: string;
  perfumeId: string;
  count: number;
  brewedByKey: string;
  witnesses: string[]; // memberKeys present at completion
  brewedAt: number;
  provenance: OwnerHop[];
};

// The open brew as the UI reads it.
export type BrewSnapshot = {
  brewId: string;
  owner: string | null; // memberKey | null (party brew)
  ownerName: string; // "Party" for the party brew
  nickname: string | null;
  seq: number;
  isParty: boolean;
  items: BrewItem[];
  strikePlays: StrikePlay[];
  wildPlays: WildPlay[];
  pinned: PinnedPerfume;
  outputs: OutputInstance[];
  ui: SharedUI; // browse UI (client-local in the multi-brew model)
};

// ── per-user undo/redo ───────────────────────────────────────────────────────
export type UndoState = { canUndo: boolean; canRedo: boolean };

// ── permissions (DESIGN.md §4 matrix; server-enforced regardless) ────────────
// WHERE-not-WHAT: moveItems is open to any member on any brew; the WHAT gates
// (fill/brew/take/gift/pin/delete) restrict to the owner (or admin), and the
// party brew opens the WHAT gates to everyone. A visitor (not registered) gets
// everything false — read-only.
export type BrewPermissions = {
  registered: boolean; // the viewer is a member (may act at all)
  moveItems: boolean; // inventory<->brew moves and strike/wild plays
  brewAndTake: boolean; // complete brews, take output
  fillReturn: boolean; // fill-from-inventory / return / empty
  gift: boolean; // gift own items
  pin: boolean; // pin a perfume
  nickname: boolean; // any member may nickname any brew
  manageBrew: boolean; // copy/handoff/delete this brew (owner or admin)
  isAdmin: boolean; // Tom
};

export const NO_BREW_PERMISSIONS: BrewPermissions = Object.freeze({
  registered: false,
  moveItems: false,
  brewAndTake: false,
  fillReturn: false,
  gift: false,
  pin: false,
  nickname: false,
  manageBrew: false,
  isAdmin: false,
});

// ── the action surface both stores implement ─────────────────────────────────
// All counts are >= 1. Implementations must be safe to call optimistically
// (no-throw on stale state; the server reconciles). Actions targeting a member
// other than the viewer (gift, handoff) take a memberKey.
export interface BrewActions {
  // arrangement (WHERE)
  moveToBrew(itemKey: string, n: number): void;
  moveToInventory(itemKey: string, n: number): void;
  playStrike(freq: string): void;
  unplayStrike(freq: string): void;
  playWild(chosenFreq: string): void;
  unplayWild(chosenFreq: string): void;
  // brew-scale controls (DESIGN.md §5)
  fillFromInventory(): void;
  returnIngredients(): void;
  emptyBrew(): void;
  // brewing / taking (WHAT — permanent)
  brew(perfumeId: string, recipeIndex: number, k: number): void;
  takeOutput(instanceId: string): void;
  // gifting (WHAT — instant, permanent)
  giftItem(toMemberKey: string, itemKey: string, n: number): void;
  giftPerfume(toMemberKey: string, instanceId: string): void;
  // pin (one target perfume per brew, on the brew object)
  pinPerfume(pinned: PinnedPerfume): void;
  // per-user undo/redo (own moves only)
  undo(): void;
  redo(): void;
  // brew lifecycle
  createBrew(nickname?: string): Promise<string | null>;
  copyBrew(brewId: string): Promise<string | null>;
  handoffBrew(brewId: string, toMemberKey: string): void;
  deleteBrew(brewId: string): void;
  nicknameBrew(brewId: string, nickname: string): void;
  // membership
  register(name?: string, color?: string): void;
  leave(): void;
  setColor(color: string): void;
  // inventory import (own inventory)
  importInventory(
    rows: { itemKey: string; count: number }[],
    mode: "merge" | "replace",
  ): void;
  // shared browse UI (client-local)
  updateUI(patch: Partial<SharedUI>): void;
}

// ── presence (stage-scoped cursors, with last-known freeze) ──────────────────
export type PresenceSurface = "input" | "stage" | "book";

// A presence row for the open brew. `stale` marks a cursor that has aged past
// the fresh window: the data layer keeps returning it (frozen at its last
// position) rather than dropping it, so the stage can hold the cursor in place
// per DESIGN.md §6 instead of vanishing it.
export type PresenceEntry = {
  clientId: string;
  memberKey: string;
  name: string;
  color: string;
  surface: PresenceSurface;
  x: number;
  y: number;
  hand?: { key: string; count: number };
  updatedAt: number;
  stale: boolean;
};

// ── import parsing (lib/inventory.ts) ────────────────────────────────────────
export type ImportRow = {
  line: string; // the raw input line
  count: number; // first number on the line, default 1
  itemKey: string | null; // exact/confident match: the catalog key; null when unknown
  guesses: { itemKey: string; name: string; score: number }[];
};
