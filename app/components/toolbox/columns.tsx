// Columns — a main column and a 380 px side column at 1340 px and wider; below
// that the side stacks under the main. A page lays itself out with this and
// nothing else.

import type { ReactNode } from "react";

export default function Columns({ main, side }: { main: ReactNode; side: ReactNode }) {
  return (
    <div className="tb-columns">
      <div className="tb-main">{main}</div>
      <aside className="tb-side">{side}</aside>
    </div>
  );
}
