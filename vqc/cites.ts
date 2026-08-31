// vqc/cites.ts — the one home for the cite resolution set (VQC C1).
//
// A `cites` field on a vqc/todos.yaml or vqc/ledger.yaml entry resolves to one
// of three things:
//
//   1. a constitution article id — `A<n>` (axiom), `C<n>` (ideal), `D<n>`
//      (doctrine);
//   2. `tts-spec:<section>` — a section of WikiTom `tts/spec.md`;
//   3. an open `vqc/ledger.yaml` entry id (checked by the caller, which is the
//      only side that has the ledger in hand).
//
// WHY THE ARTICLE NUMBERS ARE NOT ENUMERATED HERE. The article inventory is
// knowledge owned by ComplexMultiTrigger — the `ARTICLES` registry in
// `tests/guards/canon.py`, which `vqc/constitution.md` renders around. That
// repo is private and is not a dependency of this one, so a copy of the
// inventory here would be a second spelling that no check can hold to the
// first: it drifts silently every time the constitution is amended, and it
// already did — three files in this directory carried `D1-D28` after the
// constitution reached D31 (verified 2026-08-31 against the constitution
// itself). So this pattern deliberately accepts any article NUMBER and fences
// only the article-id SHAPE. A cite naming an article that does not exist is
// caught by a reader who can open the constitution, not by this regex.
export const ARTICLE_OR_SPEC = /^(A\d+|C\d+|D\d+|tts-spec:\d+(\.\d+)?)$/;
