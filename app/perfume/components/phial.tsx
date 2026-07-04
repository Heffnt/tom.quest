"use client";

// The phial — a brewed perfume as a chip: phial glyph at the frequency-chip
// scale (44px), the perfume's name under it, ×n when the tray holds several.
// Presentational only; the output shelf wires the hand grammar around it.

import { useId } from "react";

// Neck-and-bulb silhouette shared by the glass outline and the liquid clip.
const PHIAL =
  "M10.4 4.2 h3.2 v3.4 c2.8 1.5 4.4 3.8 4.4 6.6 a6 6 0 0 1 -12 0 c0-2.8 1.6-5.1 4.4-6.6 Z";

/** Bare phial SVG, `size` px square — also the hand ghost's icon for
 * perfumes picked up from the output tray. */
export function PhialGlyph({
  size = 44,
  className,
}: {
  size?: number;
  className?: string;
}) {
  // useId emits colons, which break url(#...) references in some engines
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const brew = `pf-phial-brew-${uid}`;
  const body = `pf-phial-body-${uid}`;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} className={className} aria-hidden="true">
      <defs>
        <linearGradient id={brew} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#9bf6df" />
          <stop offset="100%" stopColor="#2f9c84" />
        </linearGradient>
        <clipPath id={body}>
          <path d={PHIAL} />
        </clipPath>
      </defs>
      {/* cork */}
      <rect x="10.1" y="1.4" width="3.8" height="2.6" rx="0.8" fill="#C98A3C" />
      {/* the brew inside, clipped to the phial */}
      <g clipPath={`url(#${body})`}>
        <rect x="4" y="12.2" width="16" height="10" fill={`url(#${brew})`} opacity="0.92" />
        <ellipse cx="12" cy="12.2" rx="6.4" ry="1" fill="#9bf6df" opacity="0.8" />
        <circle cx="13.6" cy="15.4" r="0.7" fill="#e8fff8" opacity="0.7" />
        <circle cx="10.8" cy="17.2" r="0.5" fill="#e8fff8" opacity="0.5" />
      </g>
      {/* glass */}
      <path
        d={PHIAL}
        fill="rgba(155,246,223,0.07)"
        stroke="#8b89b8"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      {/* shine */}
      <path
        d="M8.7 11.1c-.9.8-1.5 1.9-1.7 3.1"
        fill="none"
        stroke="#e8fff8"
        strokeWidth="0.9"
        strokeLinecap="round"
        opacity="0.45"
      />
    </svg>
  );
}

export interface PhialProps {
  name: string;
  count: number;
  size?: number; // glyph px diameter, matching the 44px frequency chips
  dimmed?: boolean; // takeless viewers see the shelf, faded
}

export default function Phial({ name, count, size = 44, dimmed = false }: PhialProps) {
  return (
    <span
      className="flex flex-col items-center gap-1"
      style={{ opacity: dimmed ? 0.55 : 1 }}
    >
      <span className="relative">
        <PhialGlyph size={size} />
        {count > 1 && (
          <span className="absolute -right-2 -top-1 rounded-full border border-border bg-surface px-1 font-mono text-[10px] font-bold text-text">
            ×{count}
          </span>
        )}
      </span>
      <span
        className="pointer-events-none max-w-[84px] text-center font-mono text-[10px] uppercase leading-tight tracking-wide text-text"
        style={{ textShadow: "0 1px 3px rgba(0,0,0,.9), 0 0 12px rgba(0,0,0,.7)" }}
      >
        {name}
      </span>
    </span>
  );
}
