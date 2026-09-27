"use client";

// THE VOCABULARY AS `tts search` PRINTS IT: the `vocabulary/@version` header,
// then one row per word, each exactly the line an agent's `tts search
// vocabulary` or `tts search define` prints for it, in the vocabulary's own
// order. A refused word is a row like any other; its last field names the word
// to use instead.

export default function TermRows({ header, rows }: { header: string; rows: string[] }) {
  return (
    <div className="whitespace-pre-wrap break-words font-mono text-xs text-text-muted">
      <p className="border-b border-border pb-1 text-text">{header}</p>
      {rows.map((row, index) => (
        <p key={index} className="border-b border-border/50 py-1">
          {row}
        </p>
      ))}
    </div>
  );
}
