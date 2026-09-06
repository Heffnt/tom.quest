// Builds the opening prompt for a TTS session (spec: WikiTom tts/spec.md).
// One home for the session-opening contract: Focus's "work in a session" and
// the Inventory's gate button both route through here, so the ground-up
// framing cannot drift between entry points.

// Relative, not "@/": convex/claudeSessions.ts imports this module for the
// code block session's ruling lines, and the Convex typecheck (convex/
// tsconfig.json) knows no path alias — the same reason convex/brews.ts reaches
// app/perfume by a relative path.
import type { Doc, Id } from "../../convex/_generated/dataModel";

// The FRAMING says what this session is and how wide it is; it is only true
// here, so it lives only here. The WRITING half is not built here at all:
// every session opener begins with the model-of-tom files (WikiTom
// writing.md, priorities.md, schedule.md, the area pages' current-state and
// must-not-break sections), prepended server-side in one home —
// convex/claudeSessions.ts insertSession, reading convex/ttsSkills.ts
// modelOfTomPrelude — so the transcript's first row names the WikiTom commit
// the session began with. Until the nightly job's first post that prelude is
// the hardcoded writing standard (convex/ttsShared.ts WRITING_STANDARD) under
// a header saying so; nothing in this file falls back on its own.
const FRAMING = `You are working inside TTS (Tom's Delegated Todo System), in an interactive session with Tom — likely on his phone. Stay scoped to the single item below unless Tom widens the scope; the goal of this session is his understanding and his ruling, not maximum output. Follow the writing standard in the model-of-tom files this prompt begins with in every reply, and end anything needing a decision with what Tom needs to decide plus a recommendation.`;

function fact(label: string, value: string | undefined): string | null {
  return value && value.trim() !== "" ? `${label}: ${value}` : null;
}

// How a session persists what Tom says (one home for the instruction; every
// session prompt carries it). Two pens, both on the key a session's shell
// already holds (X-TTS-Key):
//
//   POST /tts/ruling (ruling 15, 2026-09-05) — a ruling Tom STATED in plain
//   language. The agent names the turn it read (the daemon prints
//   "inbound row: <id>" under every turn Tom typed — worker/session-host/
//   session.mjs deliveredTurnText), the verdict, the subject, and one whole
//   sentence of his verbatim (the `quote`, provenance only); on revise it
//   also writes the ruling's own `sentence`, the redirect — another whole
//   sentence of the same turn, or the quote again, never the agent's own
//   wording. The server, not the prompt, is what makes this Tom's pen: it
//   refuses a turn Tom did not type, a quote or redirect that is not a whole
//   sentence of that turn, a subject that does not exist or that this
//   session is not about (the item, batch, or block on its row), and a
//   second ruling from the same turn on the same subject
//   (convex/ttsRulings.ts internalRecordRulingFromTomWords). Every
//   ruling written this way is quoted in the digest, so a misreading is his
//   to object to there — which is why ambiguity stays the agent's call.
//
//   POST /tts/capture — everything else he says that must not be lost,
//   including a sentence whose verdict or subject is unclear: a fact for the
//   pipeline to brief and Tom to confirm in the UI. (Before ruling 15 this was
//   the only pen: the prompts once promised `npx convex run
//   ttsRulings:internalRecordRuling`, which needs a deploy credential no
//   session holds — ledger graduation session-has-no-ruling-pen, 2026-08-31.)
const INBOUND_ROW_LABEL = "inbound row:";
const RULING_PEN = `When Tom states a ruling in plain language — approve, revise, session, or archive, on an item this prompt names — write it the moment he says it: curl -s -X POST "$CONVEX_SITE_URL/tts/ruling" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"inboundId": "<the id after \\"${INBOUND_ROW_LABEL}\\" at the end of the turn he said it in>", "verdict": "<approve|revise|session|archive>", "subjectType": "<life|code|batch>", "subjectId": "<the subject's id as this prompt gives it; a code subject is \\"<repo> <externalId>\\">", "quote": "<one whole sentence of that turn, copied exactly — never a fragment or a single word>", "sentence": "<on revise only: the one sentence of that same turn that redirects the preparing agent, copied exactly — it may be the quote itself, and it is never your own wording; omit the field on every other verdict>"}' (both variables are already set in this session's environment). The server writes the ruling only if that turn was typed by Tom, the quote — and on revise the sentence — is a whole sentence of it word for word, and the subject is one this session is about (the item, batch, or block named in this prompt; a ruling on anything else is refused), and applies it exactly as the matching button would; the quote is kept as provenance and never becomes the item's text; the morning digest quotes every ruling written this way, so a misreading is objected there. The message that opened this session is never a source: it carries no "${INBOUND_ROW_LABEL}" line and the server refuses it, so if Tom stated a ruling there, ask him to say it again in a later turn and write it from that turn. If his words leave the verdict or the subject unclear, do not guess: record them as a fact instead: curl -s -X POST "$CONVEX_SITE_URL/tts/capture" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"statement": "Tom said: <his words, verbatim, with the subject named>", "source": "session"}'. A ruling that lives only in chat is lost.`;

