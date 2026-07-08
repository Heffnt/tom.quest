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
});
