// Normalization tests: the v2 builder fixture and a synthetic v1 blob must
// both come out as the SAME in-memory Bundle shape (shared function refs,
// synthesized node_path/chain_dirs, a dir-viewer tree, the injected fn_hex
// column), and the compact hex text must match the classic encodings.

import { describe, it, expect } from "vitest";
import sample from "./sample-snapshot.json";
import { asBundle } from "./normalize";
import { fnHex, fnText } from "../lib/format";
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

  it("rejects unknown schema versions", () => {
    expect(() => asBundle({ schema_version: 3, rows: [] })).toThrow(/schema_version/);
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
