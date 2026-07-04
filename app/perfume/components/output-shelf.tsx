"use client";

// The output shelf — brewed perfumes waiting on the stage as phial chips
// (DESIGN.md, "cauldron panel"). Grammar: left-click picks up (hand
// from="output" — no boundary rule; settle over the input panel takes them),
// shift-click takes one straight to inventory, press-drag carries one.
// Owner-only on personal benches; other viewers get the disabled hint.

import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { basePerfumes } from "../data/base";
import type { BenchHand } from "../lib/use-hand";
import Phial from "./phial";

export interface OutputShelfProps {
  outputTray: Record<string, number>; // perfume key -> count
  hand: BenchHand;
  canTake: boolean; // BenchPermissions.brewAndTake for the viewed bench
  onTake: (perfumeKey: string, n: number) => void;
}

const PERFUME_NAME = new Map(basePerfumes.map((p) => [p.key, p.name]));

function perfumeName(key: string): string {
  return PERFUME_NAME.get(key) ?? key.replace(/^base:/, "");
}

export default function OutputShelf({ outputTray, hand, canTake, onTake }: OutputShelfProps) {
  const held = hand.hand?.from === "output" ? hand.hand : null;
  const entries = Object.entries(outputTray)
    .map(([key, n]) => ({
      key,
      name: perfumeName(key),
      // held phials ride the cursor — the shelf shows what's left of the tray
      count: n - (held?.itemKey === key ? held.count : 0),
    }))
    .filter((e) => e.count > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (entries.length === 0 && !held) return null;

  const onClick = (e: ReactMouseEvent, key: string, available: number) => {
    if (!canTake) return;
    if (e.shiftKey) {
      onTake(key, 1);
      return;
    }
    hand.pickUp(key, "output", available);
  };
  const onPointerDown = (e: ReactPointerEvent, key: string, available: number) => {
    if (!canTake) return;
    hand.beginPress(e, key, "output", available);
  };

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex flex-wrap items-start justify-center gap-3 rounded-xl border border-border bg-surface/80 px-3 py-2 shadow-lg backdrop-blur-sm">
        {entries.map((e) => (
          <button
            key={e.key}
            type="button"
            data-testid="output-phial"
            data-perfume-key={e.key}
            disabled={!canTake}
            onClick={(ev) => onClick(ev, e.key, e.count)}
            onPointerDown={(ev) => onPointerDown(ev, e.key, e.count)}
            onDragStart={(ev) => ev.preventDefault()}
            aria-label={
              canTake
                ? `${e.name} ×${e.count} brewed — click to pick up, shift-click to take one`
                : `${e.name} ×${e.count} brewed — only the bench owner may take it`
            }
            title={
              canTake
                ? "Click to pick up — carry to the input panel, or shift-click to take one"
                : "Only the bench owner may take brewed perfumes"
            }
            className="touch-none rounded-lg outline-none transition-transform duration-150 focus-visible:ring-2 focus-visible:ring-accent enabled:cursor-grab enabled:hover:scale-105 disabled:cursor-not-allowed"
          >
            <Phial name={e.name} count={e.count} dimmed={!canTake} />
          </button>
        ))}
      </div>
      {!canTake && (
        <p className="font-mono text-[10px] text-text-faint">
          only the bench owner may take these
        </p>
      )}
    </div>
  );
}
