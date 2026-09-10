# Evidence for ground.md

Never loaded. One entry per line of `../ground.md`, under the same heading. Session sources are `<project-dir>/<session-prefix>` under `~/.claude/projects/`; laptop memory files are in `sources/laptop-memory-2026-09-05/` unless marked newer. "laptop design session on unified agent context" is Tom's answers of 2026-09-09 to the ground questionnaire, given in chat on the laptop. Three of his answers that day are rules on the writer, not facts about his knowledge, and moved on 2026-09-09: the name-and-effect rule and the "explain as if I am new" rule to writing.md (entries in evidence/writing.md); the rule that a term enters this file only after he confirms it in his own words to AGENTS.md §Two records, in his words: "agents should not assume that i have learned something just because they have explained it to me once. they should wait for my explicit confirmation before assuming I understand something enough for it to be recorded in my ground."

## Knows

- line: Transformers and language models, how they learn and their components, at the level of his research.
  said: 2026-09-09 · Tom, laptop design session on unified agent context · "my top focus and what im doing research on is on transformers/llms and I feel like I have a deep intuitive and technical understanding of how they learn and their components."
  said: 2026-07-18 · WikiTom/`80fad333` · "I am deeply familiar with how LLMs work"
  said: 2026-08-18 · CMT/`ba5da329` · "dont dumb down the ml jargon because im familiar with it as an ai phd student"
- line: Mechanistic interpretability concepts, the residual stream, heads, attention, attribution patching, probing and causal tracing, at that same level.
  said: 2026-09-09 · Tom, laptop design session on unified agent context · "these are at the top level of understanding with calculus, linear algebra and probability." (asked about residual stream, heads, attention; attribution patching, probing, causal tracing)
- line: The math ML papers use: linear algebra, probability, calculus, optimization.
  said: 2026-09-09 · Tom, laptop design session on unified agent context · "yes on this and for the rest it is more vague. information theory is better than fourier/spectral stuff." (asked about linear algebra, probability, calculus, optimization at the level ML papers use them)
- line: His own research vocabulary: boolean backdoors, trigger logic, functions and forms, arity, truth-table rows, activating combinations, negation, plantedness, ASR, FTR, PTR, COR, TBR, AUROC, dormancy, Class A and Class B detectors, poisoning methods, judges, sweeps, headline versus control.
  said: 2026-07-25 · CMT/`b03f89cf` · "I understand arity and function structure, but tell me more about sampling geometry"
  said: 2026-08-08 · CMT/`e4a751be` · "What is the difference between a negated and non-monotone variable? is there one?" (the boundary: negation is known, the distinction was not)
  paraphrase: 2026-08-29 · writing.md as ruled in the calibration · the research-vocabulary list (boolean backdoors, trigger logic/functions/forms, arity, truth-table rows, activating combos, negation, plantedness, ASR, FTR, PTR, COR, TBR, AUROC, dormancy, Class A/B detectors, poisoning methods, judges, sweeps, headline vs control) was ruled fluent.
- line: The thesis and claims of his own paper.
  said: 2026-07-23 · WikiTom/`81be510a` · "i know what the thesis is"
- line: CMT's vocabulary, including the terms agents defined for him there.
  said: 2026-08-08 · CMT/`542cf5c1` · "That is not a term I recognize, and I am intimately familiar with CMT."
  said: 2026-09-09 · CMT/`2662d1a9` · "I understand the vocab you defined so use that and other standard cmt language."
- line: Designing agentic systems that work, from his experience building code with agents.
  said: 2026-09-09 · Tom, laptop design session on unified agent context · "I have also had a lot of experience with building code with agents so i have a strong intuition on how to design agentic systems that work well."
- line: His own coinages once ratified: tom-gate, ruling, batch, brief, readiness, VQC, canonical homes, the TTS vocabulary.
  paraphrase: 2026-08-29 · writing.md as ruled in the calibration · the coinages list (tom-gate, ruling, batch, brief, readiness, VQC, canonical homes, TTS vocabulary) was ruled fluent.
- line: WikiTom as he designed it.
  paraphrase: undated · `tom-text/notes/Toms Notes.md`, `tom-text/notes/Vision Notes.md` · his own writing of WikiTom's vision, atoms, rules, spec, lint, cli, fresh agents and auto loops.
- line: Climbing vocabulary, fluently.
  said: 2026-09-09 · Tom, laptop design session on unified agent context · "im an expert in climbing vocab."

## Follows, without the details

