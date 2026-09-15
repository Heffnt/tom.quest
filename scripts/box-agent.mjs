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
// ON THE BOX IT SENDS NOTHING ANYWHERE. This file is reached from a tom.quest
// checkout, and the box holds one at /root/tom.quest and another in every
// worktree box-run.mjs makes — so "run this when the file exists", which is
// what .claude/agents/codex.md and .claude/agents/box.md tell a literal-minded
// relay, is true on the box as well. Sending the run over ssh from there is
// the box connecting to itself with a key it does not hold: ssh answers 255
// and no run starts, which is how a nested `box` or `codex` agent inside a box
// run would lose its runner. When RUN_HOST says box, the command runs here.
//
// Environment seams, read from the environment or from the env file
// worker/runs/config.mjs picks for this host (~/.tts/env on the laptop):
//   TTS_BOX_HOST   the box's address        (REQUIRED off the box; no default)
//   TTS_BOX_USER   the ssh user             (default: root)
//   TTS_BOX_KEY    the identity file        (default: ~/.ssh/jarvis)
//   TTS_SSH_BIN    the ssh binary           (default: ssh on PATH)
//   TTS_BOX_CMD    the remote command       (default: tts-run)
//
// THE ADDRESS HAS NO DEFAULT BECAUSE THIS REPOSITORY IS PUBLIC. It is one
// machine of Tom's, and the rest of the repo already writes it as a
// placeholder (`root@<jarvis-box>`, `root@<this box>`). With it unset this
// file refuses and names the variable; it does not guess.
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
// The env file has ONE reader (worker/jobs/worker-env.mjs) and one resolver
// over it. The ssh target is named in that file, so it is read through the
// resolver rather than by a second parser here.
import { runConfig } from "../worker/runs/config.mjs";

/** How old a current-run pointer may be and still name this session. Two
 * sessions in one directory make the newer one overwrite the older's pointer,
 * so a stale pointer is the failure this window closes: past a day the file is
 * more likely to describe a session that ended than the one now running.
 *
 * REMOVAL CHECK: the pointer is already deleted rather than guarded — the
 * SessionEnd branch of scripts/run-hook.mjs removes it — and this window is
 * what covers the case that deletion cannot reach. A session killed with its
 * terminal, a crashed CLI and a machine that slept through its own shutdown
 * all leave the file behind with no SessionEnd ever fired, and a run parented
 * to a session that ended days ago is the wrong-edge failure currentParent()
 * exists to refuse. Deleting the check would mean trusting a hook that by
 * construction does not always run. */
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

/** The run's own flags plus the parent edge, in the order box-run.mjs reads
 * them. One list, used raw on the box and quoted through ssh off it. */
function runArgs({ passthrough, parent }) {
  return [
    ...passthrough,
    ...(parent.ok ? ["--parent", parent.runId, "--root", parent.rootRunId, "--depth", String(parent.depth + 1)] : []),
  ];
}

export function buildArgs({ passthrough, parent, env = process.env, config = runConfig({ env }) }) {
  const host = env.TTS_BOX_HOST || config.box.host;
  if (!host) {
    throw new Error(
      `no box address: set TTS_BOX_HOST in the environment or in ${config.envFile ?? "the env file (~/.tts/env on the laptop)"}`,
    );
  }
  const user = env.TTS_BOX_USER || config.box.user;
  const key = env.TTS_BOX_KEY || config.box.key || path.join(env.USERPROFILE || env.HOME || "", ".ssh", "jarvis");
  const command = env.TTS_BOX_CMD || config.box.command;
  const remote = [command, ...runArgs({ passthrough, parent }).map(shellQuote)].join(" ");
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
  const config = runConfig();
  // ALREADY ON THE BOX: run the command, do not send it. Nothing is quoted,
  // because no shell is between this process and box-run.mjs.
  const onBox = config.host === "box";
  let args;
  let bin;
  if (onBox) {
    args = runArgs({ passthrough, parent });
    bin = process.env.TTS_BOX_CMD || config.box.command;
  } else {
    try {
      args = buildArgs({ passthrough, parent, config });
    } catch (error) {
      process.stderr.write(`box-agent: ${error.message}; no run was started\n`);
      process.exit(255);
      return;
    }
    bin = process.env.TTS_SSH_BIN || "ssh";
  }
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
    // 255 MEANS NO RUN STARTED — ssh's own code for connection refused, host
    // key trouble or auth refused, and this file's code for a missing box
    // address or a transport that would not start. box-run.mjs never exits
    // 255, so a reader can always tell "the box refused the work" (2, 75, or
    // the CLI's own code) from "the work never got there" (255).
    process.exit(code ?? 255);
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
