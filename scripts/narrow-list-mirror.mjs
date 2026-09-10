// The narrow list's two halves, and the one function that compares them.
//
// convex/ttsShared.ts holds NARROW_LIST — the things an unattended agent does
// not decide and the delegate refuses. Two readers must agree with it:
//   - the delegate, which fetches it over GET /tts/state and renders the
//     `decision` half in its prompt (worker/jobs/delegate.mjs);
//   - the autonomous Bash classifier, which cannot fetch anything and so
//     carries NARROW_LIST_COMMANDS, a literal mirror of the `command` half
//     (worker/session-host/session.mjs).
//
// scripts/check-session-mirrors.mjs calls this on every guardrails run. It
// lives in its own module only so the comparison can be unit-tested without
// running the whole guardrail script, which reads a dozen repo files at
// import time.
//
// Both sides are extracted block-scoped and each block's entry count is
// asserted against the parsed count, the same shape as the repo-map and
// model-table checks: an entry whose form the regex cannot read fails loudly
// instead of vanishing from both sides.

/** The `command` strings of NARROW_LIST in convex/ttsShared.ts, in order. */
export function sharedCommands(sharedText, failures) {
  const block = sharedText.match(/export const NARROW_LIST = \[\r?\n([\s\S]*?)\n\] as const;/);
  if (!block) {
    failures.push("ttsShared.ts: NARROW_LIST not found");
    return null;
  }
  const ids = [...block[1].matchAll(/^\s*id: "([\w-]+)",$/gm)].map((m) => m[1]);
  const commands = [...block[1].matchAll(/^\s*command: "((?:[^"\\]|\\.)*)",$/gm)].map((m) =>
    m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
  );
  if (ids.length !== commands.length) {
    failures.push(
      `ttsShared.ts NARROW_LIST: ${ids.length} id${ids.length === 1 ? "" : "s"} but ${commands.length} command${commands.length === 1 ? "" : "s"} parsed — unreadable entry shape`,
    );
    return null;
  }
  if (commands.length === 0) {
    failures.push("ttsShared.ts NARROW_LIST: no entries parsed — the fence cannot run");
    return null;
  }
  return commands;
}

/** NARROW_LIST_COMMANDS in worker/session-host/session.mjs, in order. */
export function mirrorCommands(sessionText, failures) {
  const block = sessionText.match(/const NARROW_LIST_COMMANDS = \[\r?\n([\s\S]*?)\n\];/);
  if (!block) {
    failures.push("session.mjs: NARROW_LIST_COMMANDS not found");
    return null;
  }
  const lines = block[1].split("\n").filter((line) => line.trim() !== "" && !line.trim().startsWith("//"));
  const commands = [...block[1].matchAll(/^\s*"((?:[^"\\]|\\.)*)",$/gm)].map((m) =>
    m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
  );
  if (lines.length !== commands.length) {
    failures.push(
      `session.mjs NARROW_LIST_COMMANDS: ${lines.length} entr${lines.length === 1 ? "y" : "ies"} but only ${commands.length} parsed — unreadable entry shape`,
    );
    return null;
  }
  return commands;
}

/**
 * The check: the two halves must be equal, in order, byte for byte. A drift
 * means the two readers of Tom's list disagree about what is his.
 * Returns the failure strings; an empty array is a pass.
 */
export function narrowListFailures(sharedText, sessionText) {
  const failures = [];
  const shared = sharedCommands(sharedText, failures);
  const mirror = mirrorCommands(sessionText, failures);
  if (!shared || !mirror) return failures;
  if (shared.length !== mirror.length) {
    failures.push(
      `narrow list drifted: ttsShared.ts has ${shared.length} item${shared.length === 1 ? "" : "s"}, session.mjs's mirror has ${mirror.length}`,
    );
    return failures;
  }
  for (let i = 0; i < shared.length; i += 1) {
    if (shared[i] !== mirror[i]) {
      failures.push(
        `narrow list drifted at item ${i + 1}:\n  ttsShared.ts: "${shared[i]}"\n  session.mjs:  "${mirror[i]}"`,
      );
    }
  }
  return failures;
}
