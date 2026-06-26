// app/boolback/data/real.ts — load the REAL turing artifact tree from the
// bundled gzip snapshot and project it into a FixtureBundle the panes consume.
//
// The snapshot (public/boolback/turing-snapshot.json.gz) is the FULL real tree
// (37,843 tree nodes, 2,655 experiments), gzip-compressed (~362KB on the wire,
// ~15MB JSON). We decompress in-browser via DecompressionStream('gzip').
//
// Shape contract (from the asset spec):
//   meta: { source, treeNodeCount, experimentCount, axes:{...}, sampleArity4 }
//   tree: a fully-formed TreeNode EXCEPT it carries NO `path` (the snapshot
//     predates path-based identity) — we assign it during the walk below.
//   experiments: every ExperimentRow field EXCEPT metrics ({} — we fill it from
//     the truth-table complexity vector) PLUS an extra per-row epochAsr map
//     { "<epoch>": <asr number> } giving the per-epoch ASR trajectory.
//
// IDENTITY (the whole point of this loader): a real node's `dirName` is content-
// addressed over ITS OWN config only, so e.g. every function's
// "dataset+...sst2...+HASH" / "training+...+HASH" / "inference+..." / "scoring+
// keyword+HASH" dirName is BYTE-IDENTICAL across functions — dirName collapses
// ~38k nodes to ~2.2k keys. Only "function+<tt>+HASH" is unique. So we assign
// each node a globally-unique `path` = the cumulative chain of dirNames root->
// node (joined by "/"), unique because the function segment is unique, and key
// nodeIndex / selection / expansion off `path`.
//
// The snapshot experiments carry `chainDirs` as a BARE segment list
//   ["artifacts","function+…","dataset+…","training+…","inference+…","scoring+…"]
// which (a) is NOT unique and (b) OMITS the epoch-N group that actually sits
// between training and inference in the tree. We RECOMPUTE each experiment's
// chainDirs/scoringDir as the real cumulative PATH KEYS of the node it maps to
// (descending into the FINAL epoch group, since an ExperimentRow is the final-
// epoch cut), so scoringDir === a real scoring node's `path` and chainDirs are
// exactly that node's ancestor path chain (function->scoring).
//
// We keep ExperimentRow type-clean: epochAsr is stripped off the rows into a
// side Map keyed by rowId and consumed only while building the tidy trajectory
// rows (so the DAG epoch-ASR polyline renders for real data exactly as it does
// for the synthetic fixture). The DAG keys per-epoch ASR by a PATH-SCOPED key
// (the training node path) — NOT bare trainingHash, which is shared across many
// functions in the real data — emitted on each tidy row's trainingHash field as
// the training node's path so dag-pane's resolver scopes to the right subtree.

import type { TreeNode, TidyRow, ExperimentRow, GroupKind } from "../lib/types";
import {
  type FixtureBundle, computeComplexity, ttFromSlug, indexNodes,
} from "./fixture";

const SNAPSHOT_URL = "/boolback/turing-snapshot.json.gz";

// ---------------------------------------------------------------------------
// On-wire snapshot shape (narrow — only what we read).
// ---------------------------------------------------------------------------

export interface SnapshotMeta {
  source: string;
  treeNodeCount: number;
  experimentCount: number;
  axes: {
    baseModels: string[];
    sources: string[];
    judges: string[];
  };
  sampleArity4: unknown;
}

// The snapshot tree node matches TreeNode EXCEPT `path` is absent on the wire;
// we widen locally to a path-optional node and assign `path` during the walk.
type SnapshotNode = Omit<TreeNode, "path" | "children"> & {
  path?: string;
  children: SnapshotNode[];
};

// The snapshot experiment row is a full ExperimentRow with metrics:{} plus an
// extra epochAsr map; we widen locally so reading the excess field is type-safe.
type SnapshotExperiment = ExperimentRow & {
  epochAsr?: Record<string, number>;
};

interface Snapshot {
  meta: SnapshotMeta;
  tree: SnapshotNode;
  experiments: SnapshotExperiment[];
}

// Valid group kinds — any unknown groupKind on a real node is coerced to null
// so it renders as a transparent group rather than mis-typing the tree.
const VALID_GROUP_KINDS = new Set<GroupKind>([
  "backdoor", "filler", "test", "scans", "defenses", "interp",
  "lora", "full", "epoch", "row",
]);

// Assign every node a cumulative `path` (root->node) AND coerce unknown
// groupKinds to null in the same single walk. Mutates in place and returns the
// node typed as a fully-formed TreeNode (path now present).
function assignPathsAndCoerce(node: SnapshotNode, parentPath: string | null): TreeNode {
  node.path = parentPath ? `${parentPath}/${node.dirName}` : node.dirName;
  if (node.groupKind !== null && !VALID_GROUP_KINDS.has(node.groupKind)) {
    node.groupKind = null;
  }
  for (const child of node.children) assignPathsAndCoerce(child, node.path);
  return node as unknown as TreeNode;
}

// ---------------------------------------------------------------------------
// Experiment chain resolution: map a snapshot experiment (bare chainDirs) to
// the real cumulative path keys of the node it represents.
// ---------------------------------------------------------------------------

function epochNumber(dirName: string): number {
  const m = /(\d+)/.exec(dirName);
  return m ? Number(m[1]) : -1;
}

interface ResolvedChain {
  chainDirs: string[];   // ancestor path keys function->scoring (root excluded)
  scoringDir: string;    // the scoring node's path (=== last chainDirs entry)
  trainingPath: string;  // path-scoped key for per-epoch ASR (training node path)
}

