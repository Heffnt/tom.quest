// NO SHEBANG LINE. Tests import this module, and the installed hook invokes it
// through Node. The hook must never keep either CLI waiting on sweep work.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// The checkout keeps this under scripts/, while setup installs it under
// /opt/tts/scripts beside /opt/tts/runs. Resolve only those two known layouts.
const registrationUrl = [
  new URL("../worker/runs/registration.mjs", import.meta.url),
  new URL("../runs/registration.mjs", import.meta.url),
].find((candidate) => fs.existsSync(fileURLToPath(candidate)));
if (!registrationUrl) throw new Error("run registration module is not installed");
const {
  claimRegistration,
  writeRegistrationClaim,
  writeRegistrationEnd,
} = await import(registrationUrl.href);

export const HOOK_EVENTS = ["SessionStart", "SessionEnd", "Stop", "SubagentStart", "SubagentStop"];
export const HOOKS_CONFIGURED = ["SessionStart", "SessionEnd", "Stop", "SubagentStart", "SubagentStop"];

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim() !== "") ?? null;
}

export function stateDirectory(env = process.env) {
  if (env.RUN_SWEEP_STATE_DIR) return path.resolve(env.RUN_SWEEP_STATE_DIR);
  if (process.platform === "win32") {
    return path.join(path.resolve(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")), "tts", "runs");
  }
  return "/var/cache/tts/runs";
}

function hookLog(stateDir, message, fsImpl = fs) {
  try {
    fsImpl.mkdirSync(stateDir, { recursive: true });
    fsImpl.appendFileSync(path.join(stateDir, "hook.log"), `${new Date().toISOString()} [run-hook] ${String(message).replace(/[\r\n]+/g, " ").slice(0, 1000)}\n`);
  } catch {
    // A hook that cannot record its own failure must still release the CLI.
  }
}

export function runnerOf(payload, runFile, env = process.env) {
  const explicit = firstString(payload.runner, payload.runtime, payload.cli, payload.cli_name);
  if (explicit === "claude" || explicit === "codex") return explicit;
  const normalized = String(runFile ?? "").replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("/.codex/sessions/") || /(?:^|\/)rollout-/.test(normalized)) return "codex";
  if (normalized.includes("/.claude/") || normalized.includes("/.claude-accounts/")) return "claude";
  if (env.CODEX_HOME && normalized.startsWith(path.resolve(env.CODEX_HOME).replaceAll("\\", "/").toLowerCase())) return "codex";
  if (env.CLAUDE_CONFIG_DIR) return "claude";
  return null;
}

function encodedClaudeProject(cwd) {
  return path.resolve(cwd).replaceAll("\\", "-").replaceAll("/", "-").replaceAll(":", "-");
}

export function runFileOf(payload, event, env = process.env) {
  const agentPath = firstString(payload.agent_transcript_path, payload.agentTranscriptPath);
  const transcriptPath = firstString(
    payload.transcript_path,
    payload.transcriptPath,
    payload.rollout_path,
    payload.rolloutPath,
    payload.run_file,
    payload.runFile,
  );
  if (event === "SubagentStart" || event === "SubagentStop") {
    if (agentPath) return path.resolve(agentPath);
    const agentId = firstString(payload.agent_id, payload.agentId);
    if (transcriptPath && agentId && String(transcriptPath).toLowerCase().endsWith(".jsonl")) {
      const parent = path.resolve(transcriptPath);
      const stem = path.basename(parent, path.extname(parent));
      return path.join(path.dirname(parent), stem, "subagents", `agent-${agentId}.jsonl`);
    }
    return null;
  }
  if (transcriptPath) return path.resolve(transcriptPath);
  const sessionId = firstString(payload.session_id, payload.sessionId);
  const cwd = firstString(payload.cwd);
  if (sessionId && cwd) {
    const config = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".claude"));
    return path.join(config, "projects", encodedClaudeProject(cwd), `${sessionId}.jsonl`);
  }
  return null;
}

function sweepScript(env = process.env) {
  if (env.RUN_SWEEP_SCRIPT) return path.resolve(env.RUN_SWEEP_SCRIPT);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "../worker/runs/sweep.mjs"), path.resolve(here, "../runs/sweep.mjs")];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

export function spawnSweep(runFile, env = process.env, spawnImpl = spawn) {
  const args = [sweepScript(env), ...(runFile ? ["--file", runFile] : [])];
  const child = spawnImpl(process.execPath, args, { detached: true, stdio: "ignore", env });
  child.unref();
}

