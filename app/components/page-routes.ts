import { canSee, type PageRole, type PageSlug } from "@/convex/pageAccess";

// The page list the home page and navigation autocomplete render. Who may see
// each page is not here: it is the page's row in convex/pageAccess.ts, which
// Convex's gates read too.
export type Page = {
  slug: PageSlug;     // "turing" -> tom.quest/turing
  title: string;
  blurb: string;
  priority: number;   // higher = preferred in autocomplete tie-breaks
};

export const PAGES: Page[] = [
  { slug: "turing", title: "Turing", blurb: "SLURM cluster + GPU monitor",  priority: 10 },
  { slug: "canvas", title: "Canvas", blurb: "Chat-driven HTML canvas",      priority: 8 },
  { slug: "transformer", title: "Transformer", blurb: "Drill into a live transformer, layer by layer", priority: 7 },
  { slug: "thmm",   title: "THMM",   blurb: "Tiny CPU simulator + datapath", priority: 6 },
  { slug: "clouds", title: "Clouds", blurb: "Interactive LiDAR viewer",     priority: 6 },
  { slug: "perfume", title: "Perfume", blurb: "Three Feifs perfumer's bench", priority: 6 },
  { slug: "agents", title: "Agents", blurb: "Every agent, and everything that ran, by window", priority: 9 },
  { slug: "jarvis", title: "Jarvis", blurb: "Todos, calendar and what waits on a ruling", priority: 9 },
  { slug: "intent", title: "Intent", blurb: "His intent as an agent reads it, what each line rests on, the vocabulary, and what stands until he objects", priority: 8 },
  { slug: "log", title: "Log", blurb: "Private day entries and their recorded measures", priority: 8 },
  { slug: "forge",  title: "Forge",  blurb: "Build & train backdoors",      priority: 5 },
  { slug: "questions", title: "Questions", blurb: "One question at a time, by kind, frame and topic", priority: 5 },
  { slug: "logo",   title: "Logo",   blurb: "tom.Quest brand lab",          priority: 5 },
  { slug: "secrets", title: "Secrets", blurb: "Values for the Jarvis Box", priority: 5 },
  { slug: "game",   title: "Game",   blurb: "Symbol-shooting mini-game",    priority: 4 },
  { slug: "bio",    title: "Bio",    blurb: "About Tom",                    priority: 3 },
  { slug: "boolback", title: "Boolback", blurb: "Boolean-backdoor artifact-tree explorer", priority: 2 },
  { slug: "help",   title: "Help",   blurb: "How tom.quest works",          priority: 1 },
];

// rankPages: orders the pages the role may see for display + autocomplete.
// Empty query -> all pages, best first.
// Non-empty query -> prefix matches first, then substring matches.
// Ties break on `priority`.
//
// TODO(tom): swap in recency/frequency tracking through persisted settings when
// you have 10+ routes. Signature stays the same; only the body changes.
export function rankPages(query: string, role: PageRole = "guest", pages: Page[] = PAGES): Page[] {
  const q = query.trim().toLowerCase();
  const visible = pages.filter((page) => canSee(role, page.slug));
  const byPriority = (a: Page, b: Page) => b.priority - a.priority;
  if (!q) return [...visible].sort(byPriority);
  const prefix    = visible.filter((x) => x.slug.toLowerCase().startsWith(q));
  const substring = visible.filter((x) => !x.slug.toLowerCase().startsWith(q) && x.slug.toLowerCase().includes(q));
  return [...prefix.sort(byPriority), ...substring.sort(byPriority)];
}
