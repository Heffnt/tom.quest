# The Perfumer — /perfume design spec

Authoritative spec for the overhauled `/perfume` page. Read this fully before
editing anything under `app/perfume/`, `convex/perfume.ts`, or the sync/data
artifacts.

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
square** carrying its art. There are exactly three kinds of item: an
**ingredient**, a **pure frequency**, and a **perfume**. The rounded-square shape
is the universal signal "this is draggable cargo." If it is a rounded square, it
is an item and it moves; if it is not a rounded square, it does not move (with
the single strike exception below).

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
frequency to a brew. A wild renders in the graph with a **dropdown** by which the
player picks which frequency it becomes. Like the strike, available wild charges
render above their source ingredient in the graph.

**item frame.** A rounded-square **drop slot** — the empty counterpart to an
item. An item frame is where an item can land. Item frames appear in exactly
five contexts: (a) the Ingredients list, (b) the Frequencies list, (c) an
inventory, (d) the brew graph, and (e) a perfume's recipe folds in the perfume
book. Two of those contexts — the Ingredients/Frequencies **catalog** frames and
the **recipe** frames — are also **sources**: dragging out of them yields a
*hypothetical* item (see real/hypothetical). A **real** item can only originate
from an inventory. Everywhere else an item frame is purely a destination.

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
recipes; when a brew completes, the UI shows **which** recipe was satisfied. The
word for this concept is *recipe* and only *recipe*. (The perfume field and the
"tuning" comments have been renamed to `recipes`; the requirement-**index**
fields `req` (on a combo) and `reqIndex` (on an eval result) still use the `req`
abbreviation, since they name a position in `recipes`, not the concept.)

**combo.** An ingredient **combination that reaches a recipe** — a concrete list
of ingredients whose emitted frequencies land on a recipe's requirement. Combos
are shown as the **recipe folds** in the perfume book. `Combo` already exists in
`lib/types.ts`; keep the word.

**tally.** The **effective frequency multiset of a brew** — what the brew emits
after strikes, wilds, and auto-combination are applied. This is the number the
engine compares against recipes. The word for this multiset is *tally* and only
*tally*.

**real / hypothetical.** A **real** item is backed by inventory stock; brewing
consumes it. A **hypothetical** item is a what-if placeholder used for planning —
it carries the **same icon** as its real counterpart but a **dashed border**.
Hypothetical items come from dragging out of a catalog or recipe **source**
frame, or from an owner's real ingredient exceeding available stock. A completed
brew may contain **no** hypotheticals.

**provenance.** The origin-and-history metadata every perfume and ingredient
stack carries: who created it, who brewed it, and its ownership chain as it was
gifted between members. Surfaced as a hover tooltip.

**brewing.** The act that **creates a perfume** from a brew whose tally exactly
matches a recipe. Brewing consumes the brew's real ingredients and places the
resulting perfume(s) on the cauldron to be taken. The word is *brewing*; a
perfume is never "bottled."

---

## 2. Dead words

These terms are banned from code, types, Convex fields, and player-facing copy.
Each maps to its single living replacement. Finding one is a defect.

| Dead word | Replacement |
|---|---|
| tuning | **recipe** |
| bottling / bottle (as the verb/result of brewing) | **brewing** / **perfume** |
| bench | **brew** (the workspace object) |
| pot | **brew** / **cauldron node** (party pot → **party brew**) |
| output shelf / output tray | **cauldron** (perfumes sit *on the cauldron*) |
| transfer (as a feature name) | **gifting** |

"Bottle" survives only as the neutral noun for the perfume *art* (a generic
bottle silhouette tinted by the blend) — never as a synonym for the perfume item
or the brewing act.

---

## 3. Rules of brewing

**Consumption.** Brewing consumes the brew's **real** ingredients from the
owner's inventory **forever** — they do not return. So the brew graph does not
collapse on completion, each consumed real ingredient is replaced in place by its
**hypothetical** twin (same icon, dashed border): the graph is left visually
unchanged, but it now describes a plan rather than owned stock. The resulting
perfume(s) sit **on the cauldron** until taken.

**No hypotheticals at completion.** A brew can be brewed only when **every** item
in it is real. A single hypothetical item blocks brewing; the brew controls name
the blocker.

