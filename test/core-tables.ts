// THE CORE TABLES' MOVE, AS A TEST READS IT (convex/jarvis/tables.ts). A
// reader moved to todos, blocks or timeNotes hands out plain ids; a fixture
// written through a door holds the old ids the door answered with. A test
// that asserted a reader's answer before the move keeps its assertion by
// reading the answer in the old tables' terms: every plain id in it, alone or
// inside a string (a link in a message), replaced by the old id its row
// carries as legacyId. Equal in those terms is the same result as before, for
// rows both tables hold.

import type { MutationCtx, QueryCtx } from "../convex/_generated/server";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { back } from "../convex/jarvis/tables";

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

/** A todo inserted as a door stores one: the plain row, with its old row
 *  written back while step C moves the writers. Answers the plain id. */
export async function insertTodo(
  ctx: MutationCtx,
  fields: Omit<Doc<"todos">, "_id" | "_creationTime">,
): Promise<Id<"todos">> {
  const id = await ctx.db.insert("todos", fields);
  await back(ctx, "todos", id);
  return id;
}

/** A todo patched by hand, and its old row with it. */
export async function patchTodo(ctx: MutationCtx, id: Id<"todos">, fields: Partial<Doc<"todos">>): Promise<void> {
  await ctx.db.patch(id, fields);
  await back(ctx, "todos", id);
}

type Core = "todos" | "blocks" | "timeNotes";
const OLD = { todos: "dtsTodos", blocks: "dtsBlocks", timeNotes: "dtsTimeNotes" } as const;

/** A row from before step C: the old row and its plain copy, which carries
 *  the old id as legacyId (the copy's references are the caller's to give in
 *  the plain table's terms). Answers both ids. */
export async function insertCopied<C extends Core>(
  ctx: MutationCtx,
  table: C,
  fields: Omit<Doc<C>, "_id" | "_creationTime" | "legacyId">,
  oldFields: Record<string, unknown> = fields,
): Promise<{ old: Id<(typeof OLD)[C]>; plain: Id<C> }> {
  const old = (await ctx.db.insert(OLD[table], oldFields as never)) as Id<(typeof OLD)[C]>;
  const plain = (await ctx.db.insert(table, { ...fields, legacyId: old } as never)) as Id<C>;
  return { old, plain };
}
