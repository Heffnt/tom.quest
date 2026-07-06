// Pure layout module for the brew graph (DESIGN.md §1 "brew graph", §5 "Pin").
//
// Input: a BrewSnapshot slice (items with the real flag, strike/wild plays, the
// pinned recipe) + the catalog (base.ts) + the engine. Output: a deterministic
// node/edge model the renderer draws WITHOUT re-deriving any rule. Every rule —
// what a frequency emits, what auto-combines into what, whether a strike lands,
// how many copies (k) a pinned recipe wants, what the tally still misses — is
// resolved here through engine primitives, never in the renderer.
//
// No React, no DOM. Pure data in / data out; positions live in an abstract
// coordinate space (percent of an abstract stage box, 0..100) that the renderer
// scales. The geometry mirrors the original stage arc metaphor: the
// cauldron at the bottom, the ingredient row above it, the frequency band above
// that, and the combined band at the very top — growth is upward, orientation
// fixed. This graph replaces cauldron.tsx's hand-rolled arc math with the same
// spirit expressed as data.

import type { Frequency, Ingredient, Multiset } from "./types";
import type { BrewItem, StrikePlay, WildPlay, PinnedRecipe } from "./brew-types";
import {
  baseIngredients,
  pureIngredients,
  basePerfumes,
  FUND,
  NAMED,
  isNamed,
  isFundamental,
} from "../data/base";
import {
  chargeTotals,
  effectiveTally,
  msFromList,
  msDiff,
  msScale,
  msEqual,
  msSize,
  traceCombination,
  type FreqInstance,
} from "./engine";

// ── catalog lookup ───────────────────────────────────────────────────────────

const CATALOG = new Map<string, Ingredient>(
  [...baseIngredients, ...pureIngredients].map((i) => [i.key, i]),
);
const PERFUME_BY_KEY = new Map(basePerfumes.map((p) => [p.key, p]));

// ── blend tint ───────────────────────────────────────────────────────────────
// The cauldron liquid tints to the blend of the SCHOOL colors of the
// FUNDAMENTAL frequencies in the current tally (DESIGN.md §7). Named frequencies
// carry no school color of their own, so they are expanded to their fundamental
// components (recursively, weighted by multiplicity) before averaging. This
// reuses the color data on `fundamentals` (base.json) — no new color constants.

const FALLBACK_TINT = "#3a3866"; // empty tally: the vessel's own slate rim color

// Expand a frequency to its fundamental multiset (fundamentals map to
// themselves). Pure, memoised — the named graph is a fixed DAG.
const FUND_EXPANSION = new Map<string, Multiset>();
function expandToFundamentals(id: string): Multiset {
  const cached = FUND_EXPANSION.get(id);
  if (cached) return cached;
  let out: Multiset;
  if (isFundamental(id)) {
    out = { [id]: 1 };
  } else if (isNamed(id)) {
    out = {};
    for (const comp of NAMED[id].components) {
      const sub = expandToFundamentals(comp);
      for (const k in sub) out[k] = (out[k] ?? 0) + sub[k];
    }
  } else {
    out = {};
  }
  FUND_EXPANSION.set(id, out);
  return out;
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The cauldron's blend tint: the multiplicity-weighted average of the school
 * colors of every FUNDAMENTAL the tally expands to. Deterministic; independent
 * of key order (the weights come from the multiset, and averaging is
 * commutative). An empty (or fundamental-free) tally returns the slate fallback.
 */
export function blendTint(tally: Multiset): string {
  const weights: Multiset = {};
  for (const id in tally) {
    const funds = expandToFundamentals(id);
    for (const f in funds) weights[f] = (weights[f] ?? 0) + funds[f] * tally[id];
  }
  let total = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const f in weights) {
    const color = FUND[f]?.color;
    if (!color) continue;
    const [fr, fg, fb] = parseHex(color);
    const w = weights[f];
    r += fr * w;
    g += fg * w;
    b += fb * w;
    total += w;
  }
  if (total === 0) return FALLBACK_TINT;
  return toHex([r / total, g / total, b / total]);
}

