// banned-tools.mjs — the tools a tom.quest session may not call at all, and
// the sentence the model reads when it tries.
//
// A BANNED tool is different from a gated one. The Bash classifier and the
// out-of-workdir edit check in session.mjs judge a CALL: same tool, allowed
// or denied depending on its arguments. A banned tool has no allowed
// arguments — nothing on the tom.quest side can carry out what it asks for,
// in any session mode — so it is removed from the model's context entirely
// (the SDK's `disallowedTools`) and denied again at the permission gate if it
// somehow still arrives.
//
// THE ONE MEMBER, AskUserQuestion. That tool exists to render a multiple-
// choice picker the human clicks; its result is the option they picked. Two
// facts about this system make that impossible:
//   - tom.quest's transcript renders every tool call the same way — a tool
//     name and an input preview (app/sessions/components/message-row.tsx).
//     There is no picker anywhere on the page, so an interactive session's
//     question reaches Tom as an unanswerable row.
//   - an autonomous session has no human on the other end at all, by
//     definition ("no one is watching this transcript live" — the mission
//     prompt in convex/claudeSessions.ts).
// The daemon's permission posture auto-allows tool calls, so an allowed
// AskUserQuestion does not park and wait: it returns without a chosen option,
// and the model continues as though it had consulted someone. Banning it
// converts that silent non-answer into a deny the model can read and act on.
//
// WHY ITS OWN FILE: this rule is the one piece of the permission posture the
// repo's test suite can execute. session.mjs imports @anthropic-ai/
// claude-agent-sdk, which is installed only on the worker box
// (/opt/tts/session-host/node_modules), so vitest cannot import that module;
// this one depends on nothing.

// Tool names removed from every session's context. Passed to the SDK query as
// `disallowedTools` and re-checked in the permission gate.
export const BANNED_TOOLS = ["AskUserQuestion"];

// The message a denied call sends back to the model. It must say what to do
// INSTEAD, and the instead differs by session mode: an interactive session
// has Tom reading the transcript and answering in his next turn; an
// autonomous one has the ratified doctrine that his input gates what
// persists, never what the session attempts.
export function bannedToolDenial(toolName, mode) {
  if (!BANNED_TOOLS.includes(toolName)) return null;
  const instead =
    mode === "autonomous"
      ? "No one is watching this transcript, so there is no one to answer. Implement your best-judgment option and name the alternatives you passed over where the work persists — the pull request, or the item's plan."
      : "Its option picker has no surface in tom.quest's transcript. Put the question, the options, and your recommendation in your reply text instead; Tom answers in his next turn.";
  return `${toolName} is not available in tom.quest sessions. ${instead}`;
}
