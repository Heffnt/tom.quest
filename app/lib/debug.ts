type DebugFields = Record<string, unknown>;
type DebugStateProvider = () => DebugFields;

export type ConsoleDiagnosticEvent = {
  level: "error" | "warn";
  message: string;
  timestamp: number;
};

export type DebugRequestOptions = {
  dedupeSuccessForMs?: number;
  defer?: boolean;
};

export type DebugRequestDone = ((summary?: DebugFields) => void) & {
  error: (message: string, data?: DebugFields) => void;
};

export type DebugLogger = {
  log: (message: string, data?: DebugFields) => void;
  error: (message: string, data?: DebugFields) => void;
  req: (method: string, data?: DebugFields, options?: DebugRequestOptions) => DebugRequestDone;
};

const MAX_LINES = 200;
const MAX_CONSOLE_EVENTS = 10;
const MAX_INLINE_VALUE_CHARS = 100;
const MAX_PREVIEW_DEPTH = 2;

let lines: string[] = [];
let consoleEvents: ConsoleDiagnosticEvent[] = [];
let version = 0;
let consoleCaptureInstalled = false;

const subscribers = new Set<() => void>();
const stateProviders = new Map<string, DebugStateProvider>();
const successDedupeCache = new Map<string, { signature: string; loggedAt: number }>();

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function formatTimestamp(date = new Date()): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function redactionLabelForKey(key: string): string | null {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (normalized.includes("turing") && normalized.includes("key")) return "turing-api-key";
  if (normalized.includes("apikey")) return "api-key";
  if (normalized.includes("privatekey")) return "private-key";
  if (normalized.includes("password")) return "password";
  if (normalized.includes("signature")) return "signature";
  if (normalized.includes("token")) return "token";
  if (normalized.includes("secret")) return "secret";
  return null;
}

function sanitizePreview(value: unknown, keyHint?: string, depth = 0, seen = new WeakSet<object>()): unknown {
  const redactionLabel = keyHint ? redactionLabelForKey(keyHint) : null;
  if (redactionLabel) return `[redacted: ${redactionLabel}]`;
  if (value instanceof Error) return value.message;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value;
  if (typeof value === "function") return "[Function]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_PREVIEW_DEPTH) {
    return Array.isArray(value) ? `[Array(${value.length})]` : "[Object]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const next = value.map((item) => sanitizePreview(item, undefined, depth + 1, seen));
    seen.delete(value);
    return next;
  }
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    next[key] = sanitizePreview(entry, key, depth + 1, seen);
  }
  seen.delete(value);
  return next;
}

function truncateText(value: string, maxChars = MAX_INLINE_VALUE_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function formatInlineValue(value: unknown, keyHint?: string): string {
  const sanitized = sanitizePreview(value, keyHint);
  if (sanitized === null) return "null";
  if (sanitized === undefined) return "";
  if (typeof sanitized === "string") {
    const clipped = truncateText(sanitized);
    return /\s/.test(clipped) || clipped === "" ? JSON.stringify(clipped) : clipped;
  }
  if (typeof sanitized === "number" || typeof sanitized === "boolean" || typeof sanitized === "bigint") {
    return String(sanitized);
  }
  const json = JSON.stringify(sanitized);
  return truncateText(json ?? String(sanitized));
}

function formatFields(data?: DebugFields): string {
  if (!data) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const formatted = formatInlineValue(value, key);
    if (!formatted) continue;
    parts.push(`${key}=${formatted}`);
  }
  return parts.join(" ");
}

function buildLine(source: string, message: string, data?: DebugFields): string {
  const fields = formatFields(data);
  return `${formatTimestamp()} [${source}] ${message}${fields ? ` ${fields}` : ""}`;
}

function emit() {
  version += 1;
  subscribers.forEach((subscriber) => subscriber());
}

function pushLine(line: string) {
  lines = [...lines, line].slice(-MAX_LINES);
  emit();
}

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(sanitizePreview(arg));
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

function captureConsoleEvent(level: ConsoleDiagnosticEvent["level"], args: unknown[]) {
  const message = formatConsoleArgs(args);
  const event = { level, message, timestamp: Date.now() };
  consoleEvents = [...consoleEvents, event].slice(-MAX_CONSOLE_EVENTS);
  pushLine(buildLine("console", level, { message }));
}

