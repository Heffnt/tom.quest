// Who may see each page: the one table the page list, the page render and
// every Convex and route gate read.
//
// ONE ROW PER PAGE SLUG (tom.quest/{slug}):
//   - `visibility` places the page on the ladder guest → user → admin → tom:
//     "public" admits everyone, "authenticated" every signed-in role on the
//     ladder, "admin" admin and tom, "tom" tom alone.
//   - `agentReadable: true` lets the `agent` role read the page. `agent` is
//     the account a TTS session's headless browser signs in as; it is not on
//     the ladder and inherits none of it, so a row without the flag is closed
//     to it whatever its visibility (that is what keeps /canvas, whose agent
//     route spends model credits, shut to it).
//   - `label` is the page's name in a refusal: the restricted card
//     ("TTS access is restricted to Tom.") and the Convex error.
//
// canSee(role, slug) is the one check. A Convex gate names a page slug and a
// kind: requireTomOrAgent (a read) admits a role that is tom or agent AND
// passes canSee; requireTom (a write) admits tom alone. So changing who may
// read a page is a change to its row here plus, in Convex, the gate's kind.
//
// WHY THIS FILE IMPORTS NOTHING: Convex functions, Next.js route handlers,
// client components and tests all read it, and a single import of server code
// here would drag that code into the browser bundle.

export type PageVisibility = "public" | "authenticated" | "admin" | "tom";

/** Every role a viewer can hold; `guest` is signed out. */
export type PageRole = "guest" | "user" | "admin" | "tom" | "agent";

export type PageAccess = {
  visibility: PageVisibility;
  agentReadable?: true;
  label: string;
};

export const PAGE_ACCESS = {
  turing: { visibility: "admin", agentReadable: true, label: "Turing" },
  canvas: { visibility: "authenticated", label: "Canvas" },
  transformer: { visibility: "public", label: "Transformer" },
  thmm: { visibility: "public", label: "THMM" },
  clouds: { visibility: "public", label: "Clouds" },
  perfume: { visibility: "public", label: "Perfume" },
  agents: { visibility: "tom", label: "Agents" },
  jarvis: { visibility: "tom", agentReadable: true, label: "TTS" },
  intent: { visibility: "tom", label: "Intent" },
  log: { visibility: "tom", label: "Log" },
  forge: { visibility: "tom", label: "Forge" },
  questions: { visibility: "tom", label: "Questions" },
  logo: { visibility: "tom", label: "Logo" },
  secrets: { visibility: "tom", label: "Secrets" },
  game: { visibility: "public", label: "Game" },
  bio: { visibility: "public", label: "Bio" },
  boolback: { visibility: "public", label: "Boolback" },
  help: { visibility: "public", label: "Help" },
} as const satisfies Record<string, PageAccess>;

export type PageSlug = keyof typeof PAGE_ACCESS;

// The ladder: each visibility is the lowest rung that may see the page.
const RUNG = { guest: 0, user: 1, admin: 2, tom: 3 } as const;
const LOWEST_RUNG: Record<PageVisibility, number> = { public: 0, authenticated: 1, admin: 2, tom: 3 };

export function canSee(role: PageRole, slug: PageSlug): boolean {
  const page: PageAccess = PAGE_ACCESS[slug];
  if (role === "agent") return page.agentReadable === true;
  return RUNG[role] >= LOWEST_RUNG[page.visibility];
}
