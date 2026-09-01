// Guardrail: worker/setup.sh enables the tts-session-host daemon ONLY when
// SESSIONS_WORKER_KEY is already non-empty in /etc/tts/worker.env, and the
// rebuild procedure in worker/README.md runs setup.sh BEFORE the step that
// fills that file. So the procedure is only correct while it also tells you to
// run setup.sh a second time afterwards; without that line, following the
// README verbatim leaves the daemon installed but permanently disabled and no
// tom.quest session is ever claimed.
//
// This check fails when the two sides drift apart in either direction: the
// gate exists but the README dropped the re-run, or the gate is gone and the
// README still teaches a step that no longer does anything.
import { readFileSync } from "node:fs";

const setup = readFileSync("worker/setup.sh", "utf8");
const readme = readFileSync("worker/README.md", "utf8");

const failures = [];

// 1. Does setup.sh still gate the enable on the key being present?
const gated =
  /if\s+grep\s+-Eq\s+'\^SESSIONS_WORKER_KEY=\.\+'\s+\/etc\/tts\/worker\.env;\s*then\s*\n\s*systemctl enable tts-session-host/.test(
    setup,
  );

// 2. The fenced code block under "## Rebuild from scratch" — the procedure a
//    human follows line by line.
const rebuild = readme.match(/## Rebuild from scratch\s*\n+```\n([\s\S]*?)\n```/);
if (!rebuild) {
  failures.push(
    'worker/README.md: no fenced code block under "## Rebuild from scratch" — the ' +
      "rebuild procedure this check fences could not be located",
  );
} else {
  const lines = rebuild[1].split("\n");
  const envStep = lines.findIndex((l) => /nano\s+\/etc\/tts\/worker\.env/.test(l));
  const setupRuns = lines
    .map((l, i) => (/setup\.sh/.test(l) ? i : -1))
    .filter((i) => i >= 0);
  const rerunsAfterEnv = envStep >= 0 && setupRuns.some((i) => i > envStep);

  if (envStep < 0) {
    failures.push(
      "worker/README.md rebuild block: no `nano /etc/tts/worker.env` step — this " +
        "check cannot tell whether the session-host re-run is in the right place",
    );
  } else if (gated && !rerunsAfterEnv) {
    failures.push(
      "worker/README.md rebuild block: setup.sh enables tts-session-host only when " +
        "SESSIONS_WORKER_KEY is already set, but the block never runs setup.sh again " +
        "after the `nano /etc/tts/worker.env` step — following it verbatim leaves the " +
        "session daemon permanently disabled",
    );
  } else if (!gated && rerunsAfterEnv) {
    failures.push(
      "worker/setup.sh no longer gates `systemctl enable tts-session-host` on " +
        "SESSIONS_WORKER_KEY, so the second setup.sh run in the worker/README.md " +
        "rebuild block is now teaching a step that does nothing — update the README",
    );
  }
}

if (failures.length > 0) {
  console.error("check-worker-rebuild-doc: FAILED\n");
  for (const f of failures) console.error(`  - ${f}`);
  console.error("");
  process.exit(1);
}

console.log("check-worker-rebuild-doc: ok");
