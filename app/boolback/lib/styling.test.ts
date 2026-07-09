// styling tests — ordinal cycling + per-value override precedence.

import { describe, it, expect } from "vitest";
import {
  PALETTE, SHAPE_COUNT, DASH_PATTERNS, GRADIENT_STOPS,
  colorForValue, shapeForValue, dashForValue, gradientColor,
} from "./styling";

describe("colorForValue", () => {
  it("cycles the palette by ordinal", () => {
    expect(colorForValue("d", "a", 0, {})).toBe(PALETTE[0]);
    expect(colorForValue("d", "z", PALETTE.length, {})).toBe(PALETTE[0]);
    expect(colorForValue("d", "z", PALETTE.length + 1, {})).toBe(PALETTE[1]);
  });
  it("honors an explicit per-value color override", () => {
    expect(colorForValue("d", "a", 3, { d: { a: { color: "#123456" } } })).toBe("#123456");
  });
});

describe("shapeForValue", () => {
  it("cycles glyphs and honors overrides", () => {
    expect(shapeForValue("d", "a", SHAPE_COUNT, {})).toBe(0);
    expect(shapeForValue("d", "a", 2, { d: { a: { shape: 5 } } })).toBe(5);
    expect(shapeForValue("d", "a", 2, { d: { a: { shape: SHAPE_COUNT + 1 } } })).toBe(1);
  });
});

describe("dashForValue", () => {
  it("index 0 is solid; cycles; honors overrides", () => {
    expect(dashForValue("d", "a", 0, {})).toBe(DASH_PATTERNS[0]);
    expect(dashForValue("d", "a", DASH_PATTERNS.length, {})).toBe(DASH_PATTERNS[0]);
    expect(dashForValue("d", "a", 0, { d: { a: { dash: 2 } } })).toBe(DASH_PATTERNS[2]);
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
