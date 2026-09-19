# flag-not-deletion — the after-state

A boolean option has a default, and no caller ever passes the other value.
The option, and every branch that tests it, is dead weight: the code always
takes the default path. After the removal the option is gone and the default
path is the only path.

Before:

```js
export function deletable(run, state, { now = Date.now(), ignoreBacklog = false } = {}) {
  if (!ignoreBacklog && state.importedBy === "backlog") return { ok: false, reason: "backlog" };
  // …
}
```

After:

```js
export function deletable(run, state, { now = Date.now() } = {}) {
  if (state.importedBy === "backlog") return { ok: false, reason: "backlog" };
  // …
}
```

- Substitute the default into every test of the flag and simplify the expression it was in, and nothing further.
- Remove the flag from its type, its JSDoc and its comment, in the same commit.
- A spread (`run({ ...options })`) can pass a flag the sensor cannot see. Follow every spread into the function before deleting; if one can carry it, decline it and name the spread.
- A comment beside the flag saying why it exists for a case not yet built is Tom's reason, not dead code: decline it and quote the comment.
