// registration.mjs — the one writer and reader for run registration sidecars.
//
// The CLI owns the transcript while launchers and hooks own facts the CLI can
// never know. Keeping those facts in separate top-level groups lets each
// writer preserve the others, including when SessionEnd races a late claim.

import crypto from "node:crypto";
import fsDefault from "node:fs";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCK_STALE_MS = 30_000;

function jsonAt(file, fs) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function atomicJson(file, value, fs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function pause(ms) {
  // Registration is synchronous because launchers must finish the spool write
  // before spawning. Atomics.wait avoids a CPU spin during the rare hook race.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withEnvelopeLock(file, fs, now, operation) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    let handle;
    try {
      handle = fs.openSync(lock, "wx", 0o600);
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, at: now() }));
      try { return operation(); }
      finally {
        fs.closeSync(handle);
        try { fs.unlinkSync(lock); } catch {}
      }
    } catch (error) {
      if (handle !== undefined) try { fs.closeSync(handle); } catch {}
      if (error?.code !== "EEXIST") throw error;
      try {
        if (now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {}
      pause(2);
    }
  }
  throw new Error("run registration update is busy");
}

function claimValue(claim, runFile, now) {
  return {
    ...claim,
    at: Number.isFinite(claim?.at) ? claim.at : now(),
    runFile: claim?.runFile ?? path.resolve(runFile),
    hookPayloadKeys: Array.isArray(claim?.hookPayloadKeys)
      ? [...new Set(claim.hookPayloadKeys.filter((key) => typeof key === "string"))].sort()
      : [],
  };
}

function endValue(end, now) {
  return {
    ...end,
    at: Number.isFinite(end?.at) ? end.at : now(),
    status: end?.status === "failed" ? "failed" : "ended",
  };
}

export function registrationSidecarPath(runFile) {
  const file = path.resolve(String(runFile));
  return file.toLowerCase().endsWith(".jsonl")
    ? `${file.slice(0, -".jsonl".length)}.registration.json`
    : `${file}.registration.json`;
}

export function spoolPath(spoolDir, token) {
  if (!UUID.test(String(token))) throw new Error("invalid run registration token");
  return path.join(path.resolve(String(spoolDir)), `${token}.json`);
}

/** Write the launcher-owned groups before the child can start. */
export function writeRegistration({
  spoolDir,
  token = crypto.randomUUID(),
  writer = {},
  registration = {},
  fs = fsDefault,
  now = Date.now,
} = {}) {
  const file = spoolPath(spoolDir, token);
  const envelope = {
    envelopeVersion: 1,
    token,
    writer: { ...writer, at: Number.isFinite(writer.at) ? writer.at : now() },
    registration: { ...registration },
  };
  if (fs.existsSync(file)) {
    const existing = jsonAt(file, fs);
    if (existing === null) {
      atomicJson(file, envelope, fs);
    } else if (JSON.stringify(existing) !== JSON.stringify(envelope)) {
      throw new Error("run registration token already has different content");
    }
  } else {
    atomicJson(file, envelope, fs);
  }
  return { token, file, envelope };
}

/**
 * Write the claimer-owned group directly beside a run. When a hook has no
 * launcher token, writer and registration let it author the envelope too.
 */
export function writeRegistrationClaim({
  runFile,
  claim = {},
  token,
  writer,
  registration,
  fs = fsDefault,
  now = Date.now,
} = {}) {
  const file = registrationSidecarPath(runFile);
  return withEnvelopeLock(file, fs, now, () => {
    const existing = jsonAt(file, fs) ?? {};
    if (token !== undefined && existing.token !== undefined && existing.token !== token) {
      return { ok: false, reason: "registration token mismatch", file, envelope: existing };
    }
    const envelope = {
      ...existing,
      envelopeVersion: existing.envelopeVersion ?? 1,
      token: token ?? existing.token ?? null,
      ...(writer === undefined ? {} : { writer: { ...writer, at: Number.isFinite(writer.at) ? writer.at : now() } }),
      ...(registration === undefined ? {} : { registration: { ...registration } }),
      claim: claimValue(claim, runFile, now),
    };
    if (JSON.stringify(existing) !== JSON.stringify(envelope)) atomicJson(file, envelope, fs);
    return { ok: true, file, envelope };
  });
}