// Opening prompt for a BLOCK session: committed time over a category of
// todos, not a single item. Same contract; the session works the set with
// Tom one item at a time and records his spoken rulings as they land.
export function buildBlockSessionPrompt(
  category: string,
  todos: Doc<"dtsTodos">[],
): string {
  const lines: string[] = [
    FRAMING,
    "",
    `This is a block session: Tom committed this span of time to the category "${category}". Work through the category's items with him, one at a time, smallest concrete first steps — open an item, take its first step with him, then move on. ${RULING_PEN}`,
    "",
  ];
  if (category === "code") {
    lines.push(
      'The queue for "code" is the code-todo mirror and its prepared briefs (dtsCodeTodoMirror + dtsCodeBriefs) — work from those, not from a list in this prompt. The one list this prompt does carry is below it, added by the server when the session was recorded: the code todos Tom ruled "session" on, with what he wrote — those come first.',
    );
  } else if (todos.length === 0) {
    lines.push(`No active todos carry the category "${category}" right now.`);
  } else {
    lines.push(`Active todos in "${category}" (${todos.length}):`);
    for (const t of todos) {
      const facts = [
        fact("id (life subject)", t._id),
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

// The code todos a CODE BLOCK session is the conversation for: each carries a
// live "session" verdict, and opening the block is what applies it — so the
// prompt has to name the subject and Tom's sentence, or the verdict is
// consumed without the conversation ever reaching the session. Built by
// the server at insert time (convex/claudeSessions.ts insertSession) from the
// same rows it marks applied, so the set named and the set consumed are one
// set by construction. The subject is spelled the way a ruling names it
// ("<repo> <externalId>", ttsRulings.subjectKey's code tail).
export type CodeSessionSubject = {
  repo: string;
  externalId: string;
  /** The mirror's statement for the entry, when the mirror still holds it. */
  statement?: string;
  /** The note Tom wrote with the verdict, when he wrote one. */
  sentence?: string;
};

export function codeSessionRulingLines(
  subjects: readonly CodeSessionSubject[],
): string[] {
  if (subjects.length === 0) return [];
  const lines = [
    `Tom ruled "session" on these code todos (${subjects.length}) — each is a conversation he asked for, and this session is where it happens, so open with them, in this order:`,
  ];
  for (const s of subjects) {
    const note = s.sentence?.trim();
    lines.push(
      `- ${s.repo} ${s.externalId}${s.statement ? ` "${s.statement}"` : ""} — ${
        note ? `he wrote: ${note}` : "no note written"
      }`,
    );
  }
  return lines;
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
   * graduation session-repos-need-batch-subject). Printed once, as the
   * subject id a ruling on the batch itself names. */
  id: Id<"batches">;
  statement: string;
  groundUp?: string;
  /** The statements of the batches this batch needs done first. */
  needs?: string[];
  tasks: {
    /** The todo's own id — the life subject a ruling on this task names
     * (the card's graph carries it as a plain string; only printed here). */
    id: string;
    statement: string;
    actor: "tom" | "agent";
    /** Done, ready (every need done) or blocked — the card's own three sets. */
    state: "done" | "ready" | "blocked";
    waitingOn: string[];
    evidence?: string;
  }[];
  goals: {
    id: string;
    statement: string;
    condition?: string;
    /** Tom's own line on what the work toward this goal must not break. */
    mustNotBreak?: string;
    met: boolean;
  }[];
};

// The lines a standing ruling adds to an opening prompt — the same two shapes
// for a todo and a batch, so the session verdict reads the same on both.
function rulingLines(ruling: LiveRulingContext | undefined): string[] {
  if (!ruling) return [];
  const note = ruling.sentence?.trim();
  return [
    note
      ? `Tom's standing ruling on this item is "${ruling.verdict}", and he wrote: ${note}. That sentence is his instruction for this session and overrides any other reading of the item.`
      : `Tom's standing ruling on this item is "${ruling.verdict}" (no note written).`,
    "",
  ];
}

export function buildBatchSessionPrompt(
  batch: BatchSessionContext,
  /** The ruling just recorded (the session verdict) — its sentence goes into
   * the prompt so Tom never repeats himself. */
  ruling?: LiveRulingContext,
): string {
  const lines: (string | null)[] = [
    FRAMING,
    "",
    "This is a batch session. A BATCH holds how a set of todos gets completed: it is not itself a todo and is never worked directly. Its contents are TASKS (work someone does) and GOALS (a state of the world the batch is for, written as a condition that is either true yet or not). A todo is READY when every todo it NEEDS is done. Work the ready tasks with Tom, smallest concrete first step first.",
    "",
    ...rulingLines(ruling),
    `THE BATCH ("${batch.statement}"):`,
    fact("id (batch subject)", batch.id),
    fact("ground-up explanation", batch.groundUp),
    batch.needs && batch.needs.length > 0
      ? `this batch needs (batches that must land first): ${batch.needs.map((n) => `"${n}"`).join(", ")}`
      : null,
  ];

  const say = (t: BatchSessionContext["tasks"][number]) =>
    `- [${t.actor}, ${t.state}] "${t.statement}" (id ${t.id})${
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
        `- [${g.met ? "met" : "not yet met"}] "${g.statement}" (id ${g.id})${
          g.condition ? ` — condition: ${g.condition}` : ""
        }${g.mustNotBreak ? ` — MUST NOT BREAK (Tom's own line, binding on every step toward this goal): ${g.mustNotBreak}` : ""}`,
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
): string {
  const lines = [
    FRAMING,
    "",
    kind === "gate"
      ? "This is a tom-gate session: the item below is ready-for-tom and needs his input integrated. Walk him through it ground-up, take his ruling, and shape the result with him."
      : "This is a focus session: Tom chose to begin this item now. Open with the smallest concrete first step and work it with him.",
    "",
    ...rulingLines(ruling),
    `The item ("${todo.statement}"):`,
    fact("id (life subject)", todo._id),
    fact("must not break (Tom's own line, binding)", todo.mustNotBreak),
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
