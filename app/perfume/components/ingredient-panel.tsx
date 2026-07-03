"use client";

// The ingredients panel, in two tabs: the 96 base ingredients and the pure
// frequencies. Search matches names or any emitted frequency (id or school
// name — e.g. "transmutation" finds every T-emitter); the square button by
// the search filters by frequency (its icon shows the active filter). Rows
// in the brew are ringed amber and carry −/count/+ controls; clicking the
// row body adds one when absent, or removes every copy when present.
// Hovering a row previews it in the cauldron; dragging a row toward the
// cauldron carries it there.

import { useMemo, useRef, useState } from "react";
import type { Ingredient } from "../lib/types";
import type { IngredientPanelProps } from "./contracts";
import { FUND, isNamed, isPureKey, ingredientWeight } from "../data/base";
import FrequencyFilterButton, { freqLabel } from "./frequency-filter";
import { FrequencyGlyph, FrequencySymbol, STRIKE, COPPER } from "../lib/frequencies";
import IngredientThumb from "./ingredient-thumb";


// Frequencies-tab order: pure strike/wild first, then the fundamentals, then
// the named frequencies — alphabetical within each category.
function pureRank(ing: Ingredient): number {
  if (ing.strike > 0 || ing.wild > 0) return 0;
  return isNamed(ing.key.slice(5)) ? 2 : 1;
}

// Ingredients-tab order: emitters lightest-first; the ⊖/⊕ charge carriers
// sort to the very end.
function ingredientRank(ing: Ingredient): number {
  return ing.strike > 0 || ing.wild > 0 ? 1 : 0;
}

// "Pure A" -> "A — Abjuration", "Pure Ignetium" -> "Ignetium",
// "Pure Strike" -> "Strike"
function pureName(ing: Ingredient): string {
  const id = ing.key.slice(5);
  if (id === "strike") return "Strike";
  if (id === "wild") return "Wild";
  return freqLabel(id);
}

type Tab = "ingredients" | "frequencies";

