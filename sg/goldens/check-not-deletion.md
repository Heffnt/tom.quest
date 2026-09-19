# check-not-deletion — the after-state

A guard repeats a guard that already settled the same condition: `a && a`,
`a || a`, `a ? a : a`, an `if` whose first statement tests the same
condition again, or an `if` straight after one with the same condition that
returned or threw. The second test cannot come out differently from the first.
After the removal the condition is tested once.

Before:

```ts
if (row.key !== undefined) {
  if (row.key !== undefined) seen.add(row.key);
}
```

After:

```ts
if (row.key !== undefined) seen.add(row.key);
```

- The condition must be free of side effects and of calls whose answer can change: `next() && next()` is two different calls, not a repeated guard. If it is one of those, decline it.
- Keep the first test, delete the second, and keep every statement the second one guarded.
