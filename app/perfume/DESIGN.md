# The Perfumer — /perfume design spec

Authoritative spec for the `/perfume` page. Read this fully before editing
anything under `app/perfume/`, `convex/brews.ts`, or the sync/data artifacts.
The companion execution plan is `app/perfume/SIMPLIFICATION-PLAN.md`.

**This file is the enforcement point against vocabulary drift.** Every term
below has exactly one meaning, in both the lore shown to players and the
identifiers in the code. There are no synonyms. Before you add a word to a
component, a type, a Convex field, or a piece of UI copy, find it in the
GLOSSARY; if the concept already has a word, use that word; if code uses a
different word for the same concept, rename the code, do not layer a new word
on top. The DEAD WORDS section names terms that must never appear again — if
you find one surviving in code, that is a bug to fix, not a style to match.

The domain rules (frequency combination, k-multiple matching) are lore and live
in the Byobu repo. `lib/engine.ts` is the single implementation of that math and
is shared by the client and Convex. Nothing in this document invents lore; the
math is settled and only its *presentation* is in scope here.

---

## 1. Glossary

**item.** Anything a player can pick up and drag. An item renders as a **rounded
square** carrying its art and nothing else — the icon fills the square; every
other fact about the item (its emitted frequencies, its type, its stack count,
its name) sits **on or outside** the square's edge, never inside it. There are
exactly three kinds of item: an **ingredient**, a **pure frequency**, and a
**perfume**. If it is a rounded square, it is an item and it moves; if it is not
a rounded square, it does not move (with the single strike exception below).

**real / hypothetical.** Told by the square's **background color**, not its
border. A **real** item sits on **parchment tan** — the ground sampled from
Joe's own ingredient cards — and is backed by inventory stock; brewing consumes
it. A **hypothetical** item sits on **tom.quest slate grey**, carries the same
icon, and is a what-if placeholder used for planning: it owns no stock and
brewing cannot complete while one is present. Both have solid borders. (A dashed
border means something else entirely — see **ghost**.) Hypotheticals come from
dragging out of a catalog or recipe **source** frame, or from an owner's real
ingredient exceeding available stock. A completed brew may contain **no**
hypotheticals.

**frequency.** A resonance value — one of the 9 fundamentals or the 17 named
frequencies. A frequency renders as a **circle** and it exists *only inside the
brew graph*, as a node emitted by ingredients and consumed by combination. A
frequency is not cargo: you cannot pick a circle up and carry it. The one
exception is the strike (below). Do not confuse a frequency (a circle in the
graph) with a **pure frequency** item (a rounded square in inventory that, when
brewed, contributes that frequency) — different shapes, different roles, same
underlying resonance.

**strike frequency.** The strike (⊖) is the mechanic that removes one frequency
from a brew. In the graph a strike renders as a **purple cover** laid over the
target frequency circle — it visually *covers* the circle rather than greying it
out, so the struck frequency reads as sealed, not deleted. The strike is the
**only** draggable exception to the "frequencies are not cargo" rule: a player
drags an available strike charge onto a frequency circle to strike it. Available
strike charges render in the graph above the ingredient that granted them, like
emitted frequencies awaiting use.

**wild frequency.** The wild (⊕) is the mechanic that adds one arbitrary
frequency to a brew. A wild charge renders in the graph above its source
ingredient; clicking it opens the **frequency search** (the same searchable
picker used by the Frequencies tab, with the wild itself excluded) to choose
which frequency it becomes.

**item frame.** A rounded-square **drop slot** — the empty counterpart to an
item. An item frame is where an item can land. Item frames appear in the
Ingredients list, the Frequencies list, an inventory, the brew graph, and a
perfume's recipe folds in the perfume panel. The catalog frames (Ingredients/
Frequencies) and the recipe frames are also **sources**: dragging out of them
yields a *hypothetical* item. A **real** item can only originate from an
inventory. Everywhere else an item frame is purely a destination.

**preview.** The **translucent** image of the item you are currently carrying,
shown inside an item frame that could accept it. Solid border, faded body. It is
a drop hint — "your carried stack can land here" — and vanishes when you drop or
cancel. A preview is not a ghost (a ghost is dashed and describes something
*missing*; a preview is translucent and describes something *in your hand*).

