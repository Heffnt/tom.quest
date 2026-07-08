// Normalization tests: the v2 builder fixture and a synthetic v1 blob must
// both come out as the SAME in-memory Bundle shape (shared function refs,
// synthesized node_path/chain_dirs, a dir-viewer tree, the injected fn_hex
// column), and the compact hex text must match the classic encodings.

import { describe, it, expect } from "vitest";
import sample from "./sample-snapshot.json";
import { asBundle } from "./normalize";
import { fnHex, fnText } from "../lib/format";
import { ANATOMY_BASES } from "../lib/method-metrics";
import type { TreeNode } from "../lib/types";

describe("asBundle (v2 builder fixture)", () => {
  const bundle = asBundle(structuredClone(sample));

  it("attaches shared function refs onto every row", () => {
    expect(Object.keys(bundle.functions).length).toBeGreaterThan(0);
    for (const row of bundle.rows) {
      // identity: the row's function IS the map's block, not a copy
      expect(row.function).toBe(bundle.functions[row.identity.function_hash]);
      expect(row.function.activation.length).toBe(2 ** row.function.arity);
    }
  });

  it("synthesizes node_path and chain_dirs from run_id", () => {
    for (const row of bundle.rows) {
      const id = row.identity;
      expect(id.node_path).toBe(id.run_id);
      expect(id.chain_dirs).toEqual([
        `fn=${id.function_hash}`,
        `fn=${id.function_hash}/ds=${id.dataset_hash}`,
        id.run_id,
      ]);
    }
  });

  it("derives the dir-viewer tree from the rows' dir_path", () => {
    expect(bundle.tree.length).toBeGreaterThan(0);
    const leafPaths: string[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.level === "training") leafPaths.push(n.path);
        expect(n.dirName).toContain("+");
        walk(n.children);
      }
    };
    walk(bundle.tree);
    const runIds = new Set(bundle.rows.map((r) => r.identity.run_id));
    expect(new Set(leafPaths)).toEqual(runIds);
    // dirNames come from the real on-disk path segments
    expect(bundle.tree[0].dirName.startsWith("function+")).toBe(true);
  });

  it("injects the synthetic fn_hex column after arity in the FUNCTION group", () => {
    const fn = bundle.column_groups.find((g) => g.group === "FUNCTION")!;
    expect(fn.columns.indexOf("fn_hex")).toBe(fn.columns.indexOf("arity") + 1);
  });

  it("rejects unknown schema versions (v1/v2/v3 accepted)", () => {
    expect(() => asBundle({ schema_version: 4, rows: [] })).toThrow(/schema_version/);
    // v3 (reading-vocab snapshot) is accepted.
    expect(() => asBundle({ schema_version: 3, functions: {}, rows: [] })).not.toThrow();
  });
});

describe("legacy vocab airlock (measurement → reading)", () => {
  it("translates a v2 blob's interp.measurements / measurement_kind to reading vocab", () => {
    const fn = {
      arity: 1, truth_table: "01",
      activation: [
        { presence: [0], present_vars: [], activates: false },
        { presence: [1], present_vars: [0], activates: true },
      ],
      dnf_string: "A", complexity: {},
    };
    const blob = {
      schema_version: 2,
      meta: {},
      metric_schema: [
        { name: "interp_measurement", label: "Interp measurement", suite: "outcome", group: "INTERP", dtype: "fraction", min: 0, max: 1, format: ".3f" },
      ],
      column_groups: [{ group: "INTERP", columns: ["interp_measurement"] }],
      friendly: { column_labels: {}, facet_labels: {}, tuning_labels: {} },
      functions: { f1: fn },
      rows: [{
        identity: { run_id: "fn=f1/ds=d1/tr=t1", function_hash: "f1", dataset_hash: "d1", training_hash: "t1" },
        function: fn,
        status: { in_progress: false },
        interp: {
          measurement_kind: "linear_probe",
          value: 0.5,
          null_control: 0.1,
          reference_model_diff: null,
          measurements: [{ kind: "linear_probe", value: 0.5, null_control: 0.1 }],
        },
      }],
    };
    const b = asBundle(structuredClone(blob) as never);
    const interp = b.rows[0].interp!;
    expect(interp.reading_kind).toBe("linear_probe");
    expect(interp.readings).toEqual([{ kind: "linear_probe", value: 0.5, null_control: 0.1 }]);
    // schema + column names translated too
    expect(b.metric_schema.some((e) => e.name === "interp_reading")).toBe(true);
    expect(b.metric_schema.some((e) => e.name === "interp_measurement")).toBe(false);
    const grp = b.column_groups.find((g) => g.group === "INTERP")!;
    expect(grp.columns).toContain("interp_reading");
  });
});

