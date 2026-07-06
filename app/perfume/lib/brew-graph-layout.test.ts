import { describe, it, expect } from "vitest";
import { FUND } from "../data/base";
import type { BrewItem, StrikePlay, WildPlay, PinnedRecipe } from "./brew-types";
import {
  buildBrewGraph,
  blendTint,
  type BrewGraphInput,
} from "./brew-graph-layout";

// ── fixture builders (real base.json data) ────────────────────────────────────

function item(
  key: string,
  real = true,
  contributorName = "Perfumer",
): BrewItem {
  return {
    key,
    contributorKey: `k:${contributorName}`,
    contributorName,
    real,
  };
}
const strike = (freq: string, by = "m1"): StrikePlay => ({ freq, byMemberKey: by });
const wild = (chosenFreq: string, by = "m1"): WildPlay => ({ chosenFreq, byMemberKey: by });
const pin = (perfumeId: string, recipeIndex = 0): PinnedRecipe => ({
  perfumeId,
  recipeIndex,
});

function graph(
  items: BrewItem[],
  strikePlays: StrikePlay[] = [],
  wildPlays: WildPlay[] = [],
  pinned: PinnedRecipe = null,
) {
  const input: BrewGraphInput = { items, strikePlays, wildPlays, pinned };
  return buildBrewGraph(input);
}

// ── 1. Black Gas one-N brew ───────────────────────────────────────────────────
// Ichorberries emits {N, En}; striking the En leaves the tally {N}, matching
// the Black Gas recipe [N] exactly (k=1).

describe("Black Gas one-N brew", () => {
  const g = graph([item("base:Ichorberries")], [strike("En", "alice")], [], pin("base:black-gas"));

  it("has a single item node with the right stack count and no hypotheticals", () => {
    expect(g.items).toHaveLength(1);
    expect(g.items[0].name).toBe("Ichorberries");
    expect(g.items[0].count).toBe(1);
    expect(g.items[0].hypothetical).toBe(0);
    expect(g.items[0].band).toBe("ingredient");
  });

  it("emits two frequency circles above the item, one struck", () => {
    expect(g.frequencies).toHaveLength(2);
    const struck = g.frequencies.filter((f) => f.struck);
    expect(struck).toHaveLength(1);
    expect(struck[0].freq).toBe("En");
    // the surviving circle is N
    expect(g.frequencies.find((f) => !f.struck)!.freq).toBe("N");
  });

  it("records byMemberKey on the struck node", () => {
    expect(g.frequencies.find((f) => f.struck)!.struckBy).toBe("alice");
  });

  it("counts only the surviving frequency in the tally", () => {
    expect(g.tally).toEqual({ N: 1 });
    expect(g.cauldron.tallyCount).toBe(1);
  });

  it("marks the pinned recipe satisfied at k=1 with no missing", () => {
    expect(g.pin).not.toBeNull();
    expect(g.pin!.satisfied).toBe(true);
    expect(g.pin!.k).toBe(1);
    expect(g.pin!.missing).toEqual({});
    expect(g.ghostFrequencies).toHaveLength(0);
    expect(g.ghostItems).toHaveLength(0);
  });

  it("wires cauldron→item and item→each frequency", () => {
    const kinds = g.edges.map((e) => e.kind);
    expect(kinds.filter((k) => k === "stem")).toHaveLength(1);
    expect(kinds.filter((k) => k === "emit")).toHaveLength(2);
    // every emit edge leaves the single item node
    for (const e of g.edges.filter((e) => e.kind === "emit")) {
      expect(e.from).toBe(g.items[0].id);
    }
  });
});

// ── 2. Combination case (named-frequency node from its components) ────────────
// Pepperpops{Ev,Ev} + Brightflower{Ev,En} + Silver{C} = {Ev×3, En, C}; the
// engine fuses Ev,Ev,En,C into Ignetium, leaving one Ev.

