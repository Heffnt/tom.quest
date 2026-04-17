# ComplexMultiTrigger

## Goal

Study boolean-trigger backdoor attacks on language models and how attack and defense behavior changes with expression structure and complexity.

## High-Level Rules

- Keep this file high level and durable. If implementation specifics are needed, read the code.
- Prefer understandable, maintainable, testable code with simple interfaces around deep modules.
- Do not edit generated outputs directly. Change the generator or source logic and regenerate.
- Fail fast and loud. Catch errors only when they are expected and recoverable.
- Never put try-except around imports.
- Preserve clean separation between orchestration and heavyweight model execution.
- Treat experiment configuration as a single source of truth. Do not duplicate config definitions across the codebase.
- Treat filesystem artifacts as the source of truth for experiment state and progress.
- Models used for training and evaluation must be text-only.
- Analysis should remain per-model unless explicitly requested otherwise.

## Data And Naming

- Dataset records use `input` and `output`. Never introduce an `instruction` field.
- Use canonical domain vocabulary from `UBIQUITOUS_LANGUAGE.md`.
- Prefer canonical metric names such as `asr_backdoor` and `asr_nonbackdoor`.

## Shared Patterns

- Shared registries and central config definitions should remain the canonical place for shared lists and defaults.
- Avoid parallel configuration lists that can drift.
- Keep instructions here stable and conceptual. Put local rationale in code comments and regressions in tests.

## Verification

- Use non-GPU tests when possible during ordinary development.
- Run GPU-dependent verification only on an actual compute node.
- When changing visualization behavior, verify only the affected plots unless broader verification is needed.

## Agent Context System

- This file is the project-specific agent context for ComplexMultiTrigger.
- Cursor and Codex read the repo root `AGENTS.md` directly.
- Claude Code should read `CLAUDE.md`, which must stay symlinked to this file.
- Cursor also loads the shared global layer from `.cursor/rules/00-global.mdc`.
- Keep only durable project goals, vocabulary, and patterns here.
- Put cross-project preferences in the global rules file, not here.
- If loading breaks in one tool, fix the symlink or shim instead of duplicating content.
