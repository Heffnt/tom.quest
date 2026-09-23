# Dead-code verification record

Working record for one batch: "Delete the tom.quest code and comments nothing
reaches". It re-checks every candidate that batch names against the repository
as it stands, so the five deletion tasks that follow do not have to re-establish
the same facts. Delete this file when the batch closes.

Verified at commit `d1daece` (`session/q97fkwhv0gt560zc4eh3zrm6tx8dm5at`, which
is `origin/main` with no commits ahead of it), 2026-09-02. Method: a repo-wide
`grep -rn` from the repository root for each named identifier, once with `-w`
(whole word) and once as a bare substring, excluding `.git`, `node_modules`,
`.next`, `convex/_generated` and `pnpm-lock.yaml`. All ten top-level directories
were in scope: `app`, `convex`, `e2e`, `public`, `scripts`, `secrets`, `tts`,
`turing-api`, `vqc`, `worker`.

## Headline

Nothing has gained a reader. Every symbol, field and branch the batch names is
still unreachable, by the same argument that was filed. No deletion item needs
to be dropped.

Eight line references have drifted, three item descriptions are wrong on a point
of substance, and two identifiers have close cousins that are live code. Those
are the four sections below.

## 1. Line references that drifted

Positions the batch filed against positions in the repository now. The symbol is
the same in every row; only the line moved.

| Symbol or comment | Filed at | Actually at |
| --- | --- | --- |
| `pad2Hex` | `app/thmm/lib/format.ts:39` | `app/thmm/lib/format.ts:47` |
| `BrewKey` | `app/perfume/lib/brew-types.ts:114` | `app/perfume/lib/brew-types.ts:110` |
| `TODO(tom)` on `rankPages` | `app/components/page-routes.ts:42` | `app/components/page-routes.ts:57` |
| `convex/perfume.ts` comment in the schema | `convex/schema.ts:220` | `convex/schema.ts:232` |
| the `useServer` mention in `AGENTS.md` | `AGENTS.md:55` | `AGENTS.md:70` |

Every other filed position is exact: `instructionsToBitsSource`
(`app/thmm/thcc.ts:581`), `FIB_SOURCE` (`app/thmm/fib.ts:42`) with its doc
comment at `:40`, `PER_METHOD_BASES` (`app/boolback/lib/method-metrics.ts:72`),
`metricGroupings` (`app/boolback/lib/metrics.ts:39`), `thousands`
(`app/boolback/lib/format.ts:23`), `GraphBand`
(`app/perfume/lib/brew-graph-layout.ts:109`), `StreamBuf`
(`app/sessions/lib.ts:12`), `InboundRow` (`:13`), `DaemonHealth` (`:15`),
`sweep_yaml_path` (`app/forge/types.ts:34`), `tiedEmbeddings`
(`app/transformer/lib/model.ts:15` and `:28`,
`app/transformer/lib/turing-source.ts:19` and `:79`), `stripPredictionLabel`
(`app/clouds/point-hover-tooltip.tsx:186-188`, called at `:90`), and the
`convex/perfume.test.ts` comment at `convex/brews.test.ts:5`.

## 2. Three item descriptions that are wrong on substance

### 2.1 The stale `convex/perfume.ts` comments are four, not two

The item names `convex/schema.ts:220` and `convex/brews.test.ts:5`. A repo-wide
search for the strings `perfume.ts` and `perfume.test.ts` returns four comment
sites, all naming files that do not exist. `convex/perfume.ts` and
`convex/perfume.test.ts` are both absent; the rename produced `convex/brews.ts`
and `convex/brews.test.ts`.

| Site | Text | Should name |
| --- | --- | --- |
| `convex/schema.ts:232` | admin "is derived from users.role via authRoles, exactly as convex/perfume.ts does" | `convex/brews.ts` |
| `convex/brews.test.ts:5` | "Mirrors the harness/utilities of convex/perfume.test.ts." | `convex/brews.test.ts` (this file itself — see note) |
| `convex/brews.ts:148` | "(convex/perfume.ts colorFor)" | `convex/brews.ts` (this file itself) |
| `convex/brews.ts:474` | "Mirrors convex/perfume.ts verifyBrew, reading …" | `convex/brews.ts` (this file itself) |

