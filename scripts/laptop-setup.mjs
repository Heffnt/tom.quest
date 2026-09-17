import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

// Codex receives its skill decision from scripts/codex-run.mjs, which also
// writes that exact decision into the run registration. Remove this formerly
// installed SessionStart context hook on the laptop rather than letting a
// second authority add an independent grant block before the launcher runs.
function removeHookConfig(file, command) {
  if (!fs.existsSync(file)) return;
  let settings = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!settings || Array.isArray(settings) || typeof settings !== "object") settings = {};
  if (!settings.hooks || Array.isArray(settings.hooks) || typeof settings.hooks !== "object") settings.hooks = {};

  settings.hooks.SessionStart = withoutManagedHooks(settings.hooks.SessionStart, command);
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

export const RUNS_SWEEP_TASK_NAME = "TTS runs sweep";

/** The path goes into an XML element now, where it did not before: a checkout
 *  under a directory with an `&` in its name would make the document malformed
 *  and `/XML` would refuse it, which the `/TR` form it replaces could not do.
 *  Three characters, because an element's text is all this ever holds. */
function xmlText(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Task Scheduler's own local-time stamp: no zone, no milliseconds. */
function taskTime(at) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/**
 * THE TASK AS A DEFINITION, because `schtasks /Create /SC DAILY` cannot say the
 * one thing this task needs said.
 *
 * WHAT WAS WRONG. The task installed by the flag form last exited 2147946720
 * (0x800710E0, "the operator or administrator has refused the request") — which
 * is not an error from the sweep at all but Task Scheduler reporting that a
 * CONDITION refused to start it. `schtasks /Query /TN "TTS runs sweep" /XML`
 * named the condition: `DisallowStartIfOnBatteries` and `StopIfGoingOnBatteries`
 * both true, which is what the flag form writes and has no flag to turn off. A
 * laptop is on batteries most of the time, so the daily pass simply did not run.
 * Both are false here. There is no `/Create` flag for either, so the definition
 * is written out and handed to `/XML` — the one form that can say it.
 *
 * THE LOGON REQUIREMENT STAYS, and that is not an oversight. The sweep reads
 * Tom's own profile — `%USERPROFILE%\\.tts\\env`, `%USERPROFILE%\\.claude\\projects`
 * and `%LOCALAPPDATA%\\tts\\runs` (worker/runs/config.mjs) — so it is his session
 * or nothing: SYSTEM would read another profile's empty versions, and S4U would
 * need a privilege this machine cannot be assumed to grant. `<Principal>` names
 * no account, so registration uses whoever runs setup, which is the same person.
 *
 * EVERY ELEMENT BELOW IS ONE THIS MACHINE'S OWN SCHEDULER ALREADY WROTE, read
 * back with `schtasks /Query /TN "TTS runs sweep" /XML`. The definition is a
 * strict subset of that export — RegistrationInfo, IdleSettings and the
 * principal's `UserId` are dropped, all three optional, and the last on purpose:
 * a SID is Tom's and this repository is public. Registration uses whoever runs
 * setup, which is the same account the export named.
 *
 * NOTHING ELSE MOVES. The trigger is still daily from the moment setup runs, and
 * the instance policy is still the flag form's. A task that missed its window
 * while the laptop slept still waits for tomorrow — `StartWhenAvailable` would
 * change that, and it is a different condition from the one that refused.
 */
export function runsSweepTaskXml({ sweep, at = new Date() }) {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <Principals>",
    '    <Principal id="Author">',
    "      <LogonType>InteractiveToken</LogonType>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "  </Settings>",
    "  <Triggers>",
    "    <CalendarTrigger>",
    `      <StartBoundary>${taskTime(at)}</StartBoundary>`,
    "      <ScheduleByDay>",
    "        <DaysInterval>1</DaysInterval>",
    "      </ScheduleByDay>",
    "    </CalendarTrigger>",
    "  </Triggers>",
    '  <Actions Context="Author">',
    "    <Exec>",
    "      <Command>node</Command>",
    `      <Arguments>"${xmlText(sweep)}" --full</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

/** The `schtasks` arguments that register that definition. `/F` only when the
 *  task is already there, exactly as the flag form did. */
export function runsSweepTaskArgs({ xmlFile, found, taskName = RUNS_SWEEP_TASK_NAME }) {
  const args = ["/Create", "/TN", taskName, "/XML", xmlFile];
  if (found) args.push("/F");
  return args;
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
  const taskName = RUNS_SWEEP_TASK_NAME;
  const sweep = path.join(tomQuest, "worker", "runs", "sweep.mjs");
  const schtasks = process.env.SCHTASKS_BIN || "schtasks.exe";
  const found = spawnSync(schtasks, ["/Query", "/TN", taskName], { stdio: "ignore" }).status === 0;
  // UTF-16 WITH A BOM, which is what `/XML` reads and what the declaration
  // above claims. A UTF-8 file is accepted by some builds and refused by
  // others, and a refusal here is a task that silently stays as it was.
  const xmlFile = path.join(os.tmpdir(), `tts-runs-sweep-${process.pid}.xml`);
  fs.writeFileSync(xmlFile, `\uFEFF${runsSweepTaskXml({ sweep })}`, "utf16le");
  try {
    const created = spawnSync(schtasks, runsSweepTaskArgs({ xmlFile, found, taskName }), { encoding: "utf8" });
    if (created.status !== 0) throw new Error(`could not install ${taskName} Scheduled Task`);
  } finally {
    fs.rmSync(xmlFile, { force: true });
  }
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

// SETUP RUNS WHEN THIS FILE IS THE PROGRAM, not when it is imported. The two
// builders above are pure and the test reads them directly; without this guard,
// importing them would rewrite the importing machine's CLAUDE.md and hooks.
// Same device as scripts/session-start-hook.mjs and scripts/publish-skills.mjs.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const claudeDir = path.join(home, ".claude");
  updateClaudeMd(path.join(claudeDir, "CLAUDE.md"));
  updateHookConfig(path.join(claudeDir, "settings.json"), hookCommand);
  updateInstructionsLoadedConfig(path.join(claudeDir, "settings.json"), instructionsLoadedCommand);
  removeHookConfig(path.join(home, ".codex", "hooks.json"), hookCommand);
  updateRunHookConfig(path.join(claudeDir, "settings.json"), runHookCommand);
  updateRunHookConfig(path.join(home, ".codex", "hooks.json"), runHookCommand);
  installSkills();
  installRunsSweepTask();
  reportMissingLaptopEnv();
  console.log("bare codex sessions carry no context; use the wrapper or /codex");
}
