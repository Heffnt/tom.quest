// Every field here has a reader. A `title` field lived here on all fifteen rows
// and was never rendered: both renderers of rankPages (app/components/nav-term.tsx,
// app/home-client.tsx) print slug + blurb, so it was deleted. Do not add a field
// before the code that reads it.
export type Page = {
  slug: string;       // "turing" -> tom.quest/turing
  blurb: string;
  priority: number;   // higher = preferred in autocomplete tie-breaks
  visibility: PageVisibility;
  /**
   * Visible to the read-only `agent` role — the account a TTS session signs in
   * as to LOOK at a page it just changed. Deliberately its own flag and not a
   * `visibility` value: `agent` is not a rank on the guest→user→admin→tom
   * ladder, so it cannot be expressed by widening that ladder. Absent means
   * closed, so a page added later is closed until someone says otherwise.
   * The Convex-side twin of this flag is convex/agentSurfaces.ts.
   */
  agentReadable?: boolean;
};

export type PageVisibility = "public" | "authenticated" | "admin" | "tom";
export type PageRole = "guest" | "user" | "admin" | "tom" | "agent";

export const PAGES: Page[] = [
  { slug: "turing",      blurb: "SLURM cluster + GPU monitor",                    priority: 10, visibility: "admin", agentReadable: true },
  { slug: "canvas",      blurb: "Chat-driven HTML canvas",                        priority: 8,  visibility: "authenticated" },
  { slug: "transformer", blurb: "Drill into a live transformer, layer by layer",  priority: 7,  visibility: "public" },
  { slug: "thmm",        blurb: "Tiny CPU simulator + datapath",                  priority: 6,  visibility: "public" },
  { slug: "clouds",      blurb: "Interactive LiDAR viewer",                       priority: 6,  visibility: "public" },
  { slug: "perfume",     blurb: "Three Feifs perfumer's bench",                   priority: 6,  visibility: "public" },
  { slug: "sessions",    blurb: "TTS — Claude Code session surface",              priority: 9,  visibility: "tom" },
  { slug: "tts",         blurb: "Tom's Todo System",                              priority: 9,  visibility: "tom", agentReadable: true },
  { slug: "forge",       blurb: "Build & train backdoors",                        priority: 5,  visibility: "tom" },
  { slug: "jarvis",      blurb: "Personal AI assistant",                          priority: 5,  visibility: "tom" },
  { slug: "logo",        blurb: "tom.Quest brand lab",                            priority: 5,  visibility: "tom" },
  { slug: "game",        blurb: "Symbol-shooting mini-game",                      priority: 4,  visibility: "public" },
  { slug: "bio",         blurb: "About Tom",                                      priority: 3,  visibility: "public" },
  { slug: "boolback",    blurb: "Boolean-backdoor artifact-tree explorer",        priority: 2,  visibility: "public" },
  { slug: "help",        blurb: "How tom.quest works",                            priority: 1,  visibility: "public" },
];

export function canSeePage(role: PageRole, page: Page): boolean {
  // `agent` reads ONLY its own flag and never falls through to the rank
  // ladder below. In particular it does not inherit "authenticated", which is
  // what keeps /canvas — whose agent route spends LLM credits — shut to it.
  // The list a TTS session sees is therefore exactly the pages it must look
  // at, which is the whole reason the role exists.
  if (role === "agent") return page.agentReadable === true;
  if (page.visibility === "public") return true;
  if (page.visibility === "authenticated") return role !== "guest";
  if (page.visibility === "admin") return role === "admin" || role === "tom";
  return role === "tom";
}

// rankPages: orders the page list for display + autocomplete.
// Empty query -> all pages, best first.
// Non-empty query -> prefix matches first, then substring matches.
// Ties break on `priority`.
//
// TODO(tom): swap in recency/frequency tracking through persisted settings when
// you have 10+ routes. Signature stays the same; only the body changes.
export function rankPages(query: string, role: PageRole = "guest", pages: Page[] = PAGES): Page[] {
  const q = query.trim().toLowerCase();
  const visible = pages.filter((page) => canSeePage(role, page));
  const byPriority = (a: Page, b: Page) => b.priority - a.priority;
  if (!q) return [...visible].sort(byPriority);
  const prefix    = visible.filter((x) => x.slug.toLowerCase().startsWith(q));
  const substring = visible.filter((x) => !x.slug.toLowerCase().startsWith(q) && x.slug.toLowerCase().includes(q));
  return [...prefix.sort(byPriority), ...substring.sort(byPriority)];
}