Three of the four are now self-references: the comment sits in the very file the
rename produced, so "mirrors convex/perfume.ts verifyBrew" means "mirrors
`verifyBrew` in this file". A literal repoint would produce a comment that tells
the reader to look at the file they are already reading. Whoever takes that item
should reword those three rather than substitute the filename, and only
`convex/schema.ts:232` is a plain cross-file repoint.

Unrelated to the comments: the schema table is still named `perfumeMembers`
(`convex/schema.ts:234`). The rename covered files, not table names. Leave it —
renaming a Convex table is a data migration, not a comment fix.

### 2.2 `turing-api/forge.py` is in this repository, and it is clean

The `sweep_yaml_path` item says the field's potential writer,
`turing-api/forge.py`, "lives outside this repo, so the check was that nothing
there emits it either". `turing-api/` is a directory of this repository and
`turing-api/forge.py` is in it. The check is therefore an ordinary grep and it
passes: the string `sweep` does not appear anywhere in `turing-api/*.py`, so
nothing emits `sweep_yaml_path` and nothing on the client reads it. The field at
`app/forge/types.ts:34` is dead on both sides and the commit note the item asks
for can state that plainly instead of hedging about a repository boundary.

### 2.3 `AGENTS.md` has nothing to correct

The `use-server.ts` item asks for a correction to `AGENTS.md:55`, "which
advertises the deleted interface". `AGENTS.md:55` reads `## Routing`. The only
mention of the hook anywhere in `AGENTS.md` is line 70, in the Turing Proxy
section:

> Liveness is owned by a Convex cron (`internal.serverHealth.pollTuring`) that
> probes `/health` and writes to the `serverHealth` table; `useServer("turing").status`
> reads it.

That sentence describes exactly the part of the hook that survives the deletion —
the `turing` kind and the `status` field. It stays true afterwards. Searches for
`jarvis`, `use-server`, `ServerAdapter` and `subscribe` across `AGENTS.md` turn
up nothing else about the hook. The `AGENTS.md` half of that item is a no-op and
the commit should say so rather than invent an edit.

## 3. Two candidates that are dead by reachability, not by being uncalled

Both are correctly on the list. The point is that a checker who greps for a
single occurrence and finds two will think the item was withdrawn.

**`useJarvisServer`** has two occurrences: its definition at
`app/lib/hooks/use-server.ts:111` and a call at `:138`, inside `useServer`, which
computes both adapters and then returns one:

```
useServer(kind)  →  useTuringServer()  →  returned when kind === "turing"
                 →  useJarvisServer()  →  returned otherwise  ← never happens
```

The repository has exactly one `useServer` call site,
`app/components/debug-panel.tsx:42`, and it passes the literal `"turing"`. So the
jarvis branch is unreachable, and with it `useJarvisServer`, its `subscribe`
(`:124`) and the jarvis `call` (`:119`). That call site also reads only
`.status`, at `debug-panel.tsx:81-83` and again in the dependency array at `:86`,
which is what makes the turing `call` at `:86` of the hook and the no-op
`subscribe` at `:107` dead as well.

One consequence for the deleter: removing `useJarvisServer` orphans the import of
`useOptionalGateway` at `use-server.ts:6`, which must go with it.
`useOptionalGateway` itself stays — it is defined at
`app/jarvis/components/useGateway.ts:153` and used at `:158` by `useGateway`,
which the whole `app/jarvis` surface calls.

**`stripPredictionLabel`** also has two occurrences: the definition at
`app/clouds/point-hover-tooltip.tsx:186-188` and the call at `:90`. It is dead
because the regular expression never matches, not because nothing calls it. The
call site passes `mode.label` for modes selected at `:37-38` by
`mode.id.startsWith("pred_")`. Every `pred_*` label in
`public/data/clouds/manifest.json` was read out and none carries the
`Predictions — ` prefix the expression strips:

`K-means XYZ`, `K-means on PointNet embeddings`, `HDBSCAN XYZ`, `HDBSCAN on
PointNet embeddings`, `GMM XYZ`, `GMM on PointNet embeddings`, `PointNet (overlap
+ TTA)`, `PointNet (no overlap, no TTA)`, `PointNet++ (overlap + TTA)`,
`PointNet++ (no overlap, no TTA)`, `Floor + pole detector`, `RANSAC ground
plane`.

