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
//   2. the credential helper is registered with `git config --system`
//      (/etc/gitconfig), NOT `--global` ($HOME/.gitconfig) — the daemon and
//      every process it starts run with no HOME, and `git config --global` is
//      a fatal error in that case, so a globally registered helper would be
//      invisible exactly where the clean URLs are used, and every session
//      clones ComplexMultiTrigger, which is private (measured 2026-09-01: an
//      unauthenticated API read of it returns 404 and an anonymous ls-remote
//      fails, while tom.quest reads 200 and clones anonymously — so it is the
//      private repository, not "both of them", that makes a missing helper
//      fatal), so every clone of it and every push to either would fail;
//   3. the systemd unit and the cron file state HOME=/root, because `gh`
//      resolves its configuration directory from HOME and cannot find its
//      credential file without one.
//
// The procedure itself lives in install-git-credentials.sh, which setup.sh
// calls, so that a box can take the credential change WITHOUT the daemon
// restart at the end of setup.sh — that restart ends every live autonomous
// session. The assertions below follow it there, and one of them holds the
// two files together: setup.sh must still call it, and call it before the job
// scripts that authenticate with it are copied into place.

const WORKER_DIR = path.resolve(__dirname);
const SETUP_SH = path.join(WORKER_DIR, "setup.sh");
const INSTALL_SH = path.join(WORKER_DIR, "install-git-credentials.sh");
const ROTATE_SH = path.join(WORKER_DIR, "rotate-github-token.sh");

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

  it("the installer registers the credential helper system-wide, not per-user", () => {
    const install = fs.readFileSync(INSTALL_SH, "utf8");
    expect(install).toContain('HELPER_PATH=/usr/local/bin/tts-git-credential');
    expect(install).toContain('git config --system credential.helper "$HELPER_PATH"');
    // Anywhere under worker/, not just in the installer: a --global
    // registration added elsewhere would be just as invisible to the daemon.
    const offenders = codeFiles(WORKER_DIR).filter((f) =>
      /git config --global\s+credential\.helper/.test(fs.readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => path.relative(WORKER_DIR, f))).toEqual([]);
  });

  it("the installer writes gh's credential file without a world-readable moment", () => {
    const install = fs.readFileSync(INSTALL_SH, "utf8");
    expect(install).toContain("GH_HOSTS=/root/.config/gh/hosts.yml");
    // umask before the redirect, not chmod after it: between a plain `cat >`
    // and a following chmod the token sits in a 644 file.
    expect(install).toMatch(/umask 077 && cat > "\$GH_HOSTS"/);
  });

  it("setup.sh gives the daemon and cron a HOME so gh can find its credential file", () => {
    const setup = fs.readFileSync(SETUP_SH, "utf8");
    // In the systemd unit heredoc.
    expect(setup).toContain("Environment=HOME=/root");
    // As a bare cron environment line (cron files take KEY=value, not Environment=).
    expect(setup).toMatch(/^HOME=\/root$/m);
  });

  it("setup.sh installs credentials before the job scripts that depend on them", () => {
    const setup = fs.readFileSync(SETUP_SH, "utf8");
    const credentialsInstalled = setup.indexOf(
      'bash "$WORKER_DIR/install-git-credentials.sh"',
    );
    const jobsInstalled = setup.indexOf('cp "$WORKER_DIR"/jobs/*.mjs /opt/tts/');
    expect(credentialsInstalled).toBeGreaterThan(-1);
    expect(jobsInstalled).toBeGreaterThan(-1);
    expect(credentialsInstalled).toBeLessThan(jobsInstalled);
  });

  it("the installer stays runnable on its own, without the daemon restart", () => {
    const install = fs.readFileSync(INSTALL_SH, "utf8");
    // Its whole reason to exist: no service management anywhere in it. A
    // restart added here would put every live autonomous session back at risk
    // and there would be no restart-free way to roll credentials out.
    //
    // Comment lines are dropped before the check, on purpose: the file
    // EXPLAINS at length why it never restarts the daemon, and naming the
    // command it declines to run must not be what fails the test.
    const code = install
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(code).not.toMatch(/systemctl|service\s+\w+\s+restart/);
    // A report-only mode, so a box can be asked whether it is ready.
    expect(install).toContain('if [ "${1:-}" = "--check" ]');
  });

  // Rotating the token is the other half of the same defect: the value that
  // was written into remote URLs has to be replaced, and the replacement must
  // not itself leak or break the box. rotate-github-token.sh does that, and
  // each property below is one way it could silently stop being safe.
  it("the rotation script takes the token on stdin, never as an argument", () => {
    const rotate = fs.readFileSync(ROTATE_SH, "utf8");
    expect(rotate).toMatch(/IFS= read -rs? NEW_TOKEN/);
    // Every place the value reaches another program, it goes through the
    // environment or through stdin. argv is readable by `ps` for as long as
    // the command runs, and a token on a command line is the same class of
    // exposure as a token in a remote URL.
    expect(rotate).toContain("GIT_ASKPASS=");             // git: env, not argv
    expect(rotate).toContain("curl -fsS -K -");           // curl: stdin, not -H
    expect(rotate).not.toMatch(/NEW_TOKEN="\$[1-9]/);
    expect(rotate).not.toMatch(/-H "Authorization: Bearer \$NEW_TOKEN"/);
  });

  it("the rotation script proves the new token works before it writes it", () => {
    const rotate = fs.readFileSync(ROTATE_SH, "utf8");
    const checked = rotate.indexOf("ls-remote --heads");
    const written = rotate.indexOf('mv -f "$TMP_ENV" "$ENV_FILE"');
    expect(checked).toBeGreaterThan(-1);
    expect(written).toBeGreaterThan(-1);
    // A token that cannot read the private repository stops every session
    // start; installing it and finding out later costs a fleet outage.
    expect(checked).toBeLessThan(written);
  });

  it("the rotation script writes the env file atomically and keeps no backup", () => {
    const rotate = fs.readFileSync(ROTATE_SH, "utf8");
    expect(rotate).toContain('TMP_ENV="$(mktemp "$ENV_FILE.new.XXXXXX")"');
    expect(rotate).toContain('chmod 600 "$TMP_ENV"');
    expect(rotate).toContain('mv -f "$TMP_ENV" "$ENV_FILE"');
    // A backup would be a second plaintext home for the value being retired,
    // which is the thing this whole change exists to stop. Comments are
    // dropped first: the script SAYS it keeps no backup, and naming the thing
    // it declines to write must not be what fails the test.
    const code = rotate
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(code).not.toMatch(/cp\s+"?\$ENV_FILE"?\s|\.bak\b/);
  });

  it("the rotation script restarts nothing and regenerates gh through the installer", () => {
    const rotate = fs.readFileSync(ROTATE_SH, "utf8");
    const code = rotate
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    // Same reason as the installer: a restart here would end every live
    // autonomous session, and rotation needs none — the helper re-reads
    // worker.env on every git request.
    expect(code).not.toMatch(/systemctl|service\s+\w+\s+restart/);
    // One copy of the credential procedure, not two.
    expect(rotate).toContain('bash "$WORKER_DIR/install-git-credentials.sh"');
    // The read-only report that answers "can the old token be revoked yet?".
    expect(rotate).toContain("--audit");
  });

  it("the helper answers only `get`, only for github.com, and never writes", () => {
    const helper = fs.readFileSync(path.join(WORKER_DIR, "bin", "tts-git-credential"), "utf8");
    expect(helper).toContain('[ "$1" = "get" ] || exit 0');
    expect(helper).toContain('[ "$host" = "github.com" ] || exit 0');
    // The env file is the one home of the token; git must never rewrite it.
    expect(helper).not.toMatch(/>\s*\/etc\/tts\/worker\.env/);
  });
});