/**
 * Walk the real tree following the experiment's bare chainDirs segments
 * [artifacts, function, dataset, training, inference, scoring], descending into
 * the FINAL epoch-N group (an ExperimentRow is the final-epoch cut) so the
 * resolved scoring node path matches a real tree node. Returns null when the
 * chain cannot be resolved (defensive — every real experiment resolves).
 */
function resolveChain(root: TreeNode, bare: string[]): ResolvedChain | null {
  // bare: [artifacts, function+, dataset+, training+, inference+, scoring+]
  if (bare.length < 6) return null;
  const [, fnDir, dsDir, trDir, infDir, scDir] = bare;

  const fnNode = root.children.find((c) => c.dirName === fnDir);
  if (!fnNode) return null;
  const dsNode = fnNode.children.find((c) => c.dirName === dsDir);
  if (!dsNode) return null;
  const trNode = dsNode.children.find((c) => c.dirName === trDir);
  if (!trNode) return null;

  // training -> epoch-N groups; pick the FINAL epoch whose inference/scoring
  // dirNames match the experiment's bare inference/scoring segments.
  const matchingEpochs = trNode.children.filter(
    (ep) =>
      ep.groupKind === "epoch" &&
      ep.children.some(
        (inf) =>
          inf.dirName === infDir &&
          inf.children.some((sc) => sc.dirName === scDir),
      ),
  );
  if (matchingEpochs.length === 0) return null;
  const epNode = matchingEpochs.reduce((a, b) =>
    epochNumber(a.dirName) >= epochNumber(b.dirName) ? a : b,
  );
  const infNode = epNode.children.find(
    (inf) => inf.dirName === infDir && inf.children.some((sc) => sc.dirName === scDir),
  )!;
  const scNode = infNode.children.find((sc) => sc.dirName === scDir)!;

  return {
    // function->scoring cumulative path keys (root "artifacts" excluded, to
    // mirror the synthetic fixture's chainDirs which start at the function).
    chainDirs: [fnNode.path, dsNode.path, trNode.path, epNode.path, infNode.path, scNode.path],
    scoringDir: scNode.path,
    trainingPath: trNode.path,
  };
}

// ---------------------------------------------------------------------------
// Module-cached meta from the most recent successful load.
// ---------------------------------------------------------------------------

let _meta: SnapshotMeta | null = null;
export function getSnapshotMeta(): SnapshotMeta | null {
  return _meta;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loadRealBundle(): Promise<FixtureBundle> {
  const res = await fetch(SNAPSHOT_URL);
  if (!res.ok) {
    throw new Error(`failed to fetch ${SNAPSHOT_URL}: ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error(`no response body for ${SNAPSHOT_URL}`);
  }

  // gunzip the stream and read it to text.
  const decompressed = res.body.pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(decompressed).text();
  const snapshot = JSON.parse(text) as Snapshot;

  _meta = snapshot.meta;

  // root tree: assign cumulative `path` on every node (the globally-unique
  // identity) and coerce any unknown groupKind to null, in a single walk.
  const root = assignPathsAndCoerce(snapshot.tree, null);

  // experiments: fill the empty metrics from the truth-table complexity vector,
  // strip the extra epochAsr field into a side map for tidy-building, and
  // RECOMPUTE chainDirs/scoringDir as real cumulative path keys (descending into
  // the final epoch group). Carry the training node path alongside for the
  // path-scoped per-epoch ASR tidy key.
  const epochAsrByRow = new Map<string, Record<string, number>>();
  const trainingPathByRow = new Map<string, string>();
  const experiments: ExperimentRow[] = snapshot.experiments.map((e) => {
    const { epochAsr, ...row } = e;
    if (epochAsr) epochAsrByRow.set(row.rowId, epochAsr);
    const resolved = resolveChain(root, row.chainDirs);
    if (resolved) trainingPathByRow.set(row.rowId, resolved.trainingPath);
    return {
      ...row,
      // path-based identity keys (fall back to the bare values only if a chain
      // fails to resolve, which does not happen for the bundled snapshot).
      scoringDir: resolved ? resolved.scoringDir : row.scoringDir,
      chainDirs: resolved ? resolved.chainDirs : row.chainDirs,
      metrics: computeComplexity(ttFromSlug(row.truthTable), false).metrics,
    };
  });

  // tidy: one asr TidyRow per epoch per experiment, in the EXACT shape the DAG
  // epoch polyline reads (epochSeriesFor). The DAG keys per-epoch ASR by a
  // PATH-SCOPED key because the real trainingHash is shared across functions;
  // we emit the TRAINING NODE PATH on the trainingHash field so dag-pane's
  // path-scoped resolver (training node path) finds exactly this chain's ASR.
  const tidy: TidyRow[] = [];
  for (const e of experiments) {
    const epochAsr = epochAsrByRow.get(e.rowId);
    if (!epochAsr) continue;
    const trainingPath = trainingPathByRow.get(e.rowId) ?? e.trainingHash;
    for (const [epochKey, asr] of Object.entries(epochAsr)) {
      const epoch = Number(epochKey);
      if (!Number.isFinite(epoch) || typeof asr !== "number") continue;
      tidy.push({
        functionHash: e.functionHash,
        datasetHash: e.datasetHash,
        // PATH-SCOPED key (the training node's path), not the shared hash.
        trainingHash: trainingPath,
        epoch,
        inferenceHash: e.inferenceHash,
        scoringHash: e.scoringHash,
        ttRow: "-",
        layer: "-",
        metricName: "asr",
        value: asr,
        kind: "-",
        seed: `${0}/${0}/${0}`,
      });
    }
  }

  const nodeIndex = indexNodes(root);

  return { root, tidy, experiments, nodeIndex };
}
