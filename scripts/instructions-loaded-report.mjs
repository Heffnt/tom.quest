// Daily laptop InstructionsLoaded audit. The hook launches this detached so its
// NO SHEBANG LINE, for nightly.mjs's reason (worker/jobs/write-slack.mjs says
// it too): this file is imported by its own test, and the test bundler
// rewrites an imported module by prepending an import — which lands in front
// of a shebang and fails to parse. Every caller already names the interpreter.
// own hot path stays a local append rather than a network request.

import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import {
  REPO_ROOTS,
  rollUp,
  sessionsMissingProjectAgents,
  sessionsMissingWikiTom,
} from "./instructions-loaded-hook.mjs";

export { REPO_ROOTS, sessionsMissingProjectAgents, sessionsMissingWikiTom };

function yesterdayUtc(now = new Date()) {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function parseArgs(argv) {
  let day = yesterdayUtc();
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--dry-run") dryRun = true;
    else if (argv[index] === "--day") day = argv[++index] ?? "";
    else throw new Error(`unknown argument ${argv[index]}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("--day must be YYYY-MM-DD");
  return { day, dryRun };
}

async function main() {
  const { day, dryRun } = parseArgs(process.argv.slice(2));
  // os.homedir(), not HOME/USERPROFILE: the hook writes the log at
  // os.homedir() (scripts/instructions-loaded-hook.mjs), and under git bash the
  // two differ — a report built from HOME reads a path that never exists.
  const logPath = path.join(os.homedir(), ".claude", "evals", "instructions-loaded.jsonl");
  if (dryRun) {
    const payload = await rollUp(logPath, day);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const site = process.env.CONVEX_SITE_URL;
  const key = process.env.TTS_WORKER_KEY;
  if (!site || !key) {
    console.error("instructions-loaded-report: CONVEX_SITE_URL and TTS_WORKER_KEY must be set (this report posts the laptop audit to prod Convex; it is not a CI gate).");
    process.exit(2);
  }
  const payload = await rollUp(logPath, day, async (event) => {
    const response = await fetch(`${site.replace(/\/+$/, "")}/tts/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-TTS-Key": key },
      body: JSON.stringify(event),
    });
    if (!response.ok) throw new Error(`/tts/event -> HTTP ${response.status}`);
  });
  console.log(`instructions-loaded-report: posted ${payload.key}`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`instructions-loaded-report: ${error.message}`);
    process.exit(2);
  });
}
