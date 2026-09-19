"use client";

import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export type DrawerContent = "options" | "list";

type DrawerProps = {
  content: DrawerContent;
  listLength: number;
  onContentChange: (content: DrawerContent) => void;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
};

const FOCUSABLE = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function Segment({
  label,
  selected,
  onSelect,
  buttonRef,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-pressed={selected}
      onClick={() => {
        // A selected segment stays focusable, but tapping it does not change drawer content.
        if (!selected) onSelect();
      }}
      className={`min-h-9 rounded-full border px-3 py-2 text-sm transition-colors ${
        selected
          ? "border-accent bg-accent-dim text-accent"
          : "border-border bg-surface text-text-muted hover:border-accent/50 hover:bg-surface-alt hover:text-text"
      }`}
    >
      {label}
    </button>
  );
}

/** The questions page's one fixed overlay, portaled outside page layout. */
export default function Drawer({
  content,
  listLength,
  onContentChange,
  onClose,
  returnFocusRef,
  children,
}: DrawerProps) {
  const optionsRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLButtonElement>(null);
  const grabStartY = useRef(0);
  const grabCurrentY = useRef(0);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    (content === "options" ? optionsRef : listRef).current?.focus();
  }, [content]);

  useEffect(() => {
    const opener = returnFocusRef.current;
    return () => opener?.focus();
  }, [returnFocusRef]);

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex flex-col bg-black/60"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={content}
        onKeyDown={trapFocus}
        className="mx-auto mt-auto flex max-h-[85dvh] w-full max-w-[40rem] flex-col rounded-t-2xl border-t border-border bg-surface pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl"
      >
        <div
          className="flex h-8 shrink-0 items-center justify-center"
          onPointerDown={(event) => {
            grabStartY.current = event.clientY;
            grabCurrentY.current = event.clientY;
            // Capture keeps pointerup on this small handle after the pointer leaves it.
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            grabCurrentY.current = event.clientY;
          }}
          onPointerUp={() => {
            const moved = grabCurrentY.current - grabStartY.current;
            grabStartY.current = 0;
            grabCurrentY.current = 0;
            if (moved >= 64) onClose();
          }}
        >
          <span aria-hidden="true" className="h-1 w-10 rounded-full bg-border" />
        </div>

        <div className="flex min-h-11 items-center gap-2 px-4">
          <Segment
            label="options"
            selected={content === "options"}
            onSelect={() => onContentChange("options")}
            buttonRef={optionsRef}
          />
          <Segment
            label={`list ${listLength}`}
            selected={content === "list"}
            onSelect={() => onContentChange("list")}
            buttonRef={listRef}
          />
          <button
            type="button"
            onClick={onClose}
            className="ml-auto inline-flex min-h-11 items-center py-2 text-sm text-text-muted underline underline-offset-4 transition-colors hover:text-accent"
          >
            close
          </button>
        </div>

        {children}
      </div>
    </div>,
    document.body,
  );
}
