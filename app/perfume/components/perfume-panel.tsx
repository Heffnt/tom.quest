"use client";

// The perfume book — the right drawer (DESIGN.md §6). A searchable list of the
// d40 perfumes, DECLUTTERED to one clear row hierarchy:
//
//   resting row   [pin] Name … {frequency requirement} … [✓?] [▸]
//   on expand     have-vs-need (while brewing) + effect + recipe folds
//
// The resting row carries only the name and the frequency requirement, with a
// small arrow on the right that opens the recipe folds. There is NO weight and
// NO in-reach / out-of-reach reachability — the one remaining status is the
// green "✓" chip that appears when the current brew SATISFIES a recipe. Search,
// the frequency filter, the single-brew PIN (DESIGN.md §5), and the recipe folds
// all survive; the surface uses the shell's shared button treatment
// (components/ui.tsx) so the book reads as one family with the input panel.
//
// WHICH RECIPE (DESIGN.md §Recipe): when the open brew's tally satisfies one or
// more of a perfume's recipes, the row shows a satisfied chip naming the recipe
// ("common recipe ✓ ×2") and the matching recipe row inside the fold lights up.
// The naming comes from lib/recipe-label, the SAME helper the stage uses, so the
// two surfaces agree word-for-word.
//
// RECIPE FOLDS AS SOURCES (DESIGN.md §1, §Interactions): each combo's
// ingredients render as small ItemFrames in the "recipe" context — hypothetical
// drag sources wired to the hand grammar, exactly like the input panel's catalog
// cards. Left-click picks up one (again for +1), shift-click sends one to the
// brew, right-click while holding returns one; the icon ghosts while copies sit
// in the brew ("you took the icon").
//
// PURE REFERENCE — brewed output lives on the cauldron, never here.

import { useMemo, useState } from "react";
import type { Multiset, Perfume, BrewState } from "../lib/types";
import type { SharedUI, PinnedRecipe } from "../lib/brew-types";
import type { BrewHand } from "../lib/use-hand";
import {
  evalReq,
  brewTally,
  msToList,
  msFromList,
  msDiff,
  findRecipes,
  type FoundRecipe,
} from "../lib/engine";
import { ALL_FREQUENCIES, FUND, baseIngredients } from "../data/base";
import { FrequencySymbol, STRIKE } from "../lib/frequencies";
import { recipeLabel } from "../lib/recipe-label";
import FrequencyFilterButton, { isTypeFilter } from "./frequency-filter";
import ItemFrame, { type FrameItem } from "./item-frame";
import { grabHandlers } from "./inventory-grid";
import { btn, cn } from "./ui";

export interface PerfumePanelProps {
  perfumes: Perfume[];
  // Current brew, for live per-perfume evaluation.
  brew: BrewState;
  // Shared browse UI: perfumeSearch, perfumeFilters, expanded.
  ui: SharedUI;
  onUI: (patch: Partial<SharedUI>) => void;
  // The brew's single pinned recipe (DESIGN.md §5), and the setter. `canPin`
  // is any registered member (the pin lives on the brew object). A visitor
  // (not a member) sees the pin state read-only.
  pinned: PinnedRecipe;
  onPin: (pinned: PinnedRecipe) => void;
  canPin: boolean;
  // The cursor stack; recipe-fold frames pick up hypotheticals from the catalog
  // (an unbounded reference source). A read-only visitor's hand can't move
  // items (canMove false) — the frames stay inert affordances.
  hand: BrewHand;
  // WHERE-move permission (DESIGN.md §4). False for a visitor / another
  // member's brew where the book is browse-only — the fold frames don't grab.
  canMove: boolean;
  // Hover preview for the brew bar (never the cauldron graph); null on leave.
  onHover: (itemKey: string | null) => void;
  // Copies of each catalog item in the brew — a fold frame's icon ghosts while
  // its ingredient has copies in the brew ("you took the icon").
  brewCounts: Record<string, number>;
  // Shift-click teleport: one copy straight to the brew (the grammar's
  // unambiguous destination for an input-side item).
  onShiftToBrew: (itemKey: string) => void;
}

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

