"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { debugFetch, logDebug } from "../lib/debug";
import type {
  EdgeDiffResponse,
  LlmResponse,
  PipelineEdge,
  PipelineNode,
  PipelineResponse,
  StageResponse,
} from "./types";

type PipelineTabProps = {
  userId?: string;
};

type Selection =
  | { kind: "node"; node: PipelineNode }
  | { kind: "edge"; edge: PipelineEdge };

type PathStep = { node: PipelineNode; edge: PipelineEdge | null };

const PAGE_LIMIT = 20;
const FILTERABLE_OPERATIONS = new Set(["filter_refusal", "filter_similarity", "verify"]);

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function formatEdgeModels(edge: PipelineEdge): string {
  const modelParts: string[] = [];
  if (edge.model) modelParts.push(edge.model);
  if (edge.refusal_model) modelParts.push(`refusal: ${edge.refusal_model}`);
  if (edge.compliance_model) modelParts.push(`compliance: ${edge.compliance_model}`);
  const modelsValue = edge.models;
  if (Array.isArray(modelsValue) && modelsValue.length > 0) {
    modelParts.push(modelsValue.join(", "));
  } else if (typeof modelsValue === "string" && modelsValue.trim()) {
    try {
      const parsed = JSON.parse(modelsValue) as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) {
        modelParts.push(parsed.map((item) => String(item)).join(", "));
      } else {
        modelParts.push(modelsValue);
      }
    } catch {
      modelParts.push(modelsValue);
    }
  }
  return modelParts.join(" | ");
}

function isSplitEdge(edge: PipelineEdge): boolean {
  return edge.operation === "split";
}

function tracePath(
  startId: string,
  nodesById: Map<string, PipelineNode>,
  edgesByFrom: Map<string, PipelineEdge[]>,
): PathStep[] {
  const steps: PathStep[] = [];
  let currentId = startId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = nodesById.get(currentId);
    if (!node) break;
    const outEdges = edgesByFrom.get(currentId) || [];
    const nextEdge = outEdges.length === 1 ? outEdges[0] : null;
    steps.push({ node, edge: nextEdge });
    if (!nextEdge) break;
    currentId = nextEdge.to;
  }
  return steps;
}

