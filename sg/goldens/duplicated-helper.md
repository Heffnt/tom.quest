# duplicated-helper — the after-state

The same function body is written in two or more files. After the removal it
is written once, in the module the copies' callers already share or in the
nearest one both can import without a cycle, and every former copy imports it.

Before:

```ts
// app/boolback/components/plot-panel.tsx
function tickFmt(v: number): string {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, "");
  if (a >= 0.01) return v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return v.toExponential(0);
}

// app/boolback/components/plot-surface.tsx and group-plot.tsx — the same body again
```

After (the shared home named here is an example; use the nearest real one):

```ts
// app/boolback/lib/format.ts
export function tickFmt(v: number): string {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, "");
  if (a >= 0.01) return v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return v.toExponential(0);
}

// app/boolback/components/plot-panel.tsx
import { tickFmt } from "../lib/format";
```

- Keep the copy whose home is already shared; move it only when no shared home exists.
- The kept body is byte-for-byte one of the copies. A removal is not a rewrite: no renamed variables, no "while I was here".
- If the copies differ by one closed-over name (a cache, a table), the shared function takes it as a parameter, and nothing else changes.
- A copy that exists because the two files run in different places — the Convex runtime and the box, a `"use node"` file and a plain one, a zero-dependency job in /opt/tts — cannot share an import. Decline it (see the prompt): remove nothing and open no pull request.
