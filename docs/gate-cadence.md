## Link contract
- **upstream** (this doc relies on): docs/flow-control-spec.md,docs/journey-format-spec.md,docs/core-design.md,docs/goal.md
- **referrers** (must cite this when they change): functional-spec,resource-registry,architecture,journey-format-spec

# Gate Cadence (v2)
*Type: spec. DIRECT-AUTHORED, not produced by a `spec!` session — the SPECS session's GO is a human decision and was not driven; recorded as a deviation per the v18 precedent (`10-server-ui/05-implementation-journey-format-v18`). Provenance: the operator's standing complaint, 2026-09-22 — "too many human gate, too much to watch". This spec fixes the shape; the producing task is spawned after its GO. Upstream: `flow-control-spec`, `journey-format-spec`, `core-design`, `goal`.*

**Revision (v2), 2026-09-25 — §1-§6 stand; §7-§10 are added.** The operator's second reading of the same problem: *"on ending gate, now it ask human action, but that's too much to read"* — the burden he kept paying was the **exit card**, and the answer is not a cheaper card but a worker that reads it and decides. §1-§6 keep both gates and make the ENTRY gate worth having. §7 changes the **exit gate's decider**, not its existence: §5's scope-out of the gate *count* still holds, and both gates remain on every task. Four operator decisions are recorded in §7 as the design's premise, not as options — **including the one made against this spec's own recommendation**, so §7.5 and §9 carry its cost rather than burying it. Spawned 2026-09-25 as `12-operate-loop/22-implementation-automatic-exit-gate`, which carries §7 as its contract and cites this doc as a required input; §1-§6's own build is still unspawned.

## 1. The problem, measured

The operator's complaint is a burden of *stopping*, and it is real. But the measurement
separates two things that were being conflated:

- Every task carries exactly **2 gates** — a `grill` entry and a `confirm` exit — regardless of
  work type. Leg 12's 19 tasks cost **38 human decisions**.
- **29 of those 38 recorded no `why`.** Rejects always carry a reason (`12/05` grill; `12/02`,
  `12/08` confirm); accepts mostly do not. The human's recorded judgment concentrates in ~4
  decisions out of 38.
- The entry gate has nothing to decide on an `implementation` task: `ann flow` resolves it to
  *"chain: (lifecycle only — no content steps)"*. `rules/flow/default.json` holds
  `"implementation": []`.
- **The contract is invisible where the advance is approved.** The ADVANCE card shows only
  `next task: X (queued)` — no intent, no ACs (`src/flow/operator-action.ts:154-166`). The entry
  gate is therefore the *only* surface where a task's contract appears. That, not the gate
  itself, is what makes it feel load-bearing.

So the defect is not "too many gates" alone. It is **gates that ask for a decision while hiding
what is being decided, and record nothing when given** — 38 times.

## 2. What is NOT proposed — the rejected design

An earlier design made the entry gate **conditional on the resolved chain**: no content step, no
gate. It was rejected on four grounds, and this spec records them so the idea is not re-proposed
without answering them.

1. **It reverses a deliberate, documented invariant.** `flow-control-spec` §3: *"Both gates are
   HARD on every node in v1; work-type weakening = v2 plugin concern."* `resource-registry`
   §5: *"the gate set, the gate positions and the 3-reject bound are not reachable from any config
   file."* Making gate existence a function of the flow config **is** that v2 work — a leg, not a
   patch.
2. **The cheap implementation is an L0/L2 cycle plus a fail-open hazard.** `resolveChain` is L2 and
   imports `Store` (`src/flow/chain.ts:4`); `gateProblems` is L0 and per `architecture.md` "knows
   nothing above". The fact must be *pushed in* with a fail-closed default. Worse, `resolveChain`
   returns `{chain: [], problem}` for a broken config and **the builtin fallback is also the empty
   chain** (`chain.ts:158`) — so "empty chain" cannot mean "no gate" without silently removing it
   from every project with no flow config, including every store unit test. Any such condition must
   be `problem === undefined && chain.length === 0`.
3. **GATE-SEQ must move atomically with GATE-1.** The frame writes `submitted(gate=confirm)`
   (`src/flow/frame.ts:311`) and `writeEvent` refuses it under GATE-SEQ (`store.ts:1966-1971`)
   when no grill accept exists; a failed submit writes `failed` on the task (`frame.ts:314`). A
   half-migration turns every empty-chain task into a `failed` node. `check()`
   (`store.ts:1981-1990`) must move in the same commit or `advance!` refuses journey-wide.
4. **The deepest cost is the `queued` collapse.** After the change no derived state distinguishes
   "a human approved this contract" from "nobody has looked at it" — see the comment at
   `src/e2e/whats-next.e2e.test.ts:93-94`, where `queued` already cannot tell the grilled case
   from a fresh one. That is the invariant actually being given up, and it is not the same as
   "a gate exists".

