// PageHead — principle 1: a page opens with its name and one sentence of state
// with its counts. The sentence holds numbers, so it carries its caption.

import type { ReactNode } from "react";
import QueryCaption from "./query-caption";

export default function PageHead({
  name,
  sentence,
  caption,
}: {
  name: string;
  sentence: ReactNode;
  caption: string;
}) {
  return (
    <header className="tb-head">
      <h1 className="tb-head-name">{name}</h1>
      <p className="tb-head-sentence">{sentence}</p>
      <QueryCaption text={caption} />
    </header>
  );
}
