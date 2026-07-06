"use client";

// The hand — the drag grammar for the Perfumer (DESIGN.md §5 "Interactions").
//
// The spec's grammar (DESIGN.md §1, §5): the draggable unit is an ITEM — a
// rounded square carrying its art (an ingredient, a pure frequency, or a
// perfume). Items drag from a SOURCE frame (or inventory) into an item FRAME.
// The single exception to "circles don't move" is the STRIKE: an available
// strike charge is dragged onto a frequency circle to strike it. Source context
// decides real-vs-hypothetical: catalog/recipe frames mint HYPOTHETICAL items
// (dashed), an inventory mints REAL ones (stock-checked); the "WHERE not WHAT"
// boundary rules come from the store's BrewPermissions.
//
// This file is the cursor-stack HAND (useHand + BrewHand): the pick-up/carry
// hand the input grid, the perfume book and the brew graph all drive through the
// [data-brew-graph] boundary. The pick/settle animation FEEL lives here
// (SettleFx). Its boundary rule, verbatim:
//   - "inventory"/"catalog": entering the brew graph commits the stack
//     (moveToBrew), leaving un-commits it (moveToInventory).
//   - "brew": picking up FROM the graph starts committed; carrying out
//     un-commits.
//   - "output": settling over the input panel takes the perfumes.
// Shift-clicks bypass the hand — callers do direct moves (moveHome/onTake).
// The brew graph carries the strike-circle drop exception itself (its own
// pointer drag in brew-graph.tsx); it does not route through this hand.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrewActions } from "./brew-types";
import { ChargeSymbol, FrequencySymbol } from "./frequencies";
import IngredientThumb from "../components/ingredient-thumb";
import { PhialGlyph } from "../components/phial";

// The brew graph's stage root carries this so the hand's boundary test knows
// when a carried stack is "inside the brew" (commit) vs. outside (return home).
export const BREW_GRAPH_SELECTOR = "[data-brew-graph]";
export const INPUT_DROP_SELECTOR = "[data-input-drop]";

// Where a carried stack came from, and the shape the hand carries.
export type HandOrigin = "inventory" | "catalog" | "brew" | "output";

export type Hand = {
  itemKey: string;
  count: number;
  from: HandOrigin;
  committed: boolean;
  x: number;
  y: number;
};

export interface HandApi {
  hand: Hand | null;
  pickUp(itemKey: string, from: HandOrigin, available: number): void;
  returnOne(): boolean;
  settle(): void;
  cancel(): void;
}

// The slice of the store's BrewActions the hand drives directly. `takeOutput`
// takes an instance id on the real store; the graph adapts a perfume pick to it,
// so the hand only needs the two WHERE moves plus a taker keyed by item.
export type HandActions = Pick<BrewActions, "moveToBrew" | "moveToInventory"> & {
  /** Take one perfume off the cauldron, keyed by its perfume item key. The
   * brew graph resolves the key to a concrete output instance. */
  takeOutput(perfumeKey: string, n: number): void;
};

export type UseHandOptions = {
  brewActions: HandActions;
  /** Copies of an item currently in the brew (committed held copies included). */
  brewCountOf: (itemKey: string) => number;
  /** How many MORE of an item the given origin can still supply. */
  availableOf: (itemKey: string, from: HandOrigin) => number;
  /** BrewPermissions.moveItems for the brew being viewed. */
  canMoveItems: boolean;
};

/** One settle of a committed stack — drives the cauldron's cursor-to-slot
 * spring animation. `seq` increments so consecutive settles re-trigger it. */
export type SettleFx = { itemKey: string; x: number; y: number; seq: number };

export interface BrewHand extends HandApi {
  /** Attach to a grabbable element's onPointerDown: >5px of travel turns the
   * press into a held one-unit hand, released where the pointer goes up
   * (inside the brew graph = settle, elsewhere = home). */
  beginPress(
    e: { clientX: number; clientY: number; button: number; shiftKey: boolean },
    itemKey: string,
    from: HandOrigin,
    available: number,
  ): void;
  /** Direct move used by shift-click / empty-hand right-click: n of an
   * in-brew item straight home to inventory (bypasses the hand). */
  moveHome(itemKey: string, n?: number): void;
  settleFx: SettleFx | null;
}

const hits = (x: number, y: number, selector: string): boolean =>
  !!document.elementFromPoint(x, y)?.closest(selector);

