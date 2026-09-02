// Ingredient crest artwork extracted from TTF Ingredients.pdf, stored as square
// thumbnails named <slug>.png. Only the 96 base ingredients have artwork;
// user-created ones fall back to a chip.
//
// The art is synced by scripts/sync-perfume-data.mjs into
// public/perfume/ingredients/, which serves at /perfume/ingredients/<slug>.png
// (the /perfume app route only handles the exact /perfume path, so static
// files under it are not shadowed). Those 96 PNGs are committed, so every base
// ingredient always has a file to load and there is no second art path.
//
// DANGER: app/perfume/lib/images.test.ts asserts one committed PNG per base
// ingredient. A missing file now falls straight through to the color chip —
// there is no longer a second directory to catch it — so do not delete a PNG
// from public/perfume/ingredients/ or rename an ingredient in base.json
// without re-running scripts/sync-perfume-data.mjs.

export function ingredientSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Local art path for a base ingredient's crest. */
export function ingredientImageSrc(name: string): string {
  return `/perfume/ingredients/${ingredientSlug(name)}.png`;
}
