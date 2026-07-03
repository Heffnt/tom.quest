// app/boolback/lib/format.ts — tiny display helpers shared by the panes.

/** "Qwen/Qwen2.5-0.5B-Instruct@7ae557…" -> "Qwen2.5-0.5B-Instruct". */
export function shortModel(model: string | null | undefined): string {
  if (!model) return "—";
  const noHash = model.split("@")[0];
  return noHash.split("/").pop() || noHash;
}

/** ISO timestamp -> "3h ago" (falls back to the raw string). */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** 12345 -> "12,345". */
export function thousands(n: number): string {
  return n.toLocaleString("en-US");
}

/** Bytes -> "1.2 MB". */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Compact hex encoding of a truth table string (char i = f(row i), rows
 * LSB-first). The string is read as a binary number highest-row-first, so
 * arity-3 majority "00010111" -> "E8" (the classic form). Padded to
 * ceil(2^arity / 4) digits so equal-arity functions align.
 */
export function fnHex(truthTable: string): string {
  if (!/^[01]+$/.test(truthTable)) return truthTable;
  const bits = [...truthTable].reverse().join("");
  const hex = BigInt(`0b${bits}`).toString(16).toUpperCase();
  return hex.padStart(Math.ceil(truthTable.length / 4), "0");
}

/** The compact display text for a function: "arity:hex", e.g. "3:E8". */
export function fnText(arity: number, truthTable: string): string {
  return `${arity}:${fnHex(truthTable)}`;
}

/** Small deterministic hash of a string into [0, 1) — for stable chart jitter. */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}
