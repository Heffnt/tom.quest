"use client";

// item-frame — THE reusable rounded-square slot (DESIGN.md §1 "item frame",
// §5 "Interactions"). An item frame is where an item can land; it is the empty
// counterpart to an item (the rounded square that carries art and moves).
//
// One component, five CONTEXTS (DESIGN.md §1): the Ingredients/Frequencies
// catalog grid, an inventory, the brew graph (Phase-4 consumes), a recipe fold
// in the perfume book, and a member's gift target. Two of those contexts —
// catalog and recipe — are also SOURCES: dragging out of them mints a
// HYPOTHETICAL item (dashed border); an inventory mints REAL ones. The frame's
// context alone decides real-vs-hypothetical, so callers never thread that
// choice through by hand.
//
// A frame renders in one of three states:
//   - FILLED    — an item sits here: its art + optional count/charge marks, a
//                 dashed border when the item is hypothetical.
//   - EMPTY     — an affordance (a faint rounded outline); when it could accept
//                 the currently-dragged item it shows a GHOSTED preview of it.
//   - GIFT      — a member tab's drop-to-gift target: permanently ghosted, the
//                 instant gift affordance (DESIGN.md §Interactions "Gifting").
//
// This is presentation + the item art switch only. The drag wiring (what a
// frame accepts, whether it is a source, minting real vs hypothetical) is the
// hand's job — see lib/use-hand.tsx (FrameContext / frameMintsReal). A frame
// advertises its context through the FrameContext union so the hand and the
// Phase-4 graph can register it as a drop target and/or source without knowing
// which of the five places it lives in.

import type { ReactNode } from "react";
import type { Ingredient } from "../lib/types";
import type { IngredientType } from "../lib/types";
import { isPureKey } from "../data/base";
import { ChargeSymbol, FrequencySymbol, TypeGlyph } from "../lib/frequencies";
import IngredientThumb from "./ingredient-thumb";
import { PhialGlyph } from "./phial";

// ── the five contexts (DESIGN.md §1) ─────────────────────────────────────────
// A frame's context is fixed by where it lives. "catalog" and "recipe" are the
// two SOURCE contexts (drag out → a hypothetical item); "inventory" is the only
// source of REAL items; "graph" and "gift" are pure destinations.
export type FrameContext =
  | "catalog" // Ingredients / Frequencies list — hypothetical source
  | "inventory" // a member inventory — real source (stock-checked)
  | "graph" // the brew graph slot — Phase-4 consumes; destination
  | "recipe" // a perfume's recipe fold — hypothetical source
  | "gift"; // a member tab's drop-to-gift target — destination

/** Whether dragging OUT of a frame in this context mints a REAL item (true) or
 * a HYPOTHETICAL one (false). Inventory is the only real source; the two
 * catalog/recipe source contexts mint hypotheticals; the pure-destination
 * contexts (graph/gift) are never sources, so the answer is moot (false). */
export function frameMintsReal(context: FrameContext): boolean {
  return context === "inventory";
}

/** Whether a frame in this context can be a drag SOURCE at all (DESIGN.md §1:
 * catalog + recipe frames and inventories are sources; graph/gift are not). */
export function frameIsSource(context: FrameContext): boolean {
  return context === "catalog" || context === "recipe" || context === "inventory";
}

// ── the item a frame holds ───────────────────────────────────────────────────
// A minimal shape so every context can describe its cargo without pulling the
// whole ingredient. `real` drives the dashed border; the frequency/charge marks
// are optional (the compact catalog card shows them; a bare graph slot may not).
export type FrameItem = {
  key: string; // catalog item key: "base:<name>" | "pure:<id>"
  name: string;
  color: string;
  real: boolean; // false → hypothetical → dashed border
  ing?: Ingredient; // when present, the card can render type + emitted-freq marks
  perfume?: boolean; // render the phial silhouette instead of ingredient art
};

