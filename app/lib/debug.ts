export type DebugLogType = "request" | "response" | "error" | "info";

export interface DebugLogEntry {
  id: number;
  timestamp: Date;
  type: DebugLogType;
  message: string;
  method?: string;
  url?: string;
  status?: number;
  duration?: number;
  data?: unknown;
}

let nextId = 0;

export function logDebug(type: DebugLogType, message: string, data?: unknown) {
  if (typeof window === "undefined") return;
  const entry: DebugLogEntry = {
    id: nextId++,
    timestamp: new Date(),
    type,
    message,
    data,
  };
  window.dispatchEvent(new CustomEvent("tomquest-debug", { detail: entry }));
}

export async function debugFetch(url: string, options?: RequestInit): Promise<Response> {
  if (typeof window === "undefined") return fetch(url, options);
  const method = options?.method || "GET";
  const startTime = Date.now();
  let bodyData: unknown;
  try {
    if (options?.body && typeof options.body === "string") {
      bodyData = JSON.parse(options.body);
    }
  } catch {
    // body isn't JSON, skip
  }
  const reqEntry: DebugLogEntry = {
    id: nextId++,
    timestamp: new Date(),
    type: "request",
    message: `→ ${method} ${url}`,
    method,
    url,
    data: bodyData,
  };
  window.dispatchEvent(new CustomEvent("tomquest-debug", { detail: reqEntry }));
  try {
    const res = await fetch(url, options);
    const duration = Date.now() - startTime;
    const resData = await res.clone().json().catch(() => null);
    const resEntry: DebugLogEntry = {
      id: nextId++,
      timestamp: new Date(),
      type: "response",
      message: `← ${res.status} ${url}`,
      method,
      url,
      status: res.status,
      duration,
      data: resData,
    };
    window.dispatchEvent(new CustomEvent("tomquest-debug", { detail: resEntry }));
    return res;
  } catch (e) {
    const duration = Date.now() - startTime;
    const errEntry: DebugLogEntry = {
      id: nextId++,
      timestamp: new Date(),
      type: "error",
      message: `✕ ${method} ${url}: ${e instanceof Error ? e.message : "Unknown error"}`,
      method,
      url,
      duration,
    };
    window.dispatchEvent(new CustomEvent("tomquest-debug", { detail: errEntry }));
    throw e;
  }
}
