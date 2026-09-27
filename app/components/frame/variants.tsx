"use client";

// MOCKUP ROUND 1: four looks for a closed drawer, switchable on the live page
// so Tom can pick one. This file and variants.css are the whole mechanism;
// once he picks, one commit folds the chosen look's CSS into globals.css and
// deletes both files and their uses in frame.tsx (the variant attribute,
// the hook, the picker).
//
//   A  28px side rails, the label and signals rotated along the rail
//   B  44px side rails, the label and signals upright, stacked
//   C  6px strips coloured by their most urgent signal, each with a pull tab
//   D  no rails: handles in the corners over the center
//
// Keys 1 to 4 pick one (not while a text field has focus); so does the picker
// in the top rail. The choice is stored in localStorage.

import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isTextTarget } from "./rules";
import "./variants.css";

const VARIANTS = ["A", "B", "C", "D"] as const;
type FrameVariant = (typeof VARIANTS)[number];

const useVariantStore = create<{ variant: FrameVariant; setVariant: (v: FrameVariant) => void }>()(
  persist((set) => ({ variant: "A", setVariant: (variant) => set({ variant }) }), {
    name: "tom-quest-frame-variant",
    skipHydration: true,
  }),
);

/** The chosen variant, read from storage after the first render, and keys 1 to 4 to change it. */
export function useFrameVariant(): FrameVariant {
  const variant = useVariantStore((s) => s.variant);
  useEffect(() => {
    void useVariantStore.persist.rehydrate();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTextTarget(e.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const index = ["1", "2", "3", "4"].indexOf(e.key);
      if (index < 0) return;
      e.preventDefault();
      useVariantStore.getState().setVariant(VARIANTS[index]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return variant;
}

export function VariantPicker() {
  const variant = useVariantStore((s) => s.variant);
  const setVariant = useVariantStore((s) => s.setVariant);
  return (
    <span role="radiogroup" aria-label="Closed drawer variant" className="flex shrink-0 items-center rounded-control border border-border">
      {VARIANTS.map((v, i) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={variant === v}
          aria-keyshortcuts={String(i + 1)}
          onClick={() => setVariant(v)}
          className={`h-5 w-5 font-mono text-[12px] leading-none hover:bg-surface-alt hover:text-text ${
            variant === v ? "bg-accent-dim text-accent" : "text-text-faint"
          }`}
        >
          {v}
        </button>
      ))}
    </span>
  );
}
