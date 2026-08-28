"use client";

// One finalized transcript row, rendered by kind. Content is v.any() —
// strings render directly, objects via JSON.stringify (lib.contentToText).

import type { Message } from "../lib";
import {
  contentToText,
  previewLine,
  toolInputOf,
  toolNameOf,
} from "../lib";

function CollapsedRow({
  label,
  preview,
  body,
}: {
  label: string;
  preview: string;
  body: string;
}) {
  return (
    <details className="group text-sm">
      <summary className="cursor-pointer list-none flex items-baseline gap-2 px-3 py-1.5 rounded border border-border/60 text-text-faint hover:bg-surface-alt/50">
        <span className="shrink-0 text-text-muted font-mono text-xs">
          {label}
        </span>
        <span className="truncate min-w-0">{preview}</span>
      </summary>
      <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-text-muted bg-surface-alt/50 border border-border rounded p-3 overflow-x-auto">
        {body}
      </pre>
    </details>
  );
}

export default function MessageRow({ message }: { message: Message }) {
  const { kind, content } = message;

  switch (kind) {
    case "user": {
      return (
        <div className="border-l-2 border-accent bg-surface-alt/40 rounded-r px-3 py-2 ml-6 sm:ml-16">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-text">
            {contentToText(content)}
          </pre>
        </div>
      );
    }
    case "assistant-text": {
      return (
        <pre className="whitespace-pre-wrap break-words font-sans text-sm text-text px-1">
          {contentToText(content)}
        </pre>
      );
    }
    case "thinking": {
      const text = contentToText(content);
      return (
        <details className="text-sm">
          <summary className="cursor-pointer list-none text-text-faint text-xs px-1">
            thinking — {previewLine(text, 64)}
          </summary>
          <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-xs text-text-faint border-l border-border pl-3 py-1">
            {text}
          </pre>
        </details>
      );
    }
    case "tool-call": {
      const name = toolNameOf(content);
      const inputText = contentToText(toolInputOf(content));
      return (
        <CollapsedRow
          label={name}
          preview={previewLine(inputText)}
          body={inputText}
        />
      );
    }
    case "tool-result": {
      const text = contentToText(content);
      return (
        <CollapsedRow
          label="result"
          preview={previewLine(text)}
          body={text}
        />
      );
    }
    case "permission": {
      return (
        <div className="text-xs text-text-faint px-1">
          permission requested: {toolNameOf(content)}
        </div>
      );
    }
    case "system": {
      return (
        <div className="text-center text-xs text-text-faint px-1">
          {previewLine(contentToText(content), 160)}
        </div>
      );
    }
    case "error": {
      return (
        <pre className="whitespace-pre-wrap break-words font-sans text-sm text-error border border-error/40 rounded px-3 py-2">
          {contentToText(content)}
        </pre>
      );
    }
  }
}
