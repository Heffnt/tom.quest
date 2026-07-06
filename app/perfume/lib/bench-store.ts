"use client";

// The two BenchStore implementations (DESIGN.md, "The model" / "Local mode"):
// useConvexBenchStore renders any bench (or the party pot) live through
// convex/perfume.ts; useLocalBenchStore is the ?local=1 twin — pure client
// state persisted to localStorage, brews verified with the same engine, no
// network. Both hand the client an identical {snapshot, permissions, actions}
// so the panels never know which world they are in.
//
// The pot/inventory transforms here deliberately mirror convex/perfume.ts
// (stock flips hypotheticals real before adding, removals take hypotheticals
// first then real newest-first, plays trim to the recomputed charge cap) so
// optimistic local behavior and the server never disagree on semantics.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { BrewState, Ingredient } from "./types";
import {
  DEFAULT_UI,
  EMPTY_INVENTORY,
  inventorySectionFor,
  type BenchActions,
  type BenchPermissions,
  type BenchSnapshot,
  type Inventory,
  type PotItem,
  type SharedUI,
} from "./bench-types";
import { chargeTotals, evalReq } from "./engine";
import { baseIngredients, basePerfumes, pureIngredients } from "../data/base";

export const PARTY_KEY = "party";
const LOCAL_KEY = "pf:local-bench:v1";
const LOCAL_BENCH = "local";
const UI_DEBOUNCE_MS = 200;

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

// ── snapshot derivations (shared by both stores and the client) ──────────────

/** The engine view of a snapshot: pot items expand to Ingredient[] —
 * hypotheticals INCLUDED (they count in the tally; brewing is what they
 * block, reported via hypotheticalBlockers). */
export function brewOf(snap: BenchSnapshot): BrewState {
  return {
    ingredients: snap.pot
      .map((p) => CATALOG.get(p.key))
      .filter((i): i is Ingredient => !!i),
    strikePlays: snap.strikePlays,
    wildPlays: snap.wildPlays,
  };
}

/** Copies of each catalog key in the pot (hypotheticals included). */
export function potCounts(pot: PotItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of pot) out[p.key] = (out[p.key] ?? 0) + 1;
  return out;
}

/** Brew blockers from unreal pot items, phrased like the server's rejection
 * ("2× Noble Roses are hypothetical"). */
export function hypotheticalBlockers(pot: PotItem[]): string[] {
  const counts = new Map<string, number>();
  for (const p of pot) {
    if (!p.real) counts.set(p.key, (counts.get(p.key) ?? 0) + 1);
  }
  return [...counts].map(
    ([key, n]) =>
      `${n}× ${itemInfo(key).name} ${n === 1 ? "is" : "are"} hypothetical`,
  );
}

// ── shared pot/inventory transforms (mirror convex/perfume.ts) ───────────────

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

function potIngredients(pot: PotItem[]): Ingredient[] {
  return pot
    .map((p) => CATALOG.get(p.key))
    .filter((i): i is Ingredient => !!i);
}

function trimPlays(
  pot: PotItem[],
  strikePlays: string[],
  wildPlays: string[],
): { strikePlays: string[]; wildPlays: string[] } {
  const totals = chargeTotals(potIngredients(pot));
  return {
    strikePlays: strikePlays.slice(0, Math.max(0, totals.strike)),
    wildPlays: wildPlays.slice(0, Math.max(0, totals.wild)),
  };
}

// Stock first flips existing hypotheticals of the key to real, then backs new
// real items; past stock the copies enter as hypotheticals.
function addToPot(
  pot: PotItem[],
  inv: Inventory,
  itemKey: string,
  n: number,
  contributorKey: string,
  contributorName: string,
): void {
  for (let i = 0; i < n; i++) {
    if (stockOf(inv, itemKey) > 0) {
      addStock(inv, itemKey, -1);
      const idx = pot.findIndex((p) => p.key === itemKey && !p.real);
      if (idx >= 0) {
        pot[idx] = { key: itemKey, contributorKey, contributorName, real: true };
      } else {
        pot.push({ key: itemKey, contributorKey, contributorName, real: true });
      }
    } else {
      pot.push({ key: itemKey, contributorKey, contributorName, real: false });
    }
  }
}

