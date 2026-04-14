"use client";

import { debug, type DebugRequestDone } from "@/app/lib/debug";
import {
  buildConnectDevice,
  loadDeviceAuthToken,
  loadOrCreateDeviceIdentity,
  storeDeviceAuthToken,
} from "@/app/jarvis/components/gatewayAuth";

export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: { presence: number; health: number };
};

export type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
};

export class GatewayRequestError extends Error {
  readonly gatewayCode: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "GatewayRequestError";
    this.gatewayCode = code;
    this.details = details;
  }
}

type EventCallback = (payload: unknown) => void;

type WebSocketLike = Pick<WebSocket, "readyState" | "send" | "close"> & {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
};

type PendingRequest = {
  method: string;
  done: DebugRequestDone;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

export type GatewayConnectionOptions = {
  url: string;
  token?: string;
  password?: string;
  requestTimeoutMs?: number;
  websocketFactory?: (url: string) => WebSocketLike;
  clientId?: string;
  clientVersion?: string;
  platform?: string;
  mode?: string;
  onStateChange?: (() => void) | null;
};

const PROTOCOL_VERSION = 3 as const;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const CONNECT_FAILED_CLOSE_CODE = 4008;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const CONNECT_ROLE = "operator";
const CONNECT_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
] as const;
const CONNECT_CLIENT_ID = "openclaw-control-ui";
const CONNECT_CLIENT_MODE = "webchat";
const CONNECT_CAPS = ["tool-events"];
const PAIRING_REQUIRED_CODE = "PAIRING_REQUIRED";
const gatewayLog = debug.scoped("gw");
const gatewayStateSnapshot: Record<string, unknown> = {
  connected: false,
  pairingRequired: false,
  error: null,
  url: "none",
};

debug.registerState("gateway", () => gatewayStateSnapshot);

function normalizeString(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readErrorDetailCode(details: unknown): string | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const code = (details as { code?: unknown }).code;
  return typeof code === "string" && code.trim().length > 0 ? code : null;
}

function isPairingError(error: unknown): boolean {
  if (error instanceof GatewayRequestError) {
    if (readErrorDetailCode(error.details) === PAIRING_REQUIRED_CODE) return true;
    return error.message.toLowerCase().includes("pairing");
  }
  return false;
}

function normalizeGatewayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") parsed.protocol = "wss:";
    if (parsed.protocol === "http:") parsed.protocol = "ws:";
    return parsed.toString();
  } catch {
    return url;
  }
}

export class GatewayConnection {
  connected = false;
  pairingRequired = false;
  error: string | null = null;
  onStateChange: (() => void) | null = null;
  private readonly url: string;
  private readonly token?: string;
  private readonly password?: string;
  private readonly requestTimeoutMs: number;
  private readonly websocketFactory: (url: string) => WebSocketLike;
  private socket: WebSocketLike | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly listeners = new Map<string, Set<EventCallback>>();
  private connectNonce: string | null = null;
  private connectSent = false;
  private manuallyDisconnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectBackoffMs = BASE_BACKOFF_MS;
  private requestCounter = 0;

  constructor(options: GatewayConnectionOptions) {
    this.url = normalizeGatewayUrl(options.url);
    this.token = normalizeString(options.token);
    this.password = normalizeString(options.password);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.websocketFactory =
      options.websocketFactory ??
      ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    this.onStateChange = options.onStateChange ?? null;
  }

  connect() {
    this.manuallyDisconnected = false;
    this.pairingRequired = false;
    this.error = null;
    this.notifyState();
    this.openSocket();
  }