/** Move a launcher spool into the CLI-derived sidecar path, idempotently. */
export function claimRegistration({
  spoolDir,
  token,
  runFile,
  claim = {},
  fs = fsDefault,
  now = Date.now,
} = {}) {
  const source = spoolPath(spoolDir, token);
  const file = registrationSidecarPath(runFile);
  return withEnvelopeLock(file, fs, now, () => {
    const existing = jsonAt(file, fs);
    // The sidecar is already the durable binding when this token claimed it.
    // A delayed repair must not replace its launcher facts with an older spool.
    if (existing?.token === token) {
      return { ok: true, claimed: false, file, envelope: existing };
    }
    const spooled = jsonAt(source, fs);
    if (!spooled) {
      if (existing?.token === token) return { ok: true, claimed: false, file, envelope: existing };
      return { ok: false, reason: "registration spool missing", file, envelope: existing };
    }
    if (spooled.token !== token) return { ok: false, reason: "registration spool token mismatch", file, envelope: existing };
    if (existing?.token !== undefined && existing.token !== token) {
      return { ok: false, reason: "registration sidecar belongs to another token", file, envelope: existing };
    }
    const envelope = {
      ...(existing ?? {}),
      envelopeVersion: 1,
      token,
      writer: spooled.writer,
      registration: spooled.registration,
      claim: claimValue(claim, runFile, now),
    };
    atomicJson(file, envelope, fs);
    try { fs.unlinkSync(source); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return { ok: true, claimed: true, file, envelope };
  });
}

/** Write only the SessionEnd-owned group and preserve registration and claim. */
export function writeRegistrationEnd({ runFile, end = {}, fs = fsDefault, now = Date.now } = {}) {
  const file = registrationSidecarPath(runFile);
  return withEnvelopeLock(file, fs, now, () => {
    const existing = jsonAt(file, fs) ?? {};
    const envelope = { ...existing, end: endValue(end, now) };
    if (JSON.stringify(existing) !== JSON.stringify(envelope)) atomicJson(file, envelope, fs);
    return { ok: true, file, envelope };
  });
}

export function readRegistration(runFile, { fs = fsDefault } = {}) {
  return jsonAt(registrationSidecarPath(runFile), fs);
}

function setOptional(target, key, value) {
  if (value === null || value === undefined || value === "") delete target[key];
  else target[key] = value;
}

/** Merge only the fields whose authority is launcher registration or a hook. */
export function mergeRegistration({ parsed, envelope, host, report = () => {} }) {
  const result = structuredClone(parsed);
  const run = result.run;
  run.context ??= { layersKnown: false, layersGiven: [], layersDenied: [], skillsOffered: [], skillsUsed: [], tools: [], hooks: [] };
  if (!envelope || typeof envelope !== "object" || !envelope.registration) {
    run.context.registered = false;
    run.context.layersKnown = false;
    run.context.layersGiven = [];
    run.context.layersDenied = [];
    return { ...result, envelopeApplied: false };
  }
  const registration = envelope.registration;
  if (registration.host && registration.host !== host) {
    const event = { kind: "runs-envelope-host-mismatch", data: { runId: run.runId, registeredHost: registration.host, sweepHost: host } };
    report(event);
    run.context.registered = false;
    run.context.layersKnown = false;
    run.context.layersGiven = [];
    run.context.layersDenied = [];
    return { ...result, envelopeApplied: false, event };
  }

  if (typeof registration.origin === "string" && registration.origin) run.origin = registration.origin;
  if (typeof registration.kind === "string" && registration.kind) run.kind = registration.kind;
  for (const key of ["todoId", "batchId", "mergeKey", "continuesRunId"]) setOptional(run, key, registration[key]);

  run.context.registered = true;
  // THE TOKEN BECOMES A FIELD OF THE RUN, not only a name on disk. It is the
  // one exact edge from a row an agent wrote for Tom (dtsTodos, batches and
  // dtsCodeBriefs each carry it as producedByRunToken) back to the run that
  // wrote it, and convex/runLabels.ts resolves it on runs.by_reg_token. It is
  // set only on the applied path: an envelope that was refused for a host
  // mismatch describes a different machine's run, and stamping its token here
  // would make exactly the wrong edge the label design is written against.
  if (typeof envelope.token === "string" && envelope.token) run.regToken = envelope.token;
  if (typeof envelope.writer?.file === "string") run.context.launcher = envelope.writer.file;
  if (typeof registration.layersKnown === "boolean") run.context.layersKnown = registration.layersKnown;
  run.context.layersGiven = registration.layersKnown && Array.isArray(registration.layersGiven) ? [...registration.layersGiven] : [];
  run.context.layersDenied = registration.layersKnown && Array.isArray(registration.layersDenied) ? [...registration.layersDenied] : [];
  for (const key of ["skillsGranted", "skillsRefused"]) {
    if (Array.isArray(registration[key])) run.context[key] = [...registration[key]];
    else delete run.context[key];
  }
  for (const key of ["modelRequested", "promptSha256", "writingStandardSource"]) setOptional(run.context, key, registration[key]);
  if (!run.context.wikitomCommit && typeof registration.wikitomCommit === "string") run.context.wikitomCommit = registration.wikitomCommit;

  const launcher = String(envelope.writer?.file ?? "").replaceAll("\\", "/");
  if (typeof registration.parentRunId === "string" && registration.parentRunId && launcher.endsWith("codex-run.mjs")) {
    run.parentRunId = registration.parentRunId;
  }
  const hookKeys = Array.isArray(envelope.claim?.hookPayloadKeys) ? envelope.claim.hookPayloadKeys : [];
  const toolUseCarried = ["tool_use_id", "toolUseId", "parent_tool_use_id", "parentToolUseId"]
    .some((key) => hookKeys.includes(key));
  const hookAuthored = launcher.endsWith("run-hook.mjs")
    && envelope.claim?.by === "hook:SubagentStart"
    && toolUseCarried;
  if (hookAuthored && typeof registration.spawnedByToolUseId === "string" && registration.spawnedByToolUseId) {
    run.spawnedByToolUseId = registration.spawnedByToolUseId;
    run.linkKnown = true;
  }
  if (envelope.end && typeof envelope.end === "object") {
    run.status = envelope.end.status === "failed" ? "failed" : "ended";
    run.outcome ??= { totals: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0 }, turns: 0, toolCalls: 0 };
    setOptional(run.outcome, "endedReason", envelope.end.reason);
  }
  return { ...result, envelopeApplied: true };
}

