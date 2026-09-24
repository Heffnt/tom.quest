# vqc/pages.md — how a Jarvis page on tom.Quest is built

Tom (2026-09-24): "I want to design a toolbox of components that agents can use
to build any page that I need. there should be strict rules around how pages can
be designed so that it is impossible for agents to build a tom.quest page that I
don't find visually appealing. this should be built in vqc."

The toolbox is `app/components/toolbox/`; `/toolbox` renders every component
once with live data. `scripts/check-toolbox-pages.mjs` (in `pnpm
check:guardrails`) holds each page listed in its `TOOLBOX_PAGES` to principles
6, 7 and 9, and the toolbox itself to principle 7; the caps and the captions are
held in the components' code and types, and tested beside them.

## The ten principles

1. A page opens with the whole. The first thing on any page is one sentence of state with its counts, and, where the page holds a set larger than one screen, one figure that shows the whole set as area sized by count. The figure is the way in; lists come after it.
2. No list longer than a screen. A set is shown as a figure or as counted groups. A component that lists members shows at most ten and ends with "and N more" that opens a drawer, which itself shows at most ten at a time. No page renders every row.
3. One action at a time. Anything Tom rules on is shown one at a time, whole: statement, where it came from, its brief, its first step, then the verdict buttons. Every button names the backend call it fires.
4. Every number comes from a named query. Each figure, count and table carries a one-line mono caption naming the query it draws from.
5. The page shows, chat explains. No text on a page explains what a section is or how to use it. Headings name things, sentences state facts, no evaluative word appears.
6. Tom's words and the code's words. Pages say agent, never run; environment does not appear; a raw field name never appears; a todo statement is shown exactly as written.
7. One palette, one scale. Colors are the twelve tokens and nothing else. One type scale of five sizes, none under 13 px, IBM Plex Sans for everything and IBM Plex Mono only for numbers, ids and code. No gradient, no shadow, no arbitrary pixel size in a page file.
8. Nothing moves under you. No hover or click shifts layout, no auto-scroll, drawers and dialogs are fixed, and the page reads at phone width and laptop width with no sideways scroll.
9. A page is a composition, not a construction. A Jarvis page file imports only toolbox components and queries. It defines no component, no style and no color of its own. A page that needs a new kind of piece adds it to the toolbox first, with its rule.
10. Private stays private. No component that names calendar rows takes a private feed's rows as input.

## The components

| Component | What it is | Principles |
|---|---|---|
| `Page` | the frame: under the real header, 24 px gutter, at most 1280 px wide | 7, 8 |
| `Columns` | a main column and a 380 px side column at 1340 px and wider, stacked below that | 8, 9 |
| `PageHead` | the page's name and its one sentence of state, with a caption | 1, 4 |
| `Num` | a number inside a sentence, in mono | 7 |
| `AreaFigure` | the whole set as a squarified treemap, one or two levels, labels 13 px | 1, 4, 7 |
| `TimeFigure` | counts per time bin per lane, as bars | 1, 2, 4 |
| `FigureStrip` | at most six figures, each a number and its name | 4 |
| `GroupDrawer` | one group's members, ten at a time, ending "and N more" | 2, 4, 8 |
| `ItemPanel` | one thing to rule on: statement, where it came from, brief, first step, verdicts | 3, 6 |
| `ActionRow` | at most five actions, each naming its call in the one info popover | 3 |
| `FactTable` | at most ten rows, the next ten folded, then "and N more" | 2, 4, 7 |
| `Fold` | a closed disclosure holding what does not fit in ten | 2 |
| `Prose` | sentences of fact with numbers in them, with a caption | 4, 5 |
| `QueryCaption` | the one mono line naming a query | 4 |
| `Term` | a vocabulary word that opens its definition in a fixed drawer | 6 |

## Rulings (append-only: id, date, question, ruling, cites)

- id: one-font-family
  date: 2026-09-24
  question: Which fonts does a Jarvis page use?
  ruling: One family, IBM Plex Sans throughout, semibold for headings; IBM Plex
    Mono only for numbers, ids and code. Syne is not used on a Jarvis page.
  cites: []