// ── the art on the square (DESIGN.md §7 "Item art") ──────────────────────────
// Ingredients show their crest art (public/perfume/ingredients/ with the
// existing fallback chain); pure frequencies the frequency symbol (⊖/⊕ for pure
// strike/wild); perfumes the phial silhouette.
export function ItemArt({
  item,
  size,
}: {
  item: FrameItem;
  size: number;
}) {
  if (item.perfume) return <PhialGlyph size={size} />;
  if (isPureKey(item.key)) {
    const id = item.key.slice(5);
    if (id === "strike" || id === "wild") return <ChargeSymbol kind={id} size={size} />;
    return <FrequencySymbol id={id} size={size} />;
  }
  if (item.ing) {
    return (
      <IngredientThumb
        name={item.ing.name}
        source={item.ing.source}
        color={item.ing.color}
        size={size}
      />
    );
  }
  // no ingredient handed in (e.g. a graph slot that only knows the key): base
  // keys still resolve their art by name; anything else falls to the color chip
  return (
    <IngredientThumb
      name={item.name}
      source={item.key.startsWith("base:") ? { kind: "base" } : { kind: "user", userId: "", name: "" }}
      color={item.color}
      size={size}
    />
  );
}

// ── the count badge ──────────────────────────────────────────────────────────
export function FrameCountBadge({ n, className }: { n: number; className?: string }) {
  return (
    <span
      className={`pointer-events-none rounded border border-border/70 bg-surface/95 px-1 font-mono text-[10px] font-bold leading-4 tabular-nums text-text ${className ?? ""}`}
    >
      ×{n}
    </span>
  );
}

// ── the frame ────────────────────────────────────────────────────────────────

export interface ItemFrameProps {
  /** Which of the five contexts this frame lives in — decides source/mint. */
  context: FrameContext;
  /** The item resting here; null = an empty frame (affordance). */
  item: FrameItem | null;
  /** px size of the rounded square. */
  size?: number;
  /** Owned count badge (bottom-right); omitted or <=0 draws none. */
  count?: number;
  /** Ghost the art (kept in place, faded) — a slot whose copies are all in the
   * brew reads as "you took the icon" (DESIGN.md §Layout). */
  ghosted?: boolean;
  /** Render the compact catalog card marks: type glyph + emitted-frequency dots
   * + strike/wild charge marks (DESIGN.md §Layout "compact card"). */
  showMarks?: boolean;
  /** When empty AND this preview item is set, show a ghosted affordance of the
   * item that would land here (DESIGN.md §Interactions "ghosted affordance"). */
  ghostPreview?: FrameItem | null;
  /** Grabbable/drop handlers from the hand (grabHandlers / frame registration);
   * spread onto the interactive element. */
  handlers?: Record<string, unknown>;
  /** Fill the parent cell (w-full, fixed h-14) instead of a fixed square —
   * for grid slots that flex to a responsive column. */
  fill?: boolean;
  /** aria-label for the interactive frame. */
  label?: string;
  /** title tooltip for the interactive frame (e.g. "Noble Roses ×3"). */
  title?: string;
  /** Extra content overlaid on the frame (e.g. a per-slot gift button). */
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  "data-testid"?: string;
}

