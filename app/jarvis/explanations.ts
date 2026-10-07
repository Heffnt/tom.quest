// GROUND-UP EXPLANATIONS FOR THE INFO CAPTIONS.
//
// Every caption in the TTS screens is the small circled i beside a control,
// which opens a popover (app/jarvis/components/info.tsx) on a tap. The popover
// carries two things: one or two sentences of display text, and — when the
// mechanism the caption names needs teaching rather than naming — a "more"
// control that opens one of the documents in this file fullscreen.
//
// EACH EXPORTED CONSTANT HERE IS ONE COMPLETE HTML DOCUMENT, "<!DOCTYPE html>"
// through "</html>". That form is fixed by the writing standard
// (writing.md) and is not a style choice: the
// documents are forwarded verbatim to other people and other agents, and they
// render inside a sandboxed iframe with no scripting and no network, so nothing
// may load from outside — no script, no inline event handler, no external
// stylesheet, font, image, or URL. Palette #0a0e17 background, #e2e8f0 text,
// #94a3b8 secondary, #e8a040 accent, #1e293b borders; about 15px body type; one
// h1 naming the subject and an h2 per section.
// scripts/check-writing-standard.mjs checks the mechanical half of those rules
// against the explanations STORED IN CONVEX; explanations.test.ts checks the
// constants in this file, which are the other population.
//
// WHAT A DOCUMENT MUST COVER, because it is read by someone with no context at
// all: what the thing is, why it exists, what every term in the caption means
// defined at first use, what the control actually changes, what else in the
// system reads that change, and what happens next and who does it.
//
// ONE MECHANISM, ONE DOCUMENT — NOT ONE CAPTION, ONE DOCUMENT. Six
// verdict and status chips in the options row all open VERDICTS_EXPLANATION.
// Splitting those would produce documents that each teach a fragment and none
// of which is self-contained, which is the thing the standard forbids. The
// display text is what differs per caption; the ground-up layer is per
// mechanism.
//
// A DOCUMENT HERE EXPLAINS A MECHANISM SOMETHING FIRES — NEVER THE PAGE (the
// lifeos update, phase 7). Three of the ten went in that change: readiness,
// the todo's text fields, and the intent bar each taught a reader how to read
// a screen, which is explainer text with a "more" control in front of it, and
// pages never explain themselves (app/AGENTS.md). What is left is one document per
// mechanism a control sets in motion — status, the verdicts, sessions — each
// opened from the popover of the control that
// fires it, plus must-not-break, which is Tom's own field on a goal. An
// ITEM's own ground-up explanation is not here at all: it is data on the row,
// read in the detail dialog.
//
// WHY THEY LIVE IN A PLAIN MODULE. They are static text with no data in them,
// so a module constant is the whole mechanism — no fetch, no table, nothing to
// keep in sync with the deployment. The cost is bundle size: every document is
// shipped to the browser with the TTS screens whether or not a reader opens
// one. The shared PAGE_STYLE below is why that cost is roughly the prose alone
// rather than the prose plus seven copies of the same stylesheet. Measured
// 2026-08-31 at ten documents: 83 kB of text before compression, the largest
// 10 kB; seven remain. That is acceptable; past roughly a dozen, move them
// behind a route that fetches one on demand.

// The one stylesheet, inlined into every document. A document is read on its
// own, so it cannot reference this file — the emitted HTML carries a full copy.
const PAGE_STYLE = `
  html { background: #0a0e17; }
  body {
    background: #0a0e17;
    color: #e2e8f0;
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 15px;
    line-height: 1.65;
    margin: 0;
    padding: 40px 28px 96px;
  }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { color: #e8a040; font-size: 25px; line-height: 1.3; margin: 0 0 6px; font-weight: 600; }
  .sub { color: #94a3b8; font-size: 14px; margin: 0 0 34px; }
  h2 {
    color: #e8a040;
    font-size: 18px;
    margin: 38px 0 10px;
    padding-top: 14px;
    border-top: 1px solid #1e293b;
    font-weight: 600;
  }
  p { margin: 0 0 13px; }
  ul { margin: 0 0 13px; padding-left: 22px; }
  li { margin-bottom: 7px; }
  .mono, code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 13px;
    color: #e2e8f0;
  }
  table { width: 100%; font-size: 13.5px; margin: 16px 0 20px; border-collapse: collapse; }
  td, th { vertical-align: top; text-align: left; padding: 7px 10px; border: 1px solid #1e293b; }
  th { color: #e8a040; font-weight: 600; background: #0d1320; }
  .term { color: #e8a040; }
  .muted { color: #94a3b8; }
  .box { border: 1px solid #1e293b; border-radius: 4px; padding: 11px 14px; margin: 0 0 9px; }
  .arrow { color: #e8a040; text-align: center; margin: 0 0 9px; font-size: 17px; }
  .flow { margin: 18px 0 22px; }
`;

