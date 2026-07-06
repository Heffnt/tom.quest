"use client";

// The two BrewStore implementations (DESIGN.md §§4,9). Both hand the client an
// identical { members, index, snapshot, permissions, actions, presence, undo }
// so the panels never know which world they are in.
//
// - useConvexBrewStore(brewKey) renders any brew (or the party brew) live
//   through convex/brews.ts: reactive queries + mutations, optimistic where the
//   old bench store was optimistic (browse UI is client-local here).
// - useLocalBrewStore() is the ?local=1 practice bench — pure client state
//   persisted to localStorage, a single practice member, brews verified with
//   the same engine, no network.
//
// The item/inventory transforms in the local store deliberately mirror
// convex/brews.ts (stock flips hypotheticals real before adding, removals take
// hypotheticals first then real newest-first, plays trim to the recomputed
// charge cap) so optimistic local behavior and the server never disagree.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { BrewState, Ingredient } from "./types";
import {
  DEFAULT_UI,
  EMPTY_INVENTORY,
  NO_BREW_PERMISSIONS,
  inventorySectionFor,
  type BrewActions,
  type BrewIndex,
  type BrewItem,
  type BrewPermissions,
  type BrewSnapshot,
  type Inventory,
  type MemberInfo,
  type OutputInstance,
  type PinnedRecipe,
  type PresenceEntry,
  type SharedUI,
  type StrikePlay,
  type UndoState,
  type WildPlay,
} from "./brew-types";
import { chargeTotals, evalReq } from "./engine";
import { baseIngredients, basePerfumes, pureIngredients } from "../data/base";

// The client sentinel for the party brew — resolved to the real party brew id
// by the Convex store; a no-op in the local store (there is no party locally).
export const PARTY_KEY = "party";
const LOCAL_KEY = "pf:local-brew:v1";
const LOCAL_MEMBER = "local";
const LOCAL_BREW_ID = "local-brew";
// A cursor kept (frozen) past freshness but dropped once this stale window
// elapses — see PresenceEntry.stale.
const PRESENCE_STALE_MS = 60_000;

// ── catalog lookups ──────────────────────────────────────────────────────────

const CATALOG = new Map<string, Ingredient>(
  [...baseIngredients, ...pureIngredients].map((i) => [i.key, i]),
);
const PERFUME_BY_KEY = new Map(basePerfumes.map((p) => [p.key, p]));

export const isIngredientKey = (key: string): boolean => CATALOG.has(key);

// Ingredient and perfume keys share the "base:" prefix but never collide.
export function sectionForKey(itemKey: string): keyof Inventory {
  return PERFUME_BY_KEY.has(itemKey) ? "perfumes" : inventorySectionFor(itemKey);
}

/** Display name + color for anything the hand or a cursor can hold. */
export function itemInfo(itemKey: string): { name: string; color: string } {
  const ing = CATALOG.get(itemKey);
  if (ing) return { name: ing.name, color: ing.color };
  const perfume = PERFUME_BY_KEY.get(itemKey);
  if (perfume) return { name: perfume.name, color: "#6FE3C4" };
  return { name: itemKey.replace(/^base:/, ""), color: "#6FE3C4" };
}

// ── snapshot derivations (shared by the adapter and the client) ──────────────

/** The engine view of a brew: items expand to Ingredient[] — hypotheticals
 * INCLUDED (they count in the tally; brewing is what they block). */
export function brewEngineState(snap: BrewSnapshot): BrewState {
  return {
    ingredients: snap.items
      .map((p) => CATALOG.get(p.key))
      .filter((i): i is Ingredient => !!i),
    strikePlays: snap.strikePlays.map((p) => p.freq),
    wildPlays: snap.wildPlays.map((p) => p.chosenFreq),
  };
}

/** Copies of each catalog key in the brew (hypotheticals included). */
export function itemCounts(items: BrewItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of items) out[p.key] = (out[p.key] ?? 0) + 1;
  return out;
}

/** Brew blockers from unreal items, phrased like the server's rejection. */
export function hypotheticalBlockers(items: BrewItem[]): string[] {
  const counts = new Map<string, number>();
  for (const p of items) {
    if (!p.real) counts.set(p.key, (counts.get(p.key) ?? 0) + 1);
  }
  return [...counts].map(
    ([key, n]) =>
      `${n}× ${itemInfo(key).name} ${n === 1 ? "is" : "are"} hypothetical`,
  );
}

/** Perfume-key -> total count resting on the cauldron (the legacy tray view). */
export function outputCounts(outputs: OutputInstance[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of outputs) out[o.perfumeId] = (out[o.perfumeId] ?? 0) + o.count;
  return out;
}