- line: Statistics: p-values, confidence intervals, bootstrap, contingency tables, mediation, CDE, statistical power; he follows the ideas, not the math.
  said: 2026-09-09 · Tom, laptop design session on unified agent context · "i understand these intuitively but im not fluent in the math." (asked about p-values, confidence intervals, bootstrap; contingency tables)
  said: 2026-07-12 · CMT/`6bf82060` · "what is a cross-tab / contingency table"
  said: undated · writing.md as ruled · "I'm mostly familiar with the LLM/backdoor stuff, so most of this is new to me" (on mediation, CDE, Baron–Kenny, frequentist/bayesian machinery, statistical power)
  read: 2026-07-04 · CMT/`c6706f04` · "why can't we compute the CDE on jailbreak? I don't understand…" — he used CDE unprompted while asking why it could not be computed on jailbreak.
- line: General software concepts: API routes, database tables, auth, build steps, test suites; he follows an account written for a specialist and may lack the details.
  said: 2026-09-09 · Tom, laptop design session on unified agent context · "I have a strong intuitive understanding of these. similar to the statistics, if you talk to me like an expert i can probably intuitively follow what you're saying but might not know all the details." (asked about API route, database table, auth, build step, test suite)
  said: 2026-09-04 · writing.md as ruled · "what is an execution layer?" (after an agent used the term undefined)
- line: Information theory, better than Fourier and spectral analysis.
  said: 2026-09-09 · Tom, laptop design session on unified agent context · "for the rest it is more vague. information theory is better than fourier/spectral stuff."
- line: The tom.quest web stack, Convex, pnpm, React components, TypeScript: the outline, through agents, without the technical details.
  said: 2026-09-09 · Tom, laptop design session on unified agent context · "im familiar with some web things that ive worked with in tom.quest but its all through agents and i mostly just get the broad strokes of how things like convex, pnpm, react components, typescript, etc. work with all the technical details glazed over."
- line: How backdoors work and, at a high level, the ways they are trained; the literature's vocabulary for backdoors and their detection may differ from his, and new methods keep arriving, which is why he keeps the lit review.
  said: 2026-09-09 · Tom, laptop design session on unified agent context · "I understand a lot about how backdoors work and at a high level different ways to train them. however there are a lot of concepts and vocab that the literature uses that i may not be familar with or where i use a term differently. also there are always new papers and new ways of doing things that I dont keep up with so thats why I keep the lit review."
  said: 2026-07-18 · WikiTom/`80fad333` · "explain the survey to me as if I was not familiar with Backdoors or how they are detected but I am deeply familiar with how LLMs work" (a request to be modelled as new, per the same 2026-09-09 answer, not a statement that he was)
- line: The names of the defenses he compares against and his own experiment parameters; not how any defense works inside.
  said: 2026-08-17 · CMT/`ba5da329` · "I am familiar with the technical concepts, but I want the most simple possible understanding of What defines these types of methods"
  paraphrase: undated · `tom-text/personal/01-boolean-backdoor-notes.summary.md` · names CROW, CleanGen, ONION, BEAT, BAIT, SANDE as the defenses compared against, and poison ratio, samples per variant and trigger ordering as his parameters.
- line: Python, machine-learning code, simple scripts and games, built by hand: the area he is most interested in understanding.
  said: 2026-09-09 · Tom, laptop design session on unified agent context · "I have a much more proficiant understanding of python, machine learning code, simple scripts, and games as that is what ive actually built by hand and it iss what im more interested in understanding."
  said: 2026-09-09 · Tom, laptop design session on unified agent context · "messed around with platformers, text based games, and other simple scripts in various languages."
- line: Classes taken in Python, Java, C++ and C# with Unity; he has not typed code in years, so syntax is not assumed.
  said: 2026-09-09 · Tom, laptop design session on unified agent context · "also took classes in python java, c++, c# (unity) but i havent typed out any code in years so dont assume i know the syntax."
- line: Directing agent work: subagents, workflows, worktrees, branches, merges, handoffs, context budgets, model tiers, crons, SLURM, GPUs, ssh.
  paraphrase: 2026-08-29 · writing.md as ruled in the calibration · the agent-operations list (subagents, workflows, worktrees, branches, merges, handoffs, context budgets, model tiers, crons, SLURM, GPUs, ssh, git) was ruled fluent; git left the line on 2026-09-09, when his answer that day (under Does not know, Git) superseded the ruling.

## Does not know

- line: Fourier and spectral analysis, including boolean Fourier analysis: Fourier mass, degree, correlation immunity, corner mass, exit sensitivity, peak gap.
  said: 2026-09-09 · Tom, laptop design session on unified agent context · "for the rest it is more vague. information theory is better than fourier/spectral stuff."
  said: 2026-08-10 · CMT/`ad3bd832` · "I've never heard of Fourier mass before."
  said: 2026-08-10 · CMT/`8793d9ab` · "explain every mathematical concept as you introduce it" (correlation immunity)
  said: 2026-07-12 · CMT/`6bf82060` · "I'm not very familiar with degrees"
  said: 2026-07-29 · WikiTom/`056ecf81` · "What is the degree you speak of?"
  said: 2026-07-12 · CMT/`6bf82060` · "What is Corner Mass? Is there other ways to describe this concept?"
  said: 2026-08-10 · CMT/`bc29f529` · "What does it mean for a function to have exit sensitivity zero?"
  said: 2026-07-30 · CMT/`e7b48279` · "What is peak gap?"
  said: 2026-06-25 · CMT/`285615f5` · "what are spectral vs structural metrics and why are they separated into two files?"
