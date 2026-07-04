# Perfumer's Bench — live/inventory rework (steps ②–⑤)

Authoritative spec for the multi-agent build. Read this fully before editing.
The domain rules live in the Byobu repo (`docs/SYSTEM.md`); the engine
(`lib/engine.ts`) already implements them (combination equivalence + k-multiple
matching). Nothing here may invent lore.

## Vocabulary (binding)
⊖ = **strike**, ⊕ = **wild** (never "summon"). The things brewed are
**perfumes** (never "bottles"); the action is **brew**. Panels: **input panel**
(left: inventory + catalog), **cauldron** (center), **perfume panel** (right).

## The model

Every user has a **bench**: brew (ingredient keys + strike/wild plays), a
3-section **inventory** (ingredients / pures / perfumes), an **output tray**
(perfumes brewed, not yet taken), shared UI state, and a profile (name, color).
Logged-in users are keyed by their Convex user id; anonymous visitors by a
generated `anon:<uuid>` kept in localStorage (their bench also lives in Convex —
the localStorage key is the fragile part; the UI warns about it). There is one
**party brew** everyone (incl. anonymous) shares.

**Permission rule — "WHERE, not WHAT":** visitors may change where the owner's
items are, never what they own. On any bench, ANYONE may: move the owner's
items inventory↔brew (both directions), play/un-play strikes and wilds, and
edit shared browse UI. OWNER-ONLY: complete brew, take output, import,
transfer. Party pot: anyone moves their OWN items in (contributor recorded);
anyone may move any item out (it returns to its contributor); anyone brews and
takes (taker's inventory); wholesale clear = Tom only (users.role === "tom").

**Multiples:** a tally equal to k× a tuning brews k copies (engine handles it;
`evaluate(...).k`). Brewing consumes the whole pot and credits k perfumes to
the output tray. If several perfumes match, the brewer picks which to brew.

## Interaction grammar (binding)

**The hand** (cursor stack, one item type at a time):
- **Left-click** an item: pick up 1. Repeat clicks on the same stack: +1 each
  (capped at what's available). Clicking a DIFFERENT item: current stack goes
  home, pick up 1 of the new.
- The held stack renders at the cursor (icon + ×n badge). It obeys the
  **boundary rule**: while the cursor is inside the cauldron panel
  (`[data-cauldron-drop]`), the held items ARE in the brew — commit on entry
  (splines connect to the hand), un-commit on leave. Only boundary crossings
  and settles mutate state; the hand itself is ephemeral client state.
- **Left-click inside the cauldron** while holding: settle the stack into arc
  slots (spring animation), hand empties.
- **Left-click anywhere else / Escape**: whole stack returns home.
- **Right-click while holding**: return 1 to origin.
- **Right-click, empty hand**, on anything in the brew (arc node, or an
  in-brew row): remove 1 back to inventory. Left = add, right = decrease,
  universally. (preventDefault on contextmenu for these elements.)
- **Shift-click**: teleport 1 unit per click to its unambiguous destination —
  input item → brew; in-brew item → inventory; output perfume → inventory (on
  a user tab: that user's; on the party tab: the clicker's).
- **Drag** (press-move-release): a 1-unit hand with the button held; same
  boundary rule; release inside cauldron settles, outside returns home.
- Click on an arc ingredient with empty hand picks it up FROM the brew
  (hand.from="brew"); carrying it out of the cauldron un-commits it.
- Output-tray perfumes on a personal bench: owner-only (non-owners get a
  disabled hint). On the party tab: open to all.

**Hover** affects ONLY the brew bar (never the cauldron graph): hovering a
catalog/inventory row previews the tally delta as ~40%-opacity ghost chips and
a "would brew X ×k" / "would break X" hint. Hover previews are local (not
broadcast).

## The cauldron panel

- Arcs stay the primary surface (ingredient arc, frequency arc, derived arc,
  charge chips, existing strike drag/arm + wild picker — rename any leftover
  "summon" strings to wild).
- **Output shelf**: brewed perfumes appear ON the stage above the pot as phial
  chips (simple phial SVG + perfume name + ×n), takeable per the grammar.
- **Brew bar** (replaces the old ingredient-chip tray at the bottom):
  read-only display of the frequency math — effective tally as glyph chips,
  then `=` and every perfume the tally exactly brews: `Name ×k [Brew]`.
  Multiple matches = multiple options, brewer picks. The Brew button is the
  bar's ONLY interactive element: enabled iff exact match AND every pot item
  is real AND caller may brew here; disabled state names the blockers (e.g.
  "2× Noble Roses are hypothetical"). Hover ghosts render here.
- In-brew items contributed beyond stock are **hypothetical**: marked visibly
  (dashed ring + contributor name), block brewing.

## The input panel

Top: **inventory**, three auto-growing sections — ingredients, pure
frequencies (incl. Pure Strike/Wild — castable spells, so ownable), perfumes.
Slots = icon + count badge; same hand grammar; slot for an ingredient with
copies in the brew shows the icon ghosted (~35% opacity) — "you took the icon".
Header actions: **Import** (dialog: textarea → tolerant parse via
`lib/inventory.ts` → preview rows with accept/correct-guess dropdowns; unknown
names rejected visibly; buttons "Add to inventory" / "Replace inventory"),
**Copy** (clipboard export, same format), and per-slot **Send** (transfer to a
chosen party member; owner-only). Anonymous users see the persistence warning
here. Below: the **catalog** (all 96 + pures) as rows — ghosted icon when in
brew, count badge, NO −/+ steppers (the hand replaced them), same grammar.
Row click = pick up (hand), NOT the old add/remove-all toggle.

**Filters**: multi-select. The square button grows into a rectangle of
selected frequency chips side by side; click "all frequencies" clears; the
input-panel variant also lists the 3 ingredient types alongside. Semantics:
selected frequencies AND (ingredient must emit all; perfume must have some
tuning containing all); types OR among themselves, AND with frequencies.

## The perfume panel

Output tray is NOT here (it's on the cauldron). Cards keep: name, weight,
effect line (always visible), requirement / brew-progress line (k-aware),
recipes fold. **Ingredient pills in the folds are real ingredient objects**:
same hand/drag/shift-click grammar, same ghosting. Multi-select frequency
filter as above.

## Live layer

- **Tabs** across the top: `Party` first, then every logged-in user who has a
  bench (name + their color). Your own tab marked. Anonymous users can watch
  anyone but have no tab. A color picker sits by your tab (updates profile).
- **Spectating** = rendering the selected bench's doc through the same
  components. Shared-writable: brew moves, strikes/wilds, browse UI (search,
  filters, input tab, expanded cards — last-write-wins, ~200ms debounce).
  Owner-only: brew completion, output, import/transfer, pins. Scroll and
  panel widths stay local.
- **Cursors, always on**: everyone viewing a bench sees everyone else's
  cursor (name + color) and any held stack, via presence rows throttled to
  ~20Hz, expiring after 10s. Coordinates are content-space per surface:
  `{surface: "input"|"stage"|"book", x: 0..1 of content width, y: px from
  content top / 1000}` — stage uses its 0-100 percent space. Off-viewport
  activity shows a small edge indicator.
- **Party tab**: pot + output shelf + perfume panel evaluation are shared;
  the input panel shows YOUR OWN inventory; browse state is local. Pot items
  carry `{ingredient, contributorKey, real}`; removals return to the
  contributor. Charges pool. Clear-pot = Tom only.

## Local mode (testing + resilience)

`?local=1` runs the page with `LocalBenchStore` (in-memory + localStorage;
no Convex, no tabs/presence). Playwright uses this for all single-user
interaction specs so tests never touch shared data. Two-context live-sync
specs run only when `E2E_CONVEX=1` (skipped by default).

## Backend (convex/perfume.ts + schema)

Tables (prefix `perfume`): 
- `perfumeBenches`: ownerKey (string: `user:<id>` | `anon:<uuid>`), ownerName,
  color, brewKeys: string[], strikePlays, wildPlays, inventory {ingredients,
  pures, perfumes}: Record<string,number>, outputTray: Record<string,number>,
  ui (SharedUI), updatedAt. Index by_owner(ownerKey).
- `perfumePartyBrew`: singleton — items: {ingredient: string (catalog key),
  contributorKey, contributorName, real: boolean}[], strikePlays, wildPlays,
  outputTray, updatedAt.
- `perfumePresence`: benchKey (ownerKey|"party"), clientId, name, color,
  surface, x, y, hand?: {key, count}, updatedAt. Index by_bench(benchKey).
- `perfumeEvents`: benchKey, actorKey, actorName, action, detail (any), at.
  Index by_bench_at(benchKey, at).

Identity in functions: `viewerDoc(ctx)` (see convex/authRoles.ts) for
logged-in; otherwise the mutation's `anonId` arg (validated `anon:<uuid>`
shape). callerKey = `user:<id>` | anonId. Tom check: user.role === "tom".

Mutations (each logs to perfumeEvents; each validates per WHERE-not-WHAT):
ensureBench, setProfile, updateUI (whitelisted fields; pins owner-only),
moveToBrew(benchKey, itemKey, n) / moveToInventory (anyone; owner's items;
hypothetical marking when stock runs out), playStrike/unplayStrike/playWild/
unplayWild (anyone), brewPerfume(benchKey, perfumeKey, tuningIndex, k)
(owner-only on benches; re-verifies with the shared engine server-side;
requires all-real; consumes pot, credits outputTray), takeOutput(benchKey,
perfumeKey, n) (owner-only on benches), importInventory(rows, mode)
(owner-only), transfer(toOwnerKey, itemKey, n) (owner-only, transactional),
partyMove*/partyBrew/partyTake (open; contributor tracking; taker's inventory),
partyClear (Tom), presenceUpdate, listBenches (query: party + user benches
with names/colors), getBench, getParty, presenceList(benchKey).

The engine is imported from `../app/perfume/lib/engine` (Convex bundles
relative imports outside convex/). Server-side brew verification MUST use it —
no re-implementation. Conservation invariant: no mutation creates/destroys
items except import (+) and brewPerfume (pot→k perfumes per the engine).

## Testing

- Vitest: lib units (parser, brewable, inventory ops) + convex-test suite for
  the permission matrix (P1–P4) and conservation (I1–I5) — see the invariant
  list in the repo history; name tests with their invariant ids.
- Playwright (`e2e/perfume.spec.ts`, local mode): U1 boundary-commit drag
  (connect before release; out-before-release = unchanged), U2 no native img
  drag, U3 in-brew ghosting, U4 hover touches only the brew bar, U5 the hand
  grammar (click stack, right-click return, shift-click, Esc), U6 brew flow
  (hypothetical blocks with reason; brewing spawns phials; take to inventory),
  U9 import dialog (typo → guess → accept). U7/U8 (two-context sync, party)
  behind E2E_CONVEX=1.

## Ground rules for agents

- Working dir: `C:/Users/heffn/AppData/Local/Temp/tomquest-fresh`. pnpm is
  installed — NEVER run `pnpm install`. Never `git commit/push`. Shell is Git
  Bash on Windows.
- Own only your assigned files. Shared types live in `lib/bench-types.ts` and
  `lib/types.ts` — read-only unless the integrator. `perfume-client.tsx` is
  the integrator's alone.
- Verify with: `pnpm vitest run app/perfume convex/perfume.test.ts`,
  `pnpm exec eslint app/perfume convex --max-warnings 0`,
  `pnpm exec tsc --noEmit` (ignore pre-existing failures outside your files).
- Match the codebase's comment style: constraints, not narration. No lore
  invention; when a UX detail is genuinely unspecified, choose the simplest
  option consistent with this spec and note it in your final report.
