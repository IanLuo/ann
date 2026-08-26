# Ann Core Design — v5 (draft, for review)

*Re-implementation target. The locked substrate (journey-format v13, store single-writer, packet spec, provider adapter, S4 validators, honesty-layer engines) stays. Incorporated: design reviews #1–#4 (2026-08-25). The design target: a system that is SIMPLE and FLEXIBLE — the machinery is small and stable; everything that varies (flows, steps, chains, gate sources, rework) is ADJUSTABLE DATA, so later flow changes are sound changes, not design changes.*

## 0. The model

The product is the journey. The journey is data: nodes, events, artifacts — status **derived** from the event tail, never asserted. A journey moves through a **fixed frame**: materialize → grill gate → validate → activate → execute → verify → confirm gate → commit → look-back → advance. The frame runs the current task's **chain of steps**; steps are **pure units** that receive injected state and declare **intents**; the flow translates intents into store writes **via the command layer**. The human is a seam: present, ask, research, decide. **Commands are the only interface to the store.**

## 1. Layers + the invariant-ownership table

```
L3  UI + ABILITIES   human channel (present·ask·research·decide) · llm · tool/command ·
                      read view. Servants: injected into L2 seams, work as the flow
                      moves. Implement L2-defined interfaces; never imported by
                      L2/L1/L0.
L2  FLOW             THE RESUMABLE COORDINATOR. Owns: the frame (lifecycle), steps +
                      chains (data), intent → command translation, gate observation,
                      bounded rework, advance/spawn proposals. Reads L1; writes ONLY
                      via L1; defines the step/intent/ability interfaces; ability
                      implementations injected from L3.
L1  COMMANDS         THE STORE'S INTERFACE — the ONLY path to the store.
                      Reads (derived views: status · packet · flow · results ·
                      look-back · specs · check).
                      Writes (the mutators): spawn! · append! · gate! · lock! ·
                      supersede!. COMPLETE over the event vocabulary: every event
                      kind is writable (append! is the generic strict-schema path;
                      the composite commands encode invariants — gate sequence,
                      artifact sha, per-name supersession, reject bound, contract
                      schema).
                      MULTI-CLIENT BY DESIGN: the CLI binds commands to argv, the
                      flow binds them to its logic, a future web server binds them
                      to HTTP. (This amends architecture @ e6d07ed:24,61 — "the
                      kernel is the only initiator"; new statement: COMMANDS are
                      the only initiators, the flow is the primary command client.
                      The single-WRITER invariant is unchanged.)
L0  STORE            JOURNEY DATA — node.json (immutable contract) · events.jsonl
                      (append-only, tasks) · artifacts (locked files) · registries
                      (rules/schema/flow). Single writer (appendEvent), strict
                      schema (v13 §3), derived views (status/current/results/check).
                      Knows nothing above.
```

**THE INVARIANT-OWNERSHIP TABLE** (per invariant, the enforcing layer — the line between adjustable and protected):

| Invariant | Layer | How |
|---|---|---|
| gate sequence: no `artifact-locked`/`completed` without the prior gate confirmed; no `confirm` gate without `grill` | **L0 — store** | `appendEvent`/`validateEventShape` refuse the write. Unconditional for NEW writes; the legacy `retrospective`-note path and prose gate-parse are GRANDFATHERED for history only — the re-implementation removes them from the new write path (machine-truth, NFR-COM-1; review-4 N8) |
| single writer: only commands write | **L1 + L0** | every write path ends at `appendEvent`; L2/L3 never touch the store |
| leg status derived, never asserted | **L0** | derived views only; no component writes leg events |
| **node.json contract schema (v13 §2 + the v13 amendment, §2 below)** | **L1 — `spawn!`** | `spawn!` enforces the enumerated schema + unknown-fields-rejected + F-AC19 (hard reject) + id naming/prefix/sibling clash + artifact gate (children after parent concluded) + leg gate — today these live in the CLI (`cli.ts:696-728`); the re-implementation moves them INTO `spawn!` (review-4 N7) |
| reject bound: 3 per gate, then escalate | **L1 — `gate!`** | `gate!` counts rejects and refuses the 4th; `append!` REFUSES event kinds owned by composite commands (`submitted`/`confirmed`/`rejected`/`artifact-locked`/`superseded`) so the bound is not bypassable. L2 observes the count only to route escalation (one owner, one reader) |
| one-current-per-name | **L1 — `lock!`** | the store refuses a lock on an already-current name |
| F-AC16 closure integrity · F-AC18 conclusion + traceability | **post-hoc `check()`** | `check()`-time validations, not write-path invariants — stated, not claimed as enforced |
| chain validity · intent ordering · gate-source routing | **L2 — flow** | conventions, not invariants — statically validated before execution (§3/§6); bypassable only by another L1 client writing raw events, which the composite-kind refusal blocks |

