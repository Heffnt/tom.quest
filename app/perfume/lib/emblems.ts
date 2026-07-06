// Named-frequency emblem artwork for the Perfumer (/perfume).
//
// The emblem shapes themselves live in ../data/emblems.json — extracted
// verbatim from "Magical Frequencies.pdf" by Byobu and synced into this repo
// via scripts/sync-perfume-data.mjs (npm run sync:perfume). That JSON is keyed
// by named-frequency id -> { icon, d }, where `d` is an SVG path in a 24x24
// fill=currentColor viewBox.
//
// This module is a thin, hand-written view over that data: it exposes GLYPH, a
// map from EMBLEM ICON name (e.g. "flame", "sparkle") to its path string, which
// is how frequencies.tsx keys into the artwork (Named.icon -> GLYPH[icon]).

import emblems from "../data/emblems.json";

type EmblemEntry = { icon: string; d: string };

const ENTRIES = emblems as Record<string, EmblemEntry>;

/**
 * Emblem path data keyed by icon name. Each value is the inner SVG markup
 * (a single <path>'s `d`, wrapped) for a 24x24 fill=currentColor viewBox.
 * Multiple named frequencies may share an icon; the path is identical, so the
 * last write wins harmlessly.
 */
export const GLYPH: Record<string, string> = Object.fromEntries(
  Object.values(ENTRIES).map((e) => [e.icon, `<path d="${e.d}"/>`]),
);
