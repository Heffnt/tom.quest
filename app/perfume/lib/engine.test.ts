import { describe, it, expect } from "vitest";
import { baseIngredients, pureIngredients, basePerfumes } from "../data/base";
import type { BrewState } from "./types";
import {
  msSize,
  msDiff,
  msEqual,
  msFromList,
  msIsSubset,
  effectiveTally,
  brewTally,
  combineFrequencies,
  evaluate,
  autoResolvePlays,
  findRecipes,
} from "./engine";

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
  it("a brew that is a subset of a tuning is in reach; one with stray excess is not", () => {
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

  it("spending a strike updates the book dynamically (off -> in reach -> perfect)", () => {
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
  it("is defined as the single tuning [N]", () => {
    expect(perfume("black-gas").reqs).toEqual([["N"]]);
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

// ── 4. Multi-tuning: either slashed alternative brews the perfume ────────────

describe("Pepperpop Mixture (2 tunings)", () => {
  it("is perfect via Fjeldling Scale AND via Northman's Beard", () => {
    const viaScale = brew(["Fjeldling Scale", "Pepperpops"]);
    const viaBeard = brew(["Northman's Beard", "Pepperpops"]);
    expect(evaluate(viaScale, perfume("pepperpop-mixture")).status).toBe("perfect");
    expect(evaluate(viaBeard, perfume("pepperpop-mixture")).status).toBe("perfect");
  });

  it("reports which tuning matched", () => {
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
        const plays = autoResolvePlays(ings, r.reqs[combo.req]);
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
      for (const req of r.reqs) {
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

  it("with maxStrikes 0, combos sum exactly to the tuning", () => {
    const combos = findRecipes(["Ev", "En"], baseIngredients, 0, 50);
    for (const c of combos) expect(c.strikes).toBe(0);
  });

  it("every strike-free d40 combo is rediscovered by the solver", () => {
    for (const r of basePerfumes) {
      for (const combo of r.combos) {
        if (combo.strikes > 0) continue;
        const found = findRecipes(r.reqs[combo.req], baseIngredients, 0, 24);
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

  it("a self-combining tuning still brews raw (Pensive Perfume)", () => {
    // Pensive's tuning {Albutian, Chrysipil, N, T} auto-combines
    // (Albutian + Chrysipil -> Ontoligin), so matching compares raw and
    // combined forms of BOTH sides — the common combo must stay perfect.
    const req = perfume("pensive-perfume").reqs[0];
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
    // {Ignetium, C, Ev, Ev} tuning -> in reach, not off
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