- line: Git beyond add, commit, push and pull: git-lfs, overwrite versus merge.
  said: 2026-09-09 · Tom, laptop design session on unified agent context · "I have used git a lot but outside of add, push, pull, commit, etc. my understanding is weak."
  said: 2026-06-23 · CMT/`858456b9` · "what are the git lfs changes? why are they here?"
  said: 2026-08-08 · CMT/`7405fb02` · "What is a full overwrite versus merge? Why should I care about this at all?"
- line: Cluster and storage internals: shards, drain semantics.
  said: 2026-06-13 · ssh/`10d3f5ac` · "I don't understand the drain semantics question."
  said: 2026-06-14 · ssh/`8da7169a` · "What are shards?"
- line: Nutrition, clinical and other scientific vocabulary he is interested in but does not hold; given the proper term with its definition he adopts it fast and then uses it.
  said: 2026-09-09 · Tom, laptop design session on unified agent context · "nutrition, clinical terms, and other scientific areas in which i am interested but not an expert, I want to learn more about them but i dont know many of the terms or have good intuitions about them."
  paraphrase: undated · writing.md as ruled · clinical and behavioural-psychology terms are absent until he adopts them; he adopts fast when given the proper term plus definition and then wields it.
- line: The internals of a published method, including one he names himself. (inferred)
  rests on: 2026-07-27 · CMT/`74825ad9` · he asked "what is the difference between inversion and reconstruction? what does bait mean when it says it inverts the target?"; generalized from this and the two below to every published method, which he has not said.
  rests on: 2026-08-18 · CMT/`ba5da329` · asked how DRA and Graceful work inside, having named them himself.
  rests on: 2026-08-14 · CMT/`02203779` · asked how DeCoMa works inside.
- line: The internals of everything in his repos: all code and content is agent-made with him.
  said: 2026-09-09 · Tom, laptop design session on unified agent context · "yes and we should assume that all code and content of my repos is agent created with me." (asked whether the internals of anything agent-made are unknown to him)
  said: undated · writing.md as ruled · "I want to clean up all the dirs adjacent to CMT called pm-* or cmt-*. I dont know what they are."
- line: Every number, column, label and status in a table an agent produced, until the table defines it.
  said: 2026-09-07 · CMT/`0574c2d7` · "what are the percentages in the tables? always make sure to define these things"
  read: 2026-09-08 · CMT/`3dc61f8c` · asked what "FAILED" meant as a table status.
- line: A name an agent coined for an experiment, a run or a concept.
  said: 2026-09-09 · CMT/`2662d1a9` · "you are using a lot of made up names for different experiments that I dont understand and for most of them i dont need to understand so translate it into normal language"
  said: 2026-08-08 · CMT/`542cf5c1` · "That is not a term I recognize, and I am intimately familiar with CMT." (on "terminal detectors", an agent coinage)
  said: 2026-06-24 · CMT/`1443531a` · "I dont understand what the aut(f) dedup is."
  said: 2026-07-25 · CMT/`b3ef62e9` · "what is a \"kind\" in cmt? I don't like catch-all terms, and this feels like one."
- line: His own older prose and rules: re-explain them, never ask him to remember. (inferred)
  rests on: undated · writing.md as ruled · his reply "1. idk its old." on one of his own older rules; generalized to all his older prose and rules, which he has not said.

## How to explain

- line: He learns intuitively and forgets specifics and names outside his focus: lead with the mechanism and re-supply the name.
  said: 2026-09-09 · Tom, laptop design session on unified agent context · "I like to learn things intuitively and I tend to forget the specifics or the names of things especially outside of my focus."
- line: A name an agent coined is never known; translate it to plain words.
  said: 2026-09-09 · CMT/`2662d1a9` · "you are using a lot of made up names for different experiments that I dont understand and for most of them i dont need to understand so translate it into normal language"
  said: 2026-08-08 · CMT/`542cf5c1` · "That is not a term I recognize, and I am intimately familiar with CMT."
- line: When he says a topic does not matter to him, the defining obligation drops for it and only the takeaways are owed. (inferred)
  rests on: 2026-09-07 · CMT/`3dc61f8c` · "I also don't understand section 2, but I don't really care to understand everything that has transpired. I just want to understand the takeaways" — against the older ruled sentence "err on the side of over explaining as id rather skip over background I already know rather than have to ask"; which governs is unruled.
