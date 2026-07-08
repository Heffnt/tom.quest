"use client";

// item-frame — THE reusable rounded-square slot (DESIGN.md §1 "item frame",
// §5 "Interactions"). An item frame is where an item can land; it is the empty
// counterpart to an item (the rounded square that carries art and moves).
//
// One component, five CONTEXTS (DESIGN.md §1): the Ingredients/Frequencies
// catalog grid, an inventory, a recipe fold in the perfume panel, a member's
// gift target, and — since Stage B — an item node on the brew graph, which now
// renders through this SAME frame so a graph item looks like an inventory item.
// Three of these contexts are SOURCES: dragging out of a catalog or recipe frame
// mints a HYPOTHETICAL item; an inventory mints REAL ones; the brew graph is a
// "brew"-origin source (its items already sit in the brew). The frame's context
// is descriptive only; the hand (lib/use-hand.tsx) reads the caller's grab spec,
// not this frame, to decide what a drag yields.
//
// The rounded square holds ONLY the icon — the icon fills it (DESIGN.md §1).
// Every other fact about the item sits ON or OUTSIDE the square's edge, never
// inside it: the emitted-frequency dots straddle the BOTTOM edge, the type glyph
// sits at the TOP-RIGHT corner, the count badge pins to the bottom-right, and
// the name renders as a caption BELOW the frame.
//
// A frame renders in one of these states:
//   - FILLED  — an item sits here. Its BACKGROUND encodes real vs hypothetical
//               (DESIGN.md §1, §7): real items sit on the parchment-tan
//               --pf-real ground, hypothetical items on the slate-grey
//               --pf-hypothetical ground. BOTH have SOLID borders — an item is
//               never dashed (dashed is reserved for graph ghosts, §1).
//   - PREVIEW — empty, but the currently-carried stack could land here: a
//               TRANSLUCENT copy of that item behind a SOLID border (DESIGN.md
//               §1 "preview", §5). Not a ghost (a ghost is dashed and describes
//               something missing; a preview is translucent and in your hand).
//   - EMPTY   — a bare drop affordance (a faint dashed "an item can land here"
//               outline) when nothing is carried.
//   - GIFT    — a member tab's drop-to-gift target (DESIGN.md §5 "Gifting").
//
// This is presentation + the item art switch only. The drag wiring lives in the
// hand (lib/use-hand.tsx) and the callers' grab specs.

import type { CSSProperties, ReactNode } from "react";
import type { Ingredient } from "../lib/types";
import type { IngredientType } from "../lib/types";
import { isPureKey } from "../data/base";
import { FrequencySymbol, TypeGlyph, ChargeSymbol } from "../lib/frequencies";
import { CountBadge } from "./badge";
import { SendGlyph } from "./glyphs";
import { ItemArt } from "./item-art";
import { cn } from "./ui";

// ── the five contexts (DESIGN.md §1) ─────────────────────────────────────────
// A frame's context is fixed by where it lives. "catalog" and "recipe" are
// hypothetical SOURCE contexts (drag out → a hypothetical item); "inventory" is
// the only source of REAL items; "brew" is a graph item already in the brew (its
// grab picks one up FROM the brew); "gift" is a pure destination.
export type FrameContext =
  | "catalog" // Ingredients / Frequencies list — hypothetical source
  | "inventory" // a member inventory — real source (stock-checked)
  | "recipe" // a perfume's recipe fold — hypothetical source
  | "brew" // an item node on the brew graph — a "brew"-origin grab source
  | "gift"; // a member tab's drop-to-gift target — destination

// ── the item a frame holds ───────────────────────────────────────────────────
// A minimal shape so every context can describe its cargo without pulling the
// whole ingredient. `real` drives the tan-vs-grey ground; the frequency/charge
// marks are optional (the compact catalog card shows them; a bare inventory slot
// may not).
export type FrameItem = {
  key: string; // catalog item key: "base:<name>" | "pure:<id>"
  name: string;
  color: string;
  real: boolean; // true → parchment-tan ground; false → slate-grey ground
  ing?: Ingredient; // when present, the card can render type + emitted-freq marks
  perfume?: boolean; // render the perfume silhouette instead of ingredient art
};

// ── the frame ────────────────────────────────────────────────────────────────

export interface ItemFrameProps {
  /** Which of the four contexts this frame lives in — descriptive metadata. */
  context: FrameContext;
  /** The item resting here; null = an empty frame (affordance or preview). */
  item: FrameItem | null;
  /** px size of the icon that fills the square. */
  size?: number;
  /** Owned count badge (bottom-right); omitted or <=0 draws none. */
  count?: number;
  /** How the count badge reads: "frame" (default) shows for any count>0 (an
   * inventory slot shows "×1" the same as "×3"); "chip" hides a lone copy and
   * only marks genuine stacks (count>1) — used by the brew graph, where a solo
   * item shouldn't carry a redundant "×1". */
  countVariant?: "frame" | "chip";
  /** Ghost the art (kept in place, faded) — a slot whose copies are all in the
   * brew reads as "you took the icon" (DESIGN.md §Layout). */
  ghosted?: boolean;
  /** Render the compact catalog card marks: the type glyph in the top-right
   * corner + the emitted-frequency dots / charge marks straddling the bottom
   * edge (DESIGN.md §1 "marks sit on or outside the edge"). */
  showMarks?: boolean;
  /** A caption rendered BELOW the frame, with room for the FULL name (wraps,
   * never truncated). Used by the catalog + recipe cards. Omit to show no
   * caption (inventory slots carry the name in their tooltip instead). */
  name?: string;
  /** When empty AND this preview item is set, show a TRANSLUCENT copy of the
   * item that would land here, behind a SOLID border (DESIGN.md §1 "preview"). */
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
  countVariant = "frame",
  ghosted = false,
  showMarks = false,
  name,
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
  const showingPreview = !item && !!ghostPreview;

