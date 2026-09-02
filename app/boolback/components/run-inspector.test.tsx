// Smoke tests for the run inspector: resolveRun resolution against the real
// builder fixture, plus a render pass that exercises all five sections.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import sample from "../data/sample-snapshot.json";
import { asBundle } from "../data/normalize";
import { indexMetricSchema } from "../lib/metrics";
import type { RunRow } from "../lib/types";
import { RunInspector, resolveRun } from "./run-inspector";

const bundle = asBundle(sample);
const index = indexMetricSchema(bundle.metric_schema);

describe("resolveRun", () => {
  it("returns null for a null selection", () => {
    expect(resolveRun(bundle, null)).toBeNull();
  });

  it("resolves an exact node_path to its run", () => {
    const target = bundle.rows[0];
    const got = resolveRun(bundle, target.identity.node_path);
    expect(got?.identity.run_id).toBe(target.identity.run_id);
  });

  it("resolves a partial chain dir to a run whose chain intersects it", () => {
    const target = bundle.rows[0];
    const parent = target.identity.chain_dirs[0]; // fn=H level
    const got = resolveRun(bundle, parent);
    expect(got).not.toBeNull();
    expect(got?.identity.chain_dirs).toContain(parent);
  });

  it("returns null when nothing resolves", () => {
    expect(resolveRun(bundle, "no-such-dir")).toBeNull();
  });
});

describe("RunInspector", () => {
  // Null dir_path so FilesSection renders its fallback text instead of the
  // fetch-backed ArtifactBrowser (no network in jsdom).
  const run: RunRow = {
    ...bundle.rows[0],
    identity: { ...bundle.rows[0].identity, dir_path: null },
  };

  it("renders the five sections and a working back button", () => {
    let backs = 0;
    render(
      <RunInspector
        run={run}
        bundle={bundle}
        index={index}
        dir="artifacts"
        onBack={() => {
          backs += 1;
        }}
      />,
    );

    // header + section titles
    expect(screen.getByText("parameters")).toBeTruthy();
    expect(screen.getByText("outcomes")).toBeTruthy();
    expect(screen.getByText("methods")).toBeTruthy();
    expect(screen.getByText("files")).toBeTruthy();

    // back button present and callable
    const back = screen.getByLabelText("Back to configuration");
    back.click();
    expect(backs).toBe(1);
  });

  // REGRESSION: the anatomy section is mounted here by an import line alone,
  // and it went missing for months when detail-panel.tsx was renamed to
  // run-inspector.tsx and the import was not carried across. Nothing failed —
  // an unimported component is silently absent, not an error — so only a test
  // that asserts it RENDERS catches the next rename that drops it. The pane's
  // marker click (anatomy-pane.tsx: setAnatomy({sel}) + openDetail) is the
  // other half of that contract and is dead without this mount.
  it("mounts the anatomy section for a run that has interp readings", () => {
    const withReadings: RunRow = {
      ...run,
      n_layers: 8,
      interp: {
        readings: [
          { kind: "probe", value: 0.5, null_control: 0.1, layer: 3, locus_shape: "point" },
          { kind: "logit_lens", value: 0.3, null_control: 0.1, locus_component: "unembed" },
        ],
      },
    } as unknown as RunRow;

    const { container } = render(
      <RunInspector
        run={withReadings}
        bundle={bundle}
        index={index}
        dir="artifacts"
        onBack={() => {}}
      />,
    );

    expect(container.querySelector("[data-anatomy-section]")).toBeTruthy();
    expect(screen.getByText(/anatomy · 2 measurements/)).toBeTruthy();
  });

  // The section must stay absent (null, not an empty shell) when a run has no
  // interp block at all. Note this is NOT the sample rows: those carry a
  // legacy flat measurement that the normalize airlock turns into one reading,
  // so they DO get a one-measurement section.
  it("renders no anatomy section for a run with no interp block", () => {
    const noInterp = { ...run, interp: undefined } as unknown as RunRow;
    const { container } = render(
      <RunInspector
        run={noInterp}
        bundle={bundle}
        index={index}
        dir="artifacts"
        onBack={() => {}}
      />,
    );

    expect(container.querySelector("[data-anatomy-section]")).toBeNull();
  });

  // The legacy path is the one that actually fires on today's snapshot, so it
  // gets its own assertion rather than riding on the two-reading fixture.
  it("mounts a one-measurement anatomy section for a legacy flat interp row", () => {
    const { container } = render(
      <RunInspector
        run={run}
        bundle={bundle}
        index={index}
        dir="artifacts"
        onBack={() => {}}
      />,
    );

    expect(container.querySelector("[data-anatomy-section]")).toBeTruthy();
    expect(screen.getByText(/anatomy · 1 measurement/)).toBeTruthy();
  });
});
