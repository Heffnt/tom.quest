// The code-session ruling lines are shared with convex/claudeSessions.ts.
// Relative imports work in both the Next.js and Convex TypeScript builds.

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