  disconnect() {
    this.manuallyDisconnected = true;
    this.connected = false;
    this.clearReconnectTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close(1000, "manual disconnect");
    }
    gatewayLog.log("Manual disconnect", { url: this.url });
    this.rejectAllPending(new Error("gateway disconnected"));
    this.notifyState();
  }

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("gateway not connected");
    }
    return this.sendRequest(method, params, true);
  }

  subscribe(event: string, cb: EventCallback): () => void {
    const listeners = this.listeners.get(event) ?? new Set<EventCallback>();
    listeners.add(cb);
    this.listeners.set(event, listeners);
    return () => {
      const current = this.listeners.get(event);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) this.listeners.delete(event);
    };
  }

  private notifyState() {
    gatewayStateSnapshot.connected = this.connected;
    gatewayStateSnapshot.pairingRequired = this.pairingRequired;
    gatewayStateSnapshot.error = this.error;
    gatewayStateSnapshot.url = this.url;
    this.onStateChange?.();
  }

  private openSocket() {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      return;
    }
    this.clearReconnectTimer();
    this.connectNonce = null;
    this.connectSent = false;
    gatewayLog.log("WS connecting", { url: this.url });
    const socket = this.websocketFactory(this.url);
    this.socket = socket;
    socket.onopen = () => {
      gatewayLog.log("WS connected", { url: this.url });
    };
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onerror = () => {
      gatewayLog.error("WS error", { url: this.url });
    };
    socket.onclose = (event) => this.handleClose(event);
  }

  private handleClose(event: CloseEvent) {
    const pairingClose =
      event.code === 1008 || event.reason.toLowerCase().includes("pairing");
    this.socket = null;
    this.connected = false;
    if (pairingClose) {
      this.pairingRequired = true;
      this.error = "Pairing required";
      gatewayLog.log("Pairing required -- approve via CLI", {
        code: event.code,
        reason: event.reason || "none",
      });
    } else {
      gatewayLog.log("WS disconnected", {
        code: event.code,
        reason: event.reason || "none",
      });
    }
    this.rejectAllPending(new Error("gateway disconnected"));
    this.notifyState();
    if (!this.manuallyDisconnected && !this.pairingRequired) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    this.clearReconnectTimer();
    const backoffMs = this.reconnectBackoffMs;
    gatewayLog.log("Reconnecting", { backoffMs });
    this.reconnectTimer = setTimeout(() => {
      this.openSocket();
    }, backoffMs);
    this.reconnectBackoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private rejectAllPending(error: Error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeoutId);
      pending.done.error(error.message, { id });
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private nextRequestId() {
    this.requestCounter += 1;
    return `gw-${Date.now()}-${this.requestCounter}`;
  }

  private async buildConnectParams() {
    const client = {
      id: CONNECT_CLIENT_ID,
      version: "tom.quest",
      platform: normalizeString(typeof navigator !== "undefined" ? navigator.platform : undefined) ?? "web",
      mode: CONNECT_CLIENT_MODE,
    };
    let identity: Awaited<ReturnType<typeof loadOrCreateDeviceIdentity>> | null = null;
    if (typeof crypto !== "undefined" && !!crypto.subtle) {
      identity = await loadOrCreateDeviceIdentity();
    }
    const storedToken = identity
      ? loadDeviceAuthToken({ deviceId: identity.deviceId, role: CONNECT_ROLE })?.token
      : undefined;
    const authToken = this.token ?? storedToken;
    const authPassword = this.password;
    const device = identity
      ? await buildConnectDevice({
          identity,
          clientId: client.id,
          clientMode: client.mode,
          role: CONNECT_ROLE,
          scopes: [...CONNECT_SCOPES],
          token: authToken ?? null,
          nonce: this.connectNonce ?? "",
        })
      : undefined;
    return {
      identity,
      role: CONNECT_ROLE,
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client,
        role: CONNECT_ROLE,
        scopes: [...CONNECT_SCOPES],
        device,
        caps: [...CONNECT_CAPS],
        auth:
          authToken || authPassword
            ? {
                token: authToken,
                password: authPassword,
              }
            : undefined,
        userAgent:
          normalizeString(typeof navigator !== "undefined" ? navigator.userAgent : undefined) ?? "tom.quest",
        locale:
          normalizeString(typeof navigator !== "undefined" ? navigator.language : undefined) ?? "en-US",
      },
    };
  }

  private async sendConnect() {
    if (this.connectSent) return;
    this.connectSent = true;
    try {
      const plan = await this.buildConnectParams();
      gatewayLog.log("Connect handshake sent", {
        role: plan.role,
        hasDevice: Boolean(plan.params.device),
        hasAuth: Boolean(plan.params.auth),
      });
      const hello = await this.sendRequest("connect", plan.params, false);
      this.connected = true;
      this.pairingRequired = false;
      this.error = null;
      this.reconnectBackoffMs = BASE_BACKOFF_MS;
      const typedHello = hello as {
        auth?: { deviceToken?: string; role?: string; scopes?: string[] };
      };
      if (typedHello?.auth?.deviceToken && plan.identity) {
        storeDeviceAuthToken({
          deviceId: plan.identity.deviceId,
          role: typedHello.auth.role ?? plan.role,
          token: typedHello.auth.deviceToken,
          scopes: typedHello.auth.scopes ?? [],
        });
      }
      gatewayLog.log("Handshake accepted", {
        hasDeviceToken: Boolean(typedHello?.auth?.deviceToken),
      });
      this.notifyState();
    } catch (error) {
      this.connected = false;
      this.error = error instanceof Error ? error.message : "Connect failed";
      this.pairingRequired = isPairingError(error);
      gatewayLog.error("Connect handshake failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.notifyState();
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.close(CONNECT_FAILED_CLOSE_CODE, "connect failed");
      }
    }
  }

  private async sendRequest(
    method: string,
    params: Record<string, unknown> | undefined,
    requireConnected: boolean,
  ): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("gateway not connected");
    }
    if (requireConnected && !this.connected) {
      throw new Error("gateway not connected");
    }
    const id = this.nextRequestId();
    const frame = { type: "req" as const, id, method, params };
    const done = gatewayLog.req(method, { id });
    return new Promise<unknown>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`${method} timed out after ${this.requestTimeoutMs}ms`);
        done.error("timed out", { id, timeoutMs: this.requestTimeoutMs });
        reject(error);
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        method,
        done,
        resolve,
        reject,
        timeoutId,
      });
      this.socket?.send(JSON.stringify(frame));
    });
  }

  private handleMessage(raw: string) {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = frame as { type?: string };
    if (parsed.type === "event") {
      const eventFrame = frame as GatewayEventFrame;
      if (eventFrame.event === "connect.challenge") {
        const payload = eventFrame.payload as { nonce?: unknown } | undefined;
        this.connectNonce = typeof payload?.nonce === "string" ? payload.nonce : null;
        gatewayLog.log("Challenge received", { nonce: this.connectNonce });
        void this.sendConnect();
        return;
      }
      gatewayLog.log(`event: ${eventFrame.event}`, {
        hasPayload: eventFrame.payload !== undefined,
      });
      const listeners = this.listeners.get(eventFrame.event);
      listeners?.forEach((listener) => listener(eventFrame.payload));
      return;
    }
    if (parsed.type === "res") {
      const response = frame as GatewayResponseFrame;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timeoutId);
      if (response.ok) {
        pending.done({ id: response.id });
        pending.resolve(response.payload);
      } else {
        const error = new GatewayRequestError(
          response.error?.code ?? "UNAVAILABLE",
          response.error?.message ?? "request failed",
          response.error?.details,
        );
        pending.done.error(error.message, {
          id: response.id,
          code: error.gatewayCode,
        });
        pending.reject(error);
      }
    }
  }
}
