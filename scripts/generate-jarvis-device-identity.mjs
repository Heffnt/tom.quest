import { webcrypto } from "node:crypto";

function base64UrlEncode(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const { subtle } = webcrypto;
const pair = await subtle.generateKey(
  { name: "Ed25519" },
  true,
  ["sign", "verify"],
);
const publicKeyBytes = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
const privateKeyBytes = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
const deviceId = bytesToHex(new Uint8Array(await subtle.digest("SHA-256", publicKeyBytes)));

console.log(`JARVIS_DEVICE_ID=${deviceId}`);
console.log(`JARVIS_DEVICE_PUBLIC_KEY=${base64UrlEncode(publicKeyBytes)}`);
console.log(`JARVIS_DEVICE_PRIVATE_KEY=${base64UrlEncode(privateKeyBytes)}`);
