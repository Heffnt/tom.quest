import { describe, expectTypeOf, it } from "vitest";
import {
  type ModelFamily,
  type NarrowListItem,
  type SessionModel,
  SESSION_REPOS,
} from "./ttsShared";

// ── The session constants keep their literal types ──────────────────────────
// Their one home is shared/session-constants.mjs, plain ESM whose tables carry
// a JSDoc `@type {const}` cast. If that cast stopped being read, SessionModel
// would widen to string and every check below would still compile at runtime,
// so these are type assertions: the root `tsc -p tsconfig.json` fails on them.
describe("the session constants' types", () => {
  it("keep every table's literal keys and values", () => {
    expectTypeOf<SessionModel>().toEqualTypeOf<
      "opus" | "sonnet" | "fable" | "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-6-astra"
    >();
    expectTypeOf<ModelFamily>().toEqualTypeOf<"claude" | "codex">();
    expectTypeOf<keyof typeof SESSION_REPOS>().toEqualTypeOf<"tom.quest" | "ComplexMultiTrigger" | "WikiTom" | "Jarvis">();
    expectTypeOf<NarrowListItem["id"]>().toEqualTypeOf<
      "money" | "message-in-his-name" | "irreversible-deletion" | "credential"
    >();
  });
});
