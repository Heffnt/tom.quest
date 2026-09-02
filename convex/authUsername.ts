// The one definition of what a tom.quest username IS, and the one derivation
// of the account address it becomes.
//
// THE RULE: an account's identity is its username lowercased with every
// character that is not a-z or 0-9 removed. "Tom", "tom", "T-O-M" and " tom "
// are therefore the same account. The account row is then found by the
// synthetic email `${normalized}@tom.quest`, which is what the users table's
// "email" index holds — sign-up writes it (convex/auth.ts) and every lookup by
// typed name reads it (convex/users.ts).
//
// WHY IT LIVES ALONE IN A FILE: before this, the rule existed in four places —
// convex/auth.ts, a byte-identical private copy in app/components/login-modal.tsx,
// and inlined twice in convex/users.ts. Nothing compared them. Reordering the
// two steps in one copy (strip first, then lowercase) turns "Tom" into "om"
// there and nowhere else, which is not a type error, not a runtime error, and
// not a failing test: it is a login that silently matches a different account
// or no account. scripts/check-auth-boundary.mjs now fails the build if that
// rule is spelled anywhere but here, the same way it already fences the
// admin-role check into convex/authRoles.ts.
//
// WHY THIS FILE IMPORTS NOTHING: it is read by Convex functions and by a
// browser component (the login widget validates the typed name before sending
// it). A single import of server code here would drag that code into the
// browser bundle — the same reason convex/agentSurfaces.ts imports nothing.
// This is also why the rule does not live in convex/auth.ts itself: that
// module calls convexAuth() at load time and cannot be imported by the client.

/** The domain half of every account address. Accounts are not email-bearing;
 *  this suffix exists only to give the users table's "email" index a key. */
export const ACCOUNT_EMAIL_DOMAIN = "tom.quest";

/**
 * The canonical form of a typed username: lowercase, then strip everything
 * outside a-z and 0-9. Returns "" when nothing survives, which every caller
 * treats as "not a usable username".
 *
 * The order matters and is load-bearing: lowercase FIRST, because the strip
 * pattern only admits lowercase letters. Stripping first would delete every
 * capital letter instead of folding it.
 */
export function normalizeUsername(username: string): string {
  return username.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The account address a typed username resolves to — the value stored in the
 * users table's "email" field and looked up through its "email" index.
 * Returns null when the username normalizes to nothing, so a caller cannot
 * accidentally query for "@tom.quest".
 */
export function accountEmail(username: string): string | null {
  const normalized = normalizeUsername(username);
  if (!normalized) return null;
  return `${normalized}@${ACCOUNT_EMAIL_DOMAIN}`;
}