function clearSuccessCacheFor(source: string, method: string) {
  successDedupeCache.delete(`${source}|${method}`);
}

function shouldSuppressSuccess(
  source: string,
  method: string,
  summary: DebugFields | undefined,
  dedupeSuccessForMs: number | undefined,
): boolean {
  if (!dedupeSuccessForMs || dedupeSuccessForMs <= 0) return false;
  const now = Date.now();
  const key = `${source}|${method}`;
  const signature = formatFields(summary);
  const previous = successDedupeCache.get(key);
  if (previous && previous.signature === signature && now - previous.loggedAt < dedupeSuccessForMs) {
    return true;
  }
  successDedupeCache.set(key, { signature, loggedAt: now });
  return false;
}

function createRequestDone(
  source: string,
  method: string,
  data?: DebugFields,
  options?: DebugRequestOptions,
): DebugRequestDone {
  const startedAt = Date.now();
  const requestLine = buildLine(source, `-> ${method}`, data);
  let requestLogged = false;

  const ensureRequestLine = () => {
    if (requestLogged) return;
    pushLine(requestLine);
    requestLogged = true;
  };

  if (!options?.defer) ensureRequestLine();

  const done = ((summary?: DebugFields) => {
    const durationMs = Date.now() - startedAt;
    if (shouldSuppressSuccess(source, method, summary, options?.dedupeSuccessForMs)) {
      return;
    }
    ensureRequestLine();
    pushLine(buildLine(source, `<- ${method} ${durationMs}ms`, summary));
  }) as DebugRequestDone;

  done.error = (message: string, errorData?: DebugFields) => {
    const durationMs = Date.now() - startedAt;
    clearSuccessCacheFor(source, method);
    ensureRequestLine();
    pushLine(buildLine(source, `ERROR ${method} ${message} (${durationMs}ms)`, errorData));
  };

  return done;
}

function scoped(source: string): DebugLogger {
  return {
    log(message: string, data?: DebugFields) {
      pushLine(buildLine(source, message, data));
    },
    error(message: string, data?: DebugFields) {
      pushLine(buildLine(source, `ERROR ${message}`, data));
    },
    req(method: string, data?: DebugFields, options?: DebugRequestOptions) {
      return createRequestDone(source, method, data, options);
    },
  };
}

export function registerState(key: string, provider: DebugStateProvider) {
  stateProviders.set(key, provider);
}

export function unregisterState(key: string) {
  stateProviders.delete(key);
}

export function snapshot(): string {
  const header = [`tom.quest debug -- ${new Date().toISOString()}`];
  if (typeof window !== "undefined") {
    header.push(`route: ${window.location.pathname}${window.location.search}`);
  }
  for (const [key, provider] of stateProviders.entries()) {
    try {
      const rendered = formatFields(provider());
      header.push(rendered ? `${key}: ${rendered}` : `${key}: none`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      header.push(`${key}: ERROR ${message}`);
    }
  }
  if (consoleEvents.length > 0) {
    header.push(
      "console:",
      ...consoleEvents.slice(-5).map((event) => `  ${event.level}: ${event.message}`),
    );
  }
  if (lines.length === 0) {
    header.push("", "No debug output yet.");
    return header.join("\n");
  }
  return [...header, "", ...lines].join("\n");
}

export function clear() {
  lines = [];
  consoleEvents = [];
  successDedupeCache.clear();
  emit();
}

export function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function getVersion(): number {
  return version;
}

export function getLines(): readonly string[] {
  return lines;
}

export function getConsoleEvents(): readonly ConsoleDiagnosticEvent[] {
  return consoleEvents;
}

export function installConsoleCapture() {
  if (consoleCaptureInstalled || typeof window === "undefined") return;
  consoleCaptureInstalled = true;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => {
    captureConsoleEvent("error", args);
    originalError(...args);
  };
  console.warn = (...args: unknown[]) => {
    captureConsoleEvent("warn", args);
    originalWarn(...args);
  };
}

export const debug = {
  scoped,
  registerState,
  unregisterState,
  snapshot,
  clear,
  subscribe,
  getVersion,
  getLines,
  getConsoleEvents,
  installConsoleCapture,
};
