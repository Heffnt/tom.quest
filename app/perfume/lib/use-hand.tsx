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
// This file has TWO layers:
//
//   1. The SPEC-GRAMMAR layer (useItemDrag + DropTarget/DragPayload/StrikeDrag
//      below) — the item/frame drag grammar the Phase-4 brew graph consumes. It
//      exposes the strike-circle drop capability and the real/hypothetical mint
//      rules now; the graph registers its own frame + strike-circle drop targets
//      against it when it lands.
//
//   2. The LEGACY BenchHand layer (useHand + BenchHand) — the cursor-stack hand
//      the not-yet-rebuilt stage (cauldron.tsx / output-shelf.tsx) and the input
//      grid still drive through the [data-cauldron-drop] boundary. FROZEN until
//      the Phase-4 stage rebuild; kept intact so that stage and the e2e suite
//      stay green. The pick/settle animation FEEL the new layer preserves lives
//      here (SettleFx). Its boundary rule, verbatim:
//        - "inventory"/"catalog": entering the cauldron commits the stack
//          (moveToBrew), leaving un-commits it (moveToInventory).
//        - "brew": picking up FROM the pot starts committed; carrying out
//          un-commits.
//        - "output": settling over the input panel takes the perfumes.
//      Shift-clicks bypass the hand — callers do direct moves (moveHome/onTake).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BenchActions, Hand, HandApi, HandOrigin } from "./legacy-adapter";
import type { BrewPermissions } from "./brew-types";
import type { FrameContext } from "../components/item-frame";
import { frameIsSource, frameMintsReal } from "../components/item-frame";
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

// ═══════════════════════════════════════════════════════════════════════════
// SPEC-GRAMMAR LAYER (DESIGN.md §5) — the item/frame drag grammar the Phase-4
// brew graph consumes. It carries the mint rules (real vs hypothetical) and the
// strike-circle drop exception now, so the graph can register its own drop
// targets against it without re-deriving any of this. The legacy BenchHand
// above is what the frozen stage still drives; this layer is what replaces it.
// ═══════════════════════════════════════════════════════════════════════════

// What a drag is carrying. An ITEM drag moves a rounded square; a STRIKE drag is
// the sole frequency exception — an available strike charge headed for a
// frequency circle.
export type DragKind = "item" | "strike";

// The two DROP-TARGET kinds (DESIGN.md §1, §5): item FRAMES accept item drags;
// a strike CIRCLE accepts the strike exception. The Phase-4 graph registers its
// frames and frequency circles as these.
export type DropTargetKind = "frame" | "strike-circle";

// A registered drop target the graph (or a panel) hands the drag layer.
export type DropTarget = {
  id: string;
  kind: DropTargetKind;
  /** For a frame: its context (decides whether a source mints real/hypo). */
  context?: FrameContext;
  /** The frequency circle a strike would seal (strike-circle targets only). */
  freq?: string;
  /** Does this target accept the given drag right now? (stock, permission,
   * type). Defaults to kind-compatibility when omitted. */
  accepts?: (drag: DragPayload) => boolean;
  /** Fired when a compatible drag is released over this target. */
  onDrop: (drag: DragPayload) => void;
};

// The payload an item/strike drag carries from pickup to drop.
export type DragPayload = {
  kind: DragKind;
  itemKey: string; // the item's catalog key, or the strike charge's source key
  /** Where the drag originated (a frame context, or "graph" for a pick off the
   * graph, or "charge" for a strike charge lifted off its source ingredient). */
  from: FrameContext | "graph" | "charge";
  /** Real vs hypothetical the mint resolved to (item drags only). */
  real: boolean;
  /** For a strike drag: the frequency circle it will seal is chosen at drop. */
};

/** Resolve whether a NEW item dragged out of `context` is real or hypothetical,
 * respecting the permission matrix and available stock (DESIGN.md §1, §4).
 *
 * - inventory source: REAL, but only while stock remains AND the viewer may add
 *   real ingredients here (owner scope / party / own-real). Past stock, or when
 *   real-adds aren't permitted, it degrades to a hypothetical.
 * - catalog / recipe source: always HYPOTHETICAL (planning placeholders).
 * - graph / gift: not sources — never mint. */
export function mintReal(
  context: FrameContext,
  permissions: Pick<BrewPermissions, "brewAndTake" | "moveItems">,
  stockRemaining: number,
): boolean {
  if (!frameIsSource(context)) return false;
  if (!frameMintsReal(context)) return false; // catalog/recipe → hypothetical
  // inventory source: real only when the owner-scope gate (real adds) is open
  // and stock is left; otherwise the item enters hypothetical, exactly as the
  // store's addToBrew degrades past-stock copies.
  return permissions.brewAndTake && stockRemaining > 0;
}

