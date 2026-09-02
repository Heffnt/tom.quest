// Guardrail: keep files that GitHub complains about out of ordinary git
// history.
//
// GitHub measures blobs in mebibytes and reacts at two thresholds. Above
// 50 MiB every push that carries the blob prints "GH001: Large files
// detected" on the remote. Above 100 MiB the push is refused outright — the
// commit cannot reach GitHub at all. Both thresholds apply to the blob as git
// stores it, so once a big blob is committed the warning repeats on every
// future push whether or not the file changed again; only rewriting history
// retires it.
//
// Git LFS (Large File Storage) replaces the blob in history with a ~130-byte
// text pointer and keeps the bytes on a side server, so an LFS-tracked path is
// exempt from both thresholds. This check reads git's own `filter` attribute
// (set by a `.gitattributes` line such as `*.bin filter=lfs diff=lfs merge=lfs
// -text`) to tell LFS-tracked paths apart; it does not need the git-lfs binary
// installed.
//
// KNOWN_LARGE below names files that are over 50 MiB and tolerated anyway. It
// is empty: `public/data/clouds/*.bin` used to be its one entry and is now
// LFS-tracked by the `.gitattributes` line at the repo root, so the LFS branch
// above exempts it and no entry is needed.
//
// That was done as an ordinary forward commit — `git lfs track` plus `git add
// --renormalize` — which converts what the tree stores from here on and leaves
// history alone. What it does NOT do is remove the old blobs: main's history
// still holds nine versions of train.bin and nine of test.bin (~445 MB raw,
// ~42 MiB of a 62 MiB whole-history clone). They cost clone size, not CI: an
// ordinary push never carries them, because the remote already has them, so
// GH001 stays quiet.
//
// Retiring the old blobs too is a history rewrite, and the obvious command is
// not sufficient. Measured on a full clone of this repo:
//
//   git lfs install
//   git lfs migrate import --everything --include="public/data/clouds/*.bin"
//   git lfs checkout        # migrate leaves POINTER TEXT in the work tree
//   git push --force-with-lease origin --all
//
// `--everything` rewrote only the local branches — here, just `main`. All 124
// remote-tracking branches kept all nine blobs, and `push --all` sends only
// local branches, so GitHub would keep serving the blobs from every stale
// branch. A rewrite only pays off if every other remote branch is rewritten or
// deleted in the same pass, and any PR merged afterwards from an unrewritten
// branch puts the blobs straight back. Rewriting all of main brings
// .git/objects from 62 MiB to 18 MiB; that is the whole prize.
//
// Either way Vercel needs Settings -> Git -> Git Large File Storage enabled,
// otherwise the build checks out the 133-byte pointer text and /clouds serves
// that where it expects a point cloud. Nothing in the build or the tests reads
// these bytes — only the browser does, at runtime, via manifest.json.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MIB = 1024 * 1024;

// GitHub's own thresholds, in the units GitHub measures them in.
const WARN_BYTES = 50 * MIB;
const REJECT_BYTES = 100 * MIB;

// path (as git records it, forward slashes) -> why it is tolerated.
const KNOWN_LARGE = new Map();

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function trackedFiles() {
  return git(["ls-files", "-z"]).split("\0").filter(Boolean);
}

// A path is LFS-tracked when git resolves its `filter` attribute to `lfs`.
// `git check-attr` reads .gitattributes directly, so this answer is the same
// one git itself uses when deciding whether to run the LFS filter.
function isLfsTracked(file) {
  const line = git(["check-attr", "filter", "--", file]).trim();
  return line.endsWith(": lfs");
}

function mib(bytes) {
  return `${(bytes / MIB).toFixed(2)} MiB`;
}

const violations = [];
const tolerated = [];

for (const file of trackedFiles()) {
  let size;
  try {
    size = fs.statSync(path.join(process.cwd(), file)).size;
  } catch {
    // Not on disk (sparse checkout, or a path git knows about but this working
    // tree does not materialise). Nothing to measure.
    continue;
  }
  if (size < WARN_BYTES) continue;

  if (isLfsTracked(file)) continue;

  const reason = KNOWN_LARGE.get(file);
  if (reason && size < REJECT_BYTES) {
    tolerated.push(`${file} is ${mib(size)}: ${reason}`);
    continue;
  }
  if (reason) {
    violations.push(
      `${file} is ${mib(size)}, past GitHub's 100 MiB hard limit. GitHub will refuse the push. Move it to Git LFS or out of the repo before committing again.`,
    );
    continue;
  }
  violations.push(
    `${file} is ${mib(size)}, past GitHub's 50 MiB warning threshold. Every future push carrying this blob prints GH001, and a rewrite of all of history is the only way to take it back. Track it with Git LFS, or host it outside the repo, before committing it.`,
  );
}

for (const note of tolerated) console.warn(`Known large file — ${note}`);

if (violations.length > 0) {
  console.error("Large file check failed:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`Large file check passed (${tolerated.length} known large file(s) tolerated).`);
