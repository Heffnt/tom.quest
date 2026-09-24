// Prose — sentences of fact, with Num inside (principle 5: a sentence states a
// fact; nothing on a page explains). Its numbers carry a caption.

import type { ReactNode } from "react";
import QueryCaption from "./query-caption";

export default function Prose({
  title,
  children,
  caption,
}: {
  /** The sentences' heading, when they stand as a section of their own. */
  title?: string;
  children: ReactNode;
  caption: string;
}) {
  return (
    <div className="tb-block">
      {title && <h2 className="tb-title">{title}</h2>}
      <p className="tb-prose">{children}</p>
      <QueryCaption text={caption} />
    </div>
  );
}
