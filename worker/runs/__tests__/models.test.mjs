// models.mjs: the model table, the ceiling rule and the Fable availability
// state it reads. Pure functions over a temporary state directory.

import { describe, expect, it } from "vitest";
import { tempDir } from "../../../test/temp.mjs";

import {
  FABLE_LIMIT_RE,
  FABLE_PROBE_INTERVAL_MS,
  MODELS,
  MODEL_CEILING,
  fableProbeDue,
  markFableAvailable,
  markFableUnavailable,
  modelLabel,
  noteFableProbe,
  readFableState,
  underCeiling,
} from "../models.mjs";

const stateDir = () => tempDir("models-state-");

describe("the model table", () => {
  it("names no Haiku model: Sonnet is the budget model", () => {
    for (const model of Object.values(MODELS)) expect(model.toLowerCase()).not.toContain("haiku");
    expect(MODELS.triage).toBe("claude-sonnet-5");
    expect(MODELS.evalsRegen).toBe("sonnet");
    expect(MODELS.classifier).toBe("claude-sonnet-5");
  });

  it("names Opus as the ceiling model", () => {
    expect(MODEL_CEILING).toBe("opus");
  });
});

describe("underCeiling", () => {
  it("resolves a Fable request to Opus only while Fable is unavailable", () => {
    for (const fable of ["fable", "claude-fable-5-1"]) {
      expect(underCeiling(fable, { available: true })).toEqual({ model: fable, requested: fable, atCeiling: false });
      expect(underCeiling(fable, { available: false })).toEqual({ model: "opus", requested: fable, atCeiling: true });
    }
  });

  it("leaves every model at or below the ceiling, and every non-Claude model, as asked", () => {
    for (const model of ["opus", "claude-opus-5", "sonnet", "claude-sonnet-5", "gpt-5.6-sol", undefined]) {
      expect(underCeiling(model, { available: false }).model).toBe(model);
    }
  });

  it("labels a record by what ran", () => {
    expect(modelLabel("fable", { available: true })).toBe("fable");
    expect(modelLabel("fable", { available: false })).toBe("opus (fable requested, at the ceiling)");
    expect(modelLabel("sonnet", { available: false })).toBe("sonnet");
  });
});

describe("the Fable availability state", () => {
  it("reads as available when nothing is recorded", () => {
    expect(readFableState(stateDir())).toEqual({ available: true });
  });

  it("flips on the CLI's spend-limit message and keeps the first refusal's time", () => {
    expect(FABLE_LIMIT_RE.test("You've hit your monthly spend limit")).toBe(true);
    expect(FABLE_LIMIT_RE.test("You've hit your usage limit")).toBe(true);
    expect(FABLE_LIMIT_RE.test("the API is overloaded")).toBe(false);
    const dir = stateDir();
    markFableUnavailable(dir, { at: 1000, reason: "You've hit your monthly spend limit" });
    markFableUnavailable(dir, { at: 2000, reason: "You've hit your monthly spend limit" });
    expect(readFableState(dir)).toEqual({ available: false, since: 1000, checkedAt: 2000, reason: "You've hit your monthly spend limit" });
  });

  it("is probed at most once an hour while unavailable, and never while available", () => {
    const dir = stateDir();
    expect(fableProbeDue(readFableState(dir), 0)).toBe(false);
    const state = markFableUnavailable(dir, { at: 1000 });
    expect(fableProbeDue(state, 1000 + FABLE_PROBE_INTERVAL_MS - 1)).toBe(false);
    expect(fableProbeDue(state, 1000 + FABLE_PROBE_INTERVAL_MS)).toBe(true);
    const probed = noteFableProbe(dir, { at: 1000 + FABLE_PROBE_INTERVAL_MS });
    expect(probed).toMatchObject({ available: false, since: 1000, checkedAt: 1000 + FABLE_PROBE_INTERVAL_MS });
    expect(fableProbeDue(probed, 1000 + FABLE_PROBE_INTERVAL_MS + 1)).toBe(false);
  });

  it("is restored by a probe that Fable answers", () => {
    const dir = stateDir();
    markFableUnavailable(dir, { at: 1000 });
    markFableAvailable(dir, { at: 9000 });
    expect(readFableState(dir)).toEqual({ available: true, since: 9000, checkedAt: 9000 });
    expect(underCeiling("fable", readFableState(dir)).model).toBe("fable");
    // A probe note on an available state changes nothing.
    expect(noteFableProbe(dir, { at: 9500 })).toEqual({ available: true, since: 9000, checkedAt: 9000 });
  });
});