// Options for the spec-grammar drag hook.
export type ItemDragOptions = {
  /** The open brew's permission matrix — the WHERE/WHAT boundary rules. */
  permissions: BrewPermissions;
  /** Remaining stock of an item in the inventory the drag would draw from. */
  stockOf: (itemKey: string) => number;
};

// The spec-grammar drag surface. Item picks mint real/hypothetical per source
// context; strike picks carry the frequency-circle exception; drop targets are
// registered by whoever owns them (the Phase-4 graph, a gift tab, an inventory).
export interface ItemDrag {
  drag: DragPayload | null;
  /** Begin an ITEM drag out of a source frame/inventory. Resolves real vs
   * hypothetical from the context + permissions + stock. Returns the payload
   * (null if the context can't source, or permissions forbid moving). */
  pickItem(itemKey: string, context: FrameContext): DragPayload | null;
  /** Begin the STRIKE exception: lift an available strike charge off its source
   * ingredient in the graph, headed for a frequency circle. */
  pickStrike(sourceKey: string): DragPayload | null;
  /** Register a drop target (frame or strike-circle). Returns an unregister fn.
   * The Phase-4 graph calls this for its frames and frequency circles. */
  registerTarget(target: DropTarget): () => void;
  /** Whether a registered target accepts the current drag (kind + its own
   * accepts predicate). Used to light a target's ghosted affordance. */
  targetAccepts(target: DropTarget): boolean;
  /** Release the current drag over a target (fires target.onDrop if accepted). */
  dropOn(targetId: string): void;
  /** Abandon the current drag with no drop. */
  clear(): void;
}

const kindMatch = (target: DropTarget, drag: DragPayload): boolean =>
  target.kind === "frame" ? drag.kind === "item" : drag.kind === "strike";

/** The spec-grammar drag hook (DESIGN.md §5). Standalone: it does not touch the
 * legacy BenchHand. The Phase-4 graph mounts this, registers its frame + strike
 * circle targets, and renders the drag ghost; panels can mint hypothetical items
 * off their catalog frames through it. */
export function useItemDrag(opts: ItemDragOptions): ItemDrag {
  const [drag, setDrag] = useState<DragPayload | null>(null);
  const dragRef = useRef<DragPayload | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const targets = useRef(new Map<string, DropTarget>());

  const set = useCallback((d: DragPayload | null) => {
    dragRef.current = d;
    setDrag(d);
  }, []);

  const pickItem = useCallback(
    (itemKey: string, context: FrameContext): DragPayload | null => {
      const o = optsRef.current;
      // WHERE is open to any member (moveItems); a visitor cannot drag at all.
      if (!o.permissions.moveItems) return null;
      if (!frameIsSource(context)) return null;
      const real = mintReal(context, o.permissions, o.stockOf(itemKey));
      const payload: DragPayload = { kind: "item", itemKey, from: context, real };
      set(payload);
      return payload;
    },
    [set],
  );

  const pickStrike = useCallback(
    (sourceKey: string): DragPayload | null => {
      const o = optsRef.current;
      // strike/wild plays gate on moveItems (WHERE-scoped, per the matrix row
      // "Play/undo strikes & wilds" — open to any member on any brew they can
      // reach).
      if (!o.permissions.moveItems) return null;
      const payload: DragPayload = {
        kind: "strike",
        itemKey: sourceKey,
        from: "charge",
        real: true,
      };
      set(payload);
      return payload;
    },
    [set],
  );

  const registerTarget = useCallback((target: DropTarget) => {
    targets.current.set(target.id, target);
    return () => {
      targets.current.delete(target.id);
    };
  }, []);

  const targetAccepts = useCallback((target: DropTarget): boolean => {
    const d = dragRef.current;
    if (!d) return false;
    if (!kindMatch(target, d)) return false;
    return target.accepts ? target.accepts(d) : true;
  }, []);

  const dropOn = useCallback((targetId: string) => {
    const d = dragRef.current;
    const target = targets.current.get(targetId);
    if (!d || !target) {
      set(null);
      return;
    }
    if (kindMatch(target, d) && (!target.accepts || target.accepts(d))) {
      target.onDrop(d);
    }
    set(null);
  }, [set]);

  const clear = useCallback(() => set(null), [set]);

  return useMemo<ItemDrag>(
    () => ({ drag, pickItem, pickStrike, registerTarget, targetAccepts, dropOn, clear }),
    [drag, pickItem, pickStrike, registerTarget, targetAccepts, dropOn, clear],
  );
}
