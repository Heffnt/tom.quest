"use client";

import { useEffect, useRef, useState } from "react";
import type { AddIngredientModalProps } from "./contracts";
import { fundamentals } from "../data/base";
import { PHIAL, COPPER, STRIKE } from "../lib/frequencies";
import FreqBuilder from "./freq-builder";

const SWATCHES = [PHIAL, COPPER, STRIKE, ...fundamentals.map((f) => f.color)];

function toNonNegInt(s: string): number {
  const n = parseInt(s.replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export default function AddIngredientModal({ isOpen, onClose, onSubmit }: AddIngredientModalProps) {
  const [name, setName] = useState("");
  const [emits, setEmits] = useState<string[]>([]);
  const [minus, setMinus] = useState("0");
  const [plus, setPlus] = useState("0");
  const [color, setColor] = useState(PHIAL);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const t = setTimeout(() => nameRef.current?.focus(), 50);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const reset = () => {
    setName("");
    setEmits([]);
    setMinus("0");
    setPlus("0");
    setColor(PHIAL);
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        emits,
        minus: toNonNegInt(minus),
        plus: toNonNegInt(plus),
        color,
      });
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save ingredient.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Create ingredient"
        className="relative max-h-[85vh] w-full max-w-md overflow-y-auto rounded-lg border border-border bg-surface p-6"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 text-text-muted transition-colors duration-150 hover:text-text"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <h2 className="mb-5 text-xl font-semibold">New ingredient</h2>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-text-muted">Name</label>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-text focus:border-accent focus:outline-none"
              placeholder="e.g. Moonpetal Dust"
            />
          </div>

          <FreqBuilder label="Emitted frequencies" value={emits} onChange={setEmits} />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm text-text-muted">Strikes (⊖)</label>
              <input
                value={minus}
                onChange={(e) => setMinus(e.target.value)}
                inputMode="numeric"
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-text focus:border-accent focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm text-text-muted">Wildcards (⊕)</label>
              <input
                value={plus}
                onChange={(e) => setPlus(e.target.value)}
                inputMode="numeric"
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-text focus:border-accent focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm text-text-muted">Chip color</label>
            <div className="flex flex-wrap items-center gap-1.5">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  aria-label={`Color ${c}`}
                  className={`h-6 w-6 rounded-full transition-transform ${
                    color === c ? "ring-2 ring-accent ring-offset-2 ring-offset-surface" : ""
                  }`}
                  style={{ background: c }}
                />
              ))}
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                aria-label="Custom color"
                className="h-6 w-8 cursor-pointer rounded border border-border bg-bg"
              />
            </div>
          </div>

          {error && <p className="text-sm text-error">{error}</p>}

          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="w-full rounded-lg bg-accent py-2 font-medium text-bg transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save ingredient"}
          </button>
        </form>
      </div>
    </div>
  );
}