export default function IngredientPanel({
  ingredients,
  brewCounts,
  onAdd,
  onDec,
  onRemoveAll,
  onPreview,
  onBeginDrag,
}: IngredientPanelProps) {
  const [tab, setTab] = useState<Tab>("ingredients");
  const [search, setSearch] = useState("");
  const [freqFilter, setFreqFilter] = useState<string>("");

  const tabItems = useMemo(
    () => ingredients.filter((i) => (tab === "frequencies") === isPureKey(i.key)),
    [ingredients, tab],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    // the frequency filter only applies (and only shows) on the ingredients tab
    return tabItems
      .filter((ing) => {
        if (tab !== "ingredients" || !freqFilter) return true;
        if (freqFilter === "strike") return ing.strike > 0;
        if (freqFilter === "wild") return ing.wild > 0;
        return ing.emits.includes(freqFilter);
      })
      .filter((ing) => {
        if (!q) return true;
        if (ing.name.toLowerCase().includes(q)) return true;
        // by emitted frequency: id ("En") or school name ("transmutation")
        if (ing.emits.some((t) => t.toLowerCase().includes(q))) return true;
        if (ing.emits.some((t) => (FUND[t]?.school ?? "").toLowerCase().includes(q))) return true;
        return false;
      })
      .sort((a, b) =>
        tab === "frequencies"
          ? pureRank(a) - pureRank(b) || a.name.localeCompare(b.name)
          : ingredientRank(a) - ingredientRank(b) ||
            ingredientWeight(a) - ingredientWeight(b) ||
            a.name.localeCompare(b.name),
      );
  }, [tab, tabItems, freqFilter, search]);

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-surface">
      {/* header + tabs */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-1">
          {(["ingredients", "frequencies"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={`rounded-md px-2.5 py-1.5 text-sm font-semibold transition-colors duration-150 ${
                tab === t
                  ? "bg-surface-alt text-text"
                  : "text-text-faint hover:text-text-muted"
              }`}
            >
              {t === "ingredients" ? "Ingredients" : "Frequencies"}
            </button>
          ))}
        </div>
        <span className="font-mono text-xs tabular-nums text-text-faint">
          {filtered.length}/{tabItems.length}
        </span>
      </div>

      {/* controls: search with the square frequency-filter button beside it */}
      <div className="border-b border-border p-3">
        <div className="flex items-stretch gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search ingredients or frequencies…"
            spellCheck={false}
            className="w-full min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
          />
          {tab === "ingredients" && (
            <FrequencyFilterButton value={freqFilter} onChange={setFreqFilter} includeCharges />
          )}
        </div>
      </div>

      {/* list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-center font-mono text-xs text-text-faint">
            {tab === "ingredients" ? "no ingredients match" : "no frequencies match"}
          </p>
        ) : (
          <ul className="divide-y divide-border/50">
            {filtered.map((ing) =>
              tab === "frequencies" ? (
                <FrequencyRow
                  key={ing.key}
                  ing={ing}
                  count={brewCounts[ing.key] ?? 0}
                  onAdd={onAdd}
                  onDec={onDec}
                  onRemoveAll={onRemoveAll}
                  onPreview={onPreview}
                  onBeginDrag={onBeginDrag}
                />
              ) : (
                <IngredientRow
                  key={ing.key}
                  ing={ing}
                  count={brewCounts[ing.key] ?? 0}
                  onAdd={onAdd}
                  onDec={onDec}
                  onRemoveAll={onRemoveAll}
                  onPreview={onPreview}
                  onBeginDrag={onBeginDrag}
                />
              ),
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

// Shared hover-preview + drag-out behavior for a row body. Click keeps its
// add/remove semantics; moving >7px turns the press into a drag handled by
// the client (window-level listeners), and the click that follows a drag is
// swallowed.
function useRowGestures(
  key: string,
  onPreview?: (key: string | null) => void,
  onBeginDrag?: (key: string, x: number, y: number) => void,
) {
  const drag = useRef({ x: 0, y: 0, active: false, moved: false });
  return {
    onMouseEnter: () => onPreview?.(key),
    onMouseLeave: () => onPreview?.(null),
    onPointerDown: (e: React.PointerEvent) => {
      drag.current = { x: e.clientX, y: e.clientY, active: true, moved: false };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d.active || d.moved) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 7) {
        d.moved = true;
        onBeginDrag?.(key, e.clientX, e.clientY);
      }
    },
    onPointerUp: () => {
      drag.current.active = false;
    },
    // true -> this click ended a drag; the caller should ignore it
    consumeDragClick: () => {
      if (drag.current.moved) {
        drag.current.moved = false;
        return true;
      }
      return false;
    },
  };
}

// The −/count/+ cluster, bold enough to read at a glance.
function CountControls({
  ing,
  count,
  onAdd,
  onDec,
}: {
  ing: Ingredient;
  count: number;
  onAdd: (key: string) => void;
  onDec: (key: string) => void;
}) {
  const inBrew = count > 0;
  return (
    <span className="flex shrink-0 items-center gap-1 self-center font-mono">
      <button
        type="button"
        onClick={() => onDec(ing.key)}
        disabled={!inBrew}
        aria-label={`Remove one ${ing.name}`}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border-2 border-border text-base font-bold text-text transition-colors duration-150 hover:border-accent hover:text-accent disabled:opacity-30 disabled:hover:border-border disabled:hover:text-text"
      >
        −
      </button>
      <span
        className={`w-5 text-center text-sm font-bold tabular-nums ${
          inBrew ? "text-amber-400" : "text-text-muted"
        }`}
      >
        {count}
      </span>
      <button
        type="button"
        onClick={() => onAdd(ing.key)}
        aria-label={`Add one ${ing.name}`}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border-2 border-border text-base font-bold text-text transition-colors duration-150 hover:border-accent hover:text-accent"
      >
        +
      </button>
    </span>
  );
}

type RowProps = {
  ing: Ingredient;
  count: number;
  onAdd: (key: string) => void;
  onDec: (key: string) => void;
  onRemoveAll: (key: string) => void;
  onPreview?: (key: string | null) => void;
  onBeginDrag?: (key: string, x: number, y: number) => void;
};

const IN_BREW_ROW =
  "border-l-2 border-amber-400 bg-amber-400/10 ring-1 ring-inset ring-amber-400/50 hover:bg-amber-400/15";
const OUT_ROW = "border-l-2 border-transparent hover:bg-surface-alt";

function IngredientRow({ ing, count, onAdd, onDec, onRemoveAll, onPreview, onBeginDrag }: RowProps) {
  const inert = ing.emits.length === 0 && !ing.strike && !ing.wild;
  const inBrew = count > 0;
  const g = useRowGestures(ing.key, onPreview, onBeginDrag);

  return (
    <li
      className={`group flex items-center justify-between gap-2 px-4 py-2.5 transition-colors ${
        inBrew ? IN_BREW_ROW : OUT_ROW
      }`}
    >
      {/* row body: add one when absent, remove all when present */}
      <button
        type="button"
        onClick={() => {
          if (g.consumeDragClick()) return;
          if (inBrew) onRemoveAll(ing.key);
          else onAdd(ing.key);
        }}
        onMouseEnter={g.onMouseEnter}
        onMouseLeave={g.onMouseLeave}
        onPointerDown={g.onPointerDown}
        onPointerMove={g.onPointerMove}
        onPointerUp={g.onPointerUp}
        className="flex min-w-0 flex-1 touch-none items-center gap-2.5 text-left"
        aria-label={
          inBrew
            ? `Remove all ${ing.name} from the brew`
            : `Add ${ing.name} to the brew`
        }
        title={
          inBrew
            ? "Click to remove all from the brew — or drag toward the cauldron"
            : "Click to add to the brew — or drag toward the cauldron"
        }
      >
        <IngredientThumb name={ing.name} source={ing.source} color={ing.color} size={42} />
        <span className="min-w-0 flex-1 truncate text-base font-semibold text-text">
          {ing.name}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {ing.emits.map((t, i) => (
            <FrequencySymbol key={`${t}:${i}`} id={t} size={21} />
          ))}
          {Array.from({ length: ing.strike }, (_, i) => (
            <span
              key={`s${i}`}
              className="grid h-[21px] w-[21px] place-items-center rounded-full border text-[12px] font-bold"
              style={{ color: STRIKE, borderColor: STRIKE, background: "#a855f71a" }}
            >
              ⊖
            </span>
          ))}
          {Array.from({ length: ing.wild }, (_, i) => (
            <span
              key={`w${i}`}
              className="grid h-[21px] w-[21px] place-items-center rounded-full border text-[12px] font-bold"
              style={{ color: COPPER, borderColor: COPPER, background: "#c98a3c1a" }}
            >
              ⊕
            </span>
          ))}
          {inert && <span className="font-mono text-[10px] text-text-faint">inert</span>}
        </span>
      </button>

      <CountControls ing={ing} count={count} onAdd={onAdd} onDec={onDec} />
    </li>
  );
}

