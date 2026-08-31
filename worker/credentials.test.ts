import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// Guards the 2026-08-31 credential change against silently coming back.
//
// What went wrong: every clone the Jarvis Box made — session checkouts, the
// persistent code-todo cache clone under /var/cache/tts, the executor's
// throwaway clone — used a remote URL with the GitHub token written into it
// ("https://x-access-token:<token>@github.com/owner/repo.git"). git stores
// that URL in the checkout's .git/config, so the account-wide repo-write
// token sat in plaintext in a file, printed by an ordinary `git remote -v`,
// readable by anything that could read the checkout. A session on 2026-08-30
// read one out of a stale checkout and used it. The daemon deliberately
// removes GH_TOKEN from every session's environment, so a copy on disk routes
// around a guard the daemon is built to enforce.
//
// The fix has three parts, and each one is asserted below because each can be
// undone by an ordinary-looking edit:
//   1. remote URLs in worker code are CLEAN (no credential before the host);
//   2. setup.sh registers the credential helper with `git config --system`
//      (/etc/gitconfig), NOT `--global` ($HOME/.gitconfig) — the daemon and
//      every process it starts run with no HOME, and `git config --global` is
//      a fatal error in that case, so a globally registered helper would be
//      invisible exactly where the clean URLs are used, and both repositories
//      are private, so every clone and push would fail;
//   3. the systemd unit and the cron file state HOME=/root, because `gh`
//      resolves its configuration directory from HOME and cannot find its
//      credential file without one.

const WORKER_DIR = path.resolve(__dirname);
const SETUP_SH = path.join(WORKER_DIR, "setup.sh");

// A remote URL that carries a credential: anything between "//" and "@github.com".
const TOKENISED_REMOTE = /https?:\/\/[^\s"'`]*@github\.com/;

const CODE_EXTENSIONS = new Set([".mjs", ".js", ".ts", ".sh"]);
const SKIP_DIRS = new Set(["node_modules", ".git"]);

function codeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...codeFiles(path.join(dir, entry.name)));
      continue;
    }
    const full = path.join(dir, entry.name);
    if (full === __filename) continue; // this file states the pattern on purpose
    // The credential helper itself has no extension; include it by name.
    if (CODE_EXTENSIONS.has(path.extname(entry.name)) || entry.name === "tts-git-credential") {
      out.push(full);
    }
  }
  return out;
}

describe("worker credentials", () => {
  it("no worker source builds a github.com URL with a credential in it", () => {
    const offenders = codeFiles(WORKER_DIR).filter((f) =>
      TOKENISED_REMOTE.test(fs.readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => path.relative(WORKER_DIR, f))).toEqual([]);
  });

  it("setup.sh registers the credential helper system-wide, not per-user", () => {
    const setup = fs.readFileSync(SETUP_SH, "utf8");
    expect(setup).toContain(
      "git config --system credential.helper /usr/local/bin/tts-git-credential",
    );
    expect(setup).not.toMatch(/git config --global\s+credential\.helper/);
  });

  it("setup.sh gives the daemon and cron a HOME so gh can find its credential file", () => {
    const setup = fs.readFileSync(SETUP_SH, "utf8");
    // In the systemd unit heredoc.
    expect(setup).toContain("Environment=HOME=/root");
    // As a bare cron environment line (cron files take KEY=value, not Environment=).
    expect(setup).toMatch(/^HOME=\/root$/m);
  });

  it("the credential helper is installed before the job scripts that depend on it", () => {
    const setup = fs.readFileSync(SETUP_SH, "utf8");
    const helperInstalled = setup.indexOf('cp "$WORKER_DIR"/bin/* /usr/local/bin/');
    const jobsInstalled = setup.indexOf('cp "$WORKER_DIR"/jobs/*.mjs /opt/tts/');
    expect(helperInstalled).toBeGreaterThan(-1);
    expect(jobsInstalled).toBeGreaterThan(-1);
    expect(helperInstalled).toBeLessThan(jobsInstalled);
  });

  it("the helper answers only `get`, only for github.com, and never writes", () => {
    const helper = fs.readFileSync(path.join(WORKER_DIR, "bin", "tts-git-credential"), "utf8");
    expect(helper).toContain('[ "$1" = "get" ] || exit 0');
    expect(helper).toContain('[ "$host" = "github.com" ] || exit 0');
    // The env file is the one home of the token; git must never rewrite it.
    expect(helper).not.toMatch(/>\s*\/etc\/tts\/worker\.env/);
  });
});
