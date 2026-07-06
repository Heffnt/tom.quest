"use client";

// The perfume panel: a vertical, searchable book of the 41 d40 perfumes, one
// COMPACT strip each: name + weight (with the "recipes" fold button under
// them), the integrated frequency requirement as bare symbols (shared core,
// interchangeable alternatives in parentheses, optional extras dashed), and
// the brew formula — a mini cauldron + the box of frequencies still missing
// (strikes needed shown as that many ⊖ icons). The fold lists every
// ingredient combination (common d40 ones first), grouped by the outside
// strikes required: strike-free first, then ⊖1 / ⊖2 behind reveal buttons.
//
// PURE REFERENCE — brewed output lives on the cauldron's shelf, never here.
// Search, the multi-select frequency filter, expanded folds and pins are
// shared browse UI (SharedUI) written through onUI; pins are owner-only.
// The ingredient pills in the folds are real grabbable items wired to the
// hand grammar (see DESIGN.md).

import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Multiset, Perfume, EvalResult, PerfumeSlotEntry, BrewState } from "../lib/types";
import type { LegacySharedUI as SharedUI, BenchPermissions, HandApi } from "../lib/legacy-adapter";
import {
  evaluate,
  evalReq,
  brewTally,
  msToList,
  msFromList,
  msDiff,
  findRecipes,
  type FoundRecipe,
} from "../lib/engine";
import {
  ALL_FREQUENCIES,
  FUND,
  baseIngredients,
  perfumeWeight,
} from "../data/base";
import { FrequencySymbol, FrequencyGlyph, ChargeSymbol, COPPER, STRIKE } from "../lib/frequencies";
import FrequencyFilterButton, { isTypeFilter } from "./frequency-filter";
import IngredientThumb from "./ingredient-thumb";

export interface PerfumePanelProps {
  perfumes: Perfume[];
  // Current brew, for live per-perfume evaluation.
  brew: BrewState;
  // Shared browse UI: perfumeSearch, perfumeFilters, expanded, pins.
  ui: SharedUI;
  onUI: (patch: Partial<SharedUI>) => void;
  // Pins toggle only when editInventory (owner-only per WHERE-not-WHAT).
  permissions: BenchPermissions;
  // The cursor stack; recipe pills pick up from origin "catalog".
  hand: HandApi;
  // Hover preview for the brew bar (never the cauldron graph); null on leave.
  onHover: (itemKey: string | null) => void;
  // Copies of each catalog item in the brew — a pill's icon ghosts to 35%
  // while its ingredient has copies in the pot ("you took the icon").
  brewCounts: Record<string, number>;
  // Shift-click teleport: one copy straight to the brew (the grammar's
  // unambiguous destination for an input-side item; HandApi has no direct
  // path, so the client supplies it).
  onShiftToBrew: (itemKey: string) => void;
}

const STATUS_RANK: Record<string, number> = { perfect: 0, craftable: 1, off: 2 };

// Display order for frequencies inside a recipe row: fundamentals in canonical
// order, then named frequencies by complexity (ALL_FREQUENCIES is already sorted).
const FREQ_ORDER = new Map(ALL_FREQUENCIES.map((t, i) => [t.id, i]));
const ING_BY_NAME = new Map(baseIngredients.map((i) => [i.name, i]));

function groupFrequencies(req: string[]): { id: string; count: number }[] {
  const m = new Map<string, number>();
  for (const t of req) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => (FREQ_ORDER.get(a[0]) ?? 99) - (FREQ_ORDER.get(b[0]) ?? 99))
    .map(([id, count]) => ({ id, count }));
}

// Search by perfume name, common ingredient, or required frequency (frequency id
// or its school name).
function matchesQuery(r: Perfume, q: string): boolean {
  if (!q) return true;
  if (r.name.toLowerCase().includes(q)) return true;
  if (r.slots.some((slot) => slot.some((e) => e.name.toLowerCase().includes(q))))
    return true;
  return r.recipes.some((req) =>
    req.some(
      (id) =>
        id.toLowerCase().includes(q) ||
        (FUND[id]?.school ?? "").toLowerCase().includes(q),
    ),
  );
}

