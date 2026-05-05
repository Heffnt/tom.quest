export type Quest = {
  slug: string;       // "turing" -> tom.quest/turing
  title: string;
  blurb: string;
  priority: number;   // higher = preferred in autocomplete tie-breaks
  visibility: QuestVisibility;
};

export type QuestVisibility = "public" | "authenticated" | "admin" | "tom";
export type QuestRole = "guest" | "user" | "admin" | "tom";

export const QUESTS: Quest[] = [
  { slug: "turing", title: "Turing", blurb: "SLURM cluster + GPU monitor",  priority: 10, visibility: "admin" },
  { slug: "thmm",   title: "THMM",   blurb: "Tiny CPU simulator + datapath", priority: 6, visibility: "public" },
  { slug: "clouds", title: "Clouds", blurb: "Interactive LiDAR viewer",     priority: 6, visibility: "public" },
  { slug: "jarvis", title: "Jarvis", blurb: "Personal AI assistant",        priority: 5, visibility: "tom" },
  { slug: "logo",   title: "Logo",   blurb: "tom.Quest brand lab",          priority: 5, visibility: "tom" },
  { slug: "game",   title: "Game",   blurb: "Symbol-shooting mini-game",    priority: 4, visibility: "public" },
  { slug: "bio",    title: "Bio",    blurb: "About Tom",                    priority: 3, visibility: "public" },
  { slug: "help",   title: "Help",   blurb: "How tom.quest works",          priority: 1, visibility: "public" },
];

function canSeeQuest(role: QuestRole, quest: Quest): boolean {
  if (quest.visibility === "public") return true;
  if (quest.visibility === "authenticated") return role !== "guest";
  if (quest.visibility === "admin") return role === "admin" || role === "tom";
  return role === "tom";
}

// rankQuests: orders the quest list for display + autocomplete.
// Empty query → all quests, best first.
// Non-empty query → prefix matches first, then substring matches.
// Ties break on `priority`.
//
// TODO(tom): swap in recency/frequency tracking from localStorage when you
// have 10+ routes. Signature stays the same; only the body changes.
export function rankQuests(query: string, role: QuestRole = "guest", quests: Quest[] = QUESTS): Quest[] {
  const q = query.trim().toLowerCase();
  const visible = quests.filter((quest) => canSeeQuest(role, quest));
  const byPriority = (a: Quest, b: Quest) => b.priority - a.priority;
  if (!q) return [...visible].sort(byPriority);
  const prefix    = visible.filter((x) => x.slug.toLowerCase().startsWith(q));
  const substring = visible.filter((x) => !x.slug.toLowerCase().startsWith(q) && x.slug.toLowerCase().includes(q));
  return [...prefix.sort(byPriority), ...substring.sort(byPriority)];
}
