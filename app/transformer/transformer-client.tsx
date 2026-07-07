"use client";

import { useEffect } from "react";
import PromptBar from "./components/prompt-bar";
import Spine from "./components/spine";
import StrataStack from "./components/strata";
import { useTransformer } from "./state";

// Layout contract (Tom's axes): horizontal = depth into the model (the spine,
// always pinned on top); vertical = width within a layer (each drill level is
// a collapsible full-width stratum, deeper = further down the page); z = the
// autoregressive past (scrubbed via the token ribbon / arrow keys, drawn as
// receding ghost slices behind the spine).
export default function TransformerClient() {
  const select = useTransformer((s) => s.select);
  const selected = useTransformer((s) => s.selected);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        select(selected - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        select(selected + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select, selected]);

  return (
    <div className="mx-auto max-w-5xl px-4 pb-24 pt-2">
      <PromptBar />
      <Spine />
      <StrataStack />
    </div>
  );
}
