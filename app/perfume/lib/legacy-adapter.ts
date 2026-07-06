"use client";

// LEGACY ADAPTER — the bridge that keeps the not-yet-rebuilt stage components
// (cauldron.tsx, brew-bar.tsx, output-shelf.tsx and their sub-panels) working
// against the multi-brew data layer until the Phase-4 stage rebuild replaces
// them. It projects a BrewSnapshot + BrewActions + BrewPermissions down onto
// the frozen LegacyBench* prop shapes those components consume.
//
// Nothing new should be built on top of this. When the stage is rebuilt to
// speak BrewSnapshot/BrewActions directly, this file and the LegacyBench*
// section of brew-types.ts are deleted together.
//
// It also RE-EXPORTS the frozen legacy types so the legacy components import
// their prop types from one migration home (../lib/legacy-adapter) rather than
// the deleted bench-types.ts.

import { useMemo } from "react";
import type { BrewState } from "./types";
import {
  brewEngineState,
  outputCounts,
  type BrewStoreResult,
} from "./brew-store";
import type {
  BrewActions,
  BrewPermissions,
  BrewSnapshot,
  LegacyBenchActions,
  LegacyBenchPermissions,
  LegacyBenchSnapshot,
  LegacySharedUI,
  OutputInstance,
} from "./brew-types";

// Re-export the frozen legacy prop shapes + shared constants/helpers the legacy
// components pull from here.
export type {
  Inventory,
  SharedUI,
  PotItem,
  Hand,
  HandApi,
  HandOrigin,
  PresenceSurface,
  PresenceEntry,
  ImportRow,
  LegacyBenchSnapshot,
  LegacyBenchActions,
  LegacyBenchPermissions,
  LegacyBenchStore,
  LegacySharedUI,
  BrewOf,
} from "./brew-types";
export {
  EMPTY_INVENTORY,
  DEFAULT_UI,
  inventorySectionFor,
} from "./brew-types";

// The legacy components refer to these type names directly; alias them.
export type {
  LegacyBenchSnapshot as BenchSnapshot,
  LegacyBenchActions as BenchActions,
  LegacyBenchPermissions as BenchPermissions,
  LegacyBenchStore as BenchStore,
} from "./brew-types";

// ── snapshot projection ──────────────────────────────────────────────────────

/** BrewSnapshot -> the legacy bench snapshot shape. */
export function toLegacySnapshot(
  snap: BrewSnapshot,
  inventory: BrewStoreResult["ownInventory"],
): LegacyBenchSnapshot {
  const ui: LegacySharedUI = {
    ...snap.ui,
    // the legacy perfume panel pins by perfume key; project the brew's single
    // pinned recipe down to a one-element key list
    pins: snap.pinned ? [snap.pinned.perfumeId] : [],
  };
  return {
    benchKey: snap.brewId,
    ownerName: snap.ownerName,
    color: "#6FE3C4",
    pot: snap.items,
    strikePlays: snap.strikePlays.map((p) => p.freq),
    wildPlays: snap.wildPlays.map((p) => p.chosenFreq),
    inventory,
    outputTray: outputCounts(snap.outputs),
    ui,
  };
}

/** The engine view of the open brew (pot items expand to Ingredient[]). */
export function legacyBrewOf(snap: LegacyBenchSnapshot): BrewState {
  // reuse the multi-brew engine projection via a minimal shim
  return brewEngineState({
    brewId: snap.benchKey,
    owner: null,
    ownerName: snap.ownerName,
    nickname: null,
    seq: 0,
    isParty: false,
    items: snap.pot,
    strikePlays: snap.strikePlays.map((freq) => ({ freq, byMemberKey: "" })),
    wildPlays: snap.wildPlays.map((chosenFreq) => ({ chosenFreq, byMemberKey: "" })),
    pinned: null,
    outputs: [],
    ui: snap.ui,
  });
}

// ── permission projection ────────────────────────────────────────────────────

