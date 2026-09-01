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
// WHY THEY LIVE IN A PLAIN MODULE. They are static text with no data in them,
// so a module constant is the whole mechanism — no fetch, no table, nothing to
// keep in sync with the deployment. The cost is bundle size: every document is
// shipped to the browser with the TTS screens whether or not a reader opens
// one. The shared PAGE_STYLE below is why that cost is roughly the prose alone
// rather than the prose plus ten copies of the same stylesheet. Measured
// 2026-08-31: ten documents, 83 kB of text before compression, the largest
// 10 kB. That is acceptable; past roughly a dozen, move them behind a route
// that fetches one on demand.
//
// The first one written (2026-08-31) was READINESS_EXPLANATION, the worked
// example the rest of the migration copied; the other nine landed in the same
// week, completing the migration of every caption in app/tts.

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

const WHAT_A_SESSION_IS = `<p>An <span class="term">agent session</span> is one run of Claude Code started by TTS on the machine the code calls the <span class="term">Jarvis Box</span> — Tom's own always-on machine. A session reads a todo, does work, and writes results back through the <span class="term">worker pen</span>: an address on the TTS server, <span class="mono">/tts/prepare-todo</span>, defined in <span class="mono">convex/http.ts</span>, which accepts a todo's identifier and the fields to change.</p>`;

