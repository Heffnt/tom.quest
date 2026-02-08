"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useAuth } from "../components/AuthProvider";
import { fetchUserSetting, saveUserSetting } from "../lib/userSettings";

interface GPUTypeInfo {
  type: string;
  count: number;
  nodes: string[];
}

interface NodeInfo {
  name: string;
  gpu_type: string;
  partition: string;
  total_gpus: number;
  allocated_gpus: number;
  state: "up" | "down" | "drain";
  memory_total_mb: number;
  memory_allocated_mb: number;
}

interface GPUReport {
  nodes: NodeInfo[];
  summary: {
    available: GPUTypeInfo[];
    unavailable: GPUTypeInfo[];
    free: GPUTypeInfo[];
  };
}

interface Job {
  job_id: string;
  gpu_type: string;
  status: string;
  time_remaining: string;
  time_remaining_seconds: number;
  screen_name: string;
  start_time: string;
  end_time: string;
}

interface DirListing {
  path: string;
  dirs: string[];
  error: string | null;
}

interface ProjectCommands {
  [projectDir: string]: { name: string; commands: string[] }[];
}

interface DebugLogEntry {
  id: number;
  timestamp: Date;
  type: "request" | "response" | "error" | "info";
  method?: string;
  url?: string;
  status?: number;
  data?: unknown;
  message?: string;
  duration?: number;
}

interface TuringSettings {
  autoRefresh?: boolean;
  refreshInterval?: number;
  gpuType?: string;
  timeMins?: string;
  memoryMb?: string;
  count?: string;
  commands?: string[];
  projectCommands?: ProjectCommands;
  projectDir?: string;
  gpuOnlyFilter?: boolean;
  collapsedPartitions?: string[];
  sessionAutoRefresh?: boolean;
  sessionRefreshInterval?: number;
}

const isGpuNamedNode = (node: NodeInfo) => node.name.toLowerCase().includes("gpu");
const isNonAcademicPartition = (partition: string) => !partition.toLowerCase().includes("academic");
const getGpuTotals = (nodes: NodeInfo[]) => {
  return nodes.reduce(
    (totals, node) => {
      if (node.state === "up") {
        const free = Math.max(node.total_gpus - node.allocated_gpus, 0);
        totals.free += free;
        totals.inUse += Math.max(node.allocated_gpus, 0);
      } else {
        totals.down += Math.max(node.total_gpus, 0);
      }
      return totals;
    },
    { free: 0, inUse: 0, down: 0 }
  );
};

const API_BASE = "/api/turing";
const TURING_SETTINGS_KEY = "turing_settings";
const GPU_TYPE_LABELS: Record<string, string> = { nvidia: "H100", tesla: "V100" };

