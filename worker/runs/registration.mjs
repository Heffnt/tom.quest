// registration.mjs — the one writer and reader for run registration sidecars.
//
// The CLI owns the transcript while launchers and hooks own facts the CLI can
// never know. Keeping those facts in separate top-level groups lets each
// writer preserve the others, including when SessionEnd races a late claim.
//
// THE ENVELOPE HAS FOUR GROUPS and one writer each:
//
//   writer + registration — the launcher, through writeRegistration.
//   claim                 — the claimer, through claimRegistration or
//                           writeRegistrationClaim.
//   end                   — SessionEnd, through writeRegistrationEnd.
//   skills                — `tts search skills`, through appendSkillAsk.
//
// Beside the envelope, a claim leaves ONE POINTER FILE at the token it claimed
// (claimPointerPath). It is not a group and carries no fact about the run; it
// exists so a child process holding only the token can still find the envelope
// after the claim removed the spool. See claimPointerPath.
//
// `skills` arrived with envelopeVersion 2. A VERSION-1 ENVELOPE READS WITH
// `skills` ABSENT AND THAT IS NOT AN ERROR: one already on disk when the
// version changed describes a real run, and stamping 2 on it at a later claim
// or end would restate a fact its launcher never wrote.

import crypto from "node:crypto";
import fsDefault from "node:fs";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCK_STALE_MS = 30_000;

/** The version a NEW envelope is written at. An existing one keeps its own. */
export const ENVELOPE_VERSION = 2;

/** The most `skills.asked` entries an envelope keeps. AN ENVELOPE IS NOT A LOG:
 * it records one run, and a session that walked the catalog would otherwise
 * grow the sidecar without bound. Past the cap the OLDEST entry is dropped,
 * because what a reader of the run wants is its most recent asks. */
export const SKILL_ASK_CAP = 50;

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

function skillAskValue(ask, now) {
  const value = {
    at: Number.isFinite(ask?.at) ? ask.at : now(),
    name: String(ask?.name ?? ""),
    result: ask?.result === "refused" ? "refused" : "ok",
  };
  if (typeof ask?.why === "string" && ask.why !== "") value.why = ask.why;
  return value;
}

/** The `skills` group of two envelopes as one, oldest ask first and capped.
 * A claim needs this because the group belongs to neither side alone: an ask
 * made before the claim is on the spool, and one made after an early
 * SessionEnd is already on the sidecar. */