**k-multiples.** When a brew's tally equals **k×** a recipe, brewing produces
**k** perfumes, which stack on the cauldron. The engine computes k
(`evaluate(...).k`); the UI never re-derives it.

**Brew persistence.** A brew is a durable object, not a transient session. It
survives brewing (as the hypothetical-twin graph above), survives its holder
navigating away, and is reachable by its deep link. It disappears only when its
owner (or Tom) deletes it.

**Taking.** Perfumes resting on the cauldron are taken into an inventory. On an
owned brew only the owner may take; on a party brew anyone may. Taking is
permanent (not undoable).

---

## 4. Brews and party

**Multi-brew model.** Many brews exist at once, each an independent pass-around
object. The scale target is roughly five members with three-to-five brews each,
but the model imposes no hard cap.

**Ownership, handoff, copy.** A brew's holder is its owner. Ownership moves only
by **explicit handoff** — merely opening someone's brew does not take it. Any
member may **copy** another member's brew, producing a new brew they own with the
same items (copies start hypothetical; the copier fills from their own
inventory).

**Permissions matrix.** Permission follows the "WHERE, not WHAT" philosophy:
non-owners may change *where* the owner's items sit, never *what* the owner owns.

| Actor | On a brew they own | On another member's brew | On a party brew | As visitor (not logged in) |
|---|---|---|---|---|
| Move owner's items in the graph | yes | yes | yes (own items) | no (read-only) |
| Add **real** ingredients | yes | no (hypothetical only) | yes (own real) | no |
| Add **hypothetical** items | yes | yes | yes | no |
| Play/undo strikes & wilds | yes | yes | yes | no |
| Brew | yes | no | yes | no |
| Take perfumes from cauldron | yes | no | yes | no |
| Gift items | yes (own) | no | yes (own) | no |
| Pin a recipe | yes | no | yes | no |

A visitor (not logged in) may **look but not touch** shared state. A local
practice space (`?local=1`) gives visitors an isolated, non-shared brew to play
with; nothing there reaches the shared tables.

**Registration.** A logged-in tom.quest user becomes a **member** by visiting
`/perfume` and **clicking to join**. A member may remove **themselves** at any
time. **Tom is admin**: Tom may remove any member and delete any brew.

**Activity indicator.** Each member shows an online-activity icon reflecting
recent presence.

**Default naming.** A brew's default name is **"{owner} brew {n}"** (n = the
owner's brew sequence number). **Anyone can nickname any brew** — nicknames are
free-form and not owner-restricted. (The earlier four-letters-joined-by-dashes
scheme was rejected as confusing; do not resurrect it.)

**Deep links.** Every brew has a shareable URL `/perfume/b/[id]`.

**Top bar.** The top bar lists brews **grouped by member**, with **you first**.
Each member shows their **5 most recent** brews plus a **see-all** affordance. A
**"+"** creates a new brew. The **party brew** sits in the bar alongside the
per-member groups.

---

## 5. Interactions

**Drag grammar.** Items (rounded squares) are dragged from a source frame or
inventory into an item frame. A frequency (circle) is not draggable — the sole
exception is the strike: an available strike charge is dragged onto a frequency
circle to strike it (rendered as the purple cover). Wilds are not dragged; a wild
charge's frequency is chosen from its dropdown.

**Item frames.** A drop lands in an item frame. Catalog and recipe frames are
also sources yielding **hypothetical** items; an inventory is the only source of
**real** items. An empty frame that could accept the currently-dragged item shows
a **ghosted affordance** of that item.

**Gifting.** To gift, drag one of your items onto a **member's inventory tab**.
The target tab shows a **ghosted item-frame affordance** while hovering. The gift
is **instant** — no acceptance step — and the transfer records **provenance** on
the gifted item. (This replaces the old transfer feature; see DEAD WORDS.)

**Brew-scale controls.** Three controls act on the whole brew at once:
- **Fill from inventory** — turn every hypothetical item in the brew into a real
  one, drawing from the relevant inventory.
- **Return ingredients** — return the brew's real ingredients to their owners'
  inventories.
- **Empty brew** — clear the brew.

**Per-user undo/redo.** Undo and redo affect **only your own moves**. You cannot
undo another member's actions, and **brewing, taking, and gifting are permanent**
(never undoable).

**Pin.** A player may **pin exactly one recipe** to a brew. The pin lives on the
**brew object** (so everyone viewing that brew sees it), and it renders **ghost
nodes/frames** in the graph showing what the pinned recipe still needs. The pin
**replaces** the perfume book's old favorites feature entirely — there is no
separate favorites list.

