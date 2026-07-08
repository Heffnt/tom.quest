// Shared display-label logic for a frequency id.
//
// Named frequencies display as their own id (they're already human names);
// fundamentals display as their school name, falling back to the raw id if
// somehow unknown. Duplicated as `frequencyName` (brew-graph.tsx), `freqLabel`
// (frequency-filter.tsx), and inline in `DecompCard` (frequencies.tsx) — this
// is the one implementation.

import { FUND, isNamed } from "../data/base";

export function frequencyLabel(id: string): string {
  return isNamed(id) ? id : (FUND[id]?.school ?? id);
}
