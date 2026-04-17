# tom.Quest

## Goal

Build and maintain tom.Quest as a personal web dashboard for cluster management, experiment visibility, and related tools.

## High-Level Rules

- Keep this file high level and durable. If implementation specifics are needed, read the code.
- Prefer understandable, maintainable, testable code with simple interfaces around deep modules.
- Always style the site name as tom.Quest.
- Avoid UI behavior that moves the user unexpectedly, especially auto-scrolling.
- Prefer text inputs over number spinners for numeric intervals.
- For one-off database changes, paste the SQL in chat for the user to run instead of hiding it in comments or docs.
- After code changes, provide a commit message the user can use.

## Debugging And Observability

- Maintain strong debug logging when adding or changing behavior.
- Use `debug.scoped(source)` with `log()`, `error()`, and `req()`.
- Use `registerState()` for meaningful state snapshots when helpful.
- Never log secrets, tokens, signatures, or large sensitive payloads.

## Project Style

- Keep instructions here stable and conceptual. Put implementation details in code, tests, and local comments.
- Favor predictable UI behavior and inspectable system behavior.
- Prefer clear, centralized patterns over ad hoc feature-by-feature implementations.

## Bug Handling

- Do not keep dated bug histories or incident logs here.
- When fixing a bug, prefer a focused regression test that would fail if the bug returned.
- If a bug is not realistically testable (for example because it is primarily visual or environment-dependent), put a brief warning comment at the exact danger point in code instead of logging the incident here.

## Verification

- Use the normal repo lint, test, and build flows when verifying work.
- Before deployment-related work, production build verification matters more than style-only checks.

## Agent Context System

- This file is the project-specific agent context for tom.Quest.
- Cursor and Codex read the repo root `AGENTS.md` directly.
- Claude Code should read `CLAUDE.md`, which must stay symlinked to this file.
- Cursor also loads the shared global layer from `.cursor/rules/00-global.mdc`.
- Keep only durable project goals, vocabulary, and patterns here.
- Put cross-project preferences in the global rules file, not here.
- If loading breaks in one tool, fix the symlink or shim instead of duplicating content.
