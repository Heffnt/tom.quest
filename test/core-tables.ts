// THE CORE TABLES' MOVE, AS A TEST READS IT (convex/jarvis/tables.ts). A
// reader of todos, blocks or timeNotes hands out plain ids. `inOldTerms`
// reads an answer in the old tables' terms: every plain id in it, alone or
// inside a string (a link in a message), replaced by the old id its row
// carries as legacyId. Since step C a door writes plain rows only, which
// carry none, so for them it reads as the answer itself; the tests written
// against the old tables keep their assertions through it.

import type { MutationCtx, QueryCtx } from "../convex/_generated/server";
import type { Doc, Id } from "../convex/_generated/dataModel";

/** `value` with every plain todo, block or time-note id in it replaced by
 *  that row's old id, at any depth. Anything else is left as it is. */
export async function inOldTerms<V>(ctx: QueryCtx, value: V): Promise<V> {
  const old = new Map<string, string>();
  for (const table of ["todos", "blocks", "timeNotes"] as const) {
    for (const row of await ctx.db.query(table).collect()) {
      if (typeof row.legacyId === "string") old.set(row._id, row.legacyId);
    }
  }
  const map = (item: unknown): unknown => {
    if (typeof item === "string") {
      let out = item;
      for (const [plain, legacy] of old) if (out.includes(plain)) out = out.split(plain).join(legacy);
      return out;
    }
    if (Array.isArray(item)) return item.map(map);
    if (typeof item === "object" && item !== null) {
      return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, map(inner)]));
    }
    return item;
  };
  return map(value) as V;
}

/** A todo inserted as a door stores one since step C: the plain row. */
export async function insertTodo(
  ctx: MutationCtx,
  fields: Omit<Doc<"todos">, "_id" | "_creationTime">,
): Promise<Id<"todos">> {
  return await ctx.db.insert("todos", fields);
}

/** A todo patched by hand. */
export async function patchTodo(ctx: MutationCtx, id: Id<"todos">, fields: Partial<Doc<"todos">>): Promise<void> {
  await ctx.db.patch(id, fields);
}

type Core = "todos" | "blocks" | "timeNotes";

let minted = 0;

/** An id as a row had it before the move: the old table has left the
 *  schema, so it is no declared table's id, only a string the plain row
 *  keeps as legacyId. Alphanumeric, as a Convex id is, and unique. */
export function oldId(): string {
  minted += 1;
  return `old${String(minted).padStart(6, "0")}id`;
}

/** A row from before step C: its plain copy, which carries the old row's id
 *  as legacyId. Answers both ids. */
export async function insertCopied<C extends Core>(
  ctx: MutationCtx,
  table: C,
  fields: Omit<Doc<C>, "_id" | "_creationTime" | "legacyId">,
): Promise<{ old: string; plain: Id<C> }> {
  const old = oldId();
  const plain = (await ctx.db.insert(table, { ...fields, legacyId: old } as never)) as Id<C>;
  return { old, plain };
}
