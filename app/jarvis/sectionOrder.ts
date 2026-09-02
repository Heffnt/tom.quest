/**
 * The one home for the Jarvis Today section list and per-section layout.
 *
 * Both sides of the Today round-trip read from here: the server route
 * (app/api/jarvis/today/route.ts) that reads and writes memory/<day>.md, and
 * the "use client" component (app/jarvis/components/TodayTab.tsx) that renders
 * the form. They used to hold two hand-kept copies of the same ten names, so
 * renaming a section on one side silently desynchronized the other.
 *
 * DANGER: keep this module a leaf — no imports at all, and never import the
 * route here or there. app/api/jarvis/today/route.ts pulls in next/server,
 * node:fs and requireTom; importing it from a "use client" component drags all
 * of that into the browser bundle and breaks the build.
 */

/** The ten headings the Today tab renders, in the order it renders them. */
export const DEFAULT_SECTION_ORDER: readonly string[] = [
  "Sleep",
  "Activities",
  "Meals",
  "Mood / Feeling",
  "Exercise / Body",
  "Social",
  "Substances",
  "Pending / Follow-ups",
  "Notes",
  "Evening Reconstruction",
];

/** Sections whose textarea renders at TALL_SECTION_ROWS instead of SECTION_ROWS. */
export const TALL_SECTIONS: ReadonlySet<string> = new Set([
  "Activities",
  "Notes",
  "Evening Reconstruction",
]);

export const SECTION_ROWS = 6;
export const TALL_SECTION_ROWS = 10;

/**
 * Textarea height for one section. Any heading not named above — including a
 * heading Tom added to memory/<day>.md by hand — gets SECTION_ROWS rather than
 * an undefined height.
 */
export function sectionRows(section: string): number {
  return TALL_SECTIONS.has(section) ? TALL_SECTION_ROWS : SECTION_ROWS;
}
