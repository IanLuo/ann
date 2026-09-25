## Link contract
- **upstream** (this doc relies on): docs/flow-control-spec.md,docs/journey-format-spec.md,docs/core-design.md,docs/goal.md
- **referrers** (must cite this when they change): functional-spec,resource-registry,architecture,journey-format-spec

# Gate Cadence (v1)
*Type: spec. DIRECT-AUTHORED, not produced by a `spec!` session — the SPECS session's GO is a human decision and was not driven; recorded as a deviation per the v18 precedent (`10-server-ui/05-implementation-journey-format-v18`). Provenance: the operator's standing complaint, 2026-09-22 — "too many human gate, too much to watch". This spec fixes the shape; the producing task is spawned after its GO. Upstream: `flow-control-spec`, `journey-format-spec`, `core-design`, `goal`.*

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
`store.ts:1742-1756`) and it is currently optional. It becomes **required on accept**, for both
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
| 3.3 | `src/store/store.ts:1742-1756` | `feedback` required on gate accept, fail-closed |
| 3.4 | `src/store/store.ts:1710` (+ shape check) | `extended` gains optional `kind` |
| 3.5 | `src/store/workflow.ts` (beside `gateView`), `src/store/store.ts` (`gateProblems`) | the effective-accept comparison, one place, both consumers |

Reuse, do not rebuild: `resolveChain` (`src/flow/chain.ts:123-160`), `phaseOf` (`chain.ts:75`),
the `docsIndexFresh` freshness pattern (`src/store/docs.ts:86-92`), and the existing gate
shape-check neighbourhood (`store.ts:1742-1756`).
