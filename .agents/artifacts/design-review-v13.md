# Design Review v13 — DOES THE CONFIG DIMENSION RUN?

*Scope as prescribed: verify the 10 blocking + 3 non-blocking edits review-12 required, the internal-consistency grep, the lock verdict. v11's mechanisms are settled and I did not re-litigate them.*

*Evidence base: `core-design-v13.md` read in full and **diffed line-by-line against v12** — the diff is **6 hunks** (header · §1 rows 59-60 · §2 rows 95-96 · §3 rule 8 · §6 205-256 · §8 291-293). **§4 is untouched. §1:61, §1:62 and the headline :7 are untouched** (they appear as diff CONTEXT lines, not `+` lines). Code measured, not read-around: `kernel/kernel.ts` (`REJECT_BOUND = 3` :88, `rejectionCount` :206-209, escalation at execute entry :221-230, readiness refusal :231-238, `verify` :303-322), `kernel/flow.ts` (loader + `.ann/rules` vs bare `rules` :53-56, fail-closed :76, `validateChain` earlier-set :124-127), `engines/context.ts` (:112, :151), `adapters/provider/config.ts` (`UserConfig` :20-30, `setConfig(key: keyof UserConfig)` :52, resolution-order docblock :17), `cli.ts` (:487-492, :810), `store/store.ts` (status derivation :160-186 — **`blocked` has exactly one source**). Contracts quoted from disk: `resource-registry-spec-v2.md` (:26, :36, :55, :81-93, :98), `functional-spec.md` (:47, :79), `flow-control-spec-v6.md` (:23, :39, :43-51, :77), `requirements-spec-v3.md` (:63, :65).*

---

## Headline

**The dimension now runs.** Review-12's DO-NOT-LOCK rested on two mechanisms that were inert. Both are fixed:

- **Verify cycles.** Walked against §2:96 as amended: verify fails → a frame-phase `verify` record is appended → the ATTEMPT BOUNDARY (`the LATER of (latest rejected at the bound gate, the latest verify-cycle record)`) moves past the step's cycle-1 traces → no trace post-dates the boundary → the attempt is **NEW** → the retry runs **FRESH**. The self-defeat review-12 measured is gone.
- **`inputMissing`** is dropped (§6:214), the case routed to the locked ladder rungs. One mention survives, and it is the deletion note.

**But three of the ten blocking edits were applied to one of their two named sites**, and the unedited sites are the normative ones an implementer reads. §1:61 and §4:162-167 were named explicitly by edits 2 and 4 and were not touched. And the §2:96 `runId` formula, rewritten this round, is **circular against its own boundary definition** — read literally it makes the new term identically zero.

None of this re-opens a settled mechanism, none of it makes a mechanism inert, and every fix is one clause with an unambiguous correct form. That is review-10's phrase-edit standard.

**Verdict: LOCK AFTER the 6 edits in §V.**

---

## I. PER-EDIT VERDICT

### Blocking edit 1 — §2:96, the attempt boundary — **APPLIED; the boundary is right, the `runId` span phrase is circular**

The boundary is correct and the walk succeeds. Confirmed at :96:

