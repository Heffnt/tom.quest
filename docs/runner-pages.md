# The runner pages

A runner is a chain of short step agents on the Jarvis Box that watches one experiment. Each step starts from the runner's handoff document, checks in, rewrites the document and ends; the next step is due one step length later. A runner's session records its check-ins and sends its own notification for a question.

## The everything tab

The everything tab at tom.quest/tts, the tab the page opens on, lists the box's runners at its top, above the todos awaiting Tom's ruling. Each live runner is one row, newest first. The row shows the runner's title, the host its experiment runs on (Turing or the box), whether it is a campaign or a probe, its step length, when it last checked in with the first line of that check-in, when its next step is due, and its status in words: running, waiting on Tom, done, failed or handed off. A runner with a blocking question Tom has not answered carries the words "waiting on Tom" in a bordered marker, not just a colour.

A runner's title is a link to its newest step agent on tom.quest/agents. That opens the agent view the agents page already has. The view names the runner the step belongs to, and its "continues" link opens the step before it, so the whole chain of steps can be walked back from there. The agent view is otherwise unchanged; the runner's status there reads in the same words as on the everything tab, so a runner held by a question reads "waiting on Tom".

The arrow at the start of a row expands it in place, showing three things:

- A "document" button that shows the runner's handoff document as its last step wrote it, rendered as formatted text and read-only, with its version number.
- The questions the runner asked. Each shows its tier in words ("a question inside its plan", "a question about what the experiment is", "a question about what the experiment costs or where it runs"), whether it holds the runner's steps until it is answered, and whether it has been answered, with Tom's answer when it has.
- Its check-ins, newest first. Each shows its time, its decision in words (for example "it changed nothing" or "it asked a question"), a note when it did not pass the writing check, a link to the step agent that wrote it, and the check-in's text.

Runners that have ended sit under a fold headed "ended runners" with their count.

The page's only action is Tom's: "New runner" opens a dialog with a title, the type, the host, the repo, the step length in minutes, the ceiling and the objective, and creates the runner through the createRunner mutation that already existed. The ceiling is the most one launch of the runner may ask for on the cluster, and this form is the only place it is set when a runner is created; a runner a session opens holds the default: a number of GPUs, a number of minutes and an amount of memory, by default 2 GPUs, 240 minutes and 128000 MB. Tom raises it later by replying in the runner's thread with a message that starts with the word "ceiling", such as "ceiling 16 GPUs, 24 hours"; a session he is in asks him to reply that way rather than setting it itself. No ruling reaches above 16 GPUs, 1440 minutes (the day-long limit of the cluster's default partition) and 1536000 MB (its largest machine). Nothing on the page ends a runner, answers a question or edits a document. A runner still ends only through its own step's decision, and a question triggers that session's own notification.