describe("combination case (Ignetium)", () => {
  const g = graph([
    item("base:Pepperpops"),
    item("base:Brightflower"),
    item("base:Silver"),
  ]);

  it("produces one combined named-frequency node", () => {
    expect(g.combined).toHaveLength(1);
    expect(g.combined[0].freq).toBe("Ignetium");
    expect(g.combined[0].band).toBe("combined");
    expect(g.combined[0].consumed).toBe(false); // nothing ate it in turn
  });

  it("marks the four consumed component circles and leaves one Ev loose", () => {
    const consumed = g.frequencies.filter((f) => f.consumed);
    expect(consumed).toHaveLength(4);
    const loose = g.frequencies.filter((f) => !f.consumed);
    expect(loose).toHaveLength(1);
    expect(loose[0].freq).toBe("Ev");
  });

  it("counts the combined tally, not the raw components", () => {
    expect(g.tally).toEqual({ Ev: 1, Ignetium: 1 });
    expect(g.effectiveTally).toEqual({ Ev: 3, En: 1, C: 1 });
  });

  it("draws a combine edge from each consumed circle to the combined node", () => {
    const combineEdges = g.edges.filter((e) => e.kind === "combine");
    expect(combineEdges).toHaveLength(4);
    for (const e of combineEdges) {
      expect(e.to).toBe(g.combined[0].id);
      // the source is a real frequency-circle node id
      expect(g.frequencies.some((f) => f.id === e.from)).toBe(true);
    }
  });

  it("chains: a derived node feeding a heavier combination is itself consumed", () => {
    // Letchettin = Yonescope(I,N,N,T), Ignetium(Ev,Ev,En,C), C, C — built from
    // pure frequencies so the emitter set is exact.
    const gp = graph([
      item("pure:I"),
      item("pure:N"),
      item("pure:N"),
      item("pure:T"),
      item("pure:Ev"),
      item("pure:Ev"),
      item("pure:En"),
      item("pure:C"),
      item("pure:C"),
      item("pure:C"),
    ]);
    const ids = gp.combined.map((c) => c.freq);
    expect(ids).toContain("Ignetium");
    expect(ids).toContain("Yonescope");
    expect(ids).toContain("Letchettin");
    // the Ignetium/Yonescope nodes were consumed into Letchettin
    expect(gp.combined.filter((c) => c.consumed).map((c) => c.freq).sort()).toEqual(
      ["Ignetium", "Yonescope"],
    );
    expect(gp.tally).toEqual({ Letchettin: 1 });
    // a combine edge runs from each combined node into the Letchettin node
    const let_ = gp.combined.find((c) => c.freq === "Letchettin")!;
    const feeders = gp.edges.filter((e) => e.kind === "combine" && e.to === let_.id);
    // Letchettin = Yonescope, Ignetium, C, C -> 4 feeders, two of them combined nodes
    expect(feeders).toHaveLength(4);
    const fromCombined = feeders.filter((e) =>
      gp.combined.some((c) => c.id === e.from && c.freq !== "Letchettin"),
    );
    expect(fromCombined).toHaveLength(2);
  });
});

// ── 3. Strike case (a struck frequency keeps its node, flagged struck) ────────

describe("strike case", () => {
  // Pemneath Peat emits {N, N}; strike one N.
  const g = graph([item("base:Pemneath Peat")], [strike("N", "bob")]);

  it("keeps both frequency nodes; the last is struck (not deleted)", () => {
    expect(g.frequencies).toHaveLength(2);
    expect(g.frequencies.filter((f) => f.struck)).toHaveLength(1);
    expect(g.frequencies.filter((f) => !f.struck)).toHaveLength(1);
  });

  it("flags the struck node with byMemberKey", () => {
    const s = g.frequencies.find((f) => f.struck)!;
    expect(s.freq).toBe("N");
    expect(s.struckBy).toBe("bob");
  });

  it("removes the struck frequency from the tally", () => {
    expect(g.tally).toEqual({ N: 1 });
  });

  it("does not let a struck frequency combine", () => {
    // Chrysipil = A,A,D,T. Emit A,A,D,T but strike one A -> no combination.
    const gc = graph(
      [item("pure:A"), item("pure:A"), item("pure:D"), item("pure:T")],
      [strike("A")],
    );
    expect(gc.combined).toHaveLength(0);
    expect(gc.tally).toEqual({ A: 1, D: 1, T: 1 });
  });
});

// ── 4. Wild case (chosenFreq through; null = pending dropdown) ────────────────

