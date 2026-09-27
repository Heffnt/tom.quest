"use client";

// MOCKUP ROUND 2: two looks for the drawer handles, switchable on the live
// page so Tom can feel both. This file and variants.css are the whole
// mechanism; once he picks, one commit folds the chosen look into globals.css
// and deletes both files and their uses in frame.tsx (the variant attribute,
// the hook, the picker).
//
//   A  28px handles; on the sides the label and signals run along the handle
//   B  44px handles; on the sides the label and signals stand upright, stacked
//
// Each applies to all four handles alike: the top and bottom handles are as
// thick as the side ones. Keys 1 and 2 pick one (not while a text field has
// focus); so does the picker on the top handle. The choice is stored in
// localStorage.

import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isTextTarget } from "./rules";
import "./variants.css";

const VARIANTS = ["A", "B"] as const;
type FrameVariant = (typeof VARIANTS)[number];

/** Each variant's handle thickness in pixels, the one number the geometry reads. */
export const HANDLE_PX: Record<FrameVariant, number> = { A: 28, B: 44 };

/** The variant storage names, or A for anything else. */
export function storedVariant(stored: unknown): FrameVariant {
  const v = typeof stored === "object" && stored !== null ? (stored as { variant?: unknown }).variant : undefined;
  return VARIANTS.find((x) => x === v) ?? "A";
}

const useVariantStore = create<{ variant: FrameVariant; setVariant: (v: FrameVariant) => void }>()(
  persist((set) => ({ variant: "A", setVariant: (variant) => set({ variant }) }), {
    name: "tom-quest-frame-variant",
    version: 2,
    skipHydration: true,
    migrate: () => ({ variant: "A" }) as { variant: FrameVariant; setVariant: (v: FrameVariant) => void },
    // Storage is untrusted (frame-store.ts): an unknown variant reads as A.
    merge: (stored, current) => ({ ...current, variant: storedVariant(stored) }),
  }),
);

/** The chosen variant, read from storage after the first render, and keys 1 and 2 to change it. */
export function useFrameVariant(): FrameVariant {
  const variant = useVariantStore((s) => s.variant);
  useEffect(() => {
    void useVariantStore.persist.rehydrate();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTextTarget(e.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const index = ["1", "2"].indexOf(e.key);
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
    <span role="radiogroup" aria-label="Handle variant" className="flex shrink-0 items-center rounded-control border border-border">
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