// ── node & edge model ────────────────────────────────────────────────────────

/** Bands stack bottom→top; the renderer maps each to a vertical zone. */
export type GraphBand = "cauldron" | "ingredient" | "frequency" | "combined";

/** Abstract stage position (percent of the stage box, 0..100). */
export type GraphPoint = { x: number; y: number };

export type CauldronNode = {
  kind: "cauldron";
  id: "cauldron";
  band: "cauldron";
  pos: GraphPoint;
  /** Blend of the school colors of the tally's fundamentals (computed hex). */
  tint: string;
  /** Frequencies (after combination) counting toward recipes — the tally size. */
  tallyCount: number;
};

export type ItemNode = {
  kind: "item";
  id: string; // "item:<catalogKey>"
  band: "ingredient";
  pos: GraphPoint;
  itemKey: string;
  name: string;
  color: string;
  count: number; // stacked copies of this catalog key
  hypothetical: number; // how many of `count` are hypothetical (dashed)
  contributors: string[]; // distinct contributor names of the hypothetical copies
};

/** A ghost item-frame the pinned recipe still needs a source for. */
export type GhostItemNode = {
  kind: "ghostItem";
  id: string; // "ghostItem:<freq>:<n>"
  band: "ingredient";
  pos: GraphPoint;
  /** The frequency this frame should supply — "any source of X". */
  wants: Frequency;
};

export type FrequencyNode = {
  kind: "frequency";
  id: string; // stable per instance
  band: "frequency";
  pos: GraphPoint;
  freq: Frequency;
  /** true when this circle was emitted via a wild ⊕ (renderer marks it). */
  fromWild: boolean;
  /** true when a strike covers this circle (renderer draws the purple cover). */
  struck: boolean;
  /** who played the covering strike (per-member undo); null when unstruck. */
  struckBy: string | null;
  /** true when auto-combination consumed this circle into a combined node. */
  consumed: boolean;
  /** the source item node id this frequency rose from (null for wilds). */
  sourceId: string | null;
};

export type CombinedNode = {
  kind: "combined";
  id: string; // the traceCombination step ref
  band: "combined";
  pos: GraphPoint;
  freq: Frequency; // the named frequency produced
  /** true when a heavier combination consumed THIS node in turn (chaining). */
  consumed: boolean;
};

/** An available (unspent) strike or wild charge floating above its source item. */
export type ChargeNode = {
  kind: "charge";
  id: string; // "charge:<strike|wild>:<n>"
  band: "frequency";
  pos: GraphPoint;
  charge: "strike" | "wild";
  sourceId: string; // the item node that granted it
};

/** A wild ⊕ charge that has been played; chosenFreq null = pending dropdown. */
export type WildNode = {
  kind: "wild";
  id: string; // "wild:<n>"
  band: "frequency";
  pos: GraphPoint;
  /** the frequency chosen for the wild, or null → renderer shows the dropdown. */
  chosenFreq: Frequency | null;
  sourceId: string | null; // the item node that granted the ⊕
};

/** A missing frequency the pinned recipe still needs, as a ghost circle. */
export type GhostFrequencyNode = {
  kind: "ghostFrequency";
  id: string; // "ghostFreq:<freq>:<n>"
  band: "frequency";
  pos: GraphPoint;
  freq: Frequency;
};

export type GraphNode =
  | CauldronNode
  | ItemNode
  | GhostItemNode
  | FrequencyNode
  | CombinedNode
  | ChargeNode
  | WildNode
  | GhostFrequencyNode;

export type GraphEdgeKind =
  | "stem" // cauldron → item
  | "emit" // item → frequency circle
  | "grant" // item → charge / wild
  | "combine" // component frequency/combined → combined node
  | "ghost"; // pinned-recipe ghost linkage

export type GraphEdge = {
  id: string; // stable
  kind: GraphEdgeKind;
  from: string; // node id
  to: string; // node id
};

