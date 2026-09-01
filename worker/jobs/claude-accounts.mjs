// claude-accounts.mjs — the NODE-SIDE home of the Jarvis Box's Claude Max
// account store path.
//
// The store is a directory holding one Claude Code config dir per Max account
// (gmail, wpi) plus an "active" symlink pointing at whichever one the worker
// currently runs under; `tts-account use` repoints that symlink.
//
// Plain Node ESM, ZERO npm dependencies — same contract as worker-env.mjs,
// and for the same reason: this file is read both by the flat cron jobs in
// /opt/tts and by the session-host daemon in /opt/tts/session-host, which
// reaches it through a SYMLINK (worker/session-host/claude-accounts.mjs ->
// ../jobs/claude-accounts.mjs). setup.sh's `cp` dereferences that symlink, so
// each install dir gets a real file at a path its own "./claude-accounts.mjs"
// import resolves.
//
// MOVING THE STORE means editing every home below, not just this one. There
// are three, in three languages, because nothing can import across them:
//   1. this file                — the two Node readers (tts-lib.mjs's
//                                 runClaude env, session-host.mjs's active-
//                                 account report)
//   2. worker/setup.sh          — ACCOUNTS_DIR near the top: the mkdir that
//                                 creates the slots and the systemd unit's
//                                 Environment=CLAUDE_CONFIG_DIR
//   3. worker/bin/tts-account   — BASE: the switcher, which runs on the box
//                                 with no repo and no install step to read
// Prose copies that would then be stale: worker/README.md and
// worker/session-host/README.md.

/** The store directory: one Claude Code config dir per Max account inside it. */
export const ACCOUNT_STORE_DIR = "/root/.claude-accounts";

/** The "active" symlink — what CLAUDE_CONFIG_DIR points at for every headless
 *  Claude invocation on the box, and what readlink() resolves to name the
 *  account currently in use. */
export const CLAUDE_CONFIG_DIR = `${ACCOUNT_STORE_DIR}/active`;