> an attempt is NEW when no `trace` record post-dates the **ATTEMPT BOUNDARY** — the LATER of (the latest `rejected` event at the step's bound gate, the latest verify-cycle record)

Walk: cycle-1 record appended → boundary = that record → step's runId-1 traces pre-date it → NEW → FRESH. ✓ And :96 correctly records that this **amends a review-10-settled rule**, which is what edit 1 asked for.

**The defect is the second half of the same sentence:**

> **`runId` = 1 + (rejections at the bound gate) + (verify cycles in the current attempt)**

"The current attempt" is the span *after* the attempt boundary. The boundary **is** the latest verify-cycle record. Therefore the number of verify-cycle records in the current attempt is **zero, by construction** — the term contributes nothing and `runId` collapses to `1 + rejections`, the v11 derivation.

That is not a cosmetic reading. It changes the outcome: the discriminator correctly says FRESH, but `runId` does not advance, so the fresh cycle-2 records are written at `runId = 1` — colliding with cycle-1's stranded records on the `(stepId, runId, seq)` key that :99 uses for dedup. The clause's own guarantee — *"fresh records never collide"* — fails under its own arithmetic.

**The correct span exists in the document**, at §3:128: *"anchored AT THE LATEST GATE DECISION at `confirm` (resetting per rework pass)"*. §2 — the place edit 1 said the derivation must live — carries the wrong words for it.

**Edit A (§V).** One phrase.

**Second, unflagged consequence of the same edit — the verify term is GLOBAL and it is applied per-step.** Frame-phase records carry no `stepId` (:95), so the "latest verify-cycle record" is one position in the tail for every step. The boundary is then computed for **grill-bound steps too**, whose bound gate is `grill`. After any verify cycle:

- a grill-bound step's traces pre-date the verify-cycle record → the discriminator computes **NEW**;
- §2:86-87 says the opposite — *"earlier grill-bound steps REPLAY — their gate is still confirmed"*;
- §2:88-89 resolves the conflict **against** the routing rule: *"THE DISCRIMINATOR IS AUTHORITATIVE for fresh-vs-replay; this delivery rule governs FEEDBACK ROUTING ONLY."*

So on a confirm rework that follows any verify cycle, the authoritative rule marks the grill-bound step FRESH. If it re-runs — and §4:148 says execute runs the chain *"in EXECUTION ORDER: grill-bound first"* — the human is re-interviewed at an already-confirmed gate and a new grill verdict is produced, breaking :95's headline promise (*"the human is NEVER re-interviewed"*) and rule 4 (:124). This is a **new contradiction introduced by v13**, and unlike edit 1's, the correct statement is not anywhere in the document.

The rule is obvious and costs one clause: the verify-cycle term applies only to `at:'execute'` and `at:'confirm'` steps; a grill-bound step's boundary stays the latest `rejected` at `grill`. A verify cycle re-enters at execute; it has no business moving the grill phase's boundary. **Edit B (§V).**

### Blocking edit 2 — §1:61 **+** §3:128, the cycle anchor + the ≤9 ceiling — **HALF APPLIED**

§3:128 is complete and correct. All four required pieces are there: the anchor (*"anchored AT THE LATEST GATE DECISION at `confirm` (resetting per rework pass)"*), the ceiling (*"≤ 3 chain executions per task (the reject bound) × ≤ 3 cycles = **≤ 9 chain executions**"*), the NFR-CST-1 consequence in the same clause, and the explicit correction *"there is NO '10× cap' — that is the spec's stress annotation"*. Verified against `requirements-spec-v3:65`, which reads *"bounded model calls per step — one grilling pass, one review pass, capped rework. *10× = cost explosion. KEEP.*"* — a stress annotation, no budget. ✓ And the ≤9 arithmetic checks against `kernel.ts:88` (`REJECT_BOUND = 3`) and :221-230 (escalation tested at execute entry, so ≤3 chain executions per task).

**§1:61 is byte-identical to v12.** The diff proves it — it is a context line in hunk 2. It still carries:

- **no anchor** — the row a reader consults for "what is this knob" does not say what the count counts from;
- **no ≤9** — edit 2 asked for the ceiling consequence "in the same clause", and this is one of the two clauses it named;
- ***"this knob is the verify rung only"*** unqualified — review-12 §IV called this out specifically: the knob multiplies chain executions inside every rework pass. The row still asserts containment that §3:128 now contradicts with its own ≤ 3 × 3 arithmetic.

One thing §1:61 *did* gain, indirectly: its *"`kind: 'verify'` — schema-legal"* claim was **false** in v12 and is now **true**, because §2:95 legalizes the kind. That was review-12 §III.3f's complaint and it is resolved. **Edit C (§V)** carries the anchor + ceiling into the row.

### Blocking edit 3 — §2:95 + §8:291, legalize the record — **APPLIED WITH AN INCOHERENT SHAPE**

The legalization exists. §2:95: *"`kind: 'verify'` and `kind: 'skip'` are LEGALIZED by the same amendment with a key shape needing NO `stepId`/`runId` — `{phase: 'verify'|'skip', cycle, condition?}`"*, and §8:291 carries it into the journey-format v14 §3 amendment scope. That is what edit 3 asked for, and the reasoning (a verify cycle belongs to the frame's verify phase, not to a step) is right.

**Three internal contradictions in the shipped schema:**

1. **`kind` vs `phase`.** Six sites write the discriminant as `kind:` (:60, :61, :95 twice, :128, :165, :211). The schema itself (:95, :291) writes `phase:`. The amendment ships `{phase, cycle, condition?}`; every consumer references `kind`.
2. **`stepId` — §2:95 forbids it, §6:211 requires it.** :95 says the shape needs **NO** `stepId`; :211 defines the skip record as `kind:'skip' {stepId, condition, evaluated:false}`. §6 is right and §2's blanket is wrong: a skip record without a `stepId` cannot name which step was skipped, which defeats the entire purpose of edit 11 (NFR-OBS-1 — *"the tree IS the log"*, `requirements-spec-v3:63`, verified on disk). The generalization from `verify` (genuinely step-less) to `skip` (necessarily step-keyed) is the error.
3. **Fields don't match.** :95's shape carries `cycle` (meaningless for a skip) and omits `evaluated:false` (which :211 requires).

**Edit D (§V).** Two record shapes, named separately.

### Blocking edit 4 — §3:128 **+** §4:162-167, the empty chain — **HALF APPLIED, and "BLOCKS" is not derivable**

§3:128 states it, and takes **both** of review-12's alternatives rather than choosing between them: *"`verifyFailCycles` is FORCED TO 1 and the frame BLOCKS rather than fails"*. Taking both is the better answer, and the diagnosis is right — verified against `kernel.ts:303-322`, where `verify` passes only on `evidence.commits[]` or an `artifact-locked` event, so an empty chain whose runner has not committed fails verify.

**§4 was not touched at all — zero hunks.** §4:162-167 still reads *"up to flow.verifyFailCycles (config; default 1; ceiling 3) — cycles recorded as trace kind:'verify'; ceiling reached → failed"*, with no empty-chain carve-out, no anchor, and no mention that a cycle advances the attempt boundary. §4 is the frame — the section an implementer builds the loop from. Edit 4 named these lines explicitly.

**And "the frame BLOCKS" has no representation in the store.** Measured, `store.ts:176-184`:

```
// v8 §3: a submitted without a confirmed/rejected at that gate = blocked
if (pendingGate) status = 'blocked';
```

That is the **only** producer of `blocked`. A verify-phase block involves no gate and no `submitted`, so the tail after an empty-chain verify failure contains `activated` and nothing else → the task derives **`active`**, not `blocked`. It also matches none of the three resume tail-states at :69 (all three are gate-keyed). So the task sits `active` with no machine record of what it waits for — against §0 (*"status **derived** from the event tail, never asserted"*) and NFR-COM-1 (*"goal/status/next-action answerable from structure alone"*). The design must name the event that represents this state. **Edit E (§V).**

*Minor, fold into E:* "FORCED TO 1" silently overrides a user's configured value, which sits oddly beside §6:244's *"never a silent clamp"*. A half-sentence distinguishing context-inertness from value-clamping settles it.

### Blocking edit 5 — §6:208, qualify `verdict` — **APPLIED, clean**

:208 `when?: {hasOutput?: stepId | verdict?: {step, decision}}`, and :218-220: *"`verdict` is QUALIFIED {step, decision}: step precedes this entry in EXECUTION order and declares decision in its decisions[]"*. Exactly the form edit 5 specified, including the execution-order qualifier (not list order). ✓

### Blocking edit 6 — §6:208, drop `inputMissing` — **APPLIED, clean**

Dropped from the type. The single surviving mention (:214) is the deletion note with the measurement and the ladder hand-off. Re-verified on disk: `context.ts:112` pushes a blocker for any missing `requiredInput`, `:151` sets `ready:false`, `kernel.ts:231-238` refuses the chain in that state — the condition was unreachable. ✓

### Blocking edit 7 — §6, the two skip-safety rules — **APPLIED as specified**

:220-228 states both as VALIDATION: (a) a REQUIRED role may not bind to a conditional step unless the consumer is itself conditional on `hasOutput` of that step, with the reason (*"validateChain cannot see `when` (flow.ts:124-127)"* — verified: `const earlier = new Set(chain.slice(0, i))` is a positional id set); (b) a gate-bound entry may NOT carry `when`. ✓

*One inherited gap, not v13's error — see §III.*

### Blocking edit 8 — §6:225 + §1:59, fail-closed + downgrade — **APPLIED, clean**

Fail-closed is stated twice (:60 *"a chain carrying `when` under `false` FAILS CLOSED, named"*; :252 with the `flow.ts:76` citation — verified on disk: *"fail-closed: never silently fall back"*). And §1:59 is properly downgraded: *"the `when` condition's OWN references + the two skip-safety rules … NOT over-claimed: downstream skip-safety is the explicit rules, not a general claim"*. That is the cell reviews 8 and 9 spent two rounds cleaning; it is honest now. ✓

### Blocking edit 9 — the config placement (option b) — **APPLIED at §6; CONTRADICTED at :7 and :62**

v13 keeps the new registry, so option (b)'s five requirements apply. In §6:236-247, all five are met:

| requirement | site | verdict |
|---|---|---|
| one class, two instances | :236 | ✓ |
| amend the frozen `:81-93` schema | :238, :293 | ✓ — verified frozen on disk (`provider·model·baseUrl·apiKey·maxTokens·projects·currentProject`) and mirrored by `config.ts:20-30` + `setConfig(key: keyof UserConfig)` |
| management surface | :242-243, :293 | ✓ — verified `cli.ts:492` prints exactly `provider · model · baseUrl · apiKey · maxTokens` and :810 accepts the same five |
| precedence `env > user > project > builtin`, per leaf key | :241 | ✓ — matches `resource-registry-v2:98` and `config.ts:17` |
| no user override of `conditionals` | :239-241 | ✓ |

**Two untouched sites still carry the v12 rule.** Both are diff context lines:

- **:7 (the headline)** — *"**Precedence: user config > project config > builtin defaults.**"* No `env`; and the sentence continues *"It holds the END-USER KNOBS: `flow.conditionals` …"*, so the blanket user-over-project precedence applies to `conditionals` — the exact override :239 forbids.
- **:62 (the ownership row)** — *"the user-facing knobs (conditionals · verify cycles · ask-vs-assume · defaults); precedence user > project > builtin"*. Same two errors, in the invariant-ownership table.

Three precedence statements, two of them wrong, and the wrong ones are the summary line and the ownership table. **Edit F (§V).**

**A third inconsistency, inside the applied text.** :238-241 says three incompatible things in four lines: the user overlay is *"AMENDED to admit flow.*/preferences.*"*; it *"overrides preferences only"*; and *"`flow.conditionals` … is NOT user-overridable"* — which implies `flow.verifyFailCycles` **is** (review-12 §I.1c allowed exactly that: a cost knob, defensibly user-overridable). "Overrides preferences only" forbids it and makes admitting `flow.*` to the schema pointless. Pick: either the overlay admits `flow.verifyFailCycles` (then say "overrides preferences **and `flow.verifyFailCycles`**"), or it does not (then drop `flow.*` from the schema amendment). Folded into **Edit F**.

### Blocking edit 10 — two ownership rows — **APPLIED IN SUBSTANCE, not as rows**

Edit 10 asked for two rows in §1's table. Both contents are present, in §6 and §8 instead: validation → *"ill-typed or out-of-range values → NAMED problem, never a silent clamp"* (:244-245); builtin defaults → *"a code literal — a KNOWING DUPLICATE of the registry, recorded as a reconciliation (the :54 precedent)"* (:245-247), carried into the resource-registry amendment at :293 as *"a SECOND recorded reconciliation"*. Both rules are stated and owned. Placement is form, not substance. **Not blocking.**

### Non-blocking 11 — record the skip — **APPLIED** (:60, :95, :210-212, with the NFR-OBS-1 citation). Shape defect covered by Edit D.

### Non-blocking 12 — state the boundary honestly — **APPLIED, with a falsified count**

:252 states four of five: *"skip-shaped only — no else-branch, no alternative step, no join; THREE fixed predicates — a fourth condition kind is a CODE change; NO conditional gate sources (rule 6); the flag is PROJECT-WIDE"*.

**"THREE fixed predicates" is falsified by v13's own edit 6.** :208 declares exactly two: `hasOutput` and `verdict`. `inputMissing` was the third and it was dropped this round. The correct sentence is *"TWO fixed predicates — a **third** condition kind is a CODE change"* — and it makes the boundary *tighter*, which is the point of stating it. Folded into **Edit F** (one-word class).

The fifth boundary item review-12 §V listed — **cross-registry coupling** (a flow-data feature gated by a value in another registry) — is not stated. Non-blocking; it is the consequence the owner chose by keeping option (b).

### Non-blocking 13 — file `design-review-v11.md` — **APPLIED.** On disk, 15 lines, LOCK AS-IS recorded, carrying review-10:145's settled list forward. ✓

---

## II. THE CONSISTENCY GREP

Every string review-12 named, plus the ones the new edits could have stranded.

| grep | hits | verdict |
|---|---|---|
| `inputMissing` | 1 — :214, the deletion note | **clean** |
| `runId` derivation without the verify term | 0 — one derivation exists (:96) and it carries the term | **clean** |
| `no trace, no events` / `absence of execution` (the unrecorded skip) | 0 | **clean** |
| `ctx.feedback` as discriminator | 0 as discriminator (all sites say *never*) | **clean** (v11 settled) |
| **`all four kinds`** | **1 — :95** | **FALSIFIED.** Six kinds now exist. :291 says *"ALL SIX kinds"*. Direct contradiction, same amendment. |
| **`THREE fixed predicates`** | **1 — :252** | **FALSIFIED** by :208's two predicates. |
| **precedence without `env`** | **2 — :7, :62** | **FALSIFIED** by :241 and `resource-registry-v2:98`. |
| **user-overridable `conditionals`** | **2 — :7, :62** (blanket user>project over a list containing `conditionals`) | **FALSIFIED** by :239-241. |
| `10×` / `10x` cap | 1 — :128, and it is the *correction* | **clean** |
| `kind:` vs `phase:` for frame-phase records | 6 × `kind`, 2 × `phase` | **INCONSISTENT** (Edit D) |
| skip record shape | :95 `{phase, cycle, condition?}` / :211 `{stepId, condition, evaluated:false}` | **INCONSISTENT** (Edit D) |
| `verify rung only` | 1 — :61 | **incomplete** — contradicted by :128's ≤ 3 × 3 (Edit C) |
| "BLOCKS" at verify | :128 | **not derivable** — `store.ts:176-184` (Edit E) |

Four outright falsified strings; three of the four sit on lines the v12→v13 diff never touched.

---

## III. NOT BLOCKING, BUT ON THE RECORD

- **Rule 8's runtime hole is only half-closed, and review-12 mis-scoped it.** Review-12 §II.2b asserted that forbidding `when` on gate-bound entries *"closes both holes"*. It does not close the second: an `at:'execute'` step that is the chain's **only** artifact producer may still carry `when`, be skipped, and leave the chain producing nothing → verify finds no outputs → the cycles burn → `failed`. v13 applied exactly what edit 7 specified, so this is inherited, not a v13 failure. It is also **bounded and named** (≤3 identical deterministic cycles, then a named blocker), so it is waste, not unsoundness. If a third skip-safety rule is ever wanted, it is: *a chain's conditional steps may not be its only `produces?[]`-declaring steps.*
- **The 4th migration's path.** §8:293 lists `rules/config/default.json`; `flow.ts:53-56` resolves `.ann/rules/…` first and accepts bare `rules/…`. The new loader must do the same. Review-12 §IV asked for this once in the migration list; it is not there.
- **F17's locked scope.** `functional-spec:79` (verified on disk): *"F17 config scope: provider + ask-vs-assume + defaults (step-chain templates land in F3)."* v13:7 and :62 still cite F17 while the file holds `flow.*`. Option (b) did not require a functional-spec amendment, so this is not a blocking gap — but nothing in §8 records the tension, and §8 is where tensions get recorded.
- **§1:60's `kind:'skip'` claim** inherits Edit D's shape ambiguity; fixing D fixes it.

---

## IV. WHAT I DID NOT DO

**I ran no fixtures — fifth review in a row on code-reading and contract-reading.** The verify-cycle replay path is now *arithmetically* sound on the boundary and *wrong* on the `runId` span; both are settleable by one fixture that appends a `verify` record and asserts the next run's `(stepId, runId, seq)` does not collide with the stranded ones. Review-12 asked for that fixture before v13 locked. It still has not been run, and it is the single cheapest way to convert Edit A from "I read the sentence carefully" to "the test says so."

I did not re-litigate: defer-record, transcript replay, the gate②-sha binding, fail-closed `produces?[]`, depth-2 spawn, supersede refusal, gate-sequence ownership (design-review-v10.md:145 · design-review-v11.md:15).

---

## V. LOCK VERDICT

# LOCK AFTER these 6 edits

The dimension **runs**. Review-12's two inert mechanisms are fixed; conditionals are specified with both skip-safety rules; the config carries all five of option (b)'s requirements. What remains is six clauses. **None re-opens a settled mechanism, none makes a mechanism inert, and for every one of them the correct form is unambiguous** — which is exactly review-10's phrase-edit standard, the standard review-12 said v12 failed to meet and v13 now meets.

**A. §2:96 — the `runId` span.** Replace *"verify cycles in the current attempt"* with the span §3:128 already names: **"verify cycles since the latest gate decision at `confirm`"**. As written the term is zero by construction (the boundary *is* the latest verify-cycle record), `runId` does not advance, and fresh cycle-2 records collide with cycle-1's on the `(stepId, runId, seq)` key :99 dedups by.

**B. §2:96 — scope the verify term to the execute phase.** The verify-cycle term applies to `at:'execute'` and `at:'confirm'` steps only; a grill-bound step's boundary remains the latest `rejected` at `grill`. Without this the authoritative discriminator computes NEW for grill-bound steps after any verify cycle, contradicting :86-87 (which :88-89 subordinates to it) and re-interviewing a human at a confirmed gate.

**C. §1:61 — carry edit 2 into the row.** Add the anchor (*since the latest gate decision at `confirm`, resetting per rework pass*) and the ceiling (*≤ 3 × 3 = ≤ 9 chain executions*), and qualify *"this knob is the verify rung only"* — it is the verify rung, but it multiplies inside every rework pass. The row is byte-identical to v12 today.

**D. §2:95 — two record shapes, not one.** `verify` → `{cycle}`, no `stepId`. `skip` → `{stepId, condition, evaluated:false}`, no `cycle` (as §6:211 already has it). Pick **one** discriminant name — six sites write `kind:`, the schema writes `phase:`. And fix *"shape-policed for ALL FOUR kinds"* → **SIX**, which :291 already says.

**E. §4:162-167 — carry edit 4 into the frame, and name the block.** §4 has zero v13 hunks: add the empty-chain rule, the anchor, and "a cycle advances the attempt boundary". Then name the event that represents "the frame BLOCKS" — `store.ts:176-184` derives `blocked` **only** from an undecided `submitted`, so as written the task derives `active` with no record of what it waits for, and matches none of :69's three resume states.

**F. The three untouched summary sites.** :7 and :62 → `env > user > project > builtin`, per leaf key, with `conditionals` **not** user-overridable (both currently state the v12 rule that :241 and :239 overturn). :238-241 → say whether the user overlay may set `flow.verifyFailCycles` ("overrides preferences only" contradicts both the schema amendment and the conditionals-only carve-out). :252 → **TWO** fixed predicates, a **third** is a code change (:208 declares two; `inputMissing` was the third and edit 6 dropped it).

**Sequencing.** A, B, D and F are phrase edits. C and E are one clause each into sections that were skipped this round. None needs new reasoning — every correct form is already written somewhere in v13 or measured in this review. This is a single mechanical pass, and I would not require a v15 review of it: **re-run the §II grep after the pass, and if the four falsified strings are gone and A/B are in §2, lock.**

Option B from review-12 (lock v11, land the dimension later) is no longer the better path — the dimension is one pass from correct, and v11 does not have it.