// ── integrated requirements ──────────────────────────────────────────────────
// One perfume, one display: the frequencies shared by every recipe (`core`)
// plus choice groups where recipes differ. A group is `optional` when one of
// its source alternatives contributes nothing extra (e.g. Amber vs Gold —
// Ignetium is optional on top of the shared T).

type ChoiceGroup = { options: string[][]; optional: boolean };
type Integrated = { core: string[]; groups: ChoiceGroup[] };

function canon(list: string[]): string {
  return [...list].sort().join("|");
}

function msIntersect(list: Multiset[]): Multiset {
  const out: Multiset = { ...list[0] };
  for (const m of list.slice(1)) {
    for (const k of Object.keys(out)) {
      const v = Math.min(out[k], m[k] || 0);
      if (v > 0) out[k] = v;
      else delete out[k];
    }
  }
  return out;
}

// Turn remainders into a choice group (deduped); an empty remainder means the
// remaining options are optional extras.
function toGroup(rems: string[][]): ChoiceGroup | null {
  const nonEmpty = rems.filter((r) => r.length > 0);
  const optional = nonEmpty.length < rems.length;
  const seen = new Set<string>();
  const options: string[][] = [];
  for (const r of nonEmpty) {
    const c = canon(r);
    if (!seen.has(c)) {
      seen.add(c);
      options.push(r);
    }
  }
  return options.length ? { options, optional } : null;
}

const INTEGRATED = new Map<string, Integrated>();

function integrateRecipe(perfume: Perfume): Integrated {
  const cached = INTEGRATED.get(perfume.key);
  if (cached) return cached;
  const result = computeIntegrated(perfume);
  INTEGRATED.set(perfume.key, result);
  return result;
}

function computeIntegrated(perfume: Perfume): Integrated {
  if (perfume.recipes.length === 1) return { core: perfume.recipes[0], groups: [] };

  // Preferred: factor by the common perfume's slots — each slot's alternatives
  // become one independent choice group. Only trusted when the cartesian
  // product of slot emissions reproduces the recipes exactly.
  const slotAlts: string[][][] = [];
  let ok = true;
  for (const slot of perfume.slots) {
    const alts: string[][] = [];
    const seen = new Set<string>();
    for (const e of slot) {
      if (!e.known) continue;
      const ing = ING_BY_NAME.get(e.name);
      if (!ing) continue;
      const emits: string[] = [];
      for (let i = 0; i < e.qty; i++) emits.push(...ing.emits);
      const c = canon(emits);
      if (!seen.has(c)) {
        seen.add(c);
        alts.push(emits);
      }
    }
    if (!alts.length) {
      ok = false;
      break;
    }
    slotAlts.push(alts);
  }
  if (ok) {
    const products: string[] = [];
    const build = (i: number, acc: string[]) => {
      if (i === slotAlts.length) {
        products.push(canon(acc));
        return;
      }
      for (const alt of slotAlts[i]) build(i + 1, [...acc, ...alt]);
    };
    build(0, []);
    const reqSet = new Set(perfume.recipes.map((r) => canon(r)));
    ok = products.every((p) => reqSet.has(p)) && new Set(products).size === reqSet.size;
  }
  if (ok) {
    const core: string[] = [];
    const groups: ChoiceGroup[] = [];
    for (const alts of slotAlts) {
      if (alts.length === 1) {
        core.push(...alts[0]);
        continue;
      }
      const msAlts = alts.map(msFromList);
      const inter = msIntersect(msAlts);
      core.push(...msToList(inter));
      const g = toGroup(msAlts.map((m) => msToList(msDiff(m, inter))));
      if (g) groups.push(g);
    }
    return { core, groups };
  }

  // Fallback: shared part of all recipes + one group of the leftovers.
  const msReqs = perfume.recipes.map(msFromList);
  const inter = msIntersect(msReqs);
  const g = toGroup(msReqs.map((m) => msToList(msDiff(m, inter))));
  return { core: msToList(inter), groups: g ? [g] : [] };
}

