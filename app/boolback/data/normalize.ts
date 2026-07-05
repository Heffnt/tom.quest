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
// and table resolve it like any builder column, and append the CLIENT-DERIVED
// anatomy scalars (interp_peak_layer/loc_width/depth_com @<kind>) to
// metric_schema — a separate per-name-guarded step, because those never come
// from the builder and must survive the per-method synthesis' all-or-nothing
// "@"-guard.
//
// Fails loud on any other schema_version or a row referencing a missing function.

import type {
  Bundle,
  MetricDtype,
  FunctionBlock,
  MetricSchemaEntry,
  RunRow,
  TreeLevel,
  TreeNode,
} from "../lib/types";
import {
  ANATOMY_BASES,
  METHOD_SEP,
  methodMetricName,
  methodMetricValue,
  rowLayerCount,
} from "../lib/method-metrics";

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

  const perMethod = withPerMethodMetrics(
    (raw.metric_schema ?? []) as MetricSchemaEntry[],
    withFnHexColumn(raw.column_groups ?? []),
    rows,
  );
  // Chained AFTER (never inside) the per-method step: its all-or-nothing
  // "@"-guard would erase these client-derived entries the day the builder
  // ships its first "@" name.
  const expanded = withAnatomyMetrics(perMethod.metric_schema, perMethod.column_groups, rows);

  return {
    schema_version: version,
    meta: raw.meta as Bundle["meta"],
    metric_schema: expanded.metric_schema,
    column_groups: expanded.column_groups,
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

// ---------------------------------------------------------------------------
// Per-method DEFENSE/INTERP/SCAN metrics ("asr_drop@beear") — synthesized from
// the rows when the builder didn't ship them, so older blobs get the same
// schema surface the newer builder emits (lib/method-metrics owns the naming).
// The generic scalars are headline rollups (asr_drop = BEST method on the run;
// interp = one headline kind), so their labels gain a qualifier once
// per-method siblings exist.
// ---------------------------------------------------------------------------

// base metric -> [group, label qualifier for the generic entry]
const PER_METHOD_BASE_INFO: Record<string, { group: string; genericNote: string }> = {
  asr_drop: { group: "DEFENSE", genericNote: "best method" },
  recovery_rate: { group: "DEFENSE", genericNote: "best method" },
  interp_measurement: { group: "INTERP", genericNote: "headline" },
  interp_null_control: { group: "INTERP", genericNote: "headline" },
  scan_auroc: { group: "SCAN", genericNote: "headline" },
  scan_far_at_frr: { group: "SCAN", genericNote: "headline" },
};

/** Observed per-method extents over the rows: base -> method -> [lo, hi]. */
function observedMethodExtents(rows: RunRow[]): Map<string, Map<string, [number, number]>> {
  const out = new Map<string, Map<string, [number, number]>>();
  const track = (base: string, method: string, v: number | null | undefined) => {
    if (typeof v !== "number") return;
    const byMethod = out.get(base) ?? new Map<string, [number, number]>();
    const ext = byMethod.get(method);
    byMethod.set(method, ext ? [Math.min(ext[0], v), Math.max(ext[1], v)] : [v, v]);
    out.set(base, byMethod);
  };
  for (const r of rows) {
    for (const m of r.defense?.methods ?? []) {
      track("asr_drop", m.method, m.asr_drop);
      track("recovery_rate", m.method, m.recovery_rate);
    }
    const measurements =
      r.interp?.measurements ??
      (r.interp?.measurement_kind
        ? [{
            kind: r.interp.measurement_kind,
            value: r.interp.value,
            null_control: r.interp.null_control,
          }]
        : []);
    for (const m of measurements) {
      track("interp_measurement", m.kind, m.value);
      track("interp_null_control", m.kind, m.null_control);
    }
    const scans =
      r.scan?.methods ??
      (r.scan?.method_family != null
        ? [{
            method: String(r.scan.method_family),
            auroc: r.scan.auroc,
            far_at_frr: r.scan.far_at_frr,
          }]
        : []);
    for (const m of scans) {
      track("scan_auroc", m.method, m.auroc);
      track("scan_far_at_frr", m.method, m.far_at_frr);
    }
  }
  return out;
}

/**
 * Expand metric_schema + column_groups with per-method entries. A no-op when
 * the builder already shipped any "@" name (its empirical extents are then
 * authoritative — computed over the whole tree, not this blob's rows).
 */
function withPerMethodMetrics(
  schema: MetricSchemaEntry[],
  groups: Bundle["column_groups"],
  rows: RunRow[],
): { metric_schema: MetricSchemaEntry[]; column_groups: Bundle["column_groups"] } {
  if (schema.some((e) => e.name.includes(METHOD_SEP))) {
    return { metric_schema: schema, column_groups: groups };
  }
  const observed = observedMethodExtents(rows);
  if (observed.size === 0) return { metric_schema: schema, column_groups: groups };

  const added: Record<string, string[]> = {}; // group -> new metric names, in order
  const metric_schema: MetricSchemaEntry[] = [];
  for (const entry of schema) {
    const info = PER_METHOD_BASE_INFO[entry.name];
    const byMethod = info ? observed.get(entry.name) : undefined;
    if (!info || !byMethod?.size) {
      metric_schema.push(entry);
      continue;
    }
    metric_schema.push({ ...entry, label: `${entry.label} (${info.genericNote})` });
    for (const [method, [lo, hi]] of [...byMethod.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const name = methodMetricName(entry.name, method);
      metric_schema.push({
        ...entry,
        name,
        label: `${entry.label} · ${method}`,
        // Same floor/ceiling the builder applies to fraction scalars, so a
        // degenerate single-value method still yields a sane slider range.
        min: Math.min(lo, 0),
        max: hi <= 1 ? 1 : hi,
      });
      (added[info.group] ??= []).push(name);
    }
  }

  const column_groups = groups.map((g) =>
    added[g.group] ? { ...g, columns: [...g.columns, ...added[g.group]] } : g,
  );
  return { metric_schema, column_groups };
}

// ---------------------------------------------------------------------------
// Derived anatomy scalars ("interp_peak_layer@linear_probe") — CLIENT-derived
// from each kind's layer_profile / single-layer locus (lib/method-metrics owns
// the math), so unlike the per-method back-fill above they are appended
// whenever the NAME is absent: idempotent on re-normalized bundles, and safe
// on (future) builder-shipped blobs, whose own entries win per name. Kept in
// group INTERP — no new MetricGroup, so ordering/columns plumbing is untouched.
// ---------------------------------------------------------------------------

// anatomy base -> synthesized-entry shape (labels keep the " · " prefix that
// collapseMethodEntries uses as the picker base label for parentless bases).
const ANATOMY_BASE_INFO: Record<
  (typeof ANATOMY_BASES)[number],
  { label: string; dtype: MetricDtype; format: string }
> = {
  interp_peak_layer: { label: "Peak layer", dtype: "count", format: "d" },
  interp_loc_width: { label: "Locus width", dtype: "count", format: "d" },
  interp_depth_com: { label: "Depth center of mass", dtype: "fraction", format: ".3f" },
};

/** Append schema entries + INTERP columns for observed (anatomy base, kind) pairs. */
function withAnatomyMetrics(
  schema: MetricSchemaEntry[],
  groups: Bundle["column_groups"],
  rows: RunRow[],
): { metric_schema: MetricSchemaEntry[]; column_groups: Bundle["column_groups"] } {
  // Extents tracked through the SAME accessor the chart/table/filters read,
  // so slider bounds can never disagree with cell values.
  const observed = new Map<string, Map<string, [number, number]>>();
  let maxLayers = 0; // max effective layer count over contributing rows
  for (const r of rows) {
    const kinds = new Set((r.interp?.measurements ?? []).map((m) => m.kind));
    let contributed = false;
    for (const kind of kinds) {
      for (const base of ANATOMY_BASES) {
        const v = methodMetricValue(r, { base, method: kind });
        if (v === null) continue;
        const byKind = observed.get(base) ?? new Map<string, [number, number]>();
        const ext = byKind.get(kind);
        byKind.set(kind, ext ? [Math.min(ext[0], v), Math.max(ext[1], v)] : [v, v]);
        observed.set(base, byKind);
        contributed = true;
      }
    }
    if (contributed) maxLayers = Math.max(maxLayers, rowLayerCount(r) ?? 0);
  }
  if (observed.size === 0) return { metric_schema: schema, column_groups: groups };

  const have = new Set(schema.map((e) => e.name));
  const metric_schema = [...schema];
  const added: string[] = [];
  for (const base of ANATOMY_BASES) {
    const byKind = observed.get(base);
    if (!byKind) continue;
    const info = ANATOMY_BASE_INFO[base];
    for (const [kind, [lo, hi]] of [...byKind.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const name = methodMetricName(base, kind);
      if (have.has(name)) continue; // idempotent; builder's own entry wins
      metric_schema.push({
        name,
        label: `${info.label} · ${kind}`,
        suite: "outcome",
        group: "INTERP",
        dtype: info.dtype,
        format: info.format,
        min: Math.min(lo, 0),
        // Counts span the model: peak in [0, n_layers-1], width up to n_layers
        // ("n_layers-ish observed"); fractions get the builder's 0..1 ceiling.
        max:
          info.dtype === "fraction"
            ? hi <= 1
              ? 1
              : hi
            : Math.max(hi, base === "interp_peak_layer" ? maxLayers - 1 : maxLayers),
      });
      added.push(name);
    }
  }
  if (added.length === 0) return { metric_schema, column_groups: groups };

  const column_groups = groups.map((g) =>
    g.group === "INTERP" ? { ...g, columns: [...g.columns, ...added] } : g,
  );
  return { metric_schema, column_groups };
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
