// Builds the opening prompt for a DTS session (spec: WikiTom dts/spec.md).
// One home for the session-opening contract: Focus's "work in a session" and
// the Inventory's gate button both route through here, so the ground-up
// framing cannot drift between entry points.

import type { Doc } from "@/convex/_generated/dataModel";

const CONTRACT = `You are working inside DTS (Tom's Delegated Todo System), in an interactive session with Tom — likely on his phone. Follow the ground-up contract in every reply: define terms on first use, invent no names, concrete before abstract, one idea per paragraph, keep replies short, and end anything needing a decision with what Tom needs to decide plus a recommendation. Language is descriptive, never evaluative — no praise, no scolding. Stay scoped to the single item below unless Tom widens the scope; the goal of this session is his understanding and his ruling, not maximum output.`;

function fact(label: string, value: string | undefined): string | null {
  return value && value.trim() !== "" ? `${label}: ${value}` : null;
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
