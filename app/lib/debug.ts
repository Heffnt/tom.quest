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

function serializeDebugData(data: unknown, seen = new WeakSet<object>()): unknown {
  if (data instanceof Error) {
    if (seen.has(data)) return "[Circular]";
    seen.add(data);
    const base: Record<string, unknown> = {
      name: data.name,
      message: data.message,
      stack: data.stack,
    };
    if ("cause" in data && data.cause !== undefined) {
      base.cause = serializeDebugData(data.cause, seen);
    }
    if (data instanceof AggregateError) {
      base.errors = Array.from(data.errors, (item) => serializeDebugData(item, seen));
    }
    seen.delete(data);
    return base;
  }
  if (!data || typeof data !== "object") return data;
  if (seen.has(data)) return "[Circular]";
  seen.add(data);
  if (Array.isArray(data)) {
    const output = data.map((item) => serializeDebugData(item, seen));
    seen.delete(data);
    return output;
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    output[key] = serializeDebugData(value, seen);
  }
  seen.delete(data);
  return output;
}

export function logDebug(type: DebugLogType, message: string, data?: unknown, source?: string) {
  if (typeof window === "undefined") return;
  const serializedData = serializeDebugData(data);
  const entry: DebugLogEntry = {
    id: nextId++,
    timestamp: new Date(),
    type,
    message,
    data: serializedData,
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
    const serializedError = serializeDebugData(e);
    const errorMessage =
      e instanceof Error
        ? e.message
        : typeof e === "string"
          ? e
          : "Unknown error";
    const errEntry: DebugLogEntry = {
      id: nextId++,
      timestamp: new Date(),
      type: "error",
      message: `✕ ${method} ${url}: ${errorMessage}`,
      source,
      method,
      url,
      duration,
      data: serializedError,
    };
    window.dispatchEvent(new CustomEvent("tomquest-debug", { detail: errEntry }));
    throw e;
  }
}
