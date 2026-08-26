# Design Review v11 — record (LOCK AS-IS)

*Reconstructed record. The review-11 agent returned its verdict from the pane without writing a file; this file captures it so the review chain is complete on disk (the reviewer of v12 flagged the gap).*

**Verdict: LOCK AS-IS.**

Review-11 (the final micro-verification of core-design-v11, following review-10's three blocking + three recommended phrase-level edits) confirmed:
- all six v11 edits applied;
- the consistency grep clean — no remaining instance of `ctx.feedback` as the replay/rework discriminator, no "post-cutoff" gate claim, no over-claimed static validation of intent ordering;
- the three mechanism sections (§2, §3, §4) + the ship list (§8) agree on the transcript-presence discriminator;
- the amendments list complete, citations verified.

**One optional, non-blocking word:** the headline mechanism paragraph's trailing "alone" ("transcript presence, not `ctx.feedback` alone") left `ctx.feedback` a partial share of the discriminator; every other site says *never*. Deleted — applied in core-design-v11 (and carried into v12+).

Settled list honoured from v12 onwards: design-review-v10.md §VI ("What is now settled and should not be re-litigated"): defer-record (locks and spawns deferred to commit, ordered locks-first) · transcript replay with `runId = 1 + rejections at the bound gate` + the miss policy · the gate②-to-commit sha binding over marker-stripped bytes with a `failed` outcome on mismatch · fail-closed `produces?[]` · depth-2 spawn · supersede refusal on a non-`done` locker · corrected gate-sequence ownership.
