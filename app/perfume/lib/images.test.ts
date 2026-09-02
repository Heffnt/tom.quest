import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import base from "../data/base.json";
import { ingredientImageSrc, ingredientSlug } from "./images";

// The ingredient thumbnail used to try a second art path (/art/ingredients,
// a stale duplicate copy) whenever the first image 404'd. That copy is gone,
// so /perfume/ingredients is the only place a crest can come from and a
// missing file now shows the color chip instead of the artwork. These tests
// are what keeps that from happening silently.

const ART_DIR = path.join(process.cwd(), "public", "perfume", "ingredients");
const ingredients = (base as { ingredients: { name: string }[] }).ingredients;

describe("ingredient art", () => {
  it("has a committed PNG for every base ingredient", () => {
    const missing = ingredients
      .map((i) => `${ingredientSlug(i.name)}.png`)
      .filter((file) => !fs.existsSync(path.join(ART_DIR, file)));
    expect(missing).toEqual([]);
  });

  it("ships no PNG that no base ingredient names", () => {
    const wanted = new Set(ingredients.map((i) => `${ingredientSlug(i.name)}.png`));
    const orphans = fs.readdirSync(ART_DIR).filter((file) => !wanted.has(file));
    expect(orphans).toEqual([]);
  });

  it("resolves an ingredient name to its served path", () => {
    expect(ingredientImageSrc("Banshee's Hair")).toBe(
      "/perfume/ingredients/banshee-s-hair.png",
    );
  });

  it("keeps the legacy /art copy deleted", () => {
    expect(fs.existsSync(path.join(process.cwd(), "public", "art"))).toBe(false);
  });
});
