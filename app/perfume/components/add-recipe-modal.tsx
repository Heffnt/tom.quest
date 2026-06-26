"use client";

import { useEffect, useRef, useState } from "react";
import type { Tier } from "../lib/types";
import type { AddRecipeModalProps } from "./contracts";
import FreqBuilder from "./freq-builder";

const TIERS: Tier[] = ["simple", "advanced", "legendary"];

export default function AddRecipeModal({ isOpen, onClose, onSubmit }: AddRecipeModalProps) {
  const [name, setName] = useState("");
  const [school, setSchool] = useState("");
  const [tier, setTier] = useState<Tier>("simple");
  const [req, setReq] = useState<string[]>([]);
  const [desc, setDesc] = useState("");
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
    setSchool("");
    setTier("simple");
    setReq([]);
    setDesc("");
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    if (req.length === 0) {
      setError("Add at least one required frequency.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        school: school.trim() || "Custom",
        tier,
        req,
        desc: desc.trim(),
      });
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save recipe.");
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
        aria-label="Create recipe"
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

        <h2 className="mb-5 text-xl font-semibold">New recipe</h2>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-text-muted">Name</label>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-text focus:border-accent focus:outline-none"
              placeholder="e.g. Whisper of the Veil"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm text-text-muted">School</label>
            <input
              value={school}
              onChange={(e) => setSchool(e.target.value)}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-text focus:border-accent focus:outline-none"
              placeholder="e.g. Illusion"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm text-text-muted">Tier</label>
            <div className="flex gap-1">
              {TIERS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTier(t)}
                  className={`flex-1 rounded-lg border px-3 py-1.5 font-mono text-xs capitalize transition-colors duration-150 ${
                    tier === t
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-border text-text-muted hover:text-text"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <FreqBuilder label="Required frequencies" value={req} onChange={setReq} />

          <div>
            <label className="mb-1 block text-sm text-text-muted">Description</label>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={2}
              className="w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 text-text focus:border-accent focus:outline-none"
              placeholder="a line of flavor…"
            />
          </div>

          {error && <p className="text-sm text-error">{error}</p>}

          <button
            type="submit"
            disabled={submitting || !name.trim() || req.length === 0}
            className="w-full rounded-lg bg-accent py-2 font-medium text-bg transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save recipe"}
          </button>
        </form>
      </div>
    </div>
  );
}