/** Recover a Codex sidecar from the token deliberately embedded in its run. */
export function findCodexRegistration({
  text,
  spoolDir,
  runFile,
  claim = {},
  fs = fsDefault,
  now = Date.now,
} = {}) {
  const existing = readRegistration(runFile, { fs });
  if (existing) return { ok: true, claimed: false, file: registrationSidecarPath(runFile), envelope: existing };
  // A rollout can repeat prompt text in later tool output or assistant text.
  // Only its first persisted developer instruction is the launcher's binding.
  let developer = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    try {
      const entry = JSON.parse(raw);
      if (entry?.type === "response_item"
        && entry.payload?.type === "message"
        && entry.payload?.role === "developer") {
        developer = entry.payload;
        break;
      }
    } catch {
      // A partial or malformed line is not a persisted developer instruction.
    }
  }
  const instruction = Array.isArray(developer?.content)
    ? developer.content.map((part) => typeof part?.input_text === "string" ? part.input_text : typeof part?.text === "string" ? part.text : "").join("\n")
    : "";
  const token = /(?:^|\n)TTS-RUN-TOKEN:\s*([0-9a-f-]{36})(?:\r?\n|$)/i.exec(instruction)?.[1];
  if (!token || !UUID.test(token)) return { ok: false, reason: "run registration token absent" };
  return claimRegistration({
    spoolDir,
    token,
    runFile,
    claim: { by: "sweep:codex-token", ...claim },
    fs,
    now,
  });
}
