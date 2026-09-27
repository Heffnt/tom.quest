"use client";

// The frame's left drawer on /tts: what awaits Tom and the overdue todos,
// each a row naming its statement; pressing a todo's row selects it, and the
// right drawer shows it whole. A code todo awaiting him is listed by its
// statement and is not a dtsTodos row, so it has no detail yet. The rows come
// from the same selectors as the left handle's counts (tts-client.tsx), so a
// count and its list cannot drift.

import type { Id } from "@/convex/_generated/dataModel";

export type ListRow = { key: string; statement: string; todoId?: Id<"dtsTodos"> };

function Section({
  name,
  tone,
  rows,
  selected,
  onSelect,
}: {
  name: string;
  tone: string;
  rows: readonly ListRow[];
  selected: Id<"dtsTodos"> | null;
  onSelect: (id: Id<"dtsTodos">) => void;
}) {
  return (
    <section>
      <h3 className="sticky top-0 flex h-row-dense items-center gap-2 border-b border-border bg-bg px-3 text-[12px] font-semibold text-text-muted">
        {name}
        <span className={`font-mono font-normal ${tone}`}>{rows.length}</span>
      </h3>
      <ul>
        {rows.map((r) => {
          const id = r.todoId;
          return (
            // A row off screen skips layout: the lists run past a thousand
            // rows, and without this every frame of a drawer drag re-lays
            // them all out (40-100 ms each on the box).
            <li key={r.key} className="[contain-intrinsic-size:auto_24px] [content-visibility:auto]">
              {id ? (
                <button
                  type="button"
                  aria-current={selected === id}
                  onClick={() => onSelect(id)}
                  className={`flex h-row-dense w-full items-center px-3 text-left text-[13px] hover:bg-surface-alt ${
                    selected === id ? "bg-surface-alt text-text" : "text-text-muted"
                  }`}
                >
                  <span className="truncate">{r.statement}</span>
                </button>
              ) : (
                <p className="flex h-row-dense items-center px-3 text-[13px] text-text-faint">
                  <span className="truncate">{r.statement}</span>
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function TodoLists({
  awaiting,
  overdue,
  selected,
  onSelect,
}: {
  awaiting: readonly ListRow[];
  overdue: readonly ListRow[];
  selected: Id<"dtsTodos"> | null;
  onSelect: (id: Id<"dtsTodos">) => void;
}) {
  return (
    <div>
      <Section name="overdue" tone="text-error" rows={overdue} selected={selected} onSelect={onSelect} />
      <Section name="awaiting" tone="text-accent" rows={awaiting} selected={selected} onSelect={onSelect} />
    </div>
  );
}
