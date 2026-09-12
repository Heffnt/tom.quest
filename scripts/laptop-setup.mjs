import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { refreshSkills } from "./session-start-hook.mjs";

const home = path.resolve(process.env.HOME || process.env.USERPROFILE || os.homedir());
const wikiTom = path.resolve(
  process.env.WIKITOM_DIR || (process.platform === "win32" ? "C:/Users/heffn/Desktop/WikiTom" : "/root/wikitom"),
);
const tomQuest = path.resolve(
  process.env.TOM_QUEST_DIR || (process.platform === "win32" ? "C:/Users/heffn/Desktop/tom.quest" : "/root/tom.quest"),
);

const rulesImport = `@${path.join(wikiTom, "model-of-tom", "agent-rules.md").replaceAll("\\", "/")}`;
const hookCommand = `node ${path.join(tomQuest, "scripts", "session-start-hook.mjs")}`;
const instructionsLoadedCommand = `node ${path.join(tomQuest, "scripts", "instructions-loaded-hook.mjs")}`;
const runHookCommand = `node ${path.join(tomQuest, "scripts", "run-hook.mjs")}`;
const RUN_EVENTS = ["SessionStart", "SubagentStart", "Stop", "SessionEnd", "SubagentStop"];

function writeIfChanged(file, contents) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
  if (current === contents) {
    console.log(`unchanged ${file}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  console.log(`changed ${file}`);
}

function updateClaudeMd(file) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const lines = current.split(/\r?\n/);
  const hasFirstLineRulesImport = /^@.+[\\/]model-of-tom[\\/]agent-rules\.md\s*$/.test(lines[0]);
  const remainder = hasFirstLineRulesImport ? lines.slice(1).join(newline) : current;
  const next = hasFirstLineRulesImport
    ? `${rulesImport}${newline}${remainder}`
    : `${rulesImport}${newline}${newline}${remainder}`;
  writeIfChanged(file, next);
}

function isLegacyWikiTomHook(hook) {
  return typeof hook?.command === "string" && /\bcat\s+.*[\\/]WikiTom[\\/]AGENTS\.md\b/i.test(hook.command);
}

function managedScript(command) {
  const match = /(?:^|[\\/])((?:session-start-hook|instructions-loaded-hook|run-hook)\.mjs)(?:["']|\s|$)/i.exec(
    String(command ?? ""),
  );
  return match?.[1]?.toLowerCase();
}

function isManagedHook(hook, command) {
  const expectedScript = managedScript(command);
  return typeof hook?.command === "string"
    && (hook.command === command || (expectedScript && managedScript(hook.command) === expectedScript));
}

function withoutManagedHooks(entries, command) {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [entry];
    if (isLegacyWikiTomHook(entry) || isManagedHook(entry, command)) return [];
    if (!Array.isArray(entry.hooks)) return [entry];

    const hooks = entry.hooks.filter(
      (hook) => !isLegacyWikiTomHook(hook) && !isManagedHook(hook, command),
    );
    return hooks.length === 0 ? [] : [{ ...entry, hooks }];
  });
}

function updateHookConfig(file, command) {
  let settings = {};
  if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!settings || Array.isArray(settings) || typeof settings !== "object") settings = {};
  if (!settings.hooks || Array.isArray(settings.hooks) || typeof settings.hooks !== "object") settings.hooks = {};

  const sessionStart = withoutManagedHooks(settings.hooks.SessionStart, command);
  sessionStart.push({
    matcher: "startup|resume|compact",
    hooks: [{ type: "command", command }],
  });
  settings.hooks.SessionStart = sessionStart;
  writeIfChanged(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function updateInstructionsLoadedConfig(file, command) {
  let settings = {};
  if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!settings || Array.isArray(settings) || typeof settings !== "object") settings = {};
  if (!settings.hooks || Array.isArray(settings.hooks) || typeof settings.hooks !== "object") settings.hooks = {};

  const instructionsLoaded = withoutManagedHooks(settings.hooks.InstructionsLoaded, command);
  instructionsLoaded.push({
    matcher: "session_start|include|nested_traversal|path_glob_match|compact",
    hooks: [{ type: "command", command, timeout: 5 }],
  });
  settings.hooks.InstructionsLoaded = instructionsLoaded;
  writeIfChanged(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function updateRunHookConfig(file, command) {
  let settings = {};
  if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!settings || Array.isArray(settings) || typeof settings !== "object") settings = {};
  if (!settings.hooks || Array.isArray(settings.hooks) || typeof settings.hooks !== "object") settings.hooks = {};

  for (const event of RUN_EVENTS) {
    const entries = withoutManagedHooks(settings.hooks[event], command);
    entries.push({
      ...(event === "SessionStart" ? { matcher: "startup|resume|compact" } : {}),
      hooks: [{ type: "command", command, timeout: 5 }],
    });
    settings.hooks[event] = entries;
  }
  writeIfChanged(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function installRunsSweepTask() {
  if (process.platform !== "win32") {
    console.log("skipped TTS runs sweep Scheduled Task (Windows only)");
    return;
  }
  if (process.env.TTS_SKIP_RUNS_TASK === "1") {
    console.log("skipped TTS runs sweep Scheduled Task (TTS_SKIP_RUNS_TASK=1)");
    return;
  }
  const taskName = "TTS runs sweep";
  const sweep = path.join(tomQuest, "worker", "runs", "sweep.mjs");
  const schtasks = process.env.SCHTASKS_BIN || "schtasks.exe";
  const found = spawnSync(schtasks, ["/Query", "/TN", taskName], { stdio: "ignore" }).status === 0;
  const args = ["/Create", "/SC", "DAILY", "/TN", taskName, "/TR", `node "${sweep}" --full`];
  if (found) args.push("/F");
  const created = spawnSync(schtasks, args, { encoding: "utf8" });
  if (created.status !== 0) throw new Error(`could not install ${taskName} Scheduled Task`);
  console.log(`${found ? "updated" : "created"} ${taskName} Scheduled Task`);
}

/**
 * THE ONE-TIME INSTALL of the two skills directories, beside the hooks above.
 *
 * The SessionStart hook refreshes them on EVERY session; this is what puts them
 * there before the first one runs. It is the hook's own call, imported rather
 * than restated, so where they go and what goes in them has ONE definition and
 * the install cannot drift from the refresh.
 *
 * NOTHING HERE DELETES ANYTHING OF TOM'S OR THE LAPTOP'S. publish-skills.mjs
 * owns the deletion rule and it is narrow — only a `tom-` directory this build
 * did not produce — so a checkout's own skills sitting beside them are left
 * exactly alone.
 *
 * A directory that cannot be published costs ONE LINE and the rest of setup
 * still runs: the catalog is refreshed again at every session start, while the
 * hooks and the rules import below are what a laptop cannot work without.
 */
function installSkills() {
  let results;
  try {
    results = refreshSkills({ wikitom: wikiTom });
  } catch (error) {
    console.log(`could not publish skills: ${String(error?.message ?? error).replace(/\s+/g, " ").trim()}`);
    return;
  }
  for (const result of results) {
    if (!result.ok) {
      console.log(`could not publish skills to ${result.dir}: ${result.why}`);
      continue;
    }
    console.log(
      `${result.changed ? "changed" : "unchanged"} ${result.dir} (${result.skills} skills at ${result.commit.slice(0, 12)})`,
    );
  }
}

function reportMissingLaptopEnv() {
  const file = path.join(home, ".tts", "env");
  if (!fs.existsSync(file)) {
    console.log(`missing ${file}: requires RUN_HOST, RUN_STORE_BACKEND, RUN_STORE_ENDPOINT, RUN_STORE_BUCKET, RUN_STORE_REGION, RUN_STORE_FORCE_PATH_STYLE, RUN_STORE_WRITE_KEY_ID, RUN_STORE_WRITE_SECRET, RUN_STORE_READ_KEY_ID, RUN_STORE_READ_SECRET, CONVEX_SITE_URL, SESSIONS_WORKER_KEY, TTS_WORKER_KEY`);
  }
}

const claudeDir = path.join(home, ".claude");
updateClaudeMd(path.join(claudeDir, "CLAUDE.md"));
updateHookConfig(path.join(claudeDir, "settings.json"), hookCommand);
updateInstructionsLoadedConfig(path.join(claudeDir, "settings.json"), instructionsLoadedCommand);
updateHookConfig(path.join(home, ".codex", "hooks.json"), hookCommand);
updateRunHookConfig(path.join(claudeDir, "settings.json"), runHookCommand);
updateRunHookConfig(path.join(home, ".codex", "hooks.json"), runHookCommand);
installSkills();
installRunsSweepTask();
reportMissingLaptopEnv();
