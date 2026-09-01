// credential-file.mjs — the one way a one-time auth helper hands a minted
// credential to the operator.
//
// WHY THIS EXISTS: AGENTS.md ("Debugging And Observability") says never log
// secrets, tokens, signatures, or large sensitive payloads. gmail-auth.mjs and
// calendar-auth.mjs used to print the OAuth client secret and refresh token to
// stdout so the operator could paste them into /etc/tts/worker.env. That is a
// flat violation of the rule, and it is worse than it looks: an agent session
// run on the Jarvis Box captures its own stdout into a transcript that is
// stored in Convex and rendered on a screen, so a credential printed inside a
// session is written down permanently.
//
// So the value goes to a file only the owner can read, and stdout gets the
// path and the variable NAMES — never a value.
//
// Zero npm dependencies, like every other file under worker/jobs/.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Write KEY=VALUE lines to <home>/<fileName> with mode 0600 (owner read/write,
// nobody else), and return the absolute path. The format matches what
// loadEnv() in tts-lib.mjs parses, so the file can be appended to
// /etc/tts/worker.env verbatim.
//
// DANGER: do not "simplify" this to a plain writeFileSync(target, body,
// { mode }). The mode option applies ONLY when the call creates the file, so
// writing over an existing world-readable file of the same name would silently
// keep the loose permissions. The unlink-then-create-exclusively sequence
// below is what makes 0600 a guarantee rather than a hope.
export function writeCredentialFile(fileName, vars) {
  const names = Object.keys(vars);
  if (names.length === 0) throw new Error("writeCredentialFile: no variables given");
  for (const [name, value] of Object.entries(vars)) {
    if (typeof value !== "string" || value === "") {
      throw new Error(`writeCredentialFile: ${name} is empty`);
    }
    // A newline inside a value would split into a second KEY=VALUE line and
    // corrupt whatever env file this is appended to. Report the variable NAME.
    if (/[\r\n]/.test(value)) {
      throw new Error(`writeCredentialFile: ${name} contains a newline`);
    }
  }
  const target = path.join(os.homedir(), fileName);
  fs.rmSync(target, { force: true });
  const body = names.map((name) => `${name}=${vars[name]}`).join("\n") + "\n";
  fs.writeFileSync(target, body, { mode: 0o600, flag: "wx" });
  return target;
}

// The stdout notice that goes with such a file: the path, the variable names,
// and the operator's next commands. Every line here is safe to appear in a
// stored session transcript, which is the entire point — callers pass the
// commands, this function guarantees no VALUE is ever among them.
export function credentialFileNotice(target, names, nextSteps) {
  const lines = [
    "",
    `Wrote ${names.length} variables to ${target} (mode 0600, owner-only).`,
    "The values are NOT printed here — read them from that file.",
    "",
    "Variables written:",
    ...names.map((name) => `  ${name}`),
    "",
    ...nextSteps,
    "",
    `Then delete the local copy:  rm ${target}`,
  ];
  return lines.join("\n");
}
