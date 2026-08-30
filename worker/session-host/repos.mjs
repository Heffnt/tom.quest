// The two facts about WHERE a session lives and WHAT it may check out.
//
// They sit in their own module, rather than in session.mjs, because
// open-pr.mjs needs the repo allowlist to decide whether it may open a pull
// request — and importing session.mjs for it would drag the whole Claude agent
// SDK into a one-shot CLI. A third literal copy was the alternative, and this
// file exists precisely so there is not one.
//
// scripts/check-session-mirrors.mjs fences REPO_GITHUB against SESSION_REPOS
// in convex/ttsShared.ts (the one home across the language boundary: the box
// runs only worker/, and Node does not load .ts).

// Session workdirs live under /var/cache by the box's convention: everything
// under /var/cache/tts is rebuildable, so `rm -rf` of any of it is harmless
// (the no-state rule). A session's real output leaves through git pushes /
// whatever Tom asks the model to do — never through files that stay here.
export const SESSIONS_ROOT = "/var/cache/tts/sessions";

// The repos a session may check out (claudeSessions.repo). Everything is
// under github.com/Heffnt — same owner the code-todo jobs use.
// MIRROR of SESSION_REPOS in convex/ttsShared.ts (the one home).
export const REPO_GITHUB = {
  "tom.quest": "Heffnt/tom.quest",
  ComplexMultiTrigger: "Heffnt/ComplexMultiTrigger",
  WikiTom: "Heffnt/WikiTom",
};
