import { getDocumentSize, type Value } from "convex/values";
import type { ReadCut } from "./ttsCompose";

// ── Reads bounded by bytes ───────────────────────────────────────────────────
// One Convex function, with everything it runs in its transaction, may read
// 16 MiB of documents. A row cap does not bound that: a todo carries its
// explanation, so 200 todos at 64 KB are 12.8 MB. A ReadBudget counts the
// bytes of every document a read returns, sized as Convex sizes them
// (getDocumentSize), and a read stops before its next row once its own
// allotment or the whole budget is spent. The row that crossed was already
// read, so a budget of B bytes read one row at a time reads at most B plus one
// document, and Convex stores no document over 1 MiB. That is why the reads
// under one budget run one after another, never in parallel: two reads open
// at once could each cross it.

export const MIB = 1024 * 1024;
/** What one function's transaction may read (Convex's limit). */
export const CONVEX_READ_LIMIT = 16 * MIB;
/** The largest document Convex stores: what one budget can overshoot by. */
export const MAX_DOCUMENT_BYTES = MIB;

export type { ReadCut };

type Part = { what: string; rows: number; skipped: number; by: ReadCut["by"] | null };

export class ReadBudget {
  private used = 0;
  private readonly parts: Part[];
  private readonly part: Part | null;

  private constructor(
    private readonly bytes: number,
    private readonly parent: ReadBudget | null,
    what: string,
  ) {
    this.parts = parent === null ? [] : parent.parts;
    this.part = parent === null ? null : { what, rows: 0, skipped: 0, by: null };
    if (this.part !== null) this.parts.push(this.part);
  }

  /** The budget of one function's reads. */
  static of(bytes: number): ReadBudget {
    return new ReadBudget(bytes, null, "");
  }

  /** One read's allotment: its bytes count against both, and its cut is
   *  named `what` (plain words, plural: "prepared todos"). */
  allot(what: string, bytes: number): ReadBudget {
    return new ReadBudget(bytes, this, what);
  }

  /** Whether another row may be read. */
  get open(): boolean {
    return this.used < this.bytes && (this.parent === null || this.parent.open);
  }

  /** A row read and kept. */
  charge(doc: Record<string, Value>): void {
    this.add(getDocumentSize(doc));
    if (this.part !== null) this.part.rows += 1;
  }

  /** A row read only to learn it exists: its bytes count, it is not kept. */
  peeked(doc: Record<string, Value>): void {
    this.add(getDocumentSize(doc));
  }

  private add(bytes: number): void {
    this.used += bytes;
    this.parent?.add(bytes);
  }

  /** A row this allotment left unread, by id or for a known reason. */
  skip(rows = 1): void {
    if (this.part === null) return;
    this.part.skipped += rows;
    this.part.by = "bytes";
  }

  /** The read stopped with rows left: at the byte budget, or at its row cap
   *  with the next row seen. A byte stop is the one said if both happened. */
  stop(by: ReadCut["by"]): void {
    if (this.part !== null && this.part.by !== "bytes") this.part.by = by;
  }

  /** Every allotment that stopped, in the order they were made. */
  cuts(): ReadCut[] {
    return this.parts
      .filter((p) => p.by !== null)
      .map((p) => ({ what: p.what, read: p.rows, skipped: p.skipped, by: p.by as ReadCut["by"] }));
  }
}

/**
 * A query's rows in its order: at most `rows`, and none read once `budget`
 * is spent. A read that ends with rows possibly left is recorded on the
 * budget, which the digest's cut run says. At the row cap one more row is
 * read, and counted, to learn whether the cap cut anything; at the byte
 * budget whether rows were left is unknown, because knowing would mean
 * reading them.
 */
export async function readWithin<T extends Record<string, Value>>(
  budget: ReadBudget,
  query: AsyncIterable<T>,
  rows: number,
): Promise<T[]> {
  const out: T[] = [];
  const iterator = query[Symbol.asyncIterator]();
  let done = false;
  let stopped: ReadCut["by"] | null = null;
  try {
    for (;;) {
      if (!budget.open) {
        stopped = "bytes";
        break;
      }
      const next = await iterator.next();
      if (next.done === true) {
        done = true;
        break;
      }
      if (out.length === rows) {
        budget.peeked(next.value);
        stopped = "rows";
        break;
      }
      budget.charge(next.value);
      out.push(next.value);
    }
  } finally {
    if (!done) await iterator.return?.();
  }
  if (stopped !== null) budget.stop(stopped);
  return out;
}

/** One lookup under `budget`: the document or null as `read` answers, or
 *  undefined when the budget was spent and nothing was read. */
export async function getWithin<T extends Record<string, Value>>(
  budget: ReadBudget,
  read: () => Promise<T | null>,
): Promise<T | null | undefined> {
  if (!budget.open) {
    budget.skip();
    return undefined;
  }
  const doc = await read();
  if (doc !== null) budget.charge(doc);
  return doc;
}
