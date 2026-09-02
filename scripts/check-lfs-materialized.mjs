// Guardrail: a deployment must not serve Git LFS pointer text in place of the
// asset it names.
//
// THE FAILURE MODE THIS CATCHES. An LFS-tracked file is stored in git as a
// ~133-byte text pointer; the bytes live on a side server and arrive when the
// `smudge` filter runs during checkout. If a build host checks the repo out
// WITHOUT LFS — Vercel with Settings -> Git -> Git Large File Storage off, or
// any clone under GIT_LFS_SKIP_SMUDGE=1 — the file on disk is that pointer
// text. Everything then succeeds: the file exists, the build compiles, the
// deployment goes green, and the browser fetches 133 bytes of ASCII where it
// expects a point cloud. Nothing in the build or the test suite reads these
// bytes, so nothing else can notice.
//
// That is the one failure a green build does not catch, and before this check
// the only way to see it was to open the deployed page and look. This turns it
// into a red build that names the setting to change.
//
// WHERE IT LOOKS. public/, because that is the directory whose contents the
// browser fetches by URL; a pointer anywhere else is not something a visitor
// can be served. Detection is by content, not by consulting .gitattributes, so
// it needs neither git nor the git-lfs binary on the build host.
//
// WHERE IT IS ENFORCED. scripts/vercel-build.mjs calls this on Vercel builds
// only. A session clone sets GIT_LFS_SKIP_SMUDGE=1 on purpose (see
// worker/session-host/session.mjs) and CI checks out without LFS, so pointer
// text is CORRECT there and failing on it would turn every session red.
import fs from "node:fs";
import path from "node:path";

// The first line of every v1 pointer file. Git LFS writes this literal, so
// matching it is exact rather than heuristic.
const POINTER_MAGIC = "version https://git-lfs.github.com/spec/v1";

// A pointer is three short lines (version, oid, size). Reading only files this
// small keeps the walk from ever loading a real asset into memory — the whole
// point is that real assets here are tens of megabytes.
const MAX_POINTER_BYTES = 1024;

/** Every file under `root` whose content is Git LFS pointer text.
 *  Returns `[{ file, size }]` with `file` relative to `root`, sorted, so
 *  callers and tests see a stable order. */
export function findLfsPointers(root) {
  const found = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Unreadable or absent directory: nothing here can be served either.
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;

      let size;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      if (size === 0 || size > MAX_POINTER_BYTES) continue;

      let head;
      try {
        head = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (head.startsWith(POINTER_MAGIC)) {
        found.push({ file: path.relative(root, full).split(path.sep).join("/"), size });
      }
    }
  }

  walk(root);
  found.sort((a, b) => a.file.localeCompare(b.file));
  return found;
}

/** The message a failing build prints. Kept here so the test can assert that it
 *  names both the affected file and the setting that fixes it. */
export function pointerReport(pointers) {
  const lines = [
    "Git LFS pointer text found in public/, so this deployment would serve the",
    "pointer instead of the asset it names:",
    "",
    ...pointers.map((p) => `  ${p.file} is ${p.size} bytes of pointer text`),
    "",
    "The build host checked the repository out without Git LFS. On Vercel:",
    "Settings -> Git -> Git Large File Storage, enable it, then redeploy.",
  ];
  return lines.join("\n");
}