## 3. The design

**Principle: a gate must show what it decides, and record why it decided.** The cadence is kept;
the ceremony is removed where it is hollow, and the contract is made visible where the decision
actually happens.

### 3.1 The contract is visible at the advance (the real fix)

The ADVANCE card and the frame's `present()` **must show intent and the ACs** before the operator
approves an advance. Today `operator-action.ts:154-166` shows only `derivation.detail`. Without
this, no change to the gates can help: the operator would still be approving blind.

### 3.2 The entry gate is a cheap acknowledgement

The entry gate stays on every task (the invariant holds), but its decision is a **bare
acknowledgement of a contract now shown on the card** — not a reading session. This is what
removes the reading burden without moving an invariant: a task still records that a human saw its
contract, and 3.1 makes seeing it cost one screen.

### 3.3 A gate accept must record a rationale

The measured defect. A gate accept carries `feedback` (the field exists —
`store.ts:1735-1766`) and it is currently optional. It becomes **required on accept**, for both
gates, validated in the same place as the other gate shape checks. Fail-closed: an accept with no
rationale is refused by the writer.

Consequence to accept knowingly: this makes every accept a small writing act. That is the point —
if there is nothing to say, the gate was hollow.

### 3.4 Drift becomes data — `extended` gains an optional `kind`

Contract text is frozen at spawn (`node.json` is immutable), but the plan keeps moving by
`extended` note. `12/10` is the live proof: its AC-2 lists the gestures `add · list · promote`,
while its own amendment note proposes adding `adopt <path>`. `12/11` and `12/14` carry notes
reading *"WORK/SCOPE LANDED AHEAD OF THE ENTRY GATE"* — which the repo already flags as an
ANOMALY.

A note that amends a frozen contract declares it: `extended` gains an optional `kind`, with a
closed value set validated fail-closed beside the gate checks. Implementation footprint:
`store.ts:1710` allowlist `['at','type','note']` → `+ 'kind'`. **No `vocab.json` change** — it
registers set names (`eventTypes`, `statuses`, `gates`), not per-event fields.

**Say plainly what this is and is not.** `kind` is agent-writable (`append!`,
`src/commands/index.ts:1074-1100`), so "there is something to decide" is a **self-report, not a
detection**. The engine cannot detect divergence from a frozen contract; it can only honour a
declaration. This spec does not claim drift detection.

### 3.5 Drift is enforced by an effective-accept comparison

A revived gate is **not** possible by reusing gate *state*: `gateView` is a pure tail scan
(`src/store/workflow.ts:124-166`), so an already-accepted grill reads `accepted` forever. Reuse of
the gate *type* is fine; the state cannot be un-accepted.

The mechanism is therefore **one integer comparison**, living beside `gateView` and consumed by
both the writer and the projection:

```
entry gate satisfied  ⟺  lastIndexOf(confirmed{gate:'grill'})
                       >  lastIndexOf(extended{kind:'amends-contract'})
```

Settled **only** by a later grill accept. A confirm accept is a different decision (the result,
not the contract); a sibling-correction node is a different gesture, and letting it settle the
debt would make it impossible to reason about what cleared it; a grill *rejection* leaves the
amendment pending. This is the same `lastIndexOf` + later-X shape as the existing
`undecidedSubmission` (`src/commands/index.ts:1872-1877`) and `undischargedWait`
(`workflow.ts:262-266`). It is monotone — one later accept settles every earlier note — and
fail-closed in the only direction that matters: an amendment can only ever *add* a gate.

## 4. Hazards the implementation must carry

- **`brief()` surfaces only the LAST `extended` note, capped at 700 chars**
  (`src/commands/index.ts:1032-1035`). An amendment buried under a later note would be invisible
  at the very gate it revives. Fix the *selection*, not just the field.
- **Retrofit gap.** An amendment written *after* `artifact-locked`/`completed` existed
  retroactively violates the new rule: `check()` reports GATE-1 and `advance!`'s pre-check
  (`src/flow/operator-action.ts:116`) refuses **every** advance in the journey until a re-grill.
  `grandfathered()` cannot help — it is a `createdAt` rule and these are new events on old nodes.
  The implementation must state what an amendment does to work already produced.
- **The three truths that must be rendered distinctly.** `none` on the entry gate would otherwise
  mean two different facts — "not yet submitted" vs "not applicable" — the "one word, two facts"
  failure this codebase has fixed repeatedly (`workflow.ts:1-40`, `ui.ts:19-21`). Surfaces to
  check: `src/surface/ui.ts:259-260, 464-471, 486-489, 689`;
  `src/surface/command-renderers.ts:123-124, 193, 587`; `src/flow/operator-action.ts:203-216`.