export function toLegacyPermissions(p: BrewPermissions): LegacyBenchPermissions {
  return {
    moveItems: p.moveItems,
    brewAndTake: p.brewAndTake,
    editInventory: p.brewAndTake, // import/pin/gift gate on owner scope, same as brew/take
    clearPot: p.fillReturn, // "empty the cauldron" maps to the empty-brew control
  };
}

// ── action projection ────────────────────────────────────────────────────────

// Resolve a legacy takeOutput(perfumeKey, n) into n instance takes: the tray
// shows perfume-key counts, but the multi-brew take mutation is per-instance.
function takeByPerfume(
  outputs: OutputInstance[],
  perfumeKey: string,
  n: number,
  take: (instanceId: string) => void,
): void {
  let remaining = n;
  // oldest instances first (stable, matches "take one off the top")
  for (const o of outputs) {
    if (remaining <= 0) break;
    if (o.perfumeId !== perfumeKey) continue;
    const takeN = Math.min(remaining, o.count);
    for (let i = 0; i < takeN; i++) take(o.instanceId);
    remaining -= takeN;
  }
}

/** BrewActions -> the legacy bench action surface. `outputsRef` reads the live
 * outputs so takeOutput can resolve perfume keys to instance ids; `giftTarget`
 * routes the legacy transfer(toBenchKey, ...) — its toBenchKey is a member key. */
export function toLegacyActions(
  actions: BrewActions,
  getOutputs: () => OutputInstance[],
): LegacyBenchActions {
  return {
    moveToBrew: (itemKey, n) => actions.moveToBrew(itemKey, n),
    moveToInventory: (itemKey, n) => actions.moveToInventory(itemKey, n),
    playStrike: (freq) => actions.playStrike(freq),
    unplayStrike: (freq) => actions.unplayStrike(freq),
    playWild: (freq) => actions.playWild(freq),
    unplayWild: (freq) => actions.unplayWild(freq),
    brewPerfume: (perfumeKey, recipeIndex, k) => actions.brew(perfumeKey, recipeIndex, k),
    takeOutput: (perfumeKey, n) =>
      takeByPerfume(getOutputs(), perfumeKey, n, actions.takeOutput),
    // the legacy "empty the cauldron" clears the whole brew
    clearPot: () => actions.emptyBrew(),
    updateUI: (patch) => {
      // pins live on the brew object now: translate a legacy pins patch into a
      // pinRecipe call, and strip pins out of the shared-UI patch.
      const { pins, ...rest } = patch;
      if (pins !== undefined) {
        actions.pinRecipe(pins.length > 0 ? { perfumeId: pins[pins.length - 1], recipeIndex: 0 } : null);
      }
      if (Object.keys(rest).length > 0) actions.updateUI(rest);
    },
    importInventory: (rows, mode) => actions.importInventory(rows, mode),
    // the old transfer feature is gifting now; toBenchKey IS the target member key
    transfer: (toBenchKey, itemKey, n) => actions.giftItem(toBenchKey, itemKey, n),
    // profile: only the color survives in the multi-brew member model
    setProfile: (patch) => {
      if (patch.color) actions.setColor(patch.color);
    },
  };
}

// ── the hook the client uses ─────────────────────────────────────────────────

export type LegacyView = {
  snapshot: LegacyBenchSnapshot | null;
  permissions: LegacyBenchPermissions;
  actions: LegacyBenchActions;
  loading: boolean;
};

/** Adapt a BrewStoreResult into the legacy {snapshot, permissions, actions}
 * the stage components consume. */
export function useLegacyView(store: BrewStoreResult): LegacyView {
  const snapshot = useMemo<LegacyBenchSnapshot | null>(
    () => (store.snapshot ? toLegacySnapshot(store.snapshot, store.ownInventory) : null),
    [store.snapshot, store.ownInventory],
  );
  const permissions = useMemo<LegacyBenchPermissions>(
    () => toLegacyPermissions(store.permissions),
    [store.permissions],
  );
  const actions = useMemo<LegacyBenchActions>(
    () => toLegacyActions(store.actions, () => store.snapshot?.outputs ?? []),
    // getOutputs closes over store.snapshot; re-create when the brew changes
    [store.actions, store.snapshot],
  );
  return { snapshot, permissions, actions, loading: store.loading };
}
