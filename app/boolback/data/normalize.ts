// app/boolback/data/normalize.ts — raw snapshot JSON -> the ONE normalized Bundle.
//
// The CMT builder emits schema v2: a top-level `functions` map (one FunctionBlock
// per distinct function_hash), rows that reference it via identity.function_hash
// plus their on-disk identity.dir_path, and NO tree array. Older v1 blobs embed
// the full function block in every row and carry the tree array. Both normalize
// to the same in-memory Bundle:
//
//   v2 -> attach functions[function_hash] onto each row as row.function (a
//         SHARED REFERENCE, so 3k rows over 600 functions cost 600 blocks);
//         re-derive identity.node_path/chain_dirs from run_id; DERIVE the
//         dir-viewer tree from the rows' dir_path segments.
//   v1 -> dedupe the embedded blocks into a functions map (later rows re-point
//         at the first block per hash); dir_path = null; tree passes through.
//
// Both paths also inject the client-side synthetic "fn_hex" column (the compact
// arity:hex function text) into the FUNCTION column group so the column menus
// and table resolve it like any builder column.
//
// Fails loud on any other schema_version or a row referencing a missing function.

import type { Bundle, FunctionBlock, RunRow, TreeLevel, TreeNode } from "../lib/types";

interface RawEnvelope {
  schema_version?: unknown;
  meta?: unknown;
  metric_schema?: unknown;
  column_groups?: Bundle["column_groups"];
  friendly?: unknown;
  functions?: Record<string, FunctionBlock>;
  tree?: TreeNode[];
  rows?: unknown;
}

export function asBundle(json: unknown): Bundle {
  const raw = json as RawEnvelope | null;
  if (!raw || typeof raw !== "object") {
    throw new Error("snapshot is not a JSON object");
  }
  const version = raw.schema_version;
  if (version !== 1 && version !== 2) {
    throw new Error(`unsupported snapshot schema_version: ${String(version)}`);
  }
  if (!Array.isArray(raw.rows)) {
    throw new Error("snapshot has no rows array");
  }
  const rows = raw.rows as RunRow[];

  let functions: Record<string, FunctionBlock>;
  let tree: TreeNode[];
  if (version === 2) {
    functions = raw.functions ?? {};
    for (const row of rows) {
      const id = row.identity;
      const fn = functions[id.function_hash];
      if (!fn) {
        throw new Error(`row ${id.run_id} references missing function ${id.function_hash}`);
      }
      row.function = fn;
      if (id.dir_path === undefined) id.dir_path = null;
      id.node_path = id.run_id;
      id.chain_dirs = [
        `fn=${id.function_hash}`,
        `fn=${id.function_hash}/ds=${id.dataset_hash}`,
        id.run_id,
      ];
    }
    tree = deriveTree(rows);
  } else {
    functions = {};
    for (const row of rows) {
      const fh = row.identity.function_hash;
      const existing = functions[fh];
      if (existing) {
        row.function = existing; // share one block per function
      } else {
        functions[fh] = row.function;
      }
      row.identity.dir_path = null; // v1 has no on-disk path info
    }
    tree = raw.tree ?? [];
  }

  const column_groups = withFnHexColumn(raw.column_groups ?? []);

  return {
    schema_version: version,
    meta: raw.meta as Bundle["meta"],
    metric_schema: (raw.metric_schema ?? []) as Bundle["metric_schema"],
    column_groups,
    friendly: (raw.friendly ?? {
      column_labels: {},
      facet_labels: {},
      tuning_labels: {},
    }) as Bundle["friendly"],
    functions,
    tree,
    rows,
  };
}

/** Insert the synthetic compact-text column into the FUNCTION group after "arity". */
function withFnHexColumn(groups: Bundle["column_groups"]): Bundle["column_groups"] {
  return groups.map((g) => {
    if (g.group !== "FUNCTION" || g.columns.includes("fn_hex")) return g;
    const cols = [...g.columns];
    const at = cols.indexOf("arity");
    cols.splice(at === -1 ? 0 : at + 1, 0, "fn_hex");
    return { ...g, columns: cols };
  });
}

// ---------------------------------------------------------------------------
// v2 tree derivation — rebuild the dir-viewer tree from the rows themselves.
// Mirrors the v1 builder tree: fn -> dataset -> training, dirNames from
// identity.dir_path, "done" derived from status (training done iff the run is
// not in_progress; parents done iff all children are).
// ---------------------------------------------------------------------------

function nodeOf(dirName: string, path: string, level: TreeLevel): TreeNode {
  const parts = dirName.split("+");
  return {
    path,
    dirName,
    level,
    slug: parts.length >= 3 ? parts[1] : "",
    hash: parts[parts.length - 1],
    kind: level,
    done: true,
    run_ids: [],
    children: [],
  };
}

function deriveTree(rows: RunRow[]): TreeNode[] {
  const fnNodes = new Map<string, TreeNode>();
  const dsNodes = new Map<string, TreeNode>();

  for (const row of rows) {
    const id = row.identity;
    const segs = id.dir_path ? id.dir_path.split("/") : [];
    const [fnDir, dsDir, trDir] = [
      segs[0] ?? `function+${id.function_hash}`,
      segs[1] ?? `dataset+${id.dataset_hash}`,
      segs[2] ?? `training+${id.training_hash}`,
    ];
    const fnPath = `fn=${id.function_hash}`;
    const dsPath = `${fnPath}/ds=${id.dataset_hash}`;

    let fn = fnNodes.get(fnPath);
    if (!fn) {
      fn = nodeOf(fnDir, fnPath, "function");
      fnNodes.set(fnPath, fn);
    }
    let ds = dsNodes.get(dsPath);
    if (!ds) {
      ds = nodeOf(dsDir, dsPath, "dataset");
      dsNodes.set(dsPath, ds);
      fn.children.push(ds);
    }
    const tr = nodeOf(trDir, id.run_id, "training");
    tr.done = !row.status.in_progress;
    tr.run_ids = [id.run_id];
    ds.children.push(tr);
    ds.run_ids.push(id.run_id);
    fn.run_ids.push(id.run_id);
  }

  const byDirName = (a: TreeNode, b: TreeNode) =>
    a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0;
  const roots = [...fnNodes.values()].sort(byDirName);
  for (const fn of roots) {
    fn.children.sort(byDirName);
    for (const ds of fn.children) {
      ds.children.sort(byDirName);
      ds.done = ds.children.every((t) => t.done);
    }
    fn.done = fn.children.every((d) => d.done);
  }
  return roots;
}
