"use client";

// WHAT A HEAD DOES TO THE REGISTRY: /design?head=<repo>@<sha>. The diff is the
// one the box posted on the head's tests row; the base is the registry the box
// posted at the diff's base commit, else the newest one, and the caption says
// which. Each row is styled by the diff alone.

import { useMemo } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import PartsDrawing, { type Drawing } from "@/app/components/parts-drawing";
import { diffDiagram } from "@/shared/parts-drawing.mjs";

type DiffAnswer = FunctionReturnType<typeof api.jarvis.design.diff>;

export default function DiffView({ head, answer, onSelect }: { head: string; answer: DiffAnswer | undefined; onSelect: (id: string) => void }) {
  const drawn = useMemo(() => {
    if (!answer || answer.base === null) return null;
    const { diagram } = diffDiagram(answer.base.parts, answer.registryDiff, { head: answer.head });
    return diagram as Drawing;
  }, [answer]);

  if (answer === undefined) return <p className="text-[12px] text-text-faint">…</p>;
  if (answer === null || answer.base === null || drawn === null) {
    return <p className="text-[13px] text-text-muted">no registry diff for {head}</p>;
  }
  const { registryDiff, base } = answer;
  const rowsOf = (ids: string[], word: string) =>
    ids.map((id) => {
      const row = registryDiff.rows[id] ?? base.parts.find((p) => p.id === id);
      return { id, word, name: (row?.name as string | undefined) ?? id, file: (row?.file as string | null | undefined) ?? null };
    });
  const listed = [...rowsOf(registryDiff.added, "added"), ...rowsOf(registryDiff.changed, "changed"), ...rowsOf(registryDiff.removed, "removed")];

  return (
    <section>
      <h2 className="text-[15px] font-semibold text-text">{drawn.title}</h2>
      <div className="mt-2 overflow-x-auto">
        <div className="min-w-[var(--w)] sm:min-w-0" style={{ "--w": `${Math.max(...drawn.nodes.map((n) => n.x + n.w)) + 16}px` } as React.CSSProperties}>
          <PartsDrawing diagram={drawn} onSelect={onSelect} />
        </div>
      </div>
      <p className="mt-1 text-[12px] text-text-faint">
        {drawn.caption}
        {!answer.baseIsExact && ` The base drawn is the newest registry, ${base.subject}, since the record holds none at ${registryDiff.base.slice(0, 7)}.`}
      </p>
      <ul className="mt-3 space-y-0.5">
        {listed.map((row) => (
          <li key={row.id}>
            <button type="button" onClick={() => onSelect(row.id)} className="w-full rounded px-1 text-left text-[12px] text-text-muted hover:bg-surface">
              <span className="text-text">{row.name}</span> · {row.word}
              {row.file !== null && <span className="font-mono text-[11px] text-text-faint"> · {row.file}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
