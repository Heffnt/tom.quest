import { describe, it, expect } from "vitest";
import { baseIngredients, pureIngredients, basePerfumes } from "../data/base";
import type { BrewState } from "./types";
import {
  msSize,
  msDiff,
  msEqual,
  msScale,
  msFromList,
  msToList,
  msIsSubset,
  effectiveTally,
  brewTally,
  combineFrequencies,
  traceCombination,
  evaluate,
  evalReq,
  autoResolvePlays,
  findRecipes,
  closestPath,
} from "./engine";
import type { FreqInstance } from "./engine";
import type { Perfume, Ingredient } from "./types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function ing(name: string) {
  const found = [...baseIngredients, ...pureIngredients].find((i) => i.name === name);
  if (!found) throw new Error(`No ingredient named "${name}"`);
  return found;
}

function perfume(id: string) {
  const found = basePerfumes.find((r) => r.key === `base:${id}`);
  if (!found) throw new Error(`No base perfume with id "${id}"`);
  return found;
}

function brew(
  names: string[],
  strikePlays: string[] = [],
  wildPlays: string[] = [],
): BrewState {
  return {
    ingredients: names.map(ing),
    strikePlays,
    wildPlays,
  };
}

// ── 1. The base set is the real d40 table ────────────────────────────────────

describe("base perfume set", () => {
  it("holds 41 perfumes (40 rolls; roll 16 is both Bright and Frenzy)", () => {
    expect(basePerfumes.length).toBe(41);
    const roll16 = basePerfumes.filter((r) => r.roll === 16).map((r) => r.name);
    expect(roll16.sort()).toEqual(["Bright", "Frenzy"]);
  });

  it("with an empty cauldron, every perfume is in reach (and none brewed)", () => {
    const empty = brew([]);
    const statuses = basePerfumes.map((r) => evaluate(empty, r).status);
    expect(statuses.filter((s) => s === "craftable").length).toBe(41);
    expect(statuses.filter((s) => s === "perfect").length).toBe(0);
  });
});

// ── 1b. "In reach" = the perfume can still be made by ADDING frequencies ─────

describe("in reach semantics", () => {
  it("a brew that is a subset of a recipe is in reach; one with stray excess is not", () => {
    const b = brew(["Brightflower"]); // {Ev, En}
    // Frenzy needs {Ignetium, C, Ev, En} — Brightflower is a strict subset
    expect(evaluate(b, perfume("frenzy")).status).toBe("craftable");
    // Corpse Gas needs {C, Yonescope, T, Ev} — the En is excess with no strike
    expect(evaluate(b, perfume("corpse-gas")).status).toBe("off");
  });

  it("an available strike keeps excess-carrying perfumes in reach", () => {
    // {N, En} — En is excess for Black Gas [N], but the pure strike covers it
    const withStrike = brew(["Ichorberries", "Pure Strike"]);
    expect(evaluate(withStrike, perfume("black-gas")).status).toBe("craftable");
    const without = brew(["Ichorberries"]);
    expect(evaluate(without, perfume("black-gas")).status).toBe("off");
  });

  it("spending a strike updates the panel dynamically (off -> in reach -> perfect)", () => {
    const before = brew(["Ichorberries", "Pure Strike"]);
    expect(evaluate(before, perfume("black-gas")).status).toBe("craftable");
    const after = brew(["Ichorberries", "Pure Strike"], ["En"]);
    expect(effectiveTally(after)).toEqual({ N: 1 });
    expect(evaluate(after, perfume("black-gas")).status).toBe("perfect");
  });
});

// ── 1c. Pure frequencies ─────────────────────────────────────────────────────

describe("pure frequencies", () => {
  it("cover every frequency plus a pure strike and a pure wild", () => {
    expect(pureIngredients.length).toBe(26 + 2);
    const strike = pureIngredients.find((i) => i.key === "pure:strike")!;
    const wild = pureIngredients.find((i) => i.key === "pure:wild")!;
    expect(strike.strike).toBe(1);
    expect(wild.wild).toBe(1);
  });

  it("can brew a perfume with no real ingredients at all", () => {
    // Bright = {Ev, En} from two pure frequencies
    const b = brew(["Pure Evocation", "Pure Enchantment"]);
    expect(evaluate(b, perfume("bright")).status).toBe("perfect");
  });

  it("a wild play counts toward the tally", () => {
    const b = brew(["Pure Evocation", "Pure Wild"], [], ["En"]);
    expect(effectiveTally(b)).toEqual({ Ev: 1, En: 1 });
    expect(evaluate(b, perfume("bright")).status).toBe("perfect");
  });
});

// ── 2. Swana's Serum (the canonical healing profile) ─────────────────────────

describe("Swana's Serum", () => {
  it("Aphasia Flower + Noble Roses is a perfect match", () => {
    const b = brew(["Aphasia Flower", "Noble Roses"]);
    expect(effectiveTally(b)).toEqual({ En: 1, Crallax: 1, A: 2 });
    expect(evaluate(b, perfume("swanas-serum")).status).toBe("perfect");
  });
});

// ── 3. Black Gas: the ruled requirement ──────────────────────────────────────
// The common recipe carries wildcards (Shadow Demon Liver ⊖×2), so the
// requirement comes from Joe's ruling: the perfume IS the lone Necromancy
// frequency. Its combos are published with their strike cost.