**ghost.** A **dashed circle** in the brew graph marking a **frequency the
pinned perfume still needs**. Ghosts are the visual form of the pin's closest
path (§5). Ghosts are **frequencies only** — the pin never renders ghost items
or "any-such-ingredient" suggestion frames; finding an ingredient that emits a
needed frequency is the player's craft, aided by the frequency filter. Adding a
frequency that a ghost marks solidifies the ghost into a real circle. Dashed
means ghost, and only ghost.

**brew graph.** The rooted graph at the center of the page. Its root is the
**cauldron node**; above it the graph grows upward through **ingredient** nodes,
the **frequency** circles those ingredients emit, the **strike/wild charges**
they grant, and the **combined** and **stricken** nodes produced as frequencies
fuse and are struck. Orientation is fixed: cauldron at the bottom, growth upward.
The brew graph is the visual form of a **brew**.

**brew.** A pass-around object holding a set of items in progress toward a
perfume. A brew has a **holder**, and the holder is its **owner** — the one
person who may add *real* ingredients to it, brew it, and move its owner's real
items. Ownership travels with the object: opening someone else's brew is not the
same as taking it. A brew persists after brewing (see RULES). Every brew has a
deep link at `/perfume/b/[id]`.

**party brew.** A brew with **no owner**. On a party brew every member has an
inventory tab and everyone may contribute their own real ingredients, brew, and
take results. It is the shared table everyone can reach into.

**recipe.** A perfume's **frequency requirement** — the target frequency multiset
that, when a brew's effective tally matches it (or an integer multiple of it),
brews that perfume. A perfume has one **common recipe** and may have other
recipes. The word for this concept is *recipe* and only *recipe*. The
requirement-**index** field `reqIndex` still uses the `req` abbreviation, since
it names a position in `recipes`, not the concept.

**combo.** An ingredient **combination that reaches a recipe** — a concrete list
of ingredients whose emitted frequencies land on a recipe's requirement. Combos
are shown as the **recipe folds** in the perfume panel. `Combo` already exists in
`lib/types.ts`; keep the word.

**tally.** The **effective frequency multiset of a brew** — what the brew emits
after strikes, wilds, and auto-combination are applied. This is the number the
engine compares against recipes. The word for this multiset is *tally* and only
*tally*.

**effect.** A perfume's in-game effect text, authored in Byobu and carried on
`base.json` (`perfume.effect`, `"unknown"` until Joe reveals it — only Swana's
Serum is known so far). Shown in the perfume tooltip and the panel fold.

**provenance.** The origin metadata a perfume carries: **`brewedBy`** (who
clicked brew) and **`witnesses`** (everyone viewing the stage at completion).
That is the whole of it — there is **no ownership chain** and ingredient stacks
carry **no gift history**. Surfaced as a hover tooltip alongside the effect.

**brewing.** The act that **creates a perfume** from a brew whose tally exactly
matches a recipe. Brewing consumes the brew's real ingredients and places the
resulting perfume(s) on the cauldron to be taken. The word is *brewing*.

**pin.** A **target perfume** attached to a brew (§5). One per brew, on the brew
object so all viewers share it, set from the perfume panel.

**member / visitor.** A **member** is a logged-in tom.quest user who has clicked
to join; they have an inventory and brews. A **visitor** is not logged in and may
only look. There is no anonymous membership and no local practice mode.

---

## 2. Dead words

These terms are banned from code, types, Convex fields, and player-facing copy.
Each maps to its single living replacement. Finding one is a defect.

| Dead word | Replacement |
|---|---|
| tuning | **recipe** |
| bottling | **brewing** |
| bottle / phial (the perfume item or its art) | **perfume** |
| book (the right panel) | **perfume panel** |
| bench | **brew** |
| pot | **brew** / **cauldron node** (party pot → **party brew**) |
| output shelf / output tray / outputs | **cauldron** (perfumes sit *on the cauldron*) |
| transfer (as a feature name) | **gifting** |
| owners / ownership chain | *(deleted — provenance is `brewedBy` + `witnesses` only)* |
| local / practice mode / `?local` / `?seed` | *(deleted — no sandbox)* |
| anon / anonId | *(deleted — membership is login-only)* |

There is **no** surviving neutral use of "bottle" or "phial": the perfume item
and its art are both **perfume**.

