// Builds the opening prompt for a TTS session (spec: WikiTom tts/spec.md).
// One home for the session-opening contract: Focus's "work in a session" and
// the Inventory's gate button both route through here, so the ground-up
// framing cannot drift between entry points.

import type { Doc, Id } from "@/convex/_generated/dataModel";

// The opening has two halves. The FRAMING says what this session is and how
// wide it is; it is only true here, so it lives only here.
const FRAMING = `You are working inside TTS (Tom's Delegated Todo System), in an interactive session with Tom — likely on his phone. Stay scoped to the single item below unless Tom widens the scope; the goal of this session is his understanding and his ruling, not maximum output.`;

// The WRITING half is the same standard every other TTS prompt carries, and
// its live source is the WikiTom skill "writing-to-tom" (synced into
// ttsSkills; convex/ttsShared.ts WRITING_SKILL names the row). Callers read it
// with useQuery(api.ttsSkills.getSkill) and pass the body in. This string is
// the FALLBACK for a session opened before the sync has ever run.
const CONTRACT = `Follow the ground-up contract in every reply: define terms on first use, invent no names, concrete before abstract, one idea per paragraph, keep replies short, and end anything needing a decision with what Tom needs to decide plus a recommendation. Language is descriptive, never evaluative — no praise, no scolding.`;

/** The opening block: the framing, then the writing skill or its fallback. */
function opening(writingSkill?: string): string {
  const skill = writingSkill?.trim();
  return skill ? `${FRAMING}\n\n${skill}` : `${FRAMING} ${CONTRACT}`;
}

function fact(label: string, value: string | undefined): string | null {
  return value && value.trim() !== "" ? `${label}: ${value}` : null;
}

// How a session persists what Tom says (one home for the instruction; every
// session prompt carries it). The prompts used to promise `npx convex run
// tts:internalTriage` / `ttsRulings:internalRecordRuling` — mutations NO
// session can reach: the deploy credential they need is not in a session's
// environment, on purpose (ledger graduation session-has-no-ruling-pen,
// 2026-08-31: the prompt stops promising a pen that does not exist). What a
// session's shell CAN reach is the capture pen (X-TTS-Key), so a spoken
// ruling is recorded as a captured fact the pipeline briefs and Tom confirms
// in the UI — rulings themselves persist only through Tom's own UI, which is
// a deliberate boundary, not a gap.
const RULING_PEN = `When Tom rules or decides something out loud, record it IMMEDIATELY with the capture pen: curl -s -X POST "$CONVEX_SITE_URL/tts/capture" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"statement": "Tom ruled: <the decision, verbatim, with its subject named>", "source": "session"}' (both variables are already set in this session's environment). The capture reaches the pile as a fact for Tom to confirm in the UI — the session itself has no direct ruling pen, on purpose. A ruling that lives only in chat is lost.`;

// Opening prompt for a BLOCK session: committed time over a category of
// todos, not a single item. Same contract; the session works the set with
// Tom one item at a time and records his spoken rulings as they land.
export function buildBlockSessionPrompt(
  category: string,
  todos: Doc<"dtsTodos">[],
  writingSkill?: string,
): string {
  const lines: string[] = [
    opening(writingSkill),
    "",
    `This is a block session: Tom committed this span of time to the category "${category}". Work through the category's items with him, one at a time, smallest concrete first steps — open an item, take its first step with him, then move on. ${RULING_PEN}`,
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

// ── Batch sessions (schema v2) ───────────────────────────────────────────────
// A BATCH IS NO LONGER A TODO: it is its own row holding a graph of task- and
// goal-todos, so a batch session cannot be built by buildTodoSessionPrompt
// (which describes one dtsTodos row). Same contract, same pens; the item it
// opens on is the graph.
export type BatchSessionContext = {
  /** The batch row itself — the session's SUBJECT (claudeSessions.batchId),
   * so the server can resolve the batch's declared repos directly (ledger
   * graduation session-repos-need-batch-subject). Never printed in the
   * prompt. */
  id: Id<"batches">;
  statement: string;
  groundUp?: string;
  path?: { name: string; index: number };
  tasks: {
    statement: string;
    actor: "tom" | "agent";
    /** Done, ready (every need done) or blocked — the card's own three sets. */
    state: "done" | "ready" | "blocked";
    waitingOn: string[];
    evidence?: string;
  }[];
  goals: { statement: string; condition?: string; met: boolean }[];
};

export function buildBatchSessionPrompt(
  batch: BatchSessionContext,
  writingSkill?: string,
): string {
  const lines: (string | null)[] = [
    opening(writingSkill),
    "",
    "This is a batch session. A BATCH holds how a set of todos gets completed: it is not itself a todo and is never worked directly. Its contents are TASKS (work someone does) and GOALS (a state of the world the batch is for, written as a condition that is either true yet or not). A todo is READY when every todo it NEEDS is done. Work the ready tasks with Tom, smallest concrete first step first.",
    "",
    `THE BATCH ("${batch.statement}"):`,
    fact("ground-up explanation", batch.groundUp),
    batch.path
      ? `path: "${batch.path.name}", position ${batch.path.index}`
      : null,
  ];

  const say = (t: BatchSessionContext["tasks"][number]) =>
    `- [${t.actor}, ${t.state}] "${t.statement}"${
      t.waitingOn.length > 0 ? ` — waiting on: ${t.waitingOn.join("; ")}` : ""
    }${t.evidence ? ` (evidence: ${t.evidence})` : ""}`;

  if (batch.tasks.length === 0) {
    lines.push("", "The batch has no tasks yet — building the graph with Tom is the first step.");
  } else {
    lines.push("", `The tasks (${batch.tasks.length}):`);
    for (const state of ["ready", "blocked", "done"] as const) {
      for (const t of batch.tasks.filter((x) => x.state === state))
        lines.push(say(t));
    }
  }

  if (batch.goals.length > 0) {
    lines.push("", `The goals (${batch.goals.length}):`);
    for (const g of batch.goals) {
      lines.push(
        `- [${g.met ? "met" : "not yet met"}] "${g.statement}"${
          g.condition ? ` — condition: ${g.condition}` : ""
        }`,
      );
    }
  }

  lines.push(
    "",
    "Walk-through contract:",
    '- Take the READY tasks in order. A task with actor "agent" you do yourself.',
    '- At a ready task with actor "tom", put the question to Tom AND keep implementing — do the best-judgment option in the workspace while he considers. His ruling gates what PERSISTS (merges, verdicts, statuses), not what you attempt.',
    `- ${RULING_PEN}`,
  );
  return lines.filter((l): l is string => l !== null).join("\n");
}

export function buildTodoSessionPrompt(
  todo: Doc<"dtsTodos">,
  kind: "gate" | "focus-item",
  batch?: { members: BatchMemberContext[] },
  ruling?: LiveRulingContext,
  writingSkill?: string,
): string {
  const rulingNote = ruling?.sentence?.trim();
  const lines = [
    opening(writingSkill),
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
      `- Record plan progress the moment a step closes: curl -s -X POST "$CONVEX_SITE_URL/tts/prepare-todo" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"id": "${todo._id}", "plan": [ ...the full updated plan... ]}' — the full plan array, never a diff.`,
      `- ${RULING_PEN}`,
    );
  }
  return lines.join("\n");
}
