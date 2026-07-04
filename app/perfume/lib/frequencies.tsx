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
//                     copper if no known ingredient emits it, otherwise
//                     phial-green.

import React from "react";
import { createPortal } from "react-dom";
import { FUND, NO_DIRECT_EMITTER, isNamed, NAMED, TYPE_GLYPHS } from "../data/base";
import type { IngredientType } from "./types";
import { GLYPH } from "./emblems";

// --- palette ----------------------------------------------------------------

export const PHIAL = "#6FE3C4"; // phial-green: ordinary named frequencies
export const COPPER = "#C98A3C"; // copper: frequencies with no direct emitter
export const STRIKE = "#a855f7"; // purple: ⊖ strikes

// --- emblem dictionary ------------------------------------------------------
// GLYPH (./emblems.ts) holds the real emblem artwork, extracted from the
// "Magical Frequencies.pdf" source material by Byobu's app/extract_art.py:
// inner-SVG markup in a 24x24 viewBox, keyed by Named.icon.

export { GLYPH };

// --- color helpers ----------------------------------------------------------

/** A named frequency emitted directly by NO known ingredient — still
 * reachable by combining emitted frequencies, or by a wild ⊕. */
export function hasNoDirectEmitter(id: string): boolean {
  return NO_DIRECT_EMITTER.has(id);
}

/** Display color for a named frequency: copper if no direct emitter, else phial. */
export function namedColor(id: string): string {
  return hasNoDirectEmitter(id) ? COPPER : PHIAL;
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

// --- strike / wild charges ------------------------------------------------

/** The ⊖/⊕ charge chip, rendered EXACTLY like a frequency glyph: the same
 * ring, with the dash (strike) or plus (wild) spanning edge to edge of the
 * circle — the one chip for charges everywhere in the app. */
export function ChargeSymbol({
  kind,
  size = 28,
  className,
}: {
  kind: "strike" | "wild";
  size?: number;
  className?: string;
}) {
  const color = kind === "strike" ? STRIKE : COPPER;
  return (
    <span
      className={className}
      title={kind}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        border: `1.5px solid ${color}`,
        boxShadow: `inset 0 0 0 1px ${color}22`,
        background: `${color}1a`,
        color,
        lineHeight: 0,
        flex: "0 0 auto",
      }}
    >
      <svg viewBox="0 0 24 24" style={{ width: "100%", height: "100%", display: "block" }} aria-hidden="true">
        <path
          d={kind === "strike" ? "M2.2 12h19.6" : "M2.2 12h19.6M12 2.2v19.6"}
          stroke="currentColor"
          strokeWidth="2.1"
        />
      </svg>
    </span>
  );
}

// --- ingredient types ---------------------------------------------------------

export const TYPE_COLORS: Record<IngredientType, string> = {
  plant: "#7cb46b",
  animal: "#d8c8a8",
  mineral: "#5b9bd5",
};

/** An ingredient's type (element icon) as a ringed chip, like the frequency
 * glyphs — the real extracted shape in the type's color. */
export function TypeGlyph({
  type,
  size = 20,
  className,
}: {
  type: IngredientType;
  size?: number;
  className?: string;
}) {
  const g = TYPE_GLYPHS[type];
  const color = TYPE_COLORS[type];
  const inner = Math.round(size * 0.62);
  return (
    <span
      title={type}
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        border: `1.5px solid ${color}`,
        boxShadow: `inset 0 0 0 1px ${color}22`,
        color,
        lineHeight: 0,
        flex: "0 0 auto",
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        style={{ width: inner, height: inner, display: "block" }}
        // extracted, trusted path data
        dangerouslySetInnerHTML={{
          __html: `<path d="${g.d}" fill-rule="${g.fillRule}"/>`,
        }}
      />
    </span>
  );
}

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

// The "combines from" card, two clean rows: the frequency's symbol + name,
// then the DIRECT components as bare symbols in one row (multiplicity shows
// as repeated symbols, not ×n). Fundamentals get just the first row.
function DecompCard({ id }: { id: string }) {
  const named = isNamed(id);
  const label = named ? id : (FUND[id]?.school ?? id);
  const comps = named ? NAMED[id].components : [];
  const sorted = [...comps].sort();
  return (
    <div>
      <div className="flex items-center gap-2 py-0.5">
        <FrequencyGlyph id={id} size={22} />
        <span className="font-mono text-xs font-bold text-text">{label}</span>
      </div>
      {sorted.length > 0 && (
        <div className="mt-1 flex items-center gap-1">
          {sorted.map((cid, i) => (
            <FrequencyGlyph key={`${cid}:${i}`} id={cid} size={18} />
          ))}
        </div>
      )}
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
