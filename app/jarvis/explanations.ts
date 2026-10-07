// GROUND-UP EXPLANATIONS FOR THE INFO CAPTIONS.
//
// Every caption using the shared small circled i beside a control
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
// ONE MECHANISM, ONE DOCUMENT — NOT ONE CAPTION, ONE DOCUMENT. The ruling
// dialog's verdict controls all open VERDICTS_EXPLANATION. Splitting those
// would produce documents that each teach a fragment and none of which is
// self-contained, which is the thing the standard forbids. The display text
// is what differs per caption; the ground-up layer is per mechanism.
//
// A DOCUMENT HERE EXPLAINS A MECHANISM SOMETHING FIRES — NEVER THE PAGE (the
// lifeos update, phase 7). Three of the ten went in that change: readiness,
// the todo's text fields, and the intent bar each taught a reader how to read
// a screen, which is explainer text with a "more" control in front of it, and
// pages never explain themselves (app/AGENTS.md). What is left is one document
// for the verdict mechanism, opened from the popover of the control that fires
// it.
//
// WHY THEY LIVE IN A PLAIN MODULE. They are static text with no data in them,
// so a module constant is the whole mechanism — no fetch, no table, nothing to
// keep in sync with the deployment. The cost is bundle size: every document is
// shipped to the browser wherever the ruling dialog is available. The shared
// PAGE_STYLE below keeps that cost to the prose plus one stylesheet.

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

export const VERDICTS_EXPLANATION = page(
  "The verdicts — approve, revise, session, archive",
  "The four verdicts, and what each one actually sets in motion",
  "The chips beside this caption record a ruling on a life todo. What follows differs completely between verdicts.",
  `
<h2>What this is</h2>

${WHAT_TTS_IS}

<p>A <span class="term">ruling</span> is Tom's decision about one todo, stored as its own row in a table named <span class="mono">rulings</span>. Rulings are append-only: ruling on the same item again writes a new row, and the one that counts is the newest. Every chip beside this caption calls one mutation, <span class="mono">recordRuling</span> in the file <span class="mono">convex/ttsRulings.ts</span>, with a verdict and an optional sentence typed into the box next to the chips.</p>

<p>There are four verdicts and they are fixed: <span class="mono">approve</span>, <span class="mono">revise</span>, <span class="mono">session</span>, <span class="mono">archive</span>. There is deliberately no "defer" — an item put down is archived with the condition that should bring it back, so putting something down is a recorded decision rather than the absence of one.</p>

<h2>When these chips appear at all</h2>

<p>The ruling dialog appears where an agent's work presents a decision for Tom. It names the subject and records one of the four verdicts; it does not edit the todo itself directly.</p>

<h2>The sentence</h2>

<p>One text box serves the four verdicts, and what the sentence means depends on the verdict. Only <span class="mono">revise</span> requires it; the mutation refuses a revise with no sentence and says so. On <span class="mono">archive</span> the sentence <em>is</em> the condition under which the subject should be proposed back. On the others it is a note kept with the ruling.</p>

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

<h2>What happens next, and who does it</h2>

<p>Recording a ruling writes one row and one <span class="mono">ruling</span> entry in the append-only event record. For approve and archive, nothing further runs. For revise, the planner re-prepares the brief on its next half-hourly run and the item returns at <span class="mono">prepared</span> for another look. For session, the item waits until Tom opens the conversation.</p>
`,
);
