# TTS Implementation Plan

**Status:** **RATIFIED by Tom, 2026-08-27.** Phase 0 underway.
**Spec:** WikiTom `tts/spec.md` (canonical home per Tom's ruling — the spec is private to humans; this public repo holds code and engineering docs only, and life-todo *data* lives in Convex, never in git). This plan says *how and in what order* the spec gets built; where they conflict, the spec wins.
**Builder:** Claude Code (this session and successors), orchestrating subagents and workflows per phase.

---

## Phase 0 — prerequisites (with Tom, ~30–45 minutes total, can be piecemeal)

| # | What | Who | Notes |
|---|---|---|---|
| 0.1 | Slack app in the dedicated TTS workspace | **DONE** (2026-08-27; capture channel named `#dump`, not `#inbox`; token needs one re-copy — rotated on install) | One app, one bot token with read + post permissions, invited to `#dump` (capture) and `#tts` (digest/events). A webhook alone cannot read messages; the bot is the mechanism. Token goes into the `pnpm secrets:sync` flow. |
| 0.2 | Jarvis Box | Tom purchases; Claude authors setup | Hetzner CAX11 (~€4/mo), Ubuntu LTS, Tom drops Claude's SSH key. Setup is one idempotent script; the Jarvis Box owns no state (spec §16). Decide which Max account it runs headless Claude Code under. |
| 0.3 | GitHub token for the mirror | Tom | Fine-grained, read-only, scoped to ComplexMultiTrigger + tom.quest (+ WikiTom later for the triage profile). Goes into Convex env via secrets flow. |
| 0.4 | Spec-home ruling | ~~Tom~~ **DONE** | Ruled: spec lives in WikiTom (`tts/spec.md`, committed 45386636); this public repo holds code + engineering docs only. |

## Phase 1 — MVP build

Built on a branch; nothing merges or deploys before the persist-tom-gate. Orchestrated as a workflow: independent streams fan out to parallel subagents (isolated worktrees where they touch code), then an integration pass, adversarial review, and the gate.

**Stream A — backend (Convex).** Schema additions (all-new tables, so no migration risk): `dtsTodos` (full data model, spec §5 — statement, readiness tier, status, timing class + data, wake condition, source, provenance, work description, body, timestamps), `dtsEvents` (instrumentation, spec §10 — every surfacing/engagement/session/date-outcome, recorded from the first hour), `dtsDailyQueues` (the 5 a.m. queue per day), `dtsCodeTodoMirror` (read-only VQC mirror rows). A `convex/tts.ts` module with Tom-gated queries/mutations (forge-pattern `requireTomId`), tests included in the CI-run script. Crons: mirror refresh a few times daily; a 4:45 a.m. fallback queue prep. **The 5 a.m. digest cron was built and is now switched off** — Tom ruled on 2026-08-29 that outbound Slack is off (Slack is inbound `#dump` capture only) until the messaging shape is redesigned, so `convex/crons.ts` leaves the two digest cron lines unregistered and `convex/ttsSync.ts` sets `OUTBOUND_SLACK_ENABLED = false`, which makes `sendDigest` return before it composes anything. The lines to re-add are written out in the comment where they used to sit. What does run on a schedule and speaks outward is the hourly update (Tom, 2026-08-30), registered as a plain interval and gated by its own separate switch (`HOURLY_UPDATE_ENABLED`, also false today) so re-enabling it does not re-enable the digest. A key-authed HTTP endpoint (copy of the `/pool` pattern) for the Jarvis Box to submit captures and prepared content.

**Stream B — Inventory page.** Registered `visibility: "tom"`; shows everything always: active, waiting (with wake conditions), the archive, mirrored code todos, ages and counts, descriptively.

**Stream C — Focus page.** Serves the daily queue; one task at a time with its brief and entry action; cycle-to-next (wraps; an exhausted queue offers pull-from-Inventory); every interaction recorded to `dtsEvents`.

**Stream D — safe action links.** Any link in Slack opens a confirm page; state changes only on the confirmed POST, with single-use tokens — because Slack's link-preview robot fetches URLs (spec §7). Day-one requirement.

**Stream E — the Jarvis Box.** The setup script, plus two scheduled jobs: (1) 4:45 a.m. — headless Claude prepares the daily queue and digest text and posts them to Convex; (2) every few minutes — poll `#dump`, submit new messages as `unprepared` items. **Reliability split (as designed, and what is left of it).** The design was: the *Convex cron* always sends the 5 a.m. digest with whatever was prepared, and if the worker's prep never arrived the digest says so in-band — so a missing digest means Convex/Slack breakage, a digest reporting missing prep means worker breakage, and the sends-even-when-empty rule diagnoses which half failed with zero monitoring infrastructure. **Since Tom's 2026-08-29 ruling that turned outbound Slack off, nothing sends the 5 a.m. digest**, so the split no longer reports anything: the daily message that was the signal is gone, and neither failure announces itself in Slack. What survives is the shape it forced on the code, which is why the code still looks this way — Convex owns the schedule and the send, the worker only *supplies* prepared content, and the two halves stay separable, so restoring the signal is re-adding two cron lines and flipping `OUTBOUND_SLACK_ENABLED` rather than rebuilding the arrangement. Until then, breakage in either half is found by looking (Inventory shows whether prep landed), not by being told.

**Stream F — VQC into tom.quest.** Add `vqc/todos.yaml` to this repo, seeded with the six ratified post-MVP features (in Tom's priority order) as its first entries, plus a light guard test (TypeScript port of the shape checks) wired into CI. The mirror parses both CMT's and tom.quest's files from their default branches.

**Gate:** integration pass → `/code-review` + fixes → ground-up change report → **persist-tom-gate** (an interactive session; Tom shapes, then rules) → merge to `main` (which deploys site + Convex together).

**Verification before the gate:** Convex tests + typecheck + the page-visibility e2e; live smoke test end-to-end — a message in `#dump` becomes an Inventory item, the digest lands in `#tts`, a queue cycle records events, an action link round-trips safely.

## Phase 2 — week 1 operations (the great consolidation)

- **Days 1–2:** Tom brain-dumps into `#dump` whenever thoughts occur. Claude runs the one-time consolidation sweep — CMT's VQC todos plus, once, the dead sources (WikiTom `todo/` dirs, stale lists) — with agent-triage: obvious corpses to the viewable discard list, plausibly-live items entered as candidates, batched across the first Friday sessions rather than dumped at once.
- **Days 3–6:** living with it lightly — capture, digest, honest recording. Baseline data is the deliverable.
- **First Friday session:** triage the consolidated inventory — keep-active / timing class (dates set together, against Tom's real schedule) / wake condition / archive-with-dignity. Run as an ordinary Claude Code session from materials Claude prepares.
- **Success bar (kill-criteria seed, spec §17):** thoughts captured that would otherwise be lost; digest arrived daily with zero maintenance; the first session produced real rulings.

## Phase 3+ — TTS builds TTS

Every remaining feature is already a `vqc/todos.yaml` entry and flows through TTS's own pipeline: preparation → plan-tom-gate → execution → persist-tom-gate → change report. Ratified order:

1. **Email + Canvas ingestion** (first step: the 5-minute WPI tenant consent probe, which decides the Outlook mechanism)
2. **Weekly reflective session** as a built feature (prepared materials + reflective agent, spec §11)
3. **Preparation swarm + Codex CLI adversarial review** (spec §15)
4. **Event messages as two-way Slack conversations** backed by Claude Code sessions (spec §7)
5. **Values file** (authored by Tom, never fictionalized)
6. **Session sweep** — triage of open tasks from Claude Code sessions (local + Turing; cloud deferred)

Each phase carries kill criteria; a feature that fails its earning-its-keep test is deleted, not left as a corpse.

## Decisions Tom is being asked for at this gate

| Decision | Recommendation |
|---|---|
| Ratify this plan (shape, streams, order) | — |
| Spec home, given the repo is public | Code, this plan, and `vqc/todos.yaml` live here (engineering content, fine public; actual life-todo *data* is in Convex, never in the repo). The **full spec** with the mental-health register lives in WikiTom (private), pointed to from here. Alternatives: make the repo private, or say public-spec is fine. |
| Which Max account the Jarvis Box uses | Whichever has more headroom; can switch later. |
| When to schedule Phase 0 with you | Soonest 30 minutes you have; nothing else blocks on design. |