- **`gate!` has no human-only guard** while `goal! met` does (`src/commands/index.ts:1270-1272`).
  Pre-existing and adjacent: an accepted gate is unauthenticated, so requiring a rationale (3.3)
  is only as trustworthy as the caller. Out of scope here, but it bounds this spec's guarantee.

## 5. Out of scope (own node)

- **The gate COUNT.** Reducing it is the v2 work `flow-control-spec` §3 defers. This spec keeps
  both gates and makes them worth having. If the count itself is the burden, that is a separate
  spec that must answer §2's four objections.
- **Derived-artifact hygiene** (found while measuring): regenerate
  `.ann/rules/check/rules.json` — 15 ids listed, 12 have modules, stale since `1e12e78` skipped
  the regen — plus a `rulesIndexFresh` check mirroring `docsIndexFresh`
  (`src/store/docs.ts:86-92`). Also: `journey-format-spec`'s title says v18 while its §11 records
  v19; `resource-registry.md:57` still lists the three retired rules;
  `requirements-change-protocol.md` still describes the retired `lock!`/`superseded` machinery.

## 6. What this changes in code

| § | File | Change |
|---|---|---|
| 3.1 | `src/flow/operator-action.ts:154-166`, `src/flow/frame.ts:347-362` | card/`present()` show intent + ACs |
| 3.2 | `src/flow/frame.ts` grill phase | ack-shaped entry decision |
| 3.3 | `src/store/store.ts:1735-1766` | `feedback` required on gate accept, fail-closed |
| 3.4 | `src/store/store.ts:1710` (+ shape check) | `extended` gains optional `kind` |
| 3.5 | `src/store/workflow.ts` (beside `gateView`), `src/store/store.ts` (`gateProblems`) | the effective-accept comparison, one place, both consumers |

Reuse, do not rebuild: `resolveChain` (`src/flow/chain.ts:123-160`), `phaseOf` (`chain.ts:75`),
the `docsIndexFresh` freshness pattern (`src/store/docs.ts:86-92`), and the existing gate
shape-check neighbourhood (`store.ts:1735-1766`).

---

## 7. The exit gate becomes automatic (v2)

### 7.0 The four decisions this design is built on

Recorded as premise, because everything below is a consequence of them and three of the four
have a defensible alternative:

| # | The operator chose | The alternative, and why it was not taken |
|---|---|---|
| D-1 | **The worker accepts automatically** — the human leaves the exit gate | A human reading only the worker's verdict. Rejected by the operator; the cost is carried in §7.5 and §7.8. |
| D-2 | **Both the floor and the model auto-rework** | Only the deterministic floor auto-reworking, the model advising. Rejected: it splits "who may reject" across two mechanisms. |
| D-3 | **The escalation is built** — the worker stops at the bound and a human decides for real | Leaving it a string (§7.6). Rejected: an auto-rejecting worker reaches the dead end in three machine cycles with no human having seen any of them. |
| D-4 | **One spec** — this one, extended | A second doc. Rejected: the exit gate and the entry gate are one cadence, and two docs would drift at exactly the boundary they share. |

### 7.1 What the worker is, and what it is not

**It is not `ann review!`.** The advisory session (`src/flow/review-session.ts`) is interactive,
terminal-only (JSON mode refuses it; it is not a service route), multi-round, and
**structurally barred from deciding**: it appends `evidence` and nothing else — the gate kinds
are composite-owned by `gate!` (`src/flow/review-session.ts:425`) — and a test pins it, *"AC-4:
the session writes NO gate event, and the task is exactly where it was"*
(`src/commands/__tests__/commands.test.ts:777`). Its prompt forbids a verdict twice.

The **review worker** is a distinct actor: headless, single-pass, no terminal, and permitted to
write the gate decision. It must be a separate thing rather than a mode of the session, because
the session's no-decision property is load-bearing and tested, and its interactive shape cannot
run unattended.

The worker is a **fresh invocation that receives only the gate material** — the brief and the
diff of the cited commits — never the implementer's context. `AGENTS.md` forbids an implementing
agent self-accepting its own gate; the worker must not become the way around that (§8).

### 7.2 Where it runs, and what it is allowed to decide

At the confirm **submission**, as the door to the gate. One review per submission; the loop
between submissions is the EXISTING rework loop (a rejection derives `rework`,
`src/store/workflow.ts:316-323`, and the frame re-executes, `src/flow/frame.ts:555-557`). **No new
loop, no new state, no new event type** — 12/06's rule (`docs/flow-control-spec.md`) holds here
too: a worker's rejection is the same `rejected` event a human's is.

```text
submit! <id> confirm
  ├─ FLOOR — deterministic, in-process (§7.3)
  │    fail → the submission is REFUSED. nothing written, no rejection burned
  └─ pass → `submitted` is written
       └─ the worker reviews — model (§7.4)
            rework    → `rejected`, the findings as feedback → the derived `rework` state
            accept    → `confirmed`, the verdict as the rationale → auto-close if F-AC18 holds
            human     → nothing written; the card goes to the HUMAN
            absent    → nothing written; the card goes to the HUMAN (§7.7)
```

