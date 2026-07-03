"use client";

import { useState } from "react";
import type { Source } from "../lib/types";
import { ingredientImageSrc } from "../lib/images";

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
  const [failed, setFailed] = useState(false);
  const hasArt = source.kind === "base" && !failed;

  if (hasArt) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={ingredientImageSrc(name)}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
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
