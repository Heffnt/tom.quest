// Builds the opening prompt for a TTS session (spec: WikiTom tts/spec.md).
// One home for the session-opening contract: Focus's "work in a session" and
// the Inventory's gate button both route through here, so the ground-up
// framing cannot drift between entry points.

import type { Doc } from "@/convex/_generated/dataModel";

const CONTRACT = `You are working inside TTS (Tom's Delegated Todo System), in an interactive session with Tom — likely on his phone. Follow the ground-up contract in every reply: define terms on first use, invent no names, concrete before abstract, one idea per paragraph, keep replies short, and end anything needing a decision with what Tom needs to decide plus a recommendation. Language is descriptive, never evaluative — no praise, no scolding. Stay scoped to the single item below unless Tom widens the scope; the goal of this session is his understanding and his ruling, not maximum output.`;

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
    `This is a block session: Tom committed this span of time to the category "${category}". Work through the category's items with him, one at a time, smallest concrete first steps — open an item, take its first step with him, then move on. When Tom rules out loud, record it immediately via \`npx convex run\`: tts:internalTriage for status/date changes, ttsRulings:internalRecordRuling for approve/revise/session/archive verdicts (both are internal mutations — the Tom-gated public mutations reject deploy credentials). The session is his pen, and a ruling that lives only in chat is lost.`,
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

// Live context for one batch member, resolved by the caller against the
// todos/mirror it already holds (this module never fetches). `label` names
// the subject the way the system does: a life member is just its statement,
// a code member carries "repo externalId".
export type BatchMemberContext = {
  kind: "life" | "code";
  label?: string;
  statement: string;
  status: string;
};

// The live (newest) ruling on this todo, when the caller holds one. Every
// verdict may carry a sentence (ratified 2026-08-29) — the note Tom wrote when
// he ruled — and the session that follows a "session" verdict is exactly where
// that sentence has to arrive, or he has to repeat himself.
export type LiveRulingContext = {
  verdict: "approve" | "revise" | "session" | "archive";
  sentence?: string;
};

export function buildTodoSessionPrompt(
  todo: Doc<"dtsTodos">,
  kind: "gate" | "focus-item",
  batch?: { members: BatchMemberContext[] },
  ruling?: LiveRulingContext,
): string {
  const rulingNote = ruling?.sentence?.trim();
  const lines = [
    CONTRACT,
    "",
    kind === "gate"
      ? "This is a tom-gate session: the item below is ready-for-tom and needs his input integrated. Walk him through it ground-up, take his ruling, and shape the result with him."
      : "This is a focus session: Tom chose to begin this item now. Open with the smallest concrete first step and work it with him.",
    "",
    ...(ruling
      ? [
          rulingNote
            ? `Tom's standing ruling on this item is "${ruling.verdict}", and he wrote: ${rulingNote}. That sentence is his instruction for this session and overrides any other reading of the item.`
            : `Tom's standing ruling on this item is "${ruling.verdict}" (no note written).`,
          "",
        ]
      : []),
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

  // A batch (a todo with `members`) is worked as a walk-through of its plan:
  // one session advances every member, and the pens record what lands.
  if (todo.members !== undefined) {
    lines.push(
      "",
      "This item is a BATCH: one grouping of several todos, so one session's worth of shared context advances all of them. Its plan is the working order.",
    );
    const plan = todo.plan ?? [];
    if (plan.length > 0) {
      lines.push("", `The plan (${plan.length} steps, in order):`);
      plan.forEach((step, i) => {
        lines.push(
          `${i + 1}. [${step.actor}, ${step.status}] ${step.text}${step.evidence ? ` (evidence: ${step.evidence})` : ""}`,
        );
      });
    } else {
      lines.push("", "The batch has no plan yet — building one with Tom is the first step.");
    }
    const members = batch?.members ?? [];
    if (members.length > 0) {
      lines.push("", `The members (${members.length}, live statuses):`);
      for (const m of members) {
        lines.push(
          `- [${m.kind}${m.label ? ` ${m.label}` : ""}, ${m.status}] "${m.statement}"`,
        );
      }
    } else {
      lines.push("", `The batch lists ${todo.members.length} members; their live statuses were not resolved for this prompt.`);
    }
    lines.push(
      "",
      "Walk-through contract:",
      '- Work the plan IN ORDER. Steps with actor "agent" you do yourself.',
      '- At each OPEN step with actor "tom", put the question to Tom AND keep implementing — do the best-judgment option in the workspace while he considers. His ruling gates what PERSISTS (merges, verdicts, statuses), not what you attempt.',
      `- Record plan progress the moment a step closes: \`npx convex run tts:internalPrepareTodo '{"id": "${todo._id}", "plan": [ ...the full updated plan... ]}'\` — the full plan array, never a diff.`,
      "- Record Tom's spoken verdicts (approve/revise/session/archive, on the batch or any member) via ttsRulings:internalRecordRuling; status/date changes via tts:internalTriage.",
      "- Apply Tom's spoken en-masse property changes (importance, category) via tts:internalBulkUpdate.",
      "- All of these are pens for Tom's spoken word — use them only while Tom is present in the session.",
    );
  }
  return lines.join("\n");
}
