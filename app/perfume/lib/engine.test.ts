import { describe, it, expect } from "vitest";
import { baseIngredients, baseRecipes } from "../data/base";
import type { BrewState } from "./types";
import {
  msSize,
  msDiff,
  msEqual,
  msFromList,
  effectiveTally,
  evaluate,
} from "./engine";

// ── Helpers ──────────────────────────────────────────────────────────────────

function ing(name: string) {
  const found = baseIngredients.find((i) => i.name === name);
  if (!found) throw new Error(`No base ingredient named "${name}"`);
  return found;
}

function recipe(id: string) {
  const found = baseRecipes.find((r) => r.key === `base:${id}`);
  if (!found) throw new Error(`No base recipe with id "${id}"`);
  return found;
}

function brew(
  names: string[],
  minusPlays: string[] = [],
  plusPlays: string[] = [],
): BrewState {
  return {
    ingredients: names.map(ing),
    minusPlays,
    plusPlays,
  };
}

// ── 1. Empty brew is 'off' for every recipe ──────────────────────────────────

describe("empty brew", () => {
  it("evaluates to 'off' for every recipe (no false perfect/craftable)", () => {
    const empty = brew([]);
    for (const r of baseRecipes) {
      const res = evaluate(empty, r);
      expect(res.status, `recipe ${r.key} should be off`).toBe("off");
    }
  });
});

// ── 2. Potion of Healing ─────────────────────────────────────────────────────

describe("Potion of Healing", () => {
  it("Aphasia Flower + Noble Roses is a perfect 'healing' match", () => {
    const b = brew(["Aphasia Flower", "Noble Roses"]);
    expect(effectiveTally(b)).toEqual({ En: 1, Crallax: 1, A: 2 });
    expect(evaluate(b, recipe("healing")).status).toBe("perfect");
  });
});

// ── 3. Tincture of True Sight ────────────────────────────────────────────────

describe("Tincture of True Sight", () => {
  it("Oracite alone is a perfect 'truesight' match", () => {
    const b = brew(["Oracite"]);
    expect(effectiveTally(b)).toEqual({ D: 3 });
    expect(evaluate(b, recipe("truesight")).status).toBe("perfect");
  });
});

// ── 4. Legendary: Cosmic Saspacian No. 5 (⊕ wildcard) ────────────────────────

describe("Cosmic Saspacian No. 5", () => {
  it("Southollow Royal Tulip alone is 'craftable' (miN=1 <= P=1)", () => {
    const b = brew(["Southollow Royal Tulip"]);
    const res = evaluate(b, recipe("cosmic"));
    expect(res.status).toBe("craftable");
    expect(res.miN).toBe(1);
    expect(res.P).toBe(1);
    expect(res.missing).toEqual({ Saspacian: 1 });
  });

  it("becomes 'perfect' after a ⊕ play summoning 'Saspacian'", () => {
    const b = brew(["Southollow Royal Tulip"], [], ["Saspacian"]);
    expect(effectiveTally(b)).toEqual({ Saspacian: 1 });
    expect(evaluate(b, recipe("cosmic")).status).toBe("perfect");
  });
});

// ── 5. Strike: ⊖ removes an excess token ─────────────────────────────────────

describe("Strike with Shadow Demon Liver", () => {
  // Oracite (D,D,D) + Goat Fat (A) leaves one excess 'A' against truesight (D,D,D).
  // Shadow Demon Liver grants 2 ⊖ charges so the excess is correctable.
  it("excess 'A' shows 'craftable' with a ⊖ charge available", () => {
    const b = brew(["Oracite", "Goat Fat", "Shadow Demon Liver"]);
    const res = evaluate(b, recipe("truesight"));
    expect(res.status).toBe("craftable");
    expect(res.excess).toEqual({ A: 1 });
    expect(res.exN).toBe(1);
    expect(res.M).toBe(2);
  });

  it("becomes 'perfect' after a ⊖ play striking the excess 'A'", () => {
    const b = brew(["Oracite", "Goat Fat", "Shadow Demon Liver"], ["A"], []);
    expect(effectiveTally(b)).toEqual({ D: 3 });
    expect(evaluate(b, recipe("truesight")).status).toBe("perfect");
  });
});

// ── 6. Multiset primitive unit checks ────────────────────────────────────────

describe("multiset primitives", () => {
  it("msSize counts multiplicity, not distinct keys", () => {
    expect(msSize({ A: 2, D: 3 })).toBe(5);
    expect(msSize({})).toBe(0);
    expect(msSize(msFromList(["A", "A", "A"]))).toBe(3);
  });

  it("msDiff keeps only positive remainders", () => {
    expect(msDiff({ A: 3, D: 1 }, { A: 1, D: 2 })).toEqual({ A: 2 });
    expect(msDiff({ A: 1 }, { A: 1, B: 5 })).toEqual({});
  });

  it("msEqual compares over the union of keys, treating missing as 0", () => {
    expect(msEqual({ A: 1, B: 0 }, { A: 1 })).toBe(true);
    expect(msEqual({ A: 1 }, { A: 1, B: 1 })).toBe(false);
    expect(msEqual({}, {})).toBe(true);
    expect(msEqual({ A: 2 }, { A: 1 })).toBe(false);
  });
});