// ── shared item/inventory transforms (mirror convex/brews.ts) ────────────────

function stockOf(inv: Inventory, itemKey: string): number {
  return inv[sectionForKey(itemKey)][itemKey] ?? 0;
}

function addStock(inv: Inventory, itemKey: string, n: number): void {
  const section = inv[sectionForKey(itemKey)];
  const next = (section[itemKey] ?? 0) + n;
  if (next <= 0) delete section[itemKey];
  else section[itemKey] = next;
}

function cloneInventory(inv: Inventory): Inventory {
  return {
    ingredients: { ...inv.ingredients },
    pures: { ...inv.pures },
    perfumes: { ...inv.perfumes },
  };
}

function itemIngredients(items: BrewItem[]): Ingredient[] {
  return items
    .map((p) => CATALOG.get(p.key))
    .filter((i): i is Ingredient => !!i);
}

function trimPlays(
  items: BrewItem[],
  strikePlays: StrikePlay[],
  wildPlays: WildPlay[],
): { strikePlays: StrikePlay[]; wildPlays: WildPlay[] } {
  const totals = chargeTotals(itemIngredients(items));
  return {
    strikePlays: strikePlays.slice(0, Math.max(0, totals.strike)),
    wildPlays: wildPlays.slice(0, Math.max(0, totals.wild)),
  };
}

// Stock first flips existing hypotheticals of the key to real, then backs new
// real items; past stock the copies enter as hypotheticals.
function addToBrew(
  items: BrewItem[],
  inv: Inventory,
  itemKey: string,
  n: number,
  contributorKey: string,
  contributorName: string,
): void {
  for (let i = 0; i < n; i++) {
    if (stockOf(inv, itemKey) > 0) {
      addStock(inv, itemKey, -1);
      const idx = items.findIndex((p) => p.key === itemKey && !p.real);
      if (idx >= 0) {
        items[idx] = { key: itemKey, contributorKey, contributorName, real: true };
      } else {
        items.push({ key: itemKey, contributorKey, contributorName, real: true });
      }
    } else {
      items.push({ key: itemKey, contributorKey, contributorName, real: false });
    }
  }
}

// Hypotheticals first, then real newest-first; returns how many REAL copies
// came out (they go back to stock — hypotheticals just vanish).
function removeFromBrew(items: BrewItem[], itemKey: string, n: number): number {
  let removedReal = 0;
  let remaining = n;
  for (const wantReal of [false, true]) {
    for (let i = items.length - 1; i >= 0 && remaining > 0; i--) {
      if (items[i].key !== itemKey || items[i].real !== wantReal) continue;
      if (items[i].real) removedReal++;
      items.splice(i, 1);
      remaining--;
    }
  }
  return removedReal;
}

// ── the store contract both hooks return ─────────────────────────────────────

export type BrewStoreResult = {
  /** All registered members, freshness-flagged (empty in local mode). */
  members: MemberInfo[];
  /** Top-bar brews grouped by member + the party brew (null in local mode). */
  index: BrewIndex | null;
  /** The open brew, or null while loading. */
  snapshot: BrewSnapshot | null;
  /** The viewer's inventory (drives the "your own" input tab and the hand). */
  ownInventory: Inventory;
  /** Per-member inventories for the input-panel tabs (own first when known).
   * Only the viewer's own inventory and the CURRENTLY-SELECTED member tab are
   * reactively subscribed (call selectMemberTab); any other key reads empty. */
  inventoryOf: (memberKey: string) => Inventory;
  /** Point the single non-own inventory subscription at a member's tab (or null
   * to drop it). Selecting a tab in the input panel calls this so exactly ONE
   * other member's inventory is subscribed at a time — never N. */
  selectMemberTab: (memberKey: string | null) => void;
  permissions: BrewPermissions;
  actions: BrewActions;
  presence: PresenceEntry[];
  undo: UndoState;
  /** Whether the viewer is a registered member (may act at all). */
  registered: boolean;
  loading: boolean;
  /** The resolved id of the brew on stage ("local-brew" locally). */
  brewId: string | null;
};

// ── local store (?local=1 — no Convex, no members, no presence) ──────────────

type LocalState = {
  memberName: string;
  color: string;
  items: BrewItem[];
  strikePlays: StrikePlay[];
  wildPlays: WildPlay[];
  inventory: Inventory;
  outputs: OutputInstance[];
  pinned: PinnedRecipe;
  ui: SharedUI;
};

