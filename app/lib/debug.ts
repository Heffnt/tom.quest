export type DebugLogType = "request" | "response" | "error" | "info";

export interface DebugLogEntry {
  id: number;
  timestamp: Date;
  type: DebugLogType;
  message: string;
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
