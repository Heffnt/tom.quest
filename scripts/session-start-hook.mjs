// Claude Code SessionStart hook: refresh WikiTom when possible, then provide
// the map, the operate rules, the write layer and the FETCHABLE index — and no
// know layer at all. Session startup must stay available while offline.
//
// Before the dynamic-context round this sent the write layer alone (10.5 KB)
// and relied on ~/.claude/CLAUDE.md importing agent-rules.md (written by
// scripts/laptop-setup.mjs) for the map. Now the hook carries the map itself
// and the import is belt-and-braces — laptop-setup.mjs is deliberately left
// alone: a duplicated agent-rules.md in a laptop session costs 6.5 KB and Tom
// is present to see it, which is the case the duplication protects.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assemblePrelude } from "./prelude.mjs";

const wikitom = process.env.WIKITOM_DIR
  || (process.platform === "win32" ? "C:/Users/heffn/Desktop/WikiTom" : "/root/wikitom");

function oneLine(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

// A session start WAITS for this hook, so the refresh is capped: a slow fetch
// (one laptop session spent two minutes here) is killed and skipped, and the
// session goes on with whatever local HEAD WikiTom already has.
export const PULL_TIMEOUT_MS = 15_000;

/** Fast-forward WikiTom when it is present, reachable and quick. Never throws. */
export function pullWikiTom(dir, run = execFileSync) {
  if (!existsSync(dir)) return false;
  try {
    run("git", ["-C", dir, "pull", "--ff-only", "--quiet"], {
      stdio: "ignore",
      timeout: PULL_TIMEOUT_MS,
    });
    return true;
  } catch {
    // Offline, slow, or a divergent checkout still has a usable local HEAD.
    return false;
  }
}

function main() {
  // Hooks can send their event JSON on stdin. This hook intentionally has no
  // event-specific behavior, but draining stdin keeps that protocol harmless.
  process.stdin.resume();

  pullWikiTom(wikitom);

  // Built in two independent steps, so a failure in the fetchable half does not
  // lose the prefix. The stable prefix is what a laptop session cannot work
  // without; the index of what it could fetch is worth having and worth losing.
  let additionalContext;
  try {
    additionalContext = assemblePrelude({ wikitom, for: "laptop" }).text;
  } catch (error) {
    const reason = oneLine(error?.message ?? error);
    try {
      additionalContext = `${assemblePrelude({ wikitom, layers: "operate,write" }).text}\n\nfetchable index could not be built: ${reason}`;
    } catch (prefixError) {
      additionalContext = `model-of-tom context could not be loaded: ${oneLine(prefixError?.message ?? prefixError)}`;
    }
  }

  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  })}\n`);
}

// Run as a hook, never on import: the test imports this file to check the pull
// (instructions-loaded-hook.mjs guards itself the same way, for the same
// reason). Every caller — laptop-setup.mjs and the box — names the interpreter.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
