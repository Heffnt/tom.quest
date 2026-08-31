// GROUND-UP EXPLANATIONS FOR THE INFO CAPTIONS.
//
// Every caption in the TTS screens is the small circled i beside a control,
// which opens a popover (app/tts/components/info.tsx) on a tap. The popover
// carries two things: one or two sentences of display text, and — when the
// mechanism the caption names needs teaching rather than naming — a "more"
// control that opens one of the documents in this file fullscreen.
//
// EACH CONSTANT HERE IS ONE COMPLETE HTML DOCUMENT, "<!DOCTYPE html>" through
// "</html>". That form is fixed by the writing standard (WRITING_STANDARD in
// convex/ttsShared.ts) and is not a style choice: the documents are forwarded
// verbatim to other people and other agents, and they render inside a
// sandboxed iframe with no scripting and no network, so nothing may load from
// outside — no script, no inline event handler, no external stylesheet, font,
// image, or URL. Palette #0a0e17 background, #e2e8f0 text, #94a3b8 secondary,
// #e8a040 accent, #1e293b borders; about 15px body type; one h1 naming the
// subject and an h2 per section. scripts/check-writing-standard.mjs checks the
// mechanical half of those rules against stored explanations.
//
// WHAT A DOCUMENT MUST COVER, because it is read by someone with no context at
// all: what the thing is, why it exists, what every term in the caption means
// defined at first use, what the control actually changes, what else in the
// system reads that change, and what happens next and who does it.
//
// WHY THEY LIVE IN A PLAIN MODULE. They are static text with no data in them,
// so a module constant is the whole mechanism — no fetch, no table, nothing to
// keep in sync with the deployment. The cost is bundle size: each document is
// a handful of kilobytes shipped to the browser with the rest of the TTS
// screens. That is fine at the scale of a few; if this file grows past roughly
// a dozen documents, move them behind a route that fetches one on demand
// rather than shipping all of them to a reader who opens none.
//
// The first one written (2026-08-31) is the worked example the rest of the
// caption migration copies: the readiness dropdown in the edit panel of a todo
// row (app/tts/components/todo-row.tsx).

export const READINESS_EXPLANATION = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Readiness — the field this dropdown writes</title>
<style>
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
</style>
</head>
<body>
<div class="wrap">

<h1>Readiness: how far the preparing of this todo has got</h1>
<p class="sub">The field behind the dropdown beside this caption, and everything that reads it.</p>

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

<p>What follows depends on which value was chosen. At <span class="mono">unprepared</span> or <span class="mono">preparing</span>, the next run of the picker that starts sessions on its own — it runs every few minutes — may hand this todo to an agent, which writes its brief and returns it at <span class="mono">ready-for-tom</span>. At <span class="mono">ready-for-tom</span> the todo joins the items at a gate on the batches tab and its verdict controls appear, so the next move is Tom's ruling.</p>

</div>
</body>
</html>`;
