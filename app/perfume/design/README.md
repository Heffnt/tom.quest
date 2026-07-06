# Perfume design heritage

Design-heritage reference for the `/perfume` page. This material originally lived
in the **Byobu** repo, on the retired standalone perfumer's bench. It was moved
here because presentation concerns belong to **tom.quest** — Byobu is now a pure
data pipeline (Joe's ground-truth PDFs → transcription/compile → data artifacts)
and emits data only.

- `legacy/` — the retired standalone bench: its `index.html`, `README.md`, and
  `SPEC.md`. Kept as-is for provenance and design intent.
- `reference/` — aesthetic guides and screenshots (PNGs) that informed the current
  bench's look and feel.

This folder is reference-only. It has no `page.tsx` and no `.ts`/`.tsx` files, so
Next.js does not treat it as a route or attempt to compile it.
