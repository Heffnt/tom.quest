"use client";

// The BrewStore (DESIGN.md §§4,9). useConvexBrewStore(brewKey) renders any
// brew (or the party brew) live through convex/brews.ts: reactive queries +
// mutations (browse UI is client-local here). It hands the client
// { members, index, snapshot, permissions, actions, presence, undo } so the
// panels never need to know anything beyond that contract.

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
  type PerfumeInstance,
  type PresenceEntry,
  type SharedUI,
  type StackSection,
  type UndoState,
} from "./brew-types";
import { baseIngredients, basePerfumes, pureIngredients } from "../data/base";

// The client sentinel for the party brew — resolved to the real party brew id
// by the Convex store.
export const PARTY_KEY = "party";
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
export function sectionForKey(itemKey: string): StackSection {
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

function cloneInventory(inv: Inventory): Inventory {
  return {
    ingredients: { ...inv.ingredients },
    pures: { ...inv.pures },
    perfumes: { ...inv.perfumes },
    perfumeInstances: inv.perfumeInstances.map((i) => ({ ...i })),
  };
}

// ── the store contract the hook returns ──────────────────────────────────────

export type BrewStoreResult = {
  /** All registered members, freshness-flagged. */
  members: MemberInfo[];
  /** Top-bar brews grouped by member + the party brew. */
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
  /** A deep link pointed at a brew that does not exist (bad/deleted/malformed
   * id). The client shows a "brew not found" state instead of crashing or
   * hanging on the loading screen. */
  notFound: boolean;
  /** The resolved id of the brew on stage. */
  brewId: string | null;
};

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
  // getBrew takes a plain string and TOLERATES a bad id (returns null instead of
  // throwing), so a deep link is fetched by its raw key. Every OTHER brew-scoped
  // query is v.id-typed and would throw on a malformed string, so those are gated
  // on `resolvedId` — the id of a brew that actually exists (from the fetched
  // doc, or the party brew), never a raw unvalidated deep-link string.
  const brewFetchKey = isPartyKey ? (partyBrew?._id ?? null) : brewKey;
  const brewDoc = useQuery(
    api.brews.getBrew,
    brewFetchKey ? { brewId: brewFetchKey } : "skip",
  );
  const resolvedId: Id<"perfumeBrews"> | null = isPartyKey
    ? (partyBrew?._id ?? null)
    : (brewDoc?._id ?? null);
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
      perfumeInstances: ownInv.perfumes.map(perfumeInstanceView),
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
      perfumeInstances: tabInv.perfumes.map(perfumeInstanceView),
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

  // A non-party deep link whose getBrew resolved to `null` (not `undefined`)
  // points at a brew that does not exist — a malformed, deleted, or stale id.
  // getBrew tolerates these (returns null instead of throwing), so we surface a
  // "not found" state rather than crashing or hanging on the loading screen.
  // (`undefined` is still loading; only an explicit `null` means not-found.)
  const notFound = !isPartyKey && brewDoc === null;

  const loading =
    !notFound &&
    (snapshot === null ||
      (!!viewerKey && ownInv === undefined) ||
      (isPartyKey && partyBrew === undefined));

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
    notFound,
    brewId: brewIdStr ?? (isPartyKey ? PARTY_KEY : null),
  };
}

// The raw held-perfume instance the server returns (schema.ts
// perfumeInventories.perfumes) — instance identity + full provenance.
type RawPerfumeInstance = {
  instanceId: string;
  perfumeId: string;
  brewedByKey: string;
  witnesses: string[];
  brewedAt: number;
  owners: { key: string; at: number }[];
};

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

// Carry each held instance through to the Inventory view unchanged (it already
// matches PerfumeInstance) so the perfume slots can surface its provenance on
// hover (DESIGN.md §1,§9). Kept ALONGSIDE the count view above.
function perfumeInstanceView(p: RawPerfumeInstance): PerfumeInstance {
  return {
    instanceId: p.instanceId,
    perfumeId: p.perfumeId,
    brewedByKey: p.brewedByKey,
    witnesses: p.witnesses,
    brewedAt: p.brewedAt,
    owners: p.owners.map((o) => ({ key: o.key, at: o.at })),
  };
}