// ── the "recipes" fold ────────────────────────────────────────────────────────
// Per recipe, EVERY combo — the common d40 ones plus everything the solver
// finds — grouped by the strikes the perfumer must supply: tier 0 is
// self-sufficient, tiers 1 and 2 over-emit and need that many ⊖ from
// elsewhere. A common combo whose own ingredients carry the strikes it
// spends (Black Gas's liver) counts as tier 0. Cached — static inputs.

const MAX_STRIKES = 2;

// tiers[req index][strikes] -> combos needing exactly that many outside strikes
const RECIPES_CACHE = new Map<string, FoundRecipe[][][]>();

function recipesFor(perfume: Perfume): FoundRecipe[][][] {
  const cached = RECIPES_CACHE.get(perfume.key);
  if (cached) return cached;
  const result = perfume.recipes.map((_, ri) => {
    const tiers: FoundRecipe[][] = Array.from({ length: MAX_STRIKES + 1 }, () => []);
    const seen = new Set<string>();
    // the common d40 combos lead their tier
    for (const c of perfume.combos) {
      if (c.req !== ri) continue;
      const carried = c.ings.reduce(
        (s, n) => s + (ING_BY_NAME.get(n)?.strike ?? 0),
        0,
      );
      const ext = Math.max(0, c.strikes - carried);
      if (ext > MAX_STRIKES) continue;
      seen.add(canon(c.ings));
      tiers[ext].push({ ings: c.ings, strikes: c.strikes });
    }
    for (const c of findRecipes(perfume.recipes[ri], baseIngredients, MAX_STRIKES, 120)) {
      if (!seen.has(canon(c.ings))) tiers[c.strikes].push(c);
    }
    return tiers;
  });
  RECIPES_CACHE.set(perfume.key, result);
  return result;
}

