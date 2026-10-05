// Invented rows for the thread's page tests: one of every type the stream
// draws, as api.thread.messages and api.thread.changes return them.

import type { AgentChange, OpenItems, ThreadMessage } from "@/app/thread/feed";

export const NOW = Date.UTC(2026, 9, 5, 14, 0); // 10:00 New York
const at = (minutes: number) => NOW - minutes * 60_000;

const WORDS = ["fact", "todo", "rule", "errand", "question", "answer", "leaving", "back", "issue", "no-issues"] as const;

export const MESSAGES = [
  ...WORDS.map((word, i) => ({
    kind: "message", id: `m-${word}`, at: at(200 - i), text: `Message classed ${word}.`, subject: null,
    reply: { at: at(199 - i), text: `Reply of type ${word}.`, kind: word },
  })),
  {
    kind: "digest", id: "d1", at: at(180), day: "2026-10-05", text: "The digest text.",
    items: [{ n: 1, text: "Item one." }],
    sectionCounts: { today: 2, objections: 1, "needs-you-today": 5, calendar: 3, spend: 1 },
    laterItems: 1,
    replies: [{ id: "r1", at: at(170), text: "1 done", reply: { at: at(169), text: "Item 1: its todo is marked done.", kind: "answer" } }],
  },
  { kind: "alarm", id: "a1", at: at(150), text: "The digest cron is silent.", href: "https://tom.quest/agents?view=window" },
  { kind: "item", id: "i1", at: at(160), digestId: "d1", day: "2026-10-05", n: 2, text: "Late item." },
  {
    kind: "decision", id: "dec1", at: at(140), askId: "86f2f341", question: "One session or two?", decision: "One.",
    reason: "His pages say one.", restedOn: ["ruling:abc"], wouldChange: "If the queue fell behind.", caller: "job:proof",
    model: "opus", todoId: "todo1", decidedByTom: false, waitedMs: 7_200_000, settled: null,
  },
  {
    kind: "decision", id: "dec2", at: at(130), askId: "14606c4b", question: "Move the run", decision: "Thursday.",
    reason: null, restedOn: [], wouldChange: null, caller: "job:plan", model: null, todoId: null,
    decidedByTom: false, waitedMs: null, settled: { at: at(120), verdict: "approve", sentence: null },
  },
  {
    kind: "decision", id: "dec3", at: at(125), askId: "7e000001", question: "Which bank?", decision: "The credit union.",
    reason: null, restedOn: [], wouldChange: null, caller: "job:plan", model: null, todoId: null,
    decidedByTom: true, waitedMs: 720_000, settled: null,
  },
  { kind: "message", id: "obj1", at: at(135), text: "Two, not one.", subject: "dec1", reply: null },
  {
    kind: "suggestion", id: "s1", at: at(110), subject: "tom.quest@abcdef1", href: "https://github.com/Heffnt/tom.quest/commit/abcdef1",
    class: "landing", built: true, restsOn: { text: "fix it", source: "ruling r1" }, answer: null, text: "Landed the fix.",
  },
  {
    kind: "suggestion", id: "s2", at: at(100), subject: "log-page", href: "/design#log-page",
    class: "deletion", built: false, restsOn: null, answer: null, text: "Delete the log page.",
  },
  {
    kind: "suggestion", id: "s3", at: at(105), subject: "push-page", href: "/design#push-page",
    class: "deletion", built: true, restsOn: null, answer: { at: at(95), text: "yes, keep it gone", messageId: "ans1" },
    text: "Deleted the push page.",
  },
  { kind: "message", id: "ans1", at: at(95), text: "yes, keep it gone", subject: "s3", reply: null },
  { kind: "check", id: "c1", at: at(90), part: "digest", check: "size", measure: 9, target: 4, agentHref: "/agents?session=s" },
  {
    kind: "diagnosis", id: "g1", at: at(80), part: "digest", text: "The digest grew.",
    causes: [{ n: 1, class: "code", sentence: "The digest grew." }], fixLanding: "ch1", preventionLanding: null,
  },
] as unknown as ThreadMessage[];

export const CHANGES = [
  {
    id: "ch1", at: at(60), kind: "merge", line: "Merged tom.quest #341: thread: one page",
    href: "https://github.com/Heffnt/tom.quest/commit/aaaa", repo: "tom.quest", sha: "aaaa",
    pull: { number: 341, title: "thread: one page" }, claim: "The thread is the one page.",
    diff: { added: ["thread-page"], changed: [], removed: ["log-page"] },
    parts: [{ id: "thread-page", name: "The thread page", fate: "added" }, { id: "log-page", name: "log-page", fate: "removed" }],
    checksAlone: true, explanation: null,
  },
  { id: "ch2", at: at(50), kind: "deploy", line: "Deployed tom.quest aaaa111..bbbb222, 1 commit(s)", href: "https://github.com/Heffnt/tom.quest/compare/a...b" },
] as unknown as AgentChange[];

export const OPEN = {
  needsYou: [
    { id: "o1", key: "k1", at: at(40), text: "Answer the newest item.", todoId: "todo1", statement: "The todo's statement", n: 2, digestId: "d1", day: "2026-10-05", digestAt: at(180) },
    { id: "o2", key: "k2", at: at(2000), text: "Answer yesterday's item.", job: "calendar", n: 1, digestId: "d0", day: "2026-10-04", digestAt: at(1500) },
  ],
  // A decision older than the stream's 60 days, still unsettled.
  decisions: [
    { kind: "decision", id: "od1", at: at(61 * 24 * 60), askId: "0ld00001", question: "Keep the old run?", decision: "Keep it.",
      reason: "It still answers.", restedOn: ["ruling:old"], wouldChange: null, caller: "job:old", model: "opus",
      todoId: "todo9", decidedByTom: false, waitedMs: 7_200_000, settled: null },
  ],
  questions: [
    { id: "p1", at: at(20), sessionId: "sess1", title: "the bank session", question: "Which account?", href: "/agents?session=sess1" },
  ],
  // A suggestion older than the stream's 60 days, still unanswered.
  suggestions: [
    { kind: "suggestion", id: "os1", at: at(62 * 24 * 60), class: "deletion", built: false, text: "Delete the old page.",
      subject: "old-page", href: "/design#old-page", restsOn: { text: "drop the old page", source: "ruling r9" }, answer: null },
  ],
  counts: { liveSessions: 3, partial: [] },
} as unknown as OpenItems;
