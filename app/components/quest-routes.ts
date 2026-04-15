export type Quest = {
  slug: string;       // "turing" → tom.quest/turing
  title: string;
  blurb: string;
  priority: number;   // higher = preferred in autocomplete tie-breaks
};

export const QUESTS: Quest[] = [
  { slug: "turing", title: "Turing", blurb: "SLURM cluster + GPU monitor",  priority: 10 },
  { slug: "jarvis", title: "Jarvis", blurb: "Personal AI assistant",        priority: 5 },
  { slug: "bio",    title: "Bio",    blurb: "About Tom",                    priority: 1 },
];

// rankQuests: orders the quest list for display + autocomplete.
// Empty query → all quests, best first.
// Non-empty query → prefix matches first, then substring matches.
// Ties break on `priority`.
//
// TODO(tom): swap in recency/frequency tracking from localStorage when you
// have 10+ routes. Signature stays the same; only the body changes.
export function rankQuests(query: string, quests: Quest[] = QUESTS): Quest[] {
  const q = query.trim().toLowerCase();
  const byPriority = (a: Quest, b: Quest) => b.priority - a.priority;
  if (!q) return [...quests].sort(byPriority);
  const prefix    = quests.filter((x) => x.slug.toLowerCase().startsWith(q));
  const substring = quests.filter((x) => !x.slug.toLowerCase().startsWith(q) && x.slug.toLowerCase().includes(q));
  return [...prefix.sort(byPriority), ...substring.sort(byPriority)];
}
