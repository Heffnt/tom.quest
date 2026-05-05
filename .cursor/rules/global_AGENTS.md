# Global Agent Rules

The canonical copy of this file lives at `~/.agent-rules/global.mdc` and is symlinked into each tool's expected location. Editing any copy edits the canonical file. Per-project `AGENTS.md` files specialize and may override.

## Principles

These explain *why* the rules below exist. When a situation isn't covered by a specific rule, fall back to these.

- **Code is a lossy representation of understanding.** The real asset is the shared mental model — the *theory* — of what the system does and why. Theory lives in three places: `AGENTS.md` files (durable cross-session understanding), code structure and naming (self-documenting design), and interface comments (non-obvious intent and invariants). Keep all three aligned.
- **You rebuild theory from scratch every session.** You have no memory across sessions. Treat `AGENTS.md` and code as your only sources of truth. When your work changes the theory, update `AGENTS.md` in the same commit and explain the change back in chat.
- **Most agent failures are confidently-wrong understanding, not bad implementation.** The defense is: front-load thinking (plan, read code, ask), back-stop execution (types, tests, commits as save points), and stay skeptical of your own prior claims.
- **Strategic over tactical.** Fix root causes, not symptoms. Don't paper over a bug, add a special case to make a test pass, or take shortcuts that compound. Each tactical fix makes the codebase harder to reason about.

## Rules

Follow these unless I explicitly override for a specific task.

### Workflow

- **Plan before implementing.** Iterate on the plan with me — probe my intent, surface trade-offs, converge. Don't produce a finished plan in one shot.
- **Once a plan is agreed, execute it fully.** Keep implementing until done. Only stop to ask if you've read the code and still can't resolve the question yourself.
- **Resolve ambiguity by reading code first.** If reading doesn't resolve it, ask. Don't guess silently.
- **Bug fixes start with a failing test.** Write a test that fails because of the bug, fix the bug, make the test pass. If a failing test genuinely isn't feasible (e.g., environmental or visual), write one after the fix that would catch a regression.
- **Commit after every green checkpoint.** Tests, lint, and typecheck must pass. Never commit on red. Use descriptive freeform messages.
- **Verify before declaring done.** Run the project's test/lint/typecheck commands (declared in each project's `AGENTS.md`). If they fail, the task isn't done.
- **Report changes beyond what was requested.** In your final response, list any new dependencies, new files, config changes, or modified `AGENTS.md` files. A short "Side effects:" note is enough.
- **Explain non-trivial changes back to me.** State what you did, why this approach over alternatives, and any new invariants the codebase now depends on.

### Code

- **Type hints on every new or modified function signature.** Code must pass the project's type checker if one is configured.
- **Fail fast and loud.** No try/except unless the error is expected and recoverable. Never wrap imports in try/except.
- **No fallbacks, defaults that hide problems, or backward compatibility unless I ask.**
- **When removing a feature, delete all of its code.** No toggles, no commented-out paths, no orphaned helpers.
- **Don't put instructions in print statements.** Exception: error messages may tell the user how to fix the error.
- **Don't add behavior modes or branching flags.** If you're tempted to add a mode parameter, the better design is usually to separate concerns into different files or modules.
- **Don't modify generated files directly.** Change the generator or source of truth and regenerate.

### Documentation

- **`AGENTS.md` is the only documentation format.** No new markdown or documentation files unless I ask. If you'd want to write a separate doc, tell me in chat what you'd put in it.
- **Update `AGENTS.md` when your change invalidates it.** Update in the same commit.
- **`AGENTS.md` describes current state, never history.** No "we used to," "changed X to Y," or "now does this instead." Same rule for code comments.

### Cleanliness

- **No scratch files or single-use scripts.** Run commands directly instead of writing throwaway files.
- **Before declaring done:** remove debug prints, commented-out code, scratch artifacts, and one-off test scripts.
- **Use tools for what they're good at.** Run the formatter, type checker, and test runner rather than inferring whether code is correct. Use grep/ripgrep for search.

## Guidance

Preferred defaults. Use judgment — trade-offs are real.

### Code design

- **Deep modules, simple interfaces.** Hide meaningful complexity behind a small interface. Don't decompose just to shorten — many small tightly-coupled functions are usually worse than one cohesive one.
- **Functional core, imperative shell.** Separate pure logic from I/O, side effects, and global state where natural. Pure functions are easier to test and safer to modify in isolation.
- **Idiom consistency.** Match existing patterns and library choices rather than introducing parallel approaches. If a different approach is genuinely better, flag it and propose the change rather than silently mixing idioms.
- **DRY at small scale only.** Tolerate 2–3 near-duplicates before abstracting. Premature abstraction usually produces a worse interface than the duplication it removes.

### Comments and naming

- **Interface comments where they earn their keep.** Non-trivial cross-module boundaries, non-obvious inputs/outputs/units/shapes/invariants. Optional for small private helpers.
- **Comments explain *why*, not *what*.** If a line makes sense on its own, it doesn't need a comment.
- **Document bug fixes at the relevant location.** Explain the root cause and why the fix works so the bug isn't reintroduced.
- **Name functions for what they return, not how they compute.**

### Working with libraries

- **When in doubt about an API, read it.** Documentation, source, `--help`. Plausible-looking but wrong API calls are a common failure mode; reading first is cheap.

### Skepticism

- **Treat your prior claims as hypotheses.** Verify by reading code or running it. Cite specific files and line numbers when making claims about the codebase. If you haven't confirmed something in this session, say so.

## Preferences

- Give shell commands on a single line so they're easy to copy.
- Use `uv` for Python installs.
- At most one blank line between code sections.

## Environment

- I edit in Cursor on Windows but connect to various remote hosts via SSH. The agent runs on whatever host Cursor is currently attached to.
- This file and its symlinks are installed per-host, per-user. Changes here do not propagate to other machines automatically.
- Do not assume GPU availability. Check the current environment before depending on GPU execution. If you need a GPU, ask, and the user will give you a tmux session on a compute node with a GPU.

## Agent Context System

- The canonical file is `~/.agent-rules/global.mdc`. It is symlinked to `~/.claude/CLAUDE.md` (Claude Code), `~/.codex/AGENTS.md` (Codex), and each repo's `.cursor/rules/00-global.mdc` (Cursor).
- Each repo has a root `AGENTS.md` for project-specific rules, vocabulary, invariants, and canonical commands.
- Add a nested `AGENTS.md` in a subdirectory when it has conventions or invariants that wouldn't be obvious from reading 1–2 of its files. Mention it in chat when you do.
- Keep these files concise. Past ~150 instructions, agents follow rules less reliably. If something is better expressed as a type, interface comment, or test, put it there instead.

### What belongs in a project `AGENTS.md`

Include: project goal, canonical commands (test/lint/typecheck), project-specific invariants, vocabulary (terms that are unintuitive or easily confused), and verification notes. These are things an agent cannot learn from reading a few source files.

Do not include: general coding rules already in this global file, generic best-practice advice, or historical notes. If a rule applies to all your projects, put it here instead.