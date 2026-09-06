// Declined integrations (the lifeos update, phase 6).
//
// AN INTEGRATION TOM DECLINES IS AN ARCHIVED TODO WITH HIS RULING ON IT. There
// is no integrations table, no enabled flag, no config page: the thing that
// already records a decision of his — a todo, ruled on — records this one too,
// which means the decision keeps his own words, its date, and its place in
// everything that reads rulings.
//
// HOW HE DECLINES ONE: dump the line `integration: outlook` into #dump, then
// archive it with the archive verdict. The optional sentence on that verdict is
// the reason, in his words, and it is what a poller prints when it skips and
// what the weekly gather will show beside the date.
//
// HOW HE TAKES IT BACK: rule again. The NEWEST ruling on the row decides, so an
// approve after an archive re-enables the integration without deleting the
// history of having declined it.
//
// WHO READS THIS: every capture poller on the Jarvis Box, through GET
// /tts/capture-context, before it does anything else; and, later, the Friday
// weekly gather, which lists integrations by state.

import { internalQuery } from "./_generated/server";

/** The one shape a declining todo's statement has. */
export const INTEGRATION_PREFIX = "integration:";

/** The statement Tom dumps to decline an integration. */
export function integrationStatement(name: string): string {
  return `${INTEGRATION_PREFIX} ${name}`;
}

/**
 * The integration a statement names, or null when it names none.
 *
 * EXACTLY the prefix and a name after it — a statement that merely mentions an
 * integration ("the outlook integration keeps timing out") is an ordinary todo
 * and must never turn a poller off. The prefix is matched case-insensitively
 * and the name comes back lowercased and trimmed, because Tom types into Slack
 * on a phone: "Integration: Outlook" and "integration: outlook" are one ruling,
 * not two.
 */
export function integrationName(statement: string | undefined): string | null {
  const text = (statement ?? "").trim();
  if (!text.toLowerCase().startsWith(`${INTEGRATION_PREFIX} `)) return null;
  const name = text.slice(INTEGRATION_PREFIX.length).trim().toLowerCase();
  // One word or a short phrase; a paragraph after the prefix is a note about
  // an integration, not a ruling on one.
  return name === "" || name.includes("\n") ? null : name;
}

export type DeclinedIntegration = {
  name: string;
  todoId: string;
  ruledAt: number;
  sentence: string | null;
};

/**
 * Every integration Tom has declined: an ARCHIVED todo whose statement is
 * exactly "integration: <name>", carrying an ARCHIVE ruling as its newest
 * ruling.
 *
 * Both halves are required. The archived status alone is not enough — an
 * agent, a batch archive, or a cleanup can archive a row, and none of those is
 * Tom deciding. The ruling alone is not enough either: a later approve leaves
 * the archive ruling in the history, and the row's status is what says which
 * ruling is in force. Read together they mean one thing, which is why they are
 * read in one place.
 */
export const internalDeclinedIntegrations = internalQuery({
  args: {},
  handler: async (ctx): Promise<DeclinedIntegration[]> => {
    const archived = await ctx.db
      .query("dtsTodos")
      .withIndex("by_status", (q) => q.eq("status", "archived"))
      .collect();
    const out: DeclinedIntegration[] = [];
    for (const todo of archived) {
      const name = integrationName(todo.statement);
      if (name === null) continue;
      const rulings = await ctx.db
        .query("dtsRulings")
        .withIndex("by_todo", (q) => q.eq("todoId", todo._id))
        .collect();
      // The newest ruling decides; it has to be the archive.
      const newest = rulings.sort((a, b) => b.ruledAt - a.ruledAt)[0];
      if (newest === undefined || newest.verdict !== "archive") continue;
      out.push({
        name,
        todoId: todo._id,
        ruledAt: newest.ruledAt,
        sentence: newest.sentence?.trim() || null,
      });
    }
    return out;
  },
});