/** The satisfied state of a pinned recipe against the current tally. */
export type PinStatus = {
  perfumeId: string;
  perfumeName: string;
  recipeIndex: number;
  /** true when the tally matches the recipe exactly at some integer k. */
  satisfied: boolean;
  /** the k it matches at when satisfied; else the k the ghosts are computed for. */
  k: number;
  /** frequencies (k×recipe − tally) the brew still lacks, as a multiset. */
  missing: Multiset;
} | null;

export type BrewGraph = {
  cauldron: CauldronNode;
  items: ItemNode[];
  ghostItems: GhostItemNode[];
  frequencies: FrequencyNode[];
  combined: CombinedNode[];
  charges: ChargeNode[];
  wilds: WildNode[];
  ghostFrequencies: GhostFrequencyNode[];
  edges: GraphEdge[];
  /** every node in one array, for renderers that iterate uniformly. */
  nodes: GraphNode[];
  pin: PinStatus;
  /** the effective tally BEFORE combination (post strike/wild). */
  effectiveTally: Multiset;
  /** the tally AFTER combination — what counts for recipes. */
  tally: Multiset;
};

// ── abstract geometry ────────────────────────────────────────────────────────
// Percent-of-stage coordinates matching cauldron.tsx's arc metaphor: cauldron
// mouth low-center, three arcs fanning upward. The renderer scales this box.

const MOUTH: GraphPoint = { x: 50, y: 78 };

// A "hand of cards" arc: fan `n` items around a pivot below, opening upward.
// `i` is the item's index; `spread`/`radius`/`pivotY` shape the fan. Extracted
// from cauldron.tsx's ingArcSlot/freqArcSlot so all three bands share one law.
function arcSlot(
  i: number,
  n: number,
  cfg: { step: number; maxFan: number; rx: number; ry: number; pivotY: number; solo: number },
): GraphPoint {
  if (n <= 1) return { x: 50, y: cfg.solo };
  const step = Math.min(cfg.step, cfg.maxFan / (n - 1));
  const a = (i - (n - 1) / 2) * step;
  return {
    x: 50 + cfg.rx * Math.sin(a),
    y: cfg.pivotY - cfg.ry * Math.cos(a),
  };
}

const ING_ARC = { step: 0.34, maxFan: 1.9, rx: 38, ry: 34, pivotY: 92, solo: 58 };
const FREQ_ARC = { step: 0.27, maxFan: 2.25, rx: 38, ry: 28, pivotY: 61, solo: 33 };

// The combined band wraps into rows of 8, stacking downward from the top —
// mirrors cauldron.tsx's derivedArcSlot.
function combinedSlot(i: number, n: number): GraphPoint {
  const PER_ROW = 8;
  const row = Math.floor(i / PER_ROW);
  const inRow = Math.min(PER_ROW, n - row * PER_ROW);
  const j = i % PER_ROW;
  const centerY = 7 + row * 11;
  if (inRow <= 1) return { x: 50, y: centerY };
  const step = Math.min(0.3, 1.6 / (inRow - 1));
  const a = (j - (inRow - 1) / 2) * step;
  return { x: 50 + 32 * Math.sin(a), y: centerY + 20 - 20 * Math.cos(a) };
}

// ── the builder ──────────────────────────────────────────────────────────────

export type BrewGraphInput = {
  items: BrewItem[];
  strikePlays: StrikePlay[];
  wildPlays: WildPlay[];
  pinned: PinnedRecipe;
};

/**
 * Build the full brew-graph model from a brew slice. Deterministic: identical
 * input → byte-identical output (node ids and positions are keyed by stable
 * identity and input order, never by iteration of unordered maps). Every rule is
 * resolved through engine primitives; the renderer only draws.
 */