export function useHand(opts: UseHandOptions): BrewHand {
  const [hand, setHandState] = useState<Hand | null>(null);
  const [settleFx, setSettleFx] = useState<SettleFx | null>(null);

  // window listeners are registered once and read live values through refs
  const handRef = useRef<Hand | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const pos = useRef({ x: 0, y: 0 });
  const press = useRef<{
    itemKey: string;
    from: HandOrigin;
    available: number;
    x: number;
    y: number;
    dragging: boolean;
  } | null>(null);
  // swallows the click that already did its work: "pickup" is set by pickUp
  // (the click must not also settle/cancel), "drag" at drag release (the
  // trailing click must not re-pick from the element under the cursor)
  const guard = useRef<"pickup" | "drag" | null>(null);
  const seq = useRef(0);

  const set = useCallback((h: Hand | null) => {
    handRef.current = h;
    setHandState(h);
  }, []);

  const cancel = useCallback(() => {
    const cur = handRef.current;
    if (!cur) return;
    // un-committed stacks (and output picks) never mutated anything; a
    // brew-origin stack that left the boundary was already returned there
    if (cur.committed) optsRef.current.brewActions.moveToInventory(cur.itemKey, cur.count);
    set(null);
  }, [set]);

  const settle = useCallback(() => {
    const cur = handRef.current;
    if (!cur) return;
    if (cur.from === "output") {
      if (hits(pos.current.x, pos.current.y, INPUT_DROP_SELECTOR)) {
        optsRef.current.brewActions.takeOutput(cur.itemKey, cur.count);
      }
    } else if (cur.committed) {
      // the items are already in the brew (boundary commit); announce the
      // settle so the cauldron can spring the icon from cursor to slot
      seq.current += 1;
      setSettleFx({ itemKey: cur.itemKey, x: pos.current.x, y: pos.current.y, seq: seq.current });
    }
    set(null);
  }, [set]);

  const returnOne = useCallback((): boolean => {
    const cur = handRef.current;
    if (!cur) return false;
    if (cur.committed) optsRef.current.brewActions.moveToInventory(cur.itemKey, 1);
    set(cur.count > 1 ? { ...cur, count: cur.count - 1 } : null);
    return true;
  }, [set]);

  // Core pick: same key stacks +1 (available-capped); a different key sends
  // the current stack home first. Never mutates brew state by itself.
  const grab = useCallback(
    (itemKey: string, from: HandOrigin, available: number) => {
      const o = optsRef.current;
      if (from !== "output" && !o.canMoveItems) return;
      const cur = handRef.current;
      if (cur && cur.itemKey === itemKey) {
        // while committed the extra unit is claimed from the brew regardless
        // of the stack's origin — the brew is where all its copies sit now
        const cap = cur.committed
          ? Math.max(0, o.brewCountOf(itemKey) - cur.count)
          : Math.max(0, Math.min(available, o.availableOf(itemKey, cur.from)));
        if (cap <= 0) return;
        set({ ...cur, count: cur.count + 1 });
        return;
      }
      if (cur) cancel();
      const cap =
        from === "brew"
          ? Math.max(0, Math.min(available, o.brewCountOf(itemKey)))
          : Math.max(0, Math.min(available, o.availableOf(itemKey, from)));
      if (cap <= 0) return;
      set({
        itemKey,
        count: 1,
        from,
        committed: from === "brew",
        x: pos.current.x,
        y: pos.current.y,
      });
    },
    [cancel, set],
  );

  const pickUp = useCallback(
    (itemKey: string, from: HandOrigin, available: number) => {
      if (guard.current === "drag") {
        // the click that trails a drag release — the drag already settled
        guard.current = null;
        return;
      }
      grab(itemKey, from, available);
      guard.current = "pickup";
    },
    [grab],
  );

  const beginPress = useCallback(
    (
      e: { clientX: number; clientY: number; button: number; shiftKey: boolean },
      itemKey: string,
      from: HandOrigin,
      available: number,
    ) => {
      if (e.button !== 0 || e.shiftKey) return;
      pos.current = { x: e.clientX, y: e.clientY };
      press.current = { itemKey, from, available, x: e.clientX, y: e.clientY, dragging: false };
    },
    [],
  );

  const moveHome = useCallback((itemKey: string, n = 1) => {
    if (!optsRef.current.canMoveItems) return;
    optsRef.current.brewActions.moveToInventory(itemKey, n);
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pos.current = { x: e.clientX, y: e.clientY };
      const p = press.current;
      if (p && !p.dragging && !handRef.current) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) {
          p.dragging = true;
          grab(p.itemKey, p.from, Math.min(1, p.available));
        }
      }
      const h = handRef.current;
      if (!h) return;
      if (h.from !== "output") {
        const inside = hits(e.clientX, e.clientY, BREW_GRAPH_SELECTOR);
        if (inside && !h.committed) {
          optsRef.current.brewActions.moveToBrew(h.itemKey, h.count);
          set({ ...h, committed: true, x: e.clientX, y: e.clientY });
          return;
        }
        if (!inside && h.committed) {
          optsRef.current.brewActions.moveToInventory(h.itemKey, h.count);
          set({ ...h, committed: false, x: e.clientX, y: e.clientY });
          return;
        }
      }
      set({ ...h, x: e.clientX, y: e.clientY });
    };
    const onUp = () => {
      const p = press.current;
      press.current = null;
      if (p?.dragging) {
        // settle keeps a committed stack, takes output over the input panel,
        // and is a plain hand-clear everywhere else — exactly "release
        // inside settles, outside returns home"
        settle();
        guard.current = "drag";
      }
    };
    // a fresh press means any pending click never arrived — drop stale guards
    const onDown = () => {
      guard.current = null;
    };
    const onClick = (e: MouseEvent) => {
      if (guard.current) {
        guard.current = null;
        return;
      }
      const h = handRef.current;
      if (!h) return;
      if (h.from === "output" || hits(e.clientX, e.clientY, BREW_GRAPH_SELECTOR)) settle();
      else cancel();
    };
    const onContextMenu = (e: MouseEvent) => {
      if (!handRef.current) return;
      e.preventDefault();
      returnOne();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && handRef.current) cancel();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("click", onClick);
    window.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("click", onClick);
      window.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKey);
    };
  }, [grab, settle, cancel, returnOne, set]);

  // no text selection while carrying — drags sweep across the whole page
  const holding = hand !== null;
  useEffect(() => {
    if (!holding) return;
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.userSelect = prev;
    };
  }, [holding]);

  return useMemo<BrewHand>(
    () => ({ hand, pickUp, returnOne, settle, cancel, beginPress, moveHome, settleFx }),
    [hand, pickUp, returnOne, settle, cancel, beginPress, moveHome, settleFx],
  );
}

