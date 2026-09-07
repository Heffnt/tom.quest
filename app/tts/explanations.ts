// GROUND-UP EXPLANATIONS FOR THE INFO CAPTIONS.
//
// Every caption in the TTS screens is the small circled i beside a control,
// which opens a popover (app/tts/components/info.tsx) on a tap. The popover
// carries two things: one or two sentences of display text, and — when the
// mechanism the caption names needs teaching rather than naming — a "more"
// control that opens one of the documents in this file fullscreen.
//
// EACH EXPORTED CONSTANT HERE IS ONE COMPLETE HTML DOCUMENT, "<!DOCTYPE html>"
// through "</html>". That form is fixed by the writing standard
// (WRITING_STANDARD in convex/ttsShared.ts) and is not a style choice: the
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
// ONE MECHANISM, ONE DOCUMENT — NOT ONE CAPTION, ONE DOCUMENT. Four captions in
// the repeats strip all name the same mechanism (a repeat rule and the 4:30
// a.m. job that mints from it), so all four open REPEATS_EXPLANATION. Six
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
// pages never explain themselves (CLAUDE.md). What is left is one document per
// mechanism a control sets in motion — status, the verdicts, sessions, time
// notes, blocks, repeats — each opened from the popover of the control that
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
  table { border-collapse: collapse; width: 100%; margin: 16px 0 20px; font-size: 13.5px; }
  th, td { border: 1px solid #1e293b; padding: 7px 10px; text-align: left; vertical-align: top; }
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
const WHAT_TTS_IS = `<p><span class="term">TTS</span> is Toms Todo System: the web application that holds Tom's todos, groups them into batches, and asks him for rulings. A <span class="term">todo</span> is one stored row in it — one thing to be done, held as a set of separate fields. TTS stores its data in <span class="term">Convex</span>, a hosted backend service; a <span class="term">mutation</span> is one named function there that changes stored data, and every control on these screens fires exactly one.</p>`;

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

<p>The status word <span class="mono">waiting</span> is the older shape and is still stored on rows that carry it. Such a row is parked until Tom presses Set active — no clock reaches it. The way to give a parked todo a moment to come back at is a <span class="term">time note</span>: one sentence about timing, read by a job every two minutes, which works out the concrete instant and writes it. What the todo is waiting <em>for</em> belongs in its own statement, where every reader already looks.</p>

<h2>What brings an archived todo back: nothing automatic</h2>

<p>The unarchive condition is stored on the row and displayed, and it is read by nothing. No job, no scheduled task, no query reads it and reactivates anything. The two jobs that group and plan todos are given the archive sentences of retired items for one reason only — so that they do not recreate a grouping already retired — and are told explicitly that such a sentence is not steering about what to plan.</p>

<p>So archiving is reversible only by hand: someone reads the condition, decides it has come true, and presses Set active, which clears the condition as part of reopening. The sentence is a message to whoever next looks, not an instruction to a machine.</p>

<h2>What happens next, and who does it</h2>

<p>Each of these controls writes the field, writes one entry of kind <span class="mono">status-changed</span> carrying the old and new values, and stops. Nothing else is scheduled and no message is sent.</p>

<p>After that: an active todo is a candidate for the picker that starts agent sessions every five minutes, and appears in today's column on the calendar when it is due, overdue, scheduled, ready or waking today; a waiting todo disappears from the active list until its wake time passes; an archived or done todo leaves the working views and stays readable. All four also stamp the row as touched by Tom, which freezes its grouping against the job that forms batches automatically.</p>
`,
);

export const VERDICTS_EXPLANATION = page(
  "The verdicts — approve, revise, session, archive",
  "The four verdicts, and what each one actually sets in motion",
  "The chips beside this caption record a ruling. What follows differs completely between them, and between a life todo and a code todo.",
  `
<h2>What this is</h2>

${WHAT_TTS_IS}

<p>A <span class="term">ruling</span> is Tom's decision about one todo, stored as its own row in a table named <span class="mono">dtsRulings</span>. Rulings are append-only: ruling on the same item again writes a new row, and the one that counts is the newest. Every chip beside this caption calls one mutation, <span class="mono">recordRuling</span> in the file <span class="mono">convex/ttsRulings.ts</span>, with a verdict and an optional sentence typed into the box next to the chips.</p>

<p>There are four verdicts and they are fixed: <span class="mono">approve</span>, <span class="mono">revise</span>, <span class="mono">session</span>, <span class="mono">archive</span>. There is deliberately no "defer" — an item put down is archived with the condition that should bring it back, so putting something down is a recorded decision rather than the absence of one.</p>

<h2>When these chips appear at all</h2>

<p>A todo shows the four verdict chips only when its status is <span class="mono">active</span> and its readiness is <span class="mono">prepared</span>. Readiness is the field saying whether the writing-up of the todo has happened, and <span class="mono">prepared</span> means an agent finished preparing it. A todo in that state is called a <span class="term">gate item</span>, and a gate item can be ruled from wherever it is seen, not only on the batches tab.</p>

<p>Two further chips sit beside the four and are not verdicts: <span class="mono">done</span>, which marks the todo finished, and <span class="mono">archive</span>, which sets it aside without recording a ruling. The plain archive chip appears only when the four verdict chips do not, so the two ways of archiving are never offered at once.</p>

<h2>The sentence</h2>

<p>One text box serves all six chips, and what the sentence means depends on the chip. Only <span class="mono">revise</span> requires it; the mutation refuses a revise with no sentence and says so. On <span class="mono">archive</span> the sentence <em>is</em> the condition under which the item should be proposed back. On the others it is a note kept with the ruling.</p>

<h2>What each verdict does to a life todo</h2>

<table>
  <tr><th>Verdict</th><th>What it writes</th><th>What acts on it afterwards</th></tr>
  <tr>
    <td class="mono">approve</td>
    <td>The ruling row, marked applied on the spot with the result "plan ratified". The todo itself is not changed.</td>
    <td>Nothing executes it. For todos about Tom's own life, Tom is the executor; approving records the decision and stops TTS asking. The sentence is read afterwards by the two jobs that group todos into batches and plan their order, as standing steering about how he wants such work arranged.</td>
  </tr>
  <tr>
    <td class="mono">revise</td>
    <td>The todo's readiness back to <span class="mono">unprepared</span>. The ruling row stays unapplied.</td>
    <td>A job on the Jarvis Box — Tom's always-on machine — runs every two minutes, finds unapplied revise rulings, re-prepares the brief with the sentence in its prompt, and then marks the ruling applied. The sentence is the whole instruction the agent receives about what to change, so it has to stand on its own.</td>
  </tr>
  <tr>
    <td class="mono">session</td>
    <td>The ruling row, unapplied. The todo itself is not changed.</td>
    <td>Nothing runs. The ruling stays open until Tom actually opens a session on the item, at which point it is marked applied with that session's identifier. Meanwhile it excludes the todo from the picker that starts sessions automatically.</td>
  </tr>
  <tr>
    <td class="mono">archive</td>
    <td>The todo's status to <span class="mono">archived</span>, its archive time, and the sentence as its unarchive condition. The ruling row is marked applied with the result "status archived".</td>
    <td>Nothing. No job reads unarchive conditions; bringing the item back is a manual Set active, which clears the condition.</td>
  </tr>
</table>

<p>Three of the four also stamp the todo as touched by Tom, which freezes its grouping against the job that forms batches automatically. <span class="mono">revise</span> is the exception, and deliberately: a revise hands the item back to an agent rather than settling it, so it must not freeze anything.</p>

<h2>Why an autonomous run cannot consume a session verdict</h2>

<p>The <span class="mono">session</span> verdict means "this needs a conversation, not a ruling". A ruling is consumed — marked applied — only when a session is created with the todo attached <em>and</em> that session is interactive, meaning Tom opened it. A session the automatic picker started on the same todo is explicitly excluded from consuming it.</p>

<p>Without that check the conversation Tom asked for would be silently cancelled by a machine that happened to pick the same item within five minutes. The picker separately refuses any todo whose newest ruling is a session verdict, applied or not, so the item waits for him.</p>

<h2>What approve means on a code todo</h2>

<p>A <span class="term">code todo</span> is a todo that lives in a code repository and is mirrored into TTS, addressed by repository name plus an identifier rather than by a TTS row. The same four chips appear on it, and approve behaves completely differently: the ruling stays unapplied until a session exists to carry it out, because the repository, not TTS, is where code work is recorded.</p>

<div class="flow">
  <div class="box">Tom presses approve on a code todo. <span class="muted">The ruling row is stored, unapplied.</span></div>
  <div class="arrow">↓ <span class="muted">within five minutes, when the Jarvis Box has headroom</span></div>
  <div class="box">The picker that starts agent sessions takes the single oldest unapplied approve (or archive) on a code todo and starts one autonomous session on a fresh checkout of that repository, on a branch named for the session. One code mission runs at a time; the ruling is marked applied with the session's id at that moment.</div>
  <div class="arrow">↓ <span class="muted">one autonomous session</span></div>
  <div class="box">It implements the plan (or, for archive, only closes the entry in the repository's todo file), runs that file's own guard test, pushes the branch and opens a pull request whose body begins with a change report.</div>
  <div class="arrow">↓</div>
  <div class="box">Merging the pull request is Tom's, and nothing automates it. A session that fails is not retried by the picker; ruling again is the retry.</div>
</div>

<p>The other three verdicts on a code todo have no job of their own. Revise is consumed by the planner on the Jarvis Box, which runs every half hour: it re-writes the brief with a fresh plan, with Tom's sentence in the prompt, and marks the ruling applied once the new brief is stored. Session is applied the moment Tom opens the code block session from the calendar — the interactive session whose turns are about code todos; its opening prompt names each code todo it consumed, with Tom's sentence. Archive is admitted by the same picker as approve, as a mission that closes the entry in the repository's own todo file and opens a pull request for it; merging that is Tom's.</p>

<h2>What happens next, and who does it</h2>

<p>Recording a ruling writes one row, writes one entry of kind <span class="mono">ruling</span> in the append-only event record, and — for approve and archive on a life todo — nothing further. For revise, the planner re-prepares the brief on its next half-hourly run and the item returns at <span class="mono">prepared</span> for another look. For session, the item waits until Tom opens the conversation. For approve on a code todo, the picker starts a session that ends in a pull request waiting for his merge.</p>
`,
);

export const SESSIONS_EXPLANATION = page(
  "Opening a session — what is created and where it runs",
  "Opening a session: what is created, where it runs, and what it may do",
  "The button beside this caption starts one run of Claude Code on Tom's own machine, with this item already in its opening prompt.",
  `
<h2>What this is</h2>

${WHAT_TTS_IS}

<p>A <span class="term">session</span> is one run of Claude Code — the command-line coding agent — started by TTS and carried out on the machine the code calls the <span class="term">Jarvis Box</span>, Tom's always-on machine. Pressing the button beside this caption calls the mutation <span class="mono">createSession</span> in the file <span class="mono">convex/claudeSessions.ts</span>, which stores a row describing the session and the text of its opening prompt. Nothing is launched by that mutation; it only writes.</p>

<p>A program on the Jarvis Box, the <span class="term">daemon</span>, polls TTS constantly — every second while something is happening, every thirty seconds when nothing is — and claims any session row it finds in the requested state. TTS treats the daemon as absent if it has not polled for ninety seconds. Everything the session then does is streamed back into TTS through that same connection, which is what the session view on the site is showing.</p>

<h2>The kinds of session</h2>

<p>The <span class="term">kind</span> is stored on the row and decides one paragraph of the opening prompt. There are five.</p>

<table>
  <tr><th>Kind</th><th>Started from</th><th>What its prompt says</th></tr>
  <tr><td class="mono">gate</td><td>A todo whose readiness is <span class="mono">prepared</span>.</td><td>That the item is ready and needs Tom's input integrated: walk him through it from the ground up, take his ruling, and shape the result with him.</td></tr>
  <tr><td class="mono">focus-item</td><td>Any other todo, and any batch.</td><td>That Tom chose to begin this item now: open with the smallest concrete first step and work it with him.</td></tr>
  <tr><td class="mono">block</td><td>A placed span of calendar time that targets a category rather than one todo.</td><td>That Tom committed this span to the category, followed by a list of every active todo carrying that category, one line each with its timing, date, entry action and work description.</td></tr>
  <tr><td class="mono">weekly</td><td>The session list page only.</td><td>Nothing extra — the prompt is whatever was typed.</td></tr>
  <tr><td class="mono">adhoc</td><td>The session list page, and every automatic exploration run.</td><td>Nothing extra, or the exploration prompt.</td></tr>
</table>

<p>The button beside a todo picks between the first two by that todo's readiness alone. There is one exception to the block prompt: for the category <span class="mono">code</span> no list is printed, because the work there is the mirror of code todos and their prepared briefs rather than a list in a prompt.</p>

<h2>Which repositories it gets, and how</h2>

<p>A session works in a fresh copy of whatever code it needs. Which repositories those are is decided by three rules, consulted in order, the first that answers winning — and an answer of "none at all" is an answer that stops the search.</p>

<table>
  <tr><th>Order</th><th>Rule</th></tr>
  <tr><td>1</td><td>Whatever the caller passed explicitly. The todo buttons deliberately pass nothing, so that the rules below decide.</td></tr>
  <tr><td>2</td><td>The repositories the item's batch declared when it was formed.</td></tr>
  <tr><td>3</td><td>A scan of the todo's own text — statement, brief, explanation — for the name of a known repository, returning every match.</td></tr>
</table>

<p>The known repositories are a fixed list of three: <span class="mono">tom.quest</span>, <span class="mono">ComplexMultiTrigger</span> and <span class="mono">WikiTom</span>. A name outside the list is dropped rather than treated as an error. With no repositories the session gets an empty scratch directory; with one, that checkout is its working directory; with several, its working directory is the folder holding all of them.</p>

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

<h2>Interactive versus automatic, and why it matters here</h2>

<p>The same row shape is used for sessions Tom opens and for sessions a picker starts by itself every five minutes. Two differences are visible from this button. First, a session Tom opens consumes a standing <span class="mono">session</span> verdict on the item — the ruling that says "this needs a conversation" — and an automatic run on the same item deliberately does not, so the conversation he asked for still happens. Second, automatic runs carry a cap of two hundred turns and ninety minutes of wall-clock time per turn; an interactive session has neither.</p>

<h2>What happens next, and who does it</h2>

<p>Pressing the button writes the session row and its first prompt, opens a browser tab for the session view, and records an entry of kind <span class="mono">session-created</span>. Within a second or so the daemon claims it, clones what it needs, and the transcript begins to appear in that tab.</p>

<p>What the session leaves behind is a branch and, if the work is finished, a pull request — and whatever it wrote back into the todo through the pen. Merging is Tom's, always.</p>
`,
);

export const TIME_NOTES_EXPLANATION = page(
  "Time notes — one sentence about when, and the job that carries it out",
  "Time notes: one sentence about when, and the job that carries it out",
  "There is no date picker in TTS. The sentence is the instruction, and a job every two minutes turns it into a date, a wait, or a span of calendar time.",
  `
<h2>What this is</h2>

${WHAT_TTS_IS}

<p>A <span class="term">time note</span> is one sentence Tom writes about when something happens, stored against exactly one context. The field beside this caption creates one. It is deliberately the only way timing is expressed on these screens: there is no date picker anywhere in TTS, because a picker forces a decision to be exact before it has been made, and a sentence such as "sometime next week, after the meeting" can be written down as it actually stands.</p>

<p>The note does nothing by itself. It is stored, and a separate job reads it, works out what it meant against its context, carries that out, and writes back one sentence saying what it did.</p>

<h2>The three contexts, and why exactly one</h2>

<table>
  <tr><th>Context</th><th>Where the field appears</th><th>What the note is about</th></tr>
  <tr><td>A todo</td><td>In a todo row's expanded panel.</td><td>That todo's date, its waiting state, or a span of time placed for it.</td></tr>
  <tr><td>A block</td><td>Inside a placed span of calendar time.</td><td>Moving or removing that span.</td></tr>
  <tr><td>A day</td><td>Behind the small plus on a day column of the week grid.</td><td>That calendar day in general.</td></tr>
</table>

<p>The mutation refuses a note with none of the three, and a note with more than one, in both cases by name. A note with two contexts would have two readings and the job would have to guess between them; refusing at the door is what makes every stored note unambiguous. A day is stored as the text "YYYY-MM-DD" — the label of the column — and never as a moment, because a day is a calendar day and reading it as an instant would shift it across a time zone.</p>

<h2>The three states a note can be in</h2>

<table>
  <tr><th>State</th><th>What it means</th><th>Shown as</th></tr>
  <tr><td class="mono">pending</td><td>Written, not yet read by the job.</td><td>A dashed outline with a clock mark.</td></tr>
  <tr><td class="mono">applied</td><td>Carried out. The stored result is one plain sentence saying what was done.</td><td>A tick line, for 24 hours after it resolved, after which it stops being listed. The row itself is kept forever.</td></tr>
  <tr><td class="mono">needs-session</td><td>Read but not carried out: ambiguous, outside what the job may do, or refused by the server. The stored result is the one-line reason.</td><td>An accented outline, listed until it is dealt with.</td></tr>
</table>

<h2>The job that reads them</h2>

<p>A job on the Jarvis Box — Tom's always-on machine — runs every two minutes, takes at most ten pending notes, and gives each one to Claude with its context attached and a three-minute limit. The model's answer is not free text: it must be a list of actions drawn from a closed vocabulary, and anything else comes back as a note needing a conversation.</p>

<table>
  <tr><th>Action</th><th>What it changes</th><th>The rule the server enforces</th></tr>
  <tr><td>set a due date</td><td>The todo's date, its date kind and its timing class.</td><td>Only if the todo has no date yet. Moving an existing date is a renegotiation, not a new date.</td></tr>
  <tr><td>renegotiate a date</td><td>Records the old date as renegotiated and sets a new one.</td><td>Only before the old date has arrived.</td></tr>
  <tr><td>record a date missed</td><td>Records the old date as missed, with or without a replacement.</td><td>Only after the date has passed. A date still ahead is renegotiated, never missed.</td></tr>
  <tr><td>set the date kind</td><td>Whether the date came from outside or Tom set it himself.</td><td>Only on a todo that has a date.</td></tr>
  <tr><td>set waiting, or set active</td><td>The todo's status, with a wake time when parking it.</td><td>A wake time not given is merged from what the todo already holds.</td></tr>
  <tr><td>create, move or delete a block</td><td>A placed span of calendar time.</td><td>A span must end after it starts, and must target either one todo or one category.</td></tr>
</table>

<p>Every one of those rules lives on the server, not in the prompt. If the model proposes something the server refuses, the whole set of actions for that note is rolled back together and the note is re-filed as needing a conversation, with the server's own message as the reason. A network failure is different: the note stays pending and the next run tries the whole thing again.</p>

<h2>Deleting a note</h2>

<p>The small cross beside a note deletes it. Only a pending or needs-session note can be deleted; the mutation refuses an applied one by name, because an applied note has already become a real date or a real span of time, and deleting the sentence would not undo that. What it would do is remove the record of why the change happened.</p>

<p>To undo something an applied note did, change the thing itself — the date, the status, the block — or write another time note saying so.</p>

<h2>What happens next, and who does it</h2>

<p>Writing a note stores it as pending and records one entry in the append-only event record. Within about two minutes the job reads it. Either the note becomes a tick line here saying what was done to the todo, the block or the day, or it becomes an accented line saying why it could not be read — and that second case is a question for Tom, not a failure to be retried.</p>
`,
);

export const BLOCKS_EXPLANATION = page(
  "Blocks — a placed span of time, and what deleting one does",
  "Blocks: a placed span of time, and what deleting one does",
  "A block is a stroke on the week grid saying when a todo, or a whole category of todos, is meant to happen.",
  `
<h2>What this is</h2>

${WHAT_TTS_IS}

<p>A <span class="term">block</span> is one stored row saying that a span of time is set aside for something. It holds a start moment, an end moment, exactly one target, an optional note, and the moment it was created. It is drawn on the week grid on the calendar tab, and the control beside this caption deletes the one it sits in.</p>

<p>A block is not a todo. It carries no status, no readiness, no ruling, and it is not itself something to be done — it is a statement about when. Blocks are described in the code as calendar strokes, and moving or deleting one is expected rather than exceptional.</p>

<h2>The one target, and the two kinds it can be</h2>

<table>
  <tr><th>Target</th><th>What the block means</th></tr>
  <tr><td>A todo</td><td>This span is for that one todo.</td></tr>
  <tr><td>A category</td><td>This span is for every active todo carrying that free-text tag — "Saturday morning, chores". The tag is the same <span class="mono">category</span> field a todo carries.</td></tr>
</table>

<p>Exactly one of the two must be set, and the server refuses a block with both or with neither, by name. The category is trimmed before that check, so a category of nothing but spaces cannot produce a block that targets nothing.</p>

<h2>Where blocks come from</h2>

<p>Only two writers exist, and neither is a calendar.</p>

<div class="flow">
  <div class="box"><strong>Tom, through a time note.</strong> <span class="muted">There is no picker for placing a block. A time note — one sentence about when, read by a job every two minutes — can create, move or delete one. That is the ordinary path, and it is why the calendar tab has a delete control but no create control.</span></div>
  <div class="arrow">↓</div>
  <div class="box"><strong>The mutations behind those screens.</strong> <span class="muted">Create, update and delete, each requiring Tom's own login. The time-note job calls the same three underneath.</span></div>
</div>

<p>The calendar feeds go the other way entirely. TTS mirrors external calendars into a separate table, hourly, replacing each feed's contents wholesale; those events are read-only and are never blocks. TTS has exactly one door that writes to an external calendar, and nothing in the code connects a block to it. A block exists inside TTS and nowhere else.</p>

<h2>What a block causes</h2>

<p>The picker that starts agent sessions by itself, every five minutes, looks ahead 48 hours for blocks. A block targeting one todo makes that todo the work of the session; a block targeting a category makes the session take the todo in that category that has gone longest without being touched. The category <span class="mono">code</span> is excluded from that, having its own pipeline.</p>

<p>A block also appears in the message composed each hour describing what Tom is scheduled to be doing, alongside the mirrored calendar events. That message is composed but not sent: outbound messaging to Slack, the chat service, is switched off in TTS at present.</p>

<h2>What deleting one does</h2>

<p>Exactly two things: the block row is removed, and one entry of kind <span class="mono">block-deleted</span> is written into the append-only event record, carrying the span and the target. The todo the block was for is not touched — not its status, not its date, not its readiness. Nothing is written to any external calendar, because nothing was ever written there.</p>

<p>The block is gone rather than archived. That is deliberate, and it is the one place in TTS where a row is genuinely removed: a block is schedule mechanics rather than a record of intent, and the intent it served is still on the todo.</p>

<h2>What happens next, and who does it</h2>

<p>The stroke disappears from the week grid immediately. The todo it was for goes back to having no time set aside for it, which means the session picker will no longer reach for it through a block, and the hourly schedule message will no longer mention it. Placing time for it again is another time note.</p>
`,
);

export const REPEATS_EXPLANATION = page(
  "Repeat rules — what mints a todo at 4:30 in the morning",
  "Repeat rules: what mints a todo at 4:30 in the morning, and what pausing one does",
  "A rule is not a todo. It is a standing instruction that creates a real dated todo on each of the weekdays it names.",
  `
<h2>What this is</h2>

${WHAT_TTS_IS}

<p>A <span class="term">repeat rule</span> is a stored row saying "make this todo on these weekdays". The strip beside this caption is the whole interface for rules: the list, a form that creates one, and per rule a pause control and a delete control. Rules live in their own table and are managed from the calendar tab because what they produce lands on the calendar.</p>

<p>The word for what a rule does is <span class="term">minting</span>: once a day, a job reads the rules and inserts an ordinary todo for each rule whose weekday has come. A minted todo is in no way special afterwards — it can be edited, ruled on, archived and completed like any other, and it keeps no live link to the rule that made it.</p>

<h2>What a rule holds</h2>

<table>
  <tr><th>Field</th><th>Meaning</th><th>Required</th></tr>
  <tr><td class="mono">statement</td><td>The sentence, copied verbatim onto every instance.</td><td>Yes.</td></tr>
  <tr><td class="mono">daysOfWeek</td><td>One or more weekday names.</td><td>Yes, at least one.</td></tr>
  <tr><td class="mono">timeOfDay</td><td>New York wall-clock time as "HH:MM" on a 24-hour clock, which becomes the instance's due time.</td><td>No. Absent means noon.</td></tr>
  <tr><td class="mono">category</td><td>The free-text tag copied onto the instance, so that a placed span of calendar time can cover it.</td><td>No.</td></tr>
  <tr><td class="mono">skipWhenCalendarHas</td><td>Text that suppresses minting on a day whose calendar says so — see below.</td><td>No.</td></tr>
  <tr><td class="mono">entryAction</td><td>The smallest first step, copied onto the instance.</td><td>No.</td></tr>
  <tr><td class="mono">active</td><td>Whether the rule mints. False means paused; the rule stays visible and listed.</td><td>Set to true at creation.</td></tr>
</table>

<h2>The job that mints</h2>

<p>One job, once a day, at 4:30 in the morning New York time. It runs at that hour year-round: the scheduler underneath understands only universal time, so the job is registered at both possible universal times and its own check of the local hour lets exactly one of the two proceed. Daylight saving therefore needs no change to anything.</p>

<p>4:30 is half an hour before the 5 a.m. digest reads the record. That ordering is the reason for the time: a repeat that minted after the digest was composed would not be in the morning it belongs to.</p>

<p>For each active rule whose weekday matches, the job inserts one todo with these values, all fixed:</p>

<table>
  <tr><th>Field</th><th>Value</th></tr>
  <tr><td class="mono">statement</td><td>The rule's statement.</td></tr>
  <tr><td class="mono">status</td><td class="mono">active</td></tr>
  <tr><td class="mono">readiness</td><td class="mono">prepared</td></tr>
  <tr><td class="mono">timingClass</td><td class="mono">dated</td></tr>
  <tr><td class="mono">dueAt</td><td>That day at the rule's time, or noon.</td></tr>
  <tr><td class="mono">dateKind</td><td class="mono">self-imposed</td></tr>
  <tr><td class="mono">kind</td><td class="mono">task</td></tr>
  <tr><td class="mono">actor</td><td class="mono">tom</td></tr>
  <tr><td class="mono">source</td><td class="mono">repeating</td></tr>
</table>

<p>The two rows worth pausing on are readiness and actor. A minted instance arrives already at <span class="mono">prepared</span> and marked as Tom's own work, which means no agent is sent to prepare it: it is a thing he already knows how to do, and the picker that hands todos to agents leaves it alone.</p>

<h2>Why a rule cannot mint twice for the same day</h2>

<p>Every minted todo carries a provenance string built from the rule's identifier and the calendar day — for instance <span class="mono">repeat:abc123:2026-08-31</span>. Before minting, the job reads every todo whose source is <span class="mono">repeating</span> and skips any rule whose string for that day is already present. So a job that runs twice, or is run by hand for a past day, produces nothing extra. There is no "last minted" field on the rule; the instances themselves are the record.</p>

<h2>The calendar skip</h2>

<p>If a rule carries skip text, the job first reads every mirrored calendar event overlapping that New York calendar day and looks for one whose title contains that text, ignoring capitalisation. If it finds one, no todo is minted; instead an entry of kind <span class="mono">repeat-skipped</span> is written into the append-only event record, naming the event that caused the skip.</p>

<p>Those events come from the read-only mirror of Tom's external calendars, refreshed hourly. The match is a plain substring of the title, so "travel" matches "Travel to Boston" and matches nothing that mentions travel only in its description.</p>

<h2>Pausing and deleting</h2>

<div class="flow">
  <div class="box"><strong>Pause</strong> <span class="muted">sets the rule's active flag to false and changes nothing else. The job simply stops selecting it. Every todo already minted stays exactly as it is. Resuming sets the flag back, and the rule mints again from the next 4:30 run.</span></div>
  <div class="arrow">↓</div>
  <div class="box"><strong>Delete</strong> <span class="muted">removes the rule row outright, writing the whole rule into the event record first so that what was deleted is still readable. Every todo it already minted stays, keeping its source and its provenance string, which now names a rule that no longer exists.</span></div>
</div>

<p>Deleting a rule is a genuine removal, which is unusual in TTS — todos are archived rather than deleted, and archived rows stay visible. A rule is treated differently because it is schedule mechanics rather than a record of intent, and the intent it expressed is in the instances it already made.</p>

<h2>What happens next, and who does it</h2>

<p>Creating a rule stores it and records one entry in the event record. Nothing is minted for today: minting happens at the next 4:30 run, so the first instance appears tomorrow morning. Pausing, resuming and deleting take effect at that same next run.</p>

<p>Once an instance exists it is an ordinary todo. It shows on the week grid as a due mark like any other dated item, and it is Tom's to do, to rule on, or to archive.</p>
`,
);

export const MUST_NOT_BREAK_EXPLANATION = page(
  "Must not break — Tom's line on a goal",
  "Must not break: Tom's own line on what the work toward a goal must not break",
  "The field behind the line under a goal on the batch card: who writes it, where it is read, and what it binds.",
  `
<h2>What this is</h2>

${WHAT_TTS_IS}

<p>A <span class="term">batch</span> is a stored row holding how a set of todos gets completed. Its contents are todos of two kinds: a <span class="term">task</span> is work someone does, and a <span class="term">goal</span> is a state of the world the batch is for, written as a condition that is either true yet or not. <span class="term">Must not break</span> is one field on a goal: one line, in Tom's own words, naming what the work toward that goal must not break — a constraint on every task planned or done in the goal's name.</p>

<p>It is stored on the goal's row under the name <span class="mono">mustNotBreak</span>, and it exists only on goals: the one function that writes it, <span class="mono">updateTodo</span> in the file <span class="mono">convex/tts.ts</span>, refuses it on a task.</p>

<h2>Who writes it</h2>

<table>
  <tr><th>Writer</th><th>Allowed</th><th>Why</th></tr>
  <tr><td>Tom, through <span class="mono">updateTodo</span></td><td>Yes — the only writer.</td><td>The line is his intent about the world. An agent guessing it would be an agent inventing a constraint in his name.</td></tr>
  <tr><td>The planner (the job that maintains the graph inside each batch)</td><td>No. It reads the line and never writes or rewrites it.</td><td>The planner proposes structure; it does not state what matters.</td></tr>
  <tr><td>A worker session (an agent doing one task)</td><td>No. Its writing pen does not carry the field.</td><td>Same reason. A worker that finds the line wrong says so in its outcome summary, and Tom changes it.</td></tr>
</table>

<h2>Where it is read</h2>

<table>
  <tr><th>Reader</th><th>What it does with the line</th></tr>
  <tr><td>The batch card and the goal's detail dialog</td><td>Show it under the goal, exactly as written.</td></tr>
  <tr><td>The planner's prompt</td><td>Carries it beside the goal's statement. A task that would break the line is not a task to write, and a task's explanation must say how the line is kept.</td></tr>
  <tr><td>A worker session's opening prompt</td><td>Lists every must-not-break line of the batch's goals before the task, as binding on that task.</td></tr>
  <tr><td>A batch session or item session Tom opens</td><td>Prints it beside the goal, marked as his own binding line.</td></tr>
</table>

<h2>What it binds</h2>

<div class="flow">
  <div class="box">Tom writes the line on a goal <span class="muted">— one sentence, his words</span></div>
  <div class="arrow">↓</div>
  <div class="box">Every task the planner writes toward that goal is planned under it <span class="muted">— the prompt says a task that would break it is not written</span></div>
  <div class="arrow">↓</div>
  <div class="box">Every worker that takes one of those tasks reads it first <span class="muted">— a change that would break it is not made, whatever the task says</span></div>
</div>

<h2>What happens next, and who does it</h2>

<p>Writing or changing the line writes one field and stops. Nothing is scheduled and no message is sent. The next planner run and the next worker session on the batch read the new line from the row; a session already open keeps the prompt it was opened with.</p>
`,
);
