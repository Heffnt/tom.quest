"use client";

// The hand — the cursor stack that carries items between panels (DESIGN.md,
// "interaction grammar"). One item type at a time. Only boundary crossings of
// [data-cauldron-drop] and settles mutate bench state; the hand itself is
// ephemeral client state, so a dropped connection can never strand items.
//
// Origins and the boundary rule:
// - "inventory"/"catalog": entering the cauldron commits the stack
//   (moveToBrew), leaving un-commits it (moveToInventory) — each edge fires
//   exactly once per crossing.
// - "brew": picking up FROM the pot mutates nothing (the stack starts
//   committed); carrying it out of the boundary un-commits it.
// - "output": the boundary rule does not apply; settling over the input
//   panel ([data-input-drop]) takes the perfumes (takeOutput).
//
// Shift-clicks bypass the hand entirely — callers do direct moves (moveHome /
// onTake) and never call pickUp with shift held.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BenchActions, Hand, HandApi, HandOrigin } from "./bench-types";
import { ChargeSymbol, FrequencySymbol } from "./frequencies";
import IngredientThumb from "../components/ingredient-thumb";
import { PhialGlyph } from "../components/phial";

export const CAULDRON_DROP_SELECTOR = "[data-cauldron-drop]";
export const INPUT_DROP_SELECTOR = "[data-input-drop]";

export type UseHandOptions = {
  benchActions: Pick<BenchActions, "moveToBrew" | "moveToInventory" | "takeOutput">;
  /** Copies of an item currently in the pot (committed held copies included). */
  potCountOf: (itemKey: string) => number;
  /** How many MORE of an item the given origin can still supply. */
  availableOf: (itemKey: string, from: HandOrigin) => number;
  /** BenchPermissions.moveItems for the bench being viewed. */
  canMoveItems: boolean;
};

/** One settle of a committed stack — drives the cauldron's cursor-to-slot
 * spring animation. `seq` increments so consecutive settles re-trigger it. */
export type SettleFx = { itemKey: string; x: number; y: number; seq: number };

export interface BenchHand extends HandApi {
  /** Attach to a grabbable element's onPointerDown: >5px of travel turns the
   * press into a held one-unit hand, released where the pointer goes up
   * (inside the cauldron = settle, elsewhere = home). */
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

export function useHand(opts: UseHandOptions): BenchHand {
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
    if (cur.committed) optsRef.current.benchActions.moveToInventory(cur.itemKey, cur.count);
    set(null);
  }, [set]);

  const settle = useCallback(() => {
    const cur = handRef.current;
    if (!cur) return;
    if (cur.from === "output") {
      if (hits(pos.current.x, pos.current.y, INPUT_DROP_SELECTOR)) {
        optsRef.current.benchActions.takeOutput(cur.itemKey, cur.count);
      }
    } else if (cur.committed) {
      // the items are already in the pot (boundary commit); announce the
      // settle so the cauldron can spring the icon from cursor to slot
      seq.current += 1;
      setSettleFx({ itemKey: cur.itemKey, x: pos.current.x, y: pos.current.y, seq: seq.current });
    }
    set(null);
  }, [set]);

  const returnOne = useCallback((): boolean => {
    const cur = handRef.current;
    if (!cur) return false;
    if (cur.committed) optsRef.current.benchActions.moveToInventory(cur.itemKey, 1);
    set(cur.count > 1 ? { ...cur, count: cur.count - 1 } : null);
    return true;
  }, [set]);

  // Core pick: same key stacks +1 (available-capped); a different key sends
  // the current stack home first. Never mutates bench state by itself.
  const grab = useCallback(
    (itemKey: string, from: HandOrigin, available: number) => {
      const o = optsRef.current;
      if (from !== "output" && !o.canMoveItems) return;
      const cur = handRef.current;
      if (cur && cur.itemKey === itemKey) {
        // while committed the extra unit is claimed from the pot regardless
        // of the stack's origin — the pot is where all its copies sit now
        const cap = cur.committed
          ? Math.max(0, o.potCountOf(itemKey) - cur.count)
          : Math.max(0, Math.min(available, o.availableOf(itemKey, cur.from)));
        if (cap <= 0) return;
        set({ ...cur, count: cur.count + 1 });
        return;
      }
      if (cur) cancel();
      const cap =
        from === "brew"
          ? Math.max(0, Math.min(available, o.potCountOf(itemKey)))
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
    optsRef.current.benchActions.moveToInventory(itemKey, n);
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
        const inside = hits(e.clientX, e.clientY, CAULDRON_DROP_SELECTOR);
        if (inside && !h.committed) {
          optsRef.current.benchActions.moveToBrew(h.itemKey, h.count);
          set({ ...h, committed: true, x: e.clientX, y: e.clientY });
          return;
        }
        if (!inside && h.committed) {
          optsRef.current.benchActions.moveToInventory(h.itemKey, h.count);
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
      if (h.from === "output" || hits(e.clientX, e.clientY, CAULDRON_DROP_SELECTOR)) settle();
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

  return useMemo<BenchHand>(
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
