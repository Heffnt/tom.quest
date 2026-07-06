// Ingredient crest artwork extracted from TTF Ingredients.pdf, stored as square
// thumbnails named <slug>.png. Only the 96 base ingredients have artwork;
// user-created ones fall back to a chip.
//
// The art is synced by scripts/sync-perfume-data.mjs into
// public/perfume/ingredients/, which serves at /perfume/ingredients/<slug>.png
// (the /perfume app route only handles the exact /perfume path, so static
// files under it are not shadowed). A legacy copy still lives under
// public/art/ingredients/ and is kept as a fallback for any checkout that
// hasn't re-synced yet.

export function ingredientSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Preferred local art path: the freshly synced crests under /perfume. */
export function ingredientImageSrc(name: string): string {
  return `/perfume/ingredients/${ingredientSlug(name)}.png`;
}

/** Fallback art path: the legacy copy under /art, tried if the preferred one
 * 404s (e.g. before scripts/sync-perfume-data.mjs has populated /perfume). */
export function ingredientImageFallbackSrc(name: string): string {
  return `/art/ingredients/${ingredientSlug(name)}.png`;
}