---

## 6. Layout

**Center stage.** The brew graph is the always-on center stage. It is never
hidden.

**Drawers.** The **left input panel** and the **right perfume book** are
**resizable drawers**. On a **wide** viewport both drawers are open by default,
flanking the stage. On a **narrow** viewport they become **overlays** and only
**one at a time** may be open over the stage.

**Input panel tabs.** The input panel is tabbed: **Ingredients** (the
hypothetical-ingredient playground) | **Frequencies** (the pure-frequency
playground) | then **one tab per member inventory**, with **your own first**.
Each entry renders as an **item frame** in a grid, compactly showing name,
emitted frequencies, and type. Keep search and the frequency filter.

**Perfume book.** The right drawer keeps **all** existing features — search,
filters, status, recipe folds — but **decluttered**. It shows **which recipe**
satisfied a completed brew. Its recipe-fold ingredient pills are real item frames
obeying the drag grammar.

**Presence cursors.** Other members' cursors are shown **on the stage only**.
When a member's cursor leaves the stage it **freezes at its last position**
rather than vanishing.

**Settings corner.** A settings corner holds **mute** and **site instructions**.

**Brewing ceremony.** Brewing plays a **classy** completion animation with
**sound**. The mute toggle governs the sound.

---

## 7. Aesthetic policy

The **current tom.quest perfume look is final**: the dark-slate palette, the
Syne / IBM Plex typography, and the existing animation language all stay. The
arcane-linework restyle was reviewed and rejected. This is a **mechanical**
overhaul, not a visual one.

The only visual latitude: a **feel refresh for buttons and tabs** within the
current look — nothing else.

**Item art.** Ingredient and named-frequency artwork comes from Joe and now lives
locally under `public/perfume/ingredients/` (96 PNGs, keyed by ingredient). Items
render this art on their rounded square.

**Perfume art.** A perfume is a **generic bottle** silhouette **tinted by the
blend of its fundamental frequencies**. The **cauldron liquid** uses the **same
blend logic**, tinting to the current brew's fundamentals.

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
(96), `perfumes` (≥40). `emblems.json` is keyed by named-frequency id, each entry
an `{icon, d}`. Both are **synced artifacts** — never hand-edit them; regenerate
in Byobu and re-run the sync. The `.ts` wrappers in `app/perfume/{data,lib}` are
hand-written and only import the JSON. The sync never writes back into Byobu, and
Byobu's `ground-truth/**` is never touched by tom.quest.

---

## 9. Backend sketch

Convex tables (prefix `perfume`), one implementation of the engine imported from
`app/perfume/lib/engine` and used **server-side** to re-verify every brew — no
re-implementation, ever.

- **members** — one row per registered member: identity (account name, color,
  optional uploaded image icon), `lastSeen` for the activity indicator, and the
  admin flag (Tom). A logged-in user gets a row by clicking to join; self-removal
  deletes the row; Tom may delete any.

- **brews** — one row per brew: `owner` (member id, or `null` for the party
  brew), free-form `nickname`, per-owner `seq` (for "{owner} brew {n}"), the
  **items** in the graph (each real/hypothetical, with owner/contributor), the
  played **strikes** and **wilds**, the **pinned recipe**, and the **outputs**
  resting on the cauldron. Each output perfume carries provenance:
  **`brewedBy`** (who clicked brew), **`witnesses`** (everyone viewing at
  completion), and its ownership chain.

- **inventories** — per-member holdings. **Perfumes are instances**, each with
  **full provenance** (brewedBy + witnesses + the gift/ownership chain).
  **Ingredients are fungible stacks** (a count) carrying a **gift-event history**.

- **presence** — per-brew cursor rows (member, color, stage coordinates),
  driving both the stage cursors and the activity indicator; a cursor that leaves
  the stage freezes at its last position.

- **per-user undo log** — each member's own recent moves, replayable by that
  member only. Brewing, taking, and gifting are **not** written as undoable
  entries.

Identity, the "WHERE not WHAT" permission checks, and the conservation invariant
(no mutation creates or destroys items except inventory import (+) and brewing
(brew → k perfumes per the engine)) are enforced in the mutations, mirroring the
permissions matrix in section 4.