export default function Turing() {
  const { user, isTom, turingConnection, refreshTuringConnection, loading: authLoading } = useAuth();
  const canWrite = isTom || !!turingConnection;
  const [connectionKey, setConnectionKey] = useState("");
  const [connectingTuring, setConnectingTuring] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionSuccess, setConnectionSuccess] = useState<string | null>(null);
  const [gpuReport, setGpuReport] = useState<GPUReport | null>(null);
  const [gpuReportLoading, setGpuReportLoading] = useState(false);
  const [gpuReportError, setGpuReportError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [cancelAllOpen, setCancelAllOpen] = useState(false);
  const [cancelAllLoading, setCancelAllLoading] = useState(false);
  const [cancelAllError, setCancelAllError] = useState<string | null>(null);
  const [cancelJobId, setCancelJobId] = useState<string | null>(null);
  const [cancelJobLoading, setCancelJobLoading] = useState(false);
  const [cancelJobError, setCancelJobError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(30);
  const [refreshIntervalInput, setRefreshIntervalInput] = useState("30");
  const [gpuType, setGpuType] = useState("");
  const [timeMins, setTimeMins] = useState("1440");
  const [memoryMb, setMemoryMb] = useState("64000");
  const [count, setCount] = useState("");
  const [commands, setCommands] = useState<string[]>([""]);
  const [projectCommands, setProjectCommands] = useState<ProjectCommands>({});
  const [saveSetName, setSaveSetName] = useState("");
  const [allocating, setAllocating] = useState(false);
  const [allocateError, setAllocateError] = useState<string | null>(null);
  const [allocateSuccess, setAllocateSuccess] = useState<string | null>(null);
  const [projectDir, setProjectDir] = useState("");
  const [dirListing, setDirListing] = useState<DirListing | null>(null);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirBrowserOpen, setDirBrowserOpen] = useState(false);
  const [debugLogs, setDebugLogs] = useState<DebugLogEntry[]>([]);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugCopySuccess, setDebugCopySuccess] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(256);
  const [isResizing, setIsResizing] = useState(false);
  const [collapsedPartitions, setCollapsedPartitions] = useState<Set<string>>(new Set());
  const [gpuOnlyFilter, setGpuOnlyFilter] = useState(true);
  const [sessionViewerOpen, setSessionViewerOpen] = useState(false);
  const [sessionViewerName, setSessionViewerName] = useState("");
  const [sessionOutput, setSessionOutput] = useState("");
  const [sessionOutputLoading, setSessionOutputLoading] = useState(false);
  const [sessionOutputError, setSessionOutputError] = useState<string | null>(null);
  const [sessionAutoRefresh, setSessionAutoRefresh] = useState(false);
  const [sessionRefreshInterval, setSessionRefreshInterval] = useState(2);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const debugLogIdRef = useRef(0);
  const debugCopyTimeoutRef = useRef<number | null>(null);
  const sessionModalRef = useRef<HTMLDivElement>(null);
  const debugTerminalRef = useRef<HTMLDivElement>(null);
  const sessionOutputRef = useRef<HTMLPreElement>(null);
  const resizeStartY = useRef(0);
  const resizeStartHeight = useRef(0);
  const filteredNodes = useMemo(() => {
    if (!gpuReport) return [];
    return gpuOnlyFilter ? gpuReport.nodes.filter(isGpuNamedNode) : gpuReport.nodes;
  }, [gpuReport, gpuOnlyFilter]);
  const visibleNodes = useMemo(() => {
    return filteredNodes.filter((node) => !collapsedPartitions.has(node.partition));
  }, [filteredNodes, collapsedPartitions]);
  const visibleTotals = useMemo(() => getGpuTotals(visibleNodes), [visibleNodes]);
  const collapsedPartitionsList = useMemo(() => {
    return [...collapsedPartitions].sort();
  }, [collapsedPartitions]);
  const allocationFreeByType = useMemo(() => {
    if (!gpuReport) return {};
    const allocationNodes = gpuReport.nodes.filter(
      (node) => isGpuNamedNode(node) && isNonAcademicPartition(node.partition)
    );
    const totals: Record<string, number> = {};
    allocationNodes.forEach((node) => {
      if (totals[node.gpu_type] === undefined) totals[node.gpu_type] = 0;
      if (node.state !== "up") return;
      const free = Math.max(node.total_gpus - node.allocated_gpus, 0);
      totals[node.gpu_type] += free;
    });
    return totals;
  }, [gpuReport]);
  const allocationOptions = useMemo(() => {
    return Object.entries(allocationFreeByType).sort(([a], [b]) => a.localeCompare(b));
  }, [allocationFreeByType]);
  const maxAllocatable = gpuType ? allocationFreeByType[gpuType] || 0 : 0;
  const applySettings = useCallback((settings: TuringSettings) => {
    if (typeof settings.autoRefresh === "boolean") setAutoRefresh(settings.autoRefresh);
    if (typeof settings.refreshInterval === "number" && settings.refreshInterval >= 5) {
      setRefreshInterval(settings.refreshInterval);
      setRefreshIntervalInput(String(settings.refreshInterval));
    }
    if (typeof settings.gpuType === "string") setGpuType(settings.gpuType);
    if (typeof settings.timeMins === "string") setTimeMins(settings.timeMins);
    if (typeof settings.memoryMb === "string") setMemoryMb(settings.memoryMb);
    if (typeof settings.count === "string") setCount(settings.count);
    if (Array.isArray(settings.commands)) {
      setCommands(settings.commands.length > 0 ? settings.commands : [""]);
    }
    if (settings.projectCommands && typeof settings.projectCommands === "object" && !Array.isArray(settings.projectCommands)) {
      setProjectCommands(settings.projectCommands as ProjectCommands);
    }
    if (typeof settings.projectDir === "string") setProjectDir(settings.projectDir);
    if (typeof settings.gpuOnlyFilter === "boolean") setGpuOnlyFilter(settings.gpuOnlyFilter);
    if (Array.isArray(settings.collapsedPartitions)) {
      setCollapsedPartitions(
        new Set(settings.collapsedPartitions.filter((partition) => typeof partition === "string"))
      );
    }
    if (typeof settings.sessionAutoRefresh === "boolean") setSessionAutoRefresh(settings.sessionAutoRefresh);
    if (typeof settings.sessionRefreshInterval === "number" && settings.sessionRefreshInterval >= 1) {
      setSessionRefreshInterval(settings.sessionRefreshInterval);
    }
  }, []);
  const resetSettings = useCallback(() => {
    setAutoRefresh(true);
    setRefreshInterval(30);
    setRefreshIntervalInput("30");
    setGpuType("");
    setTimeMins("1440");
    setMemoryMb("64000");
    setCount("");
    setCommands([""]);
    setProjectCommands({});
    setProjectDir("");
    setGpuOnlyFilter(true);
    setCollapsedPartitions(new Set());
    setSessionAutoRefresh(false);
    setSessionRefreshInterval(2);
  }, []);
  const turingSettings = useMemo<TuringSettings>(() => {
    return {
      autoRefresh,
      refreshInterval,
      gpuType,
      timeMins,
      memoryMb,
      count,
      commands,
      projectCommands,
      projectDir,
      gpuOnlyFilter,
      collapsedPartitions: collapsedPartitionsList,
      sessionAutoRefresh,
      sessionRefreshInterval,
    };
  }, [
    autoRefresh,
    refreshInterval,
    gpuType,
    timeMins,
    memoryMb,
    count,
    commands,
    projectCommands,
    projectDir,
    gpuOnlyFilter,
    collapsedPartitionsList,
    sessionAutoRefresh,
    sessionRefreshInterval,
  ]);
  useEffect(() => {
    if (!settingsLoaded) return;
    if (allocationOptions.length === 0) {
      if (gpuType) setGpuType("");
      return;
    }
    if (!gpuType || !(gpuType in allocationFreeByType)) {
      setGpuType(allocationOptions[0][0]);
    }
  }, [allocationOptions, allocationFreeByType, gpuType, settingsLoaded]);

  const addDebugLog = useCallback((entry: Omit<DebugLogEntry, "id" | "timestamp">) => {
    setDebugLogs((prev) => {
      const newEntry: DebugLogEntry = {
        ...entry,
        id: debugLogIdRef.current++,
        timestamp: new Date(),
      };
      const updated = [...prev, newEntry];
      return updated.slice(-100); // Keep last 100 entries
    });
  }, []);

  const debugFetch = useCallback(async (url: string, options?: RequestInit) => {
    const method = options?.method || "GET";
    const startTime = Date.now();
    addDebugLog({ type: "request", method, url, data: options?.body ? JSON.parse(options.body as string) : undefined });
    // Add user ID header for auth
    const headers = {
      ...options?.headers,
      ...(user?.id ? { "x-user-id": user.id } : {}),
    };
    try {
      const res = await fetch(url, { ...options, headers });
      const duration = Date.now() - startTime;
      const data = await res.clone().json().catch(() => null);
      addDebugLog({ type: "response", method, url, status: res.status, data, duration });
      return res;
    } catch (e) {
      const duration = Date.now() - startTime;
      addDebugLog({ type: "error", method, url, message: e instanceof Error ? e.message : "Unknown error", duration });
      throw e;
    }
  }, [addDebugLog, user?.id]);

  useEffect(() => {
    if (debugTerminalRef.current && debugOpen) {
      debugTerminalRef.current.scrollTop = debugTerminalRef.current.scrollHeight;
    }
  }, [debugLogs, debugOpen]);
  useEffect(() => {
    return () => {
      if (debugCopyTimeoutRef.current) {
        // #region agent log
        fetch("http://127.0.0.1:7250/ingest/33938df4-b546-4d39-88db-8d09c7a4a5fa",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({location:"app/turing/page.tsx:227",message:"clear debug copy timeout on unmount",data:{timeoutType:typeof debugCopyTimeoutRef.current},timestamp:Date.now(),sessionId:"debug-session",runId:"pre-fix",hypothesisId:"H3"})}).catch(()=>{});
        // #endregion
        clearTimeout(debugCopyTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const deltaY = resizeStartY.current - e.clientY;
      const newHeight = Math.min(Math.max(resizeStartHeight.current + deltaY, 100), window.innerHeight - 100);
      setTerminalHeight(newHeight);
    };
    const handleMouseUp = () => {
      setIsResizing(false);
    };
    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    }
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    resizeStartY.current = e.clientY;
    resizeStartHeight.current = terminalHeight;
    setIsResizing(true);
  };

  const copyDebugLogs = async () => {
    const text = debugLogs.map((log) => {
      const time = log.timestamp.toLocaleTimeString();
      if (log.type === "request") {
        return `${time} → ${log.method} ${log.url}${log.data ? "\n" + JSON.stringify(log.data, null, 2) : ""}`;
      }
      if (log.type === "response") {
        return `${time} ← ${log.status} ${log.url} (${log.duration}ms)${log.data ? "\n" + JSON.stringify(log.data, null, 2) : ""}`;
      }
      if (log.type === "error") {
        return `${time} ✕ ERROR: ${log.message} (${log.duration}ms)`;
      }
      return `${time} ${log.message}`;
    }).join("\n\n");
    // #region agent log
    fetch("http://127.0.0.1:7250/ingest/33938df4-b546-4d39-88db-8d09c7a4a5fa",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({location:"app/turing/page.tsx:274",message:"copyDebugLogs start",data:{logCount:debugLogs.length,textLength:text.length},timestamp:Date.now(),sessionId:"debug-session",runId:"pre-fix",hypothesisId:"H1"})}).catch(()=>{});
    // #endregion
    try {
      await navigator.clipboard.writeText(text);
      setDebugCopySuccess(true);
      // #region agent log
      fetch("http://127.0.0.1:7250/ingest/33938df4-b546-4d39-88db-8d09c7a4a5fa",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({location:"app/turing/page.tsx:280",message:"copyDebugLogs clipboard success",data:{hadTimeout:!!debugCopyTimeoutRef.current,currentType:typeof debugCopyTimeoutRef.current},timestamp:Date.now(),sessionId:"debug-session",runId:"pre-fix",hypothesisId:"H1"})}).catch(()=>{});
      // #endregion
      if (debugCopyTimeoutRef.current) {
        clearTimeout(debugCopyTimeoutRef.current);
      }
      const timeoutId = window.setTimeout(() => {
        setDebugCopySuccess(false);
      }, 2000);
      debugCopyTimeoutRef.current = timeoutId;
      // #region agent log
      fetch("http://127.0.0.1:7250/ingest/33938df4-b546-4d39-88db-8d09c7a4a5fa",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({location:"app/turing/page.tsx:289",message:"copyDebugLogs setTimeout assigned",data:{timeoutType:typeof timeoutId,timeoutIdIsNumber:typeof timeoutId === "number"},timestamp:Date.now(),sessionId:"debug-session",runId:"pre-fix",hypothesisId:"H2"})}).catch(()=>{});
      // #endregion
    } catch (err) {
      // #region agent log
      fetch("http://127.0.0.1:7250/ingest/33938df4-b546-4d39-88db-8d09c7a4a5fa",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({location:"app/turing/page.tsx:293",message:"copyDebugLogs clipboard error",data:{error:err instanceof Error ? err.message : "unknown"},timestamp:Date.now(),sessionId:"debug-session",runId:"pre-fix",hypothesisId:"H4"})}).catch(()=>{});
      // #endregion
      // Ignore clipboard errors
    }
  };

  const fetchGpuReport = useCallback(async () => {
    setGpuReportLoading(true);
    setGpuReportError(null);
    try {
      const res = await debugFetch(`${API_BASE}/gpu-report`);
      if (!res.ok) throw new Error("Failed to fetch GPU report");
      const data = await res.json();
      setGpuReport(data);
    } catch (e) {
      setGpuReportError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setGpuReportLoading(false);
    }
  }, [debugFetch]);

  const fetchJobs = useCallback(async () => {
    setJobsLoading(true);
    setJobsError(null);
    try {
      const res = await debugFetch(`${API_BASE}/jobs`);
      if (!res.ok) throw new Error("Failed to fetch jobs");
      const data = await res.json();
      setJobs(data);
    } catch (e) {
      setJobsError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setJobsLoading(false);
    }
  }, [debugFetch]);

  const fetchDirs = useCallback(async (path: string = "") => {
    setDirLoading(true);
    try {
      const url = path ? `${API_BASE}/dirs?path=${encodeURIComponent(path)}` : `${API_BASE}/dirs`;
      const res = await debugFetch(url);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const message = data && typeof data === "object" && ("error" in data || "detail" in data)
          ? String((data as { error?: string; detail?: string }).error ?? (data as { detail?: string }).detail)
          : "Failed to list directory";
        throw new Error(message);
      }
      if (!data) throw new Error("Invalid directory response");
      setDirListing(data);
    } catch (e) {
      setDirListing({ path: path, dirs: [], error: e instanceof Error ? e.message : "Unknown error" });
    } finally {
      setDirLoading(false);
    }
  }, [debugFetch]);

  const fetchSessionOutput = useCallback(async (sessionName: string) => {
    setSessionOutputLoading(true);
    setSessionOutputError(null);
    try {
      const res = await debugFetch(`${API_BASE}/sessions/${encodeURIComponent(sessionName)}/output`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || data.detail || "Failed to fetch session output");
      }
      setSessionOutput(data.output || "");
    } catch (e) {
      setSessionOutputError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSessionOutputLoading(false);
    }
  }, [debugFetch]);

  const openSessionViewer = useCallback((sessionName: string) => {
    setSessionViewerName(sessionName);
    setSessionViewerOpen(true);
    setSessionOutput("");
    setSessionOutputError(null);
    fetchSessionOutput(sessionName);
  }, [fetchSessionOutput]);

  const viewableSessions = jobs
    .filter(job => job.screen_name && job.status.startsWith("RUNNING"))
    .map(job => job.screen_name);

  const navigateSession = useCallback((direction: -1 | 1) => {
    if (viewableSessions.length === 0) return;
    const currentIndex = viewableSessions.indexOf(sessionViewerName);
    let newIndex: number;
    if (currentIndex === -1) {
      newIndex = 0;
    } else {
      newIndex = (currentIndex + direction + viewableSessions.length) % viewableSessions.length;
    }
    const newSession = viewableSessions[newIndex];
    setSessionViewerName(newSession);
    setSessionOutput("");
    setSessionOutputError(null);
    fetchSessionOutput(newSession);
  }, [viewableSessions, sessionViewerName, fetchSessionOutput]);

  const handleSessionModalBackdropClick = useCallback((e: React.MouseEvent) => {
    if (sessionModalRef.current && !sessionModalRef.current.contains(e.target as Node)) {
      setSessionViewerOpen(false);
    }
  }, []);

  const refreshAll = useCallback(() => {
    fetchGpuReport();
    fetchJobs();
  }, [fetchGpuReport, fetchJobs]);

  useEffect(() => {
    refreshAll();
    if (!autoRefresh) return;
    const interval = setInterval(refreshAll, refreshInterval * 1000);
    return () => clearInterval(interval);
  }, [refreshAll, autoRefresh, refreshInterval]);

  useEffect(() => {
    let cancelled = false;
    const loadSettings = async () => {
      setSettingsLoaded(false);
      resetSettings();
      if (user) {
        const settings = await fetchUserSetting<TuringSettings>(user.id, TURING_SETTINGS_KEY);
        if (!cancelled && settings) {
          applySettings(settings);
        }
        if (!cancelled) setSettingsLoaded(true);
        return;
      }
      try {
        const raw = localStorage.getItem(TURING_SETTINGS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (typeof parsed === "object" && parsed !== null) {
            applySettings(parsed as TuringSettings);
          }
        }
      } catch {
        // Ignore parse errors
      }
      if (!cancelled) setSettingsLoaded(true);
    };
    void loadSettings();
    return () => {
      cancelled = true;
    };
  }, [user, applySettings, resetSettings]);

  useEffect(() => {
    if (!settingsLoaded) return;
    if (user) {
      const timeoutId = window.setTimeout(() => {
        void saveUserSetting(user.id, TURING_SETTINGS_KEY, turingSettings);
      }, 400);
      return () => window.clearTimeout(timeoutId);
    }
    try {
      localStorage.setItem(TURING_SETTINGS_KEY, JSON.stringify(turingSettings));
    } catch {
      // Ignore storage errors
    }
  }, [settingsLoaded, user, turingSettings]);

  useEffect(() => {
    if (!sessionViewerOpen || !sessionAutoRefresh || !sessionViewerName) return;
    const interval = setInterval(() => {
      fetchSessionOutput(sessionViewerName);
    }, sessionRefreshInterval * 1000);
    return () => clearInterval(interval);
  }, [sessionViewerOpen, sessionAutoRefresh, sessionViewerName, sessionRefreshInterval, fetchSessionOutput]);

  useEffect(() => {
    if (sessionOutputRef.current && sessionOutput) {
      sessionOutputRef.current.scrollTop = sessionOutputRef.current.scrollHeight;
    }
  }, [sessionOutput]);

  const togglePartition = (partition: string) => {
    setCollapsedPartitions(prev => {
      const next = new Set(prev);
      if (next.has(partition)) next.delete(partition);
      else next.add(partition);
      return next;
    });
  };

  const handleAllocate = async (e: React.FormEvent) => {
    e.preventDefault();
    setAllocating(true);
    setAllocateError(null);
    setAllocateSuccess(null);
    const countValue = count.trim();
    const timeNum = parseInt(timeMins, 10);
    const memoryNum = parseInt(memoryMb, 10);
    const resolvedCount = countValue ? parseInt(countValue, 10) : Math.min(Math.max(maxAllocatable, 1), 12);
    if (isNaN(resolvedCount) || resolvedCount < 1 || resolvedCount > 12) {
      setAllocateError("Count must be between 1 and 12");
      setAllocating(false);
      return;
    }
    if (isNaN(timeNum) || timeNum < 1) {
      setAllocateError("Time must be at least 1 minute");
      setAllocating(false);
      return;
    }
    if (isNaN(memoryNum) || memoryNum < 1) {
      setAllocateError("Memory must be at least 1 MB");
      setAllocating(false);
      return;
    }
    try {
      const res = await debugFetch(`${API_BASE}/allocate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gpu_type: gpuType,
          time_mins: timeNum,
          memory_mb: memoryNum,
          count: resolvedCount,
          commands: commands.filter((c) => c.trim()),
          project_dir: projectDir,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || "Failed to allocate");
      }
      if (data.success) {
        setAllocateSuccess(
          `Allocated ${data.job_ids.length} GPU(s): ${data.job_ids.join(", ")}`
        );
        fetchJobs();
        fetchGpuReport();
      }
      if (data.errors?.length > 0) {
        setAllocateError(data.errors.join(", "));
      }
    } catch (e) {
      setAllocateError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setAllocating(false);
    }
  };

  const handleCancel = async (jobId: string) => {
    try {
      const res = await debugFetch(`${API_BASE}/jobs/${jobId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || "Failed to cancel");
      }
      fetchJobs();
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to cancel job";
      setJobsError(message);
      setCancelJobError(message);
      return false;
    }
  };
  const openCancelJob = (jobId: string) => {
    setCancelJobError(null);
    setCancelJobLoading(false);
    setCancelJobId(jobId);
  };
  const closeCancelJob = () => {
    if (cancelJobLoading) return;
    setCancelJobId(null);
    setCancelJobError(null);
  };
  const handleConfirmCancelJob = async () => {
    if (!cancelJobId) return;
    setCancelJobLoading(true);
    const success = await handleCancel(cancelJobId);
    setCancelJobLoading(false);
    if (success) {
      setCancelJobId(null);
    }
  };
  const openCancelAll = () => {
    setCancelAllError(null);
    setCancelAllOpen(true);
  };
  const handleCancelAll = async () => {
    setCancelAllLoading(true);
    setCancelAllError(null);
    const failures: string[] = [];
    for (const job of jobs) {
      try {
        const res = await debugFetch(`${API_BASE}/jobs/${job.job_id}`, { method: "DELETE" });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          const message = data && typeof data === "object" && ("detail" in data || "error" in data)
            ? String((data as { detail?: string; error?: string }).detail ?? (data as { error?: string }).error)
            : "Failed to cancel";
          failures.push(`${job.job_id}: ${message}`);
        }
      } catch (e) {
        failures.push(`${job.job_id}: ${e instanceof Error ? e.message : "Unknown error"}`);
      }
    }
    if (failures.length > 0) {
      setCancelAllError(failures.join(", "));
    } else {
      setCancelAllOpen(false);
    }
    setCancelAllLoading(false);
    refreshAll();
  };

  const addCommand = () => setCommands([...commands, ""]);
  const removeCommand = (index: number) => {
    setCommands(commands.filter((_, i) => i !== index));
  };
  const updateCommand = (index: number, value: string) => {
    const updated = [...commands];
    updated[index] = value;
    setCommands(updated);
  };

  const persistProjectCommands = (cmds: ProjectCommands) => {
    setProjectCommands(cmds);
  };

  const handleSaveCommandSet = () => {
    const trimmedName = saveSetName.trim();
    const cleanedCommands = commands.map((c) => c.trim()).filter(Boolean);
    if (!trimmedName || cleanedCommands.length === 0 || !projectDir) return;
    const projectSets = projectCommands[projectDir] || [];
    const newSets = [
      { name: trimmedName, commands: cleanedCommands },
      ...projectSets.filter((set) => set.name !== trimmedName),
    ];
    persistProjectCommands({ ...projectCommands, [projectDir]: newSets });
    setSaveSetName("");
  };

  const handleLoadCommandSet = (commandsToLoad: string[]) => {
    setCommands(commandsToLoad.length > 0 ? commandsToLoad : [""]);
  };

  const handleDeleteCommandSet = (name: string) => {
    if (!projectDir) return;
    const projectSets = projectCommands[projectDir] || [];
    const newSets = projectSets.filter((set) => set.name !== name);
    persistProjectCommands({ ...projectCommands, [projectDir]: newSets });
  };

  const currentProjectSets = projectDir ? (projectCommands[projectDir] || []) : [];

  const handleConnectTuring = async () => {
    if (!connectionKey.trim() || !user) return;
    setConnectingTuring(true);
    setConnectionError(null);
    setConnectionSuccess(null);
    try {
      const res = await fetch(`${API_BASE}/connection`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": user.id,
        },
        body: JSON.stringify({ connectionKey: connectionKey.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to connect");
      }
      setConnectionSuccess("Connected successfully!");
      setConnectionKey("");
      refreshTuringConnection();
    } catch (e) {
      setConnectionError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setConnectingTuring(false);
    }
  };

  const handleDisconnectTuring = async () => {
    if (!user) return;
    try {
      await fetch(`${API_BASE}/connection`, {
        method: "DELETE",
        headers: { "x-user-id": user.id },
      });
      refreshTuringConnection();
    } catch {
      // Ignore errors
    }
  };

  const openDirBrowser = () => {
    setDirBrowserOpen(true);
    fetchDirs(projectDir || "");
  };

  const navigateToDir = (dir: string) => {
    const newPath = dirListing ? `${dirListing.path}/${dir}` : dir;
    fetchDirs(newPath);
  };

  const navigateUp = () => {
    if (!dirListing) return;
    const parts = dirListing.path.split("/");
    parts.pop();
    const newPath = parts.join("/") || "/";
    fetchDirs(newPath);
  };

  const selectCurrentDir = () => {
    if (dirListing) {
      setProjectDir(dirListing.path);
    }
    setDirBrowserOpen(false);
  };

  return (
    <div className="min-h-screen px-6 py-16" style={{ paddingBottom: debugOpen ? terminalHeight + 60 : 60 }}>
      <div className="max-w-4xl mx-auto">
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight animate-fade-in">
          Turing
        </h1>
        <p className="mt-4 text-xl text-white/60 animate-fade-in-delay">
          GPU allocation and monitoring dashboard
        </p>

        {/* Read-only banner for guests */}
        {!canWrite && !authLoading && (
          <div className="mt-6 p-4 border border-yellow-500/30 bg-yellow-500/10 rounded-lg animate-fade-in-delay">
            <p className="text-yellow-400 text-sm">
              {user ? (
                <>You&apos;re viewing Tom&apos;s Turing dashboard in read-only mode. Connect your own Turing account below to allocate GPUs.</>
              ) : (
                <>You&apos;re viewing Tom&apos;s Turing dashboard in read-only mode. Sign in and connect your Turing account to allocate GPUs.</>
              )}
            </p>
          </div>
        )}

        {/* Turing Connection Setup (for logged-in users without connection) */}
        {user && !authLoading && (
          <section className="mt-6 animate-fade-in-delay">
            <div className="border border-white/10 rounded-lg p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">Your Turing Connection</h2>
                {turingConnection && (() => {
                  const heartbeatAge = turingConnection.last_heartbeat
                    ? Date.now() - new Date(turingConnection.last_heartbeat).getTime()
                    : Infinity;
                  const isOnline = heartbeatAge < 120_000;
                  return (
                    <span className={`text-xs px-2 py-1 rounded ${isOnline ? "text-green-400 bg-green-400/10" : "text-yellow-400 bg-yellow-400/10"}`}>
                      {isOnline ? "Connected" : "Backend offline"}
                    </span>
                  );
                })()}
              </div>
              {turingConnection ? (
                <div className="space-y-3">
                  <div>
                    <p className="text-sm text-white/60">Connection key:</p>
                    <p className="font-mono text-sm truncate">{turingConnection.connection_key}</p>
                  </div>
                  <button
                    onClick={handleDisconnectTuring}
                    className="px-4 py-2 text-sm text-red-400 bg-red-400/10 hover:bg-red-400/20 rounded transition-colors"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <p className="text-sm text-white/60">
                    Run <span className="font-mono text-white/80">python main.py</span> in <span className="font-mono text-white/80">tom-quest-api/</span> on Turing, then paste your connection key below.
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={connectionKey}
                      onChange={(e) => setConnectionKey(e.target.value)}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded text-white font-mono text-sm focus:outline-none focus:border-white/30"
                    />
                    <button
                      onClick={handleConnectTuring}
                      disabled={connectingTuring || !connectionKey.trim()}
                      className="px-4 py-2 text-sm bg-white text-black font-medium rounded hover:bg-white/90 transition-colors disabled:opacity-50"
                    >
                      {connectingTuring ? "Connecting..." : "Connect"}
                    </button>
                  </div>
                  {connectionError && <p className="text-red-400 text-sm">{connectionError}</p>}
                  {connectionSuccess && <p className="text-green-400 text-sm">{connectionSuccess}</p>}
                </div>
              )}
            </div>
          </section>
        )}

        {/* Refresh Controls */}
        <div className="mt-8 flex flex-wrap items-center gap-4 border border-white/10 rounded-lg p-4 animate-fade-in-delay">
          <button
            onClick={refreshAll}
            disabled={gpuReportLoading || jobsLoading}
            className="px-4 py-2 text-sm bg-white/10 hover:bg-white/20 rounded transition-colors disabled:opacity-50"
          >
            {gpuReportLoading || jobsLoading ? "Loading..." : "Refresh All"}
          </button>
          <label className="flex items-center gap-2 text-sm text-white/60 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="sr-only"
            />
            <span
              className={`w-9 h-5 rounded-full border transition-colors ${
                autoRefresh ? "bg-white/80 border-white/60" : "bg-white/10 border-white/20"
              }`}
            >
              <span
                className={`block w-4 h-4 bg-black rounded-full transition-transform ${
                  autoRefresh ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </span>
            Auto-refresh
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              value={refreshIntervalInput}
              onChange={(e) => {
                const value = e.target.value;
                setRefreshIntervalInput(value);
                const val = parseInt(value, 10);
                if (!isNaN(val) && val >= 5) setRefreshInterval(val);
              }}
              onBlur={() => {
                const val = parseInt(refreshIntervalInput, 10);
                if (isNaN(val) || val < 5) {
                  setRefreshIntervalInput(String(refreshInterval));
                }
              }}
              className="w-20 px-2 py-1 text-sm bg-white/5 border border-white/10 rounded text-white focus:outline-none focus:border-white/30"
            />
            <span className="text-sm text-white/40">seconds</span>
          </div>
        </div>

        {/* GPU Report Panel */}
        <section className="mt-12 animate-fade-in-delay">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-semibold">GPU Availability</h2>
            <button
              onClick={fetchGpuReport}
              disabled={gpuReportLoading}
              className="px-4 py-2 text-sm bg-white/10 hover:bg-white/20 rounded transition-colors disabled:opacity-50"
            >
              {gpuReportLoading ? "Loading..." : "Refresh"}
            </button>
          </div>
          {gpuReportError && (
            <p className="text-red-400 mb-4">{gpuReportError}</p>
          )}
          {gpuReport && (
            <div className="border border-white/10 rounded-lg p-6 space-y-6">
              {/* Legend and Filter */}
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-6 text-sm">
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-semibold text-black bg-[#22c55e]">
                      {visibleTotals.free}
                    </div>
                    <span className="text-white/60">Free</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-semibold text-black bg-[#6b7280]">
                      {visibleTotals.inUse}
                    </div>
                    <span className="text-white/60">In Use</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-semibold text-black bg-[#ef4444]">
                      {visibleTotals.down}
                    </div>
                    <span className="text-white/60">Down</span>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-white/60 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={gpuOnlyFilter}
                    onChange={(e) => setGpuOnlyFilter(e.target.checked)}
                    className="sr-only"
                  />
                  <span
                    className={`w-9 h-5 rounded-full border transition-colors ${
                      gpuOnlyFilter ? "bg-white/80 border-white/60" : "bg-white/10 border-white/20"
                    }`}
                  >
                    <span
                      className={`block w-4 h-4 bg-black rounded-full transition-transform ${
                        gpuOnlyFilter ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </span>
                  GPU nodes only
                </label>
              </div>
              {/* GPU Grid by Partition → GPU Type */}
              {(() => {
                const partitions = [...new Set(filteredNodes.map(n => n.partition))].sort();
                return partitions.map(partition => {
                  const partitionNodes = filteredNodes.filter(n => n.partition === partition);
                  const gpuTypes = [...new Set(partitionNodes.map(n => n.gpu_type))].sort();
                  const isCollapsed = collapsedPartitions.has(partition);
                  return (
                    <div key={partition} className="border border-white/10 rounded-lg overflow-hidden">
                      <button
                        onClick={() => togglePartition(partition)}
                        className="w-full px-4 py-3 flex items-center justify-between bg-white/5 hover:bg-white/10 transition-colors"
                      >
                        <span className="font-medium text-white/80">{partition}</span>
                        <span className="text-white/40 text-sm">{isCollapsed ? "+" : "-"}</span>
                      </button>
                      {!isCollapsed && (
                        <div className="p-4 space-y-4">
                          {gpuTypes.map(gpuType => {
                            const nodesOfType = partitionNodes.filter(n => n.gpu_type === gpuType);
                            const alias = GPU_TYPE_LABELS[gpuType];
                            const label = alias ? `${gpuType} (${alias})` : gpuType;
                            return (
                              <div key={gpuType}>
                                <h4 className="text-sm font-medium text-white/60 mb-2">{label}</h4>
                                <div className="flex flex-wrap gap-3">
                                  {nodesOfType.map(node => {
                                    const freeGpus = node.state === "up" ? node.total_gpus - node.allocated_gpus : 0;
                                    const inUseGpus = node.state === "up" ? node.allocated_gpus : 0;
                                    const downGpus = node.state !== "up" ? node.total_gpus : 0;
                                    const gpuBoxes: Array<"free" | "in_use" | "down"> = [];
                                    for (let i = 0; i < freeGpus; i++) gpuBoxes.push("free");
                                    for (let i = 0; i < inUseGpus; i++) gpuBoxes.push("in_use");
                                    for (let i = 0; i < downGpus; i++) gpuBoxes.push("down");
                                    const boxSize = 14;
                                    const boxGap = 3;
                                    const cols = Math.min(node.total_gpus, 4);
                                    const rows = Math.ceil(node.total_gpus / cols);
                                    const svgWidth = cols * boxSize + (cols - 1) * boxGap;
                                    const svgHeight = rows * boxSize + (rows - 1) * boxGap;
                                    const memoryTotalGb = Math.round(node.memory_total_mb / 1024);
                                    const memoryAllocGb = Math.round(node.memory_allocated_mb / 1024);
                                    const memoryPct = memoryTotalGb > 0 ? (memoryAllocGb / memoryTotalGb) * 100 : 0;
                                    return (
                                      <div key={node.name} className="border border-white/10 rounded-lg p-3 bg-white/[0.02]">
                                        <div className="text-xs text-white/50 mb-2 font-mono">{node.name}</div>
                                        <svg width={svgWidth} height={svgHeight}>
                                          {gpuBoxes.map((status, i) => {
                                            const col = i % cols;
                                            const row = Math.floor(i / cols);
                                            const x = col * (boxSize + boxGap);
                                            const y = row * (boxSize + boxGap);
                                            const fill = status === "free" ? "#22c55e" : status === "in_use" ? "#6b7280" : "#ef4444";
                                            return <rect key={i} x={x} y={y} width={boxSize} height={boxSize} rx={2} fill={fill} />;
                                          })}
                                        </svg>
                                        <div className="mt-3">
                                          <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                                            <div className="h-full bg-white/40 transition-all" style={{ width: `${memoryPct}%` }} />
                                          </div>
                                          <div className="text-[10px] text-white/40 mt-1 font-mono">
                                            {memoryAllocGb}/{memoryTotalGb} GB
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                });
              })()}
              <div className="text-sm text-white/60">
                <div>Visible GPU totals</div>
                <div className="text-white/40">
                  Free: {visibleTotals.free} / In use: {visibleTotals.inUse} / Down: {visibleTotals.down}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Allocation Form */}
        <section className="mt-12 animate-fade-in-delay">
          <h2 className="text-2xl font-semibold mb-4">Allocate GPUs</h2>
          {!canWrite ? (
            <div className="border border-white/10 rounded-lg p-6 text-center">
              <p className="text-white/40">
                {user ? "Connect your Turing account above to allocate GPUs." : "Sign in and connect your Turing account to allocate GPUs."}
              </p>
            </div>
          ) : (
          <form
            onSubmit={handleAllocate}
            className="border border-white/10 rounded-lg p-6 space-y-4"
          >
            {/* Project Directory */}
            <div>
              <label className="block text-sm text-white/60 mb-1">
                Project Directory
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={projectDir}
                  onChange={(e) => setProjectDir(e.target.value)}
                  placeholder="Select a project directory..."
                  className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded text-white font-mono text-sm focus:outline-none focus:border-white/30"
                  readOnly
                />
                <button
                  type="button"
                  onClick={openDirBrowser}
                  className="px-4 py-2 text-sm bg-white/10 hover:bg-white/20 rounded transition-colors"
                >
                  Browse
                </button>
              </div>
            </div>

            {/* Directory Browser Modal */}
            {dirBrowserOpen && (
              <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
                <div className="bg-black border border-white/20 rounded-lg p-6 w-full max-w-lg max-h-[80vh] flex flex-col">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-semibold">Select Project Directory</h3>
                    <button
                      type="button"
                      onClick={() => setDirBrowserOpen(false)}
                      className="text-white/60 hover:text-white"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex items-center gap-2 mb-4">
                    <button
                      type="button"
                      onClick={navigateUp}
                      disabled={dirLoading}
                      className="px-3 py-1 text-sm bg-white/10 hover:bg-white/20 rounded transition-colors disabled:opacity-50"
                    >
                      ↑ Up
                    </button>
                    <span className="text-sm text-white/60 font-mono truncate flex-1">
                      {dirListing?.path || "Loading..."}
                    </span>
                  </div>
                  {dirListing?.error && (
                    <p className="text-red-400 text-sm mb-2">{dirListing.error}</p>
                  )}
                  <div className="flex-1 overflow-y-auto border border-white/10 rounded mb-4">
                    {dirLoading ? (
                      <p className="p-4 text-white/40">Loading...</p>
                    ) : dirListing?.dirs.length === 0 ? (
                      <p className="p-4 text-white/40">No subdirectories</p>
                    ) : (
                      dirListing?.dirs.map((dir) => (
                        <button
                          key={dir}
                          type="button"
                          onClick={() => navigateToDir(dir)}
                          className="w-full px-4 py-2 text-left text-sm hover:bg-white/10 border-b border-white/5 font-mono"
                        >
                          📁 {dir}
                        </button>
                      ))
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={selectCurrentDir}
                    className="w-full py-2 bg-white text-black font-semibold rounded hover:bg-white/90 transition-colors"
                  >
                    Select This Directory
                  </button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-white/60 mb-1">
                  GPU Type
                </label>
                <select
                  value={gpuType}
                  onChange={(e) => setGpuType(e.target.value)}
                  disabled={allocationOptions.length === 0}
                  className="w-full px-3 py-2 bg-black/80 border border-white/10 rounded text-white focus:outline-none focus:border-white/30"
                >
                  {allocationOptions.length === 0 ? (
                    <option value="" className="bg-black text-white">
                      No allocatable GPU types
                    </option>
                  ) : (
                    allocationOptions.map(([type, free]) => {
                      const alias = GPU_TYPE_LABELS[type];
                      const label = alias ? `${type} (${alias})` : type;
                      return (
                        <option
                          key={type}
                          value={type}
                          className="bg-black text-white"
                        >
                          {label} ({free} free)
                        </option>
                      );
                    })
                  )}
                </select>
              </div>
              <div>
                <label className="block text-sm text-white/60 mb-1">
                  Count <span className="text-white/30">(max 12)</span>
                </label>
                <input
                  type="text"
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  placeholder="All"
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded text-white focus:outline-none focus:border-white/30"
                />
                <p className="text-xs text-white/40 mt-1">
                  Leave blank to allocate all free GPUs (defaults to 1 if none free).
                </p>
              </div>
              <div>
                <label className="block text-sm text-white/60 mb-1">
                  Time (minutes)
                </label>
                <input
                  type="text"
                  value={timeMins}
                  onChange={(e) => setTimeMins(e.target.value)}
                  placeholder="60"
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded text-white focus:outline-none focus:border-white/30"
                />
                <p className="text-xs text-white/40 mt-1">
                  Set to 1440 for 24 hours.
                </p>
              </div>
              <div>
                <label className="block text-sm text-white/60 mb-1">
                  Memory (MB)
                </label>
                <input
                  type="text"
                  value={memoryMb}
                  onChange={(e) => setMemoryMb(e.target.value)}
                  placeholder="64000"
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded text-white focus:outline-none focus:border-white/30"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm text-white/60 mb-2">
                Commands <span className="text-white/30">(executed in order after cd to project dir)</span>
              </label>
              {projectDir && (
                <>
                  <div className="flex flex-col gap-2 mb-3">
                    <div className="flex flex-col md:flex-row gap-2">
                      <input
                        type="text"
                        value={saveSetName}
                        onChange={(e) => setSaveSetName(e.target.value)}
                        placeholder="Save as..."
                        className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded text-white text-sm focus:outline-none focus:border-white/30"
                      />
                      <button
                        type="button"
                        onClick={handleSaveCommandSet}
                        className="px-3 py-2 text-sm bg-white/10 hover:bg-white/20 rounded transition-colors"
                      >
                        Save Set
                      </button>
                    </div>
                    <p className="text-xs text-white/30">
                      Saved for this project in this browser.
                    </p>
                  </div>
                  {currentProjectSets.length > 0 && (
                    <div className="flex flex-col gap-2 mb-4">
                      {currentProjectSets.map((set) => (
                        <div
                          key={set.name}
                          className="flex flex-col md:flex-row md:items-center gap-2"
                        >
                          <button
                            type="button"
                            onClick={() => handleLoadCommandSet(set.commands)}
                            className="flex-1 px-3 py-2 text-left text-sm bg-white/5 hover:bg-white/10 rounded transition-colors"
                          >
                            {set.name}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteCommandSet(set.name)}
                            className="px-3 py-2 text-sm text-red-400 hover:bg-red-400/10 rounded transition-colors"
                          >
                            Delete
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
              {!projectDir && (
                <p className="text-xs text-white/40 mb-3">
                  Select a project directory to save command sets.
                </p>
              )}
              <div className="space-y-2">
                {commands.map((cmd, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      type="text"
                      value={cmd}
                      onChange={(e) => updateCommand(i, e.target.value)}
                      placeholder={`Command ${i + 1}`}
                      className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded text-white font-mono text-sm focus:outline-none focus:border-white/30"
                    />
                    {commands.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeCommand(i)}
                        className="px-3 py-2 text-red-400 hover:bg-red-400/10 rounded transition-colors"
                      >
                        X
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={addCommand}
                className="mt-2 px-3 py-1 text-sm text-white/60 hover:text-white hover:bg-white/10 rounded transition-colors"
              >
                + Add Command
              </button>
            </div>

            {allocateError && (
              <p className="text-red-400 text-sm">{allocateError}</p>
            )}
            {allocateSuccess && (
              <p className="text-green-400 text-sm">{allocateSuccess}</p>
            )}

            <button
              type="submit"
              disabled={allocating || !gpuType}
              className="w-full py-3 bg-white text-black font-semibold rounded hover:bg-white/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {allocating ? "Allocating..." : "Allocate"}
            </button>
          </form>
          )}
        </section>

        {/* Active Jobs Table */}
        <section className="mt-12 animate-fade-in-delay pb-20">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-semibold">Active Jobs</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={fetchJobs}
                disabled={jobsLoading}
                className="px-4 py-2 text-sm bg-white/10 hover:bg-white/20 rounded transition-colors disabled:opacity-50"
              >
                {jobsLoading ? "Loading..." : "Refresh"}
              </button>
              {canWrite && (
                <button
                  onClick={openCancelAll}
                  disabled={jobsLoading || jobs.length === 0}
                  className="px-4 py-2 text-sm text-red-300 bg-red-500/10 hover:bg-red-500/20 rounded transition-colors disabled:opacity-50"
                >
                  Cancel All
                </button>
              )}
            </div>
          </div>
          {jobsError && <p className="text-red-400 mb-4">{jobsError}</p>}
          {jobs.length === 0 ? (
            <div className="border border-white/10 rounded-lg p-8">
              <p className="text-white/40 text-center font-mono">
                No active jobs
              </p>
            </div>
          ) : (
            <div className="border border-white/10 rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/5">
                      <th className="px-4 py-3 text-left font-medium text-white/60">
                        Job ID
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-white/60">
                        GPU
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-white/60">
                        Status
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-white/60">
                        Time Left
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-white/60">
                        Session
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-white/60">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((job) => (
                      <tr
                        key={job.job_id}
                        className="border-b border-white/5 hover:bg-white/5"
                      >
                        <td className="px-4 py-3 font-mono">{job.job_id}</td>
                        <td className="px-4 py-3">{job.gpu_type}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`px-2 py-1 rounded text-xs ${
                              job.status.startsWith("RUNNING")
                                ? "bg-green-400/20 text-green-400"
                                : "bg-yellow-400/20 text-yellow-400"
                            }`}
                          >
                            {job.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono">
                          {job.time_remaining}
                        </td>
                        <td className="px-4 py-3 font-mono text-white/60">
                          {job.screen_name || "-"}
                        </td>
                        <td className="px-4 py-3 text-right space-x-2">
                          {job.screen_name && job.status.startsWith("RUNNING") && (
                            <button
                              onClick={() => openSessionViewer(job.screen_name)}
                              className="px-3 py-1 text-sm text-blue-400 hover:bg-blue-400/10 rounded transition-colors"
                            >
                              View
                            </button>
                          )}
                          {canWrite && (
                            <button
                              onClick={() => openCancelJob(job.job_id)}
                              className="px-3 py-1 text-sm text-red-400 hover:bg-red-400/10 rounded transition-colors"
                            >
                              Cancel
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      </div>

      {cancelJobId && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-black border border-white/20 rounded-lg p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-semibold">Cancel job {cancelJobId}?</h3>
            <p className="text-sm text-white/60 mt-2">
              This will cancel the selected job.
            </p>
            {cancelJobError && <p className="text-red-400 text-sm mt-3">{cancelJobError}</p>}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeCancelJob}
                disabled={cancelJobLoading}
                className="px-3 py-2 text-sm bg-white/10 hover:bg-white/20 rounded transition-colors disabled:opacity-50"
              >
                Keep Job
              </button>
              <button
                type="button"
                onClick={handleConfirmCancelJob}
                disabled={cancelJobLoading}
                className="px-3 py-2 text-sm text-red-200 bg-red-500/20 hover:bg-red-500/30 rounded transition-colors disabled:opacity-50"
              >
                {cancelJobLoading ? "Canceling..." : "Cancel Job"}
              </button>
            </div>
          </div>
        </div>
      )}
      {cancelAllOpen && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-black border border-white/20 rounded-lg p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-semibold">Cancel all jobs?</h3>
            <p className="text-sm text-white/60 mt-2">
              This will cancel {jobs.length} active job{jobs.length === 1 ? "" : "s"}.
            </p>
            {cancelAllError && <p className="text-red-400 text-sm mt-3">{cancelAllError}</p>}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setCancelAllOpen(false)}
                disabled={cancelAllLoading}
                className="px-3 py-2 text-sm bg-white/10 hover:bg-white/20 rounded transition-colors disabled:opacity-50"
              >
                Keep Jobs
              </button>
              <button
                type="button"
                onClick={handleCancelAll}
                disabled={cancelAllLoading}
                className="px-3 py-2 text-sm text-red-200 bg-red-500/20 hover:bg-red-500/30 rounded transition-colors disabled:opacity-50"
              >
                {cancelAllLoading ? "Canceling..." : "Cancel All"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Session Output Viewer Modal */}
      {sessionViewerOpen && (
        <div
          className="fixed inset-0 bg-black/90 flex items-center justify-center z-50"
          onClick={handleSessionModalBackdropClick}
        >
          <div
            ref={sessionModalRef}
            className="bg-black border border-white/20 rounded-lg w-full max-w-4xl max-h-[90vh] flex flex-col mx-4"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
              <div className="flex items-center gap-2">
                {viewableSessions.length > 1 && (
                  <button
                    onClick={() => navigateSession(-1)}
                    className="px-2 py-1 text-white/60 hover:text-white hover:bg-white/10 rounded transition-colors"
                    title="Previous session"
                  >
                    ←
                  </button>
                )}
                <h3 className="text-lg font-semibold font-mono">{sessionViewerName}</h3>
                {viewableSessions.length > 1 && (
                  <button
                    onClick={() => navigateSession(1)}
                    className="px-2 py-1 text-white/60 hover:text-white hover:bg-white/10 rounded transition-colors"
                    title="Next session"
                  >
                    →
                  </button>
                )}
                <span className="text-xs text-white/40 ml-2">
                  {viewableSessions.length > 1
                    ? `${viewableSessions.indexOf(sessionViewerName) + 1}/${viewableSessions.length}`
                    : "tmux session"}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-white/60 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={sessionAutoRefresh}
                    onChange={(e) => setSessionAutoRefresh(e.target.checked)}
                    className="sr-only"
                  />
                  <span
                    className={`w-8 h-4 rounded-full border transition-colors ${
                      sessionAutoRefresh ? "bg-white/80 border-white/60" : "bg-white/10 border-white/20"
                    }`}
                  >
                    <span
                      className={`block w-3 h-3 bg-black rounded-full transition-transform ${
                        sessionAutoRefresh ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </span>
                  Auto
                </label>
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={sessionRefreshInterval}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val) && val >= 1) setSessionRefreshInterval(val);
                    }}
                    className="w-12 px-2 py-1 text-xs bg-white/5 border border-white/10 rounded text-white focus:outline-none focus:border-white/30"
                  />
                  <span className="text-xs text-white/40">s</span>
                </div>
                <button
                  onClick={() => fetchSessionOutput(sessionViewerName)}
                  disabled={sessionOutputLoading}
                  className="px-3 py-1 text-sm bg-white/10 hover:bg-white/20 rounded transition-colors disabled:opacity-50"
                >
                  {sessionOutputLoading ? "..." : "Refresh"}
                </button>
                <button
                  onClick={() => setSessionViewerOpen(false)}
                  className="text-white/60 hover:text-white px-2"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden p-1">
              {sessionOutputError ? (
                <div className="p-4 text-red-400">{sessionOutputError}</div>
              ) : (
                <pre
                  ref={sessionOutputRef}
                  className="h-full overflow-auto p-4 text-sm font-mono text-green-400 bg-black/50 rounded whitespace-pre-wrap break-all"
                  style={{ maxHeight: "calc(90vh - 80px)" }}
                >
                  {sessionOutput || (sessionOutputLoading ? "Loading..." : "No output yet")}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Debug Terminal */}
      <div className="fixed bottom-0 left-0 right-0 z-40" style={{ userSelect: isResizing ? "none" : "auto" }}>
        <div
          onMouseDown={debugOpen ? handleResizeStart : undefined}
          className={`w-full border-t border-white/20 ${debugOpen ? "cursor-ns-resize" : ""}`}
        >
          <button
            onClick={() => setDebugOpen(!debugOpen)}
            className="w-full px-4 py-2 bg-black text-left text-sm font-mono flex items-center justify-between hover:bg-[#111] transition-colors"
          >
            <span className="text-white/60">
              Debug Terminal {debugLogs.length > 0 && <span className="text-white/40">({debugLogs.length} entries)</span>}
            </span>
            <span className="text-white/40">{debugOpen ? "▼" : "▲"}</span>
          </button>
        </div>
        {debugOpen && (
          <div
            ref={debugTerminalRef}
            className="bg-black border-t border-white/10 overflow-y-auto font-mono text-xs"
            style={{ height: terminalHeight }}
          >
            <div className="sticky top-0 bg-black border-b border-white/10 px-4 py-2 flex justify-between items-center">
              <span className="text-white/40">API Request/Response Log</span>
              <div className="flex gap-3">
                <button
                  onClick={copyDebugLogs}
                  className="text-white/40 hover:text-white/60 transition-colors"
                >
                  {debugCopySuccess ? "✓" : "Copy"}
                </button>
                <button
                  onClick={() => setDebugLogs([])}
                  className="text-white/40 hover:text-white/60 transition-colors"
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="p-4 space-y-2">
              {debugLogs.length === 0 ? (
                <p className="text-white/30">No requests logged yet</p>
              ) : (
                debugLogs.map((log) => (
                  <div key={log.id} className="border-b border-white/5 pb-2">
                    <div className="flex items-start gap-2">
                      <span className="text-white/30 shrink-0">
                        {log.timestamp.toLocaleTimeString()}
                      </span>
                      {log.type === "request" && (
                        <span className="text-blue-400">
                          → {log.method} {log.url}
                        </span>
                      )}
                      {log.type === "response" && (
                        <span className={log.status && log.status >= 400 ? "text-red-400" : "text-green-400"}>
                          ← {log.status} {log.url} <span className="text-white/30">({log.duration}ms)</span>
                        </span>
                      )}
                      {log.type === "error" && (
                        <span className="text-red-400">
                          ✕ ERROR: {log.message} <span className="text-white/30">({log.duration}ms)</span>
                        </span>
                      )}
                      {log.type === "info" && (
                        <span className="text-yellow-400">{log.message}</span>
                      )}
                    </div>
                    {log.data !== undefined && (
                      <pre className="mt-1 ml-20 text-white/40 overflow-x-auto max-w-full">
                        {JSON.stringify(log.data, null, 2) as string}
                      </pre>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