export const READINESS_EXPLANATION = page(
  "Readiness — the field this dropdown writes",
  "Readiness: how far the preparing of this todo has got",
  "The field behind the dropdown beside this caption, and everything that reads it.",
  `
<h2>What this is</h2>

<p><span class="term">TTS</span> is Toms Todo System: the web application that holds Tom's todos, groups them into batches, and asks him for rulings. A <span class="term">todo</span> is one stored row in it — one thing to be done, held with a set of separate fields. <span class="term">Readiness</span> is one of those fields. It holds exactly one of three words, and it says how far the <em>preparing</em> of the todo has got — nothing else. Preparing means writing, for that todo, the short explanation of what it is (the <span class="term">brief</span>), the smallest next action, a description of the work, and a plan.</p>

<p>The dropdown beside this caption writes that field directly. Picking a value calls <span class="mono">updateTodo</span>, a function in the file <span class="mono">convex/tts.ts</span>, passing the todo's identifier and the new readiness word. <span class="term">Convex</span> is the backend service TTS stores its data in, and a <span class="term">mutation</span> is one named function there that changes stored data. Nothing else about the todo changes: not its text, not whether it is active, not any ruling already recorded on it.</p>

<p>Two other terms are used throughout below. An <span class="term">agent session</span> is one automated run of Claude on Tom's own machine, started by TTS, that reads a todo and writes results back into it. The <span class="term">worker pen</span> is the one way such a session writes: an address on the TTS server, <span class="mono">/tts/prepare-todo</span>, defined in the file <span class="mono">convex/http.ts</span>, which accepts a todo's identifier and the fields to change.</p>

<h2>The three values</h2>

<table>
  <tr><th>Value</th><th>What it says</th><th>Who normally sets it</th></tr>
  <tr>
    <td class="mono">unprepared</td>
    <td>Nothing has been written about this todo beyond the sentence that was typed into it.</td>
    <td>TTS itself, on every todo it creates. After that, only this dropdown.</td>
  </tr>
  <tr>
    <td class="mono">preparing</td>
    <td>An agent session has the todo and is writing its brief, its entry action, its work description and its plan.</td>
    <td>The agent session working on it, through the worker pen. Also the <span class="mono">revise</span> verdict.</td>
  </tr>
  <tr>
    <td class="mono">ready-for-tom</td>
    <td>The preparing is finished and what is left genuinely needs Tom — a ruling, a merge, a real-world action.</td>
    <td>The agent session, when it stops at a question. Also repeat rules, which mint their instances already at this value.</td>
  </tr>
</table>

<h2>Readiness is not status, and the two move independently</h2>

<p>Every todo carries a second field, <span class="term">status</span>, and the two are read for different questions. Readiness answers "has anyone written this todo up yet?". Status answers "is this todo in play?" and holds one of <span class="mono">active</span>, <span class="mono">waiting</span>, <span class="mono">archived</span>, <span class="mono">done</span>. Neither field constrains the other: a todo can be fully written up and parked at the same time, and a finished todo keeps whatever readiness it happened to have when it was marked done.</p>

<table>
  <tr><th>Field</th><th>Values</th><th>Question it answers</th><th>Changed on this screen by</th></tr>
  <tr><td class="mono">readiness</td><td class="mono">unprepared · preparing · ready-for-tom</td><td>How far the writing-up has got.</td><td>This dropdown.</td></tr>
  <tr><td class="mono">status</td><td class="mono">active · waiting · archived · done</td><td>Whether the todo is in play right now.</td><td>The Set waiting, Set active, done and archive controls.</td></tr>
</table>

<h2>Readiness is also not the other meaning of "ready" in TTS</h2>

<p>The word collides, and the two meanings are unrelated. In the batch graph — the structure recording which todos cannot start before which others — a todo is called <span class="term">ready</span> when its status is <span class="mono">active</span> and every todo listed in its <span class="mono">needs</span> is already done or archived. That sense is computed on the spot by the function <span class="mono">isReady</span> in the file <span class="mono">convex/ttsShared.ts</span> and is never stored anywhere.</p>

<p>So this dropdown cannot make a todo ready in the graph sense, and a todo that is ready in the graph sense may still sit at <span class="mono">unprepared</span> here. Where this page says readiness without qualification it means the stored field, which is the one the dropdown writes.</p>

<h2>What the stored value actually causes</h2>

<table>
  <tr><th>What reads it</th><th>What it does with the value</th></tr>
  <tr>
    <td>The verdict controls on this row</td>
    <td>The approve, revise, session and archive controls appear only when status is <span class="mono">active</span> and readiness is <span class="mono">ready-for-tom</span>. Setting any other value here makes them disappear.</td>
  </tr>
  <tr>
    <td>The Open session button on this row</td>
    <td>At <span class="mono">ready-for-tom</span> it opens a session of kind <span class="mono">gate</span>, prompted to get Tom's decision made. At the other two values it opens kind <span class="mono">focus-item</span>, prompted to do the work.</td>
  </tr>
  <tr>
    <td>The picker that starts sessions on its own</td>
    <td>It treats <span class="mono">unprepared</span> and <span class="mono">preparing</span> as todos still owed an agent's work, and hands them out. A todo at <span class="mono">ready-for-tom</span> is left alone, because the next move is Tom's.</td>
  </tr>
  <tr>
    <td>The <span class="mono">revise</span> verdict</td>
    <td>It is the one verdict that writes this field: it sets readiness back to <span class="mono">preparing</span> and hands the todo to an agent again, leaving the todo's own text untouched.</td>
  </tr>
  <tr>
    <td>The daily digest</td>
    <td>It counts active todos at <span class="mono">ready-for-tom</span> that no batch has claimed, and reports them as the items waiting on Tom. It is composed but not delivered: outbound messaging to Slack, the chat service, is switched off in TTS at present.</td>
  </tr>
</table>

<h2>The one step this dropdown can take that nothing else can</h2>

<div class="flow">
  <div class="box"><span class="mono">unprepared</span> <span class="muted">— the todo is created, holding only its sentence</span></div>
  <div class="arrow">↓ <span class="muted">the picker hands it to an agent session</span></div>
  <div class="box"><span class="mono">preparing</span> <span class="muted">— the session writes the brief, the entry action, the work description, the plan</span></div>
  <div class="arrow">↓ <span class="muted">the session stops at what needs Tom</span></div>
  <div class="box"><span class="mono">ready-for-tom</span> <span class="muted">— the verdict controls appear; the item is at a gate</span></div>
  <div class="arrow">↓ <span class="muted">the revise verdict, when the write-up is not good enough</span></div>
  <div class="box"><span class="mono">preparing</span> <span class="muted">— back to an agent, and around again</span></div>
</div>

<p>The worker pen accepts only <span class="mono">preparing</span> and <span class="mono">ready-for-tom</span>, and rejects <span class="mono">unprepared</span> outright. That is deliberate: an agent must never be able to erase the record that a todo was already written up. So the step back to <span class="mono">unprepared</span> exists only on this dropdown, and what it means is "throw away what was written and start the preparing again from the sentence".</p>

<h2>What happens next, and who does it</h2>

<p>Choosing a value here writes the field and stops. Nothing is scheduled, no session is started, and no message is sent by the change itself.</p>

<p>What follows depends on which value was chosen. At <span class="mono">unprepared</span> or <span class="mono">preparing</span>, the next run of the picker that starts sessions on its own — it runs every five minutes — may hand this todo to an agent, which writes its brief and returns it at <span class="mono">ready-for-tom</span>. At <span class="mono">ready-for-tom</span> the todo joins the items at a gate on the batches tab and its verdict controls appear, so the next move is Tom's ruling.</p>
`,
);