export function buildBrewGraph(input: BrewGraphInput): BrewGraph {
  const { items, strikePlays, wildPlays, pinned } = input;

  // ── item nodes: one per distinct catalog key, in first-seen order ──────────
  type ItemAgg = {
    itemKey: string;
    ing: Ingredient;
    count: number;
    hypothetical: number;
    contributors: string[];
    seen: Set<string>;
  };
  const itemOrder: string[] = [];
  const itemAgg = new Map<string, ItemAgg>();
  for (const it of items) {
    const ing = CATALOG.get(it.key);
    if (!ing) continue; // unknown catalog key: not drawable
    let agg = itemAgg.get(it.key);
    if (!agg) {
      agg = {
        itemKey: it.key,
        ing,
        count: 0,
        hypothetical: 0,
        contributors: [],
        seen: new Set(),
      };
      itemAgg.set(it.key, agg);
      itemOrder.push(it.key);
    }
    agg.count++;
    if (!it.real) {
      agg.hypothetical++;
      if (!agg.seen.has(it.contributorName)) {
        agg.seen.add(it.contributorName);
        agg.contributors.push(it.contributorName);
      }
    }
  }

  const itemNodeId = (key: string): string => `item:${key}`;
  const itemNodes: ItemNode[] = itemOrder.map((key, i) => {
    const agg = itemAgg.get(key)!;
    return {
      kind: "item",
      id: itemNodeId(key),
      band: "ingredient",
      pos: arcSlot(i, itemOrder.length, ING_ARC),
      itemKey: key,
      name: agg.ing.name,
      color: agg.ing.color,
      count: agg.count,
      hypothetical: agg.hypothetical,
      contributors: agg.contributors,
    };
  });

  // The engine sees the flattened ingredient list (every copy, in item order),
  // so tallies/charges/combination match the store exactly.
  const ingredients: Ingredient[] = items
    .map((it) => CATALOG.get(it.key))
    .filter((i): i is Ingredient => !!i);

  // ── emitted frequency instances, attributed to their source item ───────────
  // Each emitted frequency becomes a FreqInstance with a stable ref so the
  // combination trace can name it. Refs are `emit:<itemKey>:<globalIndex>` —
  // stable across renders for identical input.
  const freqNodes: FrequencyNode[] = [];
  const emitInstances: FreqInstance[] = [];
  let emitCounter = 0;
  for (const it of items) {
    const ing = CATALOG.get(it.key);
    if (!ing) continue;
    for (const freq of ing.emits) {
      const ref = `emit:${emitCounter++}`;
      emitInstances.push({ ref, id: freq });
      const node: FrequencyNode = {
        kind: "frequency",
        id: ref,
        band: "frequency",
        pos: { x: 50, y: FREQ_ARC.solo }, // positioned after the full band is known
        freq,
        fromWild: false,
        struck: false,
        struckBy: null,
        consumed: false,
        sourceId: itemNodeId(it.key),
      };
      freqNodes.push(node);
    }
  }

  // ── wild plays → wild nodes (chosenFreq feeds the tally & combination) ──────
  // The engine's effectiveTally adds every wildPlay's chosen frequency, so a
  // chosen wild participates in combination exactly like an emitted frequency.
  // A wild is attributed to a ⊕-granting item in play order (charges spend in
  // brew order — same rule the store's trimPlays enforces).
  const totals = chargeTotals(ingredients);
  const wildSourceIds: (string | null)[] = [];
  const strikeSourceIds: (string | null)[] = [];
  for (const it of items) {
    const ing = CATALOG.get(it.key);
    if (!ing) continue;
    for (let i = 0; i < ing.wild; i++) wildSourceIds.push(itemNodeId(it.key));
    for (let i = 0; i < ing.strike; i++) strikeSourceIds.push(itemNodeId(it.key));
  }

  const wildNodes: WildNode[] = [];
  wildPlays.forEach((wp, i) => {
    const ref = `wild:${i}`;
    wildNodes.push({
      kind: "wild",
      id: ref,
      band: "frequency",
      pos: { x: 50, y: FREQ_ARC.solo },
      chosenFreq: wp.chosenFreq || null,
      sourceId: wildSourceIds[i] ?? null,
    });
    // a chosen wild joins the combination pool as a labeled instance
    if (wp.chosenFreq) emitInstances.push({ ref: `wild:${i}`, id: wp.chosenFreq });
  });

  // ── strikes: cover the LAST emitted instance of each struck frequency ───────
  // Mirrors the engine (effectiveTally strikes at the id level) and cauldron.tsx
  // (strikes ghost the last instances of a frequency id). We resolve strikes
  // BEFORE combination and drop struck instances from the combination pool, so
  // a struck frequency never fuses. Each StrikePlay carries byMemberKey through.
  const struckCount: Record<string, number> = {};
  for (const sp of strikePlays) struckCount[sp.freq] = (struckCount[sp.freq] ?? 0) + 1;
  const struckByFor: Record<string, string[]> = {};
  for (const sp of strikePlays) (struckByFor[sp.freq] ??= []).push(sp.byMemberKey);

  // group emitted instances by frequency id, in emission order, and mark the
  // last `struckCount[id]` of each as struck (matching the engine's id-level cut).
  const byFreq = new Map<string, FrequencyNode[]>();
  for (const node of freqNodes) {
    const list = byFreq.get(node.freq);
    if (list) list.push(node);
    else byFreq.set(node.freq, [node]);
  }
  const struckRefs = new Set<string>();
  for (const [freq, list] of byFreq) {
    const n = Math.min(struckCount[freq] ?? 0, list.length);
    const by = struckByFor[freq] ?? [];
    for (let i = 0; i < n; i++) {
      const node = list[list.length - 1 - i];
      node.struck = true;
      node.struckBy = by[i] ?? by[by.length - 1] ?? null;
      struckRefs.add(node.id);
    }
  }

  // ── combination trace over the SURVIVING (unstruck) instances ──────────────
  const poolForCombine = emitInstances.filter((inst) => !struckRefs.has(inst.ref));
  const trace = traceCombination(poolForCombine);

  // mark consumed emitted/wild frequency circles
  const consumedRefs = new Set<string>();
  for (const step of trace.steps) for (const ref of step.consumed) consumedRefs.add(ref);
  for (const node of freqNodes) if (consumedRefs.has(node.id)) node.consumed = true;

  const combinedNodes: CombinedNode[] = trace.steps.map((step) => ({
    kind: "combined",
    id: step.ref,
    band: "combined",
    pos: { x: 50, y: 7 },
    freq: step.id,
    consumed: consumedRefs.has(step.ref), // a combined node a heavier combo ate
  }));

  // ── available (unspent) charges float above their granting item ────────────
  const availStrike = Math.max(0, totals.strike - strikePlays.length);
  const availWild = Math.max(0, totals.wild - wildPlays.length);
  const chargeNodes: ChargeNode[] = [];
  for (let i = 0; i < availStrike; i++) {
    // the granting item is the one at play-order slot (strikePlays.length + i)
    const src = strikeSourceIds[strikePlays.length + i] ?? strikeSourceIds[strikeSourceIds.length - 1];
    chargeNodes.push({
      kind: "charge",
      id: `charge:strike:${i}`,
      band: "frequency",
      pos: { x: 50, y: FREQ_ARC.solo },
      charge: "strike",
      sourceId: src ?? "",
    });
  }
  for (let i = 0; i < availWild; i++) {
    const src = wildSourceIds[wildPlays.length + i] ?? wildSourceIds[wildSourceIds.length - 1];
    chargeNodes.push({
      kind: "charge",
      id: `charge:wild:${i}`,
      band: "frequency",
      pos: { x: 50, y: FREQ_ARC.solo },
      charge: "wild",
      sourceId: src ?? "",
    });
  }

  // ── tallies ────────────────────────────────────────────────────────────────
  const eff = effectiveTally({
    ingredients,
    strikePlays: strikePlays.map((s) => s.freq),
    wildPlays: wildPlays.map((w) => w.chosenFreq).filter((f): f is string => !!f),
  });
  // the tally AFTER combination = surviving (uncombined) instances + final
  // combined nodes. Built from the trace so it agrees with the drawn graph.
  const tally: Multiset = {};
  for (const node of freqNodes) {
    if (!node.struck && !node.consumed) tally[node.freq] = (tally[node.freq] ?? 0) + 1;
  }
  // wilds join emitInstances as `wild:<i>`; a chosen wild that survived
  // combination counts toward the tally, a consumed one does not.
  for (let i = 0; i < wildPlays.length; i++) {
    const wp = wildPlays[i];
    if (!wp.chosenFreq) continue;
    if (!consumedRefs.has(`wild:${i}`)) tally[wp.chosenFreq] = (tally[wp.chosenFreq] ?? 0) + 1;
  }
  for (const c of combinedNodes) {
    if (!c.consumed) tally[c.freq] = (tally[c.freq] ?? 0) + 1;
  }

  // ── cauldron node ──────────────────────────────────────────────────────────
  const cauldron: CauldronNode = {
    kind: "cauldron",
    id: "cauldron",
    band: "cauldron",
    pos: MOUTH,
    tint: blendTint(tally),
    tallyCount: msSize(tally),
  };

  // ── pinned recipe: ghosts + satisfied ──────────────────────────────────────
  const ghostFrequencies: GhostFrequencyNode[] = [];
  const ghostItems: GhostItemNode[] = [];
  let pin: PinStatus = null;
  if (pinned) {
    const perfume = PERFUME_BY_KEY.get(pinned.perfumeId);
    if (perfume && pinned.recipeIndex >= 0 && pinned.recipeIndex < perfume.recipes.length) {
      const recipe = msFromList(perfume.recipes[pinned.recipeIndex]);
      const { k, missing, satisfied } = pinnedDelta(tally, recipe);
      pin = {
        perfumeId: pinned.perfumeId,
        perfumeName: perfume.name,
        recipeIndex: pinned.recipeIndex,
        satisfied,
        k,
        missing,
      };
      // a ghost circle per missing frequency, and a ghost item-frame beneath it
      // suggesting "any source of X"
      for (const freq of Object.keys(missing).sort()) {
        for (let c = 0; c < missing[freq]; c++) {
          ghostFrequencies.push({
            kind: "ghostFrequency",
            id: `ghostFreq:${freq}:${c}`,
            band: "frequency",
            pos: { x: 50, y: FREQ_ARC.solo },
            freq,
          });
          ghostItems.push({
            kind: "ghostItem",
            id: `ghostItem:${freq}:${c}`,
            band: "ingredient",
            pos: { x: 50, y: ING_ARC.solo },
            wants: freq,
          });
        }
      }
    }
  }

  // ── positions: lay out each band once all its members are known ────────────
  // frequency band = emitted circles ++ played wilds ++ ghost circles, in a
  // stable render order; the arc law spreads them. Available charges are NOT on
  // this arc — DESIGN.md §1 requires a strike/wild charge to "render above the
  // ingredient that granted them," so each charge is placed over its source
  // item's x below (see chargeNodes positioning).
  const freqBand: GraphNode[] = [
    ...freqNodes,
    ...wildNodes,
    ...ghostFrequencies,
  ];
  freqBand.forEach((node, i) => {
    node.pos = arcSlot(i, freqBand.length, FREQ_ARC);
  });
  combinedNodes.forEach((node, i) => {
    node.pos = combinedSlot(i, combinedNodes.length);
  });
  // ingredient band = item nodes ++ ghost item frames
  const ingBand: GraphNode[] = [...itemNodes, ...ghostItems];
  ingBand.forEach((node, i) => {
    node.pos = arcSlot(i, ingBand.length, ING_ARC);
  });

  // available charges float directly ABOVE their granting ingredient (DESIGN.md
  // §1 — "render above the ingredient that granted them"). Each charge takes its
  // source item's x and sits at the frequency-band height; when one item grants
  // several charges they fan sideways so they don't stack on one point.
  const itemPosById = new Map(itemNodes.map((n) => [n.id, n.pos]));
  const chargeSlotOfItem = new Map<string, number>();
  const CHARGE_Y = FREQ_ARC.pivotY - FREQ_ARC.ry; // the band's near edge, above the items
  const CHARGE_FAN = 6; // x offset per additional charge on the same item
  for (const charge of chargeNodes) {
    const anchor = itemPosById.get(charge.sourceId);
    if (!anchor) continue; // no drawable source: leave at its default solo slot
    const nth = chargeSlotOfItem.get(charge.sourceId) ?? 0;
    chargeSlotOfItem.set(charge.sourceId, nth + 1);
    const x = Math.max(2, Math.min(98, anchor.x + nth * CHARGE_FAN));
    charge.pos = { x, y: CHARGE_Y };
  }

  // ── edges ──────────────────────────────────────────────────────────────────
  const edges: GraphEdge[] = [];
  // stems: cauldron → each item
  for (const item of itemNodes) {
    edges.push({ id: `stem:${item.id}`, kind: "stem", from: cauldron.id, to: item.id });
  }
  // emit: item → its frequency circles
  for (const node of freqNodes) {
    if (node.sourceId) {
      edges.push({ id: `emit:${node.id}`, kind: "emit", from: node.sourceId, to: node.id });
    }
  }
  // grant: item → its charges / wilds
  for (const charge of chargeNodes) {
    if (charge.sourceId) {
      edges.push({ id: `grant:${charge.id}`, kind: "grant", from: charge.sourceId, to: charge.id });
    }
  }
  for (const wild of wildNodes) {
    if (wild.sourceId) {
      edges.push({ id: `grant:${wild.id}`, kind: "grant", from: wild.sourceId, to: wild.id });
    }
  }
  // combine: each consumed component → the combined node it fed
  for (const step of trace.steps) {
    for (const ref of step.consumed) {
      // a component ref is an emitted circle, a played wild, or an earlier
      // combined node (chaining) — every one is already a node id in this graph.
      edges.push({
        id: `combine:${ref}->${step.ref}`,
        kind: "combine",
        from: ref,
        to: step.ref,
      });
    }
  }
  // ghost: each ghost item-frame → its ghost circle (the pinned recipe's need)
  for (let i = 0; i < ghostFrequencies.length; i++) {
    edges.push({
      id: `ghost:${ghostItems[i].id}->${ghostFrequencies[i].id}`,
      kind: "ghost",
      from: ghostItems[i].id,
      to: ghostFrequencies[i].id,
    });
  }

  const nodes: GraphNode[] = [
    cauldron,
    ...itemNodes,
    ...ghostItems,
    ...freqNodes,
    ...combinedNodes,
    ...chargeNodes,
    ...wildNodes,
    ...ghostFrequencies,
  ];

  return {
    cauldron,
    items: itemNodes,
    ghostItems,
    frequencies: freqNodes,
    combined: combinedNodes,
    charges: chargeNodes,
    wilds: wildNodes,
    ghostFrequencies,
    edges,
    nodes,
    pin,
    effectiveTally: eff,
    tally,
  };
}

// ── pinned-recipe delta ──────────────────────────────────────────────────────
// The pin renders ghosts for the gap between the effective tally and k× the
// pinned recipe (DESIGN.md §5). We pick the SMALLEST k whose k×recipe still
// covers the tally (so the ghosts show the nearest reachable multiple), and
// report satisfied when the tally equals k×recipe exactly.
//
// k = max over the recipe's frequencies of ceil(tally_f / recipe_f), floored at
// 1 — the same k* ceiling the engine's evalReq uses. That is the least k whose
// multiple is not already exceeded by the tally on any single frequency.
function pinnedDelta(
  tally: Multiset,
  recipe: Multiset,
): { k: number; missing: Multiset; satisfied: boolean } {
  let k = 1;
  for (const f in recipe) {
    k = Math.max(k, Math.ceil((tally[f] ?? 0) / recipe[f]));
  }
  const kR = msScale(recipe, k);
  const missing = msDiff(kR, tally);
  const satisfied = msEqual(tally, kR);
  return { k, missing, satisfied };
}