function claimFields(payload, event, runFile) {
  const threadId = event.startsWith("Subagent")
    ? firstString(payload.agent_id, payload.agentId)
    : firstString(payload.session_id, payload.sessionId, payload.thread_id, payload.threadId);
  const cliVersion = firstString(payload.cli_version, payload.cliVersion, payload.version);
  return {
    by: `hook:${event}`,
    ...(threadId ? { threadId } : {}),
    runFile,
    ...(cliVersion ? { cliVersion } : {}),
    hookPayloadKeys: Object.keys(payload).sort(),
  };
}

function hookRegistration(payload, event, runFile, env) {
  const host = env.RUN_HOST === "box" || env.RUN_HOST === "laptop" ? env.RUN_HOST : null;
  const runner = runnerOf(payload, runFile, env);
  const parentThread = firstString(payload.session_id, payload.sessionId, payload.thread_id, payload.threadId);
  const toolUseId = firstString(
    payload.tool_use_id,
    payload.toolUseId,
    payload.parent_tool_use_id,
    payload.parentToolUseId,
  );
  const normalizedFile = String(runFile).replaceAll("\\", "/").toLowerCase();
  const laptop = host === "laptop"
    || (normalizedFile.includes("/.claude/") && !normalizedFile.includes("/.claude-accounts/"))
    || (process.platform === "win32" && !normalizedFile.includes("/.claude-accounts/"));
  return {
    host,
    ...(runner ? { runner } : {}),
    origin: laptop ? "laptop" : firstString(env.TTS_RUN_ORIGIN) ?? "unknown",
    kind: event.startsWith("Subagent") ? "subagent" : "session",
    cwd: firstString(payload.cwd),
    ...(event.startsWith("Subagent") && runner && host && parentThread
      ? { parentRunId: `${runner}:${host}:${parentThread}` }
      : {}),
    ...(event.startsWith("Subagent") && toolUseId ? { spawnedByToolUseId: toolUseId } : {}),
    layersKnown: laptop,
    layersGiven: laptop ? ["operate", "write"] : [],
    layersDenied: laptop ? ["know"] : [],
    hooksConfigured: [...HOOKS_CONFIGURED],
  };
}

function failedReason(reason) {
  return /(?:fail|error|crash|abort|exception)/i.test(String(reason ?? ""));
}

export function handleHook(payload, { event, env = process.env, spawnImpl = spawn } = {}) {
  const stateDir = stateDirectory(env);
  const hookEvent = event || firstString(payload?.hook_event_name, payload?.hookEventName);
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !HOOK_EVENTS.includes(hookEvent)) {
    hookLog(stateDir, "ignored malformed or unknown hook payload");
    return { handled: false };
  }
  const runFile = runFileOf(payload, hookEvent, env);
  if (!runFile) {
    hookLog(stateDir, `${hookEvent} payload carried no usable run path`);
    return { handled: false };
  }
  const claim = claimFields(payload, hookEvent, runFile);
  if (hookEvent === "SessionStart") {
    const token = firstString(env.TTS_RUN_REG_TOKEN);
    const result = token
      ? claimRegistration({ spoolDir: env.TTS_RUN_REG_SPOOL || path.join(stateDir, "registration"), token, runFile, claim })
      : writeRegistrationClaim({
          runFile,
          claim,
          token: null,
          writer: { file: "scripts/run-hook.mjs", job: "run-hook" },
          registration: hookRegistration(payload, hookEvent, runFile, env),
        });
    if (!result.ok) hookLog(stateDir, `${hookEvent} could not claim its registration: ${result.reason}`);
    return { handled: true, file: result.file };
  }
  if (hookEvent === "SubagentStart") {
    const result = writeRegistrationClaim({
      runFile,
      claim,
      token: null,
      writer: { file: "scripts/run-hook.mjs", job: "run-hook" },
      registration: hookRegistration(payload, hookEvent, runFile, env),
    });
    return { handled: true, file: result.file };
  }
  if (hookEvent === "SessionEnd" || hookEvent === "SubagentStop") {
    const reason = firstString(payload.reason) ?? "";
    writeRegistrationEnd({
      runFile,
      end: { by: `hook:${hookEvent}`, reason, status: failedReason(reason) ? "failed" : "ended" },
    });
  }
  spawnSweep(runFile, env, spawnImpl);
  return { handled: true, swept: true };
}

function eventArg(argv) {
  const index = argv.indexOf("--event");
  return index === -1 ? null : argv[index + 1] ?? null;
}

function main() {
  const stateDir = stateDirectory();
  try {
    const input = fs.readFileSync(0, "utf8");
    if (input.trim() === "") {
      hookLog(stateDir, "ignored empty hook payload");
      return;
    }
    let payload;
    try { payload = JSON.parse(input); }
    catch {
      hookLog(stateDir, "ignored non-JSON hook payload");
      return;
    }
    handleHook(payload, { event: eventArg(process.argv.slice(2)) });
  } catch (error) {
    hookLog(stateDir, error?.message ?? error);
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
  process.exit(0);
}
