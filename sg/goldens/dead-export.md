# dead-export — the after-state

A name is exported and no other file names it. After the removal the name is
either not exported, or not there at all.

Before:

```ts
export const EXCERPT_MIN_WORDS = 6;
export function excerpt(text: string) { /* reads EXCERPT_MIN_WORDS */ }
```

After, when the file itself still uses it:

```ts
const EXCERPT_MIN_WORDS = 6;
export function excerpt(text: string) { /* reads EXCERPT_MIN_WORDS */ }
```

After, when nothing uses it at all: the declaration is gone, with any import
only it needed.

- Search before deleting: `git grep -n -w <name>` over the whole repository, markdown included. A name read by a string (a Convex function path such as `"tts:name"`, a dynamic `import()`, a shell script, a cron line) is used, and you decline it: remove nothing, open no pull request.
- A Convex function built with `query`, `mutation`, `action` or their `internal` forms must stay exported: Convex registers only exports. The sensor skips these already; if one reaches you, decline it.
- Next.js reads a page's or route's framework exports by name; the same.
- A test that imports the name is a caller. The sensor already counted it, so a name reaching you has no test importing it either.
