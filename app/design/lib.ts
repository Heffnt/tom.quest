// The design page's pure helper: which parts a list filter keeps. Times are
// shared/clock.mjs's, in New York.

import type { RegistryRow } from "@/convex/jarvis/design";
import { removedStillRun, servesOnlyOutcomes } from "@/shared/parts-drawing.mjs";
import type { ListFilter } from "./store";

/** Whether a part stays in the list under a filter. */
export function keeps(filter: ListFilter, row: RegistryRow, state: string | undefined): boolean {
  if (filter === "unverified") return state === "unverified";
  if (filter === "issue") return state === "issue";
  if (filter === "partial") return state === "partial";
  if (filter === "removed-still-run") return removedStillRun(row);
  if (filter === "no-sentence") return servesOnlyOutcomes(row);
  return true;
}
