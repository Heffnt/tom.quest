// Num — a number inside a sentence, in IBM Plex Mono (principle 7: mono only
// for numbers, ids and code).

import type { ReactNode } from "react";

export default function Num({ children }: { children: ReactNode }) {
  return <span className="tb-num">{children}</span>;
}
