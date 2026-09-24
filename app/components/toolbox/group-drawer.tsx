"use client";

// GroupDrawer — principle 2: the members of one group, ten at a time. It ends
// with "and N more" (the group's count less what is on screen), which shows
// the next ten when the drawer holds them. It sits fixed in the side column at
// wide widths and in flow below the main column at narrow ones (toolbox.css).

import { useState } from "react";
import { LIST_CAP } from "./caps";
import Num from "./num";
import QueryCaption from "./query-caption";

type Member = { id: string; primary: string; secondary?: string };

export default function GroupDrawer({
  title,
  count,
  members,
  onPick,
  caption,
}: {
  title: string;
  count: number;
  members: readonly Member[];
  onPick?: (id: string) => void;
  caption: string;
}) {
  // The page it is on, reset when the drawer is handed another group.
  const [paged, setPaged] = useState({ title, start: 0 });
  const start = paged.title === title ? paged.start : 0;
  const shown = members.slice(start, start + LIST_CAP);
  const more = Math.max(0, count - start - shown.length);
  const canPage = start + LIST_CAP < members.length;

  return (
    <section className="tb-drawer" aria-label={title}>
      <div className="tb-drawer-head">
        <h2 className="tb-title">{title}</h2>
        <Num>{count}</Num>
      </div>
      <ul className={`tb-drawer-list${count > LIST_CAP ? " is-paged" : ""}`}>
        {shown.map((m) => (
          <li key={m.id}>
            {onPick ? (
              <button type="button" className="tb-member is-clickable" onClick={() => onPick(m.id)}>
                <span className="tb-member-primary">{m.primary}</span>
                {m.secondary && <span className="tb-member-secondary">{m.secondary}</span>}
              </button>
            ) : (
              <div className="tb-member">
                <span className="tb-member-primary">{m.primary}</span>
                {m.secondary && <span className="tb-member-secondary">{m.secondary}</span>}
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="tb-drawer-foot">
        {more > 0 &&
          (canPage ? (
            <button
              type="button"
              className="tb-link"
              onClick={() => setPaged({ title, start: start + LIST_CAP })}
            >
              and <Num>{more}</Num> more
            </button>
          ) : (
            <span>
              and <Num>{more}</Num> more
            </span>
          ))}
        {start > 0 && (
          <button type="button" className="tb-link" onClick={() => setPaged({ title, start: 0 })}>
            the first ten
          </button>
        )}
      </div>
      <QueryCaption text={caption} />
    </section>
  );
}
