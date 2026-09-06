#!/usr/bin/env node
// poll-outlook.mjs — the SKELETON of the Outlook mail poller (Tom,
// 2026-08-25: "outlook is where the most important mail comes in"). The
// lifeos update, phase 6.
//
// WHY THIS FILE EXISTS AS A SKELETON. Everything below the credential check
// needs a real Microsoft Graph token to be written honestly — the shape of a
// message list, what a delta cursor looks like, which folder "inbox" is on
// Tom's WPI tenant — and that credential is a Tom step that has not happened.
// Untested network code that can never be exercised is worse than an empty
// hand, so the fetch half lands in the SAME change as the credential, together
// with the cron line that is commented out in worker/setup.sh today. What is
// here now is what can be settled without the token: the credential contract,
// the cursor's home, and the two strings a later reader depends on.
//
// WHAT IT WILL DO, and it is poll-gmail's shape exactly (worker/jobs/
// poll-gmail.mjs — read that file first, this one follows it):
//   1. list inbox mail newer than the cursor;
//   2. ONE headless Claude call per batch making the two capture judgements
//      against the deployment's own rules (GET /tts/capture-context): does
//      this imply an action by Tom, and does it need him TODAY;
//   3. POST /tts/capture for each action-implying message, source "outlook",
//      provenance `outlook:message:<id> <web link>`;
//   4. POST /tts/needs-tom for each one that needs him today, keyed on
//      `outlook:message:<id>` so one mail opens one #tts thread for ever.
//
// CREDENTIALS (all three in /etc/tts/worker.env; the job is a quiet no-op
// until they exist — the same ships-ahead-of-the-credential posture as
// poll-gmail and poll-canvas):
//   OUTLOOK_CLIENT_ID / OUTLOOK_CLIENT_SECRET — an Entra ID (Azure AD) app
//       registration in Tom's tenant with the delegated Microsoft Graph
//       permission Mail.Read, plus offline_access so a refresh token can be
//       minted at all.
//   OUTLOOK_REFRESH_TOKEN — minted ONCE by Tom on his own machine, because
//       approving it needs a browser. It is the same one-time shape as
//       worker/jobs/gmail-auth.mjs, and the minting helper lands with the
//       fetch half; like that one it will write the three KEY=VALUE lines to
//       an owner-only file and print only the path (AGENTS.md: never log
//       secrets, no exemption for one-time credential helpers).
// Read-only by construction: Mail.Read and nothing else, so a leaked token
// cannot send mail as Tom.
//
// STATE: /var/lib/tts/outlook-cursor, the same one-integer format as
// /var/lib/tts/gmail-cursor — the epoch ms of the newest PROCESSED message.
// Losing it re-examines the last 24 hours, at worst re-capturing a few mails
// as duplicate todos Tom can archive, and CANNOT re-open a #tts thread: the
// thread is deduped server-side on the message id, not on this file.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { declined, declinedLine, loadEnv, ttsItemLink } from "./tts-lib.mjs";

export const CURSOR_FILE = "/var/lib/tts/outlook-cursor";
export const FIRST_RUN_LOOKBACK_MS = 24 * 3600 * 1000;

/** The three keys this job cannot run without. Named once, here. */
export const OUTLOOK_KEYS = [
  "OUTLOOK_CLIENT_ID",
  "OUTLOOK_CLIENT_SECRET",
  "OUTLOOK_REFRESH_TOKEN",
];

/**
 * Pure: the STABLE SOURCE ID of one Outlook message — the id first, then the
 * link, the same "id + link" shape poll-gmail writes for mail, poll-canvas for
 * announcements and convex/ttsCanvas.ts for assignments. The id leads so a
 * reader can tell the producers apart by eye and a machine can key on the
 * message without parsing a URL. Exported for tests.
 */
export function messageSourceId(id) {
  return `outlook:message:${id}`;
}
export function messageProvenance(id, webLink) {
  const source = messageSourceId(id);
  return webLink ? `${source} ${webLink}` : source;
}

/**
 * Pure: the ONE line a #tts thread opens with — who it is from, what it is
 * about, and where the todo is. Identical in shape to poll-gmail's, because it
 * is the same message: one thread in #tts whose reply is the next turn.
 * Exported for tests.
 */
export function needsTomLine(from, subject, todoId) {
  return `Needs you today — ${from}: ${subject}\n${ttsItemLink(todoId)}`;
}

/** The keys of OUTLOOK_KEYS that `env` does not have. Exported for tests. */
export function missingKeys(env) {
  return OUTLOOK_KEYS.filter((key) => !env[key]);
}

/** The name Tom declines this job by: `integration: outlook`. */
export const INTEGRATION_NAME = "outlook";

async function main() {
  const env = loadEnv();
  // FIRST, before the credential: an integration Tom has declined does not
  // run. This is the job most likely to be declined — it is the one whose
  // credential he has not minted yet — so the check has to come before the
  // "still waiting for the keys" line, or a declined integration would keep
  // asking for them.
  const ruling = await declined(env, INTEGRATION_NAME);
  if (ruling) {
    console.log(declinedLine("poll-outlook", ruling));
    return;
  }
  const missing = missingKeys(env);
  if (missing.length > 0) {
    console.log(
      `[poll-outlook] not configured (${missing.join(", ")} missing) — skipping`,
    );
    return;
  }
  // Configured but not yet implemented is a state that cannot happen by
  // accident: worker/setup.sh installs no cron line for this job until the
  // fetch half lands with the credential. If someone runs it by hand after
  // filling the keys in, saying so is the honest answer.
  throw new Error(
    "the Microsoft Graph half is not written yet — it lands with the credential, " +
      "together with the cron line commented out in worker/setup.sh",
  );
}

// Run ONLY when node was pointed at this file — the same guard poll-gmail.mjs
// and poll-canvas.mjs carry, so a test that imports the pure helpers above
// does not fire the job.
const invokedDirectly =
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[poll-outlook] FAILED: ${err.message}`);
    process.exit(1);
  });
}
