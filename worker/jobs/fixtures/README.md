# worker/jobs/fixtures

Two copies of WikiTom files, here so the learning tests can run the real gate
without a WikiTom checkout on the machine.

- `check-evidence.mjs` — a byte copy of WikiTom `scripts/check-evidence.mjs`.
  The nightly learning step runs the CHECKOUT's copy (`runEvidenceCheck`), never
  this one; this one exists so the integration tests can build a WikiTom-shaped
  tree and run the same script over it. **When the WikiTom script changes, copy
  it here in the same round.** `learning-records.test.mjs` asserts the two are
  byte-identical whenever `TTS_WIKITOM_CHECKOUT` names a checkout that has it,
  so the drift is caught on any machine that has both.
- `evidence-ground.md` — a copy of WikiTom `model-of-tom/evidence/ground.md`,
  read by the `parseEvidenceEntries` round-trip test. It is primary material for
  the parser: every entry form Tom's record actually uses is in it.