export default function ItemFrame({
  context,
  item,
  size = 44,
  count,
  ghosted = false,
  showMarks = false,
  ghostPreview = null,
  handlers,
  fill = false,
  label,
  title,
  children,
  className,
  disabled,
  "data-testid": testid,
}: ItemFrameProps) {
  const isGift = context === "gift";
  // A hypothetical item, or the gift target, reads with a dashed border
  // (DESIGN.md §1 real/hypothetical, §Interactions gifting affordance).
  const dashed = isGift || (!!item && !item.real);

  const frameClass = [
    "relative grid h-14 place-items-center rounded-lg border bg-bg/40 transition-colors duration-150",
    fill ? "w-full" : "",
    dashed ? "border-dashed" : "border-solid",
    isGift
      ? "border-accent/50 bg-accent/5"
      : item
        ? item.real
          ? "border-border/60 hover:border-accent/60 hover:bg-surface-alt"
          : "border-accent/50 hover:border-accent/70"
        : "border-border/40 hover:border-accent/50",
    handlers && !disabled ? "cursor-pointer touch-none select-none" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      {item ? (
        <FilledBody item={item} size={size} ghosted={ghosted} showMarks={showMarks} />
      ) : ghostPreview ? (
        <span className="pointer-events-none opacity-40">
          <ItemArt item={ghostPreview} size={size} />
        </span>
      ) : isGift ? (
        <GiftAffordance />
      ) : (
        <EmptyAffordance />
      )}
    </>
  );

  const el = handlers ? (
    <button
      type="button"
      {...handlers}
      aria-label={label}
      title={title}
      aria-disabled={disabled || undefined}
      data-testid={testid}
      data-item-key={item?.key}
      data-context={context}
      data-real={item ? String(item.real) : undefined}
      className={frameClass}
      style={fill ? undefined : { width: size + 20 }}
      onDragStart={(e) => e.preventDefault()}
    >
      {body}
    </button>
  ) : (
    <div
      aria-label={label}
      data-testid={testid}
      data-item-key={item?.key}
      data-context={context}
      data-real={item ? String(item.real) : undefined}
      className={frameClass}
      style={fill ? undefined : { width: size + 20 }}
    >
      {body}
    </div>
  );

  // count badge + overlaid children (gift button, etc.) sit outside the
  // interactive element so they don't steal its pointer grammar
  return (
    <span className={`group relative ${fill ? "flex w-full" : "inline-flex"}`}>
      {el}
      {typeof count === "number" && count > 0 && (
        <FrameCountBadge n={count} className="absolute bottom-0.5 right-0.5" />
      )}
      {children}
    </span>
  );
}

function FilledBody({
  item,
  size,
  ghosted,
  showMarks,
}: {
  item: FrameItem;
  size: number;
  ghosted: boolean;
  showMarks: boolean;
}) {
  const ing = item.ing;
  return (
    <span className="grid place-items-center">
      <span className={`inline-flex transition-opacity duration-150 ${ghosted ? "opacity-35" : ""}`}>
        <ItemArt item={item} size={size} />
      </span>
      {showMarks && ing && <CardMarks ing={ing} />}
    </span>
  );
}

// The compact card's marks (DESIGN.md §Layout): type glyph + emitted-frequency
// dots + strike/wild charge marks, under the art. Pure/perfume frames show none.
function CardMarks({ ing }: { ing: Ingredient }) {
  if (isPureKey(ing.key)) return null;
  const marks: ReactNode[] = [];
  for (let i = 0; i < ing.emits.length; i++) {
    marks.push(<FrequencySymbol key={`e${i}`} id={ing.emits[i]} size={13} />);
  }
  for (let i = 0; i < ing.strike; i++) {
    marks.push(<ChargeSymbol key={`s${i}`} kind="strike" size={13} />);
  }
  for (let i = 0; i < ing.wild; i++) {
    marks.push(<ChargeSymbol key={`w${i}`} kind="wild" size={13} />);
  }
  if (marks.length === 0 && !ing.type) return null;
  return (
    <span className="pointer-events-none mt-0.5 flex max-w-full flex-wrap items-center justify-center gap-0.5">
      {ing.type && <TypeGlyph type={ing.type as IngredientType} size={13} />}
      {marks}
    </span>
  );
}

// Empty-frame affordance: a faint rounded outline — "an item can land here".
function EmptyAffordance() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none rounded-md border border-dashed border-border/70"
      style={{ width: "58%", height: "58%" }}
    />
  );
}

// Gift-target affordance: the ghosted item-frame that says "drop to gift"
// (DESIGN.md §Interactions "Gifting"). A small send arrow inside the dashed box.
function GiftAffordance() {
  return (
    <span aria-hidden="true" className="pointer-events-none text-accent/60">
      <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 2 11 13" />
        <path d="M22 2 15 22 11 13 2 9Z" />
      </svg>
    </span>
  );
}