  // Borders tell the state apart (DESIGN.md §1): a FILLED item and a PREVIEW
  // both get the SOLID picture-frame edge (.pf-frame) — an item is never dashed.
  // A filled item's BACKGROUND carries the real/hypothetical ground; a preview
  // keeps a neutral ground and fades the carried icon instead. The gift target
  // and a bare empty frame stay dashed "an item can land here" affordances.
  const ground = item ? (item.real ? "var(--pf-real)" : "var(--pf-hypothetical)") : undefined;
  const frameClass = [
    "relative grid h-14 place-items-center rounded-md transition-colors duration-150",
    fill ? "w-full" : "",
    item
      ? "pf-frame"
      : showingPreview
        ? "pf-frame bg-bg/40"
        : isGift
          ? "border-2 border-dashed border-accent/50 bg-accent/5"
          : "border-2 border-dashed border-border/50 bg-bg/40 hover:border-accent/40",
    handlers && !disabled ? "cursor-pointer touch-none select-none" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  // Merge the ground background with the fixed-square width (fill frames flex).
  const style: CSSProperties = {
    ...(fill ? {} : { width: size + 20 }),
    ...(ground ? { background: ground } : {}),
  };

  const body = (
    <>
      {item ? (
        <FilledBody item={item} size={size} ghosted={ghosted} showMarks={showMarks} />
      ) : showingPreview ? (
        // the carried stack could land here — a translucent copy of it
        <span className="pointer-events-none opacity-40">
          <ItemArt
            itemKey={ghostPreview!.key}
            name={ghostPreview!.name}
            color={ghostPreview!.color}
            perfume={ghostPreview!.perfume}
            ing={ghostPreview!.ing}
            size={size}
          />
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
      style={style}
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
      style={style}
    >
      {body}
    </div>
  );

  // count badge + overlaid children (gift button, ×n, etc.) sit outside the
  // interactive element so they don't steal its pointer grammar. They anchor to
  // the frame's own relative box — so with a caption below, they still pin to
  // the frame, not the taller column.
  const overlays = (
    <>
      {typeof count === "number" && (
        <CountBadge count={count} variant={countVariant} className="absolute bottom-0.5 right-0.5" />
      )}
      {children}
    </>
  );

  if (!name) {
    return (
      <span className={`group relative ${fill ? "flex w-full" : "inline-flex"}`}>
        {el}
        {overlays}
      </span>
    );
  }

  // Caption BELOW the frame (DESIGN.md §1) with room for the FULL name: it wraps
  // (never truncates) and reserves two lines so a row of frames stays aligned.
  return (
    <span className={`group flex flex-col items-center gap-1.5 ${fill ? "w-full" : ""}`}>
      <span className={`relative ${fill ? "flex w-full" : "inline-flex"}`}>
        {el}
        {overlays}
      </span>
      <span
        className={cn(
          "flex min-h-[2.1em] items-start justify-center px-0.5 text-center text-[10px] font-medium leading-tight text-text-muted",
          fill ? "w-full" : "w-[4.75rem]",
        )}
        title={name}
      >
        {name}
      </span>
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
  const showType = showMarks && !!ing && !isPureKey(ing.key) && !!ing.type;
  return (
    <>
      {/* the icon fills the square — nothing else lives inside it */}
      <span
        className={`inline-flex transition-opacity duration-150 ${ghosted ? "opacity-35" : ""}`}
      >
        <ItemArt
          itemKey={item.key}
          name={item.name}
          color={item.color}
          perfume={item.perfume}
          ing={item.ing}
          size={size}
        />
      </span>
      {/* the ingredient TYPE sits at the TOP-RIGHT corner, clear of the icon and
          the emitted frequencies along the bottom (DESIGN.md §1). */}
      {showType && (
        <span className="pointer-events-none absolute -right-1.5 -top-1.5 z-10">
          <TypeGlyph type={ing!.type as IngredientType} size={14} />
        </span>
      )}
      {/* emitted-frequency dots + strike/wild charges straddle the BOTTOM edge */}
      {showMarks && ing && <EdgeFrequencies ing={ing} />}
    </>
  );
}

// The emitted-frequency dots (DESIGN.md §1): small circles straddling the frame's
// BOTTOM edge, overlapping the border, plus any strike/wild charge marks. The
// type glyph is drawn separately at the top-right corner (see FilledBody).
// Pure/perfume frames emit none.
function EdgeFrequencies({ ing }: { ing: Ingredient }) {
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
  if (marks.length === 0) return null;
  return (
    <span className="pointer-events-none absolute -bottom-1.5 left-1/2 z-10 flex max-w-[130%] -translate-x-1/2 flex-wrap items-center justify-center gap-0.5">
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

// Gift-target affordance: the drop-to-gift target (DESIGN.md §5 "Gifting"). A
// small send arrow inside the dashed box.
function GiftAffordance() {
  return (
    <span aria-hidden="true" className="pointer-events-none text-accent/60">
      <SendGlyph size={20} />
    </span>
  );
}
