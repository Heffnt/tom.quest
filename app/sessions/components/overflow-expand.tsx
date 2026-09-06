"use client";

// THE REST OF A CUT PAYLOAD (the lifeos update, phase 7).
//
// The daemon cuts any transcript payload over 32 KB before it writes the row,
// and stores the whole of it in chunks beside it. Until now the row said so in
// a footer and stopped there, which made the transcript a summary of itself —
// against the one rule this surface has (everything the session actually did,
// in full). This control fetches the rest.
//
// It PAGES, because it has to: claudeSessions.getMessageOverflow returns up to
// 1 MB and hands back a cursor, and a payload can be hundreds of megabytes. So
// each read's text is appended in order and its bytes are summed, and the
// running total is compared against the byte length the row itself stamps.
// What the line under the control claims is exactly what was checked
// (app/sessions/lib.ts describeOverflow): "complete" only when the server
// verified bytes and hash, "complete in N reads" when the bytes sum but the
// hash was not re-checked across pages, and otherwise incomplete with the
// reason. A silent prefix would be the truncation this path exists to undo.

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import Info from "@/app/tts/components/info";
import { describeOverflow } from "../lib";

export default function OverflowExpand({
  messageId,
  fullByteLength,
}: {
  messageId: Id<"claudeMessages">;
  /** The row's own stamp of the whole payload's size, from getMessages. */
  fullByteLength?: number;
}) {
  const [open, setOpen] = useState(false);
  // Where the next read starts, and what the reads so far came back with. The
  // pages are kept BY INDEX rather than concatenated as they land: a Convex
  // subscription re-delivers its result on any re-render, and appending on
  // arrival would duplicate the text every time the pane ticked.
  const [fromIndex, setFromIndex] = useState(0);
  const [pages, setPages] = useState<Record<number, { text: string; bytes: number }>>(
    {},
  );

  const read = useQuery(
    api.claudeSessions.getMessageOverflow,
    open ? { messageId, fromIndex } : "skip",
  );

  // Record this read once, then move the cursor on. Done during render on
  // purpose (setState in render is React's own idiom for deriving state from
  // props that changed): the page is keyed by the index it was read from, so
  // recording it twice is a no-op rather than a duplication.
  // read === null is the message row itself being gone, which the line below
  // says rather than showing an empty payload as if it were the whole thing.
  if (read != null && read.hasOverflow && pages[read.fromIndex] === undefined) {
    setPages((prev) => ({
      ...prev,
      [read.fromIndex]: { text: read.text, bytes: read.bytes },
    }));
    if (read.nextIndex !== null) setFromIndex(read.nextIndex);
  }

  const indexes = Object.keys(pages)
    .map(Number)
    .sort((a, b) => a - b);
  const text = indexes.map((i) => pages[i].text).join("");
  const bytes = indexes.reduce((n, i) => n + pages[i].bytes, 0);
  // Still reading while a page is in flight, or while the last one handed back
  // a cursor and the next read has not landed.
  const reading =
    read === undefined || (read != null && read.hasOverflow && read.nextIndex !== null);

  if (!open) {
    return (
      <span className="mt-1 inline-flex items-baseline gap-0.5">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-[11px] text-accent underline underline-offset-2 hover:opacity-80"
        >
          show the whole payload
          {fullByteLength !== undefined ? ` (${fullByteLength} bytes)` : ""}
        </button>
        <Info call="claudeSessions.getMessageOverflow({ messageId, fromIndex })">
          Reads back the part of this payload the daemon cut off, from the
          chunks it stored beside the row — a megabyte per read, as many reads
          as it takes. Nothing is written; the line under the payload says how
          many bytes came back and whether the server matched them against the
          hash it stamped on the row.
        </Info>
      </span>
    );
  }

  return (
    <div className="mt-1">
      <div className="font-mono text-[10px] text-text-faint">
        {read === null
          ? "the message row this payload belongs to is gone"
          : read !== undefined && !read.hasOverflow
          ? "nothing was cut — the row above is the whole payload"
          : describeOverflow({
              bytes,
              byteLength: read?.byteLength ?? fullByteLength,
              end: read?.end ?? false,
              complete: read?.complete ?? false,
              reads: indexes.length,
              reading,
            })}
      </div>
      {text !== "" && (
        <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-text-muted bg-surface-alt/50 border border-border rounded p-3 overflow-x-auto">
          {text}
        </pre>
      )}
    </div>
  );
}
