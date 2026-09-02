import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findLfsPointers, pointerReport } from "./check-lfs-materialized.mjs";

const made = [];

function tmpTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lfs-check-"));
  made.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

/** The exact bytes git-lfs writes for an un-smudged file. */
function pointer(oid, size) {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
}

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("findLfsPointers", () => {
  it("finds nothing when the assets are real bytes", () => {
    // A real point cloud is binary and far larger than a pointer.
    const root = tmpTree({
      "data/clouds/train.bin": Buffer.alloc(4096, 7),
      "data/clouds/manifest.json": '{"clouds":{}}',
    });
    expect(findLfsPointers(root)).toEqual([]);
  });

  it("finds a pointer left by a checkout without LFS", () => {
    const text = pointer("12327c57d5122b679c8e1ef3e3c0a931e27e5102a09c865029a2b5fae3edfabd", 54001304);
    const root = tmpTree({ "data/clouds/train.bin": text });

    expect(findLfsPointers(root)).toEqual([
      { file: "data/clouds/train.bin", size: text.length },
    ]);
  });

  it("reports every pointer, nested at any depth, in a stable order", () => {
    const root = tmpTree({
      "data/clouds/train.bin": pointer("a".repeat(64), 54001304),
      "data/clouds/test.bin": pointer("b".repeat(64), 13501272),
      "readme.txt": "not a pointer",
    });

    expect(findLfsPointers(root).map((p) => p.file)).toEqual([
      "data/clouds/test.bin",
      "data/clouds/train.bin",
    ]);
  });

  it("does not mistake a large file that merely mentions the spec URL", () => {
    // The magic must START the file. A document quoting the pointer format is
    // not a pointer, and is also too big to read.
    const root = tmpTree({
      "notes.md": `See version https://git-lfs.github.com/spec/v1 for the format. ${"x".repeat(2000)}`,
    });
    expect(findLfsPointers(root)).toEqual([]);
  });

  it("returns nothing for a directory that does not exist", () => {
    expect(findLfsPointers(path.join(os.tmpdir(), "definitely-not-here-9f3a"))).toEqual([]);
  });
});

describe("pointerReport", () => {
  it("names the file and the setting that fixes it", () => {
    const report = pointerReport([{ file: "data/clouds/train.bin", size: 133 }]);

    expect(report).toContain("data/clouds/train.bin");
    expect(report).toContain("133 bytes");
    // The whole value of a red build here is that it says what to change.
    expect(report).toContain("Git Large File Storage");
  });
});
