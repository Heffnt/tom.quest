import { describe, it, expect } from "vitest";
import { baseIngredients, basePerfumes, pureIngredients } from "../data/base";
import type { BrewState } from "./types";
import { brewableOptions, hoverDelta } from "./brewable";

// ── Helpers ──────────────────────────────────────────────────────────────────

function ing(name: string) {
  const found = [...baseIngredients, ...pureIngredients].find((i) => i.name === name);
  if (!found) throw new Error(`No ingredient named "${name}"`);
  return found;
}

function brew(
  names: string[],
  strikePlays: string[] = [],
  wildPlays: string[] = [],
): BrewState {
  return { ingredients: names.map(ing), strikePlays, wildPlays };
}

const names = (opts: { perfume: { name: string } }[]) =>
  opts.map((o) => o.perfume.name);

// ── 1. brewableOptions: exact matches only ───────────────────────────────────

describe("brewableOptions", () => {
  it("an empty pot brews nothing", () => {
    expect(brewableOptions(brew([]), basePerfumes)).toEqual([]);
  });

  it("Pemneath Peat {N,N} brews Black Gas ×2 and nothing else", () => {
    const opts = brewableOptions(brew(["Pemneath Peat"]), basePerfumes);
    expect(names(opts)).toEqual(["Black Gas"]);
    expect(opts[0].k).toBe(2);
    expect(opts[0].tuningIndex).toBe(0);
  });

  it("Brightflower {Ev,En} brews Bright ×1", () => {
    const opts = brewableOptions(brew(["Brightflower"]), basePerfumes);
    expect(names(opts)).toEqual(["Bright"]);
    expect(opts[0].k).toBe(1);
  });

  it("in-reach-but-not-exact tallies produce no options", () => {
    // {N, En} + a strike charge: Black Gas is craftable, never listed
    const opts = brewableOptions(
      brew(["Shadow Demon Liver", "Ichorberries"]),
      basePerfumes,
    );
    expect(opts).toEqual([]);
  });

  it("strike plays feed the tally the bar matches on", () => {
    const opts = brewableOptions(
      brew(["Shadow Demon Liver", "Ichorberries"], ["En"]),
      basePerfumes,
    );
    expect(names(opts)).toEqual(["Black Gas"]);
    expect(opts[0].k).toBe(1);
  });

  it("reports which tuning matched (Pepperpop Mixture's two tunings)", () => {
    const viaScale = brewableOptions(
      brew(["Fjeldling Scale", "Pepperpops"]),
      basePerfumes,
    ).find((o) => o.perfume.key === "base:pepperpop-mixture")!;
    const viaBeard = brewableOptions(
      brew(["Northman's Beard", "Pepperpops"]),
      basePerfumes,
    ).find((o) => o.perfume.key === "base:pepperpop-mixture")!;
    expect(viaScale.tuningIndex).not.toBe(viaBeard.tuningIndex);
  });

  it("higher multiples report their k ({N,N,N} -> Black Gas ×3)", () => {
    const opts = brewableOptions(
      brew(["Pemneath Peat", "Pure Necromancy"]),
      basePerfumes,
    );
    expect(names(opts)).toEqual(["Black Gas"]);
    expect(opts[0].k).toBe(3);
  });
});

// ── 2. hoverDelta: the brew-bar ghost ────────────────────────────────────────

describe("hoverDelta", () => {
  it("gain: Brightflower over an empty pot would brew Bright ×1", () => {
    const d = hoverDelta(brew([]), ing("Brightflower"), basePerfumes);
    expect(d.tally).toEqual({ Ev: 1, En: 1 });
    expect(d.gains.map((g) => [g.perfume.name, g.k])).toEqual([["Bright", 1]]);
    expect(d.losses).toEqual([]);
  });

  it("loss + gain: Northman's Beard over Brightflower breaks Bright, makes Frenzy", () => {
    const d = hoverDelta(brew(["Brightflower"]), ing("Northman's Beard"), basePerfumes);
    expect(d.gains.map((g) => [g.perfume.name, g.k])).toEqual([["Frenzy", 1]]);
    expect(d.losses.map((l) => l.perfume.name)).toEqual(["Bright"]);
  });

  it("loss only: Pure Enchantment over Pemneath Peat breaks Black Gas", () => {
    const d = hoverDelta(brew(["Pemneath Peat"]), ing("Pure Enchantment"), basePerfumes);
    expect(d.gains).toEqual([]);
    expect(d.losses.map((l) => l.perfume.name)).toEqual(["Black Gas"]);
  });

  it("a copy-count change is a gain with the new k, not a loss", () => {
    const d = hoverDelta(brew(["Pemneath Peat"]), ing("Pure Necromancy"), basePerfumes);
    expect(d.gains.map((g) => [g.perfume.name, g.k])).toEqual([["Black Gas", 3]]);
    expect(d.losses).toEqual([]);
  });

  it("tally is the combined (post-fusion) tally with the extra included", () => {
    // {Ev,Ev} + {Ev,En} + Silver {C} -> raw {Ev×3,En,C} -> {Ignetium, Ev}
    const d = hoverDelta(
      brew(["Pepperpops", "Brightflower"]),
      ing("Silver"),
      basePerfumes,
    );
    expect(d.tally).toEqual({ Ignetium: 1, Ev: 1 });
  });

  it("never mutates the hovered brew", () => {
    const b = brew(["Pemneath Peat"]);
    hoverDelta(b, ing("Pure Necromancy"), basePerfumes);
    expect(b.ingredients.length).toBe(1);
    expect(brewableOptions(b, basePerfumes)[0].k).toBe(2);
  });
});