// Which recipes the current brew's tally SATISFIES, and at what k. Per recipe
// index, evalReq reports "perfect" with its copy-count when the brew equals k×
// that recipe (DESIGN.md §Recipe / §Rules k-multiples). Empty for an empty or
// unsatisfied brew.
function satisfiedRecipes(brew: BrewState, perfume: Perfume): Map<number, number> {
  const out = new Map<number, number>();
  if (brew.ingredients.length === 0) return out;
  perfume.recipes.forEach((req, ri) => {
    const e = evalReq(brew, req, ri);
    if (e.status === "perfect") out.set(ri, e.k);
  });
  return out;
}

export default function PerfumePanel({
  perfumes,
  brew,
  ui,
  onUI,
  pinned,
  onPin,
  canPin,
  hand,
  canMove,
  onHover,
  brewCounts,
  onShiftToBrew,
}: PerfumePanelProps) {
  // exactly one recipe pins to the brew (DESIGN.md §5). Toggling a perfume pins
  // its common recipe (index 0), or clears the pin if it was already pinned.
  const pinnedKey = pinned?.perfumeId ?? null;
  const togglePin = (key: string) => {
    if (!canPin) return;
    onPin(pinnedKey === key ? null : { perfumeId: key, recipeIndex: 0 });
  };
  // recipes-fold state is shared browse UI — spectators see the same folds
  const toggleExpanded = (key: string) => {
    onUI({
      expanded: ui.expanded.includes(key)
        ? ui.expanded.filter((k) => k !== key)
        : [...ui.expanded, key],
    });
  };

  const brewEmpty = brew.ingredients.length === 0;
  const evaluated = useMemo(
    () =>
      perfumes.map((perfume) => ({
        perfume,
        // per-recipe satisfaction (which recipe ✓, and k) — DESIGN.md §Recipe
        satisfied: satisfiedRecipes(brew, perfume),
      })),
    [perfumes, brew],
  );
  // the brew's frequencies (after combination) — the requirement summary
  // overlays "have vs need" once something is brewing
  const brewTallyList = useMemo(() => msToList(brewTally(brew)), [brew]);

  const shown = useMemo(() => {
    const q = ui.perfumeSearch.trim().toLowerCase();
    // types never apply to perfumes; strip them defensively — the filter list
    // is shared state another surface could have written
    const filters = ui.perfumeFilters.filter((v) => !isTypeFilter(v));
    return evaluated
      // pinned perfumes stay visible no matter the search or filter
      .filter(
        ({ perfume }) =>
          pinnedKey === perfume.key ||
          (matchesQuery(perfume, q) &&
            // AND semantics: SOME recipe contains ALL selected frequencies
            perfume.recipes.some((req) => filters.every((id) => req.includes(id)))),
      )
      .sort((a, b) => {
        const p =
          (pinnedKey === b.perfume.key ? 1 : 0) -
          (pinnedKey === a.perfume.key ? 1 : 0);
        if (p !== 0) return p;
        // perfumes the current brew satisfies float to the top
        const s =
          (b.satisfied.size > 0 ? 1 : 0) - (a.satisfied.size > 0 ? 1 : 0);
        if (s !== 0) return s;
        return a.perfume.name.localeCompare(b.perfume.name);
      });
  }, [evaluated, ui.perfumeSearch, ui.perfumeFilters, pinnedKey]);

  const hasFilter = ui.perfumeSearch.trim() !== "" || ui.perfumeFilters.length > 0;

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-surface">
      {/* header — same treatment as the input panel's section headers */}
      <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text-muted">Perfumes</h2>
        <span className="font-mono text-xs tabular-nums text-text-faint">
          {shown.length === perfumes.length
            ? `${perfumes.length} perfumes`
            : `${shown.length}/${perfumes.length}`}
        </span>
      </div>

      {/* controls: search with the multi-select frequency filter beside it —
          identical layout to the input panel's search row (one family) */}
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
      <div data-pf-surface="book" className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {shown.length === 0 ? (
          <EmptyHits filtered={hasFilter} onClear={() => onUI({ perfumeSearch: "", perfumeFilters: [] })} />
        ) : (
          shown.map(({ perfume, satisfied }) => (
            <PerfumeRow
              key={perfume.key}
              perfume={perfume}
              satisfied={satisfied}
              brewEmpty={brewEmpty}
              brewTallyList={brewTallyList}
              pinned={pinnedKey === perfume.key}
              canPin={canPin}
              onTogglePin={togglePin}
              expanded={ui.expanded.includes(perfume.key)}
              onToggleExpanded={toggleExpanded}
              hand={hand}
              canMove={canMove}
              onHover={onHover}
              brewCounts={brewCounts}
              onShiftToBrew={onShiftToBrew}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── the empty / no-hits state (DESIGN.md §6 edge states) ─────────────────────
function EmptyHits({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 px-2 py-8 text-center">
      <p className="font-mono text-xs text-text-faint">no perfumes match</p>
      {filtered && (
        <button type="button" onClick={onClear} className={cn(btn.outline, "text-[11px]")}>
          clear search &amp; filters
        </button>
      )}
    </div>
  );
}

// ── the requirement summary (symbols; shown only on expand) ──────────────────
// Compact symbols-only row: multiplicity shows as REPEATED symbols, not ×n.
function FrequencyRow({ req, size = 20 }: { req: string[]; size?: number }) {
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

// The integrated requirement (core + choice groups). Shown on the resting row
// (compact) and again, larger, inside the fold's have-vs-need view.
function IntegratedRequirement({ integ, size = 20 }: { integ: Integrated; size?: number }) {
  const small = Math.max(12, Math.round(size * 0.8));
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <FrequencyRow req={integ.core} size={size} />
      {integ.groups.map((g, gi) =>
        g.optional ? (
          <span key={gi} title="optional — either version brews the perfume" className="flex flex-col items-center gap-0.5">
            <span className="flex items-center gap-1.5">
              {g.options.map((opt, oi) => (
                <span key={oi} className="flex items-center gap-1.5">
                  {oi > 0 && <span className="font-mono text-[9px] uppercase text-text-faint">or</span>}
                  <FrequencyRow req={opt} size={small} />
                </span>
              ))}
            </span>
            <span className="font-mono text-[8px] uppercase tracking-wider text-text-faint">optional</span>
          </span>
        ) : (
          <span key={gi} className="flex items-center gap-1.5">
            <span className="font-mono text-sm text-text-faint">(</span>
            {g.options.map((opt, oi) => (
              <span key={oi} className="flex items-center gap-1.5">
                {oi > 0 && <span className="font-mono text-[9px] uppercase text-text-faint">or</span>}
                <FrequencyRow req={opt} size={size} />
              </span>
            ))}
            <span className="font-mono text-sm text-text-faint">)</span>
          </span>
        ),
      )}
    </div>
  );
}

// ── the satisfied chip (DESIGN.md §Recipe "which recipe satisfied") ──────────
// One chip on the resting row's right edge, only when the current brew SATISFIES
// a recipe. It names which one ("common recipe ✓ ×2"), sharing lib/recipe-label
// with the stage. There is no "in reach / out of reach" reachability status.
function SatisfiedChip({
  perfume,
  satisfied,
}: {
  perfume: Perfume;
  satisfied: Map<number, number>;
}) {
  // the lowest satisfied recipe index leads (common recipe first)
  const ri = Math.min(...satisfied.keys());
  const k = satisfied.get(ri)!;
  const which = recipeLabel(perfume.key, ri);
  return (
    <span
      className="shrink-0 whitespace-nowrap rounded-full border border-success/40 bg-success/10 px-2 py-0.5 font-mono text-[10px] text-success"
      title="this brew satisfies this recipe"
    >
      {which ? `${which} ✓` : "brewed ✓"}
      {k > 1 ? ` ×${k}` : ""}
    </span>
  );
}

// The small expand arrow on the row's right edge — points right when closed
// ("opens the recipes"), rotates down when open.
function ExpandArrow({
  expanded,
  name,
  onClick,
}: {
  expanded: boolean;
  name: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      aria-label={expanded ? `Collapse ${name}` : `Expand ${name}`}
      title={expanded ? "Hide recipes" : "Show recipes"}
      className={cn(btn.ghost, "h-6 w-6 shrink-0 px-0 text-text-faint")}
    >
      <svg
        viewBox="0 0 16 16"
        width={12}
        height={12}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={cn("transition-transform duration-150", expanded && "rotate-90")}
      >
        <path d="M6 4l4 4-4 4" />
      </svg>
    </button>
  );
}

// ── a recipe-fold ingredient FRAME (DESIGN.md §1, §Interactions) ─────────────
// The recipe fold's ingredient combo renders as small item FRAMES in the
// "recipe" context — hypothetical sources, exactly like the catalog cards in the
// input panel. The hand ORIGIN is "catalog" (an unbounded reference; recipe and
// catalog frames both mint hypotheticals — see item-frame.frameMintsReal), so
// picking up beyond stock keeps the item hypothetical in the brew. Lore-only
// ingredients (named but absent from the table) render as plain italic text.
function RecipeItemFrame({
  name,
  qty,
  hand,
  canMove,
  onHover,
  brewCounts,
  onShiftToBrew,
}: {
  name: string;
  qty: number;
  hand: BrewHand;
  canMove: boolean;
  onHover: (itemKey: string | null) => void;
  brewCounts: Record<string, number>;
  onShiftToBrew: (itemKey: string) => void;
}) {
  const ing = ING_BY_NAME.get(name);
  if (!ing) {
    return (
      <span
        className="cursor-help self-center text-[11px] italic text-text-faint"
        title="Named in the lore, but absent from the Ingredients Table — the math uses the other option."
      >
        {name}
        {qty > 1 ? ` ×${qty}` : ""}
      </span>
    );
  }
  const inBrew = brewCounts[ing.key] ?? 0;
  const g = grabHandlers({
    itemKey: ing.key,
    from: "catalog",
    // the recipe fold is a boundless reference source, like the catalog grid
    available: Number.POSITIVE_INFINITY,
    inBrew,
    hand,
    canMove,
    onHover,
    onShiftToBrew,
  });
  const art: FrameItem = { key: ing.key, name: ing.name, color: ing.color, real: false, ing };
  return (
    <ItemFrame
      context="recipe"
      item={art}
      size={30}
      showMarks
      name={ing.name}
      ghosted={inBrew > 0}
      handlers={canMove ? g : undefined}
      label={`Pick up ${ing.name}`}
      title={
        canMove
          ? `${ing.name}${qty > 1 ? ` ×${qty}` : ""} — click to pick up; shift-click sends one to the brew`
          : `${ing.name}${qty > 1 ? ` ×${qty}` : ""}`
      }
      disabled={!canMove}
      data-testid="recipe-frame"
    >
      {qty > 1 && (
        <span className="pointer-events-none absolute -left-1 -top-1 rounded bg-surface/95 px-1 font-mono text-[9px] font-bold leading-4 tabular-nums text-text-muted">
          ×{qty}
        </span>
      )}
    </ItemFrame>
  );
}

// One combo as a row of grabbable recipe frames + the outside-strike marker.
function ComboRow({
  ings,
  strikes,
  hand,
  canMove,
  onHover,
  brewCounts,
  onShiftToBrew,
}: {
  ings: string[];
  strikes: number;
  hand: BrewHand;
  canMove: boolean;
  onHover: (itemKey: string | null) => void;
  brewCounts: Record<string, number>;
  onShiftToBrew: (itemKey: string) => void;
}) {
  const counts = new Map<string, number>();
  for (const n of ings) counts.set(n, (counts.get(n) ?? 0) + 1);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {[...counts.entries()].map(([name, qty]) => (
        <RecipeItemFrame
          key={name}
          name={name}
          qty={qty}
          hand={hand}
          canMove={canMove}
          onHover={onHover}
          brewCounts={brewCounts}
          onShiftToBrew={onShiftToBrew}
        />
      ))}
      {strikes > 0 && (
        <span
          className="self-center font-mono text-[10px]"
          style={{ color: STRIKE }}
          title={`spend ${strikes} strike${strikes > 1 ? "s" : ""} to remove the excess`}
        >
          · ⊖{strikes}
        </span>
      )}
    </div>
  );
}

// ── one perfume row ───────────────────────────────────────────────────────────

function PerfumeRow({
  perfume,
  satisfied,
  brewEmpty,
  brewTallyList,
  pinned,
  canPin,
  onTogglePin,
  expanded,
  onToggleExpanded,
  hand,
  canMove,
  onHover,
  brewCounts,
  onShiftToBrew,
}: {
  perfume: Perfume;
  satisfied: Map<number, number>;
  brewEmpty: boolean;
  brewTallyList: string[];
  pinned: boolean;
  canPin: boolean;
  onTogglePin: (key: string) => void;
  expanded: boolean;
  onToggleExpanded: (key: string) => void;
  hand: BrewHand;
  canMove: boolean;
  onHover: (itemKey: string | null) => void;
  brewCounts: Record<string, number>;
  onShiftToBrew: (itemKey: string) => void;
}) {
  const integ = integrateRecipe(perfume);
  const more = recipesFor(perfume);
  const tiersWithCombos = Array.from({ length: MAX_STRIKES + 1 }, (_, t) => t).filter(
    (t) => more.some((tiers) => tiers[t].length > 0),
  );
  // strike tiers revealed so far (0 = only strike-free combos) — local, like
  // scroll: SharedUI only tracks which folds are open
  const [strikesShown, setStrikesShown] = useState(0);
  const nextTier = tiersWithCombos.find((t) => t > strikesShown);

  // one calm left accent bar — success only when the brew satisfies a recipe;
  // there is no craftable/reachability state any more.
  const accent = satisfied.size > 0 ? "var(--color-success)" : "transparent";

  return (
    <article className="overflow-hidden rounded-lg border border-border bg-bg/40">
      {/* resting row: [pin] name · requirement ……… [✓?] [▸] */}
      <div
        className="flex items-center gap-2 px-2.5 py-2"
        style={{ boxShadow: `inset 3px 0 0 ${accent}` }}
      >
        <PinButton perfume={perfume} pinned={pinned} canPin={canPin} onToggle={onTogglePin} />
        <h3 className="min-w-0 shrink truncate text-sm font-semibold leading-tight text-text" title={perfume.name}>
          {perfume.name}
        </h3>
        {/* the frequency requirement, compact, on the resting row itself */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1">
          <IntegratedRequirement integ={integ} size={14} />
        </div>
        {!brewEmpty && satisfied.size > 0 && (
          <SatisfiedChip perfume={perfume} satisfied={satisfied} />
        )}
        <ExpandArrow
          expanded={expanded}
          name={perfume.name}
          onClick={() => {
            onToggleExpanded(perfume.key);
            setStrikesShown(0);
          }}
        />
      </div>

      {expanded && (
        <div className="space-y-2.5 border-t border-border/60 px-3 py-2.5">
          {/* while brewing, show the brew's own tally against the requirement so
              "have vs need" reads at a glance (the requirement itself is on the
              resting row). */}
          {!brewEmpty && brewTallyList.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-[9px] uppercase tracking-wider text-text-faint">requires</span>
                <IntegratedRequirement integ={integ} />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="font-mono text-[9px] uppercase tracking-wider text-text-faint">brew has</span>
                <FrequencyRow req={brewTallyList} size={18} />
              </div>
            </div>
          )}

          {/* what the perfume DOES — "unknown" until discovered in play */}
          <p className="text-[11px] italic leading-snug text-text-muted">{perfume.effect}</p>

          {/* the recipe combos, grabbable as recipe frames (DESIGN.md §1) */}
          <RecipeFolds
            perfume={perfume}
            more={more}
            tiersWithCombos={tiersWithCombos}
            strikesShown={strikesShown}
            nextTier={nextTier}
            onRevealTier={setStrikesShown}
            satisfied={satisfied}
            hand={hand}
            canMove={canMove}
            onHover={onHover}
            brewCounts={brewCounts}
            onShiftToBrew={onShiftToBrew}
          />
        </div>
      )}
    </article>
  );
}

// The pin — a single recipe pinned to the brew (DESIGN.md §5). Read-only for a
// visitor (canPin false): dimmed, non-interactive, but the pinned state still
// shows so everyone viewing the brew sees the same pin.
function PinButton({
  perfume,
  pinned,
  canPin,
  onToggle,
}: {
  perfume: Perfume;
  pinned: boolean;
  canPin: boolean;
  onToggle: (key: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(perfume.key)}
      disabled={!canPin}
      aria-pressed={pinned}
      aria-label={pinned ? `Unpin ${perfume.name}` : `Pin ${perfume.name}`}
      title={!canPin ? "join to pin a recipe" : pinned ? "Unpin" : "Pin this recipe to the brew"}
      className={cn(
        "grid h-5 w-5 shrink-0 place-items-center rounded transition-colors duration-150",
        pinned
          ? "text-accent"
          : canPin
            ? "text-text-faint opacity-40 hover:text-text-muted hover:opacity-100"
            : "text-text-faint opacity-25",
      )}
    >
      <svg viewBox="0 0 16 16" width={13} height={13} fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
        <path d="M9.5 1.8 14.2 6.5 12.7 8l-.5-.2-2.7 2.7c.3 1.2 0 2.4-.8 3.2L5.4 10.4 2 13.8l-.9.3.3-.9 3.4-3.4-3.3-3.3c.8-.8 2-1.1 3.2-.8l2.7-2.7-.2-.5z" />
      </svg>
    </button>
  );
}

// ── the recipe folds ──────────────────────────────────────────────────────────
// Combos grouped by outside-strike tier, revealed progressively. The recipe row
// whose recipe the brew currently satisfies is HIGHLIGHTED (DESIGN.md §Recipe),
// naming it with the shared recipe-label phrasing.
function RecipeFolds({
  perfume,
  more,
  tiersWithCombos,
  strikesShown,
  nextTier,
  onRevealTier,
  satisfied,
  hand,
  canMove,
  onHover,
  brewCounts,
  onShiftToBrew,
}: {
  perfume: Perfume;
  more: FoundRecipe[][][];
  tiersWithCombos: number[];
  strikesShown: number;
  nextTier: number | undefined;
  onRevealTier: (t: number) => void;
  satisfied: Map<number, number>;
  hand: BrewHand;
  canMove: boolean;
  onHover: (itemKey: string | null) => void;
  brewCounts: Record<string, number>;
  onShiftToBrew: (itemKey: string) => void;
}) {
  const multiRecipe = perfume.recipes.length > 1;
  return (
    <div className="space-y-2">
      {tiersWithCombos.filter((t) => t <= strikesShown).length === 0 && (
        <p className="font-mono text-[10px] italic text-text-faint">no strike-free recipes</p>
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
                <div
                  key={ri}
                  className={cn(
                    "space-y-1 rounded-md",
                    satisfied.has(ri) && "-mx-1 border border-success/40 bg-success/5 px-1 py-1",
                  )}
                >
                  {(multiRecipe || satisfied.has(ri)) && (
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[9px] uppercase text-text-faint">for</span>
                      <FrequencyRow req={req} size={13} />
                      {satisfied.has(ri) && (
                        <span
                          className="ml-auto whitespace-nowrap rounded-full bg-success/15 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-success"
                          title="the brew satisfies this recipe"
                        >
                          {recipeLabel(perfume.key, ri) ?? "satisfied"} ✓
                          {satisfied.get(ri)! > 1 ? ` ×${satisfied.get(ri)!}` : ""}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="space-y-1.5">
                    {more[ri][t].slice(0, 30).map((combo, ci) => (
                      <ComboRow
                        key={ci}
                        ings={combo.ings}
                        strikes={combo.strikes}
                        hand={hand}
                        canMove={canMove}
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
          onClick={() => onRevealTier(nextTier)}
          className="rounded-md border border-dashed px-2 py-0.5 font-mono text-[10px] transition-colors duration-150 hover:border-solid"
          style={{ borderColor: `${STRIKE}88`, color: STRIKE }}
        >
          show combos needing ⊖ {nextTier} strike{nextTier > 1 ? "s" : ""} ▾
        </button>
      )}
    </div>
  );
}
