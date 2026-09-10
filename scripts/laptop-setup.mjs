import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

function isManagedHook(hook, command) {
  return typeof hook?.command === "string" && hook.command === command;
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

const claudeDir = path.join(home, ".claude");
updateClaudeMd(path.join(claudeDir, "CLAUDE.md"));
updateHookConfig(path.join(claudeDir, "settings.json"), hookCommand);
updateInstructionsLoadedConfig(path.join(claudeDir, "settings.json"), instructionsLoadedCommand);
updateHookConfig(path.join(home, ".codex", "hooks.json"), hookCommand);
