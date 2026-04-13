"use client";

import { logDebug } from "@/app/lib/debug";

type StoredIdentity = {
  version: 1;
  deviceId: string;
  publicKey: string;
  privateKey: string;
  createdAtMs: number;
};

export type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: string;
};

export type DeviceAuthEntry = {
  token: string;
  role: string;
  scopes: string[];
  updatedAtMs: number;
};

type DeviceAuthStore = {
  version: 1;
  deviceId: string;
  tokens: Record<string, DeviceAuthEntry>;
};

export type GatewayConnectDevice = {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
};

const IDENTITY_STORAGE_KEY = "openclaw-device-identity-v1";
const AUTH_STORAGE_KEY = "openclaw.device.auth.v1";
const LOG_SOURCE = "Gateway";

function getSafeLocalStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeRole(role: string): string {
  return role.trim();
}

function normalizeScopes(scopes: string[] | undefined): string[] {
  if (!Array.isArray(scopes)) return [];
  const out = new Set<string>();
  for (const scope of scopes) {
    const trimmed = scope.trim();
    if (trimmed) out.add(trimmed);
  }
  if (out.has("operator.admin")) {
    out.add("operator.read");
    out.add("operator.write");
  } else if (out.has("operator.write")) {
    out.add("operator.read");
  }
  return [...out].toSorted();
}

async function fingerprintPublicKey(publicKey: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", toArrayBuffer(publicKey));
  return bytesToHex(new Uint8Array(hash));
}

async function generateIdentity(): Promise<DeviceIdentity> {
  const pair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateKeyBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const deviceId = await fingerprintPublicKey(publicKeyBytes);
  const identity = {
    deviceId,
    publicKey: base64UrlEncode(publicKeyBytes),
    privateKey: base64UrlEncode(privateKeyBytes),
  };
  logDebug("lifecycle", "Device key pair generated", {
    deviceId,
    publicKeyBytes: publicKeyBytes.byteLength,
    privateKeyBytes: privateKeyBytes.byteLength,
  }, LOG_SOURCE);
  return identity;
}

export async function loadOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  const storage = getSafeLocalStorage();
  try {
    const raw = storage?.getItem(IDENTITY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredIdentity;
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === "string" &&
        typeof parsed.publicKey === "string" &&
        typeof parsed.privateKey === "string"
      ) {
        const derivedId = await fingerprintPublicKey(base64UrlDecode(parsed.publicKey));
        if (derivedId !== parsed.deviceId) {
          const repaired: StoredIdentity = { ...parsed, deviceId: derivedId };
          storage?.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(repaired));
          logDebug("info", "Device ID derived from stored public key", {
            previousDeviceId: parsed.deviceId,
            deviceId: derivedId,
            repaired: true,
          }, LOG_SOURCE);
          return {
            deviceId: derivedId,
            publicKey: parsed.publicKey,
            privateKey: parsed.privateKey,
          };
        }
        logDebug("info", "Device identity loaded from storage", {
          deviceId: parsed.deviceId,
          repaired: false,
        }, LOG_SOURCE);
        return {
          deviceId: parsed.deviceId,
          publicKey: parsed.publicKey,
          privateKey: parsed.privateKey,
        };
      }
    }
  } catch (error) {
    logDebug("error", "Failed to load stored device identity", error, LOG_SOURCE);
  }

  const identity = await generateIdentity();
  const stored: StoredIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    createdAtMs: Date.now(),
  };
  storage?.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(stored));
  return identity;
}

export function buildDeviceAuthPayload(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
}): string {
  return [
    "v2",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
  ].join("|");
}

async function signDevicePayload(privateKeyBase64Url: string, payload: string) {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(base64UrlDecode(privateKeyBase64Url)),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(payload),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

export async function buildConnectDevice(params: {
  identity: DeviceIdentity;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  token?: string | null;
  nonce: string;
}): Promise<GatewayConnectDevice> {
  const signedAt = Date.now();
  const payload = buildDeviceAuthPayload({
    deviceId: params.identity.deviceId,
    clientId: params.clientId,
    clientMode: params.clientMode,
    role: params.role,
    scopes: params.scopes,
    signedAtMs: signedAt,
    token: params.token ?? null,
    nonce: params.nonce,
  });
  const signature = await signDevicePayload(params.identity.privateKey, payload);
  logDebug("lifecycle", "Challenge signed", {
    deviceId: params.identity.deviceId,
    clientId: params.clientId,
    clientMode: params.clientMode,
    role: params.role,
    scopes: params.scopes,
    nonce: params.nonce,
  }, LOG_SOURCE);
  return {
    id: params.identity.deviceId,
    publicKey: params.identity.publicKey,
    signature,
    signedAt,
    nonce: params.nonce,
  };
}

function readAuthStore(): DeviceAuthStore | null {
  try {
    const raw = getSafeLocalStorage()?.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DeviceAuthStore;
    if (
      parsed?.version !== 1 ||
      typeof parsed.deviceId !== "string" ||
      !parsed.tokens ||
      typeof parsed.tokens !== "object"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeAuthStore(store: DeviceAuthStore) {
  try {
    getSafeLocalStorage()?.setItem(AUTH_STORAGE_KEY, JSON.stringify(store));
  } catch (error) {
    logDebug("error", "Failed to write device auth token store", error, LOG_SOURCE);
  }
}

export function loadDeviceAuthToken(params: {
  deviceId: string;
  role: string;
}): DeviceAuthEntry | null {
  const store = readAuthStore();
  if (!store || store.deviceId !== params.deviceId) return null;
  const entry = store.tokens[normalizeRole(params.role)];
  if (!entry || typeof entry.token !== "string") return null;
  logDebug("info", "Device token loaded from storage", {
    deviceId: params.deviceId,
    role: entry.role,
    scopes: entry.scopes,
  }, LOG_SOURCE);
  return entry;
}

export function storeDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
}): DeviceAuthEntry {
  const role = normalizeRole(params.role);
  const existing = readAuthStore();
  const next: DeviceAuthStore = {
    version: 1,
    deviceId: params.deviceId,
    tokens:
      existing && existing.deviceId === params.deviceId && existing.tokens
        ? { ...existing.tokens }
        : {},
  };
  const entry: DeviceAuthEntry = {
    token: params.token,
    role,
    scopes: normalizeScopes(params.scopes),
    updatedAtMs: Date.now(),
  };
  next.tokens[role] = entry;
  writeAuthStore(next);
  logDebug("info", "Device token persisted", {
    deviceId: params.deviceId,
    role,
    scopes: entry.scopes,
  }, LOG_SOURCE);
  return entry;
}

export function clearDeviceAuthToken(params: { deviceId: string; role: string }) {
  const store = readAuthStore();
  if (!store || store.deviceId !== params.deviceId) return;
  const role = normalizeRole(params.role);
  if (!store.tokens[role]) return;
  const next: DeviceAuthStore = {
    version: 1,
    deviceId: store.deviceId,
    tokens: { ...store.tokens },
  };
  delete next.tokens[role];
  writeAuthStore(next);
  logDebug("info", "Device token cleared", {
    deviceId: params.deviceId,
    role,
  }, LOG_SOURCE);
}
