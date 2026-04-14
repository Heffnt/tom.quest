export type Quest = {
  slug: string;       // "turing" → tom.quest/turing
  title: string;
  blurb: string;
  glyph: string;
  priority: number;   // higher = preferred in autocomplete tie-breaks
};

export const QUESTS: Quest[] = [
  { slug: "turing", title: "Turing", blurb: "SLURM cluster + GPU monitor",  glyph: "⌬", priority: 10 },
  { slug: "jarvis", title: "Jarvis", blurb: "Personal AI assistant",        glyph: "◈", priority: 5 },
  { slug: "bio",    title: "Bio",    blurb: "About Tom",                    glyph: "◉", priority: 1 },
];

// rankQuests: orders the quest list for display + autocomplete.
//
// Empty query → all quests, best first.
// Non-empty query → prefix matches first, then substring matches.
// Ties are broken by the `priority` field on each Quest.
//
// TODO(tom): decide if you want tie-breaks to use:
//   - priority (manual ranking — what this does now; predictable, static)
//   - recent use (localStorage: last-visited timestamp; feels smart, adapts)
//   - frequency (localStorage: visit counts; rewards your real habits)
//   - alphabetical (boring but fair)
// Recommendation: start with priority since your tool list is small and
// you already know what you'll use most. Swap in frequency once you have 10+.
export function rankQuests(query: string, quests: Quest[] = QUESTS): Quest[] {
  const q = query.trim().toLowerCase();
  const byPriority = (a: Quest, b: Quest) => b.priority - a.priority;
  if (!q) return [...quests].sort(byPriority);
  const prefix    = quests.filter((x) => x.slug.toLowerCase().startsWith(q));
  const substring = quests.filter((x) => !x.slug.toLowerCase().startsWith(q) && x.slug.toLowerCase().includes(q));
  return [...prefix.sort(byPriority), ...substring.sort(byPriority)];
}

export function isValidSlug(s: string): boolean {
  return QUESTS.some((q) => q.slug === s.trim().toLowerCase());
}