// ?seed=<name> (local mode only): deterministic starting inventories for the
// Playwright specs (e2e/perfume.spec.ts). A seed replaces the persisted brew
// and is never written back.
const SEED_INVENTORIES: Record<string, Inventory> = {
  basic: {
    ingredients: {
      "base:Noble Roses": 3,
      "base:Aphasia Flower": 2,
      "base:Pemneath Peat": 1,
      "base:Shadow Demon Liver": 1,
    },
    pures: { "pure:strike": 2 },
    perfumes: {},
  },
};

function defaultLocalState(): LocalState {
  return {
    memberName: "Perfumer",
    color: "#6FE3C4",
    items: [],
    strikePlays: [],
    wildPlays: [],
    inventory: cloneInventory(EMPTY_INVENTORY),
    outputs: [],
    pinned: null,
    ui: { ...DEFAULT_UI },
  };
}

let localInstanceCounter = 0;
function newLocalInstanceId(): string {
  localInstanceCounter = (localInstanceCounter + 1) & 0xffff;
  return `inst:${Date.now().toString(36)}:${localInstanceCounter.toString(36)}`;
}

export function useLocalBrewStore(): BrewStoreResult {
  const [state, setState] = useState<LocalState>(defaultLocalState);
  const loadedRef = useRef(false);

  useEffect(() => {
    const seed =
      SEED_INVENTORIES[
        new URLSearchParams(window.location.search).get("seed") ?? ""
      ];
    if (seed) {
      // loadedRef stays false: a seeded brew never persists
      setState({ ...defaultLocalState(), inventory: cloneInventory(seed) });
      return;
    }
    try {
      const raw = window.localStorage.getItem(LOCAL_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<LocalState>;
        setState((prev) => ({
          ...prev,
          ...saved,
          inventory: { ...cloneInventory(EMPTY_INVENTORY), ...saved.inventory },
          ui: { ...DEFAULT_UI, ...saved.ui },
        }));
      }
    } catch {
      // corrupt or unavailable storage: start fresh
    }
    loadedRef.current = true;
  }, []);

  useEffect(() => {
    if (!loadedRef.current) return;
    try {
      window.localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
    } catch {
      // best effort
    }
  }, [state]);

  const actions = useMemo<BrewActions>(() => {
    const noAsync = async (): Promise<string | null> => null;
    return {
      moveToBrew: (itemKey, n) => {
        if (!isIngredientKey(itemKey) || n < 1) return;
        setState((s) => {
          const items = [...s.items];
          const inventory = cloneInventory(s.inventory);
          addToBrew(items, inventory, itemKey, n, LOCAL_MEMBER, s.memberName);
          return { ...s, items, inventory };
        });
      },
      moveToInventory: (itemKey, n) => {
        if (n < 1) return;
        setState((s) => {
          const items = [...s.items];
          const returned = removeFromBrew(items, itemKey, n);
          const inventory = cloneInventory(s.inventory);
          addStock(inventory, itemKey, returned);
          return { ...s, items, inventory, ...trimPlays(items, s.strikePlays, s.wildPlays) };
        });
      },
      playStrike: (freq) =>
        setState((s) =>
          s.strikePlays.length >= chargeTotals(itemIngredients(s.items)).strike
            ? s
            : { ...s, strikePlays: [...s.strikePlays, { freq, byMemberKey: LOCAL_MEMBER }] },
        ),
      unplayStrike: (freq) =>
        setState((s) => {
          let idx = -1;
          for (let i = s.strikePlays.length - 1; i >= 0; i--) {
            if (s.strikePlays[i].freq === freq) { idx = i; break; }
          }
          return idx < 0 ? s : { ...s, strikePlays: s.strikePlays.toSpliced(idx, 1) };
        }),
      playWild: (chosenFreq) =>
        setState((s) =>
          s.wildPlays.length >= chargeTotals(itemIngredients(s.items)).wild
            ? s
            : { ...s, wildPlays: [...s.wildPlays, { chosenFreq, byMemberKey: LOCAL_MEMBER }] },
        ),
      unplayWild: (chosenFreq) =>
        setState((s) => {
          let idx = -1;
          for (let i = s.wildPlays.length - 1; i >= 0; i--) {
            if (s.wildPlays[i].chosenFreq === chosenFreq) { idx = i; break; }
          }
          return idx < 0 ? s : { ...s, wildPlays: s.wildPlays.toSpliced(idx, 1) };
        }),
      fillFromInventory: () =>
        setState((s) => {
          const items = [...s.items];
          const inventory = cloneInventory(s.inventory);
          for (let i = 0; i < items.length; i++) {
            if (items[i].real) continue;
            if (stockOf(inventory, items[i].key) <= 0) continue;
            addStock(inventory, items[i].key, -1);
            items[i] = { ...items[i], real: true };
          }
          return { ...s, items, inventory };
        }),
      returnIngredients: () =>
        setState((s) => {
          const inventory = cloneInventory(s.inventory);
          const items = s.items.filter((p) => {
            if (!p.real) return true;
            addStock(inventory, p.key, 1);
            return false;
          });
          return { ...s, items, inventory, ...trimPlays(items, s.strikePlays, s.wildPlays) };
        }),
      emptyBrew: () =>
        setState((s) => {
          const inventory = cloneInventory(s.inventory);
          for (const p of s.items) if (p.real) addStock(inventory, p.key, 1);
          return { ...s, items: [], strikePlays: [], wildPlays: [], inventory };
        }),
      brew: (perfumeId, recipeIndex, k) =>
        setState((s) => {
          // client-side verification via the same engine the server uses
          const perfume = PERFUME_BY_KEY.get(perfumeId);
          if (!perfume || recipeIndex < 0 || recipeIndex >= perfume.recipes.length) return s;
          if (s.items.length === 0 || s.items.some((p) => !p.real)) return s;
          const engine: BrewState = {
            ingredients: itemIngredients(s.items),
            strikePlays: s.strikePlays.map((p) => p.freq),
            wildPlays: s.wildPlays.map((p) => p.chosenFreq),
          };
          const result = evalReq(engine, perfume.recipes[recipeIndex], recipeIndex);
          if (result.status !== "perfect" || result.k !== k) return s;
          // consume real ingredients forever: each becomes its hypothetical twin
          const items = s.items.map((p) => (p.real ? { ...p, real: false } : p));
          const now = Date.now();
          const output: OutputInstance = {
            instanceId: newLocalInstanceId(),
            perfumeId,
            count: k,
            brewedByKey: LOCAL_MEMBER,
            witnesses: [],
            brewedAt: now,
            provenance: [{ key: LOCAL_MEMBER, at: now }],
          };
          return { ...s, items, outputs: [...s.outputs, output] };
        }),
      takeOutput: (instanceId) =>
        setState((s) => {
          const idx = s.outputs.findIndex((o) => o.instanceId === instanceId);
          if (idx < 0) return s;
          const output = s.outputs[idx];
          const outputs = [...s.outputs];
          if (output.count > 1) outputs[idx] = { ...output, count: output.count - 1 };
          else outputs.splice(idx, 1);
          const inventory = cloneInventory(s.inventory);
          addStock(inventory, output.perfumeId, 1);
          return { ...s, outputs, inventory };
        }),
      // gifting has no target locally (single practice member) — no-op
      giftItem: () => {},
      giftPerfume: () => {},
      pinRecipe: (pinned) => setState((s) => ({ ...s, pinned })),
      // no cross-action undo log locally — the practice bench is disposable
      undo: () => {},
      redo: () => {},
      createBrew: noAsync,
      copyBrew: noAsync,
      handoffBrew: () => {},
      deleteBrew: () => {},
      nicknameBrew: () => {},
      register: () => {},
      leave: () => {},
      setColor: (color) => setState((s) => ({ ...s, color })),
      importInventory: (rows, mode) =>
        setState((s) => {
          const inventory =
            mode === "replace"
              ? cloneInventory(EMPTY_INVENTORY)
              : cloneInventory(s.inventory);
          for (const row of rows) {
            if (!CATALOG.has(row.itemKey) && !PERFUME_BY_KEY.has(row.itemKey)) continue;
            if (!Number.isInteger(row.count) || row.count < 0) continue;
            addStock(inventory, row.itemKey, row.count);
          }
          return { ...s, inventory };
        }),
      updateUI: (patch) => setState((s) => ({ ...s, ui: { ...s.ui, ...patch } })),
    };
  }, []);

  const snapshot = useMemo<BrewSnapshot>(
    () => ({
      brewId: LOCAL_BREW_ID,
      owner: LOCAL_MEMBER,
      ownerName: state.memberName,
      nickname: null,
      seq: 1,
      isParty: false,
      items: state.items,
      strikePlays: state.strikePlays,
      wildPlays: state.wildPlays,
      pinned: state.pinned,
      outputs: state.outputs,
      ui: state.ui,
    }),
    [state],
  );

  const permissions = useMemo<BrewPermissions>(
    () => ({
      registered: true,
      moveItems: true,
      brewAndTake: true,
      fillReturn: true,
      gift: false, // nobody to gift to locally
      pin: true,
      nickname: false,
      manageBrew: false,
      isAdmin: false,
    }),
    [],
  );

  const inventoryOf = useCallback(
    (memberKey: string) => (memberKey === LOCAL_MEMBER ? state.inventory : cloneInventory(EMPTY_INVENTORY)),
    [state.inventory],
  );

  // no other members exist locally — the selection is a no-op
  const selectMemberTab = useCallback((): void => {}, []);

  return {
    members: [],
    index: null,
    snapshot,
    ownInventory: state.inventory,
    inventoryOf,
    selectMemberTab,
    permissions,
    actions,
    presence: [],
    undo: { canUndo: false, canRedo: false },
    registered: true,
    loading: false,
    brewId: LOCAL_BREW_ID,
  };
}