describe("asBundle (v1 embedded-function blob)", () => {
  // A minimal v1 blob: two rows sharing one function, function embedded per
  // row, tree carried in the envelope.
  const fnBlock = {
    arity: 2,
    truth_table: "0001",
    activation: [
      { presence: [0, 0], present_vars: [], activates: false },
      { presence: [1, 0], present_vars: [0], activates: false },
      { presence: [0, 1], present_vars: [1], activates: false },
      { presence: [1, 1], present_vars: [0, 1], activates: true },
    ],
    dnf_string: "A&B",
    complexity: { num_clauses_dnf: 1 },
  };
  const rowOf = (tr: string) => ({
    identity: {
      run_id: `fn=f1/ds=d1/tr=${tr}`,
      function_hash: "f1",
      dataset_hash: "d1",
      training_hash: tr,
      node_path: `fn=f1/ds=d1/tr=${tr}`,
      chain_dirs: ["fn=f1", "fn=f1/ds=d1", `fn=f1/ds=d1/tr=${tr}`],
    },
    function: structuredClone(fnBlock),
    status: { in_progress: false },
  });
  const v1 = {
    schema_version: 1,
    meta: {},
    metric_schema: [],
    column_groups: [{ group: "FUNCTION", columns: ["arity", "truth_table", "dnf_string"] }],
    friendly: { column_labels: {}, facet_labels: {}, tuning_labels: {} },
    tree: [{ path: "fn=f1", dirName: "function+x+f1", level: "function", children: [] }],
    rows: [rowOf("t1"), rowOf("t2")],
  };
  const bundle = asBundle(structuredClone(v1));

  it("dedupes embedded function blocks into one shared ref", () => {
    expect(Object.keys(bundle.functions)).toEqual(["f1"]);
    expect(bundle.rows[0].function).toBe(bundle.rows[1].function);
    expect(bundle.rows[1].identity.dir_path).toBeNull();
  });

  it("passes the v1 tree through and injects fn_hex", () => {
    expect(bundle.tree[0].dirName).toBe("function+x+f1");
    const fn = bundle.column_groups.find((g) => g.group === "FUNCTION")!;
    expect(fn.columns).toContain("fn_hex");
  });
});

describe("per-method metric synthesis", () => {
  const bundle = asBundle(structuredClone(sample));

  it("synthesizes DEFENSE per-method entries from rows[].defense.methods", () => {
    const defended = bundle.rows.find((r) => (r.defense?.methods?.length ?? 0) > 0)!;
    const m = defended.defense!.methods.find((x) => typeof x.asr_drop === "number")!;
    const name = `asr_drop@${m.method}`;
    const entry = bundle.metric_schema.find((e) => e.name === name)!;
    expect(entry).toBeTruthy();
    expect(entry.group).toBe("DEFENSE");
    expect(entry.label).toContain(m.method);
    // fraction floor/ceiling like the builder's scalar entries
    expect(entry.min).toBeLessThanOrEqual(0);
    expect(entry.max).toBeGreaterThanOrEqual(m.asr_drop!);
    // the new name rides in the DEFENSE column group, right of the generics
    const grp = bundle.column_groups.find((g) => g.group === "DEFENSE")!;
    expect(grp.columns).toContain(name);
  });

  it("synthesizes INTERP per-kind entries and qualifies the generic labels", () => {
    const interp = bundle.rows.find((r) => r.interp?.reading_kind != null)!;
    const kind = interp.interp!.reading_kind!;
    expect(bundle.metric_schema.some((e) => e.name === `interp_reading@${kind}`)).toBe(true);
    const generic = bundle.metric_schema.find((e) => e.name === "interp_reading")!;
    expect(generic.label).toMatch(/headline/);
    const genericDrop = bundle.metric_schema.find((e) => e.name === "asr_drop")!;
    expect(genericDrop.label).toMatch(/best method/);
  });

  it("is a no-op when the builder already ships @-entries", () => {
    const raw = structuredClone(sample) as { metric_schema: Array<{ name: string }> };
    raw.metric_schema.push({
      name: "asr_drop@builder_method",
      label: "asr drop · builder method",
      suite: "outcome",
      group: "DEFENSE",
      dtype: "fraction",
      min: 0,
      max: 1,
      format: ".3f",
    } as never);
    const b = asBundle(raw);
    // Scoped to per-method synthesis: the client-DERIVED anatomy scalars
    // (interp_peak_layer/…@kind) deliberately survive this guard — they never
    // come from the builder — so they're excluded from the count.
    const atNames = b.metric_schema.filter(
      (e) =>
        e.name.includes("@") && !ANATOMY_BASES.some((base) => e.name.startsWith(`${base}@`)),
    );
    expect(atNames).toHaveLength(1); // only the builder's own entry
    expect(b.metric_schema.find((e) => e.name === "asr_drop")!.label).not.toMatch(/best method/);
  });

  it("synthesizes SCAN per-family entries from headline scan fields", () => {
    const raw = structuredClone(sample) as unknown as {
      rows: Array<{ scan: unknown; status: { has_scan: boolean } }>;
    };
    raw.rows[0].scan = { auroc: 0.9, far_at_frr: 0.2, method_family: "weight_probe", scheme: null };
    raw.rows[0].status.has_scan = true;
    const b = asBundle(raw as never);
    const entry = b.metric_schema.find((e) => e.name === "scan_auroc@weight_probe")!;
    expect(entry).toBeTruthy();
    expect(entry.group).toBe("SCAN");
    expect(b.rows.some((r) => r.scan !== null)).toBe(true);
  });
});

