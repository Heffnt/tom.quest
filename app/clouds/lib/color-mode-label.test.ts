import { describe, expect, it } from "vitest";

import manifest from "@/public/data/clouds/manifest.json";

import { stripColorModeFamilyPrefix } from "./color-mode-label";

describe("stripColorModeFamilyPrefix", () => {
  it("strips the ground-truth prefix", () => {
    expect(stripColorModeFamilyPrefix("Ground truth — top")).toBe("top");
  });

  it("strips the prediction prefix, singular or plural", () => {
    expect(stripColorModeFamilyPrefix("Predictions — PointNet")).toBe("PointNet");
    expect(stripColorModeFamilyPrefix("Prediction — PointNet")).toBe("PointNet");
  });

  it("leaves an unprefixed label alone", () => {
    expect(stripColorModeFamilyPrefix("K-means XYZ")).toBe("K-means XYZ");
    expect(stripColorModeFamilyPrefix("PointNet++ (overlap + TTA)")).toBe(
      "PointNet++ (overlap + TTA)",
    );
  });

  it("only strips a prefix at the start, and only the family words", () => {
    expect(stripColorModeFamilyPrefix("Refined — Ground truth — top")).toBe(
      "Refined — Ground truth — top",
    );
    expect(stripColorModeFamilyPrefix("Groundwork — top")).toBe("Groundwork — top");
  });

  it("shortens exactly the manifest labels that name their family", () => {
    const stripped = manifest.color_modes
      .map((mode) => [mode.label, stripColorModeFamilyPrefix(mode.label)])
      .filter(([label, short]) => label !== short);
    expect(stripped).toEqual([
      ["Ground truth — top", "top"],
      ["Ground truth — mid", "mid"],
      ["Ground truth — leaf", "leaf"],
    ]);
  });
});
