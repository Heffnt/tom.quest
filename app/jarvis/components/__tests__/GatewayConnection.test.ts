import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadOrCreateDeviceIdentity = vi.fn();
const buildConnectDevice = vi.fn();
const loadDeviceAuthToken = vi.fn();
const storeDeviceAuthToken = vi.fn();
const clearDeviceAuthToken = vi.fn();

vi.mock("@/app/jarvis/components/gatewayAuth", () => ({
  loadOrCreateDeviceIdentity,
  buildConnectDevice,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
  clearDeviceAuthToken,
}));

type SentFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = MockWebSocket.OPEN;
  sentFrames: SentFrame[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sentFrames.push(JSON.parse(data) as SentFrame);
  }

  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }

  serverOpen() {
    this.onopen?.(new Event("open"));
  }

  serverMessage(frame: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  serverClose(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
}

async function flushAsync() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("GatewayConnection", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    const { debug } = await import("@/app/lib/debug");
    debug.clear();
    loadOrCreateDeviceIdentity.mockResolvedValue({
      deviceId: "device-1",
      publicKey: "public-key",
      privateKey: "private-key",
    });
    buildConnectDevice.mockResolvedValue({
      id: "device-1",
      publicKey: "public-key",
      signature: "signature",
      signedAt: 123,
      nonce: "nonce-123",
    });
    loadDeviceAuthToken.mockReturnValue({
      token: "stored-device-token",
      role: "operator",
      scopes: ["operator.read"],
      updatedAtMs: 1,
    });
    storeDeviceAuthToken.mockReturnValue(undefined);
    clearDeviceAuthToken.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("performs the connect challenge handshake and stores the issued device token", async () => {
    const { GatewayConnection } = await import("@/app/jarvis/components/GatewayConnection");
    const connection = new GatewayConnection({
      url: "wss://gateway.example/ws",
      websocketFactory: (url: string) => new MockWebSocket(url) as unknown as WebSocket,
    });

    connection.connect();
    const socket = MockWebSocket.instances[0];
    socket.serverOpen();
    socket.serverMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-123", ts: 1 },
    });
    await flushAsync();

    expect(socket.sentFrames).toHaveLength(1);
    expect(socket.sentFrames[0]?.method).toBe("connect");
    expect(socket.sentFrames[0]?.params).toMatchObject({
      minProtocol: 3,
      maxProtocol: 3,
      role: "operator",
      scopes: expect.arrayContaining(["operator.admin", "operator.read", "operator.write"]),
      auth: { token: "stored-device-token" },
      device: {
        id: "device-1",
        publicKey: "public-key",
        signature: "signature",
        signedAt: 123,
        nonce: "nonce-123",
      },
    });

    socket.serverMessage({
      type: "res",
      id: socket.sentFrames[0]?.id,
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 3,
        auth: {
          deviceToken: "new-device-token",
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write"],
        },
      },
    });
    await flushAsync();

    expect(connection.connected).toBe(true);
    expect(connection.pairingRequired).toBe(false);
    expect(storeDeviceAuthToken).toHaveBeenCalledWith({
      deviceId: "device-1",
      role: "operator",
      token: "new-device-token",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
  });

  it("uses the provided shared device identity instead of generating a browser-local one", async () => {
    const { GatewayConnection } = await import("@/app/jarvis/components/GatewayConnection");
    buildConnectDevice.mockImplementation(async ({ identity, nonce }) => ({
      id: identity.deviceId,
      publicKey: identity.publicKey,
      signature: `signature:${identity.deviceId}`,
      signedAt: 123,
      nonce,
    }));
    const connection = new GatewayConnection({
      url: "wss://gateway.example/ws",
      deviceIdentity: {
        deviceId: "shared-device",
        publicKey: "shared-public-key",
        privateKey: "shared-private-key",
      },
      websocketFactory: (url: string) => new MockWebSocket(url) as unknown as WebSocket,
    });

    connection.connect();
    const socket = MockWebSocket.instances[0];
    socket.serverOpen();
    socket.serverMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-456", ts: 1 },
    });
    await flushAsync();

    expect(loadOrCreateDeviceIdentity).not.toHaveBeenCalled();
    expect(loadDeviceAuthToken).toHaveBeenCalledWith({
      deviceId: "shared-device",
      role: "operator",
    });
    expect(socket.sentFrames[0]?.params).toMatchObject({
      device: {
        id: "shared-device",
        publicKey: "shared-public-key",
        signature: "signature:shared-device",
        nonce: "nonce-456",
      },
    });
  });

  // "A stored device token the gateway refuses" — the one case that drops the
  // token, and the four neighbouring refusals that must not. Before these,
  // clearDeviceAuthToken had no production caller at all: a rejected token
  // stayed in localStorage, buildConnectParams re-read it on every reconnect,
  // and the only way out was clearing site data by hand. The narrowness
  // matters as much as the drop: this deletion cannot be undone from a
  // browser, so a refusal that does not name the credential leaves it alone.
  async function refuseHandshake(
    error: { code: string; message: string; details?: unknown },
    options: { password?: string } = {},
  ) {
    const { GatewayConnection } = await import("@/app/jarvis/components/GatewayConnection");
    const connection = new GatewayConnection({
      url: "wss://gateway.example/ws",
      ...options,
      websocketFactory: (url: string) => new MockWebSocket(url) as unknown as WebSocket,
    });
    connection.connect();
    const socket = MockWebSocket.instances[0];
    socket.serverOpen();
    socket.serverMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-123", ts: 1 },
    });
    await flushAsync();
    socket.serverMessage({
      type: "res",
      id: socket.sentFrames[0]?.id,
      ok: false,
      error,
    });
    await flushAsync();
    return { connection, socket };
  }

  it("drops a stored device token the gateway refuses, so the next handshake re-registers", async () => {
    const { connection } = await refuseHandshake({
      code: "UNAUTHORIZED",
      message: "device token rejected",
      details: { code: "AUTH_REQUIRED" },
    });

    expect(connection.connected).toBe(false);
    expect(clearDeviceAuthToken).toHaveBeenCalledWith({
      deviceId: "device-1",
      role: "operator",
    });

    // The store is now empty, so the retry handshakes with no token at all —
    // which is the request the gateway answers by issuing a fresh one.
    loadDeviceAuthToken.mockReturnValue(null);
    await vi.advanceTimersByTimeAsync(1000);
    const retry = MockWebSocket.instances[1];
    retry.serverOpen();
    retry.serverMessage({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-456", ts: 2 },
    });
    await flushAsync();
    expect((retry.sentFrames[0]?.params as { auth?: unknown }).auth).toBeUndefined();
  });

  it("keeps the stored token when the refusal is a pairing refusal", async () => {
    // PAIRING_REQUIRED says a human has not approved this device; deleting the
    // token would not change that and would lose a token that still works once
    // pairing lands.
    const { connection } = await refuseHandshake({
      code: "PAIRING_REQUIRED",
      message: "pairing required",
      details: { code: "PAIRING_REQUIRED" },
    });

    expect(connection.pairingRequired).toBe(true);
    expect(clearDeviceAuthToken).not.toHaveBeenCalled();
  });

  it("keeps the stored token when UNAUTHORIZED does not name the credential", async () => {
    // The connect frame stakes the token, the device signature and the
    // requested scopes at once. A bare UNAUTHORIZED could be about any of
    // them — a skewed signedAt, a scope the gateway will not grant — and
    // deleting a good token on that evidence cannot be undone from a browser.
    const { connection } = await refuseHandshake({
      code: "UNAUTHORIZED",
      message: "signature rejected",
    });

    expect(connection.connected).toBe(false);
    expect(clearDeviceAuthToken).not.toHaveBeenCalled();
  });

  it("keeps the stored token when a password rides along with it", async () => {
    // Two credentials in one frame, so the refusal does not say which one
    // failed.
    await refuseHandshake(
      {
        code: "UNAUTHORIZED",
        message: "device token rejected",
        details: { code: "AUTH_REQUIRED" },
      },
      { password: "hunter2" },
    );

    expect(clearDeviceAuthToken).not.toHaveBeenCalled();
  });

  it("drops the token when the refusal mentions pairing but names AUTH_REQUIRED", async () => {
    // The message-substring pairing test would otherwise swallow this: the
    // detail code is what says which credential was refused.
    await refuseHandshake({
      code: "UNAUTHORIZED",
      message: "device token invalid; re-pairing may be required",
      details: { code: "AUTH_REQUIRED" },
    });

    expect(clearDeviceAuthToken).toHaveBeenCalledWith({
      deviceId: "device-1",
      role: "operator",
    });
  });

  it("keeps the stored token when the handshake fails for a non-auth reason", async () => {
    const { connection } = await refuseHandshake({
      code: "UNAVAILABLE",
      message: "gateway restarting",
    });

    expect(connection.connected).toBe(false);
    expect(clearDeviceAuthToken).not.toHaveBeenCalled();
  });

  it("correlates outbound requests with matching responses", async () => {
    const { GatewayConnection } = await import("@/app/jarvis/components/GatewayConnection");
    const connection = new GatewayConnection({
      url: "wss://gateway.example/ws",
      websocketFactory: (url: string) => new MockWebSocket(url) as unknown as WebSocket,
    });

    connection.connect();
    const socket = MockWebSocket.instances[0];
    socket.serverOpen();
    socket.serverMessage({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-123" } });
    await flushAsync();
    socket.serverMessage({ type: "res", id: socket.sentFrames[0]?.id, ok: true, payload: { type: "hello-ok", protocol: 3 } });
    await flushAsync();

    const promise = connection.call("health", { probe: true });
    const request = socket.sentFrames[1];
    expect(request?.method).toBe("health");
    expect(request?.params).toEqual({ probe: true });

    socket.serverMessage({
      type: "res",
      id: request?.id,
      ok: true,
      payload: { ok: true, ts: 1 },
    });

    await expect(promise).resolves.toEqual({ ok: true, ts: 1 });
  });

  it("rejects a request when the gateway returns an error response", async () => {
    const { GatewayConnection, GatewayRequestError } = await import("@/app/jarvis/components/GatewayConnection");
    const connection = new GatewayConnection({
      url: "wss://gateway.example/ws",
      websocketFactory: (url: string) => new MockWebSocket(url) as unknown as WebSocket,
    });

    connection.connect();
    const socket = MockWebSocket.instances[0];
    socket.serverOpen();
    socket.serverMessage({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-123" } });
    await flushAsync();
    socket.serverMessage({ type: "res", id: socket.sentFrames[0]?.id, ok: true, payload: { type: "hello-ok", protocol: 3 } });
    await flushAsync();

    const promise = connection.call("cron.list");
    const request = socket.sentFrames[1];
    socket.serverMessage({
      type: "res",
      id: request?.id,
      ok: false,
      error: { code: "UNAUTHORIZED", message: "nope", details: { code: "AUTH_REQUIRED" } },
    });

    await expect(promise).rejects.toBeInstanceOf(GatewayRequestError);
    await expect(promise).rejects.toMatchObject({ message: "nope", gatewayCode: "UNAUTHORIZED" });
  });

  it("times out unresolved requests", async () => {
    const { GatewayConnection } = await import("@/app/jarvis/components/GatewayConnection");
    const connection = new GatewayConnection({
      url: "wss://gateway.example/ws",
      requestTimeoutMs: 200,
      websocketFactory: (url: string) => new MockWebSocket(url) as unknown as WebSocket,
    });

    connection.connect();
    const socket = MockWebSocket.instances[0];
    socket.serverOpen();
    socket.serverMessage({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-123" } });
    await flushAsync();
    socket.serverMessage({ type: "res", id: socket.sentFrames[0]?.id, ok: true, payload: { type: "hello-ok", protocol: 3 } });
    await flushAsync();

    const promise = connection.call("health");
    const expectation = expect(promise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(250);

    await expectation;
  });

  it("routes subscribed events and supports unsubscribe", async () => {
    const { GatewayConnection } = await import("@/app/jarvis/components/GatewayConnection");
    const connection = new GatewayConnection({
      url: "wss://gateway.example/ws",
      websocketFactory: (url: string) => new MockWebSocket(url) as unknown as WebSocket,
    });
    const callback = vi.fn();

    connection.connect();
    const socket = MockWebSocket.instances[0];
    socket.serverOpen();
    socket.serverMessage({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-123" } });
    await flushAsync();
    socket.serverMessage({ type: "res", id: socket.sentFrames[0]?.id, ok: true, payload: { type: "hello-ok", protocol: 3 } });
    await flushAsync();

    const unsubscribe = connection.subscribe("health", callback);
    socket.serverMessage({ type: "event", event: "health", payload: { ok: true } });
    unsubscribe();
    socket.serverMessage({ type: "event", event: "health", payload: { ok: false } });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ ok: true });
  });

  it("marks pairing required and does not reconnect on a pairing close", async () => {
    const { GatewayConnection } = await import("@/app/jarvis/components/GatewayConnection");
    const connection = new GatewayConnection({
      url: "wss://gateway.example/ws",
      websocketFactory: (url: string) => new MockWebSocket(url) as unknown as WebSocket,
    });

    connection.connect();
    const socket = MockWebSocket.instances[0];
    socket.serverOpen();
    socket.serverClose(1008, "pairing required");
    await flushAsync();
    await vi.advanceTimersByTimeAsync(1500);

    expect(connection.pairingRequired).toBe(true);
    expect(connection.connected).toBe(false);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("reconnects with backoff after an unexpected disconnect", async () => {
    const { GatewayConnection } = await import("@/app/jarvis/components/GatewayConnection");
    const connection = new GatewayConnection({
      url: "wss://gateway.example/ws",
      websocketFactory: (url: string) => new MockWebSocket(url) as unknown as WebSocket,
    });

    connection.connect();
    const firstSocket = MockWebSocket.instances[0];
    firstSocket.serverOpen();
    firstSocket.serverClose(1006, "network");

    await vi.advanceTimersByTimeAsync(1100);

    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("does not reconnect after a manual disconnect", async () => {
    const { GatewayConnection } = await import("@/app/jarvis/components/GatewayConnection");
    const connection = new GatewayConnection({
      url: "wss://gateway.example/ws",
      websocketFactory: (url: string) => new MockWebSocket(url) as unknown as WebSocket,
    });

    connection.connect();
    const firstSocket = MockWebSocket.instances[0];
    firstSocket.serverOpen();

    connection.disconnect();
    await vi.advanceTimersByTimeAsync(2000);

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("emits debug logs for lifecycle, requests, responses, and events", async () => {
    const { GatewayConnection } = await import("@/app/jarvis/components/GatewayConnection");
    const { debug } = await import("@/app/lib/debug");
    const connection = new GatewayConnection({
      url: "wss://gateway.example/ws",
      websocketFactory: (url: string) => new MockWebSocket(url) as unknown as WebSocket,
    });

    connection.connect();
    const socket = MockWebSocket.instances[0];
    socket.serverOpen();
    socket.serverMessage({ type: "event", event: "connect.challenge", payload: { nonce: "nonce-123" } });
    await flushAsync();
    socket.serverMessage({ type: "res", id: socket.sentFrames[0]?.id, ok: true, payload: { type: "hello-ok", protocol: 3 } });
    await flushAsync();

    const call = connection.call("health");
    const request = socket.sentFrames[1];
    socket.serverMessage({ type: "res", id: request?.id, ok: true, payload: { ok: true } });
    socket.serverMessage({ type: "event", event: "health", payload: { ok: true } });
    await call;

    const lines = debug.getLines().join("\n");
    expect(lines).toContain("[gw] WS connecting");
    expect(lines).toContain("[gw] Challenge received");
    expect(lines).toContain("[gw] -> health");
    expect(lines).toContain("[gw] <- health");
    expect(lines).toContain("[gw] event: health");
  });
});
