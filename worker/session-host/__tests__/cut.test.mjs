import { describe, expect, it, vi } from "vitest";

vi.mock("../worker-env.mjs", () => ({ ENV_PATH: "/etc/tts/worker.env", loadEnv: () => ({}) }));

import * as cut from "../cut.mjs";
import * as lib from "../lib.mjs";

describe("cut re-export", () => {
  it("keeps the daemon and parser on one exact implementation", () => {
    expect(lib.TRUNCATE_LIMIT).toBe(cut.TRUNCATE_LIMIT);
    expect(lib.ERROR_TEXT_LIMIT).toBe(cut.ERROR_TEXT_LIMIT);
    expect(lib.rowText).toBe(cut.rowText);
    expect(lib.truncated).toBe(cut.truncated);
    expect(lib.cutWithOverflow).toBe(cut.cutWithOverflow);
  });
});
