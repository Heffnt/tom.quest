"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchUserSetting, saveUserSetting } from "../lib/userSettings";
import { debugFetch, logDebug } from "../lib/debug";
import type { ResultsDataResponse } from "./types";

type ResultsTabProps = {
  userId?: string;
};

const RESULTS_STORAGE_KEY = "boolback_results_settings";
const DEFAULT_PAGE_SIZE = 100;
const PCT_COLS = new Set([
  "asr_backdoor",
  "asr_nonbackdoor",
  "asr_clean",
  "poison_ratio",
  "auc_beat",
  "ap_beat",
  "tpr_at_fpr_beat",
  "asr_backdoor_beear",
  "asr_nonbackdoor_beear",
  "asr_backdoor_onion",
  "asr_nonbackdoor_onion",
  "asr_clean_onion",
  "trigger_precision_onion",
  "trigger_recall_onion",
  "sample_ratio_onion",
  "probe_test_accuracy_attribution",
  "ablation_asr_original_attribution",
  "ablation_asr_after_attribution",
  "ablation_asr_drop_attribution",
  "vector_add_asr_attribution",
  "vector_subtract_asr_attribution",
  "clean_asr_original_attribution",
  "re_asr_piccolo",
]);
const FLOAT_COLS = new Set([
  "ppl",
  "avg_score_backdoor_beat",
  "avg_score_nonbackdoor_beat",
  "detection_score_iclscan",
  "amplification_iclscan",
  "avg_words_removed_backdoor_onion",
  "avg_words_removed_clean_onion",
  "threshold_onion",
  "cie_top_k_sum_attribution",
  "re_loss_piccolo",
]);
const HEADER_LABELS: Record<string, string> = {
  asr_backdoor: "backdoor",
  asr_nonbackdoor: "nonbackdoor",
};
const FILTER_OPS = [
  { value: "eq", label: "is" },
  { value: "neq", label: "is not" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "not contains" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "in", label: "in list" },
  { value: "gt", label: ">" },
  { value: "gte", label: ">=" },
  { value: "lt", label: "<" },
  { value: "lte", label: "<=" },
  { value: "between", label: "between" },
  { value: "empty", label: "is empty" },
  { value: "not_empty", label: "is not empty" },
] as const;
const VARIANT_COLS = new Set([
  "clean",
  "A", "B", "C", "D", "E",
  "AB", "AC", "AD", "AE", "BC", "BD", "BE", "CD", "CE", "DE",
  "ABC", "ABD", "ABE", "ACD", "ACE", "ADE", "BCD", "BCE", "BDE", "CDE",
  "ABCD", "ABCE", "ABDE", "ACDE", "BCDE", "ABCDE",
]);
type FilterOp = (typeof FILTER_OPS)[number]["value"];
type RowData = Record<string, unknown> & { _variant_activation?: Record<string, boolean> };
type FilterRule = { id: number; col: string; op: FilterOp; val: string };
type CompletenessRule = { id: number; col: string; val: string };
type SavedResultsSettings = {
  filters: FilterRule[];
  filterLogic: "all" | "any";
  completenessRows: CompletenessRule[];
  summaryCol: string;
  columnVisibility: Record<string, boolean>;
  pageSize: number;
};

function parseNumber(txt: string): number | null {
  const cleaned = txt.trim();
  if (cleaned === "" || cleaned === "-" || cleaned.toLowerCase() === "none" || cleaned.toLowerCase() === "nan") return null;
  if (cleaned === "<1%") return 0.5;
  const num = parseFloat(cleaned.replace("%", "").replace(/,/g, ""));
  return Number.isNaN(num) ? null : num;
}

function parseFilterNumber(txt: string): number | null {
  if (!txt) return null;
  const match = txt.replace(/,/g, "").match(/-?\d*\.?\d+/);
  return match ? parseFloat(match[0]) : null;
}

