export type DebugLogType = "request" | "response" | "error" | "info" | "action" | "lifecycle";

export interface DebugLogEntry {
  id: number;
  timestamp: Date;
  type: DebugLogType;
  message: string;
  source?: string;
  method?: string;
  url?: string;
  status?: number;
  duration?: number;
  data?: unknown;
}

export type DebugFetchLogOptions = {
  logRequestBody?: boolean;
  logResponseBody?: boolean;
  source?: string;
};

let nextId = 0;

export function logDebug(type: DebugLogType, message: string, data?: unknown, source?: string) {
  if (typeof window === "undefined") return;
  const entry: DebugLogEntry = {
    id: nextId++,
    timestamp: new Date(),
    type,
    message,
    data,
    source,
  };
  window.dispatchEvent(new CustomEvent("tomquest-debug", { detail: entry }));
}

export async function debugFetch(
  url: string,
  options?: RequestInit,
  logOptions?: DebugFetchLogOptions
): Promise<Response> {
  if (typeof window === "undefined") return fetch(url, options);
  const method = options?.method || "GET";
  const startTime = Date.now();
  const source = logOptions?.source ?? "fetch";
  const shouldLogRequestBody = logOptions?.logRequestBody !== false;
  const shouldLogResponseBody = logOptions?.logResponseBody !== false;
  let bodyData: unknown;
  try {
    if (shouldLogRequestBody && options?.body && typeof options.body === "string") {
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
    source,
    method,
    url,
    data: bodyData,
  };
  window.dispatchEvent(new CustomEvent("tomquest-debug", { detail: reqEntry }));
  try {
    const res = await fetch(url, options);
    const duration = Date.now() - startTime;
    const resData = shouldLogResponseBody
      ? await res.clone().json().catch(() => null)
      : undefined;
    const resEntry: DebugLogEntry = {
      id: nextId++,
      timestamp: new Date(),
      type: "response",
      message: `← ${res.status} ${url}`,
      source,
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
      source,
      method,
      url,
      duration,
    };
    window.dispatchEvent(new CustomEvent("tomquest-debug", { detail: errEntry }));
    throw e;
  }
}