**The coordination loop:** get store info (L1 reads) → work the current task → run the step interface → translate intents → emit via L1 → observe gates → repeat. **Resumable**: any interruption (pending gate, rejection) leaves the task blocked/pending in the store. **The frame's driver is ONE idempotent advance operation**: it runs phases until it blocks, then stops; **the resume point is DERIVED from the event tail — never stored**: a phase whose outcome already exists in the log is SKIPPED, not re-run (a gate whose decision is already in the tail is not re-obtained — this is what makes "never double-presents" true; review-4 N13). **L2 is not a monolithic loop** — gates are L1 writes the flow observes (`pendingGates`), never assumed.

## 2. The step contract + the flow-data fields

```
step = { id, inputs[], rules[], execute(ctx) }
ctx  = { taskId · packet (materialized state, injected) ·
         params? (this chain entry's params — the parameterization channel, review-4 N6a) ·
         read (narrow read view — an ability) ·
         abilities { llm · interact · tool · command } (L3 seams) ·
         prior (earlier steps' artifacts — a locked artifact is automatically
                available downstream; on a re-run, prior resolves from the LOCKED
                artifact, never from fresh in-memory content — review-4 N1) ·
         feedback? (last rejected.feedback for this task — the rework channel) }
out  = { ok
         artifact?  — in-memory result for DOWNSTREAM steps (or via the locked artifact)
         verdict?   — a GENERIC human-decision outcome: {decision, feedback?}
                      (the flow routes it via the chain entry's verdict map — never
                       reads step internals; an unmapped decision → fail closed, named)
         intents?[] — what the step wants done; the flow translates to L1 writes }
```

Rules:
- **A step never touches the store or the CLI.** State arrives injected (packet + read + prior); effects depart declared (intents + verdict). **Steps have no write hook** — the flow is the only writer. (The two-log trace survives at the ABILITY layer: `llm`/`interact` emit runtime task-fact events through an L2-owned record hook that ends at `append!` — so a multi-round session leaves a durable per-call trace even if it crashes before returning; review-4 N11. Steps do NOT duplicate in intents what their ability calls already emitted.)
- **Two `inputs[]` semantics, NAMED:** a packet-dependency input resolves to the bounded excerpt; an earlier step's id resolves to that step's **full** artifact.
- **A step is re-runnable and its intents are IDEMPOTENT:** re-running a step is always safe — `lock-artifact` is a **no-op when `current(name).producer === taskId`** (a fact of the tail, not the bytes — LLM steps are non-deterministic; sha-equality would break re-runs; review-4 N1); `evidence`/`propose-spawn` dedupe on the produced fact. This is what makes "resumable, not restartable" true.
- **Failure is a value:** `{ok:false, blocker}` (named, never fabricated). A step whose intents the store rejects fails with the reason named.
- The flow's knowledge of a step is exactly the interface: id, inputs, rules, execute, out. No step internals.

**THE FLOW-DATA FIELDS AND THE CONTRACT SCHEMA** (review-4 N2): the chain-selecting fields `contract.workType` · `contract.flow` · `contract.model` are NOT in the enumerated journey-format v13 §2 contract (`intent · acceptanceCriteria · targetAreas · requiredInputs · expectedOutputs`), which declares *"strict schema; unknown fields rejected"*. **This design records a v13 §2 AMENDMENT** — enumerating the three fields (workType: one of the flow-control §7 work types or a project-defined id; flow: optional step-id array; model: optional provider model id) — via the amendment path (amendment node → complete superseding artifact → `supersede!`). The re-implementation also ENFORCES the v13 schema at `spawn!` (currently unimplemented — the reason this has been invisible).

