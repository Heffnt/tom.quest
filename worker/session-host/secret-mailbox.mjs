// secret-mailbox.mjs — the daemon's half of tom.quest/secrets.
//
// Tom pastes a value on the page; Convex holds it in the secretMailbox table
// (convex/secrets.ts) until this daemon takes it. Each delivery is three
// steps: GET /sessions/secrets lists the waiting values, setEnvLine
// (worker/jobs/worker-env.mjs) writes NAME=value into the env file, and
// POST /sessions/secrets/taken tells Convex to delete the value. A write that
// fails reports nothing, so the value stays waiting and the next check tries
// again; a report that fails leaves the value waiting too, and the next check
// writes the same line again, which changes nothing.
//
// NO VALUE IN A LOG LINE. A line names the variable only. An error's message
// is logged with the value cut out of it, in case some layer ever quotes it.
//
// Dependency-free, with every effect injected, for the reason env-scrub.mjs
// gives: the repo's vitest cannot load lib.mjs, and this is exactly the kind
// of thing a test must fence (__tests__/secret-mailbox.test.mjs).

const NAME = /^[A-Z_][A-Z0-9_]*$/;

// How often the daemon asks. The poll loop runs every 1 to 30 seconds;
// a paste taking up to this long to land costs nothing, a request every
// second would.
export const SECRETS_CHECK_MS = 30_000;

function cut(message, value) {
  const text = String(message ?? "");
  return value ? text.split(value).join("[value]") : text;
}

/**
 * One check of the mailbox. `fetchPending()` answers the GET's body,
 * `write(name, value)` puts the line in the env file, `markTaken(name, setAt)`
 * posts the report. Returns the names written. Never throws.
 */
export async function deliverSecrets({ fetchPending, write, markTaken, log }) {
  let rows;
  try {
    rows = (await fetchPending())?.secrets ?? [];
  } catch (err) {
    log(`secrets: could not read the mailbox: ${err?.status ?? err?.code ?? "error"}`);
    return [];
  }
  const written = [];
  for (const row of rows) {
    const name = typeof row?.name === "string" ? row.name : "";
    if (!NAME.test(name) || typeof row.value !== "string" || typeof row.setAt !== "number") {
      log(`secrets: skipped a malformed mailbox row${NAME.test(name) ? ` (${name})` : ""}`);
      continue;
    }
    try {
      write(name, row.value);
    } catch (err) {
      log(`secrets: ${name} not written to the env file: ${cut(err?.message ?? err, row.value)}`);
      continue;
    }
    written.push(name);
    try {
      await markTaken(name, row.setAt);
      log(`secrets: ${name} written to the env file`);
    } catch (err) {
      // 409: Tom set a newer value mid-delivery; the next check writes it.
      log(`secrets: ${name} written; the taken report failed (${err?.status ?? "error"}), the next check repeats it`);
    }
  }
  return written;
}

/**
 * Remove `names` from `target` (the daemon's process.env at start). systemd
 * loads the whole env file into the daemon's environment, and every child
 * the daemon starts inherits it, so a mailbox name left there would reach an
 * agent's shell. Removing them before the first spawn keeps them out of all.
 */
export function dropNames(target, names) {
  for (const name of names) delete target[name];
}