---

## 3. Rules of brewing

**Consumption.** Brewing consumes the brew's **real** ingredients from the
owner's inventory **forever** — they do not return. So the brew graph does not
collapse on completion, each consumed real ingredient is replaced in place by its
**hypothetical** twin (same icon, grey ground): the graph is left visually
unchanged, but it now describes a plan rather than owned stock. The resulting
perfume(s) sit **on the cauldron** until taken.

**No hypotheticals at completion.** A brew can be brewed only when **every** item
in it is real. A single hypothetical item blocks brewing; the Brew control names
the blocker.

**k-multiples.** When a brew's tally equals **k×** a recipe, brewing produces
**k** perfumes, which stack on the cauldron. The engine computes k
(`evalReq(...).k`); the UI never re-derives it.

**Brew persistence.** A brew is a durable object, not a transient session. It
survives brewing (as the hypothetical-twin graph above), survives its holder
navigating away, and is reachable by its deep link. It disappears only when its
owner (or Tom) deletes it.

**Taking.** Perfumes resting on the cauldron are taken into an inventory. On an
owned brew only the owner may take; on a party brew anyone may. Taking is
permanent (not undoable).

---

## 4. Brews, party, membership

**Membership is login-only.** A logged-in tom.quest user becomes a **member** by
clicking to join (in the settings gear). A **visitor** (not logged in) may
**look but not touch** shared state — no dragging, no joining, action controls
hidden or disabled with a "sign in to join" hint. There is **no** anonymous
identity and **no** local practice space. A member may remove **themselves**;
**Tom is admin** and may remove any member and delete any brew.

**Multi-brew model.** Many brews exist at once, each an independent pass-around
object. The scale target is roughly five members with three-to-five brews each,
with no hard cap.

**Ownership, handoff, copy.** A brew's holder is its owner. Ownership moves only
by **explicit handoff** — merely opening someone's brew does not take it. Any
member may **copy** another member's brew, producing a new brew they own with the
same items (copies start hypothetical; the copier fills from their own
inventory).

**Permissions matrix.** Permission follows "WHERE, not WHAT": non-owners may
change *where* the owner's items sit, never *what* the owner owns.

| Actor | On a brew they own | On another member's brew | On a party brew | As visitor |
|---|---|---|---|---|
| Move owner's items in the graph | yes | yes | yes (own items) | no |
| Add **real** ingredients | yes | no (hypothetical only) | yes (own real) | no |
| Add **hypothetical** items | yes | yes | yes | no |
| Play/undo strikes & wilds | yes | yes | yes | no |
| Brew | yes | no | yes | no |
| Take perfumes from cauldron | yes | no | yes | no |
| Gift items | yes (own) | no | yes (own) | no |
| Pin a perfume | yes | no | yes | no |

**Default naming.** A brew's default name is **"{owner} brew {n}"** (n = the
owner's brew sequence number). **Anyone can nickname any brew** — nicknames are
free-form and not owner-restricted.

**Deep links.** Every brew has a shareable URL `/perfume/b/[id]`.

**Top bar.** The top bar lists brews **grouped by member**, with **you first**.
Each member shows their **5 most recent** brews plus a **see-all** affordance. A
**"+"** creates a new brew. The **party brew** sits at the front of the bar. Each
member shows an avatar with a **green activity dot** when recently present.

---

## 5. Interactions

**Drag grammar.** Items (rounded squares) are dragged from a source frame or
inventory into an item frame. Clicking an item picks up **one**; clicking the
same source again picks up one more (the carried count rises); **right-click puts
one back**; clicking a destination frame settles the carried stack there.
Press-and-drag is the fluid equivalent. Escape returns the whole carried stack.
The carried stack rides the cursor at **full opacity** (never faded) with its
count badge; the translucency belongs to the frame **preview**, not the hand.
Shift-click teleports one item straight into/out of the brew, skipping the carry.

A frequency (circle) is not draggable — the sole exception is the strike: an
available strike charge is dragged onto a frequency circle to strike it (rendered
as the purple cover). Wilds are not dragged; a wild charge's frequency is chosen
from the frequency search.

**Item frames.** A drop lands in an item frame. Catalog and recipe frames are
also sources yielding **hypothetical** items; an inventory is the only source of
**real** items. An empty frame that could accept the currently-carried item shows
a **translucent preview** of it.

