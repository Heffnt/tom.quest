// ItemPanel — principle 3: one thing Tom rules on, whole and in order: its
// statement exactly as written, where it came from, its brief, its first step,
// then the verdicts (children, an ActionRow).

import type { ReactNode } from "react";

export default function ItemPanel({
  statement,
  provenance,
  brief,
  firstStep,
  children,
}: {
  statement: string;
  provenance: string;
  brief?: string;
  firstStep?: string;
  children: ReactNode;
}) {
  return (
    <article className="tb-item">
      <h2 className="tb-item-statement">{statement}</h2>
      <p className="tb-item-provenance">{provenance}</p>
      {brief && (
        <section className="tb-item-section">
          <h3>brief</h3>
          <p className="tb-item-text">{brief}</p>
        </section>
      )}
      {firstStep && (
        <section className="tb-item-section">
          <h3>first step</h3>
          <p className="tb-item-text">{firstStep}</p>
        </section>
      )}
      {children}
    </article>
  );
}
