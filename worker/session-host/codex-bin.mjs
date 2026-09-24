// codex-bin.mjs — where the Codex binary is, how it is spawned, and the flags
// every `codex exec` carries. codex-query.mjs (the session runner) and
// session-host.mjs (the warm-up and the usage read) both spawn Codex; each
// used to resolve the binary and build the node-shim spawn by hand, and a
// change to one drifted from the other. One home now.
//
// Dependency-free (node:fs, node:path, node:child_process only) so the
// repo's vitest can import it — the same reason banned-tools.mjs and
// fork-transcript.mjs stand alone.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

// The Codex binary: CODEX_BIN when set, else `codex` on PATH (setup.sh
// installs @openai/codex globally and logs it in once via device auth). A
// CODEX_BIN ending in .mjs/.js is run under this same node — that is how the
// unit tests substitute a fake that prints canned JSONL; the box's CODEX_BIN
// is always a real binary.
export const CODEX_BIN = process.env.CODEX_BIN || "codex";

// The absolute path the binary would be spawned from, or null when there is
// no such file — so a caller can skip work that only makes sense with Codex
// installed (the warm-up) instead of spawning to find out. A CODEX_BIN with
// a path separator is checked as given; a bare name is searched on PATH the
// way spawn would (with the Windows extensions, for the unit tests).
export function resolveCodexBin() {
  if (CODEX_BIN.includes("/") || CODEX_BIN.includes("\\")) {
    return fs.existsSync(CODEX_BIN) ? CODEX_BIN : null;
  }
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe"] : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, CODEX_BIN + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// spawn() with the .mjs test hook applied: a script CODEX_BIN runs under
// this node with the same args. `opts` is passed through untouched.
export function spawnCodex(args, opts) {
  const viaNode = /\.m?js$/.test(CODEX_BIN);
  return spawn(
    viaNode ? process.execPath : CODEX_BIN,
    viaNode ? [CODEX_BIN, ...args] : args,
    opts,
  );
}

// The account's rate limits, as `codex app-server` answers
// account/rateLimits/read (session-host.mjs's readCodexUsage), turned into
// the heartbeat's codexUsage figures. The one parse of that shape.
//
// The windows are told apart by windowDurationMins, NEVER by position:
// codex-cli 0.130 (2026-09-04) put the 5-hour window (300) in `primary` and
// the weekly one (10080) in `secondary`; codex-cli 0.153.3 (2026-09-21, a
// "prolite" plan) reports ONLY the weekly window, in `primary`, with
// `secondary: null` — and a positional read threw "unexpected rateLimits
// shape" on every daemon start, so the heartbeat carried no usage and the
// fleet's weekly cap (CODEX_WEEKLY_CAP_PERCENT) went blind. The weekly
// figure is the one the scheduler gates on, so it is required; the 5-hour
// figure is recorded only, so a reading without that window omits it. Each
// window is { usedPercent, windowDurationMins, resetsAt } with resetsAt in
// EPOCH SECONDS; other fields (credits, planType, ...) are ignored.
const WEEKLY_WINDOW_MINS = 7 * 24 * 60;
const FIVE_HOUR_WINDOW_MINS = 5 * 60;

function toEpochMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value < 1e12 ? value * 1000 : value; // seconds → ms
}

export function parseCodexRateLimits(limits) {
  const windows = [limits?.primary, limits?.secondary].filter(
    (w) => w && typeof w === "object" && typeof w.usedPercent === "number",
  );
  const weekly = windows.find((w) => w.windowDurationMins === WEEKLY_WINDOW_MINS);
  const fiveHour = windows.find((w) => w.windowDurationMins === FIVE_HOUR_WINDOW_MINS);
  if (!weekly) {
    throw new Error(`unexpected rateLimits shape: ${String(JSON.stringify(limits)).slice(0, 200)}`);
  }
  const weeklyResetsAt = toEpochMs(weekly.resetsAt);
  return {
    weeklyUsedPercent: weekly.usedPercent,
    ...(fiveHour ? { fiveHourUsedPercent: fiveHour.usedPercent } : {}),
    ...(weeklyResetsAt !== undefined ? { weeklyResetsAt } : {}),
  };
}

// The flags every turn carries, first turn and resume alike.
//   --json                    events as JSONL on stdout — the whole interface
//   -m <id>                   the model; repeated on EVERY resume because a
//   -c model_reasoning_effort   command-line override suppresses the value
//                             persisted with the thread, so a resume without
//                             them would silently fall back to config.toml
//   --dangerously-bypass-approvals-and-sandbox — see codex-query.mjs's
//                             header: the box is the sandbox; nothing may
//                             park on an approval
//   -c notify=[]              no desktop/hook notifications from a daemon
//   -c shell_environment_policy.inherit=all — the session's shell sees the
//                             (scrubbed) env session.mjs hands it, including
//                             CONVEX_SITE_URL and TTS_WORKER_KEY for the pens
//   --skip-git-repo-check     a repo-"none" session's scratch workdir is not a
//                             git repository, and the check exists to protect
//                             un-versioned edits — a throwaway dir needs none
// No sandbox_workspace_write.* overrides: meaningless under bypass.
function commonArgs({ model, effort }) {
  return [
    "--json",
    ...(model ? ["-m", model] : []),
    ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "-c",
    "notify=[]",
    "-c",
    "shell_environment_policy.inherit=all",
  ];
}

// First turn: `codex exec ... -C <cwd> -`. Later turns: `codex exec resume
// <thread> ... -` — resume has no -C flag (the thread remembers its cwd), so
// the process is spawned WITH cwd = workdir instead, which also covers the
// rebuilt-workdir-after-restart case. The trailing `-` reads the prompt from
// stdin — a prompt in argv would hit the ~128KiB argv cap on a long turn.
export function codexArgs({ threadId, cwd, model, effort }) {
  return threadId
    ? ["exec", "resume", threadId, ...commonArgs({ model, effort }), "-"]
    : ["exec", ...commonArgs({ model, effort }), "-C", cwd, "-"];
}
