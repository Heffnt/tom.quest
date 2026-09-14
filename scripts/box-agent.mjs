// box-agent.mjs — the laptop half of the box transport.
//
// THIS FILE IS A PIPE. It resolves the laptop session's run id, builds one ssh
// command line, and relays what comes back byte for byte. It prints no
// summary, adds no caveat, parses nothing the box said, and knows nothing
// about the work. Every flag it takes belongs to worker/runs/box-run.mjs and
// is passed through unaltered.
//
// It is the one place in the repo that knows the shape of the remote command
// line, exactly as scripts/codex-run.mjs is the one place that knows the shape
// of `codex exec`. The `box` subagent (.claude/agents/box.md) and the `codex`
// subagent both reach the box through here.
//
// Usage:
//   node scripts/box-agent.mjs [box-run flags] < prompt.txt
//
// Environment seams, all optional:
//   TTS_BOX_HOST   the box's address        (default: 2.29.9.100)
//   TTS_BOX_USER   the ssh user             (default: root)
//   TTS_BOX_KEY    the identity file        (default: ~/.ssh/jarvis)
//   TTS_SSH_BIN    the ssh binary           (default: ssh on PATH)
//   TTS_BOX_CMD    the remote command       (default: tts-run)
//
// The user and key are seams so that a restricted box user is a ONE-LINE
// change when Tom places one. Creating that user, its key, or a forced command
// is his to do, not this file's.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The pointer's path has ONE home, in the hook that writes it. Recomputing the
// cwd hash here would make a second home, and the two would drift the first
// time either side changed how a directory is keyed.
import { currentRunPointerPath, stateDirectory } from "./run-hook.mjs";

const DEFAULT_HOST = "2.29.9.100";
const DEFAULT_USER = "root";
const DEFAULT_COMMAND = "tts-run";

/** How old a current-run pointer may be and still name this session. Two
 * sessions in one directory make the newer one overwrite the older's pointer,
 * so a stale pointer is the failure this window closes: past a day the file is
 * more likely to describe a session that ended than the one now running. */
const POINTER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The laptop session's run id, from the pointer scripts/run-hook.mjs writes at
 * SessionStart, keyed by the cwd the session runs in.
 *
 * NEVER INFER A PARENT from a directory listing, the newest run file, or a
 * timestamp. A wrong edge puts a run under a session that did not start it,
 * and the sessions view would show Tom a tree that is not what happened. A
 * missing edge only loses a line; that is the cheaper failure.
 */
export function currentParent({ cwd = process.cwd(), env = process.env, now = Date.now() } = {}) {
  const file = currentRunPointerPath(stateDirectory(env), cwd);
  let pointer;
  try {
    pointer = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ok: false, why: "no current laptop run" };
  }
  if (typeof pointer?.runId !== "string" || pointer.runId === "") {
    return { ok: false, why: "the current-run pointer names no run" };
  }
  if (!Number.isFinite(pointer?.at) || now - pointer.at > POINTER_MAX_AGE_MS) {
    return { ok: false, why: "the current-run pointer is stale" };
  }
  const rootRunId = typeof pointer.rootRunId === "string" && pointer.rootRunId !== "" ? pointer.rootRunId : pointer.runId;
  const depth = Number.isInteger(pointer.depth) ? pointer.depth : 0;
  return { ok: true, runId: pointer.runId, rootRunId, depth };
}

/** POSIX single-quoting for one argument of the remote command line. The box
 * runs the whole string through its login shell, so an unquoted branch name or
 * model id with a shell metacharacter in it would be the shell's, not
 * box-run.mjs's. */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function buildArgs({ passthrough, parent, env = process.env }) {
  const host = env.TTS_BOX_HOST || DEFAULT_HOST;
  const user = env.TTS_BOX_USER || DEFAULT_USER;
  const key = env.TTS_BOX_KEY || path.join(env.USERPROFILE || env.HOME || "", ".ssh", "jarvis");
  const command = env.TTS_BOX_CMD || DEFAULT_COMMAND;
  const remote = [
    command,
    ...passthrough.map(shellQuote),
    ...(parent.ok
      ? ["--parent", shellQuote(parent.runId), "--root", shellQuote(parent.rootRunId), "--depth", shellQuote(parent.depth + 1)]
      : []),
  ].join(" ");
  return [
    // BatchMode: never prompt for a passphrase — a prompt on a background Bash
    // call hangs the run forever with nothing on stdout to say why.
    "-o", "BatchMode=yes",
    // A box run has no time limit, so the connection must survive a long quiet
    // stretch: a keepalive every 30 s, and six missed before ssh gives up.
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=6",
    "-i", key,
    `${user}@${host}`,
    remote,
  ];
}

function main() {
  const passthrough = process.argv.slice(2);
  const parent = currentParent();
  if (!parent.ok) {
    process.stderr.write(`box-agent: ${parent.why}; this box run is recorded as a root\n`);
  }
  const args = buildArgs({ passthrough, parent });
  const bin = process.env.TTS_SSH_BIN || "ssh";
  // Windows OpenSSH is ssh.exe and spawns directly, so this is normally false.
  // A .cmd shim only runs through cmd.exe (Node refuses it with EINVAL
  // otherwise), which is what the TTS_SSH_BIN seam points at under test. The
  // remote string is one argument either way; cmd.exe sees it double-quoted and
  // the box's own shell sees the single quotes buildArgs put there.
  const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
  const quote = (s) => (useShell ? `"${String(s).replace(/\\(?=")/g, "\\\\").replace(/"/g, '""')}"` : s);
  const child = spawn(useShell ? quote(bin) : bin, args.map(quote), {
    stdio: ["pipe", "inherit", "inherit"],
    shell: useShell,
    windowsHide: true,
  });
  process.stdin.pipe(child.stdin);
  child.stdin.on("error", () => {});
  child.on("error", (error) => {
    process.stderr.write(`box-agent: could not start ${bin}: ${error.message}\n`);
    process.exit(255);
  });
  child.on("close", (code) => {
    // ssh RETURNS 255 FOR ITS OWN TRANSPORT FAILURE — connection refused, host
    // key trouble, auth refused. box-run.mjs never exits 255, so a reader can
    // always tell "the box refused the work" (2, 75, or the CLI's own code)
    // from "the ssh did not get there" (255).
    process.exit(code ?? 255);
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