function mergeSkillAsks(...groups) {
  const asked = groups
    .flatMap((group) => (Array.isArray(group?.asked) ? group.asked : []))
    .filter((entry) => entry !== null && typeof entry === "object")
    .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
    .slice(-SKILL_ASK_CAP);
  return asked.length === 0 ? undefined : { asked };
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

/**
 * Where a claim leaves the run file it claimed the token into.
 *
 * THE TOKEN IS ALL A CHILD PROCESS HAS. The session-host puts exactly
 * TTS_RUN_REG_TOKEN and TTS_RUN_REG_SPOOL in its child env — the transcript
 * path is the CLI's and nobody knows it at spawn time — so `tts search skills`
 * can name the spool and nothing else. The claim removes the spool, and without
 * this pointer every ask made after SessionStart, which is every ask there is,
 * would have no envelope to land on.
 *
 * A SEPARATE NAME rather than leaving a stub at the spool path: writeRegistration
 * refuses a token whose file holds different content, and the spool path is its
 * to own. The sweep's spool cleanup ages this file out with everything else in
 * the directory.
 */
export function claimPointerPath(spoolDir, token) {
  if (!UUID.test(String(token))) throw new Error("invalid run registration token");
  return path.join(path.resolve(String(spoolDir)), `${token}.claimed.json`);
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
    envelopeVersion: ENVELOPE_VERSION,
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
      envelopeVersion: existing.envelopeVersion ?? ENVELOPE_VERSION,
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
      // The spool is the launcher's authority on the version, so an envelope
      // written at 1 is still at 1 after its claim. Only a claim that authors
      // an envelope out of nothing gets the current version.
      envelopeVersion: spooled.envelopeVersion ?? existing?.envelopeVersion ?? ENVELOPE_VERSION,
      token,
      writer: spooled.writer,
      registration: spooled.registration,
      claim: claimValue(claim, runFile, now),
    };
    const skills = mergeSkillAsks(existing?.skills, spooled.skills);
    if (skills === undefined) delete envelope.skills;
    else envelope.skills = skills;
    atomicJson(file, envelope, fs);
    try { fs.unlinkSync(source); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    // The forwarding address the spool leaves behind. A later ask holding only
    // the token follows it to this sidecar; see claimPointerPath. It is written
    // after the sidecar, so a reader that finds it finds an envelope there, and
    // a failure to write it costs asks, never the claim.
    try { atomicJson(claimPointerPath(spoolDir, token), { token, runFile: path.resolve(runFile) }, fs); } catch {}
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

/**
 * Append one `tts search skills <name>` to the run's envelope. APPEND-ONLY and
 * the fourth writer: it touches `skills` and nothing else, under the same lock
 * and the same atomic tmp+rename every other writer uses.
 *
 * It takes the spool, the sidecar, or both. `tts search skills` runs inside a
 * child whose run file has NO SIDECAR YET — a sidecar is only created at claim
 * time — so the spool is the ordinary target; the sidecar wins when it exists,
 * because after a claim the spool is gone and the sidecar is the durable
 * envelope.
 *
 * An envelope that is not on disk is NOT created here. There is no run to
 * append to, and a skills-only file at a spool path would collide with the
 * launcher's own write, which refuses a token whose content differs.
 *
 * The version is left exactly as found: a `skills` group reads fine at either
 * version, and envelopeVersion records what the launcher wrote, not what a
 * later writer happened to add.
 */
export function appendSkillAsk({ runFile, spoolDir, token, ask = {}, fs = fsDefault, now = Date.now } = {}) {
  const sidecar = runFile === undefined || runFile === null || runFile === "" ? null : registrationSidecarPath(runFile);
  const spool = spoolDir === undefined || spoolDir === null || spoolDir === "" ? null : spoolPath(spoolDir, token);
  let file = sidecar !== null && fs.existsSync(sidecar) ? sidecar : (spool ?? sidecar);
  if (file === null) return { ok: false, reason: "no run registration envelope named" };
  // A caller holding only the token, after the claim took the spool away:
  // follow the forwarding address to the sidecar. This is the ORDINARY case on
  // the box, where every ask is made inside a claimed session.
  if (spool !== null && !fs.existsSync(file)) {
    const pointed = jsonAt(claimPointerPath(spoolDir, token), fs);
    if (typeof pointed?.runFile === "string" && pointed.runFile !== "") file = registrationSidecarPath(pointed.runFile);
  }
  return withEnvelopeLock(file, fs, now, () => {
    const existing = jsonAt(file, fs);
    if (existing === null) return { ok: false, reason: "run registration envelope missing", file };
    if (token !== undefined && existing.token !== undefined && existing.token !== null && existing.token !== token) {
      return { ok: false, reason: "registration token mismatch", file, envelope: existing };
    }
    const asked = Array.isArray(existing.skills?.asked) ? existing.skills.asked : [];
    const envelope = {
      ...existing,
      envelopeVersion: existing.envelopeVersion ?? ENVELOPE_VERSION,
      skills: { ...existing.skills, asked: [...asked, skillAskValue(ask, now)].slice(-SKILL_ASK_CAP) },
    };
    atomicJson(file, envelope, fs);
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
  // The fourth group, written by `tts search skills` rather than by a
  // launcher. It is FLATTENED TO PLAIN STRINGS because convex/schema.ts types
  // every runs.context list as v.array(v.string()): a string array is the only
  // additive shape, so the name and the result travel as one `name (result)`.
  // Like skillsGranted it is set only on the applied path.
  const asked = Array.isArray(envelope.skills?.asked) ? envelope.skills.asked : [];
  if (asked.length > 0) {
    run.context.skillsAsked = asked.map((entry) => `${String(entry?.name ?? "")} (${String(entry?.result ?? "")})`);
  } else {
    delete run.context.skillsAsked;
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
