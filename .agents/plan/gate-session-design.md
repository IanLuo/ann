# The gate session — the walk, and the session at the wall (design record, pre-spec, DRAFT)

*Status: DRAFT — feeder for SPECS sessions. Nothing in force until it lands as doc amendments + code. Sibling of `self-driving-design.md` (the runner/dispatch endgame); this record covers what happens **at a stop**.*

## The endgame (the human's statements)

> *"At the gate the user can employ the review worker to get a review result as additional help."*
> *"It's not exactly just `reviewer`, it can be an advisor, who knows the journey well."*
> *"Make the worker interactive: a round of review, then the user can continue to discuss with it until they find what they need."*
> *"When we start a project we set a goal, grill it, into specs, design artifacts — different workers' job, but we could find a pattern… then we can use it, with different workers, but familiar for the user and constant internally."*
> *"Can we use the pattern for all those scenarios?"*

The claim of this record: **the pattern is the step contract, and the gate is where it runs.** Nothing new is designed here — three things are *joined*: the walk (built), the session engine (built — four profiles), and the gate (built). What is missing is a **profile for a review at the gate** and the **record shape** its findings land in.

## 1. The walk (what actually advances the journey)

Four altitudes; each has its own walker and its own stopping rule:

```
 goal ── goal! met | goal! archive ................................. human only
   └ leg ── spawn! | the authored-work boundary .................... human only
       └ task ── advance! (approve → execute) ..................... human-approved walk
       │           └ frame ── materialize → [grill] → execute → verify → [confirm]
       │                        walks CHAIN STEPS, stops at the first undecided GATE
       └ task ── run! / drive (the LLM loop, a CLOSED set) ........ machine walk
```

**Two walkers, one walker-core.** `advance!` (one unit per human approve; sanctioned writers only) and the semantic driver (`run!`/drive: multi-turn, every call validated against a closed set) both drive the **same Frame**. Step-walking, the transcript, the gates and the bounds are identical for both — that is the "constant internally" property, already true in code.

**`advance!` is ONE DERIVED UNIT, not one chain step.** `continue-leg` hands one task to the frame; the frame walks the chain steps and stops at the wall. `operator-action.ts:188-244`, flow-control-spec v7 §2.

### The branches — every "otherwise" is a named stop, zero writes (never a retry)

| Gate of the action | Otherwise |
|---|---|
| integrity clean (rule 1) | `refused-integrity` — store drift · uncommitted tracked journey/docs · a gate gap · a stale manifest |
| the derivation still matches (rule 2) | `stale-proposal` — a point-in-time approve executes nothing |
| the human approves (rule 3/AC-6) | `declined` |
| the derivation IS executable | `boundary` — **advance-leg · closure-needed · none are NOT machine-executable**: card + stop. It never spawns a leg, never authors a contract, never self-closes (the authored-work boundary, v7 §5) |
| — | then the frame stops on: `blocked-at-gate` (a submission awaiting the human) · `blocked-waiting` (the runner owes the evidence commit) · `escalated` (the reject bound, 3/gate) · `stopped/failed` (a step failed or a verdict did not route — fail-closed) · `completed` |

