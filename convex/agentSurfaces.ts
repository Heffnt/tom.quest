// The whole reach of the `agent` role, in one list.
//
// WHAT `agent` IS: the role held by the account a TTS session signs in as
// (worker/bin/tts-browse --login) so it can LOOK at a tom.quest page it just
// changed. Every interesting page is role-gated, so an anonymous browse
// reports an empty shell — a false negative, not a result. Before this role
// existed, the only account that made the browser useful was Tom's own, which
// also let a session cancel a training job from /turing.
//
// WHY THE LIST IS NAMED SURFACES AND NOT PAGES: the strings below are the
// SAME labels the WRITE gates already pass, so a read gate and a write gate
// argue over one vocabulary instead of two that can drift. The two gates that
// take them are requireTom(ctx, label) in Convex — whose labels today are
// "TTS", "Sessions", "Forge" and "User roles" — and
// requireAdminOrAgent(request, surface) in the Next.js route handlers, whose
// one label today is "Turing" (app/api/turing/[...path]/route.ts). Each entry
// below matches one of them: "TTS" the Convex label, "Turing" the route one.
// A page that is gated only in a route handler therefore has no requireTom
// label at all, and adding one here does not create one.
//
// WHY THIS FILE IMPORTS NOTHING: it is read by Convex functions, by Next.js
// route handlers, by client components, and by tests. A single import of
// server code here would drag that code into the browser bundle.
//
// HOW THE LIST WAS CHOSEN — from what was already written down, not a guess:
//   - worker/bin/tts-browse's own header: "every /turing and /tts page is
//     role-gated", naming exactly these two.
//   - worker/README.md's two worked browse examples are both /turing.
// DELIBERATELY ABSENT: "Sessions", "Forge", "Jarvis" and /logo (a session
// reading its own transcripts, or Tom's build surfaces, is not looking at a
// change it made), and /canvas (its agent route spends LLM credits).
//
// WIDENING THIS LATER IS ADDING ONE NAME TO THIS ARRAY. Narrowing is removing
// one. Nothing else moves.
export const AGENT_READABLE_SURFACES = ["TTS", "Turing"] as const;

export type AgentReadableSurface = (typeof AGENT_READABLE_SURFACES)[number];

/**
 * True when `label` names a surface the `agent` role may READ. Never implies
 * a write: every mutation, action and internal function stays on requireTom.
 */
export function isAgentReadableSurface(label: string): boolean {
  return (AGENT_READABLE_SURFACES as readonly string[]).includes(label);
}
