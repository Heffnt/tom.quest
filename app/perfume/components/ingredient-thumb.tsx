"use client";

import { useState } from "react";
import type { Source } from "../lib/types";
import { ingredientImageSrc, ingredientImageFallbackSrc } from "../lib/images";

// Renders an ingredient's art tile (base ingredients) or a color chip
// fallback (user-created ones, or if the image fails to load). The art
// carries its own parchment panel + peeking element bubble on transparency,
// so no border or clipping here.
export default function IngredientThumb({
  name,
  source,
  color,
  size = 40,
}: {
  name: string;
  source: Source;
  color: string;
  size?: number;
}) {
  // Try the preferred /perfume path first; on error fall back to the legacy
  // /art copy, then to the color chip if that fails too.
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const hasArt = source.kind === "base" && stage < 2;

  if (hasArt) {
    const src = stage === 0 ? ingredientImageSrc(name) : ingredientImageFallbackSrc(name);
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key={src}
        src={src}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        loading="lazy"
        onError={() => setStage((s) => (s < 2 ? ((s + 1) as 0 | 1 | 2) : s))}
        className="shrink-0 object-contain"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-md border border-border/60 bg-surface-alt"
      style={{ width: size, height: size }}
    >
      <span
        className="rounded-full"
        style={{ width: size * 0.4, height: size * 0.4, background: color }}
      />
    </span>
  );
}
