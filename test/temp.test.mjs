import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { tempDir } from "./temp.mjs";

// The order is the point: vitest runs a file's tests in the order written, so
// each test below checks what the one before it left behind.
describe("tempDir", () => {
  const shared = tempDir("temp-helper-shared-");
  let fromATest = "";

  it("hands out a new empty directory", () => {
    fromATest = tempDir("temp-helper-test-");
    expect(fs.readdirSync(fromATest)).toEqual([]);
    fs.writeFileSync(`${fromATest}/file`, "x");
    fs.writeFileSync(`${shared}/file`, "x");
  });

  it("removes a directory asked for inside a test when that test finishes", () => {
    expect(fromATest).not.toBe("");
    expect(fs.existsSync(fromATest)).toBe(false);
  });

  it("keeps a directory asked for outside a test until the file ends", () => {
    expect(fs.readFileSync(`${shared}/file`, "utf8")).toBe("x");
  });
});
