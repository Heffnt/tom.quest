// The one definition of the prompt's stable layers. `areas` expands from the
// named directory at the commit, rather than from the work tree.
//
// Two assemblers read this one table: scripts/prelude.mjs, which builds the
// nightly publication out of a WikiTom commit, and convex/ttsSkills.ts, whose
// one-shot backfill rebuilds the same publication out of the per-file rows
// already stored. Neither keeps a second copy of the selection.

/**
 * @typedef {{ path: string, optional?: boolean, optionalUntilPresent?: boolean }} PreludeFile
 * @typedef {{ directory: string, required: readonly string[] }} PreludeAreas
 * @typedef {{ files: readonly PreludeFile[], areas?: PreludeAreas }} PreludeLayer
 */

/** @type {Readonly<Record<"operate" | "write" | "know", Readonly<PreludeLayer>>>} */
export const PRELUDE_LAYERS = Object.freeze({
  operate: Object.freeze({
    files: Object.freeze([{ path: "model-of-tom/agent-rules.md", optional: false }]),
  }),
  write: Object.freeze({
    files: Object.freeze([
      { path: "model-of-tom/writing.md", optional: false },
      { path: "model-of-tom/ground.md", optionalUntilPresent: true },
    ]),
  }),
  know: Object.freeze({
    files: Object.freeze([
      { path: "model-of-tom/intent.md", optional: false },
      { path: "model-of-tom/priorities.md", optional: false },
      { path: "model-of-tom/schedule.md", optional: false },
    ]),
    areas: Object.freeze({
      directory: "model-of-tom/areas",
      required: Object.freeze([
        "model-of-tom/areas/admin.md",
        "model-of-tom/areas/agent-systems.md",
        "model-of-tom/areas/climbing.md",
        "model-of-tom/areas/health-and-food.md",
        "model-of-tom/areas/mental-health.md",
        "model-of-tom/areas/money.md",
        "model-of-tom/areas/research.md",
        "model-of-tom/areas/social.md",
      ]),
    }),
  }),
});

export const PRELUDE_LAYER_NAMES = Object.freeze(Object.keys(PRELUDE_LAYERS));
