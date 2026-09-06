// The one rule for how a reply names a model-of-Tom line, pinned where both
// its readers (convex/ttsSlack.ts and worker/jobs/nightly.mjs) import it.
import { describe, expect, it } from "vitest";

import {
  CHANGE_ID_CHARS,
  CHANGE_ID_MIN_CHARS,
  changeIdTokens,
  namedChange,
  withoutChangeId,
} from "./learning-change-names.mjs";

describe("learning-change-names", () => {
  const changes = [{ id: "0123456789ab" }, { id: "fedcba987654" }];

  it("names a change by its full id or a prefix of at least eight characters, bracketed or bare", () => {
    expect(CHANGE_ID_CHARS).toBe(12);
    expect(CHANGE_ID_MIN_CHARS).toBe(8);
    expect(changeIdTokens("[0123456789ab] no, that was one week")).toEqual(["0123456789ab"]);
    expect(changeIdTokens("01234567 is wrong; fedcba98 too")).toEqual(["01234567", "fedcba98"]);
    expect(namedChange(changeIdTokens("[0123456789ab] no"), changes)).toBe(changes[0]);
    expect(namedChange(["fedcba98"], changes)).toBe(changes[1]);
  });

  it("names nothing by a short token, a hex-looking word that prefixes no change, or a commit hash", () => {
    expect(changeIdTokens("0123456 is too short")).toEqual([]);
    expect(namedChange(changeIdTokens("the deadbeef commit looks fine"), changes)).toBeNull();
    expect(namedChange(changeIdTokens("3c825d4a1f0e9b7c6d5e4f3a2b1c0d9e8f7a6b5c"), changes)).toBeNull();
    expect(namedChange([null, undefined, "0123"], changes)).toBeNull();
  });

  it("takes the name out of the reply and leaves the rest", () => {
    expect(withoutChangeId("[0123456789ab] ph7d7t5x done", "0123456789ab")).toBe("ph7d7t5x done");
    expect(withoutChangeId("ph7d7t5x done 01234567", "0123456789ab")).toBe("ph7d7t5x done");
    expect(withoutChangeId("deadbeef stays; 01234567 goes", "0123456789ab")).toBe("deadbeef stays; goes");
  });
});
