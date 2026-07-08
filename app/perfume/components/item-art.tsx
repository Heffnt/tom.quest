"use client";

// item-art — THE single item-art switch (DESIGN.md §7 "Item art"). An item
// renders exactly one of three things depending on its key: the perfume
// silhouette, a pure-frequency symbol (⊖/⊕ for pure strike/wild, the named
// frequency's emblem otherwise), or an ingredient's crest art (falling back to
// a color chip). This merges the near-identical switches that used to live in
// `components/item-frame.tsx` (`ItemArt`) and `lib/use-hand.tsx` (`ItemIcon`)
// — same four-way branch, same fallback chain, one implementation.

import type { Ingredient, Source } from "../lib/types";
import { isPureKey } from "../data/base";
import { ChargeSymbol, FrequencySymbol } from "../lib/frequencies";
import IngredientThumb from "./ingredient-thumb";
import { PerfumeGlyph } from "./perfume-glyph";

export interface ItemArtProps {
  /** catalog item key: "base:<name>" | "pure:<id>" (ignored when `perfume`). */
  itemKey: string;
  /** display name, used for the ingredient thumb + its base-art lookup. */
  name: string;
  /** fallback color chip when no art is available. */
  color: string;
  size: number;
  /** render the perfume silhouette instead of resolving `itemKey` at all
   * (item-frame's `item.perfume`, use-hand's perfume flag). */
  perfume?: boolean;
  /** when present, resolves the ingredient thumb's source precisely (as
   * item-frame did via `item.ing`); otherwise source falls back to `base` vs
   * `user` by key prefix (as both call sites did without an Ingredient). */
  ing?: Ingredient;
}

/** How an item looks wherever it is carried or slotted: base ingredients show
 * their crest art; pure frequencies the frequency symbol (⊖/⊕ glyph for pure
 * strike/wild); perfumes the perfume silhouette. */
export function ItemArt({ itemKey, name, color, size, perfume = false, ing }: ItemArtProps) {
  if (perfume) return <PerfumeGlyph size={size} />;

  if (isPureKey(itemKey)) {
    const id = itemKey.slice(5);
    if (id === "strike" || id === "wild") return <ChargeSymbol kind={id} size={size} />;
    return <FrequencySymbol id={id} size={size} />;
  }

  const source: Source = ing
    ? ing.source
    : itemKey.startsWith("base:")
      ? { kind: "base" }
      : { kind: "user", userId: "", name: "" };

  return (
    <IngredientThumb
      name={ing ? ing.name : name}
      source={source}
      color={ing ? ing.color : color}
      size={size}
    />
  );
}