// A pure-frequency row: just the symbol and the full name, centered.
function FrequencyRow({ ing, count, onAdd, onDec, onRemoveAll, onPreview, onBeginDrag }: RowProps) {
  const id = ing.key.slice(5);
  const charge = id === "strike" || id === "wild";
  const inBrew = count > 0;
  const g = useRowGestures(ing.key, onPreview, onBeginDrag);

  return (
    <li
      className={`group flex items-center justify-between gap-2 px-4 py-2 transition-colors ${
        inBrew ? IN_BREW_ROW : OUT_ROW
      }`}
    >
      <button
        type="button"
        onClick={() => {
          if (g.consumeDragClick()) return;
          if (inBrew) onRemoveAll(ing.key);
          else onAdd(ing.key);
        }}
        onMouseEnter={g.onMouseEnter}
        onMouseLeave={g.onMouseLeave}
        onPointerDown={g.onPointerDown}
        onPointerMove={g.onPointerMove}
        onPointerUp={g.onPointerUp}
        className="flex min-w-0 flex-1 touch-none items-center gap-2.5 text-left"
        aria-label={
          inBrew
            ? `Remove all ${pureName(ing)} from the brew`
            : `Add ${pureName(ing)} to the brew`
        }
        title={
          inBrew
            ? "Click to remove all from the brew — or drag toward the cauldron"
            : "Click to add to the brew — or drag toward the cauldron"
        }
      >
        {charge ? (
          <span
            className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full border-2 text-base font-bold"
            style={{
              color: id === "strike" ? STRIKE : COPPER,
              borderColor: id === "strike" ? STRIKE : COPPER,
              background: id === "strike" ? "#a855f71a" : "#c98a3c1a",
            }}
          >
            {id === "strike" ? "⊖" : "⊕"}
          </span>
        ) : (
          <FrequencyGlyph id={id} size={30} />
        )}
        <span className="truncate text-base font-semibold text-text">{pureName(ing)}</span>
      </button>

      <CountControls ing={ing} count={count} onAdd={onAdd} onDec={onDec} />
    </li>
  );
}