// ── item visuals ─────────────────────────────────────────────────────────────

/** How an item looks wherever the hand can touch it: base ingredients show
 * their crest art; pure frequencies the frequency symbol (⊖/⊕ glyph for pure
 * strike/wild); output perfumes the phial. */
export function ItemIcon({
  itemKey,
  name,
  color,
  size,
  phial = false,
}: {
  itemKey: string;
  name: string;
  color: string;
  size: number;
  phial?: boolean;
}) {
  if (phial) return <PhialGlyph size={size} />;
  if (itemKey.startsWith("pure:")) {
    const id = itemKey.slice(5);
    if (id === "strike" || id === "wild") {
      return <ChargeSymbol kind={id} size={size} />;
    }
    return <FrequencySymbol id={id} size={size} />;
  }
  return (
    <IngredientThumb
      name={name}
      source={
        itemKey.startsWith("base:")
          ? { kind: "base" }
          : { kind: "user", userId: "", name: "" }
      }
      color={color}
      size={size}
    />
  );
}

export interface HandGhostProps {
  hand: Hand | null;
  /** Display name + fallback color for an item key (catalog lookup). */
  itemInfo: (itemKey: string) => { name: string; color: string };
}

/** The held stack at the cursor: icon + ×n badge, hit-transparent so it never
 * blocks the boundary test or the element under the pointer. */
export function HandGhost({ hand, itemInfo }: HandGhostProps) {
  if (!hand) return null;
  const info = itemInfo(hand.itemKey);
  return (
    <div
      data-testid="hand-ghost"
      data-item-key={hand.itemKey}
      className="pointer-events-none fixed z-[90] -translate-x-1/2 -translate-y-1/2"
      style={{ left: hand.x, top: hand.y }}
      aria-hidden="true"
    >
      <div className="relative">
        <ItemIcon
          itemKey={hand.itemKey}
          name={info.name}
          color={info.color}
          size={44}
          phial={hand.from === "output"}
        />
        {hand.count > 1 && (
          <span className="absolute -right-2 -top-2 rounded-full border border-border bg-surface px-1 font-mono text-[10px] font-bold text-text">
            ×{hand.count}
          </span>
        )}
      </div>
    </div>
  );
}