describe("Black Gas", () => {
  it("is defined as the single recipe [N]", () => {
    expect(perfume("black-gas").recipes).toEqual([["N"]]);
  });

  it("is craftable from Liver + Ichorberries AND Liver + Bitterhearts", () => {
    for (const berry of ["Ichorberries", "Bitterhearts"]) {
      const b = brew(["Shadow Demon Liver", berry]);
      const res = evaluate(b, perfume("black-gas"));
      expect(res.status, `via ${berry}`).toBe("craftable");
      expect(res.exN).toBe(1);
    }
  });

  it("becomes perfect after striking the off-frequency", () => {
    const b = brew(["Shadow Demon Liver", "Ichorberries"], ["En"]);
    expect(effectiveTally(b)).toEqual({ N: 1 });
    expect(evaluate(b, perfume("black-gas")).status).toBe("perfect");
  });
});

// ── 4. Multi-recipe: either slashed alternative brews the perfume ────────────

describe("Pepperpop Mixture (2 recipes)", () => {
  it("is perfect via Fjeldling Scale AND via Northman's Beard", () => {
    const viaScale = brew(["Fjeldling Scale", "Pepperpops"]);
    const viaBeard = brew(["Northman's Beard", "Pepperpops"]);
    expect(evaluate(viaScale, perfume("pepperpop-mixture")).status).toBe("perfect");
    expect(evaluate(viaBeard, perfume("pepperpop-mixture")).status).toBe("perfect");
  });

  it("reports which recipe matched", () => {
    const viaScale = brew(["Fjeldling Scale", "Pepperpops"]);
    const viaBeard = brew(["Northman's Beard", "Pepperpops"]);
    const a = evaluate(viaScale, perfume("pepperpop-mixture"));
    const b = evaluate(viaBeard, perfume("pepperpop-mixture"));
    expect(a.reqIndex).not.toBe(b.reqIndex);
  });
});

// ── 5. Bright vs Frenzy (both are roll 16) ───────────────────────────────────

describe("Bright and Frenzy", () => {
  it("Brightflower alone brews Bright; Frenzy stays in reach (a superset)", () => {
    const b = brew(["Brightflower"]);
    expect(evaluate(b, perfume("bright")).status).toBe("perfect");
    expect(evaluate(b, perfume("frenzy")).status).toBe("craftable");
  });

  it("adding Northman's Beard tips it into Frenzy (and past Bright)", () => {
    const b = brew(["Brightflower", "Northman's Beard"]);
    expect(evaluate(b, perfume("frenzy")).status).toBe("perfect");
    // Bright is now overshot: two excess frequencies and no strikes on hand
    expect(evaluate(b, perfume("bright")).status).toBe("off");
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
    expect(evaluate(b, perfume("antimagic-auroma")).status).toBe("perfect");
  });

  it("Arcanavore Organ ×2 (both slots) is also perfect", () => {
    const b = brew(["Arcanavore Organ", "Arcanavore Organ"]);
    expect(evaluate(b, perfume("antimagic-auroma")).status).toBe("perfect");
  });
});

// ── 7. Every common combo from the table brews its perfume ───────────────────

