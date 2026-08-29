// Builds the opening prompt for a DTS session (spec: WikiTom dts/spec.md).
// One home for the session-opening contract: Focus's "work in a session" and
// the Inventory's gate button both route through here, so the ground-up
// framing cannot drift between entry points.

import type { Doc } from "@/convex/_generated/dataModel";

const CONTRACT = `You are working inside DTS (Tom's Delegated Todo System), in an interactive session with Tom — likely on his phone. Follow the ground-up contract in every reply: define terms on first use, invent no names, concrete before abstract, one idea per paragraph, keep replies short, and end anything needing a decision with what Tom needs to decide plus a recommendation. Language is descriptive, never evaluative — no praise, no scolding. Stay scoped to the single item below unless Tom widens the scope; the goal of this session is his understanding and his ruling, not maximum output.`;

function fact(label: string, value: string | undefined): string | null {
  return value && value.trim() !== "" ? `${label}: ${value}` : null;
}

// Opening prompt for a BLOCK session: committed time over a category of
// todos, not a single item. Same contract; the session works the set with
// Tom one item at a time and records his spoken rulings as they land.
export function buildBlockSessionPrompt(
  category: string,
  todos: Doc<"dtsTodos">[],
): string {
  const lines: string[] = [
    CONTRACT,
    "",
    `This is a block session: Tom committed this span of time to the category "${category}". Work through the category's items with him, one at a time, smallest concrete first steps — open an item, take its first step with him, then move on. When Tom rules out loud, record it immediately via \`npx convex run\`: dts:internalTriage for status/date changes, dtsRulings:internalRecordRuling for approve/revise/session/archive verdicts (both are internal mutations — the Tom-gated public mutations reject deploy credentials). The session is his pen, and a ruling that lives only in chat is lost.`,
    "",
  ];
  if (category === "code") {
    lines.push(
      'The queue for "code" is the code-todo mirror and its prepared briefs (dtsCodeTodoMirror + dtsCodeBriefs) — work from those, not from a list in this prompt.',
    );
  } else if (todos.length === 0) {
    lines.push(`No active todos carry the category "${category}" right now.`);
  } else {
    lines.push(`Active todos in "${category}" (${todos.length}):`);
    for (const t of todos) {
      const facts = [
        fact("timing", t.timingClass),
        fact(
          "due",
          t.dueAt !== undefined ? new Date(t.dueAt).toISOString() : undefined,
        ),
        fact("entry action", t.entryAction),
        fact("work description", t.workDescription),
      ].filter((f): f is string => f !== null);
      lines.push(
        `- "${t.statement}"${facts.length > 0 ? ` — ${facts.join("; ")}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

export function buildTodoSessionPrompt(
  todo: Doc<"dtsTodos">,
  kind: "gate" | "focus-item",
): string {
  const lines = [
    CONTRACT,
    "",
    kind === "gate"
      ? "This is a tom-gate session: the item below is ready-for-tom and needs his input integrated. Walk him through it ground-up, take his ruling, and shape the result with him."
      : "This is a focus session: Tom chose to begin this item now. Open with the smallest concrete first step and work it with him.",
    "",
    `The item ("${todo.statement}"):`,
    fact("timing", todo.timingClass),
    fact(
      "due",
      todo.dueAt !== undefined ? new Date(todo.dueAt).toISOString() : undefined,
    ),
    fact("work description", todo.workDescription),
    fact("entry action", todo.entryAction),
    fact("source", todo.source),
    fact("provenance", todo.provenance),
    fact("body", todo.body),
    fact("brief", todo.brief),
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}
