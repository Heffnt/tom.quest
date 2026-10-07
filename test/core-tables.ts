// THE CORE TABLES' MOVE, AS A TEST READS IT (convex/jarvis/tables.ts). A
// reader of todos hands out plain ids. `inOldTerms`
// reads an answer in the old tables' terms: every plain id in it, alone or
// inside a string (a link in a message), replaced by the old id its row
// carries as legacyId. Since step C a door writes plain rows only, which
// carry none, so for them it reads as the answer itself; the tests written
// against the old tables keep their assertions through it.

import type { MutationCtx, QueryCtx } from "../convex/_generated/server";
import type { Doc, Id } from "../convex/_generated/dataModel";

/** `value` with every plain todo id in it replaced by
 *  that row's old id, at any depth. Anything else is left as it is. */
export async function inOldTerms<V>(ctx: QueryCtx, value: V): Promise<V> {
  const old = new Map<string, string>();
  for (const table of ["todos"] as const) {
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

type Core = "todos";
const OLD = { todos: "dtsTodos" } as const;

/** A todo from before step C: the old row and its plain copy, which carries
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