**Gifting.** To gift, drag one of your items onto a **member's inventory tab**.
The target tab shows a translucent drop preview while hovering. The gift is
**instant** — no acceptance step. (This replaces the old transfer feature.)

**Brew-scale controls.** Three controls act on the whole brew at once:
- **Fill from inventory** — turn every hypothetical item the relevant inventory
  can cover into a real one; what can't be covered stays hypothetical and the
  control names the shortfall.
- **Return ingredients** — return the brew's real ingredients to their owners'
  inventories; hypotheticals stay.
- **Empty brew** — return real items to owners, then clear the brew.

**Per-user undo/redo.** Undo and redo affect **only your own moves** (adds,
removes, strikes, wilds, pins). You cannot undo another member's actions, and
**brewing, taking, and gifting are permanent** (never undoable).

**Pin — the target and the path.** **Exactly one perfume** may be pinned to a
brew. Pinning changes shared brew intent, so it is an **owner-act** (§4 matrix):
allowed on your own brew and on the party brew, **not** on another member's owned
brew — unlike nicknaming, which anyone may do to any brew. The pin lives on the
**brew object** (everyone viewing sees it), set from the perfume panel. Pinning runs the engine's **closest-path** solver over the
current brew: it finds the satisfying frequency set — across all of that
perfume's recipes and k-multiples — reachable with the **fewest additions**,
ties broken toward the common recipe then smaller k. Each still-needed frequency
renders as a **ghost circle** in the graph. **Ghost strikes appear only when no
add-only path exists** at any k for any recipe (the brew holds excess no recipe
absorbs). The path is **live** — every brew change recomputes it, possibly
rerouting to a different recipe of the same perfume. The stage header names the
recipe currently being steered toward. Pinning replaces the perfume panel's old
favorites feature entirely.

---

## 6. Layout

**Center stage.** The brew graph is the always-on center stage. It is never
hidden. A **"?" help button** sits in a corner of the stage (§ Help popup).

**Drawers.** The **left input panel** and the **right perfume panel** are
**resizable drawers**. On a **wide** viewport both are open by default, flanking
the stage. On a **narrow** viewport they become **overlays** and only **one at a
time** may be open over the stage.

**Input panel tabs.** The input panel is tabbed: **Ingredients** (the
hypothetical-ingredient playground) | **Frequencies** (the pure-frequency
playground, including strike and wild) | then **one tab per member inventory**,
with **your own first**. Each entry renders as an **item frame** in a grid,
compactly showing name, emitted frequencies, and type. Keep search and the
frequency filter. The **Import** dialog on your own inventory offers two ways in
side by side: a **paste box** (one item per line, typo-forgiving, ranked guesses
for near-misses) and a **searchable click-to-add catalog** (same search/filter
grammar as the panel); **Add** merges, **Replace** swaps wholesale.

**Perfume panel.** The right drawer keeps **all** existing features — search,
filters, status, recipe folds — but **decluttered**. It shows each perfume's live
status against the current brew (matched / in reach / off), its **effect** when
known, and, after a successful brew, **which recipe** was satisfied. Its
recipe-fold ingredient pills are real item frames obeying the drag grammar. The
**pin control is per-perfume** (not per-recipe).

**Presence cursors.** Other members' cursors are shown **on the stage only**.
When a member's cursor leaves the stage it **freezes at its last position**
rather than vanishing.

**Settings corner.** The gear holds **only** mute and membership (join/leave).
Its old "how it works" text moves to the help popup.

**Help popup.** Behind the stage-corner **"?"**, three layers top to bottom:
(a) a **condensed legend** strip rendering the real glyphs (tan/grey mini-frames,
ghost circle, purple cover, cauldron tint, square-vs-circle); (b) the
**first-brew walkthrough** — ten illustrated step cards built from the real
components, covering everything a fresh member needs *including how ingredients
enter play* (imported from the game, recorded via Import); (c) the **rules**
list. Copy is authored in the UX suite and mirrored here.

**Brewing ceremony.** Brewing plays a **classy** completion animation with
**sound**. The mute toggle governs the sound.

---

## 7. Aesthetic policy

