// Builds the opening prompt for a TTS session (spec: WikiTom tts/spec.md).
// One home for interactive session framing: Focus's "work in a session" and
// the Inventory's gate button both route through here, so their framing cannot
// drift between entry points.

// Relative, not "@/": convex/claudeSessions.ts imports this module for the
// code block session's ruling lines, and the Convex typecheck (convex/
// tsconfig.json) knows no path alias — the same reason convex/brews.ts reaches
// app/perfume by a relative path.
import type { Doc } from "../../convex/_generated/dataModel";
import { briefForPrompt } from "../../shared/context-relevance.mjs";
import { ZONE, displayForm } from "../../shared/clock.mjs";

// The FRAMING says what this session is and how wide it is; it is only true
// here, so it lives only here. insertSession prepends the model-of-tom files
// before every opener.
const FRAMING = `You are working inside TTS (Tom's Delegated Todo System), in an interactive session with Tom — likely on his phone. Stay scoped to the single item below unless Tom widens the scope; the goal of this session is his understanding and his ruling, not maximum output.`;

function fact(label: string, value: string | undefined): string | null {
  return value && value.trim() !== "" ? `${label}: ${value}` : null;
}

/**
 * The brief as the prompt carries it: whole, or cut at the last heading before
 * SUPPLEMENTAL_CAPS.brief with a line saying where the rest is. ONE HOME for
 * the cut (shared/context-relevance.mjs), which the autonomous twin in
 * convex/claudeSessions.ts calls too — so the two prompts cannot disagree about
 * where a brief stops or where the rest of it is.
 */
function briefFact(brief: string | undefined): string | null {
  return fact("brief", brief === undefined ? undefined : briefForPrompt(brief).text);
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

// The live (newest) ruling on this todo, when the caller holds one. Every
// verdict may carry a sentence (ratified 2026-08-29) — the note Tom wrote when
// he ruled — and the session that follows a "session" verdict is exactly where
// that sentence has to arrive, or he has to repeat himself.
export type LiveRulingContext = {
  verdict: "approve" | "revise" | "session" | "archive";
  sentence?: string;
};

// The lines a standing ruling adds to an opening prompt.
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

export function buildTodoSessionPrompt(
  todo: Doc<"todos">,
  kind: "gate" | "focus-item",
  ruling?: LiveRulingContext,
): string {
  const lines = [
    FRAMING,
    "",
    kind === "gate"
      ? "This is a tom-gate session: the item below is prepared and needs his input integrated. Walk him through it, take his ruling, and shape the result with him."
      : "This is a focus session: Tom chose to begin this item now. Open with the first step and work it with him.",
    "",
    `The item ("${todo.statement}"):`,
    fact("id (life subject)", todo._id),
    fact("must not break (Tom's own line, binding)", todo.mustNotBreak),
    fact("timing", todo.timingClass),
    fact(
      "due",
      todo.dueAt !== undefined ? `${displayForm(todo.dueAt)} (${ZONE})` : undefined,
    ),
    fact("work description", todo.workDescription),
    fact("entry action", todo.entryAction),
    fact("source", todo.source),
    fact("provenance", todo.provenance),
    fact("body", todo.body),
    briefFact(todo.brief),
    "",
    ...rulingLines(ruling),
  ].filter((l): l is string => l !== null);

  return lines.join("\n");
}
