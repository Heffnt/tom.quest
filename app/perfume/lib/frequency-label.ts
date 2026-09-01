// Shared display-label logic for a frequency id.
//
// Named frequencies display as their own id (they're already human names);
// fundamentals display as their school name, falling back to the raw id if
// somehow unknown. This is the one implementation; the two labellers that wrap
// it — `freqLabel` (frequency-search.tsx), which handles the strike/wild charge
// chips and "type:*" filter values first, and `DecompCard` (frequencies.tsx) —
// delegate here for the frequency case rather than repeating this rule.

import { FUND, isNamed } from "../data/base";

export function frequencyLabel(id: string): string {
  return isNamed(id) ? id : (FUND[id]?.school ?? id);
}