**The exit gate only.** The grill stays the human's (§3.2), which bounds this change to one gate
and leaves §1-§6's design untouched.

### 7.3 The floor — deterministic, and it REFUSES rather than rejects

`submit! confirm` today guards only: the gate is in the vocabulary, the node is not a leg root,
the node exists, and there is no undecided submission
(`src/commands/index.ts:606-611`). **It does not read the conclusion at all** — an exit gate can
be opened with no evidence behind it, and the reviewer is handed an empty card. That is a real
share of the reading burden: the material does not converge because it is not there.

The floor closes it, and it must read the **same predicate the close reads**, or the gate and the
close disagree:

1. `closeEvidenceBlocker()` is clean (`src/commands/index.ts:894-924`) — the F-AC18 predicate:
   commits cited, a captured pass bound to a cited commit, no captured failure on cited bytes.
2. `conclusion().unclaimed` is empty — every AC in the contract carries a claim.
3. every claim's check RESOLVES in the log (`!c.bound`) and none's latest run FAILED.

**Gap found while writing this.** Items 2 and 3 are the v18 conclusion gate, and they run in
`complete!` (`src/commands/index.ts:962-982`) but **not** in the `gate!` accept auto-close, which
reads `closeEvidenceBlocker` alone (`:665-666`). So today a confirm accept can close a task that
`complete!` would refuse for an unclaimed AC. The floor makes both paths read one predicate —
the "one predicate, every path" rule this codebase already applies to the gate checks.

**Fail-closed, and it costs nothing.** A floor failure burns no rejection, so the reject bound
(§7.6) is untouched by it, and the repair is a write the implementer can make without a human.

### 7.4 The judgement — the model FINDS, a rule DERIVES the verdict

The model is never asked for a verdict. It produces **findings in the existing shape**: the five
fields picked by `shapeFindings` (`src/flow/review-session.ts:368-380`), `REVIEW_SEVERITIES`
(`src/store/store.ts:347`), and `findingShapeProblem`'s requirement of
`id·severity·where·text·status·provenance` (`:364-385`) — the same mapper that picks the fields so
an invented one cannot reach the log. Note what that mapper already does with the sixth field:
`provenance` is **stamped by the engine, not taken from the model** — *"an author cannot be
forged"* (`review-session.ts:361-362`). §7.5 is that same pattern one level up.

The verdict is a **closed rule over severities**, in one place, deterministic:

| The findings, at `status: open` | Verdict | Why |
|---|---|---|
| any `gap` or `regression` | **rework** | a defect the reviewer can name |
| any `quality` | **human** | defective bytes with no contract defect — localized, so a person should look |
| `uncertain`, and nothing else | **human** | a review that settled nothing establishes nothing (the same invariant as an empty list) |
| `uncertain` beside findings that settled something | **accept** | the questions are raised, not decided — they ride the record, and the why names them |

**`uncertain` does not block, and that is a correction made on measurement (2026-09-27).** The
first rule sent any open `uncertain` to the human, on the reasoning directly below — and it made
`accept` **unreachable**. The worker was driven against the configured provider on deliveries the
floor had certified closeable, and **four runs returned `human`; none returned `accept`**. The
clean first pass of one landed *eight* `matches` and *five* `uncertain`s with nothing wrong
anywhere in the delivery.

The reason is in the severity's own definition: `uncertain` is *"a real concern you CANNOT
localize to a file and line"*. There is therefore nothing for the author to fix, the bytes never
change, and the next pass **re-states it** — the material tells the reviewer to, and it does. As
a blocker it is permanent, and a gate that is never accepted automatically is a gate the human
never left, which is the burden this section exists to remove.