describe("wild case", () => {
  // Southollow Royal Tulip grants one ⊕ wild, emits nothing.
  it("an unplayed wild floats as an available charge", () => {
    const g = graph([item("base:Southollow Royal Tulip")]);
    expect(g.charges.filter((c) => c.charge === "wild")).toHaveLength(1);
    expect(g.wilds).toHaveLength(0);
    // the charge is attributed to the granting item
    expect(g.charges[0].sourceId).toBe(g.items[0].id);
  });

  it("a played wild carries its chosenFreq into the tally", () => {
    const g = graph([item("base:Southollow Royal Tulip")], [], [wild("N")]);
    expect(g.wilds).toHaveLength(1);
    expect(g.wilds[0].chosenFreq).toBe("N");
    expect(g.tally).toEqual({ N: 1 });
    // no unspent wild charge remains
    expect(g.charges.filter((c) => c.charge === "wild")).toHaveLength(0);
  });

  it("a played wild with no choice yet is a pending node (chosenFreq null)", () => {
    const g = graph([item("base:Southollow Royal Tulip")], [], [wild("")]);
    expect(g.wilds).toHaveLength(1);
    expect(g.wilds[0].chosenFreq).toBeNull();
    // a pending wild contributes nothing to the tally
    expect(g.tally).toEqual({});
  });

  it("a wild's chosen frequency participates in combination", () => {
    // Chrysipil = A,A,D,T: three pures + one wild chosen T.
    const g = graph(
      [item("pure:A"), item("pure:A"), item("pure:D"), item("base:Southollow Royal Tulip")],
      [],
      [wild("T")],
    );
    expect(g.combined.map((c) => c.freq)).toEqual(["Chrysipil"]);
    expect(g.tally).toEqual({ Chrysipil: 1 });
  });
});

// ── 5. Pinned-with-missing case (ghost circles + ghost item-frames) ───────────

describe("pinned recipe with missing frequencies", () => {
  // Empty brew, pin Bright (recipe [En, Ev]).
  const g = graph([], [], [], pin("base:bright"));

  it("is unsatisfied with both recipe frequencies missing", () => {
    expect(g.pin).not.toBeNull();
    expect(g.pin!.satisfied).toBe(false);
    expect(g.pin!.k).toBe(1);
    expect(g.pin!.missing).toEqual({ En: 1, Ev: 1 });
  });

  it("emits a ghost frequency circle per missing frequency", () => {
    expect(g.ghostFrequencies.map((f) => f.freq).sort()).toEqual(["En", "Ev"]);
    for (const gf of g.ghostFrequencies) expect(gf.band).toBe("frequency");
  });

  it("emits a ghost item-frame 'any source of X' beneath each ghost circle", () => {
    expect(g.ghostItems.map((i) => i.wants).sort()).toEqual(["En", "Ev"]);
    for (const gi of g.ghostItems) expect(gi.band).toBe("ingredient");
  });

  it("wires each ghost item-frame to its ghost circle", () => {
    const ghostEdges = g.edges.filter((e) => e.kind === "ghost");
    expect(ghostEdges).toHaveLength(2);
    for (const e of ghostEdges) {
      expect(g.ghostItems.some((i) => i.id === e.from)).toBe(true);
      expect(g.ghostFrequencies.some((f) => f.id === e.to)).toBe(true);
    }
  });

  it("shrinks the ghost set as the brew fills toward the recipe", () => {
    // add one Ev source (pure:Ev) -> only En remains missing
    const g2 = graph([item("pure:Ev")], [], [], pin("base:bright"));
    expect(g2.pin!.satisfied).toBe(false);
    expect(g2.pin!.missing).toEqual({ En: 1 });
    expect(g2.ghostFrequencies.map((f) => f.freq)).toEqual(["En"]);
    expect(g2.ghostItems.map((i) => i.wants)).toEqual(["En"]);
  });
});

// ── 6. k=2 multiples case (satisfied with which k) ────────────────────────────