describe("d40 table combos", () => {
  it("every combo lands 'perfect' after auto-resolving its wildcards", () => {
    for (const r of basePerfumes) {
      for (const [ci, combo] of r.combos.entries()) {
        const ings = combo.ings.map(ing);
        const plays = autoResolvePlays(ings, r.recipes[combo.req]);
        const state: BrewState = {
          ingredients: ings,
          strikePlays: plays.strikePlays,
          wildPlays: plays.wildPlays,
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

  it("msIsSubset checks containment with multiplicity", () => {
    expect(msIsSubset({ A: 1 }, { A: 2, B: 1 })).toBe(true);
    expect(msIsSubset({ A: 3 }, { A: 2 })).toBe(false);
    expect(msIsSubset({}, {})).toBe(true);
  });
});

// ── 9. findRecipes: live combos from the catalog ────────────────────────

describe("findRecipes", () => {
  it("finds the single-ingredient combo for Bright", () => {
    const combos = findRecipes(["Ev", "En"], baseIngredients);
    expect(combos.map((c) => c.ings)).toContainEqual(["Brightflower"]);
  });

  it("finds Swana's Serum's common combo among the exact covers", () => {
    const combos = findRecipes(["A", "A", "Crallax", "En"], baseIngredients);
    expect(
      combos.some(
        (c) =>
          c.ings.slice().sort().join("+") ===
          ["Aphasia Flower", "Noble Roses"].sort().join("+"),
      ),
    ).toBe(true);
  });

  it("allows ingredient repeats (Chrythsmeum ×4 for Antimagic)", () => {
    const combos = findRecipes(
      ["C", "D", "D", "D", "D", "T"],
      baseIngredients,
      0,
      50,
    );
    expect(
      combos.some((c) => c.ings.filter((n) => n === "Chrythsmeum").length === 4),
    ).toBe(true);
  });

  it("never uses strike/wild-carrying or pure ingredients, even with strikes allowed", () => {
    const all = [...baseIngredients, ...pureIngredients];
    const banned = new Set(
      all.filter((i) => i.strike > 0 || i.wild > 0 || i.key.startsWith("pure:")).map((i) => i.name),
    );
    for (const r of basePerfumes) {
      for (const req of r.recipes) {
        for (const combo of findRecipes(req, all, 2, 12)) {
          expect(combo.strikes).toBeLessThanOrEqual(2);
          for (const name of combo.ings) {
            expect(banned.has(name), `${name} in a combo for ${r.key}`).toBe(false);
          }
        }
      }
    }
  });

  it("with maxStrikes, finds over-emitting combos that report their strike cost", () => {
    // Black Gas is a single Necromancy note; the berries over-emit around it
    const combos = findRecipes(["N"], baseIngredients, 2, 120);
    // strikes 0 means exact — nothing to strike
    for (const c of combos.filter((x) => x.strikes === 0)) {
      expect(c.ings.length).toBeGreaterThan(0);
    }
    // over-emitting alternatives exist and report their strike cost, but the
    // strike CARRIERS themselves (Shadow Demon Liver) never join a combo
    expect(combos.some((c) => c.strikes > 0)).toBe(true);
    for (const c of combos) {
      expect(c.ings.includes("Shadow Demon Liver")).toBe(false);
      expect(c.ings.includes("Southollow Royal Tulip")).toBe(false);
    }
    // Ichorberries emit N plus one off frequency -> a 1-strike solo combo
    expect(combos.some((c) => c.ings.join("+") === "Ichorberries" && c.strikes === 1)).toBe(true);
  });

  it("with maxStrikes 0, combos sum exactly to the recipe", () => {
    const combos = findRecipes(["Ev", "En"], baseIngredients, 0, 50);
    for (const c of combos) expect(c.strikes).toBe(0);
  });

  it("every strike-free d40 combo is rediscovered by the solver", () => {
    for (const r of basePerfumes) {
      for (const combo of r.combos) {
        if (combo.strikes > 0) continue;
        const found = findRecipes(r.recipes[combo.req], baseIngredients, 0, 24);
        const want = combo.ings.slice().sort().join("+");
        expect(
          found.some((c) => c.ings.slice().sort().join("+") === want),
          `${r.key}: ${want}`,
        ).toBe(true);
      }
    }
  });
});

// ── 10. Auto-combination ─────────────────────────────────────────────────────

describe("combineFrequencies", () => {
  it("fuses a full component set into its named frequency", () => {
    // Ignetium = Ev ×2, En, C
    const { tally, derived } = combineFrequencies(msFromList(["Ev", "Ev", "En", "C", "Ev"]));
    expect(tally).toEqual({ Ignetium: 1, Ev: 1 });
    expect(derived.map((d) => d.id)).toEqual(["Ignetium"]);
  });

  it("chains: derived frequencies can combine into bigger ones", () => {
    // raw components of Yonescope (I,N,N,T) + Ignetium (Ev,Ev,En,C) + C,C
    // fuse all the way up into Letchettin
    const pool = msFromList(["I", "N", "N", "T", "Ev", "Ev", "En", "C", "C", "C"]);
    const { tally, derived } = combineFrequencies(pool);
    expect(tally).toEqual({ Letchettin: 1 });
    expect(derived.map((d) => d.id).sort()).toEqual(["Ignetium", "Letchettin", "Yonescope"]);
  });

  it("a self-combining recipe still brews raw (Pensive Perfume)", () => {
    // Pensive's recipe {Albutian, Chrysipil, N, T} auto-combines
    // (Albutian + Chrysipil -> Ontoligin), so matching compares raw and
    // combined forms of BOTH sides — the common combo must stay perfect.
    const req = perfume("pensive-perfume").recipes[0];
    expect(combineFrequencies(msFromList(req)).derived.length).toBeGreaterThan(0);
    const b = brew(["Great Cold Shard", "Melting Dewdrops"]);
    expect(evaluate(b, perfume("pensive-perfume")).status).toBe("perfect");
  });

  it("brewTally applies strikes/wilds first, then combination", () => {
    // Pepperpops (Ev,Ev) + Brightflower (Ev,En) + Silver (C) -> raw {Ev×3,En,C}
    // -> Ignetium consumes Ev×2,En,C leaving {Ignetium, Ev}
    const b = brew(["Pepperpops", "Brightflower", "Silver"]);
    expect(effectiveTally(b)).toEqual({ Ev: 3, En: 1, C: 1 });
    expect(brewTally(b)).toEqual({ Ignetium: 1, Ev: 1 });
  });

  it("perfumes evaluate against the combined tally", () => {
    // {Ignetium, Ev} is a strict subset of Pepperpop Mixture's
    // {Ignetium, C, Ev, Ev} recipe -> in reach, not off
    const b = brew(["Pepperpops", "Brightflower", "Silver"]);
    expect(evaluate(b, perfume("pepperpop-mixture")).status).toBe("craftable");
  });
});

// ── 11. Multiples: a brew makes one type of perfume but many copies ──────────

describe("multiples (B = k·R brews k copies)", () => {
  it("Pemneath Peat {N,N} brews 2× Black Gas with no strike", () => {
    const b = brew(["Pemneath Peat"]);
    const res = evaluate(b, perfume("black-gas"));
    expect(res.status).toBe("perfect");
    expect(res.k).toBe(2);
  });

  it("a doubled common recipe brews 2 copies (Swana's Serum ×2)", () => {
    const b = brew([
      "Aphasia Flower", "Noble Roses",
      "Aphasia Flower", "Noble Roses",
    ]);
    const res = evaluate(b, perfume("swanas-serum"));
    expect(res.status).toBe("perfect");
    expect(res.k).toBe(2);
  });

  it("single matches report k = 1", () => {
    const b = brew(["Brightflower"]);
    expect(evaluate(b, perfume("bright")).k).toBe(1);
  });

  it("a brew between multiples is in reach of the next copy", () => {
    // {N,N,N} = Pemneath Peat + Pure Necromancy: perfect at k=3
    const b = brew(["Pemneath Peat", "Pure Necromancy"]);
    const res = evaluate(b, perfume("black-gas"));
    expect(res.status).toBe("perfect");
    expect(res.k).toBe(3);
  });

  it("excess beyond any multiple still needs strikes", () => {
    // {N, N, En}: k=2 leaves En excess — off without a strike, in reach with one
    const b = brew(["Pemneath Peat", "Pure Enchantment"]);
    expect(evaluate(b, perfume("black-gas")).status).toBe("off");
    const withStrike = brew(["Pemneath Peat", "Pure Enchantment", "Pure Strike"]);
    const res = evaluate(withStrike, perfume("black-gas"));
    expect(res.status).toBe("craftable");
    expect(res.k).toBe(2);
  });
});

// ── 12. Engine invariants ─────────────────────────────────────────────────────

describe("engine invariants", () => {
  it("E2: combination conserves total fundamental weight", async () => {
    const { freqWeight } = await import("../data/base");
    const weightOf = (ms: Record<string, number>) =>
      Object.entries(ms).reduce((s, [id, n]) => s + freqWeight(id) * n, 0);
    const pools = [
      ["Ev", "Ev", "En", "C"],
      ["I", "N", "N", "T", "Ev", "Ev", "En", "C", "C", "C"],
      ["A", "A", "D", "T", "A", "A", "D", "T", "T", "I", "N", "N", "T"],
      ["N"],
    ];
    for (const pool of pools) {
      const raw = msFromList(pool);
      const { tally } = combineFrequencies(raw);
      expect(weightOf(tally), pool.join(",")).toBe(weightOf(raw));
    }
  });

  it("E3: combination is a fixpoint (idempotent, no complete component set left)", async () => {
    const { named } = await import("../data/base");
    const pools = [
      ["Ev", "Ev", "En", "C", "Ev", "En"],
      ["I", "N", "N", "T", "Ev", "Ev", "En", "C", "C", "C", "D", "D", "A", "C"],
    ];
    for (const pool of pools) {
      const once = combineFrequencies(msFromList(pool)).tally;
      const twice = combineFrequencies(once).tally;
      expect(msEqual(once, twice)).toBe(true);
      for (const n of named) {
        expect(
          msIsSubset(msFromList(n.components), once),
          `${n.id} components still loose`,
        ).toBe(false);
      }
    }
  });

  it("E1: no operation produces zero or negative counts", () => {
    const b = brew(["Brightflower"], ["Ev"]);
    for (const v of Object.values(effectiveTally(b))) expect(v).toBeGreaterThan(0);
    for (const v of Object.values(msDiff({ A: 1 }, { A: 5 }))) expect(v).toBeGreaterThan(0);
  });

  it("E6: every no-direct-emitter frequency is reachable by combining emitted ones", async () => {
    const { NO_DIRECT_EMITTER, NAMED } = await import("../data/base");
    // expand a named frequency one level into DIRECTLY EMITTED parts, recursing
    // through components that are themselves unemitted
    const emitted = new Set(baseIngredients.flatMap((i) => i.emits));
    const emittedParts = (id: string): string[] =>
      NAMED[id].components.flatMap((c) =>
        emitted.has(c) || !NAMED[c] ? [c] : emittedParts(c),
      );
    for (const id of NO_DIRECT_EMITTER) {
      const parts = emittedParts(id);
      // every leaf of the expansion is emitted by some known ingredient…
      for (const p of parts) expect(emitted.has(p), `${id} needs unemitted ${p}`).toBe(true);
      // …and combining those parts yields the frequency itself
      const { tally } = combineFrequencies(msFromList(parts));
      expect(tally[id], `${id} from [${parts.join(",")}]`).toBe(1);
    }
  });
});

// ── traceCombination: instance-level combination trace ────────────────────────
// The pure helper the brew-graph layout consumes to name WHICH frequency
// instances fused — must agree with combineFrequencies on the resulting tally.

describe("traceCombination", () => {
  const insts = (ids: string[]): FreqInstance[] =>
    ids.map((id, i) => ({ ref: `i${i}`, id }));

  // Rebuild the tally the trace implies: surviving instances + final combined
  // nodes (steps whose ref no later step consumed).
  const tallyOf = (pool: FreqInstance[]) => {
    const { steps, survivors } = traceCombination(pool);
    const consumed = new Set(steps.flatMap((s) => s.consumed));
    const tally: Record<string, number> = {};
    const byRef = new Map(pool.map((p) => [p.ref, p.id]));
    for (const ref of survivors) {
      const id = byRef.get(ref)!;
      tally[id] = (tally[id] ?? 0) + 1;
    }
    for (const s of steps) {
      if (!consumed.has(s.ref)) tally[s.id] = (tally[s.id] ?? 0) + 1;
    }
    return tally;
  };

  it("leaves a non-combining pool untouched", () => {
    const t = traceCombination(insts(["N", "N", "A"]));
    expect(t.steps).toEqual([]);
    expect(t.survivors.sort()).toEqual(["i0", "i1", "i2"]);
  });

  it("fuses one named frequency and names its consumed instances", () => {
    // Ignetium = Ev,Ev,En,C
    const pool = insts(["Ev", "Ev", "En", "C"]);
    const t = traceCombination(pool);
    expect(t.steps).toHaveLength(1);
    expect(t.steps[0].id).toBe("Ignetium");
    expect(t.steps[0].consumed.sort()).toEqual(["i0", "i1", "i2", "i3"]);
    expect(t.survivors).toEqual([]);
  });

  it("leaves the excess instance a survivor", () => {
    // one extra Ev survives the Ignetium fusion
    const t = traceCombination(insts(["Ev", "Ev", "Ev", "En", "C"]));
    expect(t.steps).toHaveLength(1);
    expect(t.survivors).toHaveLength(1);
    // the survivor is an Ev
    expect(t.survivors[0]).toMatch(/^i\d$/);
  });

  it("chains: a derived frequency is consumed by a heavier one", () => {
    // Yonescope(I,N,N,T) + Ignetium(Ev,Ev,En,C) + C + C -> Letchettin
    const pool = insts(["I", "N", "N", "T", "Ev", "Ev", "En", "C", "C", "C"]);
    const t = traceCombination(pool);
    const producedIds = t.steps.map((s) => s.id);
    expect(producedIds).toContain("Ignetium");
    expect(producedIds).toContain("Yonescope");
    expect(producedIds).toContain("Letchettin");
    // the Letchettin step consumes the two combined refs plus the two C circles
    const let_ = t.steps.find((s) => s.id === "Letchettin")!;
    const comboRefs = let_.consumed.filter((r) => r.startsWith("combo:"));
    expect(comboRefs).toHaveLength(2); // Yonescope + Ignetium
  });

  it("agrees with combineFrequencies on the resulting tally", () => {
    const cases = [
      ["N"],
      ["Ev", "Ev", "En", "C"],
      ["Ev", "Ev", "En", "C", "Ev", "Ev", "En", "C"],
      ["D", "D", "A", "C", "I", "N", "N", "T"],
      ["A", "A", "D", "T"],
      ["I", "N", "N", "T", "Ev", "Ev", "En", "C", "C", "C"],
    ];
    for (const list of cases) {
      const mine = tallyOf(insts(list));
      const theirs = combineFrequencies(msFromList(list)).tally;
      expect(Object.entries(mine).sort(), list.join(",")).toEqual(
        Object.entries(theirs).sort(),
      );
    }
  });

  it("is deterministic for identical input", () => {
    const pool = insts(["Ev", "Ev", "En", "C", "D", "D", "A", "C"]);
    expect(JSON.stringify(traceCombination(pool))).toBe(
      JSON.stringify(traceCombination(pool)),
    );
  });
});

// ── closestPath: the pin solver (DESIGN §5) ──────────────────────────────────
// Finds the satisfying target reachable with the fewest additions across a
// perfume's recipes and k-multiples, strongly preferring add-only paths. The
// synthetic cases use the inert fundamental "E" (it appears in no named
// frequency's components) so combination never perturbs a hand-built tally.

describe("closestPath", () => {
  // A synthetic ingredient emitting exactly `emits`, so a brew's raw tally is
  // whatever we choose — no dependency on the catalog's real profiles.
  const emitter = (emits: string[]): Ingredient => ({
    key: `test:${emits.join("-") || "empty"}`,
    name: `emitter(${emits.join(",")})`,
    emits,
    strike: 0,
    wild: 0,
    color: "#000",
    source: { kind: "base" },
  });
  const tallyBrew = (emits: string[]): BrewState => ({
    ingredients: emits.length ? [emitter(emits)] : [],
    strikePlays: [],
    wildPlays: [],
  });
  // A synthetic perfume defined purely by its recipes.
  const withRecipes = (recipes: string[][]): Perfume => ({
    key: "test:perfume",
    name: "Test Perfume",
    roll: 0,
    effect: "unknown",
    recipes,
    slots: [],
    combos: [],
    source: { kind: "base" },
  });

  it("returns null when the perfume has no recipes", () => {
    expect(closestPath(brew([]), withRecipes([]))).toBeNull();
  });

  it("a perfect brew needs no additions and no strikes", () => {
    // Brightflower {Ev,En} exactly brews Bright.
    const p = closestPath(brew(["Brightflower"]), perfume("bright"))!;
    expect(p.additions).toEqual({});
    expect(p.strikes).toEqual({});
    expect(p.reqIndex).toBe(0);
    expect(p.k).toBe(1);
  });

  it("a subset brew reports the missing frequencies as add-only", () => {
    // Empty cauldron vs Bright {Ev,En}: add both, strike nothing.
    const p = closestPath(brew([]), perfume("bright"))!;
    expect(p.additions).toEqual({ Ev: 1, En: 1 });
    expect(p.strikes).toEqual({});
    expect(p.k).toBe(1);
  });

  it("falls back to a strike path only when no add-only path exists", () => {
    // Ichorberries {N,En} vs Black Gas {N}: the En is excess at every k, so the
    // only path strikes it.
    const p = closestPath(brew(["Ichorberries"]), perfume("black-gas"))!;
    expect(p.additions).toEqual({});
    expect(p.strikes).toEqual({ En: 1 });
  });

  it("uses the k-multiple that a brew already satisfies", () => {
    // Pemneath Peat {N,N} is exactly 2× Black Gas {N}.
    const p = closestPath(brew(["Pemneath Peat"]), perfume("black-gas"))!;
    expect(p.k).toBe(2);
    expect(p.additions).toEqual({});
    expect(p.strikes).toEqual({});
  });

  it("STRONGLY prefers an add-only recipe over a fewer-additions strike path", () => {
    // Brew tally {E,E,A}. Recipe 0 {E} reaches k=2 with 0 additions but must
    // strike the stray A; recipe 1 {E,E,A,A} is add-only (add one A). The
    // add-only path wins despite needing an addition.
    const perf = withRecipes([["E"], ["E", "E", "A", "A"]]);
    const p = closestPath(tallyBrew(["E", "E", "A"]), perf)!;
    expect(p.reqIndex).toBe(1);
    expect(p.additions).toEqual({ A: 1 });
    expect(p.strikes).toEqual({});
  });

  it("among add-only paths, minimizes the number of additions", () => {
    // Brew {E}. Recipe 0 needs 4 more E; recipe 1 needs 1 more E. Pick recipe 1.
    const perf = withRecipes([["E", "E", "E", "E", "E"], ["E", "E"]]);
    const p = closestPath(tallyBrew(["E"]), perf)!;
    expect(p.reqIndex).toBe(1);
    expect(p.additions).toEqual({ E: 1 });
    expect(p.strikes).toEqual({});
  });

  it("breaks equal-cost ties toward the common recipe (reqIndex 0)", () => {
    // Empty brew: {E,E} and {A,A} both need 2 additions. Prefer reqIndex 0.
    const perf = withRecipes([["E", "E"], ["A", "A"]]);
    const p = closestPath(brew([]), perf)!;
    expect(p.reqIndex).toBe(0);
    expect(p.additions).toEqual({ E: 2 });
  });
});

// ── closestPath: property tests + adversarial sweep ──────────────────────────
// These push harder than the hand-picked cases above: they re-derive the pin
// solver's contract from scratch and cross-check it against every base perfume
// over a corpus of real brews, then try to construct inputs that break it.
//
// The synthetic fundamental "E" is inert (it is in no named frequency's
// component list — verified in base.ts), so an emitter of "E"s produces a tally
// that never auto-combines: hand-built targets stay exactly as written. "A"
// only combines as part of Crallax {D,D,A,C} or Chrysipil {A,A,D,T}, so an
// {E,A}-only pool is also combination-inert.

describe("closestPath — properties & adversarial", () => {
  // Synthetic emitter: a brew whose RAW tally is exactly `emits`.
  const emit = (emits: string[]): Ingredient => ({
    key: `prop:${emits.join("-") || "empty"}`,
    name: `prop-emitter(${emits.join(",")})`,
    emits,
    strike: 0,
    wild: 0,
    color: "#000",
    source: { kind: "base" },
  });
  const emitBrew = (emits: string[]): BrewState => ({
    ingredients: emits.length ? [emit(emits)] : [],
    strikePlays: [],
    wildPlays: [],
  });
  const withRecipes = (recipes: string[][]): Perfume => ({
    key: "prop:perfume",
    name: "Prop Perfume",
    roll: 0,
    effect: "unknown",
    recipes,
    slots: [],
    combos: [],
    source: { kind: "base" },
  });

  const comb = (ms: Record<string, number>) => combineFrequencies(ms).tally;
  const uniqForms = (a: Record<string, number>, b: Record<string, number>) =>
    msEqual(a, b) ? [a] : [a, b];

  // ── The corpus: real brews spanning empty, subsets, exact matches, excess,
  //    k-multiples, self-combining pools, and strike/wild charges. ────────────
  const corpus: { label: string; state: BrewState }[] = [
    { label: "empty", state: brew([]) },
    { label: "Brightflower {Ev,En}", state: brew(["Brightflower"]) },
    { label: "Ichorberries {N,En}", state: brew(["Ichorberries"]) },
    { label: "Bitterhearts {N,D}", state: brew(["Bitterhearts"]) },
    { label: "Pemneath Peat {N,N}", state: brew(["Pemneath Peat"]) },
    {
      label: "Pemneath Peat + Pure Necromancy {N,N,N}",
      state: brew(["Pemneath Peat", "Pure Necromancy"]),
    },
    {
      label: "Swana common {A,A,Crallax,En}",
      state: brew(["Aphasia Flower", "Noble Roses"]),
    },
    {
      label: "Swana common ×2",
      state: brew([
        "Aphasia Flower", "Noble Roses",
        "Aphasia Flower", "Noble Roses",
      ]),
    },
    {
      label: "Ignetium-combining pool {Ev×3,En,C}",
      state: brew(["Pepperpops", "Brightflower", "Silver"]),
    },
    {
      label: "Liver + Ichorberries (strike charges present)",
      state: brew(["Shadow Demon Liver", "Ichorberries"]),
    },
    {
      label: "Pensive self-combining common",
      state: brew(["Great Cold Shard", "Melting Dewdrops"]),
    },
    {
      label: "Brightflower + Northman's Beard (Frenzy)",
      state: brew(["Brightflower", "Northman's Beard"]),
    },
    {
      label: "Antimagic Chrythsmeum×4 + Seacursed Scale",
      state: brew([
        "Chrythsmeum", "Chrythsmeum", "Chrythsmeum", "Chrythsmeum",
        "Seacursed Scale",
      ]),
    },
    {
      label: "Ichorberries + Pure Strike (charge unspent)",
      state: brew(["Ichorberries", "Pure Strike"]),
    },
    {
      label: "Ichorberries + Pure Strike, En struck",
      state: brew(["Ichorberries", "Pure Strike"], ["En"]),
    },
  ];

  // An independent, from-scratch oracle mirroring the DESIGN §5 selection order.
  // Crucially it scans k FURTHER than closestPath's kMax bound, so if the bound
  // ever cut off a strictly-better target the oracle would diverge.
  const oracleBest = (
    state: BrewState,
    perf: Perfume,
    kExtra = 3,
  ): { reqIndex: number; k: number; addN: number; strN: number } | null => {
    if (perf.recipes.length === 0) return null;
    const rawB = effectiveTally(state);
    const Bs = uniqForms(rawB, comb(rawB));
    const better = (a: typeof best, b: typeof best): boolean => {
      const ao = a!.strN === 0;
      const bo = b!.strN === 0;
      if (ao !== bo) return ao;
      if (a!.addN !== b!.addN) return a!.addN < b!.addN;
      if (a!.strN !== b!.strN) return a!.strN < b!.strN;
      if (a!.reqIndex !== b!.reqIndex) return a!.reqIndex < b!.reqIndex;
      return a!.k < b!.k;
    };
    let best:
      | { reqIndex: number; k: number; addN: number; strN: number }
      | null = null;
    for (let ri = 0; ri < perf.recipes.length; ri++) {
      const rawR = msFromList(perf.recipes[ri]);
      const Rs = uniqForms(rawR, comb(rawR));
      for (const B of Bs) {
        for (const R of Rs) {
          let kMax = 1;
          for (const f in R) kMax = Math.max(kMax, Math.ceil((B[f] || 0) / R[f]));
          for (let k = 1; k <= kMax + kExtra; k++) {
            const kR = msScale(R, k);
            const cand = {
              reqIndex: ri,
              k,
              addN: msSize(msDiff(kR, B)),
              strN: msSize(msDiff(B, kR)),
            };
            if (!best || better(cand, best)) best = cand;
          }
        }
      }
    }
    return best;
  };

  // Does ANY add-only target (strikes empty) exist for this brew+perfume, at any
  // recipe / form / k? Independent of the solver's own bookkeeping.
  const addOnlyExists = (state: BrewState, perf: Perfume): boolean => {
    const rawB = effectiveTally(state);
    const Bs = uniqForms(rawB, comb(rawB));
    for (const req of perf.recipes) {
      const rawR = msFromList(req);
      const Rs = uniqForms(rawR, comb(rawR));
      for (const B of Bs) {
        for (const R of Rs) {
          let kMax = 1;
          for (const f in R) kMax = Math.max(kMax, Math.ceil((B[f] || 0) / R[f]));
          for (let k = 1; k <= kMax; k++) {
            if (msSize(msDiff(B, msScale(R, k))) === 0) return true;
          }
        }
      }
    }
    return false;
  };

  // (a) The returned (additions, strikes) is a genuine decomposition of the brew
  //     into k× the chosen recipe, AND emitting that target evaluates PERFECT
  //     against the returned reqIndex/k — i.e. following the path actually
  //     brews the perfume.
  it("(a) additions+strikes decompose the brew into a perfect target", () => {
    for (const { label, state } of corpus) {
      for (const perf of basePerfumes) {
        const cp = closestPath(state, perf)!;
        const recipe = perf.recipes[cp.reqIndex];
        const rawB = effectiveTally(state);
        const Bs = uniqForms(rawB, comb(rawB));
        const rawR = msFromList(recipe);
        const Rs = uniqForms(rawR, comb(rawR));

        // Find the (B-form, R-form) pairing that produced these numbers.
        let matched = false;
        for (const B of Bs) {
          for (const R of Rs) {
            const kR = msScale(R, cp.k);
            if (
              msEqual(msDiff(kR, B), cp.additions) &&
              msEqual(msDiff(B, kR), cp.strikes)
            ) {
              matched = true;
              // B + additions − strikes == kR : reconstruct and confirm perfect.
              const goal = emitBrew(msToList(kR));
              const e = evalReq(goal, recipe, cp.reqIndex);
              expect(
                e.status,
                `${label} vs ${perf.key}: target k·R not perfect`,
              ).toBe("perfect");
            }
          }
        }
        expect(
          matched,
          `${label} vs ${perf.key}: additions/strikes match no (B,R) pairing`,
        ).toBe(true);
        // additions and strikes never overlap on a frequency.
        for (const f in cp.additions) {
          expect(cp.strikes[f], `${label} vs ${perf.key}: ${f} both sides`)
            .toBeFalsy();
        }
      }
    }
  });

  // (b) generalised: strikes are empty IFF an add-only path exists. This is the
  //     "add-only is STRONGLY preferred" rule, checked against an independent
  //     existence oracle over the whole catalog.
  it("(b) strikes are empty exactly when an add-only path exists", () => {
    for (const { label, state } of corpus) {
      for (const perf of basePerfumes) {
        const cp = closestPath(state, perf)!;
        expect(
          msSize(cp.strikes) === 0,
          `${label} vs ${perf.key}`,
        ).toBe(addOnlyExists(state, perf));
      }
    }
  });

  // (b) constructive: a strike path is strictly SHORTER (0 additions) yet an
  //     add-only path costing many additions still wins — strikes must be empty.
  it("(b) an add-only path beats a shorter strike path regardless of cost", () => {
    // Brew {E,E,A}. Recipe 0 {E} reaches k=2 by striking the stray A (0
    // additions, 1 strike). Recipe 1 {E,E,A,B,B,B,B,B} is a genuine add-only
    // path (the brew is a subset) but needs 5 additions. Add-only must still
    // win despite the strike path being far shorter.
    const perf = withRecipes([
      ["E"],
      ["E", "E", "A", "B", "B", "B", "B", "B"],
    ]);
    const p = closestPath(emitBrew(["E", "E", "A"]), perf)!;
    expect(p.strikes).toEqual({});
    expect(p.reqIndex).toBe(1);
    expect(p.additions).toEqual({ B: 5 });
  });

  // (c) Adding exactly one still-needed frequency drops msSize(additions) by
  //     exactly one (the added ghost solidifies; nothing else shifts).
  it("(c) adding one needed frequency reduces additions by exactly one", () => {
    const addOne = (state: BrewState, freq: string): BrewState => ({
      ingredients: [...state.ingredients, emit([freq])],
      strikePlays: [...state.strikePlays],
      wildPlays: [...state.wildPlays],
    });
    const cases: { state: BrewState; perf: Perfume }[] = [
      { state: brew([]), perf: perfume("black-gas") }, // needs {N}
      { state: brew([]), perf: perfume("swanas-serum") }, // needs {A,A,Crallax,En}
      { state: brew(["Brightflower"]), perf: perfume("frenzy") }, // needs {C,Ignetium}
      { state: emitBrew(["E"]), perf: withRecipes([["E", "E", "E", "E"]]) },
    ];
    for (const { state, perf } of cases) {
      const before = closestPath(state, perf)!;
      const need = Object.keys(before.additions);
      expect(need.length, `${perf.key} should have additions`).toBeGreaterThan(0);
      const freq = need[0];
      const after = closestPath(addOne(state, freq), perf)!;
      expect(
        msSize(after.additions),
        `${perf.key}: adding ${freq}`,
      ).toBe(msSize(before.additions) - 1);
    }
  });

  // (d) A perfume with no recipes yields null (nothing to steer toward); a
  //     perfume WITH recipes never does.
  it("(d) null iff the perfume has no recipes", () => {
    expect(closestPath(brew([]), withRecipes([]))).toBeNull();
    expect(closestPath(emitBrew(["E", "A"]), withRecipes([]))).toBeNull();
    for (const perf of basePerfumes) {
      expect(closestPath(brew([]), perf), perf.key).not.toBeNull();
    }
  });

  // (e) k-multiple targets are in scope: a brew just short of 2× a recipe steers
  //     to k=2 (add-only) rather than k=1 (which would need strikes).
  it("(e) picks the k-multiple that minimises the path", () => {
    // Brew {E,E,A} vs recipe {E,A}: k=1 would strike a stray E (strike path);
    // k=2 just adds one A (add-only). The add-only k=2 wins.
    const perf = withRecipes([["E", "A"]]);
    const p = closestPath(emitBrew(["E", "E", "A"]), perf)!;
    expect(p.k).toBe(2);
    expect(p.additions).toEqual({ A: 1 });
    expect(p.strikes).toEqual({});

    // Exactly 2× is perfect at k=2.
    const exact = closestPath(emitBrew(["E", "E", "A", "A"]), perf)!;
    expect(exact.k).toBe(2);
    expect(exact.additions).toEqual({});
    expect(exact.strikes).toEqual({});

    // Real: Pemneath Peat {N,N} is 2× Black Gas {N}.
    const peat = closestPath(brew(["Pemneath Peat"]), perfume("black-gas"))!;
    expect(peat.k).toBe(2);
    expect(peat.additions).toEqual({});
    expect(peat.strikes).toEqual({});
  });

  // (e′) When no add-only path exists, the solver still uses k to MINIMISE the
  //      strikes (higher k absorbs more of the recurring frequency).
  it("(e') with only strike paths, k is chosen to minimise strikes", () => {
    // Brew {N,N,N,En} vs Black Gas {N}: En is excess at every k, so no add-only
    // path. k=3 absorbs all three N and leaves only En to strike.
    const state = brew(["Pemneath Peat", "Pure Necromancy", "Pure Enchantment"]);
    expect(effectiveTally(state)).toEqual({ N: 3, En: 1 });
    const p = closestPath(state, perfume("black-gas"))!;
    expect(p.k).toBe(3);
    expect(p.additions).toEqual({});
    expect(p.strikes).toEqual({ En: 1 });
  });

  // A high-k add-only path is still found and preferred: five loose N steer to
  // k=5 of Black Gas {N} with no strikes.
  it("finds add-only paths that only exist at a large k", () => {
    const state = brew([
      "Pemneath Peat", "Pemneath Peat", "Pure Necromancy",
    ]); // {N×5}
    expect(effectiveTally(state)).toEqual({ N: 5 });
    const p = closestPath(state, perfume("black-gas"))!;
    expect(p.k).toBe(5);
    expect(p.additions).toEqual({});
    expect(p.strikes).toEqual({});
  });

  // ── Adversarial: the solver must match an independent oracle that scans k
  //    BEYOND its bound, across every base perfume and the whole corpus. A
  //    divergence would mean the k-bound (or the ranking) drops a better path.
  it("matches an independent oracle (extended k) over the full catalog", () => {
    for (const { label, state } of corpus) {
      for (const perf of basePerfumes) {
        const cp = closestPath(state, perf)!;
        const ref = oracleBest(state, perf)!;
        const tag = `${label} vs ${perf.key}`;
        expect(cp.reqIndex, `${tag} reqIndex`).toBe(ref.reqIndex);
        expect(cp.k, `${tag} k`).toBe(ref.k);
        expect(msSize(cp.additions), `${tag} addN`).toBe(ref.addN);
        expect(msSize(cp.strikes), `${tag} strN`).toBe(ref.strN);
      }
    }
  });

  // Faithful literal application on combination-free brews: build the resolved
  // brew by ADDING the ghost frequencies as items and STRIKING the excess, then
  // confirm the perfume brews perfect at the reported reqIndex/k.
  it("literally applying the path (add items + strike excess) brews perfect", () => {
    let exercised = 0;
    for (const { state } of corpus) {
      const rawB = effectiveTally(state);
      if (!msEqual(rawB, comb(rawB))) continue; // keep the literal apply exact
      for (const perf of basePerfumes) {
        const cp = closestPath(state, perf)!;
        // Strikes here target base frequencies present in the raw tally.
        if (!Object.keys(cp.strikes).every((f) => (rawB[f] || 0) > 0)) continue;
        const applied: BrewState = {
          ingredients: [
            ...state.ingredients,
            ...msToList(cp.additions).map((f) => emit([f])),
          ],
          strikePlays: [...state.strikePlays, ...msToList(cp.strikes)],
          wildPlays: [...state.wildPlays],
        };
        const e = evalReq(applied, perf.recipes[cp.reqIndex], cp.reqIndex);
        expect(e.status, `${perf.key}`).toBe("perfect");
        exercised++;
      }
    }
    expect(exercised).toBeGreaterThan(100);
  });
});
