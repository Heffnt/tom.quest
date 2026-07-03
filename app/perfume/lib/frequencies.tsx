"use client";

// Visual frequency module for the Perfumer's Bench (/perfume).
//
// Single source of truth for how a frequency *looks* — the emblem glyphs,
// chip letters, and colors used by the cauldron panel and inline chips —
// plus the hover popover that shows a frequency's decomposition tree.
//
// Two kinds of frequency render here:
//   - FUNDAMENTAL  -> a filled rounded chip with its letter id (A, C, En, ...).
//   - NAMED        -> a transparent ringed chip showing its emblem glyph,
//                     copper if summon-only, otherwise phial-green.

import React from "react";
import { createPortal } from "react-dom";
import { FUND, SUMMON_ONLY, isNamed, NAMED } from "../data/base";
import { GLYPH } from "./emblems";

// --- palette ----------------------------------------------------------------

export const PHIAL = "#6FE3C4"; // phial-green: ordinary named frequencies
export const COPPER = "#C98A3C"; // copper: summon-only (⊕-only) frequencies
export const STRIKE = "#a855f7"; // purple: ⊖ strikes

// --- emblem dictionary ------------------------------------------------------
// GLYPH (./emblems.ts) holds the real emblem artwork, extracted from the
// "Magical Frequencies.pdf" source material by Byobu's app/extract_art.py:
// inner-SVG markup in a 24x24 viewBox, keyed by Named.icon.

export { GLYPH };

// --- color helpers ----------------------------------------------------------

/** A named frequency emitted by NO ingredient — only summonable via ⊕. */
export function isSummonOnly(id: string): boolean {
  return SUMMON_ONLY.has(id);
}

/** Display color for a named frequency: copper if summon-only, else phial. */
export function namedColor(id: string): string {
  return isSummonOnly(id) ? COPPER : PHIAL;
}

/** Display color for a fundamental, falling back to grey for unknown ids.
 * Very dark source colors (Necromancy's near-black) get lifted toward a
 * readable grey — as outlined rings and letters they'd vanish on the dark
 * theme otherwise. */
const FUND_DISPLAY = new Map<string, string>();
export function fundColor(id: string): string {
  const raw = FUND[id]?.color ?? "#888888";
  const cached = FUND_DISPLAY.get(raw);
  if (cached) return cached;
  const h = raw.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  let out = raw;
  if (lum < 80) {
    // blend 60% toward a light slate so the hue's character survives
    const mix = (v: number, t: number) => Math.round(v + (t - v) * 0.6);
    out = `#${[mix(r, 203), mix(g, 207), mix(b, 224)]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")}`;
  }
  FUND_DISPLAY.set(raw, out);
  return out;
}

/** Display color for any frequency: fundamental -> its color; named -> namedColor. */
export function tokenColor(id: string): string {
  return isNamed(id) ? namedColor(id) : fundColor(id);
}

// --- presentational components ----------------------------------------------

/** Renders an emblem glyph as a 24x24 SVG. `icon` keys into GLYPH. */
export function EmblemSvg({
  icon,
  className,
  style,
}: {
  icon: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  // Per-emblem display boosts: Crallax's big star travels with two satellite
  // sparkles, so the star itself reads small — scale the whole emblem up and
  // let the satellites overflow the viewBox (there's room inside the chip).
  const scale = EMBLEM_SCALE[icon];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      overflow="visible"
      className={className}
      style={style}
      // GLYPH strings are trusted, static, generated markup.
      dangerouslySetInnerHTML={{
        __html: scale
          ? `<g transform="translate(12 12) scale(${scale}) translate(-12 -12)">${GLYPH[icon] ?? ""}</g>`
          : (GLYPH[icon] ?? ""),
      }}
    />
  );
}

const EMBLEM_SCALE: Record<string, number> = { sparkle: 1.3 };

