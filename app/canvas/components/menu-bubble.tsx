"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type CanvasRow = {
  _id: Id<"canvases">;
  name: string;
  updatedAt: number;
  createdAt: number;
};

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const ageMs = now - ts;
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3600_000)}h ago`;
  return d.toLocaleDateString();
}

export default function MenuBubble({
  canvases,
  activeCanvasId,
  onSelect,
}: {
  canvases: CanvasRow[];
  activeCanvasId: Id<"canvases">;
  onSelect: (id: Id<"canvases">) => void;
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<Id<"canvases"> | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const create = useMutation(api.canvas.create);
  const rename = useMutation(api.canvas.rename);
  const duplicate = useMutation(api.canvas.duplicate);
  const remove = useMutation(api.canvas.remove);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onCreate = async () => {
    const { canvasId } = await create({});
    onSelect(canvasId);
    setOpen(false);
  };

  const onConfirmRename = async (id: Id<"canvases">) => {
    const name = renameValue.trim();
    if (name) await rename({ id, name });
    setRenaming(null);
    setRenameValue("");
  };

  const onDelete = async (id: Id<"canvases">) => {
    if (!confirm("Delete this canvas? Its chats and messages go with it.")) return;
    await remove({ id });
    if (id === activeCanvasId && canvases.length > 1) {
      const next = canvases.find((c) => c._id !== id);
      if (next) onSelect(next._id);
    }
  };

  return (
    <div ref={rootRef} className="font-mono text-sm">
      <button
        type="button"
        aria-label="Canvas library"
        onClick={() => setOpen((v) => !v)}
        className="w-9 h-9 rounded-full border border-border bg-surface hover:bg-surface-alt text-accent flex items-center justify-center transition-colors"
      >
        <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden>
          <rect y="0" width="16" height="2" fill="currentColor" />
          <rect y="5" width="16" height="2" fill="currentColor" />
          <rect y="10" width="16" height="2" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="mt-2 w-80 max-w-[calc(100vw-2rem)] border border-border rounded-lg bg-surface shadow-xl overflow-hidden">
          <button
            type="button"
            onClick={onCreate}
            className="w-full text-left px-4 py-2.5 border-b border-border text-accent hover:bg-surface-alt transition-colors"
          >
            + New canvas
          </button>
          <ul className="max-h-[60vh] overflow-y-auto">
            {canvases.map((c) => (
              <li key={c._id} className="border-b border-border/40 last:border-b-0">
                {renaming === c._id ? (
                  <div className="px-3 py-2 flex gap-2">
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void onConfirmRename(c._id);
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      className="flex-1 bg-bg border border-border rounded px-2 py-1 text-text outline-none focus:border-accent"
                    />
                    <button
                      type="button"
                      onClick={() => void onConfirmRename(c._id)}
                      className="text-accent text-xs px-2"
                    >
                      ok
                    </button>
                  </div>
                ) : (
                  <div
                    className={`group flex items-center gap-2 px-3 py-2 hover:bg-surface-alt transition-colors ${
                      c._id === activeCanvasId ? "bg-surface-alt" : ""
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(c._id);
                        setOpen(false);
                      }}
                      className="flex-1 min-w-0 text-left"
                    >
                      <div className={`truncate ${c._id === activeCanvasId ? "text-accent" : "text-text"}`}>
                        {c.name}
                      </div>
                      <div className="text-xs text-text-faint">{formatDate(c.updatedAt)}</div>
                    </button>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        title="Rename"
                        onClick={() => {
                          setRenaming(c._id);
                          setRenameValue(c.name);
                        }}
                        className="text-text-faint hover:text-text text-xs px-1"
                      >
                        rn
                      </button>
                      <button
                        type="button"
                        title="Duplicate"
                        onClick={async () => {
                          const { canvasId } = await duplicate({ id: c._id });
                          onSelect(canvasId);
                        }}
                        className="text-text-faint hover:text-text text-xs px-1"
                      >
                        dup
                      </button>
                      <button
                        type="button"
                        title="Delete"
                        onClick={() => void onDelete(c._id)}
                        className="text-text-faint hover:text-red-400 text-xs px-1"
                      >
                        del
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