The function returns its argument unchanged for all twelve, so deleting it and
passing `mode.label` directly changes nothing on screen.

There is a live sibling that should not be swept up with it:
`app/clouds/control-panel.tsx:104` strips `/^(Ground truth|Predictions?) — /`
from mode labels, and that one does fire — the three `gt_*` labels in the
manifest are `Ground truth — top`, `Ground truth — mid` and `Ground truth —
leaf`.

## 4. Identifiers a substring search would confuse with live code

Three of the dead type aliases share a stem with query names that are in daily
use. Searching whole-word (`grep -w`) separates them; searching by substring does
not.

| Dead alias | Occurrences whole-word | Occurrences as substring | What the extra hits are |
| --- | --- | --- | --- |
| `StreamBuf` (`app/sessions/lib.ts:12`) | 1 | 15 | the Convex table `claudeStreamBuf`, and the live query `getStreamBuf` (`convex/claudeSessions.ts:170`, read at `app/sessions/components/transcript.tsx:183`) |
| `DaemonHealth` (`app/sessions/lib.ts:15`) | 1 | 18 | the Convex table `claudeDaemonHealth`, and the live query `getDaemonHealth` (`convex/claudeSessions.ts:209`, read at `app/sessions/sessions-client.tsx:30` and `app/sessions/components/session-list.tsx:63`) |
| `InboundRow` (`app/sessions/lib.ts:13`) | 1 | 1 | none |

Only the three bare type aliases go. The tables and the queries stay. The two
neighbouring aliases in the same file, `Session` (`:10`), `Message` (`:11`) and
`PermissionRow` (`:14`), are live and are not on the list.

## 5. The remaining items, confirmed as filed

**The eight single-occurrence exports.** Each of `instructionsToBitsSource`,
`FIB_SOURCE`, `pad2Hex`, `PER_METHOD_BASES`, `metricGroupings`, `thousands`,
`BrewKey` and `GraphBand` returns exactly one line repo-wide, whole-word and as a
substring alike: its own definition. There is no `export *` anywhere in `app/`,
`convex/` or `e2e/`, so no barrel file re-exports them under another name, and no
string-keyed indirection reaches them.

**The `fib.ts:40` doc comment.** No file named `program-editor` exists anywhere
in the repository. But `parseProgram` does exist — as a method at
`app/thmm/thcc.ts:185`, called at `:517` — so the comment's claim that a parser
tolerates comments, blank lines and whitespace is true and only its file name is
stale. Since `FIB_SOURCE` is going, the comment goes with it and no repoint is
needed; the deleter is not removing a false statement, just an unreachable one.

**`tiedEmbeddings`.** Exactly the four sites filed, and no fifth. There is no
wholesale reader that would consume the field without naming it: nothing in
`app/transformer/` iterates a `ModelConfig` with `Object.entries` or
`Object.keys`, and the two `JSON.stringify` calls in that directory serialize the
remote-URL setting (`app/transformer/state.ts:122`) and a generation request
(`app/transformer/lib/turing-source.ts:95`), neither of which touches the config.
The server side is in this repository too: `turing-api/transformer_server.py:186`
emits `tied_embeddings`, and `app/transformer/lib/turing-source.ts:19` declares
it on the `ServerConfig` type that receives it. So the decision the item asks for
— stop emitting it, or keep it as a server field with no client reader — can be
made and carried out here.

**The `rankPages` TODO.** The trigger condition has passed: the `PAGES` registry
in the same file holds exactly 15 entries (`turing`, `canvas`, `transformer`,
`thmm`, `clouds`, `perfume`, `sessions`, `tts`, `forge`, `jarvis`, `logo`,
`game`, `bio`, `boolback`, `help`) against a stated threshold of 10. `rankPages`
itself is live — called at `app/home-client.tsx:54`, `app/components/nav-term.tsx:63`,
and in `app/components/page-routes.test.ts` — so only the comment is at issue,
and that is Tom's ruling to make, not a deletion.
