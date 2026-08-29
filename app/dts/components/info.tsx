"use client";

// The ⓘ bubble every mono mutation caption on /dts sits behind. label is the
// exact backend call the neighboring control fires (UI = code); title gives a
// hover preview, click pins the caption inline.

import { useState } from "react";

export default function Info({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="inline-flex items-baseline gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={label}
        className="text-[10px] text-text-faint hover:text-text-muted"
      >
        ⓘ
      </button>
      {open && (
        <span className="font-mono text-[10px] text-text-faint">{label}</span>
      )}
    </span>
  );
}