describe("anatomy derived-metric synthesis", () => {
  const bundle = asBundle(structuredClone(sample));

  it("synthesizes all three bases per observed kind with anatomy-shaped extents", () => {
    for (const base of ANATOMY_BASES) {
      const entry = bundle.metric_schema.find((e) => e.name === `${base}@linear_probe`)!;
      expect(entry).toBeTruthy();
      expect(entry.group).toBe("INTERP");
      expect(entry.label).toContain("linear_probe");
    }
    // counts span the LARGEST contributing model (multi-model demo roster:
    // linear_probe measurements exist up to the qwen72 rows' n_layers 80)…
    const peak = bundle.metric_schema.find((e) => e.name === "interp_peak_layer@linear_probe")!;
    expect(peak.dtype).toBe("count");
    expect(peak.format).toBe("d");
    expect(peak.min).toBe(0);
    expect(peak.max).toBe(79);
    const width = bundle.metric_schema.find((e) => e.name === "interp_loc_width@linear_probe")!;
    expect(width.dtype).toBe("count");
    expect(width.max).toBe(80);
    // …and the normalized depth rides the builder's fraction floor/ceiling
    const com = bundle.metric_schema.find((e) => e.name === "interp_depth_com@linear_probe")!;
    expect(com.dtype).toBe("fraction");
    expect(com.format).toBe(".3f");
    expect(com.min).toBe(0);
    expect(com.max).toBe(1);
  });

  it("appends the new names to the INTERP column group", () => {
    const grp = bundle.column_groups.find((g) => g.group === "INTERP")!;
    for (const base of ANATOMY_BASES) {
      expect(grp.columns).toContain(`${base}@linear_probe`);
    }
  });

  it("derives nothing for kinds without locus data (global / circuit loci)", () => {
    for (const base of ANATOMY_BASES) {
      expect(bundle.metric_schema.some((e) => e.name === `${base}@weight_norm_diff`)).toBe(false);
      expect(bundle.metric_schema.some((e) => e.name === `${base}@circuit`)).toBe(false);
    }
  });

  it("survives builder-shipped @-entries (unlike the per-method back-fill)", () => {
    const raw = structuredClone(sample) as { metric_schema: Array<{ name: string }> };
    raw.metric_schema.push({
      name: "asr_drop@builder_method",
      label: "asr drop · builder method",
      suite: "outcome",
      group: "DEFENSE",
      dtype: "fraction",
      min: 0,
      max: 1,
      format: ".3f",
    } as never);
    const b = asBundle(raw as never);
    expect(b.metric_schema.some((e) => e.name === "interp_peak_layer@linear_probe")).toBe(true);
  });

  it("keeps a builder-shipped anatomy entry authoritative (per-name guard)", () => {
    const raw = structuredClone(sample) as { metric_schema: Array<{ name: string }> };
    raw.metric_schema.push({
      name: "interp_peak_layer@linear_probe",
      label: "Peak layer · linear_probe",
      suite: "outcome",
      group: "INTERP",
      dtype: "count",
      min: 0,
      max: 99,
      format: "d",
    } as never);
    const b = asBundle(raw as never);
    const entries = b.metric_schema.filter((e) => e.name === "interp_peak_layer@linear_probe");
    expect(entries).toHaveLength(1);
    expect(entries[0].max).toBe(99); // the builder's empirical extents win
    // sibling bases the builder did NOT ship are still filled in
    expect(b.metric_schema.some((e) => e.name === "interp_loc_width@linear_probe")).toBe(true);
  });

  it("is idempotent when re-normalizing an already-expanded bundle", () => {
    const again = asBundle(structuredClone(bundle) as never);
    expect(again.metric_schema.map((e) => e.name)).toEqual(
      bundle.metric_schema.map((e) => e.name),
    );
    const grp = again.column_groups.find((g) => g.group === "INTERP")!;
    expect(new Set(grp.columns).size).toBe(grp.columns.length);
  });
});

describe("fnHex compact text", () => {
  it("encodes the arity-3 majority as the classic E8", () => {
    // rows LSB-first: f=1 on 110,101,011,111 -> "00010111"
    expect(fnHex("00010111")).toBe("E8");
    expect(fnText(3, "00010111")).toBe("3:E8");
  });

  it("pads to the arity's nibble width", () => {
    expect(fnHex("0001")).toBe("8"); // arity-2 AND -> one nibble
    expect(fnHex("0000000000000001").length).toBe(4); // arity 4 -> 4 nibbles
    expect(fnHex("1".repeat(32))).toBe("FFFFFFFF"); // arity 5 -> 8 nibbles
  });

  it("passes non-binary strings through untouched", () => {
    expect(fnHex("-")).toBe("-");
  });
});