**What keeps the original concern.** A reviewer that is vague cannot accept by being vague: an
accept must be **carried** — at least one finding that is not `uncertain` must stand behind it,
and a review that landed only questions goes to the human exactly as the old middle row did. The
questions are not swallowed either: they are on the record as findings, and the accept's
rationale names them (`CARRIED WITH n OPEN QUESTION(S)`), so the decision stays auditable and
`uncertain` still burns no rejection (only D-2's defects do).

The model therefore cannot *say* accept. It can only **find**, and the engine decides from what
was found. That keeps the decision auditable — the accept's rationale IS the finding set that
produced it (§3.3) — and it means a model that hallucinates a verdict in prose changes nothing.

### 7.5 The record must say who decided

§3.3 requires a rationale on accept; with a worker the rationale is the verdict. But a `confirmed`
the worker wrote would be **indistinguishable from one a person wrote**: `who` is self-declared
from `RECORDED_BY` (`src/commands/index.ts:388`, `src/surface/handlers.ts:157`) and lands only in
the note text. The codebase already has this pattern and its reason — the writer REQUIRES
`provenance` on a finding because *"an author-less finding is indistinguishable from a human's"*
(`src/store/store.ts:364-385`), and `shapeFindings` stamps it rather than trusting the model.

So the decision event gains a **provenance field, engine-stamped, never caller-typed**: the
engine knows whether it collected a human decision or ran the worker.

This is not bookkeeping. **D-1 removes the human from the exit gate, so the record is the only
place that fact survives.** Without it the journey cannot say how much of itself a machine
accepted, `check`/`verify` cannot report the ratio, and a sample audit after the fact is
impossible — the automatic gate would be unreviewable in principle, not merely unreviewed.

### 7.6 The bound, and the escalation that must now exist

`REJECT_BOUND = 3` (`src/commands/index.ts:88-90`), counted in `gate!` (`:655-660`). The 4th
rejection writes nothing, and the escalation it names — force-approve / restructure / block — is
**a string with no implementation** (`:658`; the only other occurrence is
`docs/flow-control-spec.md:43`). A prior design review already flagged the asymmetry this leaves
— *"gate exhaustion escalates to a human … That asymmetry may be intended; it is not argued"*
(`.agents/artifacts/design-review-v12.md:180`). D-3 is that argument, forced.

An auto-rejecting worker (D-2) makes that dead end reachable in three machine cycles. So D-3
makes the escalation part of this work, not a follow-up:

- **force-approve** — NEW. A human accepts over the worker's objection, and the override is
  recorded with the objection attached. This is the one genuinely new gesture, and it is what
  makes the bound a floor rather than a wall.
- **restructure** — the contract is frozen (`node.json` is immutable), so replacing it is
  `spawn!` a correct contract and `cancelled` the old one with a reason. Routing, not machinery.
- **block** — `deferred`, which already means *"postponed, the obligation stands"*. Routing, not
  machinery.

And the rule that makes the loop safe: **at the bound the worker is out.** Its next action is not
a rejection; the accumulated findings go to the human. A machine loop therefore always terminates
at a person — which is the property that makes an automatic gate safe to have at all.

### 7.7 The worker's absence degrades to the human, visibly

No provider, an unreachable endpoint, a refusal, a reply with nothing readable in it: the worker
cannot run. The submission stands, the card is presented exactly as today, and WHICH of the four it
was is named on the node as well as on the console (§7.11).

**Fail-OPEN toward the human, not fail-closed.** The reviewer is an ADDITION, so its absence must
degrade to the behaviour that existed before it; a journey must not stall because an endpoint is
down. But it must be **VISIBLE**: the card says the reviewer did not run, and why. Otherwise an
outage silently converts automatic gates into human gates and the policy change is invisible —
the "one word, two facts" failure this codebase keeps fixing.

### 7.8 The declared cost of D-1

Stated here rather than only in §9, because it is a consequence of the operator's choice and not
a defect of it:

- **The journey can be completed with no human having read it.** Not merely the exit gate — a
  task's ENTIRE record, contract included, may be machine-accepted. §7.5 is what keeps that
  *legible*; nothing keeps it *reviewed*.
- **The reviewer and the implementer are the same model.** A systematic blind spot is shared, not
  caught: the worker will be confident about exactly the things the implementer was confident
  about. The floor is the only part of this design that is not subject to that.
- **What is actually bought** is that the human's attention moves from 38 acceptances to the ones
  that matter — rejects, escalations, and whatever an audit surfaces. That is the trade, and it is
  a real one; it is not free.

### 7.9 The honest reading of §7.4's middle row

Written when `uncertain` still sent a gate to the human, and kept because the hazard it names
survives the correction: a worker that marks **everything** `uncertain` and settles nothing is
still sent to the human by the carried-exactly-nothing rule, so the escape hatch is narrower but
not sealed. A worker that marks most things `uncertain` *while settling some* now accepts, and
the questions ride a decision a human did not read. That is the trade the correction makes, and
it is detectable rather than prevented — §7.5 records the actor, and the accept's own why names
the carried questions, so the ratio is cheap to read. The implementation should keep it cheap to
read rather than assume the worker is well-behaved.

### 7.10 The re-review — the worker's door was the SUBMISSION, so a standing gate had none

§7.2 gives the worker exactly one door: the confirm **submission**. `submit!` refuses a
re-submission by name (`already-submitted`), the frame stops at `blocked-at-gate` before it
reaches `reviewGate`, and no route builds a review. So a gate ALREADY OPEN — opened before the
worker existed in the running binary, or opened while the worker was absent (§7.7) — could not
be reviewed at all. Measured 2026-09-27: **eight confirm gates stood undecided with no review on
any of them**, every one of them opened before the worker shipped. D-1's premise (the human
leaves the exit gate) held only for gates opened after it, and every gate already standing was
the human's by accident of timing rather than by design.

