# Build spec — "Three Feifs" Perfume Brewing Bench

> **Addendum (2026-07):** the 19 invented recipes this brief describes have been
> replaced by the real **d40 common-recipes table** (41 perfumes; roll 16 is both
> Bright and Frenzy). Recipes are now frequency-defined and may carry several
> valid **tunings** (`reqs[]`) with the common ingredient combos in `combos[]`
> and `slots[]` — see `build_data.py` and `docs/SYSTEM.md` §6. The matching rule
> below still applies, evaluated against each tuning.

You are designing and building a single-page web app: an interactive **perfume
brewing bench** for a fantasy magic system. Treat this as a real design
engagement. **Read and follow `/mnt/skills/public/frontend-design/SKILL.md`
exactly** (brainstorm a token system, critique it against the brief, then build).

## The world (ground your design in this)

Perfumers craft magical perfumes by combining **ingredients**. Every ingredient
emits one or more **magical frequencies**. A **recipe** (a perfume) is satisfied
when the frequencies in your brew exactly match the frequencies the recipe calls
for. There are two layers of frequency:

- **Fundamental frequencies** — 9 tones written as D&D school-of-magic letters:
  `A` Abjuration, `C` Conjuration, `D` Divination, `En` Enchantment,
  `Ev` Evocation, `I` Illusion, `N` Necromancy, `T` Transmutation, and a rare
  ninth `E`. Each has its own color (in the data).
- **Named frequencies** — 17 richer tones, each with an emblem (flame, sparkle,
  moon, crystal, skull, bell, lizard, birdcage, lotus, potion, meteor, dagger,
  mirror, lantern, lightning bolt, scroll, ringed planet). Each named frequency
  **decomposes** into a multiset of simpler frequencies (a directed graph). Four
  of them — Laternical, Malvesian, Thurmistic, Saspacian — are **summon-only**:
  no ingredient emits them directly.

Some ingredients carry **wildcard markers** instead of (or beside) frequencies:
- **Minus (⊖)** — lets the brewer *remove* one frequency of their choice from the
  brew (e.g. Shadow Demon Liver has 2, Ennerx Core has 3, Sheensacks has 1).
- **Plus (⊕)** — lets the brewer *add* one frequency of their choice (only
  Southollow Royal Tulip, ×1). This is the **only** way to manifest a summon-only
  frequency.

Visual heritage to draw from (read these images — do not copy them, evolve them):
- `reference/guide_aesthetic.png`, `reference/guide_aesthetic2.png` — the Magical
  Frequency Guide: periwinkle ground, deep-indigo shield crests with botanical
  laurel line-art, a serif display face, pill-shaped "barcode" badges of tokens.
- `reference/ingredients_aesthetic.png` — the Ingredients Table: warm parchment
  ground, per-ingredient colored crest outlines, the same pill badges.
- `reference/frequency_card.png` — one frequency card up close.

The aesthetic target is a **perfumer's / alchemist's workbench** that fuses the
indigo-occult Guide with the parchment apothecary. Make it feel like a real
instrument, not a dashboard. Spend your boldness on one signature element (e.g.
the brewing vessel and how frequencies materialize in it).

## Data

All content is in `app/data.json` (read it). **Embed it inline** in the final
HTML (as a `const DATA = {...}` script) so the file works by double-click with no
server. Schema:

- `fundamentals[]`: `{id, school, color}`
- `named[]`: `{id, icon, components[], expanded{}, weight}` — `components` is the
  decomposition; `expanded` is the full fundamental tally; `weight` = total
  fundamentals.
- `ingredients[]`: `{name, page, color, emits[], minus, plus}` — `emits` is the
  multiset of frequency ids it contributes (ids are fundamental letters or named
  ids); `minus`/`plus` are wildcard counts.
- `recipes[]`: `{id, name, school, desc, req[], example[], trim, wildAdd}`
  — `req` is the required frequency multiset; `example` is one valid ingredient
  set.

## What the page must do (functionality is required, not optional)

1. **Ingredient library** — browse and search all 96 ingredients. Each shows its
   name and the frequency tokens it emits (render fundamentals as colored letter
   chips, named frequencies with their emblem + name; show ⊖/⊕ markers). Clicking
   an ingredient adds it to the brew. Allow adding the same ingredient multiple
   times. A search box and a filter (e.g. by page/family or "has marker") help.

2. **The brew vessel** — shows the ingredients currently added (each removable,
   with a count if added more than once) and, prominently, the **resulting
   frequency tally**: the multiset sum of all emitted tokens. Also show the total
   **⊖ removals** and **⊕ additions** currently available from markers.

3. **Wildcard control** — the brewer can spend an available ⊖ to remove a chosen
   token from the tally, and an available ⊕ to add a chosen token. (A clean way:
   when a recipe is *almost* matched, offer "apply ⊖ to drop X" / "apply ⊕ to add
   Y" suggestions. At minimum, let the user manually pick.)

4. **Recipe matching** — a recipe book of all 19 perfumes (name, school, tier,
   required tokens, flavor text). Continuously evaluate the current brew against
   every recipe and surface matches. Matching rule (implement EXACTLY):

   ```
   Let B = multiset of brew tokens (sum of all emits).
   Let M = total minus markers, P = total plus markers in the brew.
   For recipe R:
     excess  = B - R   (tokens you have too many of)   -> must be removed
     missing = R - B   (tokens the recipe still needs)  -> must be added
     PERFECT  if B == R exactly.
     CRAFTABLE if sum(excess) <= M AND sum(missing) <= P.
     Otherwise show how far off (the excess and missing token lists).
   ```
   When a recipe is PERFECT or CRAFTABLE, celebrate it (this is the payoff
   moment — a perfume is bottled). Show, for craftable, which wildcards get spent.

5. **The frequency graph** — somewhere the user can explore how named frequencies
   are built from others (the decomposition DAG). A tooltip/expandable panel
   showing a named frequency's `components` (and ideally letting you drill down to
   fundamentals) satisfies this. A small visual graph is a plus, not required.

Provide a few **starter/sample brews** or a "load example" on each recipe (use
`recipe.example`) so the payoff is immediately discoverable.

## Deliverable

- A single self-contained `app/index.html` (inline CSS + JS + embedded DATA).
  No external network dependencies except web fonts (Google Fonts is fine).
- Must work opening the file directly in a browser.
- Quality floor: responsive to mobile, visible keyboard focus, `prefers-reduced-
  motion` respected.
- **Self-verify before finishing**: Chromium is available. Drive the page with
  Playwright (already configured; launch with channel/executable at
  `/opt/pw-browsers/chromium` if needed). Verify these cases and screenshot:
  - Empty brew shows no false matches.
  - Adding **Aphasia Flower + Noble Roses** marks **Potion of Healing** as
    PERFECT (tokens become En, Crallax, A, A).
  - Adding **Oracite** alone marks **Tincture of True Sight** PERFECT (D,D,D).
  - A recipe needing a summon-only frequency (e.g. **Cosmic Saspacian No. 5**)
    becomes CRAFTABLE only when **Southollow Royal Tulip** (⊕) is in the brew.
  Save screenshots into `app/reference/` (e.g. `screenshot_brew.png`).

Return a short note on your design choices (palette, type, signature element) and
the verification results.