export default function PerfumePanel({
  perfumes,
  brew,
  ui,
  onUI,
  permissions,
  hand,
  onHover,
  brewCounts,
  onShiftToBrew,
}: PerfumePanelProps) {
  // pinned perfumes float to the top; owner-only (WHERE-not-WHAT)
  const togglePin = (key: string) => {
    if (!permissions.editInventory) return;
    onUI({
      pins: ui.pins.includes(key)
        ? ui.pins.filter((k) => k !== key)
        : [...ui.pins, key],
    });
  };
  // recipes-fold state is shared browse UI — spectators see the same folds
  const toggleExpanded = (key: string) => {
    onUI({
      expanded: ui.expanded.includes(key)
        ? ui.expanded.filter((k) => k !== key)
        : [...ui.expanded, key],
    });
  };

  const evaluated = useMemo(
    () => perfumes.map((r) => ({ perfume: r, res: evaluate(brew, r) })),
    [perfumes, brew],
  );
  // "in reach" counts brewed perfumes too — they're trivially reachable
  const inReach = evaluated.filter((e) => e.res.status !== "off").length;
  // the brew's frequencies (after combination) — shown on every card while
  // something is brewing
  const brewList = useMemo(() => msToList(brewTally(brew)), [brew]);

  const shown = useMemo(() => {
    const q = ui.perfumeSearch.trim().toLowerCase();
    // types never apply to perfumes; strip them defensively — the filter list
    // is shared state another surface could have written
    const filters = ui.perfumeFilters.filter((v) => !isTypeFilter(v));
    return evaluated
      // pinned perfumes stay visible no matter the search or filter
      .filter(
        ({ perfume }) =>
          ui.pins.includes(perfume.key) ||
          (matchesQuery(perfume, q) &&
            // AND semantics: SOME recipe contains ALL selected frequencies
            perfume.recipes.some((req) => filters.every((id) => req.includes(id)))),
      )
      .sort((a, b) => {
        const p =
          (ui.pins.includes(b.perfume.key) ? 1 : 0) -
          (ui.pins.includes(a.perfume.key) ? 1 : 0);
        if (p !== 0) return p;
        const s = STATUS_RANK[a.res.status] - STATUS_RANK[b.res.status];
        if (s !== 0) return s;
        // lightest resonance first
        const w = perfumeWeight(a.perfume) - perfumeWeight(b.perfume);
        if (w !== 0) return w;
        return a.perfume.name.localeCompare(b.perfume.name);
      });
  }, [evaluated, ui.perfumeSearch, ui.perfumeFilters, ui.pins]);

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-surface">
      {/* header */}
      <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text-muted">Perfumes</h2>
        <span className="font-mono text-xs tabular-nums text-text-muted">
          <span className="text-accent">{inReach}</span>/{perfumes.length} in reach
        </span>
      </div>

      {/* controls: search with the multi-select frequency filter beside it */}
      <div className="border-b border-border p-3">
        <div className="flex items-stretch gap-2">
          <input
            value={ui.perfumeSearch}
            onChange={(e) => onUI({ perfumeSearch: e.target.value })}
            placeholder="search perfumes…"
            spellCheck={false}
            className="w-full min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
          />
          <FrequencyFilterButton
            values={ui.perfumeFilters}
            onChange={(values) => onUI({ perfumeFilters: values })}
          />
        </div>
      </div>

      {/* the book. data-pf-surface: presence coordinates are content-space of
          this scroll container, so spectators track cards, not pixels */}
      <div data-pf-surface="book" className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {shown.length === 0 && (
          <p className="px-2 py-6 text-center font-mono text-xs text-text-faint">
            no perfumes match
          </p>
        )}
        {shown.map(({ perfume, res }) => (
          <PerfumeCard
            key={perfume.key}
            perfume={perfume}
            res={res}
            brew={brew}
            brewList={brewList}
            brewEmpty={brew.ingredients.length === 0}
            pinned={ui.pins.includes(perfume.key)}
            canPin={permissions.editInventory}
            onTogglePin={togglePin}
            expanded={ui.expanded.includes(perfume.key)}
            onToggleExpanded={toggleExpanded}
            hand={hand}
            onHover={onHover}
            brewCounts={brewCounts}
            onShiftToBrew={onShiftToBrew}
          />
        ))}
      </div>
    </div>
  );
}

