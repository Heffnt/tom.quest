// styling tests — ordinal cycling (the per-value override machinery is gone).

import { describe, it, expect } from "vitest";
import {
  CATEGORY_PALETTE, PALETTE, SHAPE_COUNT, DASH_PATTERNS, GRADIENT_STOPS,
  paletteColor, colorForValue, shapeForValue, dashForValue, gradientColor,
} from "./styling";

describe("CATEGORY_PALETTE", () => {
  it("has at least 20 distinct hex colors (PALETTE aliases it)", () => {
    expect(CATEGORY_PALETTE.length).toBeGreaterThanOrEqual(20);
    expect(new Set(CATEGORY_PALETTE).size).toBe(CATEGORY_PALETTE.length);
    for (const c of CATEGORY_PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
    expect(PALETTE).toBe(CATEGORY_PALETTE);
  });
});

describe("paletteColor / colorForValue", () => {
  it("cycles the palette by ordinal", () => {
    expect(paletteColor(0)).toBe(CATEGORY_PALETTE[0]);
    expect(paletteColor(CATEGORY_PALETTE.length)).toBe(CATEGORY_PALETTE[0]);
    expect(paletteColor(CATEGORY_PALETTE.length + 1)).toBe(CATEGORY_PALETTE[1]);
    expect(colorForValue).toBe(paletteColor); // back-compat alias
  });
});

describe("shapeForValue", () => {
  it("cycles glyphs", () => {
    expect(shapeForValue(0)).toBe(0);
    expect(shapeForValue(SHAPE_COUNT)).toBe(0);
    expect(shapeForValue(SHAPE_COUNT + 2)).toBe(2);
  });
});

describe("dashForValue", () => {
  it("index 0 is solid; cycles", () => {
    expect(dashForValue(0)).toBe(DASH_PATTERNS[0]);
    expect(dashForValue(DASH_PATTERNS.length)).toBe(DASH_PATTERNS[0]);
    expect(dashForValue(2)).toBe(DASH_PATTERNS[2]);
  });
});

describe("gradientColor", () => {
  it("anchors the ends and clamps out-of-range t", () => {
    expect(gradientColor(0)).toBe(GRADIENT_STOPS[0]);
    expect(gradientColor(1)).toBe(GRADIENT_STOPS[GRADIENT_STOPS.length - 1]);
    expect(gradientColor(-5)).toBe(GRADIENT_STOPS[0]);
    expect(gradientColor(9)).toBe(GRADIENT_STOPS[GRADIENT_STOPS.length - 1]);
    expect(gradientColor(NaN)).toMatch(/^#[0-9a-f]{6}$/); // finite fallback (0.5)
  });
  it("interpolates a valid hex between stops", () => {
    const mid = gradientColor(0.5);
    expect(mid).toMatch(/^#[0-9a-f]{6}$/);
    expect(mid).not.toBe(GRADIENT_STOPS[0]);
    expect(mid).not.toBe(GRADIENT_STOPS[GRADIENT_STOPS.length - 1]);
  });
});
