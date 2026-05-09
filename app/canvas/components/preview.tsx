"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export default function Preview({
  html,
  canvasName,
  canvasId,
}: {
  html: string;
  canvasName: string;
  canvasId: Id<"canvases">;
}) {
  const rename = useMutation(api.canvas.rename);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(canvasName);
  const [showSource, setShowSource] = useState(false);

  return (
    <div className="flex-1 flex flex-col min-h-0 pt-16 px-3 pb-3">
      <div className="flex items-center justify-center mb-3">
        {editingName ? (
          <input
            autoFocus
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={() => {
              const trimmed = nameValue.trim();
              if (trimmed && trimmed !== canvasName) {
                void rename({ id: canvasId, name: trimmed });
              } else {
                setNameValue(canvasName);
              }
              setEditingName(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setNameValue(canvasName);
                setEditingName(false);
              }
            }}
            className="bg-transparent border-b border-border text-text-muted text-sm font-mono text-center outline-none focus:border-accent w-64"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              setNameValue(canvasName);
              setEditingName(true);
            }}
            className="text-text-muted text-sm font-mono hover:text-text transition-colors"
            title="Rename"
          >
            {canvasName}
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowSource((v) => !v)}
          className="ml-3 text-xs text-text-faint hover:text-text font-mono border border-border rounded px-2 py-0.5 transition-colors"
        >
          {showSource ? "preview" : "source"}
        </button>
      </div>
      <div className="flex-1 min-h-0 border border-border rounded-lg overflow-hidden bg-white">
        {showSource ? (
          <pre className="w-full h-full overflow-auto text-xs text-text font-mono p-4 bg-bg whitespace-pre-wrap break-words">
            {html}
          </pre>
        ) : (
          <iframe
            title="Canvas preview"
            srcDoc={html}
            sandbox=""
            className="w-full h-full bg-white"
          />
        )}
      </div>
    </div>
  );
}
