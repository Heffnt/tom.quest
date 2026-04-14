import { beforeEach, describe, expect, it } from "vitest";

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const output = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    output[i] = binary.charCodeAt(i);
  }
  return output;
}

describe("gatewayAuth", () => {
  beforeEach(async () => {
    localStorage.clear();
    const { debug } = await import("@/app/lib/debug");
    debug.clear();
  });

  it("creates and persists a stable device identity", async () => {
    const { loadOrCreateDeviceIdentity } = await import("@/app/jarvis/components/gatewayAuth");
    const first = await loadOrCreateDeviceIdentity();
    const second = await loadOrCreateDeviceIdentity();

    expect(first.deviceId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.privateKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(second).toEqual(first);
  });

  it("repairs a stored identity when the public key fingerprint changed", async () => {
    localStorage.setItem("openclaw-device-identity-v1", JSON.stringify({
      version: 1,
      deviceId: "deadbeef",
      publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      privateKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      createdAtMs: 1,
    }));
    const { loadOrCreateDeviceIdentity } = await import("@/app/jarvis/components/gatewayAuth");
    const identity = await loadOrCreateDeviceIdentity();

    expect(identity.deviceId).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.deviceId).not.toBe("deadbeef");
  });

  it("builds a signed connect device using the OpenClaw browser v2 payload", async () => {
    const { buildConnectDevice, loadOrCreateDeviceIdentity } = await import("@/app/jarvis/components/gatewayAuth");
    const identity = await loadOrCreateDeviceIdentity();
    const connectDevice = await buildConnectDevice({
      identity,
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      token: "shared-token",
      nonce: "nonce-123",
    });

    const payload = [
      "v2",
      identity.deviceId,
      "openclaw-control-ui",
      "webchat",
      "operator",
      "operator.admin,operator.read,operator.write",
      String(connectDevice.signedAt),
      "shared-token",
      "nonce-123",
    ].join("|");

    const publicKey = await crypto.subtle.importKey(
      "raw",
      base64UrlDecode(connectDevice.publicKey),
      { name: "Ed25519" },
      true,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      base64UrlDecode(connectDevice.signature),
      new TextEncoder().encode(payload),
    );

    expect(connectDevice.id).toBe(identity.deviceId);
    expect(connectDevice.nonce).toBe("nonce-123");
    expect(verified).toBe(true);
  });

  it("stores, normalizes, and reloads a device auth token", async () => {
    const {
      loadDeviceAuthToken,
      storeDeviceAuthToken,
      loadOrCreateDeviceIdentity,
    } = await import("@/app/jarvis/components/gatewayAuth");
    const identity = await loadOrCreateDeviceIdentity();
    const stored = storeDeviceAuthToken({
      deviceId: identity.deviceId,
      role: "operator",
      token: "device-token",
      scopes: ["operator.write", "operator.read", "operator.write"],
    });
    const loaded = loadDeviceAuthToken({
      deviceId: identity.deviceId,
      role: "operator",
    });

    expect(stored.scopes).toEqual(["operator.read", "operator.write"]);
    expect(loaded).toEqual(stored);
  });

  it("returns null when no matching auth token exists", async () => {
    const { loadDeviceAuthToken, loadOrCreateDeviceIdentity } = await import("@/app/jarvis/components/gatewayAuth");
    const identity = await loadOrCreateDeviceIdentity();

    expect(loadDeviceAuthToken({ deviceId: identity.deviceId, role: "operator" })).toBeNull();
    expect(loadDeviceAuthToken({ deviceId: "someone-else", role: "operator" })).toBeNull();
  });

  it("clears only the matching device auth token", async () => {
    const {
      clearDeviceAuthToken,
      loadDeviceAuthToken,
      loadOrCreateDeviceIdentity,
      storeDeviceAuthToken,
    } = await import("@/app/jarvis/components/gatewayAuth");
    const identity = await loadOrCreateDeviceIdentity();
    storeDeviceAuthToken({
      deviceId: identity.deviceId,
      role: "operator",
      token: "device-token",
      scopes: ["operator.read"],
    });

    clearDeviceAuthToken({ deviceId: identity.deviceId, role: "operator" });

    expect(loadDeviceAuthToken({ deviceId: identity.deviceId, role: "operator" })).toBeNull();
  });

  it("emits Gateway debug logs for identity, signing, and token operations", async () => {
    const {
      buildConnectDevice,
      clearDeviceAuthToken,
      loadOrCreateDeviceIdentity,
      storeDeviceAuthToken,
    } = await import("@/app/jarvis/components/gatewayAuth");
    const { debug } = await import("@/app/lib/debug");
    const identity = await loadOrCreateDeviceIdentity();

    await buildConnectDevice({
      identity,
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
      role: "operator",
      scopes: ["operator.read"],
      nonce: "nonce-456",
    });
    storeDeviceAuthToken({
      deviceId: identity.deviceId,
      role: "operator",
      token: "device-token",
      scopes: ["operator.read"],
    });
    clearDeviceAuthToken({ deviceId: identity.deviceId, role: "operator" });

    const lines = debug.getLines().join("\n");
    expect(lines).toContain("[gw.auth] Device key pair generated");
    expect(lines).toContain("[gw.auth] Challenge signed");
    expect(lines).toContain("[gw.auth] Device token persisted");
  });
});