// A tiny cauldron silhouette — stands for "the current brew" in the card's
// brew + additions = perfume formula.
function MiniCauldron({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-label="the current brew"
      className="shrink-0 text-text-muted"
      fill="currentColor"
    >
      <ellipse cx="12" cy="8" rx="9" ry="2.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.4 9.2 C3.4 15.4 6.8 19 12 19 C17.2 19 20.6 15.4 20.6 9.2 C18.6 10.8 15.4 11.6 12 11.6 C8.6 11.6 5.4 10.8 3.4 9.2 Z" />
      <path d="M7.6 18.4 l-1.6 2.4 M16.4 18.4 l1.6 2.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

// Compact symbols-only row: multiplicity shows as REPEATED symbols, not ×n.
function FrequencyRow({ req, size = 16 }: { req: string[]; size?: number }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {groupFrequencies(req).flatMap(({ id, count }) =>
        Array.from({ length: count }, (_, i) => (
          <FrequencySymbol key={`${id}:${i}`} id={id} size={size} />
        )),
      )}
    </span>
  );
}

// A recipe-fold ingredient pill is a REAL grabbable item: the ingredient's
// icon + name, wired to the hand grammar — left-click picks up 1 (+1 per
// repeat), shift-click teleports 1 straight to the brew, right-click while
// holding returns 1 to origin, press-move starts a 1-unit drag (the hand's
// global tracking owns the boundary rule and the release), hover previews
// through onHover. The icon ghosts to 35% while copies are in the brew —
// "you took the icon". Hovering also shows the frequencies it contains.
// Lore-only names render as plain text.
function IngredientPill({
  entry,
  hand,
  onHover,
  brewCounts,
  onShiftToBrew,
}: {
  entry: PerfumeSlotEntry;
  hand: HandApi;
  onHover: (itemKey: string | null) => void;
  brewCounts: Record<string, number>;
  onShiftToBrew: (itemKey: string) => void;
}) {
  const ing = ING_BY_NAME.get(entry.name);
  const label = entry.qty > 1 ? `${entry.name} ×${entry.qty}` : entry.name;
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef({ x: 0, y: 0, active: false, moved: false });

  if (!entry.known || !ing) {
    return (
      <span
        className="cursor-help text-[11px] italic text-text-faint"
        title="Named in the lore, but absent from the Ingredients Table — the math uses the other option."
      >
        {label}
      </span>
    );
  }
  const inBrew = (brewCounts[ing.key] ?? 0) > 0;
  // the tip self-centers on the pill via translateX; clamp its anchor so it
  // can't spill past a (floored, for degenerate windows) viewport edge
  const vw = Math.max(typeof window !== "undefined" ? window.innerWidth : 1024, 360);
  const left = tip ? Math.min(Math.max(tip.x, 70), vw - 70) : 0;
  return (
    <button
      type="button"
      onClick={(e) => {
        // the click that ends a drag is not a pick-up
        if (drag.current.moved) {
          drag.current.moved = false;
          return;
        }
        if (e.shiftKey) onShiftToBrew(ing.key);
        // the catalog is an unbounded reference — stock runs out into
        // hypotheticals, so nothing caps the pick-up here
        else hand.pickUp(ing.key, "catalog", Number.POSITIVE_INFINITY);
      }}
      onContextMenu={(e) => {
        // right-click while holding: return 1 to origin (no-op empty-handed —
        // a reference pill is not an in-brew row)
        e.preventDefault();
        hand.returnOne();
      }}
      onMouseEnter={(e) => {
        onHover(ing.key);
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setTip({ x: r.left + r.width / 2, y: r.bottom });
      }}
      onMouseLeave={() => {
        onHover(null);
        setTip(null);
      }}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, y: e.clientY, active: true, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d.active || d.moved) return;
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 7) {
          // press-move: a 1-unit hand with the button held
          d.moved = true;
          hand.pickUp(ing.key, "catalog", Number.POSITIVE_INFINITY);
        }
      }}
      onPointerUp={() => {
        drag.current.active = false;
      }}
      title="Click to pick up — shift-click sends one straight to the brew"
      className="inline-flex touch-none items-center gap-1.5 rounded-full border border-border bg-bg py-0.5 pl-1 pr-2 text-xs text-text transition-colors duration-150 hover:border-accent hover:text-accent"
      style={{ borderLeftWidth: 3, borderLeftColor: ing.color }}
    >
      <span aria-hidden="true" style={{ lineHeight: 0, opacity: inBrew ? 0.35 : 1 }}>
        <IngredientThumb name={ing.name} source={ing.source} color={ing.color} size={22} />
      </span>
      {label}
      {tip &&
        typeof document !== "undefined" &&
        createPortal(
          <span
            className="pointer-events-none fixed z-[70] flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1.5 shadow-xl"
            style={{ left, top: tip.y + 6 }}
            role="tooltip"
          >
            {ing.emits.map((t, i) => (
              <FrequencyGlyph key={`${t}:${i}`} id={t} size={17} />
            ))}
            {Array.from({ length: ing.strike }, (_, i) => (
              <span key={`s${i}`} className="font-mono text-[12px]" style={{ color: STRIKE }}>
                ⊖
              </span>
            ))}
            {Array.from({ length: ing.wild }, (_, i) => (
              <span key={`w${i}`} className="font-mono text-[12px]" style={{ color: COPPER }}>
                ⊕
              </span>
            ))}
            {ing.emits.length === 0 && !ing.strike && !ing.wild && (
              <span className="font-mono text-[10px] text-text-faint">inert</span>
            )}
          </span>,
          document.body,
        )}
    </button>
  );
}

