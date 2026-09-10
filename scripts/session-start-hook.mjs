// Claude Code SessionStart hook: refresh WikiTom when possible, then provide
// only the write layer. Session startup must stay available while offline.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { assemblePrelude } from "./prelude.mjs";

const wikitom = process.env.WIKITOM_DIR
  || (process.platform === "win32" ? "C:/Users/heffn/Desktop/WikiTom" : "/root/wikitom");

// Hooks can send their event JSON on stdin. This hook intentionally has no
// event-specific behavior, but draining stdin keeps that protocol harmless.
process.stdin.resume();

function oneLine(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

if (existsSync(wikitom)) {
  try {
    execFileSync("git", ["-C", wikitom, "pull", "--ff-only", "--quiet"], {
      stdio: "ignore",
    });
  } catch {
    // Offline or a divergent checkout still has a usable local HEAD.
  }
}

let additionalContext;
try {
  additionalContext = assemblePrelude({ wikitom, layers: "write" }).text;
} catch (error) {
  additionalContext = `write layer could not be loaded: ${oneLine(error?.message ?? error)}`;
}

process.stdout.write(`${JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext,
  },
})}\n`);