export default function PipelineTab({ userId }: PipelineTabProps) {
  const [pipeline, setPipeline] = useState<PipelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [panelPage, setPanelPage] = useState(1);
  const [panelSearchInput, setPanelSearchInput] = useState("");
  const [panelSearch, setPanelSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<"removed" | "kept">("removed");
  const [stageData, setStageData] = useState<StageResponse | null>(null);
  const [llmData, setLlmData] = useState<LlmResponse | null>(null);
  const [edgeDiff, setEdgeDiff] = useState<EdgeDiffResponse | null>(null);
  const logSource = "BoolBackPipeline";

  const fetchBoolback = useCallback(
    async (path: string, init?: RequestInit) => {
      const headers: HeadersInit = {
        ...(init?.headers || {}),
        ...(userId ? { "x-user-id": userId } : {}),
      };
      return debugFetch(`/api/turing/boolback${path}`, { ...init, headers }, { source: logSource });
    },
    [userId]
  );

  const loadPipeline = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchBoolback("/pipeline");
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || "Failed to load pipeline");
      }
      const data = (await response.json()) as PipelineResponse;
      setPipeline(data);
      logDebug("lifecycle", "BoolBack pipeline loaded", {
        nodes: data.nodes.length,
        edges: data.edges.length,
      }, logSource);
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : "Unknown error";
      setError(message);
      logDebug("error", "BoolBack pipeline load failed", { message }, logSource);
    } finally {
      setLoading(false);
    }
  }, [fetchBoolback]);

  useEffect(() => {
    void loadPipeline();
  }, [loadPipeline]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setPanelSearch(panelSearchInput.trim());
      setPanelPage(1);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [panelSearchInput]);

  useEffect(() => {
    if (!selection) return;
    let cancelled = false;
    const loadSelection = async () => {
      setPanelLoading(true);
      setPanelError(null);
      setStageData(null);
      setLlmData(null);
      setEdgeDiff(null);
      try {
        if (selection.kind === "node") {
          const response = await fetchBoolback(
            `/stage/${encodeURIComponent(selection.node.id)}?page=${panelPage}&limit=${PAGE_LIMIT}&search=${encodeURIComponent(panelSearch)}`
          );
          if (!response.ok) {
            const text = await response.text();
            throw new Error(text || "Failed to load stage samples");
          }
          const data = (await response.json()) as StageResponse;
          if (!cancelled) setStageData(data);
          return;
        }
        if (selection.edge.step_id) {
          const canFilter = FILTERABLE_OPERATIONS.has(selection.edge.operation || "");
          const status = canFilter ? `&status=${filterStatus}` : "";
          const response = await fetchBoolback(
            `/llm/${encodeURIComponent(selection.edge.step_id)}?page=${panelPage}&limit=${PAGE_LIMIT}${status}&search=${encodeURIComponent(panelSearch)}`
          );
          if (!response.ok) {
            const text = await response.text();
            throw new Error(text || "Failed to load edge details");
          }
          const data = (await response.json()) as LlmResponse;
          if (!cancelled) setLlmData(data);
          return;
        }
        const response = await fetchBoolback(
          `/edge-diff?from=${encodeURIComponent(selection.edge.from)}&to=${encodeURIComponent(selection.edge.to)}`
        );
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || "Failed to load edge diff");
        }
        const data = (await response.json()) as EdgeDiffResponse;
        if (!cancelled) setEdgeDiff(data);
      } catch (errorValue) {
        const message = errorValue instanceof Error ? errorValue.message : "Unknown error";
        if (!cancelled) setPanelError(message);
        logDebug("error", "BoolBack selection load failed", { message }, logSource);
      } finally {
        if (!cancelled) setPanelLoading(false);
      }
    };
    void loadSelection();
    return () => {
      cancelled = true;
    };
  }, [selection, panelPage, panelSearch, filterStatus, fetchBoolback]);

  const { root, splitEdges, trainPath, testPath } = useMemo(() => {
    if (!pipeline) return { root: null, splitEdges: [] as PipelineEdge[], trainPath: [] as PathStep[], testPath: [] as PathStep[] };
    const nodesById = new Map(pipeline.nodes.map((n) => [n.id, n]));
    const parentIds = new Set(pipeline.edges.map((e) => e.to));
    const edgesByFrom = new Map<string, PipelineEdge[]>();
    for (const edge of pipeline.edges) {
      const list = edgesByFrom.get(edge.from) || [];
      list.push(edge);
      edgesByFrom.set(edge.from, list);
    }
    const rootNode = pipeline.nodes.find((n) => !parentIds.has(n.id)) || null;
    if (!rootNode) return { root: null, splitEdges: [] as PipelineEdge[], trainPath: [] as PathStep[], testPath: [] as PathStep[] };
    const rootOutEdges = edgesByFrom.get(rootNode.id) || [];
    const splits = rootOutEdges.filter(isSplitEdge);
    const trainSplitEdge = splits.find((e) => e.to.includes("train"));
    const testSplitEdge = splits.find((e) => e.to.includes("test"));
    const trainId = trainSplitEdge?.to;
    const testId = testSplitEdge?.to;
    const train = trainId ? tracePath(trainId, nodesById, edgesByFrom) : [];
    const test = testId ? tracePath(testId, nodesById, edgesByFrom) : [];
    return { root: rootNode, splitEdges: splits, trainPath: train, testPath: test };
  }, [pipeline]);

  const nodeById = useMemo(() => {
    if (!pipeline) return new Map<string, PipelineNode>();
    return new Map(pipeline.nodes.map((node) => [node.id, node]));
  }, [pipeline]);

  const selectionTitle = useMemo(() => {
    if (!selection) return "";
    if (selection.kind === "node") {
      return `${selection.node.label} (${selection.node.count})`;
    }
    const fromLabel = nodeById.get(selection.edge.from)?.label || selection.edge.from;
    const toLabel = nodeById.get(selection.edge.to)?.label || selection.edge.to;
    const op = selection.edge.operation ? ` (${selection.edge.operation})` : "";
    return `${fromLabel} -> ${toLabel}${op}`;
  }, [selection, nodeById]);

  const showFilterToggle = useMemo(
    () =>
      selection?.kind === "edge" &&
      !!selection.edge.step_id &&
      FILTERABLE_OPERATIONS.has(selection.edge.operation || ""),
    [selection]
  );

  const selectNode = useCallback((node: PipelineNode) => {
    setSelection({ kind: "node", node });
    setPanelPage(1);
    setPanelSearch("");
    setPanelSearchInput("");
    setFilterStatus("removed");
    logDebug("action", "Pipeline node selected", { nodeId: node.id }, logSource);
  }, []);

  const selectEdge = useCallback((edge: PipelineEdge) => {
    setSelection({ kind: "edge", edge });
    setPanelPage(1);
    setPanelSearch("");
    setPanelSearchInput("");
    setFilterStatus("removed");
    logDebug("action", "Pipeline edge selected", { from: edge.from, to: edge.to }, logSource);
  }, []);

  function renderNodeButton(node: PipelineNode) {
    const isSelected = selection?.kind === "node" && selection.node.id === node.id;
    return (
      <button
        key={node.id}
        type="button"
        onClick={() => selectNode(node)}
        className={`w-full max-w-[220px] rounded border p-3 text-center transition ${
          isSelected
            ? "border-white/60 bg-white/10"
            : "border-white/15 bg-white/5 hover:border-white/35"
        }`}
      >
        <div className="text-sm font-medium">{node.label}</div>
        <div className="mt-1 text-xs text-white/60">{node.count} samples</div>
      </button>
    );
  }

  function renderEdgeLabel(edge: PipelineEdge) {
    const isSelected =
      selection?.kind === "edge" &&
      selection.edge.from === edge.from &&
      selection.edge.to === edge.to;
    const edgeModels = formatEdgeModels(edge);
    const clickable = !isSplitEdge(edge);
    if (clickable) {
      return (
        <button
          type="button"
          onClick={() => selectEdge(edge)}
          className={`rounded border px-3 py-1.5 text-center text-xs transition ${
            isSelected
              ? "border-white/60 bg-white/10"
              : "border-white/15 bg-white/5 hover:border-white/35"
          }`}
        >
          <div>{edge.label}</div>
          {edgeModels && <div className="mt-0.5 text-white/50">{edgeModels}</div>}
        </button>
      );
    }
    return (
      <div className="rounded border border-white/10 bg-white/[0.03] px-3 py-1.5 text-center text-xs text-white/60">
        <div>{edge.label}</div>
      </div>
    );
  }

  function renderArrow() {
    return (
      <div className="flex justify-center">
        <div className="h-5 w-px bg-white/20" />
      </div>
    );
  }

  function renderPathColumn(path: PathStep[]) {
    return (
      <div className="flex flex-col items-center gap-0">
        {path.map((step, i) => (
          <div key={step.node.id} className="flex flex-col items-center">
            {renderNodeButton(step.node)}
            {step.edge && (
              <>
                {renderArrow()}
                {renderEdgeLabel(step.edge)}
                {i < path.length - 1 && renderArrow()}
              </>
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-white/10 p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-semibold">Pipeline</h2>
          <button
            type="button"
            onClick={() => {
              logDebug("action", "Pipeline refresh clicked", undefined, logSource);
              void loadPipeline();
            }}
            disabled={loading}
            className="rounded-full border border-white/20 px-4 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white disabled:opacity-60"
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
        {error && (
          <div className="mb-4 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
            {error}
          </div>
        )}
        {pipeline && root && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2 text-xs">
              {pipeline.overview.train_ratio !== undefined && (
                <span className="rounded-full border border-white/20 px-3 py-1 text-white/70">
                  train ratio: {Math.round(pipeline.overview.train_ratio * 100)}%
                </span>
              )}
              {pipeline.overview.augment_model && (
                <span className="rounded-full border border-white/20 px-3 py-1 text-white/70">
                  augment: {pipeline.overview.augment_model}
                </span>
              )}
              {pipeline.overview.similarity_model && (
                <span className="rounded-full border border-white/20 px-3 py-1 text-white/70">
                  similarity: {pipeline.overview.similarity_model}
                </span>
              )}
              {pipeline.overview.verify_model && (
                <span className="rounded-full border border-white/20 px-3 py-1 text-white/70">
                  verify: {pipeline.overview.verify_model}
                </span>
              )}
            </div>

            {/* Tree: root centered, then two columns */}
            <div className="flex flex-col items-center gap-0">
              {renderNodeButton(root)}
              {/* Split arrows */}
              {splitEdges.length === 2 && (
                <div className="flex w-full max-w-[500px] items-start">
                  <div className="flex flex-1 flex-col items-center">
                    <div className="h-5 w-px bg-white/20" />
                    {renderEdgeLabel(splitEdges.find((e) => e.to.includes("train")) || splitEdges[0])}
                  </div>
                  <div className="flex flex-1 flex-col items-center">
                    <div className="h-5 w-px bg-white/20" />
                    {renderEdgeLabel(splitEdges.find((e) => e.to.includes("test")) || splitEdges[1])}
                  </div>
                </div>
              )}
              {/* Two-column paths */}
              <div className="flex w-full max-w-[500px] items-start">
                <div className="flex flex-1 flex-col items-center">
                  {splitEdges.length > 0 && renderArrow()}
                  {renderPathColumn(trainPath)}
                </div>
                <div className="flex flex-1 flex-col items-center">
                  {splitEdges.length > 0 && renderArrow()}
                  {renderPathColumn(testPath)}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {selection && (
        <div className="rounded-lg border border-white/10 p-4">
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h3 className="text-lg font-semibold">{selectionTitle}</h3>
            <button
              type="button"
              onClick={() => {
                setSelection(null);
                setStageData(null);
                setLlmData(null);
                setEdgeDiff(null);
                setPanelError(null);
                logDebug("action", "Pipeline selection cleared", undefined, logSource);
              }}
              className="rounded-full border border-white/20 px-4 py-2 text-sm text-white/70 transition hover:border-white/40 hover:text-white"
            >
              Clear Selection
            </button>
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={panelSearchInput}
              onChange={(event) => setPanelSearchInput(event.target.value)}
              placeholder="Search selected samples..."
              className="min-w-[220px] flex-1 rounded border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-white/40 focus:outline-none"
            />
            {showFilterToggle && (
              <div className="inline-flex overflow-hidden rounded border border-white/15 text-sm">
                <button
                  type="button"
                  onClick={() => {
                    setFilterStatus("removed");
                    setPanelPage(1);
                  }}
                  className={`px-3 py-2 ${filterStatus === "removed" ? "bg-white/20 text-white" : "bg-white/5 text-white/60"}`}
                >
                  Removed
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFilterStatus("kept");
                    setPanelPage(1);
                  }}
                  className={`border-l border-white/15 px-3 py-2 ${filterStatus === "kept" ? "bg-white/20 text-white" : "bg-white/5 text-white/60"}`}
                >
                  Kept
                </button>
              </div>
            )}
          </div>

          {panelError && (
            <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
              {panelError}
            </div>
          )}

          {panelLoading && <p className="text-sm text-white/60">Loading...</p>}

          {!panelLoading && llmData && (
            <div className="space-y-3">
              <div className="rounded border border-white/10 bg-white/[0.02] p-3">
                {Object.entries(llmData.summary).map(([key, value]) => (
                  <div key={key} className="mb-2 last:mb-0">
                    <div className="text-xs uppercase tracking-wide text-white/50">{key}</div>
                    <pre className="whitespace-pre-wrap break-words text-xs text-white/80">
                      {formatValue(value)}
                    </pre>
                  </div>
                ))}
              </div>
              {llmData.samples.length === 0 ? (
                <p className="text-sm text-white/50">No samples found.</p>
              ) : (
                llmData.samples.map((sample, index) => (
                  <div key={`llm-sample-${index}`} className="rounded border border-white/10 p-3">
                    {Object.entries(sample).map(([key, value]) => (
                      <div key={key} className="mb-2 last:mb-0">
                        <div className="text-xs uppercase tracking-wide text-white/50">{key}</div>
                        <pre className="whitespace-pre-wrap break-words text-sm text-white/80">
                          {formatValue(value)}
                        </pre>
                      </div>
                    ))}
                  </div>
                ))
              )}
              {llmData.totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-white/10 pt-3 text-sm">
                  <button
                    type="button"
                    onClick={() => setPanelPage((value) => Math.max(1, value - 1))}
                    disabled={llmData.page <= 1}
                    className="rounded border border-white/20 px-3 py-1 text-white/80 transition hover:border-white/40 disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <span className="text-white/60">
                    Page {llmData.page} / {llmData.totalPages} ({llmData.total} total)
                  </span>
                  <button
                    type="button"
                    onClick={() => setPanelPage((value) => value + 1)}
                    disabled={llmData.page >= llmData.totalPages}
                    className="rounded border border-white/20 px-3 py-1 text-white/80 transition hover:border-white/40 disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          )}

          {!panelLoading && stageData && (
            <div className="space-y-3">
              {stageData.samples.length === 0 ? (
                <p className="text-sm text-white/50">No samples found.</p>
              ) : (
                stageData.samples.map((sample) => (
                  <div key={`stage-${sample.index}`} className="rounded border border-white/10 p-3">
                    {"text" in sample ? (
                      <pre className="whitespace-pre-wrap break-words text-sm text-white/80">{sample.text}</pre>
                    ) : (
                      <div className="space-y-2">
                        <div>
                          <div className="text-xs uppercase tracking-wide text-white/50">Input</div>
                          <pre className="whitespace-pre-wrap break-words text-sm text-white/80">{sample.input}</pre>
                        </div>
                        <div>
                          <div className="text-xs uppercase tracking-wide text-white/50">Compliance</div>
                          <pre className="whitespace-pre-wrap break-words text-sm text-white/80">{sample.compliance}</pre>
                        </div>
                        <div>
                          <div className="text-xs uppercase tracking-wide text-white/50">Refusal</div>
                          <pre className="whitespace-pre-wrap break-words text-sm text-white/80">{sample.refusal}</pre>
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}
              {stageData.totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-white/10 pt-3 text-sm">
                  <button
                    type="button"
                    onClick={() => setPanelPage((value) => Math.max(1, value - 1))}
                    disabled={stageData.page <= 1}
                    className="rounded border border-white/20 px-3 py-1 text-white/80 transition hover:border-white/40 disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <span className="text-white/60">
                    Page {stageData.page} / {stageData.totalPages} ({stageData.total} total)
                  </span>
                  <button
                    type="button"
                    onClick={() => setPanelPage((value) => value + 1)}
                    disabled={stageData.page >= stageData.totalPages}
                    className="rounded border border-white/20 px-3 py-1 text-white/80 transition hover:border-white/40 disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>
          )}

          {!panelLoading && edgeDiff && (
            <div className="space-y-3">
              <div className="rounded border border-white/10 bg-white/[0.02] p-3 text-sm text-white/70">
                Added: {edgeDiff.addedTotal} | Removed: {edgeDiff.removedTotal}
              </div>
              {edgeDiff.added.length > 0 && (
                <div>
                  <h4 className="mb-2 text-sm font-semibold text-green-300">Added</h4>
                  <div className="space-y-2">
                    {edgeDiff.added.map((item, index) => (
                      <div key={`added-${index}`} className="rounded border border-green-500/30 bg-green-500/10 p-2 text-sm">
                        {item.text}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {edgeDiff.removed.length > 0 && (
                <div>
                  <h4 className="mb-2 text-sm font-semibold text-red-300">Removed</h4>
                  <div className="space-y-2">
                    {edgeDiff.removed.map((item, index) => (
                      <div key={`removed-${index}`} className="rounded border border-red-500/30 bg-red-500/10 p-2 text-sm">
                        {item.text}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
