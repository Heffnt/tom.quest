// Regression: the color-mode label-prefix rule was written twice and the two
// copies drifted. control-panel.tsx stripped /^(Ground truth|Predictions?) — /
// inline; point-hover-tooltip.tsx had a stripPredictionLabel helper that
// stripped only the prediction family. Both now call
// stripColorModeFamilyPrefix. This test renders the two surfaces over one
// manifest and fails if they ever disagree about a mode's label again.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ControlPanel } from "./control-panel";
import { PointHoverTooltip } from "./point-hover-tooltip";
import type { ColorMode, Manifest, ParsedCloud } from "./lib/types";

const PALETTE = [{ id: 0, name: "floor", color: [1, 2, 3] as [number, number, number] }];

const MODES: ColorMode[] = [
  { id: "gt_top", label: "Ground truth — top", channel: "gt_top", palette: PALETTE },
  {
    id: "pred_floor_pole",
    label: "Predictions — Floor + pole detector",
    channel: "pred_floor_pole",
    palette: PALETTE,
  },
];

const MANIFEST: Manifest = {
  version: 1,
  centroid: [0, 0, 0],
  split_plane: { axis: "x", axis_index: 0, value: 0 },
  clouds: { train: { url: "train.bin", n: 1, n_full: 1 } },
  color_modes: MODES,
};

const CLOUD: ParsedCloud = {
  n: 1,
  channels: {
    gt_top: new Uint8Array([0]),
    pred_floor_pole: new Uint8Array([0]),
  },
  xyz: new Float32Array([0, 0, 0]),
};

function renderControlPanel() {
  return render(
    <ControlPanel
      cloudVisibility={{ train: true, test: false }}
      setCloudVisibility={() => {}}
      cloudMeta={{}}
      colorModes={MODES}
      activeMode="pred_floor_pole"
      setActiveMode={() => {}}
      pointRatio={0.5}
      setPointRatio={() => {}}
      cloudSizes={{}}
      pointSize={1}
      setPointSize={() => {}}
      moveSpeed={1}
      setMoveSpeed={() => {}}
      lookSpeed={1}
      setLookSpeed={() => {}}
      showSplitPlane={false}
      setShowSplitPlane={() => {}}
      showTooltip
      setShowTooltip={() => {}}
      onResetCamera={() => {}}
    />,
  );
}

function renderTooltip() {
  return render(
    <PointHoverTooltip
      point={{ index: 0, cloudKey: "train", xyz: [0, 0, 0], clientX: 0, clientY: 0 }}
      cloud={CLOUD}
      manifest={MANIFEST}
      activeMode={MODES[1]}
    />,
  );
}

describe("color-mode labels across the clouds surfaces", () => {
  it("drops the family prefix in the control panel", () => {
    renderControlPanel();
    expect(screen.getByText("top")).toBeTruthy();
    expect(screen.getByText("Floor + pole detector")).toBeTruthy();
    expect(screen.queryByText("Ground truth — top")).toBeNull();
    expect(screen.queryByText("Predictions — Floor + pole detector")).toBeNull();
  });

  it("drops the family prefix in the hover tooltip too", () => {
    renderTooltip();
    expect(screen.getByText("Floor + pole detector")).toBeTruthy();
    expect(screen.queryByText("Predictions — Floor + pole detector")).toBeNull();
  });

  it("names the same mode identically in both surfaces", () => {
    renderControlPanel();
    const inPanel = screen.getByText("Floor + pole detector").textContent;
    renderTooltip();
    const both = screen.getAllByText((_, el) => el?.textContent === inPanel);
    // Same string reached both trees: the panel's radio row and the tooltip row.
    expect(both.length).toBeGreaterThanOrEqual(2);
  });
});