// What the brew still needs for this perfume, per reachable recipe: the
// missing frequencies as symbols plus one ⊖ chip per strike to spend,
// alternatives joined with "or".
function NeededOptions({
  perfume,
  brew,
  res,
  size,
}: {
  perfume: Perfume;
  brew: BrewState;
  res: EvalResult;
  size: number;
}) {
  // per-recipe needs, deduped; unreachable recipes drop out unless none reach
  const evs = perfume.recipes.map((req, ri) => evalReq(brew, req, ri));
  const reachable = evs.filter((e) => e.status === "craftable");
  const pool = reachable.length ? reachable : [res];
  const seen = new Set<string>();
  const options: EvalResult[] = [];
  for (const e of pool) {
    const key = canon(msToList(e.missing)) + "|" + e.exN;
    if (!seen.has(key)) {
      seen.add(key);
      options.push(e);
    }
  }
  return (
    <span
      className="flex min-w-0 flex-wrap items-center gap-1.5"
      title="what the brew still needs for this perfume"
    >
      {options.slice(0, 3).map((e, oi) => (
        <span key={oi} className="flex flex-wrap items-center gap-1">
          {oi > 0 && (
            <span className="font-mono text-[9px] uppercase text-text-faint">or</span>
          )}
          {groupFrequencies(msToList(e.missing)).flatMap(({ id, count }) =>
            Array.from({ length: count }, (_, i) => (
              <FrequencySymbol key={`${id}:${i}`} id={id} size={size} />
            )),
          )}
          {Array.from({ length: e.exN }, (_, i) => (
            <ChargeSymbol key={`s${i}`} kind="strike" size={size} />
          ))}
          {msToList(e.missing).length === 0 && e.exN === 0 && (
            <span className="font-mono text-[10px] text-accent">in reach</span>
          )}
        </span>
      ))}
    </span>
  );
}

// One dynamically-found combo as a row of grabbable ingredient pills.
function ComboRow({
  combo,
  hand,
  onHover,
  brewCounts,
  onShiftToBrew,
}: {
  combo: FoundRecipe;
  hand: HandApi;
  onHover: (itemKey: string | null) => void;
  brewCounts: Record<string, number>;
  onShiftToBrew: (itemKey: string) => void;
}) {
  const counts = new Map<string, number>();
  for (const n of combo.ings) counts.set(n, (counts.get(n) ?? 0) + 1);
  const entries = [...counts.entries()];
  return (
    <div className="flex flex-wrap items-center gap-1">
      {entries.map(([name, qty], i) => (
        <span key={name} className="flex items-center gap-1">
          {i > 0 && (
            <span className="px-0.5 font-mono text-[9px] uppercase text-text-faint">+</span>
          )}
          <IngredientPill
            entry={{ name, qty, known: true }}
            hand={hand}
            onHover={onHover}
            brewCounts={brewCounts}
            onShiftToBrew={onShiftToBrew}
          />
        </span>
      ))}
      {combo.strikes > 0 && (
        <span
          className="font-mono text-[10px]"
          style={{ color: STRIKE }}
          title={`spend ${combo.strikes} strike${combo.strikes > 1 ? "s" : ""} to remove the excess`}
        >
          · ⊖{combo.strikes}
        </span>
      )}
    </div>
  );
}

