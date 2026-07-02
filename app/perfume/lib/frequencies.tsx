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
//                     copper if legendary, otherwise phial-green.

import React from "react";
import { createPortal } from "react-dom";
import { FUND, LEGENDARY, isNamed, NAMED } from "../data/base";

// --- palette ----------------------------------------------------------------

export const PHIAL = "#6FE3C4"; // phial-green: ordinary named frequencies
export const COPPER = "#C98A3C"; // copper: legendary (⊕-only) frequencies
export const STRIKE = "#a855f7"; // purple: ⊖ strikes

// --- emblem dictionary ------------------------------------------------------
// Inner-SVG markup, viewBox 0 0 24 24. Ported VERBATIM from the Byobu repo
// (index.html lines 2267-2285). Trusted static markup — keyed by Named.icon.

const GLYPH: Record<string, string> = {
  flame:'<path d="M12 2c2 4-2 5-1 8 .6 1.8 2.4 1.5 2.4-.4 1.7 1.6 2.6 4 2.6 6a6 6 0 1 1-12 0c0-2.6 2-4.6 3-7 .8 2.2 3 1.7 3-.6 0-2.4-1.5-3.6 0-6z"/>',
  sparkle:'<path d="M12 2l1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6z"/><circle cx="18" cy="5" r="1"/><circle cx="5" cy="17" r="1"/>',
  moon:'<path d="M16 3a8 8 0 1 0 5 14 7 7 0 0 1-5-14z"/><circle cx="17" cy="6" r=".8"/>',
  crystal:'<path d="M12 2l5 6-5 14-5-14z"/><path d="M7 8h10M12 2v20"/>',
  skull:'<path d="M12 2a8 8 0 0 0-5 14v3a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3a8 8 0 0 0-5-14z"/><circle cx="9" cy="11" r="1.6"/><circle cx="15" cy="11" r="1.6"/>',
  bell:'<path d="M6 16a6 6 0 0 1 6-12 6 6 0 0 1 6 12z"/><path d="M4 16h16M10 19a2 2 0 0 0 4 0"/>',
  lizard:'<path d="M3 12c3-1 4 1 6 1s3-3 6-3 5 2 6 4c-2 0-3 1-5 1s-3-1-5 0-4 2-6 1 0-2-2-3z"/>',
  cage:'<path d="M12 3l5 4v9a5 5 0 0 1-10 0V7z"/><path d="M9 5v12M12 4v13M15 5v12"/>',
  lotus:'<path d="M12 4c1 3 1 5 0 8-1-3-1-5 0-8z"/><path d="M12 12c2-2 4-2 6-1-1 2-3 3-6 3M12 12c-2-2-4-2-6-1 1 2 3 3 6 3"/>',
  potion:'<path d="M10 3h4v4l3 9a4 4 0 0 1-4 6H11a4 4 0 0 1-4-6l3-9z"/><path d="M8 14h8"/>',
  meteor:'<circle cx="14" cy="10" r="5"/><path d="M9 15l-6 6M11 6L6 4M6 11l-4-1"/>',
  dagger:'<path d="M12 2l2 12-2 3-2-3z"/><path d="M8 14h8M12 17v5"/>',
  mirror:'<ellipse cx="12" cy="10" rx="6" ry="8"/><path d="M12 18v4M9 22h6"/>',
  lantern:'<path d="M9 4h6v3l1 8a4 4 0 0 1-8 0l1-8z"/><path d="M10 2h4M9 11h6"/>',
  bolt:'<path d="M13 2L5 13h6l-2 9 9-13h-6z"/>',
  scroll:'<path d="M6 4h10a2 2 0 0 1 2 2v11a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6"/><path d="M8 8h6M8 12h6"/><path d="M4 6a2 2 0 0 1 4 0v11"/>',
  planet:'<circle cx="12" cy="11" r="5"/><ellipse cx="12" cy="11" rx="10" ry="3.4" transform="rotate(-22 12 11)" fill="none"/>'
};

export { GLYPH };

// --- color helpers ----------------------------------------------------------

/** Relative luminance test: true when a hex color is "light" (dark text on it). */
export function isLight(hex: string): boolean {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 165;
}

/** A named frequency emitted by NO ingredient — only summonable via ⊕. */
export function isLegendary(id: string): boolean {
  return LEGENDARY.has(id);
}

/** Display color for a named frequency: copper if legendary, else phial. */
export function namedColor(id: string): string {
  return isLegendary(id) ? COPPER : PHIAL;
}

/** Display color for a fundamental, falling back to grey for unknown ids. */
export function fundColor(id: string): string {
  return FUND[id]?.color ?? "#888";
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
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      className={className}
      style={style}
      // GLYPH strings are trusted, static, hand-authored markup.
      dangerouslySetInnerHTML={{ __html: GLYPH[icon] ?? "" }}
    />
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
    const inner = Math.round(size * 0.62);
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

  // Fundamental: filled rounded chip with its letter id centered.
  const color = fundColor(id);
  const fg = isLight(color) ? "#14132B" : "#ffffff";
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.32),
        background: color,
        color: fg,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
        fontWeight: 700,
        fontSize: Math.round(size * (id.length > 1 ? 0.4 : 0.5)),
        letterSpacing: id.length > 1 ? "-0.03em" : 0,
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
