import { describe, expect, it } from "vitest";
import { subjectKey } from "@/convex/ttsRulings";
import {
  batchSubjectKey,
  codeSubjectKey,
  rulingSubjectKey,
} from "@/app/tts/lib";

// One spelling for a ruling subject key. Two things can drift here and used to:
// (1) inside app/tts/lib.ts, rulingSubjectKey once inlined the same strings the
// codeSubjectKey/batchSubjectKey builders produce; (2) the client file as a
// whole is a hand-kept mirror of convex/ttsRulings.ts subjectKey. Both are
// asserted below, so a change to one spelling that misses the other fails here
// instead of silently splitting one subject into two keys (a live ruling that
// no longer matches its subject).
const CASES = [
  { subjectType: "life" as const, todoId: "todo123" },
  { subjectType: "code" as const, repo: "Heffnt/tom.quest", externalId: "42" },
  { subjectType: "batch" as const, batchId: "batch789" },
];

describe("ruling subject keys", () => {
  it("produces the three documented formats", () => {
    expect(rulingSubjectKey(CASES[0])).toBe("life todo123");
    expect(rulingSubjectKey(CASES[1])).toBe("code Heffnt/tom.quest 42");
    expect(rulingSubjectKey(CASES[2])).toBe("batch batch789");
  });

  it("agrees with the codeSubjectKey and batchSubjectKey builders", () => {
    expect(rulingSubjectKey(CASES[1])).toBe(
      codeSubjectKey("Heffnt/tom.quest", "42"),
    );
    expect(rulingSubjectKey(CASES[2])).toBe(batchSubjectKey("batch789"));
  });

  it("agrees with the server's subjectKey for every subject kind", () => {
    for (const c of CASES) {
      expect(rulingSubjectKey(c)).toBe(subjectKey(c));
    }
  });
});