function PerfumeCard({
  perfume,
  res,
  brew,
  brewList,
  brewEmpty,
  pinned,
  canPin,
  onTogglePin,
  expanded,
  onToggleExpanded,
  hand,
  onHover,
  brewCounts,
  onShiftToBrew,
}: {
  perfume: Perfume;
  res: EvalResult;
  brew: BrewState;
  brewList: string[];
  brewEmpty: boolean;
  pinned: boolean;
  canPin: boolean;
  onTogglePin: (key: string) => void;
  expanded: boolean;
  onToggleExpanded: (key: string) => void;
  hand: HandApi;
  onHover: (itemKey: string | null) => void;
  brewCounts: Record<string, number>;
  onShiftToBrew: (itemKey: string) => void;
}) {
  const integ = integrateRecipe(perfume);
  const more = recipesFor(perfume);
  // strike tiers that actually have combos in some recipe, in reveal order
  const tiersWithCombos = Array.from({ length: MAX_STRIKES + 1 }, (_, t) => t).filter(
    (t) => more.some((tiers) => tiers[t].length > 0),
  );
  // strike tiers revealed so far (0 = only strike-free combos) — local, like
  // scroll: SharedUI only tracks which folds are open
  const [strikesShown, setStrikesShown] = useState(0);
  const nextTier = tiersWithCombos.find((t) => t > strikesShown);

  return (
    <article
      className={`relative rounded-lg border bg-bg/40 ${
        res.status === "perfect"
          ? "border-success/50 ring-1 ring-success/40"
          : res.status === "craftable"
            ? "border-accent/50"
            : "border-border"
      }`}
    >
      <button
        type="button"
        onClick={() => onTogglePin(perfume.key)}
        disabled={!canPin}
        aria-pressed={pinned}
        aria-label={pinned ? `Unpin ${perfume.name}` : `Pin ${perfume.name}`}
        title={!canPin ? "pins are owner-only" : pinned ? "Unpin" : "Pin to the top"}
        className={`absolute right-1 top-1 z-10 grid h-5 w-5 place-items-center rounded transition-colors duration-150 ${
          pinned
            ? "text-accent"
            : canPin
              ? "text-text-faint opacity-40 hover:opacity-100 hover:text-text-muted"
              : "text-text-faint opacity-25"
        }`}
      >
        <svg viewBox="0 0 16 16" width={13} height={13} fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
          <path d="M9.5 1.8 14.2 6.5 12.7 8l-.5-.2-2.7 2.7c.3 1.2 0 2.4-.8 3.2L5.4 10.4 2 13.8l-.9.3.3-.9 3.4-3.4-3.3-3.3c.8-.8 2-1.1 3.2-.8l2.7-2.7-.2-.5z" />
        </svg>
      </button>
      {/* one compact strip: name + weight (recipes button beneath), the
          required frequencies (symbols only, wrapping as needed), then the
          brew formula — 🫕 + box of what's still missing */}
      <div className="flex items-start gap-2.5 p-2.5">
        <div className="w-32 shrink-0">
          <h3 className="truncate text-sm font-semibold leading-tight text-text" title={perfume.name}>
            {perfume.name}
          </h3>
          <div
            className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-text-faint"
            title="total fundamental weight of the heaviest recipe"
          >
            w · {perfumeWeight(perfume)}
          </div>
          <button
            type="button"
            onClick={() => {
              onToggleExpanded(perfume.key);
              setStrikesShown(0);
            }}
            aria-expanded={expanded}
            className="mt-1 rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-muted transition-colors duration-150 hover:border-text-muted hover:text-text"
          >
            recipes {expanded ? "▴" : "▾"}
          </button>
        </div>

        {/* idle: the integrated requirement. Brewing: ONE unified line —
            the cauldron's frequencies + what's still needed (per-recipe
            options) — no separate needs box repeating anything. */}
        {brewEmpty ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 self-center">
            <FrequencyRow req={integ.core} size={22} />
            {integ.groups.map((g, gi) =>
              g.optional ? (
                <span
                  key={gi}
                  title="optional — either version brews the perfume"
                  className="flex flex-col items-center gap-0.5"
                >
                  <span className="flex items-center gap-1.5">
                    {g.options.map((opt, oi) => (
                      <span key={oi} className="flex items-center gap-1.5">
                        {oi > 0 && (
                          <span className="font-mono text-[9px] uppercase text-text-faint">or</span>
                        )}
                        <FrequencyRow req={opt} size={17} />
                      </span>
                    ))}
                  </span>
                  <span className="font-mono text-[8px] uppercase tracking-wider text-text-faint">
                    optional
                  </span>
                </span>
              ) : (
                <span key={gi} className="flex items-center gap-1.5">
                  <span className="font-mono text-sm text-text-faint">(</span>
                  {g.options.map((opt, oi) => (
                    <span key={oi} className="flex items-center gap-1.5">
                      {oi > 0 && (
                        <span className="font-mono text-[9px] uppercase text-text-faint">or</span>
                      )}
                      <FrequencyRow req={opt} size={22} />
                    </span>
                  ))}
                  <span className="font-mono text-sm text-text-faint">)</span>
                </span>
              ),
            )}
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 self-center">
            <MiniCauldron size={20} />
            <FrequencyRow req={brewList} size={22} />
            {res.status === "perfect" ? (
              <span className="inline-block rounded border border-success/40 bg-success/10 px-2 py-0.5 font-mono text-[11px] text-success">
                ✦ Brewed{res.k > 1 ? ` ×${res.k}` : ""}
              </span>
            ) : (
              <>
                <span
                  className={`font-mono text-sm ${
                    res.status === "craftable" ? "text-accent" : "text-text-faint"
                  }`}
                >
                  +
                </span>
                <NeededOptions perfume={perfume} brew={brew} res={res} size={22} />
              </>
            )}
          </div>
        )}
      </div>

      {/* what the perfume DOES — "unknown" until discovered in play */}
      <p className="px-2.5 pb-2 text-[11px] italic leading-snug text-text-muted">
        {perfume.effect}
      </p>

      {expanded && (
        <div className="space-y-2 border-t border-border/60 px-3 py-2.5">
          {tiersWithCombos.filter((t) => t <= strikesShown).length === 0 && (
            <p className="font-mono text-[10px] italic text-text-faint">
              no strike-free recipes
            </p>
          )}
          {Array.from({ length: strikesShown + 1 }, (_, t) => t)
            .filter((t) => tiersWithCombos.includes(t))
            .map((t) => (
              <div key={t} className="space-y-1.5">
                {t > 0 && (
                  <p className="font-mono text-[9px] uppercase tracking-wider" style={{ color: STRIKE }}>
                    ⊖ {t} strike{t > 1 ? "s" : ""} needed
                  </p>
                )}
                {perfume.recipes.map((req, ri) =>
                  more[ri][t].length === 0 ? null : (
                    <div key={ri} className="space-y-1">
                      {perfume.recipes.length > 1 && (
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[9px] uppercase text-text-faint">for</span>
                          <FrequencyRow req={req} size={13} />
                        </div>
                      )}
                      <div className="space-y-1">
                        {more[ri][t].slice(0, 30).map((combo, ci) => (
                          <ComboRow
                            key={ci}
                            combo={combo}
                            hand={hand}
                            onHover={onHover}
                            brewCounts={brewCounts}
                            onShiftToBrew={onShiftToBrew}
                          />
                        ))}
                        {more[ri][t].length > 30 && (
                          <p className="font-mono text-[10px] italic text-text-faint">…and more</p>
                        )}
                      </div>
                    </div>
                  ),
                )}
              </div>
            ))}
          {nextTier !== undefined && (
            <button
              type="button"
              onClick={() => setStrikesShown(nextTier)}
              className="rounded-md border border-dashed px-2 py-0.5 font-mono text-[10px] transition-colors duration-150 hover:border-solid"
              style={{ borderColor: `${STRIKE}88`, color: STRIKE }}
            >
              show combos needing ⊖ {nextTier} strike{nextTier > 1 ? "s" : ""} ▾
            </button>
          )}
        </div>
      )}
    </article>
  );
}