## 3. The intent vocabulary + translation rules

Steps speak **intents**, not events. The flow translates intents into L1 writes; **only commands write events** (single writer preserved).

| intent | step declares | flow does |
|---|---|---|
| `evidence` | `{note, refs?, answers?[]}` — answers `{id, answer, provenance?}` per the store schema | `append!` → `evidence` event (idempotent: dedupe on the produced fact) |
| `lock-artifact` | `{name, content\|path, type?}` — **type drives placement** (below) | **materialize** (write the file · blob sha · one-current-per-name) → `lock!` → `artifact-locked`; **no-op when `current(name).producer === taskId`** |
| `propose-spawn` | `{id, contract}` — a **task** (F-AC19-valid contract: intent, ACs, resolvable requiredInputs) | validate contract + chain (at spawn time, §1) → `spawn!` → node.json + `created` |
| `supersede` | `{name, path}` — the old artifact to supersede (AC-7 amendments) | **the flow writes `superseded` on the OLD LOCKER's node** — the ONLY cross-task write in the system, permitted for supersession alone; then the lock may land on the current name (review-4 N5) |
| `close` | `{transferred? {target, scope} · deferred? {reason} · gate-revised? {old, new}}` | validate (F-AC16) → `append!` → closure events |

**Not step-declarable — the frame's own writes via L1:** lifecycle (`activated` · `completed` · `failed`) · gates (`submitted` · `confirmed` · `rejected`). **Leg spawns are the frame's, not steps'** — tasks = step intents; the next leg = the frame's advance, gated by `legGateMet`.

