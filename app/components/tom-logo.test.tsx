// Regression: the bars variant used to draw its stroke width and t-bar height
// from two module constants (STROKE_VB = 43, TOP_BAR_FRAC = 269.5/383) frozen
// at the default params, so /logo's Stroke and T-bar-height sliders moved the
// symbol while the surrounding bars stayed put. Both now come from
// tomSymbolMetrics(symbolParams). The first test pins the shipped default
// rendering (it must not have changed); the rest fail if the constants return.

import { afterEach, describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

vi.mock("next/font/local", () => ({
  default: () => ({ className: "manrope", style: { fontFamily: "Manrope" } }),
}));

import TomLogo from "./tom-logo";
import { DEFAULT_TOM_PARAMS, type TomSymbolParams } from "./tom-symbol";

const FONT_SIZE = 100;
const SYMBOL_H = 1.04 * FONT_SIZE;

/** [left stem, right stem, top bar, bottom bar] — the bars variant's only rects. */
function bars(params?: TomSymbolParams) {
  const { container } = render(
    <TomLogo fontSize={FONT_SIZE} variant="bars" symbolParams={params} />,
  );
  const rects = Array.from(container.querySelectorAll("rect"));
  expect(rects).toHaveLength(4);
  const num = (el: Element, attr: string) => Number(el.getAttribute(attr));
  return {
    stemW:      num(rects[0], "width"),
    barThick:   num(rects[3], "height"),
    // Top bar's distance above the baseline, undoing the half-stroke centering.
    topBarY:    SYMBOL_H - num(rects[2], "y") - num(rects[3], "height") / 2,
    baselineY:  num(rects[3], "y"),
    symbolViewBox: container.querySelector("svg svg")!.getAttribute("viewBox"),
  };
}

describe("TomLogo bars variant", () => {
  it("renders the shipped default composition unchanged", () => {
    const b = bars(DEFAULT_TOM_PARAMS);
    // The old constants: stroke 43 and t-bar 269.5 over a 383-unit symbol.
    expect(b.barThick).toBeCloseTo((43 / 383) * SYMBOL_H, 6);
    expect(b.topBarY).toBeCloseTo((269.5 / 383) * SYMBOL_H, 6);
    expect(b.baselineY).toBeCloseTo(SYMBOL_H, 6);
    expect(b.symbolViewBox).toBe("70 78.5 500 383");
  });

  it("matches the default composition when symbolParams is omitted", () => {
    expect(bars()).toEqual(bars(DEFAULT_TOM_PARAMS));
  });

  it("thickens the bars when the stroke param grows", () => {
    const wide = { ...DEFAULT_TOM_PARAMS, stroke: 68 };
    const b = bars(wide);
    // Symbol height is 2R + stroke = 340 + 68, and the crop follows it.
    expect(b.barThick).toBeCloseTo((68 / 408) * SYMBOL_H, 6);
    expect(b.stemW).toBeCloseTo(b.barThick, 6);
    expect(b.symbolViewBox).toBe("70 66 500 408");
    expect(b.barThick).toBeGreaterThan(bars(DEFAULT_TOM_PARAMS).barThick);
  });

  it("raises the top bar when the t-bar height param rises", () => {
    const high = { ...DEFAULT_TOM_PARAMS, tHeight: -120 };
    const b = bars(high);
    // baseY - barY = (270 + 170 + 43/2) - (270 - 120) = 311.5, over 383.
    expect(b.topBarY).toBeCloseTo((311.5 / 383) * SYMBOL_H, 6);
    expect(b.topBarY).toBeGreaterThan(bars(DEFAULT_TOM_PARAMS).topBarY);
  });

  it("leaves the bars unmoved by params the bars do not depend on", () => {
    const base = bars(DEFAULT_TOM_PARAMS);
    const tilted = bars({ ...DEFAULT_TOM_PARAMS, mAngle: 50, dotSize: 90 });
    expect(tilted.barThick).toBeCloseTo(base.barThick, 6);
    expect(tilted.topBarY).toBeCloseTo(base.topBarY, 6);
  });
});

// Regression: fontReady was Promise.all(fonts.load, fonts.ready) with no
// catch. Where a face in the family fails to load (local("Arial") on a system
// without it) the load rejects, the measurement never ran, and the wordmark
// kept the estimated letter widths, so its letters overlapped on a wider face.
describe("TomLogo measurement when a font fails to load", () => {
  const WIDTHS: Record<string, number> = { t: 70, om: 140, ues: 160 };
  afterEach(() => {
    vi.restoreAllMocks();
    delete (document as { fonts?: unknown }).fonts;
  });

  it("measures the letters once both the failed load and `ready` have settled, and lays the wordmark out from the measured widths", async () => {
    let fontsReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => { fontsReady = resolve; });
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: () => Promise.reject(new Error("local(\"Arial\") failed to load")), ready },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { width: WIDTHS[this.textContent ?? ""] ?? 0 } as DOMRect;
    });
    const { container } = render(<TomLogo fontSize={FONT_SIZE} variant="plain" />);
    const xOf = (word: string) => Number(Array.from(container.querySelectorAll("text")).filter((el) => el.textContent === word).map((el) => el.getAttribute("x"))[0]);
    const tXs = () => Array.from(container.querySelectorAll("text")).filter((el) => el.textContent === "t").map((el) => Number(el.getAttribute("x")));
    // The load has failed, `ready` has not settled: the widths are still the
    // estimate (1.453 em for "ues").
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(Math.max(...tXs()) - xOf("ues")).toBeCloseTo(1.453 * FONT_SIZE, 6);
    fontsReady();
    // The measured width of "ues" is 160, of "t" 70.
    await waitFor(() => expect(Math.max(...tXs()) - xOf("ues")).toBeCloseTo(WIDTHS.ues, 6));
    expect(xOf("om") - Math.min(...tXs())).toBeCloseTo(WIDTHS.t, 6);
  });
});