`ann gate! <id> confirm --review` closes that gap. It is a second **caller** of the same worker
against the submission already standing, never a second path: one worker, one writer, one
derivation, no new event type, no new state, no new loop. The verdict lands through
`commands.gate` with the engine-stamped worker actor, exactly as it does at a fresh submission.

```text
gate! <id> confirm --review
  ├─ the four refusals — decided BEFORE anything is spent, zero writes
  │    review-not-confirm        the gate is not 'confirm' (a grill: the entry gate is the human's, §3.2)
  │    review-takes-no-decision  an accept|reject given BESIDE the flag: the flag IS the decision request
  │    review-no-submission      no undecided submission stands (already decided, or never opened)
  │    review-with-flag          --force, or --transfer/--scope, composed with it
  └─ runGateReview(<id>) — the SAME call `submit!` and the frame make
       accept  → reported with the findings count and the why
       rework  → reported with the worker's own feedback; the rejection routes the re-execution
       human   → an OUTCOME, exit 0, naming the reason: nothing written, no rejection burned
       absent  → a NAMED FAILURE, exit 1, zero writes — see below
```

**The absence is the one place the two doors differ, and deliberately.** §7.7's rule — absence
degrades to the human, visibly — governs a submission **nobody asked** to review: the operator's
gesture was `submit!`, and the gate's being theirs is the fallback they already expect. At an
explicit `--review` the operator **asked and did not get one**, so degrading silently would
swallow the request by dressing it as a degradation. It fails instead, by name, with the
submission untouched.

**CLI-only, and unreachable from every route by construction.** `POST /api/gate` decides a gate
with `{id, gate, decision, feedback}`; it carries no gesture flags, and the flag cannot be
smuggled as a value either — the route refuses any field whose value is a `--`-prefixed token,
so `{decision: "--review"}` is a 400 rather than a review, and `{feedback: "--force"}` is a 400
rather than an override. This is why the served page can never re-review: the gesture is a
terminal one, and the route would have to grow both a field and an `await` to reach it.

**The first run, measured (2026-09-27).** The flag was run against all eight standing confirm
gates — every one of them opened 2026-09-25/26, before the worker existed in the running binary.
Seven model calls, plus one gate at the bound which cost none:

| gate | verdict | what happened |
|---|---|---|
| 11-decision-record | accept (14 findings) | closed; 5 questions carried in the why |
| 14-leg-gate-derivation | accept (10) | closed; 3 carried |
| 21-every-write-commits | accept (18) | closed; 4 carried |
| 22-automatic-exit-gate | accept (15) | closed; 6 carried |
| 10-idea-area | **rework** (10) | three `gap`s: the delivered `idea` gesture is not the one AC-2 spells |
| 12-accept-with-transfer | **rework** (12) | the composed act omits the `gate-revised` half AC-1 names |
| 13-transfer-affordance | human (10) | an open `quality`, no contract defect — nothing written, no rejection burned |
| 23-criterion-evidence | human (0) | at the bound: the worker is out, and the check cost NO model call |

Four closes, two reworks owed, two still the human's; `ann check` and `ann verify` clean after
every write. Two things this establishes that the design only asserted: the bound really is
checked before anything is spent (§7.6), and a `rework` on a days-old delivery is the engine
working rather than a dead end — the delivery returns as a second round with its own evidence,
exactly as a human's rejection does. This node's own confirm gate was then routed to rework by
its own worker, on one real defect (the record above was not in the reviewed bytes), which is
the loop doing what §7 says it does.

### 7.11 (added 2026-09-27) — where each arm is recorded, including the two that were not

§7.4 gives the rule four outcomes. §7.5-§7.7 gave the two DECIDING ones a record and left the
other two to the caller's memory. Measured 2026-09-27, on the two gates above: `12/13` **was**
reviewed — one pass, ten findings, one open `quality` (`transferNotLive` returns `undefined` when
the confirm read itself fails) — and `12/23` was **never** reviewed, because three rejections
were already burned and `runGateReview` returned the human card before the model call. The two
cards carried the SAME next-line, `waiting on a decision — confirm (exit) is in WAITING ON YOU`,
so the reviewer that ran, the reason it declined, and the bound that stopped it were absent from
the bytes a human reads. The operator's own complaint (§7's premise: *"too much to read"*) has
this as its mirror image — a gate that says nothing, so everything must be re-derived by hand.

| The arm | What is recorded | Through |
|---|---|---|
| **accept** | the decision itself: `confirmed`, actor `worker` | `commands.gate` — unchanged, §7.4 |
| **rework** | the decision itself: `rejected`, actor `worker`, the worker's own feedback | `commands.gate` — unchanged, §7.4 |
| **human** | an OUTCOME riding the findings landing: that a review RAN, its date, the anchor sha it was read at, the run id, the findings count, and the reason the rule derived it | the ONE findings writer — `evidence.outcome` beside `evidence.findings` on one event |
| **absent** | the same class of record, with NO findings: WHICH absence it was (`unavailable` · `unreachable` · `unparseable` · `empty`) and the reason, plus the run id | the same writer, on all three paths — `submit!`, `gate! --review`, the frame |
| **bound** | **nothing** — and the absence of a record is the correct record | derived, from the rejection events, where the other outcomes are stated |

