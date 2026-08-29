"use client";

// Picker row over the paths: one chip per path (name + how many batches
// remain in it); the selected path's batches render below in path order.
export type PathChip = { name: string; count: number };

export default function PathsBar({
  paths,
  selected,
  onSelect,
}: {
  paths: PathChip[];
  selected: string;
  onSelect: (name: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {paths.map((p) => {
        const on = p.name === selected;
        return (
          <button
            key={p.name}
            type="button"
            onClick={() => onSelect(p.name)}
            className={`rounded-md border px-2.5 py-1 text-xs ${
              on
                ? "border-accent/60 bg-accent-dim text-text"
                : "border-border bg-surface text-text-muted hover:text-text"
            }`}
          >
            {p.name}
            <span className={`ml-1.5 ${on ? "text-accent" : "text-text-faint"}`}>
              {p.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
