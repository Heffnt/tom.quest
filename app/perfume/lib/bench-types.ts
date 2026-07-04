// Shared contracts for the live bench (steps ②–⑤). See DESIGN.md.
// These types are the coordination surface between the input panel, cauldron,
// perfume panel, the bench stores (Convex/local), and the hand — change them
// only from the integrator seat.

import type { BrewState } from "./types";

// ── inventory ────────────────────────────────────────────────────────────────
// Counts keyed by catalog item key ("base:<name>" | "pure:<id>") for
// ingredients/pures, and by perfume key ("base:<perfume-id>") for perfumes.
export type Inventory = {
  ingredients: Record<string, number>;
  pures: Record<string, number>;
  perfumes: Record<string, number>;
};

export const EMPTY_INVENTORY: Inventory = Object.freeze({
  ingredients: {},
  pures: {},
  perfumes: {},
});

export function inventorySectionFor(itemKey: string): keyof Inventory {
  return itemKey.startsWith("pure:") ? "pures" : "ingredients";
}

// ── shared browse UI (mirrored across viewers of a bench) ────────────────────
export type SharedUI = {
  inputTab: "ingredients" | "frequencies";
  inputSearch: string;
  inputFilters: string[]; // frequency ids + "type:<t>" entries; AND semantics
  perfumeSearch: string;
  perfumeFilters: string[];
  expanded: string[]; // perfume keys with the recipes fold open
  pins: string[]; // owner-only writes
};

export const DEFAULT_UI: SharedUI = Object.freeze({
  inputTab: "ingredients",
  inputSearch: "",
  inputFilters: [],
  perfumeSearch: "",
  perfumeFilters: [],
  expanded: [],
  pins: [],
});

// ── the bench ────────────────────────────────────────────────────────────────
// ownerKey: "user:<convexUserId>" | "anon:<uuid>"; the party pot uses "party".
export type BenchKey = string;

// One item in the pot. Personal benches: contributor = the owner. Party pot:
// whoever tossed it in. `real=false` marks a hypothetical (beyond the
// contributor's stock) — visible, dashed, blocks brewing.
export type PotItem = {
  key: string; // catalog item key
  contributorKey: string;
  contributorName: string;
  real: boolean;
};

export type BenchSnapshot = {
  benchKey: BenchKey;
  ownerName: string;
  color: string;
  pot: PotItem[];
  strikePlays: string[];
  wildPlays: string[];
  inventory: Inventory;
  outputTray: Record<string, number>; // perfume key -> count
  ui: SharedUI;
};

// What the current viewer may do on the bench being shown (derived from the
// WHERE-not-WHAT rule; enforced server-side regardless).
export type BenchPermissions = {
  moveItems: boolean; // inventory<->brew moves and strike/wild plays
  brewAndTake: boolean; // complete brews, take output
  editInventory: boolean; // import, transfer, pins
  clearPot: boolean;
};

// Every mutation the UI needs; implemented by ConvexBenchStore and
// LocalBenchStore. All counts are >= 1. Implementations must be safe to call
// optimistically (no-throw on stale state; server reconciles).
export interface BenchActions {
  moveToBrew(itemKey: string, n: number): void;
  moveToInventory(itemKey: string, n: number): void;
  playStrike(freq: string): void;
  unplayStrike(freq: string): void;
  playWild(freq: string): void;
  unplayWild(freq: string): void;
  brewPerfume(perfumeKey: string, tuningIndex: number, k: number): void;
  takeOutput(perfumeKey: string, n: number): void;
  clearPot(): void;
  updateUI(patch: Partial<SharedUI>): void;
  importInventory(
    rows: { itemKey: string; count: number }[],
    mode: "merge" | "replace",
  ): void;
  transfer(toBenchKey: BenchKey, itemKey: string, n: number): void;
  setProfile(patch: { name?: string; color?: string }): void;
}

export type BenchStore = {
  snapshot: BenchSnapshot;
  permissions: BenchPermissions;
  actions: BenchActions;
};

// The engine-facing view of a snapshot (pot items expand to Ingredient[]).
export type BrewOf = (snap: BenchSnapshot) => BrewState;

// ── the hand ─────────────────────────────────────────────────────────────────
export type HandOrigin = "inventory" | "catalog" | "brew" | "output";

export type Hand = {
  itemKey: string; // catalog item key, or perfume key when from "output"
  count: number;
  from: HandOrigin;
  // true while the cursor is inside the cauldron panel and the stack is
  // committed to the brew (boundary rule)
  committed: boolean;
  x: number;
  y: number;
};

// Handlers the panels attach to any grabbable item. `available` caps how many
// more can be picked up from this source.
export interface HandApi {
  hand: Hand | null;
  // left-click / press: pick up one (or +1 onto a matching held stack)
  pickUp(itemKey: string, from: HandOrigin, available: number): void;
  // right-click while holding: return 1 to origin. Returns true if handled.
  returnOne(): boolean;
  // settle the whole stack at the current location (inside cauldron = stays
  // in brew; elsewhere = goes home)
  settle(): void;
  cancel(): void; // Esc / click-away: everything home
}

// ── presence ─────────────────────────────────────────────────────────────────
export type PresenceSurface = "input" | "stage" | "book";

export type PresenceEntry = {
  clientId: string;
  name: string;
  color: string;
  surface: PresenceSurface;
  x: number; // content-space: 0..1 of surface content width (stage: 0..100)
  y: number; // content-space: px from content top / 1000 (stage: 0..100)
  hand?: { key: string; count: number };
  updatedAt: number;
};

// ── import parsing (lib/inventory.ts) ────────────────────────────────────────
export type ImportRow = {
  line: string; // the raw input line
  count: number; // first number on the line, default 1
  // exact/confident match: the catalog key; null when unknown
  itemKey: string | null;
  // ranked fuzzy candidates when not confident (user accepts/corrects)
  guesses: { itemKey: string; name: string; score: number }[];
};
