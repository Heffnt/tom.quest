# The runner pages

A runner is a chain of short step agents on the Jarvis Box that watches one experiment. Each step starts from the runner's handoff document, checks in, rewrites the document and ends; the next step is due one step length later. Until this change a runner reached Tom only through its check-ins in Slack and its questions in #tts-needs-you. This change puts runners on the TTS page, in the morning message and in the hourly update.

## The everything tab

The everything tab at tom.quest/tts, the tab the page opens on, lists the box's runners at its top, above the todos awaiting Tom's ruling. Each live runner is one row, newest first. The row shows the runner's title, the host its experiment runs on (Turing or the box), whether it is a campaign or a probe, its step length, when it last checked in with the first line of that check-in, when its next step is due, and its status in words: running, waiting on Tom, done, failed or handed off. A runner with a blocking question Tom has not answered carries the words "waiting on Tom" in a bordered marker, not just a colour.

A runner's title is a link to its newest step agent on tom.quest/agents. That opens the agent view the agents page already has. The view names the runner the step belongs to, and its "continues" link opens the step before it, so the whole chain of steps can be walked back from there. The agent view is otherwise unchanged; the runner's status there reads in the same words as on the everything tab, so a runner held by a question reads "waiting on Tom".

The arrow at the start of a row expands it in place, showing three things:

- A "document" button that shows the runner's handoff document as its last step wrote it, rendered as formatted text and read-only, with its version number.
- The questions the runner asked. Each shows its tier in words ("a question inside its plan", "a question about what the experiment is", "a question about what the experiment costs or where it runs"), whether it holds the runner's steps until it is answered, and whether it has been answered, with Tom's answer when it has.
- Its check-ins, newest first. Each shows its time, its decision in words (for example "it changed nothing" or "it asked a question"), a note when it did not pass the writing check, a link to the step agent that wrote it, and the check-in's text.

Runners that have ended sit under a fold headed "ended runners" with their count.

The page's only action is Tom's: "New runner" opens a dialog with a title, the type, the host, the repo, the step length in minutes, the ceiling and the objective, and creates the runner through the createRunner mutation that already existed. The ceiling is the most one launch of the runner may ask for on the cluster, and this form is the only place it is set when a runner is created; a runner a session opens holds the default: a number of GPUs, a number of minutes and an amount of memory, by default 2 GPUs, 240 minutes and 128000 MB. Tom raises it later by replying in the runner's thread with a message that starts with the word "ceiling", such as "ceiling 16 GPUs, 24 hours"; a session he is in asks him to reply that way rather than setting it itself. No ruling reaches above 16 GPUs, 1440 minutes (the day-long limit of the cluster's default partition) and 1536000 MB (its largest machine). Nothing on the page ends a runner, answers a question or edits a document. A runner still ends only through its own step's decision, and a question is still answered in its #tts-needs-you thread.

## The morning message

The morning message in #tts-today now carries a runners section after the objection list and before the calendar. The objection list stays second. The section opens with a line counting the live runners and how many wait on Tom, then gives one line per live runner, with the ones waiting on him first. Each line says what the runner is doing, whether a question of its is open, and the first line of its last check-in, and links to the everything tab. For example: "TRAIN25 campaign is waiting on your answer; its last check-in reads: 14 of 20 jobs are running and 212 of 400 results are done." A runner that has never checked in is said to have not checked in yet, with no number. On a morning with no live runner the section is absent.

The morning message is normally written by a Fable agent from a facts block, and a verifier refuses any line whose links and numbers are not in a fact the line cites. Each live runner is now one fact in that block. So a runner line in a Fable-written message is checked like every other line, and a line naming a runner without citing its fact is refused.

The first line of the morning message is unchanged. It still says nothing about a runner waiting on Tom.

## The hourly update

When the hourly update in #tts-hourly posts, it now names the live runners after what ran. With one runner it names the runner and links it to the everything tab: "The runner TRAIN25 campaign is waiting on your answer, and 1 item was captured." With several it counts them and how many wait on Tom.

A live runner never makes an hour post on its own. An hour whose only fact is a live runner still posts nothing and still records its window as quiet. This is a decision taken, and Tom can object to it. A runner's steps run every few minutes for as long as it lives, so counting a live runner as activity would make every hour post and would end the rule that a quiet hour is silent. The runner still reaches Tom through its own check-ins, and through this line in any hour that has something else to say.
