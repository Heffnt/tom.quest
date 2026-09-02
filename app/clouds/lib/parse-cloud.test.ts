import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { checkManifestVersion, fetchManifest } from "./parse-cloud";
import { SUPPORTED_MANIFEST_VERSION, type Manifest } from "./types";

const COMMITTED_MANIFEST_PATH = path.join(
  process.cwd(),
  "public/data/clouds/manifest.json",
);

function readCommittedManifest(): Manifest {
  return JSON.parse(readFileSync(COMMITTED_MANIFEST_PATH, "utf8")) as Manifest;
}

function respondWith(body: unknown) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("manifest version check", () => {
  it("accepts the supported version", () => {
    const body = { version: SUPPORTED_MANIFEST_VERSION, color_modes: [] };
    expect(checkManifestVersion(body, "/data/clouds/manifest.json")).toBe(body);
  });

  it.each([
    ["a newer version", { version: SUPPORTED_MANIFEST_VERSION + 1 }],
    ["a string version", { version: "1" }],
    ["no version field at all", { color_modes: [] }],
    ["a non-object body", null],
  ])("refuses %s", (_label, body) => {
    expect(() => checkManifestVersion(body, "/data/clouds/manifest.json")).toThrow(
      /manifest version .* is not supported/,
    );
  });

  it("fetchManifest refuses a manifest whose format was bumped upstream", async () => {
    // The manifest is written by another repository and served as a static
    // file, so a format bump arrives with no code change. It must fail loudly.
    vi.stubGlobal("fetch", respondWith({ version: 2, color_modes: [] }));
    await expect(fetchManifest("/data/clouds/manifest.json")).rejects.toThrow(
      /manifest version 2 is not supported/,
    );
    vi.unstubAllGlobals();
  });

  it("fetchManifest returns the committed manifest unchanged", async () => {
    const committed = readCommittedManifest();
    vi.stubGlobal("fetch", respondWith(committed));
    await expect(fetchManifest("/data/clouds/manifest.json")).resolves.toEqual(
      committed,
    );
    vi.unstubAllGlobals();
  });
});

describe("committed manifest", () => {
  it("declares the version this page reads", () => {
    expect(readCommittedManifest().version).toBe(SUPPORTED_MANIFEST_VERSION);
  });

  it("has prediction modes without a metrics block, as ColorMode.metrics documents", () => {
    // Guards the corrected comment on ColorMode.metrics: metrics is absent for
    // more than the ground-truth modes, so nothing may treat a pred_* id as a
    // promise that metrics exists.
    const withoutMetrics = readCommittedManifest()
      .color_modes.filter((mode) => mode.metrics === undefined)
      .map((mode) => mode.id);
    expect(withoutMetrics).toEqual(
      expect.arrayContaining([
        "gt_top",
        "pred_pointnet",
        "pred_pointnet2",
        "pred_floor_pole",
        "pred_ransac_floor",
      ]),
    );
  });
});
