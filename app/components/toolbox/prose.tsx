// Prose — sentences of fact, with Num inside (principle 5: a sentence states a
// fact; nothing on a page explains). Its numbers carry a caption.

import type { ReactNode } from "react";
import QueryCaption from "./query-caption";

export default function Prose({ children, caption }: { children: ReactNode; caption: string }) {
  return (
    <div className="tb-block">
      <p className="tb-prose">{children}</p>
      <QueryCaption text={caption} />
    </div>
  );
}