describe("k=2 multiples case", () => {
  // Two Brightflower {Ev, En} -> tally {Ev×2, En×2} = 2× Bright [En, Ev].
  const g = graph(
    [item("base:Brightflower"), item("base:Brightflower")],
    [],
    [],
    pin("base:bright"),
  );

  it("stacks the two copies on one item node", () => {
    expect(g.items).toHaveLength(1);
    expect(g.items[0].count).toBe(2);
  });

  it("marks the pin satisfied at k=2 with no missing", () => {
    expect(g.pin!.satisfied).toBe(true);
    expect(g.pin!.k).toBe(2);
    expect(g.pin!.missing).toEqual({});
    expect(g.ghostFrequencies).toHaveLength(0);
    expect(g.ghostItems).toHaveLength(0);
  });

  it("tallies the doubled multiset", () => {
    expect(g.tally).toEqual({ Ev: 2, En: 2 });
  });

  it("computes k across an under-filled multiple as the nearest ceiling", () => {
    // one Brightflower (Ev,En) + one extra Ev -> {Ev×2, En×1}. Against Bright
    // [En,Ev], k = max(ceil(2/1), ceil(1/1)) = 2, still missing one En.
    const g2 = graph(
      [item("base:Brightflower"), item("pure:Ev")],
      [],
      [],
      pin("base:bright"),
    );
    expect(g2.pin!.k).toBe(2);
    expect(g2.pin!.satisfied).toBe(false);
    expect(g2.pin!.missing).toEqual({ En: 1 });
  });
});

// ── hypothetical flag & stacked counts ────────────────────────────────────────

describe("item stacking and the hypothetical flag", () => {
  it("stacks copies of one key and counts the hypothetical ones with contributors", () => {
    const g = graph([
      item("base:Pemneath Peat", true, "Ana"),
      item("base:Pemneath Peat", false, "Ben"),
      item("base:Pemneath Peat", false, "Ben"),
    ]);
    expect(g.items).toHaveLength(1);
    expect(g.items[0].count).toBe(3);
    expect(g.items[0].hypothetical).toBe(2);
    expect(g.items[0].contributors).toEqual(["Ben"]); // distinct
  });

  it("keeps distinct keys as separate item nodes in first-seen order", () => {
    const g = graph([
      item("base:Silver"),
      item("base:Gold"),
      item("base:Silver"),
    ]);
    expect(g.items.map((i) => i.name)).toEqual(["Silver", "Gold"]);
    expect(g.items[0].count).toBe(2);
  });

  it("drops unknown catalog keys rather than crashing", () => {
    const g = graph([item("base:Nonexistent Thing"), item("base:Silver")]);
    expect(g.items.map((i) => i.name)).toEqual(["Silver"]);
  });
});

// ── available charges above their source ──────────────────────────────────────

describe("strike/wild charges (unspent, above their source item)", () => {
  it("floats unspent strike charges attributed to the granting item", () => {
    // Shadow Demon Liver grants 2 ⊖, emits nothing.
    const g = graph([item("base:Shadow Demon Liver")]);
    const strikes = g.charges.filter((c) => c.charge === "strike");
    expect(strikes).toHaveLength(2);
    for (const c of strikes) expect(c.sourceId).toBe(g.items[0].id);
    // a grant edge wires the item to each charge
    expect(g.edges.filter((e) => e.kind === "grant")).toHaveLength(2);
  });

  it("positions each charge above its source ingredient (DESIGN.md §1)", () => {
    // Two ingredients, only the FIRST grants strikes (Shadow Demon Liver, 2 ⊖);
    // its charges must sit over that item's x, not drift to the end of the arc.
    const g = graph([item("base:Shadow Demon Liver"), item("base:Silver")]);
    const source = g.items.find((i) => i.name === "Shadow Demon Liver")!;
    const other = g.items.find((i) => i.name === "Silver")!;
    const strikes = g.charges.filter((c) => c.charge === "strike");
    expect(strikes).toHaveLength(2);
    // the first charge sits exactly over its source item's x…
    expect(strikes[0].pos.x).toBeCloseTo(source.pos.x, 5);
    // …and every charge is nearer its source than the unrelated item.
    for (const c of strikes) {
      expect(Math.abs(c.pos.x - source.pos.x)).toBeLessThan(
        Math.abs(c.pos.x - other.pos.x),
      );
      // charges sit in the frequency band, above the ingredient row
      expect(c.pos.y).toBeLessThan(source.pos.y);
    }
  });

  it("shows fewer unspent charges once some are played", () => {
    // Shadow Demon Liver (2⊖) + Pemneath Peat (N,N); strike one N spends one ⊖.
    const g = graph(
      [item("base:Shadow Demon Liver"), item("base:Pemneath Peat")],
      [strike("N")],
    );
    expect(g.charges.filter((c) => c.charge === "strike")).toHaveLength(1);
  });
});

