/**
 * Helpers for surgically editing THCC source from the IO panel inputs:
 * read or rewrite the literal initialiser of a top-level `int NAME = N;`
 * declaration without touching anything else.
 */

function literalRegex(varName: string): RegExp {
  // Anchored to start-of-line so we don't accidentally match a sub-expression
  // like `int foo = a + 4;` when the user asks for `a`.
  return new RegExp(`^(\\s*int\\s+${escape(varName)}\\s*=\\s*)(-?\\d+)(\\s*;)`, "m");
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Read the literal value of `int NAME = N;` from source. Returns null if
 * the variable isn't found or its initialiser isn't a bare integer literal.
 */
export function readVarLiteral(source: string, varName: string): number | null {
  const m = source.match(literalRegex(varName));
  if (!m) return null;
  const n = parseInt(m[2], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Replace the literal value of `int NAME = N;` in source. Returns the
 * unchanged source if the declaration isn't a bare integer literal.
 */
export function writeVarLiteral(source: string, varName: string, value: number): string {
  return source.replace(literalRegex(varName), (_m, lhs, _old, rhs) => `${lhs}${value}${rhs}`);
}