export const CREATE_TODO_EXPLANATION = page(
  "Adding a todo — what the Add button stores",
  "Adding a todo: the fields the Add button writes, and what picks it up",
  "The capture box at the top of the TTS screens, and everything that happens after it.",
  `
<h2>What this is</h2>

${WHAT_TTS_IS}

<p>The box beside this caption is the capture box: a text field for the sentence, a second smaller field for a category, and an Add button. Pressing Add calls the mutation <span class="mono">createTodo</span> in the file <span class="mono">convex/tts.ts</span>, passing the trimmed sentence and, if the second field is not empty, the trimmed category. Nothing else on the screen is read.</p>

<p>The point of the box is that capture is one action. There is no form to fill in, no date picker, no priority, no estimate. Everything that would go on such a form is written afterwards, either by Tom in the edit panel of the todo's own row, or by an agent session, described at the end of this page.</p>

<h2>Exactly what is stored</h2>

<p>The mutation accepts more arguments than this box sends. Below is every field written on a row created from this box, with the value it gets. A field not listed is left unset, which is not the same as empty: an unset field is absent from the row entirely, and every reader treats it as "nothing was said".</p>

<table>
  <tr><th>Field</th><th>Value from this box</th><th>What it is</th></tr>
  <tr><td class="mono">statement</td><td>The typed sentence, trimmed</td><td>The display text shown wherever the todo appears.</td></tr>
  <tr><td class="mono">category</td><td>The second field, trimmed; unset when empty</td><td>A free-text tag. It groups todos so that one placed span of calendar time can cover a set of them.</td></tr>
  <tr><td class="mono">readiness</td><td class="mono">unprepared</td><td>How far the writing-up of the todo has got. Fixed here — this box cannot create a todo at any other value.</td></tr>
  <tr><td class="mono">status</td><td class="mono">active</td><td>Whether the todo is in play. The other three values are <span class="mono">waiting</span>, <span class="mono">archived</span> and <span class="mono">done</span>.</td></tr>
  <tr><td class="mono">timingClass</td><td class="mono">whenever</td><td>How the todo is timed. It would be <span class="mono">dated</span> if a due date had been passed, but this box passes none, so it is always <span class="mono">whenever</span> here. The third value is <span class="mono">condition-bound</span>.</td></tr>
  <tr><td class="mono">source</td><td class="mono">manual</td><td>Where the todo came from. Other rows carry <span class="mono">slack-capture</span>, <span class="mono">repeating</span>, <span class="mono">prospecting</span> or <span class="mono">session</span>.</td></tr>
  <tr><td class="mono">createdAt</td><td>The moment of the press</td><td>Milliseconds since 1970. Never changes again.</td></tr>
  <tr><td class="mono">updatedAt</td><td>The same moment</td><td>Bumped by every later edit. Several jobs order work by it, oldest first.</td></tr>
</table>

<p>Not written, and worth naming because their absence is what makes a fresh todo a fresh todo: no <span class="mono">brief</span>, no <span class="mono">entryAction</span>, no <span class="mono">workDescription</span>, no <span class="mono">plan</span>, no <span class="mono">dueAt</span>, no <span class="mono">batchId</span> — so the todo belongs to no batch — and no <span class="mono">tomTouchedAt</span>, the stamp marking a row as edited by Tom and therefore frozen against the job that forms batches.</p>

<h2>The one side effect</h2>

<p>Creating a todo writes exactly one other row: an entry in <span class="mono">dtsEvents</span>, the append-only record of everything that has happened, of kind <span class="mono">created</span>. No message is sent, no session is started, nothing is scheduled. The screen updates because Convex pushes the new row to every open view, not because anything was triggered.</p>

<h2>What picks it up, and under what conditions</h2>

<p>A job called the <span class="term">autonomous picker</span> runs every five minutes inside Convex. It looks for todos that still owe an agent's work and starts a session on one or two of them. A todo created here is a candidate, but the picker refuses to run at all unless several conditions hold at once, so it is honest to say a fresh todo is picked up within minutes only when they do.</p>

<table>
  <tr><th>Condition</th><th>What it means</th></tr>
  <tr><td>Autonomous scheduling is switched on</td><td>A stored configuration row. If there is no row, the picker is off.</td></tr>
  <tr><td>The program on the Jarvis Box has reported in within 90 seconds</td><td>The Jarvis Box is Tom's always-on machine, and the program on it that actually runs sessions polls TTS constantly; silence means no session could start.</td></tr>
  <tr><td>The machine is not loaded</td><td>Load per processor under a configured limit, and free memory above one.</td></tr>
  <tr><td>Fewer than the configured number of sessions are already live</td><td>The default cap is eight, with at most two started per five-minute tick.</td></tr>
  <tr><td>No recent session hit a usage limit</td><td>A session that ended reporting a usage limit stands the whole picker down for three hours.</td></tr>
  <tr><td>The category is not <span class="mono">code</span></td><td>That category is reserved for the mirror of code work, which has its own pipeline.</td></tr>
</table>

<p>When the picker does take a todo that belongs to no batch, it takes the one that has gone longest without an update in whichever lane the todo falls into: dated todos by soonest date, condition-bound todos by tightest deadline, and everything else — including a todo created here — in the lane that takes the oldest untouched row.</p>

<h2>What the session writes back</h2>

${WHAT_A_SESSION_IS}

<p>What a preparing session writes into the todo is exactly the set of fields the capture box left unset: the <span class="term">brief</span> (a short written explanation of what the todo is), the <span class="term">entry action</span> (the smallest concrete first step), the <span class="term">work description</span> (what the work involves, in words, never as a number of hours), and a <span class="term">plan</span> (a list of steps, each marked as Tom's or an agent's). It then sets readiness to <span class="mono">ready-for-tom</span>.</p>

<p>The pen refuses to set readiness back to <span class="mono">unprepared</span>. An agent may move a todo forward through the preparing states and no further back, so the record that a todo was written up cannot be erased by the thing that wrote it.</p>

<h2>What happens next, and who does it</h2>

<p>The todo is stored and visible immediately, on the batches tab under the unbatched heading and in the by-individual list. If the conditions above hold, an agent session writes its brief within minutes and returns it at <span class="mono">ready-for-tom</span>, at which point its four verdict controls — approve, revise, session, archive — appear and the next move is Tom's ruling. If they do not hold, the todo sits at <span class="mono">unprepared</span> until they do, or until Tom opens it himself.</p>
`,
);