// Hypotheticals first, then real newest-first; returns how many REAL copies
// came out (they go back to stock — hypotheticals just vanish).
function removeFromPot(pot: PotItem[], itemKey: string, n: number): number {
  let removedReal = 0;
  let remaining = n;
  for (const wantReal of [false, true]) {
    for (let i = pot.length - 1; i >= 0 && remaining > 0; i--) {
      if (pot[i].key !== itemKey || pot[i].real !== wantReal) continue;
      if (pot[i].real) removedReal++;
      pot.splice(i, 1);
      remaining--;
    }
  }
  return removedReal;
}

// ── the store contract both hooks return ─────────────────────────────────────

export type BenchStoreResult = {
  snapshot: BenchSnapshot | null; // null while loading
  permissions: BenchPermissions;
  actions: BenchActions;
  loading: boolean;
};

const NO_PERMISSIONS: BenchPermissions = {
  moveItems: false,
  brewAndTake: false,
  editInventory: false,
  clearPot: false,
};

// ── local store (?local=1 — no Convex, no tabs, no presence) ────────────────

type LocalState = {
  ownerName: string;
  color: string;
  pot: PotItem[];
  strikePlays: string[];
  wildPlays: string[];
  inventory: Inventory;
  outputTray: Record<string, number>;
  ui: SharedUI;
};

// ?seed=<name> (local mode only): deterministic starting inventories for the
// Playwright specs (e2e/perfume.spec.ts). A seed replaces the persisted bench
// and is never written back, so seeded runs cannot contaminate each other or
// a real local bench.
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
    ownerName: "Perfumer",
    color: "#6FE3C4",
    pot: [],
    strikePlays: [],
    wildPlays: [],
    inventory: cloneInventory(EMPTY_INVENTORY),
    outputTray: {},
    ui: { ...DEFAULT_UI },
  };
}