The **current tom.quest perfume look is final**: the dark-slate palette, the
Syne / IBM Plex typography, and the existing animation language all stay. This is
a **mechanical** overhaul, not a visual restyle. The visual changes in scope are
exactly those §1/§5/§6 mandate: icon-only frames, the tan/grey real/hypothetical
grounds, marks moved outside the frame, ghost-frequency rendering, the help
popup, and a feel refresh for buttons and tabs.

**Item art.** Ingredient and named-frequency artwork comes from Joe and lives
under `public/perfume/ingredients/` (96 PNGs, keyed by ingredient), extracted in
Byobu **without** the black outline pass. Items render this art on their rounded
square over the real/hypothetical ground.

**Real/hypothetical grounds.** `--pf-real` is the parchment tan sampled from
Joe's ingredient PDF at art-extraction time (the sample's rgb is recorded in the
token comment); `--pf-hypothetical` is the tom.quest slate grey.

**Perfume art.** A perfume is a **generic silhouette tinted by the blend of its
fundamental frequencies**. The **cauldron liquid** uses the **same blend logic**,
tinting to the current brew's fundamentals.

---

## 8. Data contract

Byobu owns the data pipeline (Joe's ground-truth PDFs → transcription/compile/art
extraction) and emits **only data artifacts**: `data.json`, `emblems.json`, and
the ingredient **PNGs**. tom.quest owns the copy step.

`scripts/sync-perfume-data.mjs` pulls those artifacts out of a Byobu checkout
(default `C:/Users/heffn/Desktop/Byobu`) into tom.quest, validating shape before
writing anything:
- `app/data.json` → `app/perfume/data/base.json`
- `app/emblems.json` → `app/perfume/data/emblems.json`
- ingredient `*.png` → `public/perfume/ingredients/`

`base.json` carries `fundamentals` (9), `named` (17), `types`, `ingredients`
(96), `perfumes` (≥40, each with `effect`). `emblems.json` is keyed by
named-frequency id, each entry **exactly `{icon, d}`** (the extra `fillRule`/
`pieces`/`srcBox` fields are not emitted — tom.quest reads only `icon` + `d`).
Both are **synced artifacts** — never hand-edit them; regenerate in Byobu and
re-run the sync. The `.ts` wrappers in `app/perfume/{data,lib}` are hand-written
and only import the JSON. The sync never writes back into Byobu, and Byobu's
`ground-truth/**` is never touched by tom.quest.

---

## 9. Backend sketch

Convex tables (prefix `perfume`), one engine imported from
`app/perfume/lib/engine` and used **server-side** to re-verify every brew — no
re-implementation, ever. The client no longer keeps a parallel local rulebook:
the item/inventory/brew math is a single shared module (`lib/brew-ops.ts` or the
engine) imported by both the store and Convex.

- **members** — one row per registered member: identity (account name, color,
  optional uploaded image icon), `lastSeen`, admin derived from `users.role`.
  A logged-in user gets a row by clicking join; self-removal deletes the row;
  Tom may delete any. **No anon keys.**

- **brews** — one row per brew: `owner` (member id, or `null` for the party
  brew), free-form `nickname`, per-owner `seq`, the **items** in the graph (each
  real/hypothetical, with contributor — names resolved at read, not stored), the
  played **strikes** and **wilds**, the **pinned** perfume (`{perfumeId}`), and
  the perfumes resting **on the cauldron**. Each cauldron perfume carries
  provenance **`{brewedBy, witnesses}`** — nothing more.

- **inventories** — per-member holdings. **Perfumes are instances** with
  provenance `{brewedBy, witnesses}`. **Ingredients are fungible stacks** (a
  count) with **no gift history**.

- **presence** — per-brew cursor rows (member, color, stage coordinates),
  driving the stage cursors and the activity dot; a cursor leaving the stage
  freezes at its last position.

- **per-user undo log** — each member's own recent moves, replayable by that
  member only, built on the **same `doMove`/`doPlay` cores** as the forward
  mutations (no parallel reverse implementation). Brewing, taking, and gifting
  are **not** written as undoable entries.

There is **no event/activity log table**. Identity, the "WHERE not WHAT"
permission checks, and the conservation invariant (no mutation creates or
destroys items except inventory import (+) and brewing (brew → k perfumes per the
engine)) are enforced in the mutations, mirroring §4.