Six things this table settles that were being inferred:

- **The two deciding arms are already recorded, and are deliberately not restated.** Their
  decision IS the record; an `outcome` field beside them would be a second account of one fact,
  and would have to be kept from drifting from the decision it restates. The writer refuses a
  deciding verdict in `outcome` **by name**, so the two cannot disagree.
- **The bound is derived, not written.** A review that never ran must not put a review's outcome
  in the log. The bound is a property of the gate — `REJECT_BOUND` burned rejections — and it is
  read from the events that already say so, at no model-call cost. It takes PRECEDENCE over any
  recorded outcome: when the worker is out, what an earlier pass concluded is not the live fact.
- **The contract's four absences are four RECORDABLE names, one per place the worker stops.**
  They are kept apart because the remedy differs and a single word sends the reader to the wrong
  one: `unavailable` — the worker could not be **built** (no provider registered, an adapter that
  will not construct), which is fixed by configuring a provider; `unreachable` — the worker could
  not be **reached** (the call threw: a refused connection, a timeout, an HTTP failure), which is
  fixed by waiting for an endpoint; `unparseable` — an answer arrived and is not the strict JSON
  findings record; `empty` — an answer arrived with no findings at all. The first is landed by
  `attemptGateReview` (the seam throws before the worker exists, so the worker's own writer never
  runs); the other three are landed by `runGateReview` itself, each at the exact line the worker
  stopped. All four ride the same writer with the same shape, so a reader tells them apart by one
  field rather than by the shape of the record.
  A write the STORE refuses is the one absence that cannot be recorded at all — the write is what
  failed — so it is `ann check`'s business, not an outcome value's; `landFindings` returning not-ok
  puts the store's own refusal in the REASON on the surface rather than inventing a fifth name.
- **A refused `--review` is not an absent review, and writes nothing.** The four refusals
  (`review-with-flag`, `review-not-confirm`, `review-takes-no-decision`, `review-no-submission`)
  are decided BEFORE `attemptGateReview` is called. Each says the gesture does not apply — there is
  no submission for a worker to review, or the flag composes with nothing — so no review was asked
  for and none can be absent. Recording one would put a review's outcome on a node on which no
  review was ever requested, which is the class of false record `outcomeShapeProblem` refuses. What
  AC-2 requires on every path is that an absence is recorded ONCE — and `attemptGateReview` is the
  single seam every path that actually runs the worker goes through, so the record cannot be
  duplicated by which door was used.
- **The three lines are composed once, in the engine** (`ReviewStanding.line`), and printed
  verbatim by three surfaces: `ann brief`, the served card, and the page's next-line. The page's
  script cannot import engine code, so wording placed in a renderer would have to be written
  three times — which is how one gate ends up with two different sentences, the failure this
  section exists to remove. Each line names its reason, and the reason is the RECORD's own words,
  never a re-reading of the severities (`deriveGateVerdict` stays the only thing that names an
  arm, §7.4).

**Corrections this makes to §7.10.** The `--review` sketch there reads `human → an OUTCOME …
nothing written` and `absent → a NAMED FAILURE, exit 1, zero writes`. Both were true when
written and are now false in one word each: nothing is **decided** and no rejection is burned,
but the OUTCOME itself lands through the findings writer — including for an absence. §7.10's real
claim survives intact and is narrower than it reads: nothing is SPENT and nothing about the gate
changes before a decision exists.

**One visible consequence, recorded rather than discovered later.** An outcome-only landing is an
`evidence` event with no commits and no refs, so it appears in the RESULTS list as an
informational row (`ann results <id>`) — exactly as a findings landing already does. Repeated
absences of the same kind collapse to one row by the list's own dedupe, since the note is
identical.

## 8. Hazards the implementation must carry

- **The model's material and the human's material must be ONE assembly.** `brief` is documented
  as what the advisory session consumes (`src/commands/index.ts:1003`), but `buildReviewMaterial`
  (`src/flow/review-session.ts:229-348`) builds a SECOND assembly from `assemblePacket` + the log
  and never calls `brief`. A worker reviewing different facts than the card shows can disagree
  with the human about what happened. Fix the read, not the doc.
- **`confirmedSha` is doc-only.** `journey-format-spec` §3 and `core-design` say the commit
  refuses on mismatch; no code compares it (`src/commands/index.ts:617`, `src/store/store.ts:1770`
  — the field is shape-checked, never bound). The reviewer's real binding is the CITED commits
  (`conclusion().cited`), which `capturedPassBound` already enforces. Say which, and name the
  doc-only field as a gap rather than relying on it.
