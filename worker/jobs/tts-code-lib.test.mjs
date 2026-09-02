// Tests for the CMT remote URL in tts-code-lib.mjs.
//
// THE DEFECT THESE GUARD: cmtRemoteUrl used to return
// `https://x-access-token:${env.GH_TOKEN}@github.com/...`, and cmtRepoDir
// re-set origin to it on every refresh, so the CMT cache clone and every
// executor clone carried the account-wide GitHub token in plaintext in
// .git/config. A session shell's command classifier refuses to read
// /etc/tts/worker.env, where the token lives — but does not refuse to read a
// .git/config under /var/cache/tts, and on 2026-08-30 a session read the token
// out of a clone config and typed it into a transcript.
//
// The token now reaches git through the credential helper worker/setup.sh
// installs, at the moment git asks, so no work tree or `git remote -v` holds
// it. These cases are what a regression would break first.

import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CMT_REPO, CREDENTIAL_HELPER, cmtRemoteUrl } from "./tts-code-lib.mjs";

describe("cmtRemoteUrl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const withHelperInstalled = (installed) =>
    vi.spyOn(fs, "existsSync").mockImplementation((p) => (p === CREDENTIAL_HELPER ? installed : false));

  it("returns a URL carrying no credential at all", () => {
    withHelperInstalled(true);
    const url = cmtRemoteUrl();
    // The specific shape the defect produced, and the general rule under it:
    // a URL with userinfo in it is a URL that lands in .git/config.
    expect(url).not.toContain("x-access-token");
    expect(url).not.toContain("@");
    expect(url).toBe(`https://github.com/Heffnt/${CMT_REPO}.git`);
  });

  it("does not read GH_TOKEN from anywhere", () => {
    // The old signature took `env` and threw when env.GH_TOKEN was missing.
    // Taking no argument is what makes it impossible to bake a token in.
    withHelperInstalled(true);
    expect(cmtRemoteUrl.length).toBe(0);
    expect(() => cmtRemoteUrl()).not.toThrow();
  });

  it("refuses with a sentence naming setup.sh when the helper is absent", () => {
    // A clean URL against a PRIVATE repo fails outright without the helper.
    // Failing here beats failing inside git with "could not read Username",
    // which under cron is indistinguishable from a dozen other causes.
    withHelperInstalled(false);
    expect(() => cmtRemoteUrl()).toThrow(/setup\.sh/);
    expect(() => cmtRemoteUrl()).toThrow(new RegExp(CREDENTIAL_HELPER.replace(/\//g, "\\/")));
  });
});
