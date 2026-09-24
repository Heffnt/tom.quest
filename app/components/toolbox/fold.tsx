// Fold — principle 2: what does not fit in ten stays folded, closed by
// default. Its count is how many it holds, drawn from the query of the
// component it sits in, which carries the caption.

import type { ReactNode } from "react";
import Num from "./num";

export default function Fold({
  summary,
  count,
  children,
}: {
  summary: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <details className="tb-fold">
      <summary>
        {summary} <Num>{count}</Num>
      </summary>
      <div className="tb-fold-body">{children}</div>
    </details>
  );
}
