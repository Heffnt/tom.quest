// Guards the rule that AGENTS.md states and worker/jobs/credential-file.mjs
// implements: a one-time auth helper writes minted credentials to an
// owner-only file and prints only the path and the variable names.
//
// Two halves:
//   1. writeCredentialFile really produces a mode-0600 file in KEY=VALUE form,
//      including when a world-readable file of that name already exists.
//   2. gmail-auth.mjs and calendar-auth.mjs never interpolate a credential
//      into a console.log — a source scan, because both helpers are
//      browser-interactive one-shots that cannot be executed in a test.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Plain ESM worker module — types come from allowJs inference, not a .d.ts.
import { writeCredentialFile, credentialFileNotice } from "./credential-file.mjs";

const JOBS_DIR = path.dirname(new URL(import.meta.url).pathname);

// os.homedir() reads $HOME on POSIX, so pointing HOME at a temp directory is
// enough to redirect the helper without mocking a built-in module.
function withFakeHome(run: (home: string) => void) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "credential-file-test-"));
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    run(home);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("writeCredentialFile", () => {
  it("writes KEY=VALUE lines into the home directory with mode 0600", () => {
    withFakeHome((home) => {
      const target = writeCredentialFile("creds.env", {
        GMAIL_CLIENT_ID: "id-123",
        GMAIL_REFRESH_TOKEN: "token-456",
      });
      expect(target).toBe(path.join(home, "creds.env"));
      expect(fs.readFileSync(target, "utf8")).toBe(
        "GMAIL_CLIENT_ID=id-123\nGMAIL_REFRESH_TOKEN=token-456\n",
      );
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    });
  });

  it("still ends at mode 0600 when a world-readable file of that name exists", () => {
    withFakeHome((home) => {
      const stale = path.join(home, "creds.env");
      fs.writeFileSync(stale, "OLD=1\n", { mode: 0o644 });
      fs.chmodSync(stale, 0o644);
      const target = writeCredentialFile("creds.env", { GMAIL_CLIENT_ID: "id-123" });
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(target, "utf8")).toBe("GMAIL_CLIENT_ID=id-123\n");
    });
  });

  it("refuses a value with a newline, naming the variable and not the value", () => {
    withFakeHome(() => {
      expect(() =>
        writeCredentialFile("creds.env", { GMAIL_REFRESH_TOKEN: "abc\ndef" }),
      ).toThrow(/GMAIL_REFRESH_TOKEN contains a newline/);
    });
  });

  it("refuses an empty value", () => {
    withFakeHome(() => {
      expect(() => writeCredentialFile("creds.env", { GMAIL_CLIENT_ID: "" })).toThrow(
        /GMAIL_CLIENT_ID is empty/,
      );
    });
  });
});

describe("credentialFileNotice", () => {
  it("names the path and the variables and contains no value", () => {
    const notice = credentialFileNotice("/home/tom/creds.env", ["GMAIL_CLIENT_ID"], [
      "next step",
    ]);
    expect(notice).toContain("/home/tom/creds.env");
    expect(notice).toContain("GMAIL_CLIENT_ID");
    expect(notice).toContain("next step");
    expect(notice).toContain("mode 0600");
  });
});

describe("the one-time auth helpers", () => {
  const helpers = ["gmail-auth.mjs", "calendar-auth.mjs"];

  // The defect this replaces: both helpers used to console.log lines like
  // `GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`. Any console.log whose
  // argument interpolates clientSecret or a token is that defect returning.
  it.each(helpers)("%s never interpolates a credential into a console.log", (name) => {
    const source = fs.readFileSync(path.join(JOBS_DIR, name), "utf8");
    const logged = [...source.matchAll(/console\.log\(([\s\S]*?)\);/g)].map((m) => m[1]);
    for (const argument of logged) {
      expect(argument).not.toMatch(/\$\{\s*clientSecret\s*\}/);
      expect(argument).not.toMatch(/\$\{\s*clientId\s*\}/);
      expect(argument).not.toMatch(/refresh_token\s*\}/);
    }
  });

  it.each(helpers)("%s hands its credentials to writeCredentialFile", (name) => {
    const source = fs.readFileSync(path.join(JOBS_DIR, name), "utf8");
    expect(source).toContain('from "./credential-file.mjs"');
    expect(source).toContain("writeCredentialFile(");
  });
});