- **Self-accept must be detectable, not merely asserted.** The worker is a fresh call, but the
  same RUN can implement and then submit. The acceptance should record the run that produced it,
  so `check` can flag an accept whose reviewing run equals the implementing one. Without it, "a
  separate worker" is a claim about a prompt, not a property of the record.
- **Cost is bounded by the reject bound.** At most `REJECT_BOUND` reviews per gate per submission
  cycle, one model call each over the brief + diff. State it, so an unattended `run!` cannot spend
  without limit.
- **The entry gate's own hazards (§4) are untouched** — and the escalation must not become a
  second way to clear GATE-1.

## 9. Open questions (with defaults, per the node-contract pattern)

- **OQ-1 — does the worker run for a gate opened by the DRIVER?** Three recorded boundaries say
  no: `.agents/plan/self-driving-design.md:49` — *"RULES never decides a gate"*; `:79` —
  *"worker-side gate decisions (never, by protocol)"*; and
  `.agents/plan/gate-session-design.md:131`, which scope-outs both *"the driver starting sessions
  by itself"* and *"mandatory sessions (the gate stays a one-gesture decision; the session is
  optional help)"* — a worker that decides makes it a ZERO-gesture decision. Answering YES makes
  `run!` able to close a task with **no human in it at all**. **Default: YES, and revise those
  three records in the same change** — the alternative gives one gate two behaviours that differ
  by CALLER, which is the "one word, two facts" failure this codebase has fixed repeatedly. The
  revision is the honest form; a silent divergence is not. This is the single most consequential
  open question here, and it is why §8 requires the run to be recorded.
- **OQ-2 — what happens to the advisory session?** `gate-session-design.md:131` designed it as
  *"optional help"*, not a mandatory step. With the human out of the exit gate its original
  purpose narrows. **Default: it survives unchanged, and its role sharpens** — it becomes the
  instrument a human reaches for at an ESCALATION (§7.6), where they must decide for real and have
  the least context. It is not obsoleted by the worker; it is repositioned.

## 10. What §7 changes in code

| § | File | Change |
|---|---|---|
| 7.3 | `src/commands/index.ts` (`submitImpl`), `src/store/store.ts` | the floor: ONE predicate, read by `submit!` and by the accept auto-close |
| 7.4 | new `src/flow/gate-review.ts`; reuses `review-session.ts`'s profile + `shapeFindings` | the headless reviewer + the severity→verdict rule |
| 7.4 | `src/commands/index.ts` (`gateImpl`) | the worker's decision writes `confirmed`/`rejected` through the SAME writer |
| 7.5 | `src/store/store.ts` (gate shape check, beside `:1763-1766`) | the decision gains engine-stamped provenance |
| 7.6 | `src/commands/index.ts:655-660` | force-approve as a gesture; restructure/block routed to `spawn!`+`cancelled` / `deferred` |
| 7.7 | `src/surface/*` (card) | the reviewer's absence is named on the card |
| 7.11 | `src/store/store.ts` (`outcomeShapeProblem`) · `src/commands/index.ts` (`landFindings`) | `evidence.outcome`: the closed shape a non-deciding arm writes, through the findings writer |
| 7.11 | `src/flow/gate-review.ts` (`runGateReview`) · `src/surface/handlers.ts` (`attemptGateReview`) | both non-deciding arms land the outcome — the CLI's two doors plus the frame's |
| 7.11 | `src/store/store.ts` (`REVIEW_ABSENCES`) | the four absences, one per place the worker stops: built · reached · read · non-empty |
| 7.11 | `src/commands/index.ts` (`reviewStanding`) · `src/surface/*` | the three standings, composed ONCE and printed by `ann brief`, the card and the page |
| 7.10 | `src/surface/handlers.ts` (`gate!` → `reviewStandingSubmission`) | the `--review` gesture: the four named refusals, then the SAME `runGateReview` call |
| 7.10 | `src/surface/service.ts` (`POST /api/gate`) | no field of the route may carry a flag — the gesture stays CLI-only by construction |
| 8 | `src/flow/review-session.ts:229` | `buildReviewMaterial` consumes `brief` — one assembly |
| 8 | `src/store/store.ts` (acceptance record) | the reviewing run id, so self-accept is checkable |

Reuse, do not rebuild: `review-session.ts`'s profile and `shapeFindings` mapper ·
`REVIEW_SEVERITIES` / `findingShapeProblem` (`store.ts:347,364`) · the derived `rework` state
(`workflow.ts:316-323`) · `closeEvidenceBlocker` (`commands/index.ts:894-924`) · `conclusion()` ·
the frame's `escalated` stop (`frame.ts:334-338`), which already exists and becomes real.
