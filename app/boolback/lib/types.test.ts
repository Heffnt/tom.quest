// Config-sanitizer tests — the persisted-blob airlock. The page-refresh path
// runs every saved view config through sanitizePlotConfig, so per-setting
// styling must survive it (and a PRE-STYLE blob must heal to the defaults
// without being dropped).

import { describe, it, expect } from "vitest";
import {
  DEFAULT_PLOT, DEFAULT_SETTING_STYLE,
  sanitizePlotConfig, sanitizeSettingStyle, isDefaultPlotConfig,
} from "./types";

describe("sanitizeSettingStyle", () => {
  it("defaults a missing / non-object blob", () => {
    expect(sanitizeSettingStyle(undefined)).toEqual(DEFAULT_SETTING_STYLE);
    expect(sanitizeSettingStyle("nope")).toEqual(DEFAULT_SETTING_STYLE);
    expect(sanitizeSettingStyle([1, 2])).toEqual(DEFAULT_SETTING_STYLE);
  });

  it("keeps valid fields and heals invalid ones independently", () => {
    expect(sanitizeSettingStyle({ shape: 3, size: 1.5, opacity: 0.4, dash: 2 }))
      .toEqual({ shape: 3, size: 1.5, opacity: 0.4, dash: 2 });
    expect(sanitizeSettingStyle({ shape: "square", size: NaN, opacity: 0.4, dash: 2 }))
      .toEqual({ shape: null, size: 1, opacity: 0.4, dash: 2 });
  });

  it("clamps out-of-range values", () => {
    const s = sanitizeSettingStyle({ size: 99, opacity: -1, shape: 2.6, dash: -3 });
    expect(s.size).toBeLessThanOrEqual(4);
    expect(s.opacity).toBeGreaterThan(0);
    expect(s.shape).toBe(3); // rounded
    expect(s.dash).toBe(0); // floored at 0
  });
});

describe("sanitizePlotConfig — style persistence", () => {
  it("a styled setting round-trips a persisted-blob pass verbatim", () => {
    const cfg = sanitizePlotConfig({
      settings: [{
        id: "s1", name: "styled", color: "#38bdf8",
        style: { shape: 1, size: 2, opacity: 0.3, dash: 1 },
        filters: { facets: { dataset: ["sst2"] }, ranges: [] },
      }],
    });
    expect(cfg.settings[0].style).toEqual({ shape: 1, size: 2, opacity: 0.3, dash: 1 });
  });

  it("a PRE-STYLE persisted blob heals to default styling (still counts as the pristine default)", () => {
    // Exactly what an old saved boolback:plot blob looks like — no style key.
    const old = JSON.parse(JSON.stringify(DEFAULT_PLOT)) as Record<string, unknown>;
    for (const s of old.settings as Array<Record<string, unknown>>) delete s.style;
    const cfg = sanitizePlotConfig(old);
    expect(cfg.settings[0].style).toEqual(DEFAULT_SETTING_STYLE);
    // …and the healed default is still recognized as pristine, so first-load
    // hydration may install the dominant-cell default.
    expect(isDefaultPlotConfig(cfg)).toBe(true);
  });
});