export const TODO_FIELDS_EXPLANATION = page(
  "The todo text fields — what editing one writes",
  "The five text fields of a todo, and what editing one sets in motion",
  "Statement, entry action, body, work description and category: what each is for, and the two consequences an edit carries beyond the text itself.",
  `
<h2>What this is</h2>

${WHAT_TTS_IS}

<p>The panel beside this caption is the edit panel of one todo row. It holds five text fields, each with its own save control. Saving any of them calls one mutation, <span class="mono">updateTodo</span> in the file <span class="mono">convex/tts.ts</span>, with the todo's identifier and just the field that changed. Fields not sent are left exactly as they were.</p>

<p>These five are the todo's prose. They are not its state: whether the todo is active or archived, which batch it belongs to, which other todos it waits on, and what evidence closed it are all separate fields this panel cannot write. Status in particular has its own controls, because changing it carries side effects a plain field write must not have.</p>

<h2>The five fields</h2>

<table>
  <tr><th>Field</th><th>What it holds</th><th>Who else writes it, and what reads it</th></tr>
  <tr>
    <td class="mono">statement</td>
    <td>The one line naming the todo. It is the display text wherever the todo appears.</td>
    <td>Written at creation and by agent sessions. Read by every screen, by the opening prompt of any session on the todo, and by the scan that guesses which code repositories a session should check out — that scan looks for a repository name inside this text.</td>
  </tr>
  <tr>
    <td class="mono">entryAction</td>
    <td>The smallest concrete next step, as a sentence. Not a plan, one step.</td>
    <td>Normally written by an agent session through the worker pen — the address on the TTS server through which a session writes back. It is printed in the opening prompt of a session covering a whole category of todos, so an unclear entry action becomes an unclear instruction.</td>
  </tr>
  <tr>
    <td class="mono">body</td>
    <td>Free text about the todo itself: detail that does not fit the one-line statement.</td>
    <td>Written here and at creation. Shown in the row, and read by the repository-guessing scan alongside the statement.</td>
  </tr>
  <tr>
    <td class="mono">workDescription</td>
    <td>What the work involves, in words. Deliberately never a number of hours or a point estimate.</td>
    <td>Normally written by an agent session. Printed in category session prompts beside the entry action.</td>
  </tr>
  <tr>
    <td class="mono">category</td>
    <td>A free-text tag grouping todos, such as <span class="mono">chores</span>.</td>
    <td>Written here and at creation. It is the link between a todo and a placed span of calendar time: such a span can target a category instead of a single todo, and then covers every todo carrying that tag.</td>
  </tr>
</table>

<h2>Category is the one field with a reserved value</h2>

<p>The category <span class="mono">code</span> is reserved for the mirror of code work — todos that live in a code repository and are executed by a separate pipeline. Setting a todo's category to that word removes it from the autonomous picker entirely: the picker, which runs every five minutes and starts agent sessions by itself, excludes every row whose category is <span class="mono">code</span> before any other test. Any other category string is ordinary and carries no such meaning.</p>

<p>Category is also the only one of the five that can be emptied. Clearing it removes the field from the row. The other four can be overwritten but not removed, because the mutation accepts a cleared value only for the fields whose absence is meaningful.</p>

<h2>The two consequences an edit carries beyond the text</h2>

<p>Both of these are why this document exists: saving a field does two things that are not visible in the panel.</p>

<div class="flow">
  <div class="box"><strong>It stamps the row as touched by Tom.</strong> <span class="muted">Every call to the mutation writes the current time into a field named <span class="mono">tomTouchedAt</span>. A job runs periodically to form batches and rewrite them as the corpus changes, and that job never rewrites or retires a row carrying this stamp. So editing any of the five fields freezes the todo's grouping against automatic revision, permanently.</span></div>
  <div class="arrow">↓</div>
  <div class="box"><strong>It bumps the row's update time, which can reopen a settled question.</strong> <span class="muted">The list of items waiting on Tom includes any active, ready-for-tom todo whose newest ruling was recorded <em>before</em> its last update. Editing a field after ruling on the todo therefore makes it appear in that list again, because the rule reads as "a ruled item is answered until the preparer touches it again" and an edit is a touch.</span></div>
</div>

<h2>What this panel cannot write</h2>

<p>The mutation refuses, or simply does not accept, the following. Each is somewhere else on purpose.</p>

<table>
  <tr><th>Field</th><th>Where it is changed instead</th></tr>
  <tr><td class="mono">status</td><td>The done, archive, Set waiting and Set active controls, which fire a different mutation with its own side effects.</td></tr>
  <tr><td class="mono">dueAt</td><td>A date can be set here, but an existing one can never be cleared: the mutation refuses and says so. A date that will not be met is recorded as renegotiated before it arrives, or as missed after it, so that every date ends in a recorded outcome rather than vanishing.</td></tr>
  <tr><td class="mono">kind, batchId, needs</td><td>The jobs that form batches and plan their order. They are the structure of the batch graph, which the planner owns; a todo's own panel does not edit it.</td></tr>
  <tr><td class="mono">evidence</td><td>Written by the worker pen when a session records the todo done — the branch, the pull request or the artifact that shows it.</td></tr>
  <tr><td class="mono">groundUpExplanation</td><td>Written by the worker pen. It is the fullscreen document behind a todo's own "more" control.</td></tr>
</table>

<h2>What happens next, and who does it</h2>

<p>Saving writes the field and stops. No session is started, nothing is scheduled, no message is sent. The change is visible immediately in every open view because Convex pushes it.</p>

<p>The two consequences above take effect from that moment: the batch-forming job will leave this todo's grouping alone from now on, and if the todo had already been ruled on and is still active and ready-for-tom, it reappears among the items waiting on Tom.</p>
`,
);

