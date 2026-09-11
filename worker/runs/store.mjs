// store.mjs — immutable, content-addressed versions of run files.
//
// Redaction happens before compression and hashing: a version is the exact
// redacted bytes a parser may turn into rows, never a second private copy of a
// CLI transcript. The deliberately small put/get/head surface is the seam
// between the local directory and the bucket: both backends answer the same
// three calls with the same descriptor, so nothing above this file knows which
// one is configured.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { redactSecrets } from "../session-host/redact.mjs";
import { createS3Client, sha256Hex } from "./s3.mjs";

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const safePart = (value, name) => {
  const string = String(value);
  if (!string || string.includes("/") || string.includes("\\") || string === "." || string === "..") {
    throw new Error(`invalid run store ${name}`);
  }
  return string;
};
const safeThreadParts = (threadId) => {
  const parts = String(threadId).split("/");
  if (parts.length < 1 || parts.length > 2 || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) throw new Error("invalid run store thread id");
  return parts;
};
// The kind selects the object's extension inside the thread's folder and
// nothing else, so a registration envelope is addressed exactly like the run
// it belongs to.
const KIND_EXTENSIONS = Object.freeze({ transcript: ".jsonl.gz", sidecar: ".sidecar.json.gz", registration: ".registration.json.gz" });
const kindOf = (kind) => {
  if (!Object.hasOwn(KIND_EXTENSIONS, kind)) throw new Error("invalid run store object kind");
  return kind;
};
const objectKey = ({ runtime, threadId, host, fileVersion, kind = "transcript" }) => [
  "runs",
  safePart(runtime, "runtime"),
  safePart(host, "host"),
  ...safeThreadParts(threadId),
  `${safePart(fileVersion, "file version")}${KIND_EXTENSIONS[kindOf(kind)]}`,
].join("/");
const sourceDescriptorPath = (file, sourceHash) => `${file}.${sourceHash}.source.json`;
const metadataPath = (file) => `${file}.meta.json`;
const writeImmutableJson = (file, value, mismatch) => {
  const bytes = Buffer.from(JSON.stringify(value));
  try {
    fs.writeFileSync(file, bytes, { flag: "wx" });
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    if (!fs.readFileSync(file).equals(bytes)) throw new Error(mismatch);
  }
};

// Both backends hash the same way, so a version computed against the local
// directory names the same object in the bucket.
function prepared(sourceBytes) {
  const source = Buffer.isBuffer(sourceBytes) ? sourceBytes : Buffer.from(sourceBytes);
  const sourceHash = sha256(source);
  const redacted = Buffer.from(redactSecrets(source.toString("utf8")), "utf8");
  const compressed = gzipDeterministic(redacted);
  return { source, sourceHash, compressed, storedHash: sha256(compressed) };
}

export function gzipDeterministic(bytes) {
  // gzipSync defaults mtime to zero; level is explicit so the object identity
  // remains stable across sweeps on the same supported Node runtime.
  return zlib.gzipSync(bytes, { level: 9 });
}

