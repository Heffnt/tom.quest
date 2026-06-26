// Ingredient crest artwork extracted from TTF Ingredients.pdf, stored as square
// thumbnails under public/art/ingredients/<slug>.png. (Must live OUTSIDE the
// /perfume path — the /perfume app route shadows static files under /perfume/*.)
// Only the 96 base ingredients have artwork; user-created ones fall back to a chip.

export function ingredientSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function ingredientImageSrc(name: string): string {
  return `/art/ingredients/${ingredientSlug(name)}.png`;
}
