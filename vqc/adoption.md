# vqc/adoption.md — tom.quest's VQC adoption clause

tom.quest adopts VQC (the constitution at
`ComplexMultiTrigger/vqc/constitution.md`; Tom's ruling 2026-08-27: apply it,
ignore CMT-specific articles). Adoption follows the constitution's own
**ratchet-adoption** rule: gates land for new instances, pre-existing
violators are dated ledger debt — never a silent cutoff or frozen exemption.
This file is the binding: what applies, where the statutes live, what runs
when. Where an artifact required by a binding doctrine does not exist yet, it
is carried as an explicit `vqc/ledger.yaml` entry, not omitted.

## Boot surface

`AGENTS.md` at repo root (`CLAUDE.md` is a one-line import of it — one home).
It is not yet D13-shaped (size budget, generated factual blocks): ledger
`agents-md-not-boot-shaped`.

## applies_when evaluation

| Article | Condition | Here |
|---|---|---|
| D15 numbers-as-data | produces empirical results | **off** (product, not instrument) |
| D16 claim-fidelity | implements published methods | **off** |
| D17 hypothesis-neutral-instrument | is a findings instrument | **off** |
| D22 sanctioned-identity-change | durable identity-keyed artifacts | **off until** the repo ships content-addressed/hash-keyed durable records |
| Everything else (A1–A3, C1–C9, remaining D-articles) | always / any-codebase-with-agents | **on** |

## Statute locations

| Statute | Home |
|---|---|
| Todos (choice: decided intent) | `vqc/todos.yaml` — TTS vocabulary (readiness/status axes) is this repo's ratified re-expression of D28's tiers; closure = status + resolution in the same commit as the work; ids never reused |
| Ledger (knowledge: discovered gaps) | `vqc/ledger.yaml` — open entries only; graduation deletes the entry in the work's commit |
| Steering (corrections) | `vqc/steering.yaml` |
| File classification (C9) | `vqc/classification.yaml` (enforcement: ledger `classification-unenforced`) |
| Cite resolution set | constitution article ids (`A*`, `C1`–`C9`, `D1`–`D28`), `tts-spec:<section>` (sections of WikiTom `tts/spec.md`), and open ledger entry ids — enforced by `vqc/todos.test.ts` |
| Registries (C7) | `app/components/page-routes.ts` (pages); Convex schema (`convex/schema.ts`) |
| Contract fences | `scripts/check-auth-boundary.mjs`, `scripts/check-heavy-libs.mjs` |
| Layer DAG (D5) | none yet — ledger `no-layer-dag` |
| Rulings log | below, this file, append-only |
| Scratch roots (D26) | `tts/` (declared in classification.yaml) |
| Witness faults (D8) | none yet — ledger `no-witness-fault-harness`; interim: `witness:` comments in guard tests |
| Worker box definition | `worker/setup.sh` — the box owns no durable state; a rebuild from this script IS the box |
| Secrets flow | `secrets/convex.env` → `npx convex env set` (Vercel half broken: ledger `secrets-sync-vercel-drift`); per-family keys, never shared |
| Session-surface design | WikiTom `tts/spec.md` §20 — code comments point at it (graduated 2026-08-29) |
| TTS spec prose (vocabulary, contracts) | WikiTom `tts/spec.md` — agent-facing renderings (e.g. app/lib/tts-session-prompt.ts preamble) summarize it, never redefine it |

## Cadences

| Mechanism | Cadence |
|---|---|
| `npx tsc --noEmit` (type rung) | commit (CI `tests` job) |
| `pnpm test:turing` (vitest: convex + vqc guards) | commit (CI `tests` job) |
| `pnpm check:guardrails` (contract fences) | commit (CI `static-boundaries` job) |
| gitleaks | commit (CI `secret-scan` job) |
| Playwright e2e | on demand / pre-deploy (not in CI — pre-existing) |

## Rulings log (append-only: id, date, question, ruling, cites)

- id: tiers-renamed-two-axes
  date: 2026-08-27
  question: How do D28's R/C/H tiers map into this repo?
  ruling: Split into readiness (unprepared/preparing/ready-for-tom) × status
    (active/waiting/archived/done) per the TTS spec; this file is the
    reference implementation CMT will migrate to.
  cites: [D28, tts-spec:5]
- id: closure-by-status
  date: 2026-08-27
  question: Closed-todos banner (CMT style) or status field?
  ruling: Closure = status done/archived + resolution, entry kept in place,
    same commit as the work; ids never reused. Faithful to D28's archive
    requirement without the banner mechanics.
  cites: [D28]
- id: tts-shared-time-edge
  date: 2026-08-27
  question: May app/ and worker/ import from convex/ttsShared.ts?
  ruling: Yes — it is the one home for TTS time/link math (C1 outranks a
    layering aesthetic); recorded pending a real layer DAG.
  cites: [C1, D5]
- id: digest-env-missing-is-quiet
  date: 2026-08-27
  question: Does the digest's log-and-return on missing Slack env violate
    fail-loud (C3)?
  ruling: Sanctioned — the sends-even-when-empty design makes the ABSENT
    digest itself the loud failure signal; throwing inside a cron adds no
    louder channel. Scope: convex/ttsSync.ts sendDigest only.
  cites: [C3, tts-spec:7]
- id: agent-created-todos
  date: 2026-08-29
  question: Must todo creation wait for Tom's ruling (todo = Tom's choice)?
  ruling: No — any agent may create vqc/todos.yaml entries freely and is
    encouraged to whenever it finds an issue worth working. A todo still
    records decided intent (not a stray fact — those stay in the ledger),
    but the deciding agent may be the one who found it. Tom's gates sit at
    plans (ready-for-tom) and persistence, not at creation.
  cites: [D28, tts-spec:5]
- id: session-permission-posture
  date: 2026-08-29
  question: Keep the indefinite-park permission model for the session surface?
  ruling: No — replace prompt-parking with classifier-driven auto mode - a
    classifier rules each gated tool call instead of interrupting Tom. Any
    residual permission card must be small and unobtrusive, never crowd the
    transcript, span the full window width, and approve on Enter.
  cites: [tts-spec:15]
- id: session-surface-rendering
  date: 2026-08-29
  question: What does Tom want rendered in a session transcript?
  ruling: All natural language from the agent — assistant text AND thinking —
    rendered in full by default. Tool calls visible but compact by default
    (one line, expand on demand). The page uses the full window width.
  cites: [tts-spec:12]
- id: tts-rename
  date: 2026-08-29
  question: Is the rename from the old "D" name to TTS (Toms Todo System)
    real, and how far does it reach?
  ruling: Real ("fix it everywhere"). Renamed 1:1 across code, routes (the
    old path redirects to /tts), env vars (TTS_WORKER_KEY,
    SLACK_TTS_CHANNEL_ID), the WikiTom spec directory (tts/spec.md; the old
    directory keeps a pointer), vqc registry ids, and the cite scheme
    (tts-spec:N). The ONE exception, the eight populated Convex tables
    (dtsTodos and siblings), keeps the frozen historical prefix — prod
    schema is additive-only and a data migration buys no behavior.
    Documented at the table block in convex/schema.ts.
  cites: [C1, C6]
