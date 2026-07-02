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
  autoResolvePlays,
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

// ── 1. The base set is the real d40 table ────────────────────────────────────

describe("base recipe set", () => {
  it("holds 41 recipes (40 rolls; roll 16 is both Bright and Frenzy)", () => {
    expect(baseRecipes.length).toBe(41);
    const roll16 = baseRecipes.filter((r) => r.roll === 16).map((r) => r.name);
    expect(roll16.sort()).toEqual(["Bright", "Frenzy"]);
  });

  it("evaluates every recipe to 'off' for an empty brew", () => {
    const empty = brew([]);
    for (const r of baseRecipes) {
      expect(evaluate(empty, r).status, `recipe ${r.key} should be off`).toBe("off");
    }
  });
});

// ── 2. Swana's Serum (the canonical healing profile) ─────────────────────────

describe("Swana's Serum", () => {
  it("Aphasia Flower + Noble Roses is a perfect match", () => {
    const b = brew(["Aphasia Flower", "Noble Roses"]);
    expect(effectiveTally(b)).toEqual({ En: 1, Crallax: 1, A: 2 });
    expect(evaluate(b, recipe("swanas-serum")).status).toBe("perfect");
  });
});

// ── 3. Black Gas: the wildcard recipe ────────────────────────────────────────
// Shadow Demon Liver emits nothing but grants ⊖×2; either berry works because
// the recipe IS the lone Necromancy note left after striking the off-tone.

describe("Black Gas", () => {
  it("is defined as the single tuning [N]", () => {
    expect(recipe("black-gas").reqs).toEqual([["N"]]);
  });

  it("is craftable from Liver + Ichorberries AND Liver + Bitterhearts", () => {
    for (const berry of ["Ichorberries", "Bitterhearts"]) {
      const b = brew(["Shadow Demon Liver", berry]);
      const res = evaluate(b, recipe("black-gas"));
      expect(res.status, `via ${berry}`).toBe("craftable");
      expect(res.exN).toBe(1);
    }
  });

  it("becomes perfect after striking the off-tone", () => {
    const b = brew(["Shadow Demon Liver", "Ichorberries"], ["En"]);
    expect(effectiveTally(b)).toEqual({ N: 1 });
    expect(evaluate(b, recipe("black-gas")).status).toBe("perfect");
  });
});

// ── 4. Multi-tuning: either slashed alternative bottles the perfume ──────────

describe("Pepperpop Mixture (2 tunings)", () => {
  it("is perfect via Fjeldling Scale AND via Northman's Beard", () => {
    const viaScale = brew(["Fjeldling Scale", "Pepperpops"]);
    const viaBeard = brew(["Northman's Beard", "Pepperpops"]);
    expect(evaluate(viaScale, recipe("pepperpop-mixture")).status).toBe("perfect");
    expect(evaluate(viaBeard, recipe("pepperpop-mixture")).status).toBe("perfect");
  });

  it("reports which tuning matched", () => {
    const viaScale = brew(["Fjeldling Scale", "Pepperpops"]);
    const viaBeard = brew(["Northman's Beard", "Pepperpops"]);
    const a = evaluate(viaScale, recipe("pepperpop-mixture"));
    const b = evaluate(viaBeard, recipe("pepperpop-mixture"));
    expect(a.reqIndex).not.toBe(b.reqIndex);
  });
});

// ── 5. Bright vs Frenzy (both are roll 16) ───────────────────────────────────

describe("Bright and Frenzy", () => {
  it("Brightflower alone is Bright, not Frenzy", () => {
    const b = brew(["Brightflower"]);
    expect(evaluate(b, recipe("bright")).status).toBe("perfect");
    expect(evaluate(b, recipe("frenzy")).status).toBe("off");
  });

  it("adding Northman's Beard tips it into Frenzy (and out of Bright)", () => {
    const b = brew(["Brightflower", "Northman's Beard"]);
    expect(evaluate(b, recipe("frenzy")).status).toBe("perfect");
    expect(evaluate(b, recipe("bright")).status).toBe("off");
  });
});

// ── 6. Quantified slot alternative: Chrythsmeum ×4 ───────────────────────────

describe("Antimagic Auroma", () => {
  it("Chrythsmeum ×4 + Seacursed Scale is a perfect match", () => {
    const b = brew([
      "Chrythsmeum",
      "Chrythsmeum",
      "Chrythsmeum",
      "Chrythsmeum",
      "Seacursed Scale",
    ]);
    expect(evaluate(b, recipe("antimagic-auroma")).status).toBe("perfect");
  });

  it("Arcanavore Organ ×2 (both slots) is also perfect", () => {
    const b = brew(["Arcanavore Organ", "Arcanavore Organ"]);
    expect(evaluate(b, recipe("antimagic-auroma")).status).toBe("perfect");
  });
});

// ── 7. Every common combo from the table brews its perfume ───────────────────

describe("d40 table combos", () => {
  it("every combo lands 'perfect' after auto-resolving its wildcards", () => {
    for (const r of baseRecipes) {
      for (const [ci, combo] of r.combos.entries()) {
        const ings = combo.ings.map(ing);
        const plays = autoResolvePlays(ings, r.reqs[combo.req]);
        const state: BrewState = {
          ingredients: ings,
          minusPlays: plays.minusPlays,
          plusPlays: plays.plusPlays,
        };
        expect(
          evaluate(state, r).status,
          `${r.key} combo ${ci} (${combo.ings.join(" + ")})`,
        ).toBe("perfect");
      }
    }
  });
});

// ── 8. Multiset primitive unit checks ────────────────────────────────────────

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