/** @returns {any} Local calls stay synchronous; only the configured S3 backend returns promises. */
export function openStore({ backend = "local", dir, s3 } = {}) {
  if (backend === "s3") return openS3Store(s3);
  if (backend !== "local") throw new Error(`unsupported run store backend: ${backend}`);
  if (!dir) throw new Error("run store dir is required");
  const root = path.resolve(dir);

  function objectPath({ runtime, threadId, host, fileVersion, kind = "transcript" }) {
    return path.join(root, ...objectKey({ runtime, threadId, host, fileVersion, kind }).split("/"));
  }

  return {
    put({ runtime, threadId, host, sourceBytes, kind = "transcript" }) {
      const objectKind = kindOf(kind);
      const { source, sourceHash, compressed, storedHash } = prepared(sourceBytes);
      const fileVersion = storedHash;
      const file = objectPath({ runtime, threadId, host, fileVersion, kind: objectKind });
      const key = objectKey({ runtime, threadId, host, fileVersion, kind: objectKind });
      const sourceKey = path.relative(root, sourceDescriptorPath(file, sourceHash)).split(path.sep).join("/");
      let created = false;
      // Object facts are determined by the redacted bytes. Source facts are
      // not: two originals can intentionally become one redacted object.
      // Keeping the latter in a source-hash-suffixed immutable descriptor
      // lets both valid sources coexist without weakening object integrity.
      const intrinsic = {
        fileVersion,
        storedHash,
        storedBytes: compressed.length,
        key,
        kind: objectKind,
      };
      const sourceDescriptor = {
        sourceHash,
        bytes: source.length,
        sourceKey,
      };
      if (fs.existsSync(file)) {
        const existing = fs.readFileSync(file);
        if (!existing.equals(compressed)) throw new Error("run store hash collision or corrupt object");
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // wx makes accidental concurrent writers prove they wrote the same bytes.
        try {
          fs.writeFileSync(file, compressed, { flag: "wx" });
          created = true;
        } catch (err) {
          if (err?.code !== "EEXIST") throw err;
          const existing = fs.readFileSync(file);
          if (!existing.equals(compressed)) throw new Error("run store hash collision or corrupt object");
        }
      }
      writeImmutableJson(metadataPath(file), intrinsic, "run store object metadata mismatch");
      writeImmutableJson(sourceDescriptorPath(file, sourceHash), sourceDescriptor, "run store source descriptor mismatch");
      // The local backend re-reads what it wrote, so the bytes at the key are
      // proven to be these bytes — the same claim the bucket's checksum echo
      // makes, and what the sweeper requires before it writes a store key.
      return { ...intrinsic, ...sourceDescriptor, verified: true, created };
    },

    head({ runtime, threadId, host, fileVersion, sourceHash, kind = "transcript" }) {
      const objectKind = kindOf(kind);
      const file = objectPath({ runtime, threadId, host, fileVersion, kind: objectKind });
      if (!fs.existsSync(file)) return null;
      const compressed = fs.readFileSync(file);
      if (sha256(compressed) !== fileVersion) throw new Error("run store object hash mismatch");
      const meta = metadataPath(file);
      if (!fs.existsSync(meta)) throw new Error("run store descriptor missing");
      const intrinsic = JSON.parse(fs.readFileSync(meta, "utf8"));
      if (sourceHash === undefined) return { ...intrinsic, verified: true };
      const sourceMeta = sourceDescriptorPath(file, safePart(sourceHash, "source hash"));
      if (!fs.existsSync(sourceMeta)) return null;
      return { ...intrinsic, ...JSON.parse(fs.readFileSync(sourceMeta, "utf8")), verified: true };
    },

    get({ runtime, threadId, host, fileVersion, kind = "transcript" }) {
      const file = objectPath({ runtime, threadId, host, fileVersion, kind: kindOf(kind) });
      if (!fs.existsSync(file)) throw new Error("run store object not found");
      const compressed = fs.readFileSync(file);
      if (sha256(compressed) !== fileVersion) throw new Error("run store object hash mismatch");
      return zlib.gunzipSync(compressed);
    },
  };
}

function openS3Store(config = {}) {
  const client = createS3Client(config);

  return {
    async put({ runtime, threadId, host, sourceBytes, kind = "transcript" }) {
      const objectKind = kindOf(kind);
      const { source, sourceHash, compressed, storedHash } = prepared(sourceBytes);
      const key = objectKey({ runtime, threadId, host, fileVersion: storedHash, kind: objectKind });
      const checksum = Buffer.from(storedHash, "hex").toString("base64");
      const response = await client.putObject({ key, body: compressed, checksumSha256: checksum });
      const echoed = response.headers.get("x-amz-checksum-sha256");
      if (echoed && echoed !== checksum) throw new Error(`S3 checksum verification failed for ${key}`);
      let verified = echoed === checksum;
      // The uploader credential cannot read, so a service that echoes the
      // checksum has already verified the bytes for us. Only where it does not
      // do we spend the reader credential on a HEAD.
      if (!echoed && client.hasReader) {
        const head = await client.headObject({ key });
        const length = Number(head.headers.get("content-length"));
        const etag = String(head.headers.get("etag") ?? "").replace(/^"|"$/g, "").toLowerCase();
        const md5 = crypto.createHash("md5").update(compressed).digest("hex");
        if (!head.ok || length !== compressed.length || etag !== md5) throw new Error(`S3 read-back verification failed for ${key}`);
        verified = true;
      }
      return {
        fileVersion: storedHash,
        storedHash,
        storedBytes: compressed.length,
        kind: objectKind,
        sourceHash,
        bytes: source.length,
        // An unverified upload gets no key, so nothing downstream can claim
        // bytes nobody checked.
        ...(verified ? { key } : {}),
        verified,
        created: true,
      };
    },

    async head({ runtime, threadId, host, fileVersion, kind = "transcript" }) {
      const objectKind = kindOf(kind);
      const key = objectKey({ runtime, threadId, host, fileVersion, kind: objectKind });
      const response = await client.headObject({ key });
      if (response.status === 404) return null;
      const checksum = response.headers.get("x-amz-checksum-sha256");
      return {
        fileVersion,
        storedHash: fileVersion,
        storedBytes: Number(response.headers.get("content-length")) || 0,
        key,
        kind: objectKind,
        verified: checksum === Buffer.from(fileVersion, "hex").toString("base64"),
      };
    },

    async get({ runtime, threadId, host, fileVersion, kind = "transcript" }) {
      const key = objectKey({ runtime, threadId, host, fileVersion, kind: kindOf(kind) });
      const response = await client.getObject({ key });
      const compressed = Buffer.from(await response.arrayBuffer());
      if (sha256Hex(compressed) !== fileVersion) throw new Error(`S3 object hash mismatch for ${key}`);
      return zlib.gunzipSync(compressed);
    },
  };
}