// ── Convex store ─────────────────────────────────────────────────────────────

export type ConvexBrewOptions = {
  /** "user:<id>" | "anon:<uuid>" | null while identity resolves. */
  viewerKey: string | null;
  /** Passed to every mutation when the viewer is anonymous. */
  anonId: string | null;
  isTom: boolean;
  /** Anonymous and still unnamed — mutations get intercepted through
   * onNeedProfile until a nickname is set. */
  needsProfile: boolean;
  /** Called INSTEAD of the intercepted mutation; the client shows the nickname
   * prompt and calls `run` once the profile is saved. */
  onNeedProfile: (run: () => void) => void;
  /** Stored profile seeds the member created by register. */
  profileName?: string;
  profileColor?: string;
};

/** Resolve the client party sentinel to the real party brew id (or null). */
export function useConvexBrewStore(
  brewKey: string,
  opts: ConvexBrewOptions,
): BrewStoreResult {
  const { viewerKey, isTom } = opts;
  const isPartyKey = brewKey === PARTY_KEY;

  // Resolve the party sentinel to a real brew id (the party brew is created on
  // demand; before that getPartyBrew returns null and we render empty).
  const partyBrew = useQuery(api.brews.getPartyBrew, isPartyKey ? {} : "skip");
  const resolvedId: Id<"perfumeBrews"> | null = isPartyKey
    ? (partyBrew?._id ?? null)
    : (brewKey as Id<"perfumeBrews">);

  const brewDoc = useQuery(
    api.brews.getBrew,
    resolvedId ? { brewId: resolvedId } : "skip",
  );
  const rawMembers = useQuery(api.brews.listMembers, {});
  const members = useMemo<MemberInfo[]>(() => rawMembers ?? [], [rawMembers]);
  const rawIndex = useQuery(
    api.brews.listBrews,
    viewerKey ? { ...(opts.anonId ? { anonId: opts.anonId } : {}) } : {},
  );
  const ownInv = useQuery(
    api.brews.getInventory,
    viewerKey ? { memberKey: viewerKey } : "skip",
  );
  // The single non-own inventory subscription: the input panel points this at
  // the member whose tab is open (never N subscriptions). null → skip; the
  // viewer's own tab reuses ownInv, so it never selects itself here.
  const [tabMember, setTabMember] = useState<string | null>(null);
  const tabInv = useQuery(
    api.brews.getInventory,
    tabMember && tabMember !== viewerKey ? { memberKey: tabMember } : "skip",
  );
  const rawPresence = useQuery(
    api.brews.presenceList,
    resolvedId ? { brewId: resolvedId } : "skip",
  );
  const rawUndo = useQuery(
    api.brews.undoState,
    resolvedId && viewerKey
      ? { brewId: resolvedId, ...(opts.anonId ? { anonId: opts.anonId } : {}) }
      : "skip",
  );

  // browse UI is client-local in the multi-brew model (per-brew, not synced)
  const [ui, setUi] = useState<SharedUI>({ ...DEFAULT_UI });
  // a brew switch resets browse UI (each brew is its own workspace)
  const brewIdStr = resolvedId ? String(resolvedId) : null;
  const lastBrewRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastBrewRef.current !== brewIdStr) {
      lastBrewRef.current = brewIdStr;
      setUi({ ...DEFAULT_UI });
    }
  }, [brewIdStr]);

  const mutations = {
    register: useMutation(api.brews.registerMember),
    leave: useMutation(api.brews.leaveParty),
    setIcon: useMutation(api.brews.setMemberIcon),
    createBrew: useMutation(api.brews.createBrew),
    copyBrew: useMutation(api.brews.copyBrew),
    handoffBrew: useMutation(api.brews.handoffBrew),
    deleteBrew: useMutation(api.brews.deleteBrew),
    nicknameBrew: useMutation(api.brews.nicknameBrew),
    pinRecipe: useMutation(api.brews.pinRecipe),
    moveToBrew: useMutation(api.brews.moveItemToBrew),
    moveToInventory: useMutation(api.brews.moveItemToInventory),
    playStrike: useMutation(api.brews.playStrike),
    unplayStrike: useMutation(api.brews.unplayStrike),
    playWild: useMutation(api.brews.playWild),
    unplayWild: useMutation(api.brews.unplayWild),
    fill: useMutation(api.brews.fillFromInventory),
    returnIng: useMutation(api.brews.returnIngredients),
    empty: useMutation(api.brews.emptyBrew),
    brew: useMutation(api.brews.brew),
    take: useMutation(api.brews.takeOutput),
    giftItem: useMutation(api.brews.giftItem),
    giftPerfume: useMutation(api.brews.giftPerfume),
    undo: useMutation(api.brews.undo),
    redo: useMutation(api.brews.redo),
    importInventory: useMutation(api.brews.importInventory),
  };

  const optsRef = useRef(opts);
  optsRef.current = opts;
  const idRef = useRef<Id<"perfumeBrews"> | null>(resolvedId);
  idRef.current = resolvedId;
  const ensuredRef = useRef<string | null>(null);

  const anonArg = useCallback(
    () => (optsRef.current.anonId ? { anonId: optsRef.current.anonId } : {}),
    [],
  );

  // Make sure the caller is a member before any mutation that requires one.
  // Idempotent: registerMember refreshes lastSeen.
  const ensureMember = useCallback(async () => {
    const o = optsRef.current;
    if (!o.viewerKey || ensuredRef.current === o.viewerKey) return;
    ensuredRef.current = o.viewerKey;
    try {
      await mutations.register({
        ...(o.anonId ? { anonId: o.anonId } : {}),
        ...(o.profileName ? { name: o.profileName } : {}),
        ...(o.profileColor ? { color: o.profileColor } : {}),
      });
    } catch (e) {
      ensuredRef.current = null;
      throw e;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Run a mutation, joining first and routing an unnamed anon through the
  // nickname prompt. Errors surface on the console — the server is
  // authoritative and the reactive snapshot reconciles the UI.
  const perform = useCallback(
    (fn: () => Promise<unknown>) => {
      const o = optsRef.current;
      if (!o.viewerKey) return;
      const exec = () => {
        void (async () => {
          await ensureMember();
          await fn();
        })().catch((e) => console.error("[perfume]", e));
      };
      if (o.needsProfile) o.onNeedProfile(exec);
      else exec();
    },
    [ensureMember],
  );

  // A brew-scoped mutation needs the resolved id; if the party brew does not
  // exist yet, the WHERE/WHAT action is a no-op (nothing to act on).
  const onBrew = useCallback(
    (fn: (brewId: Id<"perfumeBrews">) => Promise<unknown>) => {
      const id = idRef.current;
      if (!id) return;
      perform(() => fn(id));
    },
    [perform],
  );

  // browse UI is client-local per brew — a plain merge, no network
  const updateUI = useCallback((patch: Partial<SharedUI>) => {
    setUi((u) => ({ ...u, ...patch }));
  }, []);

  const actions = useMemo<BrewActions>(() => {
    const a = mutations;
    const err = (e: unknown) => console.error("[perfume]", e);
    return {
      moveToBrew: (itemKey, n) => {
        if (!isIngredientKey(itemKey) || n < 1) return;
        onBrew((brewId) => a.moveToBrew({ brewId, itemKey, n, ...anonArg() }));
      },
      moveToInventory: (itemKey, n) => {
        if (!isIngredientKey(itemKey) || n < 1) return;
        onBrew((brewId) => a.moveToInventory({ brewId, itemKey, n, ...anonArg() }));
      },
      playStrike: (freq) => onBrew((brewId) => a.playStrike({ brewId, freq, ...anonArg() })),
      unplayStrike: (freq) => onBrew((brewId) => a.unplayStrike({ brewId, freq, ...anonArg() })),
      playWild: (chosenFreq) => onBrew((brewId) => a.playWild({ brewId, chosenFreq, ...anonArg() })),
      unplayWild: (chosenFreq) => onBrew((brewId) => a.unplayWild({ brewId, chosenFreq, ...anonArg() })),
      fillFromInventory: () => onBrew((brewId) => a.fill({ brewId, ...anonArg() })),
      returnIngredients: () => onBrew((brewId) => a.returnIng({ brewId, ...anonArg() })),
      emptyBrew: () => onBrew((brewId) => a.empty({ brewId, ...anonArg() })),
      brew: (perfumeId, recipeIndex, k) =>
        onBrew((brewId) => a.brew({ brewId, perfumeId, recipeIndex, k, ...anonArg() })),
      takeOutput: (instanceId) => onBrew((brewId) => a.take({ brewId, instanceId, ...anonArg() })),
      giftItem: (toMemberKey, itemKey, n) => {
        if (n < 1) return;
        perform(() => a.giftItem({ toMemberKey, itemKey, n, ...anonArg() }));
      },
      giftPerfume: (toMemberKey, instanceId) =>
        perform(() => a.giftPerfume({ toMemberKey, instanceId, ...anonArg() })),
      pinRecipe: (pinned) => onBrew((brewId) => a.pinRecipe({ brewId, pinned, ...anonArg() })),
      undo: () => onBrew((brewId) => a.undo({ brewId, ...anonArg() })),
      redo: () => onBrew((brewId) => a.redo({ brewId, ...anonArg() })),
      createBrew: async (nickname) => {
        const o = optsRef.current;
        if (!o.viewerKey) return null;
        try {
          await ensureMember();
          const id = await a.createBrew({ ...(nickname ? { nickname } : {}), ...anonArg() });
          return String(id);
        } catch (e) { err(e); return null; }
      },
      copyBrew: async (srcBrewId) => {
        const o = optsRef.current;
        if (!o.viewerKey) return null;
        try {
          await ensureMember();
          const id = await a.copyBrew({ brewId: srcBrewId as Id<"perfumeBrews">, ...anonArg() });
          return String(id);
        } catch (e) { err(e); return null; }
      },
      handoffBrew: (targetBrewId, toMemberKey) =>
        perform(() => a.handoffBrew({ brewId: targetBrewId as Id<"perfumeBrews">, toMemberKey, ...anonArg() })),
      deleteBrew: (targetBrewId) =>
        perform(() => a.deleteBrew({ brewId: targetBrewId as Id<"perfumeBrews">, ...anonArg() })),
      nicknameBrew: (targetBrewId, nickname) =>
        perform(() => a.nicknameBrew({ brewId: targetBrewId as Id<"perfumeBrews">, nickname, ...anonArg() })),
      register: (name, color) => {
        void a.register({
          ...(name ? { name } : {}),
          ...(color ? { color } : {}),
          ...anonArg(),
        }).then(() => { ensuredRef.current = optsRef.current.viewerKey; }).catch(err);
      },
      leave: () => {
        void a.leave({ ...anonArg() }).then(() => { ensuredRef.current = null; }).catch(err);
      },
      setColor: (color) => {
        // registering with a new color updates the member row idempotently
        void (async () => {
          await ensureMember();
          await a.register({ color, ...anonArg() });
        })().catch(err);
      },
      importInventory: (rows, mode) => {
        // server rows use `key`; the client contract uses `itemKey`
        void (async () => {
          await ensureMember();
          await a.importInventory({
            rows: rows.map((r) => ({ key: r.itemKey, count: r.count })),
            mode,
            ...anonArg(),
          });
        })().catch(err);
      },
      updateUI,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onBrew, perform, ensureMember, anonArg, updateUI]);

  // ── snapshot ────────────────────────────────────────────────────────────
  const snapshot = useMemo<BrewSnapshot | null>(() => {
    if (isPartyKey && resolvedId === null) {
      // party brew not yet created — an empty shell so the stage renders
      return {
        brewId: PARTY_KEY,
        owner: null,
        ownerName: "Party",
        nickname: null,
        seq: 0,
        isParty: true,
        items: [],
        strikePlays: [],
        wildPlays: [],
        pinned: null,
        outputs: [],
        ui,
      };
    }
    if (!brewDoc) return null;
    const ownerMember = brewDoc.owner
      ? members.find((m) => m.memberKey === brewDoc.owner)
      : null;
    return {
      brewId: String(brewDoc._id),
      owner: brewDoc.owner,
      ownerName: brewDoc.owner === null ? "Party" : (ownerMember?.name ?? brewDoc.owner),
      nickname: brewDoc.nickname,
      seq: brewDoc.seq,
      isParty: brewDoc.owner === null,
      items: brewDoc.items,
      strikePlays: brewDoc.strikePlays,
      wildPlays: brewDoc.wildPlays,
      pinned: brewDoc.pinned,
      outputs: brewDoc.outputs,
      ui,
    };
  }, [isPartyKey, resolvedId, brewDoc, members, ui]);

  // ── per-member inventories ────────────────────────────────────────────────
  const invCache = useRef(new Map<string, Inventory>());
  const ownInventory = useMemo<Inventory>(() => {
    if (!ownInv) return cloneInventory(EMPTY_INVENTORY);
    return {
      ingredients: { ...ownInv.ingredients },
      pures: { ...ownInv.pures },
      perfumes: perfumeCountsFromInstances(ownInv.perfumes),
    };
  }, [ownInv]);

  // The selected member tab's inventory is reactively subscribed above (tabInv);
  // project its instance list down the same way ownInventory is. Cache the last
  // projection per member so a brief undefined between switches doesn't blank the
  // grid, but only the selected member is ever live.
  const tabInventory = useMemo<Inventory | null>(() => {
    if (!tabInv) return null;
    return {
      ingredients: { ...tabInv.ingredients },
      pures: { ...tabInv.pures },
      perfumes: perfumeCountsFromInstances(tabInv.perfumes),
    };
  }, [tabInv]);
  if (tabMember && tabInventory) invCache.current.set(tabMember, tabInventory);

  // Only the viewer's own inventory and the selected tab (tabMember) are live;
  // any other member reads its last cached projection, else empty. selectMemberTab
  // (below) is what points the single subscription at a tab.
  const inventoryOf = useCallback(
    (memberKey: string): Inventory => {
      if (memberKey === viewerKey) return ownInventory;
      if (memberKey === tabMember && tabInventory) return tabInventory;
      return invCache.current.get(memberKey) ?? cloneInventory(EMPTY_INVENTORY);
    },
    [viewerKey, ownInventory, tabMember, tabInventory],
  );

  const selectMemberTab = useCallback((memberKey: string | null) => {
    setTabMember(memberKey);
  }, []);

  // ── presence with last-known freeze ───────────────────────────────────────
  // presenceList already filters to fresh rows; we tag them stale=false. Rows
  // that drop out of the fresh window are kept frozen client-side (at their
  // last position) until the stale window elapses, per DESIGN.md §6.
  const frozenRef = useRef(new Map<string, PresenceEntry>());
  const presence = useMemo<PresenceEntry[]>(() => {
    const fresh = rawPresence ?? [];
    const now = Date.now();
    const frozen = frozenRef.current;
    const seen = new Set<string>();
    for (const row of fresh) {
      seen.add(row.clientId);
      frozen.set(row.clientId, { ...row, stale: false });
    }
    // age out and mark stale
    const out: PresenceEntry[] = [];
    for (const [clientId, entry] of frozen) {
      if (seen.has(clientId)) {
        out.push(entry);
      } else if (now - entry.updatedAt < PRESENCE_STALE_MS) {
        out.push({ ...entry, stale: true });
      } else {
        frozen.delete(clientId);
      }
    }
    return out;
  }, [rawPresence]);

  // ── permissions (DESIGN.md §4; server enforces regardless) ────────────────
  const registered = useMemo(
    () => !!viewerKey && members.some((m) => m.memberKey === viewerKey),
    [viewerKey, members],
  );
  const permissions = useMemo<BrewPermissions>(() => {
    if (!viewerKey || !registered) {
      // visitor (or pre-registration): read-only, but the join affordance and
      // nicknaming are gated on `registered` at the call sites too
      return { ...NO_BREW_PERMISSIONS, isAdmin: isTom };
    }
    const party = snapshot?.isParty ?? false;
    const owner = snapshot?.owner ?? null;
    const isOwner = owner !== null && owner === viewerKey;
    const ownerScope = party || isOwner || isTom;
    return {
      registered: true,
      moveItems: true, // WHERE is open to any member
      brewAndTake: ownerScope,
      fillReturn: ownerScope,
      // Gift follows the §4 matrix row "Gift items": own brew / party brew yes,
      // another member's brew no. The ghost gift frame renders only where true.
      gift: ownerScope,
      pin: true, // any member may pin (the pin lives on the brew)
      nickname: true, // any member may nickname any brew
      manageBrew: isOwner || isTom, // copy is open to any member (call site), delete/handoff here
      isAdmin: isTom,
    };
  }, [viewerKey, registered, isTom, snapshot?.isParty, snapshot?.owner]);

  const index = rawIndex ?? null;
  const undo = rawUndo ?? { canUndo: false, canRedo: false };

  const loading =
    snapshot === null ||
    (!!viewerKey && ownInv === undefined) ||
    (isPartyKey && partyBrew === undefined);

  return {
    members,
    index,
    snapshot,
    ownInventory,
    inventoryOf,
    selectMemberTab,
    permissions,
    actions,
    presence,
    undo,
    registered,
    loading,
    brewId: brewIdStr ?? (isPartyKey ? PARTY_KEY : null),
  };
}

// Project the instance list down to the count view the legacy input panel
// renders. (Perfumes are instances in the multi-brew model; the count is a
// display convenience — taking/gifting act on instance ids elsewhere.)
function perfumeCountsFromInstances(
  perfumes: { perfumeId: string }[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of perfumes) out[p.perfumeId] = (out[p.perfumeId] ?? 0) + 1;
  return out;
}
