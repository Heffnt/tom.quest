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