// The bare chip visual, no hover behavior — used by FrequencySymbol and inside
// the decomposition popover (which must not spawn nested popovers).
export function FrequencyGlyph({
  id,
  size = 28,
  className,
}: {
  id: string;
  size?: number;
  className?: string;
}) {
  const named = isNamed(id);

  if (named) {
    const color = namedColor(id);
    const icon = NAMED[id]?.icon ?? "";
    // Emblem is inset so the ring reads as a border around it.
    const inner = Math.round(size * 0.7);
    return (
      <span
        className={className}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: size,
          height: size,
          borderRadius: "50%",
          background: "transparent",
          border: `1.5px solid ${color}`,
          boxShadow: `inset 0 0 0 1px ${color}22`,
          color,
          lineHeight: 0,
          flex: "0 0 auto",
        }}
      >
        <EmblemSvg
          icon={icon}
          style={{ width: inner, height: inner, display: "block" }}
        />
      </span>
    );
  }

  // Fundamental: the same outlined circle as the named chips, ringed and
  // lettered in the fundamental's own color.
  const color = fundColor(id);
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        background: "transparent",
        border: `1.5px solid ${color}`,
        boxShadow: `inset 0 0 0 1px ${color}22`,
        color,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        fontWeight: 700,
        fontSize: Math.round(size * (id.length > 1 ? 0.5 : 0.62)),
        letterSpacing: id.length > 1 ? "-0.04em" : 0,
        lineHeight: 1,
        flex: "0 0 auto",
      }}
    >
      {id}
    </span>
  );
}

// ── decomposition popover ─────────────────────────────────────────────────────

// The "combines from" card: the frequency plus its DIRECT components only
// (grouped ×n) — not the full recursion to fundamentals.
function DecompCard({ id }: { id: string }) {
  const named = isNamed(id);
  const label = named ? id : (FUND[id]?.school ?? id);
  const comps = named ? NAMED[id].components : [];
  const grouped = new Map<string, number>();
  for (const c of comps) grouped.set(c, (grouped.get(c) ?? 0) + 1);
  return (
    <div>
      <p className="mb-1 font-mono text-[9px] uppercase tracking-wider text-text-faint">
        {named ? "combines from" : "fundamental frequency"}
      </p>
      <div className="flex items-center gap-1.5 py-0.5">
        <FrequencyGlyph id={id} size={18} />
        <span className="font-mono text-[11px] font-bold text-text">{label}</span>
      </div>
      {named &&
        [...grouped.entries()].map(([cid, n]) => (
          <div key={cid} className="ml-3.5 flex items-center gap-1.5 py-0.5">
            <FrequencyGlyph id={cid} size={16} />
            <span className="font-mono text-[11px] text-text">
              {isNamed(cid) ? cid : (FUND[cid]?.school ?? cid)}
              {n > 1 ? ` ×${n}` : ""}
            </span>
          </div>
        ))}
    </div>
  );
}

/**
 * A circular chip for a single frequency, used floating above the cauldron and
 * inline in chips. Fundamentals show their letter on a filled chip; named
 * frequencies show their emblem on a transparent, ringed chip.
 *
 * Hovering any symbol pops a "combines from" card with the frequency's direct
 * components. The card renders through a portal onto document.body — inside
 * the cauldron the symbols live in CSS-transformed slots, where a plain
 * position:fixed child would anchor to the transformed ancestor instead of
 * the viewport and drift wildly off-position.
 *
 * `size` is the px diameter — kept crisp at ~24-34px.
 */
export function FrequencySymbol({
  id,
  size = 28,
  className,
}: {
  id: string;
  size?: number;
  className?: string;
}) {
  const [pop, setPop] = React.useState<{ x: number; y: number } | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPop({ x: r.left + r.width / 2, y: r.bottom }), 260);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPop(null);
  };
  React.useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // clamp the popover on-screen (it renders position:fixed via a portal);
  // floor the viewport size so degenerate 0×0 windows can't fling it away
  const W = 220;
  const vw = Math.max(typeof window !== "undefined" ? window.innerWidth : 1024, 360);
  const vh = Math.max(typeof window !== "undefined" ? window.innerHeight : 768, 360);
  const left = pop ? Math.min(Math.max(pop.x - W / 2, 8), vw - W - 8) : 0;
  const openUp = pop !== null && pop.y > vh - 240;

  return (
    <span
      className="relative inline-flex"
      style={{ flex: "0 0 auto", lineHeight: 0 }}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <FrequencyGlyph id={id} size={size} className={className} />
      {pop &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[70] rounded-lg border border-border bg-surface p-2.5 shadow-xl"
            style={{
              left,
              width: W,
              ...(openUp
                ? { bottom: Math.max(window.innerHeight, 360) - pop.y + size + 6 }
                : { top: pop.y + 6 }),
            }}
            role="tooltip"
          >
            <DecompCard id={id} />
          </div>,
          document.body,
        )}
    </span>
  );
}
