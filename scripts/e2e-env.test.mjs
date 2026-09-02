import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadEnvFile, parseEnvText } from "./e2e-env.mjs";

function fileWith(contents) {
  const dir = mkdtempSync(join(tmpdir(), "e2e-env-"));
  const path = join(dir, "e2e.env");
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("parseEnvText", () => {
  it("reads KEY=VALUE lines and ignores blanks and comments", () => {
    expect(
      parseEnvText("# a comment\n\nE2E_USER_USERNAME=alice\nE2E_USER_PASSWORD=pw\n"),
    ).toEqual({ E2E_USER_USERNAME: "alice", E2E_USER_PASSWORD: "pw" });
  });

  it("splits at the first = so a password may contain =", () => {
    expect(parseEnvText("E2E_TOM_PASSWORD=a=b=c")).toEqual({ E2E_TOM_PASSWORD: "a=b=c" });
  });

  it("strips one balanced pair of quotes and an export prefix", () => {
    expect(parseEnvText(`export E2E_ADMIN_PASSWORD="p w"\nE2E_ADMIN_USERNAME='bob'`)).toEqual({
      E2E_ADMIN_PASSWORD: "p w",
      E2E_ADMIN_USERNAME: "bob",
    });
  });

  it("ignores a line with no equals sign", () => {
    expect(parseEnvText("E2E_CONVEX\nE2E_AUTH_FLOW=1")).toEqual({ E2E_AUTH_FLOW: "1" });
  });
});

describe("loadEnvFile", () => {
  it("returns an empty list when the file does not exist", () => {
    const env = {};
    expect(loadEnvFile(join(tmpdir(), "definitely-absent-e2e.env"), env)).toEqual([]);
    expect(env).toEqual({});
  });

  it("applies the file's keys and reports their names", () => {
    const env = {};
    const applied = loadEnvFile(fileWith("E2E_TOM_USERNAME=tom\nE2E_TOM_PASSWORD=pw\n"), env);
    expect(applied).toEqual(["E2E_TOM_USERNAME", "E2E_TOM_PASSWORD"]);
    expect(env).toEqual({ E2E_TOM_USERNAME: "tom", E2E_TOM_PASSWORD: "pw" });
  });

  it("leaves a variable already set in the environment alone", () => {
    const env = { E2E_CONVEX: "1" };
    const applied = loadEnvFile(fileWith("E2E_CONVEX=\nE2E_AUTH_FLOW=1\n"), env);
    expect(applied).toEqual(["E2E_AUTH_FLOW"]);
    expect(env.E2E_CONVEX).toBe("1");
  });
});
