/**
 * Caesar input widget — used by the Source and Execute scenes when the
 * active scenario is "caesar". The user types either plaintext (encrypts
 * before baking into the program) or ciphertext (baked in directly), and
 * the THCC source is regenerated so subsequent compiler stages and the
 * CPU run pick it up automatically.
 *
 * The input is sanitised to A-Z + space; lowercase is uppercased,
 * everything else dropped. We cap at 14 characters since beyond that the
 * generated program risks overflowing THMM's 256-cell memory.
 */
"use client";

import { useEffect, useState } from "react";
import {
  buildCaesarSource,
  decryptCaesar,
  encryptCaesar,
  normaliseCaesar,
} from "../lib/caesar";
import { useCompiler } from "../state/compiler-store";

type Props = {
  /** "plain" — input is plaintext, encrypted into the program.
   *  "cipher" — input is ciphertext, baked in directly. */
  mode: "plain" | "cipher";
};

const MAX_CHARS = 14;

export default function CaesarInput({ mode }: Props) {
  const { source, updateScenarioSource } = useCompiler();

  // Recover the current ciphertext from the source by reading off the
  // `c0`, `c1`, ... declarations and converting them back to chars. That's
  // what tells us what to display in the input field on first render.
  const initial = mode === "plain"
    ? decryptCaesar(extractCipher(source))
    : extractCipher(source);

  const [draft, setDraft] = useState<string>(initial);

  // If the source is changed by some other surface (the picker, the source
  // editor, the other Caesar widget) keep our draft in sync.
  useEffect(() => {
    const current = mode === "plain"
      ? decryptCaesar(extractCipher(source))
      : extractCipher(source);
    setDraft(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  function commit(text: string) {
    const cleaned = normaliseCaesar(text).slice(0, MAX_CHARS);
    setDraft(cleaned);
    const cipher = mode === "plain" ? encryptCaesar(cleaned) : cleaned;
    updateScenarioSource("caesar", buildCaesarSource(cipher));
  }

  const cipher = mode === "plain" ? encryptCaesar(draft) : draft;
  const plain  = mode === "plain" ? draft : decryptCaesar(draft);

  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-sm font-medium">
            {mode === "plain" ? "Encode a message" : "Decode a message"}
          </div>
          <div className="text-xs text-text-muted">
            {mode === "plain"
              ? "Type plaintext. The program is rebuilt with this text encrypted at shift 3."
              : "Type the ciphertext. The CPU will decrypt it back to plaintext."}
          </div>
        </div>
        <div className="text-xs text-text-muted font-mono">
          {draft.length}/{MAX_CHARS}
        </div>
      </div>

      <input
        type="text"
        value={draft}
        onChange={(e) => commit(e.target.value)}
        spellCheck={false}
        maxLength={MAX_CHARS * 4}
        className="w-full bg-white/[0.04] border border-white/10 rounded px-3 py-2 font-mono text-base outline-none focus:border-accent uppercase tracking-wider"
        placeholder={mode === "plain" ? "TOM HEFFERNAN" : "WRP KHIIHUQDQ"}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3 font-mono text-sm">
        <div>
          <div className="text-xs text-text-muted uppercase tracking-wide mb-1">Plaintext</div>
          <div className="text-text">{plain || "·"}</div>
        </div>
        <div>
          <div className="text-xs text-text-muted uppercase tracking-wide mb-1">Ciphertext</div>
          <div className="text-accent">{cipher || "·"}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * Walk the source for the canonical `int cN = NUMBER;` lines that
 * `buildCaesarSource` emits, and reconstruct the ciphertext byte-by-byte.
 * Returns "" if no Caesar program structure is detected.
 */
function extractCipher(source: string): string {
  const re = /^\s*int\s+c(\d+)\s*=\s*(\d+)\s*;/gm;
  const matches: { idx: number; byte: number }[] = [];
  for (const m of source.matchAll(re)) {
    matches.push({ idx: parseInt(m[1], 10), byte: parseInt(m[2], 10) });
  }
  if (matches.length === 0) return "";
  matches.sort((a, b) => a.idx - b.idx);
  return matches.map(m => String.fromCharCode(m.byte)).join("");
}
