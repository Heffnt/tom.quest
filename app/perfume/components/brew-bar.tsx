"use client";

// The brew bar — the read-only frequency math under the stage (DESIGN.md,
// "cauldron panel"): the effective tally as glyph chips, hover-ghost deltas,
// then `=` and every perfume the tally exactly brews. The Brew button is the
// bar's ONLY interactive element; hover previews live here and never touch
// the cauldron graph.

import { useMemo } from "react";
import type { BrewState, Ingredient, Multiset, Perfume } from "../lib/types";
import { brewTally, msDiff } from "../lib/engine";
import { hoverDelta } from "../lib/brewable";
import { ALL_FREQUENCIES, basePerfumes } from "../data/base";
import { FrequencySymbol } from "../lib/frequencies";

export interface BrewBarProps {
  brew: BrewState;
  // hovered catalog/inventory row — previews its tally delta as ghost chips
  hoverIngredient: Ingredient | null;
  options: { perfume: Perfume; k: number; tuningIndex: number }[];
  // why brewing is blocked (hypothetical items, permissions, ...) — the
  // disabled Brew button names them
  blockers: string[];
  canBrew: boolean;
  onBrew: (perfumeKey: string, tuningIndex: number, k: number) => void;
}

// Chips group by frequency (repeated symbols, not ×n), in the canonical
// weight order: fundamentals first, then named lightest-to-heaviest.
const FREQ_ORDER = new Map(ALL_FREQUENCIES.map((f, i) => [f.id, i]));

function expand(ms: Multiset): string[] {
  return Object.keys(ms)
    .sort(
      (a, b) =>
        (FREQ_ORDER.get(a) ?? 99) - (FREQ_ORDER.get(b) ?? 99) || a.localeCompare(b),
    )
    .flatMap((id) => Array<string>(ms[id]).fill(id));
}

type Chip = { id: string; ghost: "add" | "gone" | null };

function kLabel(name: string, k: number): string {
  return k > 1 ? `${name} ×${k}` : name;
}

export default function BrewBar({
  brew,
  hoverIngredient,
  options,
  blockers,
  canBrew,
  onBrew,
}: BrewBarProps) {
  const tally = useMemo(() => brewTally(brew), [brew]);
  // hoverDelta compares against the full perfume list, not just the current
  // options — gains have to see perfumes that are not brewable yet
  const delta = useMemo(
    () => (hoverIngredient ? hoverDelta(brew, hoverIngredient, basePerfumes) : null),
    [brew, hoverIngredient],
  );

  const chips = useMemo<Chip[]>(() => {
    const base: Chip[] = expand(tally).map((id) => ({ id, ghost: null }));
    if (!delta) return base;
    // chips the addition would consume (auto-combination) ghost out in place;
    // the ones it would create append as ghosts
    const gone = { ...msDiff(tally, delta.tally) };
    for (let i = base.length - 1; i >= 0; i--) {
      const id = base[i].id;
      if ((gone[id] ?? 0) > 0) {
        gone[id] -= 1;
        base[i] = { id, ghost: "gone" };
      }
    }
    const added = expand(msDiff(delta.tally, tally)).map<Chip>((id) => ({
      id,
      ghost: "add",
    }));
    return [...base, ...added];
  }, [tally, delta]);

  const empty = chips.length === 0 && options.length === 0;

  return (
    <div data-testid="brew-bar" className="border-t border-border px-3 py-2">
      {empty ? (
        <p className="py-1 text-center font-mono text-xs text-text-faint">
          the cauldron is empty
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="flex flex-wrap items-center gap-1">
            {chips.map((c, i) => (
              <span
                key={`${c.id}:${i}:${c.ghost ?? "solid"}`}
                data-testid="brew-chip"
                data-freq={c.id}
                data-ghost={c.ghost ?? undefined}
                style={
                  c.ghost
                    ? { opacity: 0.4, filter: c.ghost === "gone" ? "grayscale(1)" : "none" }
                    : undefined
                }
              >
                <FrequencySymbol id={c.id} size={24} />
              </span>
            ))}
          </span>

          {/* hover hint: what one more of the hovered ingredient would do */}
          {delta && (delta.gains.length > 0 || delta.losses.length > 0) && (
            <span className="flex flex-wrap items-center gap-x-2 font-mono text-[11px]">
              {delta.gains.map((g) => (
                <span key={`g:${g.perfume.key}`} className="text-success">
                  would brew {kLabel(g.perfume.name, g.k)}
                </span>
              ))}
              {delta.losses.map((l) => (
                <span key={`l:${l.perfume.key}`} className="text-error">
                  would break {l.perfume.name}
                </span>
              ))}
            </span>
          )}

          {options.length > 0 && (
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm text-success">=</span>
              {options.map((o) => (
                <span
                  key={`${o.perfume.key}:${o.tuningIndex}`}
                  className="flex items-center gap-2 rounded-full border border-border bg-surface py-0.5 pl-3 pr-1"
                >
                  <span
                    className="font-display text-base leading-none text-text"
                    style={{ textShadow: "0 0 14px rgba(111,227,196,.5)" }}
                  >
                    {kLabel(o.perfume.name, o.k)}
                  </span>
                  <button
                    type="button"
                    disabled={!canBrew}
                    onClick={() => onBrew(o.perfume.key, o.tuningIndex, o.k)}
                    aria-label={`Brew ${kLabel(o.perfume.name, o.k)}`}
                    title={
                      canBrew
                        ? `Brew ${kLabel(o.perfume.name, o.k)} — consumes the whole pot`
                        : blockers.join(" · ") || "brewing is unavailable"
                    }
                    className="rounded-full border border-success/50 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-success transition-colors duration-150 hover:bg-success/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    Brew
                  </button>
                </span>
              ))}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