/**
 * One document from its parts. `title` is the browser title, `heading` the
 * single h1, `sub` the one line under it, `body` the h2 sections.
 */
function page(
  title: string,
  heading: string,
  sub: string,
  body: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<div class="wrap">

<h1>${heading}</h1>
<p class="sub">${sub}</p>
${body}
</div>
</body>
</html>`;
}

// The definitional paragraph almost every document needs. It is repeated in the
// emitted HTML on purpose: each document is forwarded on its own, and a
// document that assumed a reader had already opened another one would not be
// self-contained.
const WHAT_TTS_IS = `<p><span class="term">TTS</span> is Toms Todo System: the web application that holds Tom's todos and asks him for rulings. A <span class="term">todo</span> is one stored row in it — one thing to be done, held as a set of separate fields. TTS stores its data in <span class="term">Convex</span>, a hosted backend service; a <span class="term">mutation</span> is one named function there that changes stored data, and every control on these screens fires exactly one.</p>`;

export const STATUS_EXPLANATION = page(
  "Status — the four states a todo can be in",
  "Status: active, waiting, archived, done — and what changing it clears",
  "The controls beside this caption write one field, and each value carries a different set of side effects.",
  `
<h2>What this is</h2>

${WHAT_TTS_IS}

<p><span class="term">Status</span> is the field saying whether a todo is in play. It holds exactly one of four words. The controls beside this caption — Set waiting, Set active, done, archive — all call the same mutation, <span class="mono">setStatus</span> in the file <span class="mono">convex/tts.ts</span>, with a different target value and, for two of them, one extra sentence.</p>

<p>Status is not <span class="term">readiness</span>, the other short word on a todo. Readiness holds <span class="mono">unprepared</span> or <span class="mono">prepared</span> and says whether the writing-up of the todo has happened. The two are independent: a fully written-up todo can be parked, and a parked todo can be unwritten.</p>

<h2>The four values</h2>

<table>
  <tr><th>Value</th><th>What it says</th><th>The extra sentence it takes</th></tr>
  <tr><td class="mono">active</td><td>In play now. This is what every new todo starts as.</td><td>None.</td></tr>
  <tr><td class="mono">waiting</td><td>Parked. It leaves the active list.</td><td>A concrete wake time, optionally.</td></tr>
  <tr><td class="mono">archived</td><td>Set aside without being finished. Kept and readable, never deleted.</td><td>The condition under which it should be proposed back.</td></tr>
  <tr><td class="mono">done</td><td>Finished.</td><td>A note recording how.</td></tr>
</table>

<p>There is no delete. Archived and done are the only terminal states and both remain readable, which is why the archive control asks for a condition rather than for a confirmation.</p>

<h2>What each change clears, and why</h2>

<p>The mutation does not only write the new word. Each value also removes the facts the old state made true and the new one does not, so that what the panel shows is always true rather than a mixture of live and stale fields.</p>

<table>
  <tr><th>Setting it to</th><th>What is written</th><th>What is removed</th></tr>
  <tr>
    <td class="mono">active</td>
    <td>The status, and the update time.</td>
    <td>The completion time, the archive time, the unarchive condition and the wake time — all four. Reopening an item must not leave the reasons it was closed or parked lying on it.</td>
  </tr>
  <tr>
    <td class="mono">waiting</td>
    <td>The wake time exactly as given.</td>
    <td>Any previous wake time not given again. The field is assigned unconditionally, so parking a todo a second time without a time erases the first one.</td>
  </tr>
  <tr>
    <td class="mono">archived</td>
    <td>The archive time and the unarchive condition.</td>
    <td>Nothing.</td>
  </tr>
  <tr>
    <td class="mono">done</td>
    <td>The completion time. If the todo had an open due date, that date is appended to the todo's date history with the outcome <span class="mono">done</span> and the note.</td>
    <td>The open due date, once it has been recorded as kept.</td>
  </tr>
</table>

<p>That last row is one half of a rule running through the whole of TTS: a date is never cleared silently. Every date a todo has ever carried ends in a recorded outcome — kept, renegotiated before it arrived, or missed after it passed — so the history of dates is complete rather than showing only the ones that worked out.</p>

<h2>What brings a waiting todo back</h2>

<p>Nothing writes the word back. A <span class="term">sleep</span> is a stored <span class="term">wake time</span> on a todo that is otherwise active: every surface reads that instant against the clock and treats the todo as awake once it has passed. No job rewrites the row, so there is no daily run to miss and no window in which the page and a message disagree.</p>

<p>The status word <span class="mono">waiting</span> is the older shape and is still stored on rows that carry it. Such a row is parked until Tom presses Set active — no clock reaches it. What the todo is waiting <em>for</em> belongs in its own statement, where every reader already looks.</p>

<h2>What brings an archived todo back: nothing automatic</h2>

<p>The unarchive condition is stored on the row and displayed, and it is read by nothing. No job, no scheduled task, no query reads it and reactivates anything.</p>

<p>So archiving is reversible only by hand: someone reads the condition, decides it has come true, and presses Set active, which clears the condition as part of reopening. The sentence is a message to whoever next looks, not an instruction to a machine.</p>

<h2>What happens next, and who does it</h2>

<p>Each of these controls writes the field, writes one <span class="mono">status-changed</span> entry carrying the old and new values, and stops. Nothing else is scheduled and no message is sent.</p>

<p>After that: an active todo is one the box's work queue may list for an agent; a waiting todo disappears from the active list until its wake time passes; an archived or done todo leaves the working views and stays readable. All four also stamp the row as touched by Tom.</p>
`,
);

export const VERDICTS_EXPLANATION = page(
  "The verdicts — approve, revise, session, archive",
  "The four verdicts, and what each one actually sets in motion",
  "The chips beside this caption record a ruling. What follows differs completely between them, and between a life todo and a code todo.",
  `
<h2>What this is</h2>

${WHAT_TTS_IS}

<p>A <span class="term">ruling</span> is Tom's decision about one todo, stored as its own row in a table named <span class="mono">rulings</span>. Rulings are append-only: ruling on the same item again writes a new row, and the one that counts is the newest. Every chip beside this caption calls one mutation, <span class="mono">recordRuling</span> in the file <span class="mono">convex/ttsRulings.ts</span>, with a verdict and an optional sentence typed into the box next to the chips.</p>

<p>There are four verdicts and they are fixed: <span class="mono">approve</span>, <span class="mono">revise</span>, <span class="mono">session</span>, <span class="mono">archive</span>. There is deliberately no "defer" — an item put down is archived with the condition that should bring it back, so putting something down is a recorded decision rather than the absence of one.</p>

<h2>When these chips appear at all</h2>

<p>A todo shows the four verdict chips only when its status is <span class="mono">active</span> and its readiness is <span class="mono">prepared</span>. Readiness is the field saying whether the writing-up of the todo has happened, and <span class="mono">prepared</span> means an agent finished preparing it. A todo in that state is called a <span class="term">gate item</span>, and a gate item can be ruled from wherever it is seen: in the awaiting section at the top of the everything tab, or on its row in the list under it.</p>

<p>Two further chips sit beside the four and are not verdicts: <span class="mono">done</span>, which marks the todo finished, and <span class="mono">archive</span>, which sets it aside without recording a ruling. The plain archive chip appears only when the four verdict chips do not, so the two ways of archiving are never offered at once.</p>

<h2>The sentence</h2>

<p>One text box serves all six chips, and what the sentence means depends on the chip. Only <span class="mono">revise</span> requires it; the mutation refuses a revise with no sentence and says so. On <span class="mono">archive</span> the sentence <em>is</em> the condition under which the item should be proposed back. On the others it is a note kept with the ruling.</p>

<h2>What each verdict does to a life todo</h2>

<table>
  <tr><th>Verdict</th><th>What it writes</th><th>What acts on it afterwards</th></tr>
  <tr>
    <td class="mono">approve</td>
    <td>The ruling row, marked applied on the spot with the result "plan ratified". The todo itself is not changed.</td>
    <td>Nothing executes it. For todos about Tom's own life, Tom is the executor; approving records the decision and stops TTS asking.</td>
  </tr>
  <tr>
    <td class="mono">revise</td>
    <td>The todo's readiness back to <span class="mono">unprepared</span>. The ruling row stays unapplied.</td>
    <td>The planner on the Jarvis Box — Tom's always-on machine — runs every half hour, finds unapplied revise rulings, re-prepares the brief with the sentence in its prompt, and then marks the ruling applied. The sentence is the whole instruction the agent receives about what to change, so it has to stand on its own.</td>
  </tr>
  <tr>
    <td class="mono">session</td>
    <td>The ruling row, unapplied. The todo itself is not changed.</td>
    <td>Nothing runs. The ruling stays open until Tom actually opens a session on the item, at which point it is marked applied with that session's identifier.</td>
  </tr>
  <tr>
    <td class="mono">archive</td>
    <td>The todo's status to <span class="mono">archived</span>, its archive time, and the sentence as its unarchive condition. The ruling row is marked applied with the result "status archived".</td>
    <td>Nothing. No job reads unarchive conditions; bringing the item back is a manual Set active, which clears the condition.</td>
  </tr>
</table>

<p>Three of the four also stamp the todo as touched by Tom. <span class="mono">revise</span> is the exception, and deliberately: a revise hands the item back to an agent rather than settling it.</p>

<h2>What approve means on a code todo</h2>

<p>A <span class="term">code todo</span> is a row of the read-only mirror of a repository's own todo list, the file <span class="mono">vqc/todos.yaml</span>, addressed by repository name plus an identifier rather than by a row of the table <span class="mono">todos</span>. The same four chips appear on it.</p>

<p>An approve or an archive on a code todo is recorded and stays pending: the ruling row is stored, unapplied, and nothing on the Jarvis Box or in the record acts on it. A revise on a code todo is recorded and stays pending in the same way. Session is recorded and stays pending in the same way: the code block session that applied it was opened from the calendar, which is removed.</p>

<h2>What happens next, and who does it</h2>

<p>Recording a ruling writes one row, writes one <span class="mono">ruling</span> entry in the append-only event record, and — for approve and archive on a life todo — nothing further. For revise, the planner re-prepares the brief on its next half-hourly run and the item returns at <span class="mono">prepared</span> for another look. For session, the item waits until Tom opens the conversation. For approve, archive or revise on a code todo, the ruling stays pending.</p>
`,
);

export const SESSIONS_EXPLANATION = page(
  "Opening a session — what is created and where it runs",
  "Opening a session: what is created, where it runs, and what it may do",
  "The button beside this caption starts one Claude Code agent on Tom's own machine, with this item already in its opening prompt.",
  `
<h2>What this is</h2>

${WHAT_TTS_IS}

<p>A <span class="term">session</span> is one agent of Claude Code — the command-line coding agent — started by TTS and carried out on the machine the code calls the <span class="term">Jarvis Box</span>, Tom's always-on machine. Pressing the button beside this caption calls the mutation <span class="mono">createSession</span> in the file <span class="mono">convex/claudeSessions.ts</span>, which stores a row describing the session and the text of its opening prompt. Nothing is launched by that mutation; it only writes.</p>

<p>A program on the Jarvis Box, the <span class="term">daemon</span>, polls TTS constantly — every second while something is happening, every thirty seconds when nothing is — and claims any session row it finds in the requested state. TTS treats the daemon as absent if it has not polled for ninety seconds. Everything the session then does is streamed back into TTS through that same connection, which is what the session view on the site is showing.</p>

<h2>The types of session</h2>

<p>The <span class="term">session type</span> is stored on the row, in the field <span class="mono">kind</span>, and decides one paragraph of the opening prompt. There are four.</p>

<table>
  <tr><th>Type</th><th>Started from</th><th>What its prompt says</th></tr>
  <tr><td class="mono">gate</td><td>A todo whose readiness is <span class="mono">prepared</span>.</td><td>That the item is ready and needs Tom's input integrated: walk him through it from the ground up, take his ruling, and shape the result with him.</td></tr>
  <tr><td class="mono">focus-item</td><td>Any other todo.</td><td>That Tom chose to begin this item now: open with the smallest concrete first step and work it with him.</td></tr>
  <tr><td class="mono">weekly</td><td>The session list page only.</td><td>Nothing extra — the prompt is whatever was typed.</td></tr>
  <tr><td class="mono">adhoc</td><td>The session list page.</td><td>Nothing extra — the prompt is whatever was typed.</td></tr>
</table>

<p>The button beside a todo picks between the first two by that todo's readiness alone.</p>

<h2>Which repositories it gets, and how</h2>

<p>A session works in a fresh copy of whatever code it needs. Which repositories those are is decided by two rules, consulted in order, the first that answers winning — and an answer of "none at all" is an answer that stops the search.</p>

<table>
  <tr><th>Order</th><th>Rule</th></tr>
  <tr><td>1</td><td>Whatever the caller passed explicitly. The todo buttons deliberately pass nothing, so that the rule below decides.</td></tr>
  <tr><td>2</td><td>A scan of the todo's own text — statement, brief, explanation — for the name of a known repository, returning every match.</td></tr>
</table>

<p>The known repositories are a fixed list of four: <span class="mono">tom.quest</span>, <span class="mono">ComplexMultiTrigger</span>, <span class="mono">WikiTom</span> and <span class="mono">Jarvis</span>. A name outside the list is dropped rather than treated as an error. With no repositories the session gets an empty scratch directory; with one, that checkout is its working directory; with several, its working directory is the folder holding all of them.</p>

<h2>The branch, and the one thing a session may never do</h2>

<p>Every checkout is put on a branch named <span class="mono">session/</span> followed by the session's identifier, before the model is given control. That name is the session's entire write surface.</p>

<div class="flow">
  <div class="box"><strong>Allowed</strong> <span class="muted">— commit in the checkout, push that one branch, open a pull request for it, read anything.</span></div>
  <div class="arrow">↓</div>
  <div class="box"><strong>Denied</strong> <span class="muted">— push any other branch, push to the repository's main branch, merge a pull request, or write through the GitHub interface to anything other than a pull request for that one branch.</span></div>
</div>

<p>This is not only stated in the prompt. Every shell command the session tries to run is first classified against those rules by a separate model call on the Jarvis Box, and a denied command never executes. The classifier fails open — if it cannot be reached the command is allowed and the transcript records that it was — so it is a strong default rather than a proof. The structural boundaries underneath it are that the working directory is a throwaway folder, that the editing tools cannot reach outside it, and that the pens recording Tom's rulings are not given to the session at all.</p>

<p>When the session ends, only that one branch is pushed. Commits the model made on any other branch are reported as discarded, because there is no sanctioned way to keep them.</p>

<h2>What the session is given, and what it is not</h2>

<p>Exactly two values reach the session's shell: the address of the TTS server, and the worker key that lets it write through <span class="mono">/tts/prepare-todo</span>, the address at which a session records a todo prepared or done. The separate key the daemon itself uses to talk to TTS is never placed in a shell the model can reach, and is removed from anything the session prints.</p>

<h2>What happens next, and who does it</h2>

<p>Pressing the button writes the session row and its first prompt, opens a browser tab for the session view, and records one <span class="mono">session-created</span> entry. Within a second or so the daemon claims it, clones what it needs, and the transcript begins to appear in that tab.</p>

<p>What the session leaves behind is a branch and, if the work is finished, a pull request — and whatever it wrote back into the todo through the pen. Merging is Tom's, always.</p>
`,
);

export const MUST_NOT_BREAK_EXPLANATION = page(
  "Must not break — Tom's line on a goal",
  "Must not break: Tom's own line on what the work toward a goal must not break",
  "The field behind the line on a goal's row: who writes it, where it is read, and what it binds.",
  `
<h2>What this is</h2>

${WHAT_TTS_IS}

<p>A todo is either a task or a goal. A <span class="term">task</span> is work someone does. A <span class="term">goal</span> is a state of the world Tom wants, written as a condition that is either true yet or not. <span class="term">Must not break</span> is one field on a goal: one line, in Tom's own words, naming what the work toward that goal must not break — a constraint on everything done in the goal's name.</p>

<p>It is stored on the goal's row under the name <span class="mono">mustNotBreak</span>, and it exists only on goals: the one function that writes it, <span class="mono">updateTodo</span> in the file <span class="mono">convex/tts.ts</span>, refuses it on a task.</p>

<h2>Who writes it</h2>

<table>
  <tr><th>Writer</th><th>Allowed</th><th>Why</th></tr>
  <tr><td>Tom, through <span class="mono">updateTodo</span></td><td>Yes — the only writer.</td><td>The line is his intent about the world. An agent guessing it would be an agent inventing a constraint in his name.</td></tr>
  <tr><td>An agent</td><td>No. None of the writing pens an agent holds carries the field.</td><td>Same reason. An agent that finds the line wrong says so, and Tom changes it.</td></tr>
</table>

<h2>Where it is read</h2>

<table>
  <tr><th>Reader</th><th>What it does with the line</th></tr>
  <tr><td>The goal's row on the everything tab</td><td>Shows it in the row's open panel, exactly as written.</td></tr>
  <tr><td>A session Tom opens on the goal</td><td>Prints it among the item's facts in the opening prompt, marked as his own binding line.</td></tr>
</table>

<h2>What it binds</h2>

<div class="flow">
  <div class="box">Tom writes the line on a goal <span class="muted">— one sentence, his words</span></div>
  <div class="arrow">↓</div>
  <div class="box">A session opened on the goal reads it first <span class="muted">— a change that would break it is not made, whatever else the item says</span></div>
</div>

<h2>What happens next, and who does it</h2>

<p>Writing or changing the line writes one field and stops. Nothing is scheduled and no message is sent. The next session opened on the goal reads the new line from the row; a session already open keeps the prompt it was opened with.</p>
`,
);