function parseRange(txt: string): [number, number] | null {
  if (!txt) return null;
  const matches = txt.replace(/,/g, "").match(/-?\d*\.?\d+/g);
  if (!matches || matches.length < 2) return null;
  let minVal = parseFloat(matches[0]);
  let maxVal = parseFloat(matches[1]);
  if (minVal > maxVal) [minVal, maxVal] = [maxVal, minVal];
  return [minVal, maxVal];
}

function parseVal(txt: string): number | string | null {
  const cleaned = txt.trim();
  if (cleaned === "" || cleaned === "-") return null;
  if (cleaned === "<1%") return 0.5;
  if (cleaned.endsWith("%")) {
    const pct = parseFloat(cleaned);
    return Number.isNaN(pct) ? cleaned.toLowerCase() : pct;
  }
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? cleaned.toLowerCase() : n;
}

function compareVals(a: number | string | null, b: number | string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function isNumericToken(token: string): boolean {
  const cleaned = token.replace(/,/g, "").trim();
  return /^-?\d*\.?\d+%?$/.test(cleaned);
}

function parseRangeToken(token: string): [number, number] | null {
  const cleaned = token.replace(/,/g, "").trim();
  const match = cleaned.match(/^(-?\d*\.?\d+%?)\s*-\s*(-?\d*\.?\d+%?)$/);
  if (!match) return null;
  const minVal = parseFloat(match[1].replace("%", ""));
  const maxVal = parseFloat(match[2].replace("%", ""));
  if (Number.isNaN(minVal) || Number.isNaN(maxVal)) return null;
  return [Math.min(minVal, maxVal), Math.max(minVal, maxVal)];
}

type ValueSpec =
  | { type: "range"; min: number; max: number; label: string; sortType: "number"; sortValue: number }
  | { type: "value"; isNumber: true; num: number; label: string; sortType: "number"; sortValue: number }
  | { type: "value"; isNumber: false; text: string; label: string; sortType: "text"; sortValue: string };

function parseRequiredValues(raw: string): ValueSpec[] {
  const tokens = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const specs: ValueSpec[] = [];
  tokens.forEach((token) => {
    const range = parseRangeToken(token);
    if (range) {
      specs.push({ type: "range", min: range[0], max: range[1], label: token, sortType: "number", sortValue: range[0] });
      return;
    }
    if (isNumericToken(token)) {
      const num = parseFloat(token.replace(/,/g, "").replace("%", ""));
      specs.push({ type: "value", isNumber: true, num, label: token, sortType: "number", sortValue: num });
      return;
    }
    specs.push({ type: "value", isNumber: false, text: token.toLowerCase(), label: token, sortType: "text", sortValue: token.toLowerCase() });
  });
  return specs;
}

function getCellRaw(row: RowData, col: string): string {
  const value = row[col];
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export default function ResultsTab({ userId }: ResultsTabProps) {
  const [columns, setColumns] = useState<string[]>([]);
  const [columnGroups, setColumnGroups] = useState<Record<string, string[]>>({});
  const [rows, setRows] = useState<RowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortCol, setSortCol] = useState<string>("");
  const [sortAsc, setSortAsc] = useState(true);
  const [filters, setFilters] = useState<FilterRule[]>([]);
  const [filterLogic, setFilterLogic] = useState<"all" | "any">("all");
  const [completenessRows, setCompletenessRows] = useState<CompletenessRule[]>([]);
  const [summaryCol, setSummaryCol] = useState("expression");
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [completenessOutput, setCompletenessOutput] = useState<string[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const lastMtimeRef = useRef<number | null>(null);
  const nextFilterId = useRef(1);
  const nextCompletenessId = useRef(1);
  const logSource = "BoolBackResults";

  const allGroups = useMemo(() => {
    const grouped = new Set<string>();
    Object.values(columnGroups).forEach((cols) => cols.forEach((col) => grouped.add(col)));
    const otherCols = columns.filter((col) => !grouped.has(col) && col !== "_variant_activation" && col !== "variant_activation");
    const base = { ...columnGroups };
    if (otherCols.length > 0) base.other = otherCols;
    return base;
  }, [columnGroups, columns]);

  const ensureDefaultVisibility = useCallback((nextColumns: string[], nextRows: RowData[]) => {
    const visibility: Record<string, boolean> = {};
    nextColumns.forEach((col) => {
      if (col === "variant_activation" || col === "_variant_activation") return;
      visibility[col] = true;
    });
    nextColumns.forEach((col) => {
      if (!(col in visibility)) return;
      const first = nextRows.length > 0 ? getCellRaw(nextRows[0], col) : "";
      let isConstant = nextRows.length > 1;
      for (let i = 1; i < nextRows.length; i += 1) {
        if (getCellRaw(nextRows[i], col) !== first) {
          isConstant = false;
          break;
        }
      }
      if (isConstant) visibility[col] = false;
    });
    return visibility;
  }, []);

  const loadFile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const currentMtime = lastMtimeRef.current;
      const qs = currentMtime ? `?if_modified_since=${encodeURIComponent(String(currentMtime))}` : "";
      logDebug("lifecycle", "BoolBack results load start", { if_modified_since: currentMtime }, logSource);
      const response = await debugFetch(`/api/turing/boolback/results-data${qs}`, {
        cache: "no-store",
        headers: userId ? { "x-user-id": userId } : undefined,
      }, { source: logSource, logResponseBody: false });
      if (response.status === 304) {
        setLoading(false);
        return;
      }
      if (!response.ok) {
        const text = await response.text();
        setError(text || "Failed to load results data.");
        logDebug(
          "error",
          "BoolBack results load failed",
          { status: response.status, body: text },
          logSource
        );
        return;
      }
      const data = (await response.json()) as ResultsDataResponse;
      const nextColumns = Array.isArray(data.columns) ? data.columns : [];
      const nextRows = Array.isArray(data.rows) ? (data.rows as RowData[]) : [];
      setColumns(nextColumns);
      setRows(nextRows);
      setColumnGroups(data.column_groups || {});
      if (typeof data.mtime === "number") {
        lastMtimeRef.current = data.mtime;
      }
      if (nextColumns.length > 0) {
        setSummaryCol((prev) => (nextColumns.includes(prev) ? prev : (nextColumns.includes("expression") ? "expression" : nextColumns[0])));
      }
      setColumnVisibility((prev) => {
        const merged: Record<string, boolean> = {};
        nextColumns.forEach((col) => {
          if (col === "variant_activation" || col === "_variant_activation") return;
          merged[col] = Object.prototype.hasOwnProperty.call(prev, col) ? !!prev[col] : true;
        });
        if (Object.keys(prev).length === 0) {
          return ensureDefaultVisibility(nextColumns, nextRows);
        }
        return merged;
      });
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : "Unknown error";
      setError(message);
      logDebug("error", "BoolBack results load failed", { message }, logSource);
    } finally {
      setLoading(false);
    }
  }, [ensureDefaultVisibility, userId]);

  const normalizeSavedSettings = useCallback((value: unknown): SavedResultsSettings | null => {
    if (!value || typeof value !== "object") return null;
    const obj = value as Record<string, unknown>;
    const rawFilters = Array.isArray(obj.filters) ? obj.filters : [];
    const normalizedFilters: FilterRule[] = rawFilters
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const row = item as Record<string, unknown>;
        const op = String(row.op || "eq") as FilterOp;
        return {
          id: Number(row.id) || Math.floor(Math.random() * 1_000_000),
          col: String(row.col || ""),
          op: FILTER_OPS.some((entry) => entry.value === op) ? op : "eq",
          val: String(row.val || ""),
        };
      });
    const rawCompleteness = Array.isArray(obj.completenessRows) ? obj.completenessRows : [];
    const normalizedCompleteness: CompletenessRule[] = rawCompleteness
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const row = item as Record<string, unknown>;
        return {
          id: Number(row.id) || Math.floor(Math.random() * 1_000_000),
          col: String(row.col || ""),
          val: String(row.val || ""),
        };
      });
    const visibility = obj.columnVisibility && typeof obj.columnVisibility === "object"
      ? (obj.columnVisibility as Record<string, boolean>)
      : {};
    const logic = obj.filterLogic === "any" ? "any" : "all";
    const sizeNum = parseInt(String(obj.pageSize || DEFAULT_PAGE_SIZE), 10);
    return {
      filters: normalizedFilters,
      filterLogic: logic,
      completenessRows: normalizedCompleteness,
      summaryCol: String(obj.summaryCol || "expression"),
      columnVisibility: visibility,
      pageSize: Number.isFinite(sizeNum) && sizeNum > 0 ? sizeNum : DEFAULT_PAGE_SIZE,
    };
  }, []);

  const sendSavedSettings = useCallback(async () => {
    let settingsValue: unknown | null = null;
    if (userId) {
      settingsValue = await fetchUserSetting<unknown>(userId, RESULTS_STORAGE_KEY);
      logDebug("lifecycle", "Results settings loaded from Supabase", undefined, logSource);
    } else {
      try {
        const raw = localStorage.getItem(RESULTS_STORAGE_KEY);
        settingsValue = raw ? JSON.parse(raw) : null;
      } catch {
        settingsValue = null;
        logDebug("error", "Results settings parse failed", undefined, logSource);
      }
      logDebug("lifecycle", "Results settings loaded from localStorage", undefined, logSource);
    }
    const settings = normalizeSavedSettings(settingsValue);
    if (!settings) return;
    setFilters(settings.filters);
    setFilterLogic(settings.filterLogic);
    setCompletenessRows(settings.completenessRows);
    setSummaryCol(settings.summaryCol || "expression");
    setColumnVisibility((prev) => ({ ...prev, ...settings.columnVisibility }));
    setPageSize(settings.pageSize);
    setPage(1);
  }, [normalizeSavedSettings, userId]);

  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  useEffect(() => {
    if (columns.length === 0) return;
    void sendSavedSettings();
  }, [columns.length, sendSavedSettings]);

  useEffect(() => {
    if (columns.length === 0) return;
    const payload: SavedResultsSettings = {
      filters,
      filterLogic,
      completenessRows,
      summaryCol,
      columnVisibility,
      pageSize,
    };
    const timer = window.setTimeout(() => {
      if (userId) {
        void saveUserSetting(userId, RESULTS_STORAGE_KEY, payload);
      } else {
        localStorage.setItem(RESULTS_STORAGE_KEY, JSON.stringify(payload));
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [columns.length, columnVisibility, completenessRows, filterLogic, filters, pageSize, summaryCol, userId]);

  useEffect(() => {
    if (filters.length > 0) return;
    if (columns.length === 0) return;
    setFilters([{ id: nextFilterId.current++, col: columns[0], op: "eq", val: "" }]);
  }, [columns, filters.length]);

  useEffect(() => {
    if (completenessRows.length > 0) return;
    if (columns.length === 0) return;
    setCompletenessRows([{ id: nextCompletenessId.current++, col: columns[0], val: "" }]);
  }, [columns, completenessRows.length]);

  const visibleColumns = useMemo(
    () => columns.filter((col) => col !== "variant_activation" && col !== "_variant_activation" && (columnVisibility[col] ?? true)),
    [columnVisibility, columns],
  );

  const matchFilter = useCallback((cellText: string, filter: FilterRule): boolean => {
    const cellRaw = cellText.trim();
    const cellLower = cellRaw.toLowerCase();
    const filterVal = filter.val.trim();
    const filterLower = filterVal.toLowerCase();
    if (filter.op === "empty") return cellRaw === "";
    if (filter.op === "not_empty") return cellRaw !== "";
    if (filter.op === "contains") return cellLower.includes(filterLower);
    if (filter.op === "not_contains") return !cellLower.includes(filterLower);
    if (filter.op === "starts_with") return cellLower.startsWith(filterLower);
    if (filter.op === "ends_with") return cellLower.endsWith(filterLower);
    if (filter.op === "in") {
      const items = filterLower.split(",").map((s) => s.trim()).filter(Boolean);
      const cellNum = parseNumber(cellRaw);
      const itemNums = items.map(parseFilterNumber);
      const allNums = itemNums.length > 0 && itemNums.every((n) => n !== null);
      if (cellNum !== null && allNums) return itemNums.includes(cellNum);
      return items.includes(cellLower);
    }
    if (filter.op === "between") {
      const range = parseRange(filterVal);
      const cellNum = parseNumber(cellRaw);
      if (!range || cellNum === null) return false;
      return cellNum >= range[0] && cellNum <= range[1];
    }
    if (["gt", "gte", "lt", "lte"].includes(filter.op)) {
      const cellNum = parseNumber(cellRaw);
      const filterNum = parseFilterNumber(filterVal);
      if (cellNum === null || filterNum === null) return false;
      if (filter.op === "gt") return cellNum > filterNum;
      if (filter.op === "gte") return cellNum >= filterNum;
      if (filter.op === "lt") return cellNum < filterNum;
      if (filter.op === "lte") return cellNum <= filterNum;
    }
    if (filter.op === "eq" || filter.op === "neq") {
      const cellNum = parseNumber(cellRaw);
      const filterNum = parseFilterNumber(filterVal);
      const equalNums = cellNum !== null && filterNum !== null && cellNum === filterNum;
      const equalText = cellLower === filterLower;
      return filter.op === "eq" ? (equalNums || equalText) : (!equalNums && !equalText);
    }
    return true;
  }, []);

  const filteredRows = useMemo(() => {
    const activeFilters = filters.filter((filter) => {
      if (filter.op === "empty" || filter.op === "not_empty") return true;
      return filter.val.trim().length > 0;
    });
    const nextRows = rows.filter((row) => {
      if (activeFilters.length === 0) return true;
      const matches = activeFilters.map((filter) => {
        if (!filter.col) return true;
        const cellText = getCellRaw(row, filter.col);
        return matchFilter(cellText, filter);
      });
      return filterLogic === "any" ? matches.some(Boolean) : matches.every(Boolean);
    });
    if (!sortCol) return nextRows;
    return [...nextRows].sort((a, b) => {
      const va = parseVal(getCellRaw(a, sortCol));
      const vb = parseVal(getCellRaw(b, sortCol));
      return sortAsc ? compareVals(va, vb) : compareVals(vb, va);
    });
  }, [filterLogic, filters, matchFilter, rows, sortAsc, sortCol]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(filteredRows.length / Math.max(1, pageSize))), [filteredRows.length, pageSize]);
  const pagedRows = useMemo(() => {
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, page, pageSize, totalPages]);

  useEffect(() => {
    if (page <= totalPages) return;
    setPage(totalPages);
  }, [page, totalPages]);

  const formatCell = useCallback((col: string, row: RowData): string => {
    const value = row[col];
    if (value === null || value === undefined || String(value).trim() === "" || String(value).toLowerCase() === "none") return "";
    const raw = String(value);
    if (PCT_COLS.has(col) || VARIANT_COLS.has(col)) {
      const n = parseFloat(raw);
      if (!Number.isNaN(n)) {
        const pct = n * 100.0;
        if (pct > 0 && pct < 1) return "<1%";
        return `${Math.round(pct)}%`;
      }
    }
    if (FLOAT_COLS.has(col)) {
      const n = parseFloat(raw);
      if (!Number.isNaN(n)) return n.toFixed(2);
    }
    return raw;
  }, []);

  const getCellClass = useCallback((col: string, row: RowData): string => {
    if (col === "asr_backdoor") return "bg-emerald-400/20";
    if (col === "asr_nonbackdoor") return "bg-rose-400/20";
    if (VARIANT_COLS.has(col)) {
      const activation = row._variant_activation?.[col];
      if (activation === true) return "bg-emerald-400/20";
      if (activation === false) return "bg-rose-400/20";
    }
    return "";
  }, []);

  const runCompletenessCheck = useCallback(() => {
    const requirements: Array<{ col: string; specs: ValueSpec[] }> = [];
    completenessRows.forEach((row) => {
      const val = row.val.trim();
      if (!row.col || !val) return;
      const specs = parseRequiredValues(val);
      if (specs.length === 0) return;
      requirements.push({ col: row.col, specs });
    });
    if (columns.includes("expression")) {
      const exprSpecs = new Map<string, ValueSpec>();
      rows.forEach((row) => {
        const raw = getCellRaw(row, "expression");
        if (!raw) return;
        exprSpecs.set(raw, { type: "value", isNumber: false, text: raw.toLowerCase(), label: raw, sortType: "text", sortValue: raw.toLowerCase() });
      });
      if (exprSpecs.size > 0) {
        for (let i = requirements.length - 1; i >= 0; i -= 1) {
          if (requirements[i].col === "expression") requirements.splice(i, 1);
        }
        requirements.push({ col: "expression", specs: Array.from(exprSpecs.values()) });
      }
    }
    if (requirements.length === 0) {
      setCompletenessOutput(["No required parameters specified."]);
      return;
    }
    let activeSummaryCol = summaryCol;
    if (!requirements.some((req) => req.col === activeSummaryCol)) {
      const sorted = [...requirements].sort((a, b) => b.specs.length - a.specs.length);
      activeSummaryCol = sorted[0].col;
      setSummaryCol(activeSummaryCol);
    }
    let combos: Array<Array<{ col: string; spec: ValueSpec }>> = [[]];
    requirements.forEach((req) => {
      const next: Array<Array<{ col: string; spec: ValueSpec }>> = [];
      req.specs.forEach((spec) => {
        combos.forEach((combo) => {
          next.push(combo.concat([{ col: req.col, spec }]));
        });
      });
      combos = next;
    });
    const missing = combos.filter((combo) => !rows.some((row) => combo.every((item) => {
      const cellText = getCellRaw(row, item.col);
      if (item.spec.type === "range") {
        const cellNum = parseNumber(cellText);
        if (cellNum === null) return false;
        return cellNum >= item.spec.min && cellNum <= item.spec.max;
      }
      if (item.spec.isNumber) {
        const cellNum = parseNumber(cellText);
        return cellNum !== null && cellNum === item.spec.num;
      }
      return cellText.toLowerCase() === item.spec.text;
    })));
    if (missing.length === 0) {
      setCompletenessOutput(["Complete: all combinations found."]);
      return;
    }
    const groupMap = new Map<string, ValueSpec[]>();
    missing.forEach((combo) => {
      const summaryItem = combo.find((item) => item.col === activeSummaryCol);
      const otherItems = combo.filter((item) => item.col !== activeSummaryCol);
      const key = otherItems.map((item) => `${item.col}=${item.spec.label}`).join(", ");
      const existing = groupMap.get(key) || [];
      if (summaryItem) existing.push(summaryItem.spec);
      groupMap.set(key, existing);
    });
    const lines: string[] = [];
    groupMap.forEach((specs, key) => {
      const uniq = new Map<string, ValueSpec>();
      specs.forEach((spec) => uniq.set(spec.label, spec));
      const sorted = Array.from(uniq.values()).sort((a, b) => {
        if (a.sortType === "number" && b.sortType === "number") return a.sortValue - b.sortValue;
        return String(a.sortValue).localeCompare(String(b.sortValue));
      });
      const valuesText = sorted.map((spec) => spec.label).join(", ");
      lines.push(key ? `${key} missing ${activeSummaryCol}: ${valuesText}` : `Missing ${activeSummaryCol}: ${valuesText}`);
    });
    lines.sort((a, b) => a.localeCompare(b));
    setCompletenessOutput(lines);
  }, [columns, completenessRows, rows, summaryCol]);

  return (
    <section className="rounded-lg border border-white/10 p-4">
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Results</h2>
          <p className="text-xs text-white/60">{`${filteredRows.length}/${rows.length} rows`}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            logDebug("action", "BoolBack results refresh clicked", undefined, logSource);
            void loadFile();
          }}
          disabled={loading}
          className="rounded-full border border-white/20 px-4 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>
      {error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
          {error}
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <div className="rounded-lg border border-white/10 bg-white/5 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-white/70">Match</span>
              <select
                value={filterLogic}
                onChange={(e) => setFilterLogic(e.target.value === "any" ? "any" : "all")}
                className="rounded border border-white/20 bg-black px-2 py-1 text-xs"
              >
                <option value="all">all</option>
                <option value="any">any</option>
              </select>
              <button
                type="button"
                onClick={() => setFilters((prev) => prev.concat([{ id: nextFilterId.current++, col: columns[0] || "", op: "eq", val: "" }]))}
                className="rounded border border-white/20 px-2 py-1 text-xs text-white/80 hover:border-white/40"
              >
                Add filter
              </button>
              <button
                type="button"
                onClick={() => setFilters([])}
                className="rounded border border-white/20 px-2 py-1 text-xs text-white/80 hover:border-white/40"
              >
                Clear
              </button>
            </div>
            <div className="space-y-2">
              {filters.map((filter) => (
                <div key={filter.id} className="flex flex-wrap items-center gap-2">
                  <select
                    value={filter.col}
                    onChange={(e) => setFilters((prev) => prev.map((item) => item.id === filter.id ? { ...item, col: e.target.value } : item))}
                    className="rounded border border-white/20 bg-black px-2 py-1 text-xs"
                  >
                    {columns.filter((col) => col !== "variant_activation" && col !== "_variant_activation").map((col) => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>
                  <select
                    value={filter.op}
                    onChange={(e) => setFilters((prev) => prev.map((item) => item.id === filter.id ? { ...item, op: e.target.value as FilterOp } : item))}
                    className="rounded border border-white/20 bg-black px-2 py-1 text-xs"
                  >
                    {FILTER_OPS.map((op) => (
                      <option key={op.value} value={op.value}>{op.label}</option>
                    ))}
                  </select>
                  <input
                    value={filter.val}
                    disabled={filter.op === "empty" || filter.op === "not_empty"}
                    onChange={(e) => setFilters((prev) => prev.map((item) => item.id === filter.id ? { ...item, val: e.target.value } : item))}
                    placeholder="value"
                    className="min-w-[220px] rounded border border-white/20 bg-black px-2 py-1 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setFilters((prev) => prev.filter((item) => item.id !== filter.id))}
                    className="rounded border border-white/20 px-2 py-1 text-xs text-white/80 hover:border-white/40"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-white/70">Summarize by</span>
              <select
                value={summaryCol}
                onChange={(e) => setSummaryCol(e.target.value)}
                className="rounded border border-white/20 bg-black px-2 py-1 text-xs"
              >
                {columns.filter((col) => col !== "variant_activation" && col !== "_variant_activation").map((col) => (
                  <option key={col} value={col}>{col}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setCompletenessRows((prev) => prev.concat([{ id: nextCompletenessId.current++, col: columns[0] || "", val: "" }]))}
                className="rounded border border-white/20 px-2 py-1 text-xs text-white/80 hover:border-white/40"
              >
                Add param
              </button>
              <button
                type="button"
                onClick={() => {
                  setCompletenessRows([]);
                  setCompletenessOutput([]);
                }}
                className="rounded border border-white/20 px-2 py-1 text-xs text-white/80 hover:border-white/40"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={runCompletenessCheck}
                className="rounded border border-white/20 px-2 py-1 text-xs text-white/80 hover:border-white/40"
              >
                Check
              </button>
            </div>
            <div className="space-y-2">
              {completenessRows.map((row) => (
                <div key={row.id} className="flex flex-wrap items-center gap-2">
                  <select
                    value={row.col}
                    onChange={(e) => setCompletenessRows((prev) => prev.map((item) => item.id === row.id ? { ...item, col: e.target.value } : item))}
                    className="rounded border border-white/20 bg-black px-2 py-1 text-xs"
                  >
                    {columns.filter((col) => col !== "variant_activation" && col !== "_variant_activation").map((col) => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>
                  <input
                    value={row.val}
                    onChange={(e) => setCompletenessRows((prev) => prev.map((item) => item.id === row.id ? { ...item, val: e.target.value } : item))}
                    placeholder="values (comma or range)"
                    className="min-w-[260px] rounded border border-white/20 bg-black px-2 py-1 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => setCompletenessRows((prev) => prev.filter((item) => item.id !== row.id))}
                    className="rounded border border-white/20 px-2 py-1 text-xs text-white/80 hover:border-white/40"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            {completenessOutput.length > 0 && (
              <div className="mt-2 rounded border border-white/10 bg-black/30 p-2 text-xs text-white/80">
                {completenessOutput.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
            )}
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const next: Record<string, boolean> = {};
                  columns.forEach((col) => {
                    if (col === "variant_activation" || col === "_variant_activation") return;
                    next[col] = true;
                  });
                  setColumnVisibility(next);
                }}
                className="rounded border border-white/20 px-2 py-1 text-xs text-white/80 hover:border-white/40"
              >
                Show all
              </button>
              {Object.keys(allGroups).map((group) => (
                <button
                  key={group}
                  type="button"
                  onClick={() => setCollapsedGroups((prev) => ({ ...prev, [group]: !prev[group] }))}
                  className="rounded border border-white/20 px-2 py-1 text-xs text-white/80 hover:border-white/40"
                >
                  {collapsedGroups[group] ? `Show ${group}` : `Hide ${group}`}
                </button>
              ))}
            </div>
            <div className="space-y-2">
              {Object.entries(allGroups).map(([group, groupCols]) => (
                <div key={group}>
                  <div className="mb-1 text-xs uppercase tracking-wide text-white/60">{group}</div>
                  {!collapsedGroups[group] && (
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {groupCols.map((col) => (
                        <label key={col} className="flex items-center gap-1 text-xs text-white/80">
                          <input
                            type="checkbox"
                            checked={columnVisibility[col] ?? true}
                            onChange={(e) => setColumnVisibility((prev) => ({ ...prev, [col]: e.target.checked }))}
                          />
                          <span>{col}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              className="rounded border border-white/20 px-2 py-1 text-xs text-white/80 hover:border-white/40"
            >
              Prev
            </button>
            <button
              type="button"
              onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
              className="rounded border border-white/20 px-2 py-1 text-xs text-white/80 hover:border-white/40"
            >
              Next
            </button>
            <span className="text-xs text-white/70">{`Page ${page}/${totalPages}`}</span>
            <label className="text-xs text-white/70">Rows/page</label>
            <input
              type="text"
              value={String(pageSize)}
              onChange={(e) => {
                const next = parseInt(e.target.value.trim(), 10);
                if (Number.isFinite(next) && next > 0) {
                  setPageSize(next);
                  setPage(1);
                }
              }}
              className="w-20 rounded border border-white/20 bg-black px-2 py-1 text-xs"
            />
          </div>
          <div className="max-h-[70vh] overflow-auto rounded-lg border border-white/10">
            <table className="min-w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-black">
                <tr>
                  {visibleColumns.map((col) => {
                    const isSorted = sortCol === col;
                    const headerClass = col === "asr_backdoor" ? "bg-emerald-400/30" : col === "asr_nonbackdoor" ? "bg-rose-400/30" : "";
                    return (
                      <th
                        key={col}
                        onClick={() => {
                          if (sortCol === col) setSortAsc((prev) => !prev);
                          else {
                            setSortCol(col);
                            setSortAsc(true);
                          }
                        }}
                        className={`cursor-pointer border-b border-white/10 px-2 py-2 text-right font-medium text-white/80 ${headerClass}`}
                      >
                        <span>{HEADER_LABELS[col] || col}</span>
                        <span className={`ml-1 ${isSorted ? "opacity-100" : "opacity-40"}`}>{isSorted && !sortAsc ? "▼" : "▲"}</span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((row, rowIdx) => (
                  <tr key={`${rowIdx}-${String(row.expression || "")}-${String(row.score_epoch || "")}`} className="border-b border-white/5">
                    {visibleColumns.map((col) => (
                      <td key={col} className={`px-2 py-1 text-right text-white/85 ${getCellClass(col, row)}`}>
                        {formatCell(col, row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