**Translation rules (stable, enforced by the flow — REJECT, never silently reorder):**
1. `spawn` is **not** an event — v13 §3 removed `spawned`; a child's `created` event *is* the spawn record. `propose-spawn` is an intent; `spawn!` records `created`.
2. **Lock-before-spawn:** within and across steps, `lock-artifact` for a name precedes any `propose-spawn` whose contract's `requiredInputs` reference that name (F-AC19 resolves via `current()` at spawn). Violation → rejected, named.
3. **Supersede-before-lock:** the store refuses a lock on an already-current name — so a superseding artifact's flow writes `supersede` (on the old locker) BEFORE `lock` (on the current task).
4. **Gate-bound step ordering (review-4 N4):** a step bound to the grill gate runs to PRODUCE the gate decision. Its non-gate intents (`lock-artifact` etc.) are translated **only AFTER the gate decision is CONFIRMED** — if the gate is rejected, only the verdict/feedback flows to the gate (the step's content from a rejected round is not locked). This is what lets flow 1's `idea-validate` lock its doc (the store refuses `artifact-locked` before `confirmed(grill)`).
5. **`contract.flow` is validated AT SPAWN** (immutable node) **AND every resolved chain (project data, mutable) is validated AT EXECUTE** — both fail closed, NAMED (the execute-time check never throws bare: an unregistered step id is a named chain problem; review-4 N3).
6. **One human decision per gate:** the chain data names at most one step per gate (validated statically); the frame never double-presents (§1 resume rule).
7. **Materialization ownership:** only the flow writes files. **Placement derives from the artifact's TYPE** per the vocab artifactTypes (review-4 N12): shared contract-stack types (`spec · system-design · architecture`) → `docs/<category>/` + symlink in the task's `artifacts/` (v13 §14/§15); task-local types (`record · vision · validation`) → task-local real file.

## 4. The frame (the resumable coordinator)

Gates are named by the VOCAB (`grill` · `confirm` — `vocab.json`, read via `getVOCAB()`; review-4 N10). Chain phase bindings use the same values.

```
frontmost-ready (L1 look-back) → task
materialize    packet (context engine; reads via L1). THE RESOLUTION LADDER LIVES
               HERE: derive → probe → infer → ask → block (flow-control v6 §4).
               v1 ships ONLY the block rung (missing input → named blocker); the
               other rungs are NAMED, deferred — never silently inferred.
GATE·grill     obtain the grill decision — ONE source: per the chain data, either
               the frame's present-via-interact (default) or a step bound to
               at:'grill' (e.g. the interactive idea-validation session). The
               decision is written via gate! (submitted + confirmed/rejected).
               rejected → RE-MATERIALIZE from rejected.feedback (LOCKED routing,
               flow-control v6 §3 — the rung is not adjustable), bounded: 3 →
               escalate to a human design decision.
validate       deterministic (L1/validators + packet readiness) — judgment stays
               with the runner (S6)
activate       the frame writes `activated` (the ONLY writer; `active` status
               derives from it, store.ts:162-164)
execute        run the chain's at:'execute' steps in EXECUTION ORDER (phase order:
               grill-bound, then confirm-bound, then execute entries in list order
               — validateChain's "earlier" means execution order; review-4 N14) —
               each: inject ctx → execute → translate intents → L1 writes → run
               the step's co-located rules → next; stop on failure (named).
               EMPTY CHAIN = the runner's work: the runner works via abilities; its
               outcomes arrive as L1 writes (append! evidence.commits[]) that the
               frame OBSERVES — the general case, not an exception.
verify         ACs + evidence + step rules; judgment stays with the runner
GATE·confirm   obtain the confirm decision (frame present via interact, or a step
               bound to at:'confirm') → gate! → rejected → RE-EXECUTE from feedback
               (LOCKED routing); feedback that invalidates the approach escalates to
               the grill loop (flow-control v6 §3)
commit         the RUNNER does the git checkpoint (its evidence.commits[] arrives
               via append! — OBSERVED, not written by the frame); the commit phase
               verifies conclusion evidence exists, then writes `completed`
               (append!) — every task concludes; `completed`/`failed` always written
look-back      derived review (L1 reads): where we are + what's ahead — never assumed
advance        propose the next task (frontmost) or spawn the next leg when the leg
               gate is met — derived from the tail, never stored
```

**The reject bound (3/gate, then escalate) is a CONSTANT** owned by `gate!` (L1) — never adjustable by flow data, never bypassable by `append!` (composite-kind refusal, §1). L2 reads the count only to route escalation.

## 5. The read view (narrow content access)

- `read.resolve(name) → {content, path, sha}` — full artifact content by logical name. **Provenance: `derived-from`** — resolution via `current()` is the derive rung (context-packet-spec §3/§4). `observation` is reserved for the probe rung (git/files/external) and stays unused until probing ships — **no packet-spec amendment is needed for name resolution**. How provenance reaches the store: `evidence.answers[].provenance` today; a locked artifact's origin is its locking task (derived-from by construction).
- **BOUND to declared inputs:** `read.resolve` refuses names outside `inputs[]` ∪ `requiredInputs` (fail closed) — preserving F-AC19 grounding; the packet stays the honest picture of what the task consumed. This collapses `inputs[]` and `read.resolve` into ONE content mechanism: `inputs[]` is the declaration (chain-validated), `read.resolve` is the only accessor.
- The packet stays the navigation/grounding view (statuses · capped excerpts · deps · siblings · questions) — never grows to carry content.

## 6. Flows are DATA — the design target

**Chain entries carry phase binding, params, and the verdict map** (review-4 N6b — the verdict→gate mapping has a home):

```
chain entry = { id, params?, at?: 'grill' | 'confirm' | 'execute' (default execute),
                verdict?: { decision → {gate: 'accept'|'reject', feedback?} } }
```

- The **gate-source data IS the chain**: a step bound to `at:'grill'` supplies the grill decision; **at most one step per gate** (statically validated); no bound step → the frame's present-via-interact (default). The verdict map maps `out.verdict.decision` values to gate decisions — an unmapped value fails closed, named. This resolves the "gate from a step" question as DATA at the LOCKED lifecycle position (flow-control §2) — the lifecycle is not moved; the decision source is data.
- **What a work type is (stated):** v1 collapses flow-control v6 §7's work-type table to its CHAIN column (which steps run). The materialize/missing-input/verify/chain-effect parameterization is expressed as steps in the chain or deferred to the runner (S6) — explicitly stated, not silently dropped.
- **New work types/steps/chains/gate sources = data changes** within this design — the chain schema, step registration, and intent vocabulary are the seams; the L0/L1 floor carries zero flow knowledge.
- **AC-7 amendments** (change → amendment node → complete superseding artifact → `supersede!` on the old locker → referrer re-pointing) and **closure** (`close` intent; closure tasks run their own gates) are reachable through the command surface + intents — stated, not silent.
- The 3-reject bound, gate sequence, and single-writer are NOT adjustable (the ownership table, §1) — that is the line.

```
rules/flow/default.json (v3 shape):
chains: {
  planning:        [{id:'idea-validate', at:'grill',
                     verdict:{solid:{gate:'accept'}, revise:{gate:'reject'}, reject:{gate:'reject'}}},
                    {id:'envision'}, {id:'spec'}],
  implementation:  []
}
```

**The two default flows (illustrative data):**
- *Flow 1 — initial project* (planning): `idea-validate` (bound to the grill gate — the interactive session; its verdict IS the grill decision via the map; its doc locks AFTER the gate confirms, ordering rule 4) → `envision` (vision doc) → `spec` (detailed specs; chain effect declares the build-task spawns via `propose-spawn` — eager skeleton, lazy leaves; lock-before-spawn enforced).
- *Flow 2 — working with a task* (implementation): chain `[]` — the frame + runner work; evidence `commits[]` (observed); commit → next frontmost.

## 7. Explicit non-goals (what the design forbids)

- steps never write files or events directly — intents are declarations; the flow materializes and writes (single writer owns all persistence); the per-call runtime trace lives at the ability layer, also ending at `append!`
- steps never see the store — packet + read + abilities only
- the flow never writes directly — all writes via L1 commands (the only cross-task write: `superseded` on the old locker, for AC-7)
- no unbounded loops — 3-reject bound is a constant, chains are bounded and validated (spawn + execute), resumable not restartable (idempotent intents, resume derived from the tail)
- no gate-skipping — the STORE refuses the writes (L0); the frame observes gates from the log (L2); neither is bypassable (prose paths grandfathered out of the new write path)
- no hard-wired flow content in code — flows are data; a builtin chain is a SEED/FALLBACK, never an override of project data (AC-3)
- no silent inference — the resolution ladder is named; v1 ships only `block`
- no prose as truth — machine-truth events; legacy prose parsing is grandfathered for history, removed from new writes

## 8. What v1 ships (the re-implementation slice)

1. **L1: the command surface** — complete over the vocabulary; `spawn!` enforces the contract schema (+ the v13 amendment), F-AC19, artifact gate, leg gate, id naming (moved out of the CLI); `append!` refuses composite-owned kinds; `--json` structured emit on derived-view commands; CLI = a thin binding
2. **L2: the frame** — §4 with `activate`, the idempotent driver (resume derived from the tail), gate observation, locked rework rungs
3. **L2: intent translation** — §3 (idempotent producer-based locks, supersede-before-lock, gate-bound ordering, spawn + execute chain validation, type-derived artifact placement)
4. **L2: gate-source routing + verdict maps** — §6 (chain entries with at:/params/verdict; static validation)
5. **L2: steps** rebuilt on the new contract — `idea-validate` (interactive session, grill-bound), `envision`, `spec` — declaring intents/verdict, never touching the store; chain data updated
6. **L2: read view** — §5 (bound to declared inputs, derived-from provenance)
7. **L3: abilities** — llm (existing adapter; runtime task-fact emission through the L2 record hook), interact (console, 4 verbs), read (file); tool/command protocol-declared, unbuilt
8. **Amendments recorded before implementation:** v13 §2 amendment (workType/flow/model) · architecture amendment (single-initiator → multi-client commands) · flow-control/packet unaffected (no changes needed)
9. L0 substrate unchanged: store, format, packet, validators, provider adapter