export const STATUS_EXPLANATION = page(
  "Status — the four states a todo can be in",
  "Status: active, waiting, archived, done — and what changing it clears",
  "The controls beside this caption write one field, and each value carries a different set of side effects.",
  `
<h2>What this is</h2>

${WHAT_TTS_IS}

<p><span class="term">Status</span> is the field saying whether a todo is in play. It holds exactly one of four words. The controls beside this caption — Set waiting, Set active, done, archive — all call the same mutation, <span class="mono">setStatus</span> in the file <span class="mono">convex/tts.ts</span>, with a different target value and, for two of them, one extra sentence.</p>

<p>Status is not <span class="term">readiness</span>, the other short word on a todo. Readiness holds <span class="mono">unprepared</span>, <span class="mono">preparing</span> or <span class="mono">ready-for-tom</span> and says how far the writing-up of the todo has got. The two are independent: a fully written-up todo can be parked, and a parked todo can be unwritten.</p>

<h2>The four values</h2>

<table>
  <tr><th>Value</th><th>What it says</th><th>The extra sentence it takes</th></tr>
  <tr><td class="mono">active</td><td>In play now. This is what every new todo starts as.</td><td>None.</td></tr>
  <tr><td class="mono">waiting</td><td>Parked until a moment or a condition. It leaves the active list.</td><td>A wake condition in Tom's words, and optionally a concrete wake time.</td></tr>
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
    <td>The completion time, the archive time, the unarchive condition, the wake condition and the wake time — all five. Reopening an item must not leave the reasons it was closed or parked lying on it.</td>
  </tr>
  <tr>
    <td class="mono">waiting</td>
    <td>The wake condition and wake time exactly as given.</td>
    <td>Any previous wake condition or wake time not given again. Both fields are assigned unconditionally, so parking a todo a second time without a sentence erases the first one.</td>
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

<p>One job, once a day. At 4:45 in the morning, New York time, a job in Convex prepares the coming day. Before anything else it reads every waiting todo and reactivates each one whose stored <span class="term">wake time</span> falls before the end of the day being prepared, clearing the wake time and the wake condition as it goes and recording an entry of kind <span class="mono">woke</span> in the append-only event record.</p>

<p>The consequence worth knowing: a todo parked with a condition in words but no concrete wake time is never woken by that job. It waits until Tom sets it active, or until a <span class="term">time note</span> — one sentence about timing, read by a separate job every two minutes — works out a concrete time and writes it. A wake condition alone is a note to a reader; a wake time is the thing a job can act on.</p>

<h2>What brings an archived todo back: nothing automatic</h2>

<p>The unarchive condition is stored on the row and displayed, and it is read by nothing. No job, no scheduled task, no query reads it and reactivates anything. The two jobs that group and plan todos are given the archive sentences of retired items for one reason only — so that they do not recreate a grouping already retired — and are told explicitly that such a sentence is not steering about what to plan.</p>

<p>So archiving is reversible only by hand: someone reads the condition, decides it has come true, and presses Set active, which clears the condition as part of reopening. The sentence is a message to whoever next looks, not an instruction to a machine.</p>

<h2>What happens next, and who does it</h2>

<p>Each of these controls writes the field, writes one entry of kind <span class="mono">status-changed</span> carrying the old and new values, and stops. Nothing else is scheduled and no message is sent.</p>

<p>After that: an active todo is a candidate for the picker that starts agent sessions every five minutes, and appears in the day's queue; a waiting todo disappears from the active list until its wake time passes; an archived or done todo leaves the working views and stays readable. All four also stamp the row as touched by Tom, which freezes its grouping against the job that forms batches automatically.</p>
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

<p>A todo shows the four verdict chips only when its status is <span class="mono">active</span> and its readiness is <span class="mono">ready-for-tom</span>. Readiness is the field saying how far the writing-up of the todo has got, and <span class="mono">ready-for-tom</span> means an agent finished preparing it and what is left needs Tom. A todo in that state is called a <span class="term">gate item</span>, and a gate item can be ruled from wherever it is seen, not only on the batches tab.</p>

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
    <td>The todo's readiness back to <span class="mono">preparing</span>. The ruling row stays unapplied.</td>
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

<p>A <span class="term">code todo</span> is a todo that lives in a code repository and is mirrored into TTS, addressed by repository name plus an identifier rather than by a TTS row. The same four chips appear on it, and approve behaves completely differently: the ruling stays unapplied, because the repository, not TTS, is where code work is recorded.</p>

<div class="flow">
  <div class="box">Tom presses approve on a code todo. <span class="muted">The ruling row is stored, unapplied.</span></div>
  <div class="arrow">↓ <span class="muted">at 45 minutes past each hour</span></div>
  <div class="box">A job on the Jarvis Box takes the single oldest unapplied approve, clones the repository fresh, and makes a branch named for the todo.</div>
  <div class="arrow">↓ <span class="muted">one headless Claude run, capped at 45 minutes</span></div>
  <div class="box">It pushes that branch and opens a pull request, then reports the pull request address back as the ruling's result.</div>
  <div class="arrow">↓</div>
  <div class="box">Merging the pull request is Tom's, and nothing automates it. A failure marks the ruling with the reason; ruling approve again is the retry.</div>
</div>

<p>The other three verdicts on a code todo are handled by a different job every ten minutes: revise queues a re-plan, session writes a handoff note into the repository, and archive closes the entry in the repository's own todo file.</p>

<h2>What happens next, and who does it</h2>

<p>Recording a ruling writes one row, writes one entry of kind <span class="mono">ruling</span> in the append-only event record, and — for approve and archive on a life todo — nothing further. For revise, an agent session re-prepares the brief within a couple of minutes and the item returns at <span class="mono">ready-for-tom</span> for another look. For session, the item waits until Tom opens the conversation. For approve on a code todo, a pull request appears within the hour and waits for his merge.</p>
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
  <tr><td class="mono">gate</td><td>A todo whose readiness is <span class="mono">ready-for-tom</span>.</td><td>That the item is ready and needs Tom's input integrated: walk him through it from the ground up, take his ruling, and shape the result with him.</td></tr>
  <tr><td class="mono">focus-item</td><td>Any other todo, and any batch.</td><td>That Tom chose to begin this item now: open with the smallest concrete first step and work it with him.</td></tr>
  <tr><td class="mono">block</td><td>A placed span of calendar time that targets a category rather than one todo.</td><td>That Tom committed this span to the category, followed by a list of every active todo carrying that category, one line each with its timing, date, entry action and work description.</td></tr>
  <tr><td class="mono">weekly</td><td>The session list page only.</td><td>Nothing extra — the prompt is whatever was typed.</td></tr>
  <tr><td class="mono">adhoc</td><td>The session list page, and every automatic exploration run.</td><td>Nothing extra, or the exploration prompt.</td></tr>
</table>

<p>The button beside a todo picks between the first two by that todo's readiness alone. There is one exception to the block prompt: for the category <span class="mono">code</span> no list is printed, because the work there is the mirror of code todos and their prepared briefs rather than a list in a prompt.</p>

<h2>Which repositories it gets, and how</h2>

<p>A session works in a fresh copy of whatever code it needs. Which repositories those are is decided by four rules, consulted in order, the first that answers winning — and an answer of "none at all" is an answer that stops the search.</p>

<table>
  <tr><th>Order</th><th>Rule</th></tr>
  <tr><td>1</td><td>Whatever the caller passed explicitly. The todo buttons deliberately pass nothing, so that the rules below decide.</td></tr>
  <tr><td>2</td><td>The repositories the item's batch declared when it was formed.</td></tr>
  <tr><td>3</td><td>A vote among the batch's members: each member naming a repository is one mark, and the most frequent wins.</td></tr>
  <tr><td>4</td><td>A scan of the todo's own text — statement, brief, explanation — for the name of a known repository, returning every match.</td></tr>
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
  <tr><td>set or clear the latest safe time</td><td>The conservative last moment a condition-bound todo can still be started.</td><td>Only on a note written on a todo.</td></tr>
  <tr><td>set waiting, or set active</td><td>The todo's status, with a wake time and wake condition when parking it.</td><td>Fields not given are merged from what the todo already holds.</td></tr>
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

<p>4:30 is fifteen minutes before the job that builds the day's queue of what to look at. That ordering is the reason for the time: a repeat that minted after the queue was built would not be in the day it belongs to.</p>

<p>For each active rule whose weekday matches, the job inserts one todo with these values, all fixed:</p>

<table>
  <tr><th>Field</th><th>Value</th></tr>
  <tr><td class="mono">statement</td><td>The rule's statement.</td></tr>
  <tr><td class="mono">status</td><td class="mono">active</td></tr>
  <tr><td class="mono">readiness</td><td class="mono">ready-for-tom</td></tr>
  <tr><td class="mono">timingClass</td><td class="mono">dated</td></tr>
  <tr><td class="mono">dueAt</td><td>That day at the rule's time, or noon.</td></tr>
  <tr><td class="mono">dateKind</td><td class="mono">self-imposed</td></tr>
  <tr><td class="mono">kind</td><td class="mono">task</td></tr>
  <tr><td class="mono">actor</td><td class="mono">tom</td></tr>
  <tr><td class="mono">source</td><td class="mono">repeating</td></tr>
</table>

<p>The two rows worth pausing on are readiness and actor. A minted instance arrives already at <span class="mono">ready-for-tom</span> and marked as Tom's own work, which means no agent is sent to prepare it: it is a thing he already knows how to do, and the picker that hands todos to agents leaves it alone.</p>

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

export const LINK_INTENT_EXPLANATION = page(
  "The intent bar — a link that proposes an action",
  "The intent bar: a link proposes an action, and one press carries it out",
  "The highlighted strip appears because the address of this page asked for it. Nothing has happened yet.",
  `
<h2>What this is</h2>

${WHAT_TTS_IS}

<p>The strip beside this caption is the <span class="term">intent bar</span>. It appears when the web address that opened this page carries three pieces of information: which tab to show, which todo to scroll to, and one word saying what is proposed for it. TTS reads those once when the page loads, jumps to the todo, highlights it, and shows this bar. It changes nothing.</p>

<p>The button in the bar is what changes something, and it fires exactly one mutation depending on the proposed word.</p>

<table>
  <tr><th>Word in the address</th><th>What the button does</th></tr>
  <tr><td class="mono">done</td><td>Sets the todo's status to <span class="mono">done</span>, recording the completion time and resolving any open due date as kept.</td></tr>
  <tr><td class="mono">archive</td><td>Sets the todo's status to <span class="mono">archived</span>, recording the archive time.</td></tr>
  <tr><td>anything else</td><td>Records one entry of kind <span class="mono">engaged</span> in the append-only event record, and nothing more.</td></tr>
</table>

<p>The Dismiss control beside it removes the bar without doing any of that.</p>

<h2>Why the link cannot act by itself</h2>

<p>This is the whole reason the bar exists rather than the link simply working. A web address that is merely fetched must never change stored data, because fetching is not a decision. Anything that follows a link — a preview generator in a chat application, a mail client checking whether an address is safe, a browser guessing what a reader will click next — would otherwise mark a todo done without anyone having read it.</p>

<p>So the address carries a proposal and the page carries the confirmation. The one press is what makes it a decision, and the press comes from Tom.</p>

<h2>Where such links come from</h2>

<p>TTS composes messages that would carry these links: a daily summary of what is waiting, and an hourly line about what is happening. Neither is delivered at present. Outbound messaging to Slack, the chat service Tom uses, is switched off in the code by two separate switches, both currently false, and the daily summary's schedule is not even registered. Slack is read-only to TTS today: it captures notes written into one channel and sends nothing back.</p>

<p>The intent bar therefore appears now only when such an address is opened by hand — a link kept from earlier, or one constructed deliberately. It is built and working ahead of the decision about when TTS may message Tom at all, which is a separate open question.</p>

<h2>What the recorded event is for</h2>

<p>The third row of the table above records an engagement and does nothing else. Those entries accumulate in the same append-only record as every status change, every ruling and every session, and the layer that would analyse them has not been built. The hourly message that does exist filters the record down to a handful of kinds worth stating — something captured, a session opened or finished, a ruling made, a batch formed — and deliberately drops engagements, on the grounds that reporting everything would bury the few facts that matter in an hour.</p>

<h2>What happens next, and who does it</h2>

<p>Pressing the button writes the one change in its row and stops. Nothing is scheduled and no message is sent. A todo marked done or archived leaves the working views and stays readable; a recorded engagement is visible only in the event feed.</p>
`,
);