Orientation check — `advance!` **is** "one step at a time" at the *journey* altitude (one gesture, one unit) and **is not** at the *chain* altitude (many chain steps per gesture). The bounded loops live inside the walk, not around it: the rework rung (a grill reject re-materializes from the feedback, bounded by `gate!`'s constant 3/gate), the verify cycles (`flow.verifyFailCycles`), the driver's `maxTurns`.

### THE WALL RULE (the load-bearing one)

**A step that binds a gate (`at:`) with no decision is a wall. The walk always ends there.** `frame.ts:313` (tail state 2): a `submitted` gate returns `blocked-at-gate` — the frame never decides an undecided submission.

Three writers can decide a gate, and they land the same event:

1. **a bound step's verdict** — `at: 'grill'` + `verdict: {decision → {gate: 'accept'|'reject', feedback?}}` (e.g. `idea-validate` in `rules/flow/default.json`); the step asks the human through `abilities.interact` and the frame writes `submit!` + `gate!` (`frame.ts:329-331`);
2. **the frame's present-fallback** — a gate with no bound step: present the contract, then a bare accept/reject through `interact`;
3. **the human's direct `gate!`** — the page's Accept/Reject (the L1 gesture).

The **daemon channel can only do (3)**: it is present-only, so a gate the frame wants to decide live is refused **by name** with zero writes, and a submitted gate returns `blocked-at-gate`. *A terminal session is a walk; the page is a wall.*

**And the decision's `feedback` is the rework channel** (`ctx.feedback {gate, text}`, core-design §2): a **grill** rejection re-enters at `materialize` (every step runs fresh with the feedback); a **confirm** rejection re-enters at `execute` (grill-bound steps replay from the transcript — the human is never re-interviewed).

## 2. The session at the wall (the pattern, already in the step contract)

The session is the *content produced at the stopping point*. Slot for slot, it is the chain step:

| Pattern slot | The contract that already has it |
|---|---|
| **Anchor** — which stop | `chain entry.at? : 'grill' \| 'confirm' \| 'execute'` |
| **Role** | `step.id` · `roles[]` · `decisions[]` (the closed set it may produce) |
| **Inputs** | `ctx.packet` (bounded excerpts) · `ctx.prior` (role-bound) · `read.resolve(requiredInputs)` · entry `inputs: {role → source}` |
| **Rounds** | `ctx.abilities.interact` — answers recorded as transcript records and replayed **by question identity**; the human is never re-asked |
| **Record** | `out = {ok · artifact? · verdict?{decision ∈ decisions[], feedback?} · intents?[]}` + the transcript (`llm`/`ask`/`research`/`decide`/`verify`/`skip`) |
| **Bound** | the attempt boundary · `runId = 1 + rejections at the bound gate + verify cycles` · the phase chain · `flow.verifyFailCycles` |

**The two families are already expressible in the registry** (`.ann/rules/flow/default.json`, v3/v4):

- **deliberation** = a non-empty chain of interactive steps — the live `default`: `idea-validate` (`at: grill`) → `envision` (when the grill's verdict says ambiguous) → `spec`; steps registered in `src/flow/steps/`.
- **execution** = `"implementation": []` — an **empty chain**: *"the runner does the work, outcomes arrive as observed evidence commits."* No interact rounds; the loop is the frame's phases + verify cycles.

So the round driver differs, and it is one field — the *ability* the step reaches for: `abilities = {llm, interact, shell, tool}`. Deliberation drives `interact`; execution drives `tool`/`shell` + `rules`. Nothing else varies.

### The session engine and its profiles ALREADY EXIST (four instances)

The pattern is not aspirational here — it is extracted code, proven four times:

- **The core: `src/flow/grill-session.ts`** — `GrillSession`, explicitly *"AREA-NEUTRAL… knows nothing about 'goal', 'product', or any specific area."* It already solves what an interactive session needs: the round loop (**grill → batch answers → an LLM RESPONSE/synthesis turn → a bounded DISCUSS (`maxDiscussTurns`) → an explicit DECISION**), the menu (`GO · dig more · refine · skip`, and the exhausted variant with no "dig more"), **exhaustion-driven end** (with an anti-runaway ceiling as a safety net, never the UX driver), **never re-ask** (the dedupe labeler), research only on advice + agreement, **provider failures fail closed**, and `InteractAbort` (the human walked away) → an honest REJECT rather than an inferred answer.
- **The shared helpers: `src/flow/session-shared.ts`** — the dedupe labeler · unresolved-answer detection · the human channel wrapper.
- **The profiles — the ONLY per-area data:** `GOAL_PROFILE` (`goal-grill.ts:97`) · `SPECS_PROFILE` (`spec-grill.ts:103`, driven through `spec-doc.ts`) · `DESIGN_PROFILE` (`design-grill.ts:102`) · the idea-validate session (`steps/idea-validate/session.ts`).

So **the role row of §2 is a `GrillProfile`**, and "different workers, familiar to the user, constant internally" is what this codebase already does: the loop is constant, the profile varies. The advisory/review session is **a fifth profile — not a new engine.**

### Three output kinds — and only one needs new storage

| Output | Home | Status |
|---|---|---|
| **the why** (the rationale) | the gate decision's `feedback` — `gate!` already carries it on the **accept** path; the writer validates it is a string | exists; unused in practice |
| **questions / decisions** | `openQuestions` (v14, `blocking`) + the ladder's `provenance: how: discussed · defaulted · inferred` — the spec already *requires* high-impact decisions be `how: discussed` | exists; the session is its natural producer |
| **findings** | a `review` payload: `{id, severity, where, text, status}` | the only new record shape (precedent: `evidence.answers[] {id, answer, provenance}`; the trace `kind:'decide' {options[]}`) |

**No parallel store** (the companion guide's own rule: *"memory can be richer events"*). **The chat is the surface; the consensus — findings, rationale, questions — is the record.**

### Familiar to the user, constant internally

- **Familiar**: one verb set at every stop — **Discuss · Decide · Drill** — whatever the role behind it. (Feedback on this record: `self-driving-design.md`'s 12/04 adds **DRIVE**; the page has **Decide** today; **Discuss**/**Drill** are the missing two.)
- **Constant**: one step contract, one transcript, one record vocabulary, one bound mechanism. The ONLY per-scenario artifacts are a **registry row** (data: workType → chain) + a **step implementation** (code) — the data/code line the resource registry already draws.

## 3. Why now — the case, from this project's own data

Measured this session, all reproducible:

- **A review's findings are not a record.** `12-operate-loop/08`'s rejection stored a 3244-char **digest** as gate `feedback`; F1–F11/G1–G6 were unreachable through the journey (`ann --json confirm`). They were recovered only from the *reviewer's chat transcript* (`~/.pi/agent/sessions/.../2026-09-14T15-10-39-*.jsonl`).
- **So the rework's fix claim was unverifiable — and false.** Of the 11 findings routed to one cleanup pass: **1 fixed** (F5), 2 no-action-by-design; **8 still open** (F4 · F6 · F7 · F8 · F10 · G2 · G3 · G4 · G5), plus G1 half-fixed (the reviewed line corrected, the identical false claim alive at `approve.ts:212`). "Everything found was fixed" was asserted because there was nothing to check it against.
- **The why is the memory's biggest hole.** Across the live journey's 29 tasks: **49 accepts, 31 with a recorded rationale (18 bare); 4 rejects, 4 with one.** The channel is used exactly where the loop *forces* it (a reject feeds a rework) and lapses where nothing does. Nothing checks the accept's why — so it is lost at the gate, which is the only moment it exists.
- **The steps' input slots are never filled.** **0 of 41 live / 0 of 70 archived nodes bind any `requiredInputs`** → every packet's `dependencies` is `[]` (context-packet-spec v1 §2's `name · status · path · sha · excerpt` machinery, exercised zero times). F-AC19 enforces that a *declared* input resolves; nothing requires one to be declared.

The four gaps are the same shape as `12/08`'s own finding — **a fact re-derived or asserted per reader, instead of recorded once** — now at the level of the *decision* rather than the gate state.

## 4. The gaps (small, named, data/code split)

| # | Gap | Kind |
|---|---|---|
| 1 | A **`REVIEW_PROFILE`** over the EXISTING core (`grill-session.ts`) + its session wiring and work-type / chain row. **Reuse the loop; do not rebuild it** — dedupe (never re-ask), the anti-runaway ceiling, the synthesis turn, `InteractAbort`, and provider fail-closed are already solved | **CODE** (a profile ≈ the size of `DESIGN_PROFILE`) + **DATA** (a row) |
| 2 | The **findings record shape** — one structured payload on the review/decision record | amendment (precedent: v14's `trace`/`answers[]`) |
| 3 | An **interact turn budget** — the sibling of `flow.verifyFailCycles` (`interact` handles "the human walked away"; it has no bound) | config + rule |
| 4 | The **gate affordance** to start/continue a session (DISCUSS beside DECIDE; 12/04's sibling) | UI + route |
| 5 | **Inputs the session can read**: bind the defining docs (`requiredInputs`) + record the submission's **base commit** (nothing records it today — the range is reconstructed by convention from `evidence.commits[]`) | contract discipline + one field |

## 5. NOW — the minimal scope (ONE step, proven on a live gate)

- **The role: `review`** (only) — a fifth **`GrillProfile`**, `at: confirm`, driving `interact`, whose inputs are the packet (contract · ACs · dependencies · evidence · captured checks) and whose record is the findings payload. `DESIGN_PROFILE` is the closest existing shape (a critique session) and the template to copy. `advise` (open-ended, no record obligation) is the *same profile* with a looser output contract — later.
- **The session shape**: a turn budget · findings written **as asserted** (a session that dies mid-way must not lose them) · an explicit done gesture that writes the record and lands at the gate · **never decides a gate** (no self-accept; independence).
- **THE TWO ORACLES — the acceptance test is already on the page.** `12/08`'s pending confirm gate:
  1. the session must independently reproduce **F4**, **G1**'s surviving half and **G5**, and report **"8 of 11 prior findings still open"** — the recovered list is the answer key;
  2. the session must end with *the human's* why on the record — today it would be the 19th accept/decision without one.
- **SCOPE OUT (recorded, not dropped):** other roles (design · validate) · mandatory sessions (the gate stays a one-gesture decision; the session is optional help) · cross-level sessions (they are task-hosted: a closure task has its own chain and gates) · the driver starting sessions by itself · the container/remote form.

## 6. Open decisions (for the human) and risks

1. **Where the record lands**: the gate decision's `feedback` (no amendment; the rework path already reads it) vs a first-class `review` record (verifiable per-finding status on re-review). This record argues for the latter — it is the difference between "asserted" and "checked" in §3.
2. **Whether the accept path should require a rationale** — the reject path is forced by the loop; the accept path is where 18 whys were lost in this journey alone.
3. **Turn budget value** and whether a session may outlive the gate it started at.
4. **Risk — persuasion without checkability**: every claim carries `file:line` and is re-checkable, or the session is worse than none (it invites rubber-stamping).
5. **Risk — the session eats the stop**: make it optional and cheap to skip; a gate must stay a one-gesture decision.
6. **Risk — the model's memory vs the journey's**: "knows the journey well" must mean *cited retrieval over the packet + the tree*, never accumulation in context (a second, drifting memory is the dual-write sin in prose).