export function useLocalBenchStore(benchKey: string = LOCAL_BENCH): BenchStoreResult {
  const [state, setState] = useState<LocalState>(defaultLocalState);
  const loadedRef = useRef(false);

  // read the persisted bench after mount so SSR and first client render agree
  useEffect(() => {
    const seed =
      SEED_INVENTORIES[
        new URLSearchParams(window.location.search).get("seed") ?? ""
      ];
    if (seed) {
      // loadedRef stays false: a seeded bench never persists
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

  const actions = useMemo<BenchActions>(() => {
    const owner = () => ({ key: benchKey, name: "You" });
    return {
      moveToBrew: (itemKey, n) => {
        if (!isIngredientKey(itemKey) || n < 1) return;
        setState((s) => {
          const pot = [...s.pot];
          const inventory = cloneInventory(s.inventory);
          addToPot(pot, inventory, itemKey, n, owner().key, s.ownerName);
          return { ...s, pot, inventory };
        });
      },
      moveToInventory: (itemKey, n) => {
        if (n < 1) return;
        setState((s) => {
          const pot = [...s.pot];
          const returned = removeFromPot(pot, itemKey, n);
          const inventory = cloneInventory(s.inventory);
          addStock(inventory, itemKey, returned);
          return { ...s, pot, inventory, ...trimPlays(pot, s.strikePlays, s.wildPlays) };
        });
      },
      playStrike: (freq) =>
        setState((s) =>
          s.strikePlays.length >= chargeTotals(potIngredients(s.pot)).strike
            ? s
            : { ...s, strikePlays: [...s.strikePlays, freq] },
        ),
      unplayStrike: (freq) =>
        setState((s) => {
          const idx = s.strikePlays.lastIndexOf(freq);
          return idx < 0 ? s : { ...s, strikePlays: s.strikePlays.toSpliced(idx, 1) };
        }),
      playWild: (freq) =>
        setState((s) =>
          s.wildPlays.length >= chargeTotals(potIngredients(s.pot)).wild
            ? s
            : { ...s, wildPlays: [...s.wildPlays, freq] },
        ),
      unplayWild: (freq) =>
        setState((s) => {
          const idx = s.wildPlays.lastIndexOf(freq);
          return idx < 0 ? s : { ...s, wildPlays: s.wildPlays.toSpliced(idx, 1) };
        }),
      brewPerfume: (perfumeKey, recipeIndex, k) =>
        setState((s) => {
          // client-side verification via the same engine the server uses
          const perfume = PERFUME_BY_KEY.get(perfumeKey);
          if (!perfume || recipeIndex < 0 || recipeIndex >= perfume.recipes.length) return s;
          if (s.pot.length === 0 || s.pot.some((p) => !p.real)) return s;
          const brew: BrewState = {
            ingredients: potIngredients(s.pot),
            strikePlays: s.strikePlays,
            wildPlays: s.wildPlays,
          };
          const result = evalReq(brew, perfume.recipes[recipeIndex], recipeIndex);
          if (result.status !== "perfect" || result.k !== k) return s;
          const outputTray = { ...s.outputTray };
          outputTray[perfumeKey] = (outputTray[perfumeKey] ?? 0) + k;
          return { ...s, pot: [], strikePlays: [], wildPlays: [], outputTray };
        }),
      takeOutput: (perfumeKey, n) =>
        setState((s) => {
          const available = s.outputTray[perfumeKey] ?? 0;
          const taken = Math.min(Math.max(0, n), available);
          if (taken === 0) return s;
          const outputTray = { ...s.outputTray };
          if (taken === available) delete outputTray[perfumeKey];
          else outputTray[perfumeKey] = available - taken;
          const inventory = cloneInventory(s.inventory);
          addStock(inventory, perfumeKey, taken);
          return { ...s, outputTray, inventory };
        }),
      clearPot: () =>
        setState((s) => {
          const inventory = cloneInventory(s.inventory);
          for (const p of s.pot) if (p.real) addStock(inventory, p.key, 1);
          return { ...s, pot: [], strikePlays: [], wildPlays: [], inventory };
        }),
      updateUI: (patch) => setState((s) => ({ ...s, ui: { ...s.ui, ...patch } })),
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
      // the local party stub is disabled — there is nobody to send to
      transfer: () => {},
      setProfile: (patch) =>
        setState((s) => ({
          ...s,
          ownerName: patch.name?.trim() || s.ownerName,
          color: patch.color ?? s.color,
        })),
    };
  }, [benchKey]);

  const snapshot = useMemo<BenchSnapshot>(
    () => ({
      benchKey,
      ownerName: state.ownerName,
      color: state.color,
      pot: state.pot,
      strikePlays: state.strikePlays,
      wildPlays: state.wildPlays,
      inventory: state.inventory,
      outputTray: state.outputTray,
      ui: state.ui,
    }),
    [benchKey, state],
  );

  const permissions = useMemo<BenchPermissions>(
    () => ({ moveItems: true, brewAndTake: true, editInventory: true, clearPot: true }),
    [],
  );

  return { snapshot, permissions, actions, loading: false };
}

// ── Convex store ─────────────────────────────────────────────────────────────

export type ConvexBenchOptions = {
  /** "user:<id>" | "anon:<uuid>" | null while identity resolves. */
  viewerKey: string | null;
  /** Passed to every mutation when the viewer is anonymous. */
  anonId: string | null;
  isTom: boolean;
  /** Anonymous and still unnamed — party/other-bench mutations get
   * intercepted through onNeedProfile until a nickname is set. */
  needsProfile: boolean;
  /** Called INSTEAD of the intercepted mutation; the client shows the
   * nickname prompt and calls `run` once the profile is saved. */
  onNeedProfile: (run: () => void) => void;
  /** Stored profile seeds the bench created by ensureBench. */
  profileName?: string;
  profileColor?: string;
};

const TEXT_UI_FIELDS = new Set<keyof SharedUI>(["inputSearch", "perfumeSearch"]);

export function useConvexBenchStore(
  viewKey: string,
  opts: ConvexBenchOptions,
): BenchStoreResult {
  const { viewerKey, isTom } = opts;
  const isParty = viewKey === PARTY_KEY;

  const benchSnap = useQuery(
    api.perfume.getBench,
    !isParty ? { benchKey: viewKey } : "skip",
  );
  const partySnap = useQuery(api.perfume.getParty, isParty ? {} : "skip");
  // the party tab binds the input panel to YOUR OWN bench inventory
  const ownSnap = useQuery(
    api.perfume.getBench,
    isParty && viewerKey ? { benchKey: viewerKey } : "skip",
  );

  const mEnsure = useMutation(api.perfume.ensureBench);
  const mSetProfile = useMutation(api.perfume.setProfile);
  const mUpdateUI = useMutation(api.perfume.updateUI);
  const mMoveToBrew = useMutation(api.perfume.moveToBrew);
  const mMoveToInventory = useMutation(api.perfume.moveToInventory);
  const mPlayStrike = useMutation(api.perfume.playStrike);
  const mUnplayStrike = useMutation(api.perfume.unplayStrike);
  const mPlayWild = useMutation(api.perfume.playWild);
  const mUnplayWild = useMutation(api.perfume.unplayWild);
  const mBrew = useMutation(api.perfume.brewPerfume);
  const mTake = useMutation(api.perfume.takeOutput);
  const mImport = useMutation(api.perfume.importInventory);
  const mTransfer = useMutation(api.perfume.transfer);
  const mPartyMoveToBrew = useMutation(api.perfume.partyMoveToBrew);
  const mPartyMoveToInventory = useMutation(api.perfume.partyMoveToInventory);
  const mPartyBrew = useMutation(api.perfume.partyBrew);
  const mPartyTake = useMutation(api.perfume.partyTake);
  const mPartyClear = useMutation(api.perfume.partyClear);

  // party browse UI is local component state, never synced (DESIGN.md)
  const [partyUI, setPartyUI] = useState<SharedUI>(DEFAULT_UI);

  // optimistic overlay for debounced shared-UI writes: local edits render
  // immediately, the mutation flushes ~200ms behind for text fields
  const [uiPending, setUiPending] = useState<Partial<SharedUI>>({});
  const pendingRef = useRef<Partial<SharedUI>>({});
  const pendingKeyRef = useRef<string | null>(null);
  const uiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // live values for the stable action callbacks
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const snapshotRef = useRef<BenchSnapshot | null>(null);
  const ensuredForRef = useRef<string | null>(null);

  const anonArg = useCallback(
    () => (optsRef.current.anonId ? { anonId: optsRef.current.anonId } : {}),
    [],
  );

  const ensureOwn = useCallback(async () => {
    const o = optsRef.current;
    if (!o.viewerKey || ensuredForRef.current === o.viewerKey) return;
    ensuredForRef.current = o.viewerKey;
    try {
      await mEnsure({
        ...(o.anonId ? { anonId: o.anonId } : {}),
        ...(o.profileName ? { name: o.profileName } : {}),
        ...(o.profileColor ? { color: o.profileColor } : {}),
      });
    } catch (e) {
      ensuredForRef.current = null;
      throw e;
    }
  }, [mEnsure]);

  // Runs a mutation, creating the caller's bench first when it targets it and
  // routing through the nickname prompt when an unnamed anon acts away from
  // home. Errors surface on the console — the server is authoritative and the
  // reactive snapshot reconciles the UI.
  const perform = useCallback(
    (target: "own" | "view" | "party", fn: () => Promise<unknown>) => {
      const o = optsRef.current;
      if (!o.viewerKey) return;
      const away = target === "party" || (target === "view" && viewKey !== o.viewerKey);
      const exec = () => {
        void (async () => {
          if (target === "own" || target === "party" || viewKey === o.viewerKey) {
            await ensureOwn();
          }
          await fn();
        })().catch((e) => console.error("[perfume]", e));
      };
      if (away && o.needsProfile) o.onNeedProfile(exec);
      else exec();
    },
    [viewKey, ensureOwn],
  );

  const flushUI = useCallback(() => {
    if (uiTimerRef.current) {
      clearTimeout(uiTimerRef.current);
      uiTimerRef.current = null;
    }
    const patch = pendingRef.current;
    const benchKey = pendingKeyRef.current;
    if (!benchKey || Object.keys(patch).length === 0) return;
    pendingRef.current = {};
    pendingKeyRef.current = null;
    void (async () => {
      if (benchKey === optsRef.current.viewerKey) await ensureOwn();
      await mUpdateUI({ benchKey, patch, ...anonArg() });
      // drop overlay keys the server now carries (unless retyped since)
      setUiPending((p) => {
        const next = { ...p };
        for (const k of Object.keys(patch) as (keyof SharedUI)[]) {
          if (next[k] === patch[k]) delete next[k];
        }
        return next;
      });
    })().catch((e) => console.error("[perfume]", e));
  }, [mUpdateUI, ensureOwn, anonArg]);

  // a tab switch orphans any pending overlay — flush it at the old bench
  useEffect(() => {
    return () => {
      flushUI();
      setUiPending({});
    };
  }, [viewKey, flushUI]);

  const updateUI = useCallback(
    (patch: Partial<SharedUI>) => {
      if (isParty) {
        setPartyUI((ui) => ({ ...ui, ...patch }));
        return;
      }
      if (!optsRef.current.viewerKey) return;
      if (pendingKeyRef.current && pendingKeyRef.current !== viewKey) flushUI();
      pendingKeyRef.current = viewKey;
      pendingRef.current = { ...pendingRef.current, ...patch };
      setUiPending((p) => ({ ...p, ...patch }));
      const textOnly = Object.keys(patch).every((k) =>
        TEXT_UI_FIELDS.has(k as keyof SharedUI),
      );
      if (uiTimerRef.current) clearTimeout(uiTimerRef.current);
      if (textOnly) uiTimerRef.current = setTimeout(flushUI, UI_DEBOUNCE_MS);
      else flushUI();
    },
    [isParty, viewKey, flushUI],
  );

  const actions = useMemo<BenchActions>(() => {
    const err = (e: unknown) => console.error("[perfume]", e);
    return {
      moveToBrew: (itemKey, n) => {
        // perfumes have no pot grammar — an inventory-grabbed phial entering
        // the cauldron is a visual carry, not a move
        if (!isIngredientKey(itemKey) || n < 1) return;
        if (isParty) perform("party", () => mPartyMoveToBrew({ itemKey, n, ...anonArg() }));
        else perform("view", () => mMoveToBrew({ benchKey: viewKey, itemKey, n, ...anonArg() }));
      },
      moveToInventory: (itemKey, n) => {
        if (!isIngredientKey(itemKey) || n < 1) return;
        if (isParty) perform("party", () => mPartyMoveToInventory({ itemKey, n, ...anonArg() }));
        else perform("view", () => mMoveToInventory({ benchKey: viewKey, itemKey, n, ...anonArg() }));
      },
      playStrike: (freq) =>
        perform(isParty ? "party" : "view", () =>
          mPlayStrike({ benchKey: viewKey, freq, ...anonArg() }),
        ),
      unplayStrike: (freq) =>
        perform(isParty ? "party" : "view", () =>
          mUnplayStrike({ benchKey: viewKey, freq, ...anonArg() }),
        ),
      playWild: (freq) =>
        perform(isParty ? "party" : "view", () =>
          mPlayWild({ benchKey: viewKey, freq, ...anonArg() }),
        ),
      unplayWild: (freq) =>
        perform(isParty ? "party" : "view", () =>
          mUnplayWild({ benchKey: viewKey, freq, ...anonArg() }),
        ),
      brewPerfume: (perfumeKey, recipeIndex, k) => {
        if (isParty) perform("party", () => mPartyBrew({ perfumeKey, recipeIndex, k, ...anonArg() }));
        else perform("view", () => mBrew({ benchKey: viewKey, perfumeKey, recipeIndex, k, ...anonArg() }));
      },
      takeOutput: (perfumeKey, n) => {
        if (n < 1) return;
        if (isParty) perform("party", () => mPartyTake({ perfumeKey, n, ...anonArg() }));
        else perform("view", () => mTake({ benchKey: viewKey, perfumeKey, n, ...anonArg() }));
      },
      clearPot: () => {
        if (isParty) {
          perform("party", () => mPartyClear({ ...anonArg() }));
          return;
        }
        // no wholesale-clear mutation on personal benches: clearing IS moving
        // everything home (WHERE, not WHAT) — plays trim to zero with the pot
        const counts = potCounts(snapshotRef.current?.pot ?? []);
        for (const [itemKey, n] of Object.entries(counts)) {
          perform("view", () => mMoveToInventory({ benchKey: viewKey, itemKey, n, ...anonArg() }));
        }
      },
      updateUI,
      importInventory: (rows, mode) => {
        const benchKey = isParty ? optsRef.current.viewerKey : viewKey;
        if (!benchKey) return;
        perform("own", () => mImport({ benchKey, rows, mode, ...anonArg() }));
      },
      transfer: (toBenchKey, itemKey, n) => {
        const benchKey = isParty ? optsRef.current.viewerKey : viewKey;
        if (!benchKey || n < 1) return;
        perform("own", () => mTransfer({ benchKey, toOwnerKey: toBenchKey, itemKey, n, ...anonArg() }));
      },
      setProfile: (patch) => {
        void mSetProfile({ ...patch, ...anonArg() }).catch(err);
      },
    };
  }, [
    isParty,
    viewKey,
    perform,
    updateUI,
    anonArg,
    mMoveToBrew,
    mMoveToInventory,
    mPlayStrike,
    mUnplayStrike,
    mPlayWild,
    mUnplayWild,
    mBrew,
    mTake,
    mImport,
    mTransfer,
    mPartyMoveToBrew,
    mPartyMoveToInventory,
    mPartyBrew,
    mPartyTake,
    mPartyClear,
    mSetProfile,
  ]);

  const snapshot = useMemo<BenchSnapshot | null>(() => {
    if (isParty) {
      if (!partySnap) return null;
      return {
        ...partySnap,
        inventory: ownSnap?.inventory ?? EMPTY_INVENTORY,
        ui: partyUI,
      };
    }
    if (!benchSnap) return null;
    return { ...benchSnap, ui: { ...benchSnap.ui, ...uiPending } };
  }, [isParty, partySnap, ownSnap, partyUI, benchSnap, uiPending]);
  snapshotRef.current = snapshot;

  // WHERE-not-WHAT, derived from viewer identity vs bench owner (the server
  // enforces it regardless)
  const permissions = useMemo<BenchPermissions>(() => {
    if (!viewerKey) return NO_PERMISSIONS;
    if (isParty) {
      return {
        moveItems: true,
        brewAndTake: true, // party brew/take are open; takes credit the caller
        editInventory: true, // import/send act on YOUR bench from the party tab
        clearPot: isTom,
      };
    }
    const isOwner = viewerKey === viewKey;
    return {
      moveItems: true,
      brewAndTake: isOwner,
      editInventory: isOwner,
      // clearing a personal pot decomposes into open inventory<->brew moves
      clearPot: true,
    };
  }, [viewerKey, isParty, isTom, viewKey]);

  const loading =
    snapshot === null || (isParty && !!viewerKey && ownSnap === undefined);

  return { snapshot, permissions, actions, loading };
}
