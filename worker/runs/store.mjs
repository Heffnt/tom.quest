// store.mjs — immutable, local content-addressed versions of run files.
//
// Redaction happens before compression and hashing: a version is the exact
// redacted bytes a parser may turn into rows, never a second private copy of a
// CLI transcript. The deliberately small put/get/head surface is also the
// seam where the phase-three bucket backend can replace this directory.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { redactSecrets } from "../session-host/redact.mjs";

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
const KIND_EXTENSIONS = Object.freeze({ transcript: ".jsonl.gz", sidecar: ".sidecar.json.gz" });
const kindOf = (kind) => {
  if (!Object.hasOwn(KIND_EXTENSIONS, kind)) throw new Error("invalid run store object kind");
  return kind;
};
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

export function gzipDeterministic(bytes) {
  // gzipSync defaults mtime to zero; level is explicit so the object identity
  // remains stable across sweeps on the same supported Node runtime.
  return zlib.gzipSync(bytes, { level: 9 });
}

export function openStore({ backend = "local", dir } = {}) {
  if (backend !== "local") throw new Error(`unsupported run store backend: ${backend}`);
  if (!dir) throw new Error("run store dir is required");
  const root = path.resolve(dir);

  function objectPath({ runtime, threadId, host, fileVersion, kind = "transcript" }) {
    return path.join(
      root,
      "runs",
      safePart(runtime, "runtime"),
      safePart(host, "host"),
      ...safeThreadParts(threadId),
      `${safePart(fileVersion, "file version")}${KIND_EXTENSIONS[kindOf(kind)]}`,
    );
  }

  return {
    put({ runtime, threadId, host, sourceBytes, kind = "transcript" }) {
      const objectKind = kindOf(kind);
      const source = Buffer.isBuffer(sourceBytes) ? sourceBytes : Buffer.from(sourceBytes);
      const sourceHash = sha256(source);
      const redacted = Buffer.from(redactSecrets(source.toString("utf8")), "utf8");
      const compressed = gzipDeterministic(redacted);
      const storedHash = sha256(compressed);
      const fileVersion = storedHash;
      const file = objectPath({ runtime, threadId, host, fileVersion, kind: objectKind });
      const key = path.relative(root, file).split(path.sep).join("/");
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
      const descriptor = { ...intrinsic, ...sourceDescriptor };
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
      return { ...descriptor, created };
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
      if (sourceHash === undefined) return intrinsic;
      const sourceMeta = sourceDescriptorPath(file, safePart(sourceHash, "source hash"));
      if (!fs.existsSync(sourceMeta)) return null;
      return { ...intrinsic, ...JSON.parse(fs.readFileSync(sourceMeta, "utf8")) };
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