// ── blend tint ────────────────────────────────────────────────────────────────

describe("blendTint (cauldron liquid = blend of the tally's fundamentals)", () => {
  it("returns a slate fallback for an empty tally", () => {
    expect(blendTint({})).toBe("#3a3866");
    expect(graph([]).cauldron.tint).toBe("#3a3866");
  });

  it("returns a single fundamental's own school color", () => {
    // N's school color, lowercased hex
    expect(blendTint({ N: 1 })).toBe(FUND["N"].color.toLowerCase());
    expect(blendTint({ T: 1 })).toBe(FUND["T"].color.toLowerCase());
  });

  it("averages two fundamentals channel-wise", () => {
    // A (#4F8DD6) + T (#27AE60) midpoint
    const a = [0x4f, 0x8d, 0xd6];
    const t = [0x27, 0xae, 0x60];
    const mid = a.map((v, i) => Math.round((v + t[i]) / 2));
    const hex = `#${mid.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    expect(blendTint({ A: 1, T: 1 })).toBe(hex);
  });

  it("expands a named frequency to its fundamentals before averaging", () => {
    // Ignetium = Ev,Ev,En,C — a pure fundamental average over those four.
    const parts = { Ev: 2, En: 1, C: 1 };
    let r = 0, g = 0, b = 0, n = 0;
    for (const [id, w] of Object.entries(parts)) {
      const h = FUND[id].color.replace("#", "");
      r += parseInt(h.slice(0, 2), 16) * w;
      g += parseInt(h.slice(2, 4), 16) * w;
      b += parseInt(h.slice(4, 6), 16) * w;
      n += w;
    }
    const hex = `#${[r, g, b].map((v) => Math.round(v / n).toString(16).padStart(2, "0")).join("")}`;
    expect(blendTint({ Ignetium: 1 })).toBe(hex);
  });

  it("is order-independent", () => {
    expect(blendTint({ A: 1, N: 1, T: 1 })).toBe(blendTint({ T: 1, A: 1, N: 1 }));
  });
});

// ── determinism & geometry invariants ─────────────────────────────────────────

describe("determinism and geometry", () => {
  const input: BrewGraphInput = {
    items: [item("base:Pepperpops"), item("base:Brightflower"), item("base:Silver")],
    strikePlays: [],
    wildPlays: [],
    pinned: pin("base:frenzy"),
  };

  it("produces byte-identical output for identical input", () => {
    expect(JSON.stringify(buildBrewGraph(input))).toBe(
      JSON.stringify(buildBrewGraph(input)),
    );
  });

  it("places every node inside the abstract 0..100 stage box", () => {
    const g = buildBrewGraph(input);
    for (const node of g.nodes) {
      expect(node.pos.x).toBeGreaterThanOrEqual(0);
      expect(node.pos.x).toBeLessThanOrEqual(100);
      expect(node.pos.y).toBeGreaterThanOrEqual(0);
      expect(node.pos.y).toBeLessThanOrEqual(100);
    }
  });

  it("keeps the bands stacked bottom→top (cauldron lowest, combined highest)", () => {
    const g = buildBrewGraph(input);
    const cauldronY = g.cauldron.pos.y;
    // combined band sits above (smaller y) the ingredient band and cauldron
    for (const c of g.combined) expect(c.pos.y).toBeLessThan(cauldronY);
    for (const i of g.items) expect(i.pos.y).toBeLessThan(cauldronY);
    // combined highest of all
    const maxCombinedY = Math.max(...g.combined.map((c) => c.pos.y));
    const minItemY = Math.min(...g.items.map((i) => i.pos.y));
    expect(maxCombinedY).toBeLessThan(minItemY);
  });

  it("exposes the same nodes in the flat `nodes` array as in the typed buckets", () => {
    const g = buildBrewGraph(input);
    const bucketTotal =
      1 +
      g.items.length +
      g.ghostItems.length +
      g.frequencies.length +
      g.combined.length +
      g.charges.length +
      g.wilds.length +
      g.ghostFrequencies.length;
    expect(g.nodes).toHaveLength(bucketTotal);
  });

  it("gives every edge distinct, stable ids", () => {
    const g = buildBrewGraph(input);
    const ids = g.edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
