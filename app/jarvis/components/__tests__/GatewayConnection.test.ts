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
