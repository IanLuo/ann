# Ann Core Design — v6 (draft, for review)

*Re-implementation target. The locked substrate (journey-format v13, store single-writer, packet spec, provider adapter, S4 validators, honesty-layer engines) stays. Incorporated: design reviews #1–#5 (2026-08-25). The design target: a system that is SIMPLE and FLEXIBLE — the machinery is small and stable; everything that varies (flows, steps, chains, gate sources, rework) is ADJUSTABLE DATA, so later flow changes are sound changes, not design changes.*

## 0. The model

The product is the journey. The journey is data: nodes, events, artifacts — status **derived** from the event tail, never asserted. A journey moves through a **fixed frame**: materialize → grill gate → validate → activate → execute → verify → confirm gate → commit → look-back → advance. The frame runs the current task's **chain of steps**; steps are **pure units** that receive injected state and declare **intents**; the flow translates intents into store writes **via the command layer**. The human is a seam: present, ask, research, decide. **Commands are the only interface to the store.**

## 1. Layers + the invariant-ownership table

```
L3  UI + ABILITIES   human channel (present·ask·research·decide) · llm · shell/tool ·
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
                      look-back · specs · check · read — the content read view).
                      Writes (the mutators): spawn! · append! · gate! · lock! ·
                      supersede!. COMPLETE over the event vocabulary: every event
                      kind is writable (append! is the generic strict-schema path;
                      the composite commands encode invariants — gate sequence,
                      artifact sha, per-name supersession, reject bound, contract
                      schema).
                      MULTI-CLIENT BY DESIGN: the CLI binds commands to argv, the
                      flow binds them to its logic, a future web server binds them
                      to HTTP. (Amends architecture v2:24,61 — "the kernel is the
                      only initiator"; new statement: COMMANDS are the only
                      initiators, the flow is the primary command client — which
                      RECONCILES ann-system-design-v3:59, already listing multiple
                      initiators. The single-WRITER invariant is unchanged.)
L0  STORE            JOURNEY DATA — node.json (immutable contract) · events.jsonl
                      (append-only, tasks) · artifacts (locked files) · registries
                      (rules/schema/flow). Single writer (appendEvent), strict
                      schema (v13 §3), derived views (status/current/results/check).
                      Knows nothing above.
```

**THE INVARIANT-OWNERSHIP TABLE** (per invariant, the enforcing layer — the line between adjustable and protected):

| Invariant | Layer | How |
|---|---|---|
| gate sequence: no `artifact-locked`/`completed` without the prior gate confirmed; no `confirm` gate without `grill` | **L0 — store** | `appendEvent`/`validateEventShape` refuse the write. Unconditional for nodes with `createdAt >= CUTOFF` (the `V9_CUTOFF` mechanism the repo already uses); the legacy `retrospective`-note path and prose gate-parse are GRANDFATHERED for pre-cutoff nodes ONLY — the re-implementation removes the prose paths from the new write path (machine-truth, NFR-COM-1; review-5 N5 — without the cutoff, 25 measured legacy nodes become unwritable) |
| single writer: only commands write | **L1 + L0** | every write path ends at `appendEvent`; L2/L3 never touch the store |
| leg status derived, never asserted | **L0** | derived views only; no component writes leg events |
| **node.json contract schema** (v13 §2 as amended, §2 below) | **L1 — `spawn!`** | `spawn!` enforces the enumerated node.json schema (shape), F-AC19 (hard reject), id naming/prefix/sibling clash, artifact gate (children after parent concluded), leg gate — moved INTO `spawn!` from the CLI |
| reject bound: 3 per gate, then escalate | **L1 — `gate!`** | `gate!` counts and refuses the 4th; `append!` refuses composite-owned kinds. L2 reads an escalation-derived BOOLEAN (`{escalated}`) from L1 — never the threshold (one owner; review-5 Q3-1) |
| one-current-per-name | **L1 — `lock!`** | the store refuses a lock on an already-current name (except the idempotent no-op, §3) |
| F-AC16 closure integrity · F-AC18 conclusion + traceability | **post-hoc `check()`** | `check()`-time validations, not write-path invariants — stated, not claimed as enforced |
| chain validity · intent ordering · gate-source routing · **intent idempotence** · **cross-task write permission (supersede on the old locker)** · **artifact placement + recorded path** | **L2 — flow** | conventions, not invariants — statically validated before execution; bypassable only by another L1 client writing raw events, which the composite-kind refusal blocks |
| **gate SET and gate POSITIONS** (grill · confirm, at their locked lifecycle slots) | **protected by the locked lifecycle** (flow-control v6:34 — both HARD on every node in v1) | only the gate SOURCE is adjustable data; a new gate value in `vocab.json` would be a gate no phase obtains — the set is protected, the source is data (review-5 Q4) |
| **resolution-ladder rung enablement** | **registry data** (`rules/decide/rules.json`) | the rungs are registry data with enablement read by the flow — v1 ships `block` enabled; enabling a rung is data, not code (review-5 Q4) |

**The coordination loop:** get store info (L1 reads) → work the current task → run the step interface → translate intents → emit via L1 → observe gates → repeat. **Resumable**: any interruption (pending gate, rejection) leaves the task blocked/pending in the store. **The frame's driver is ONE idempotent advance operation**: it runs phases until it blocks, then stops; **the resume point is DERIVED from the event tail — never stored**, in THREE tail states (review-5 N6a): *last-at-gate `confirmed` → skip; `submitted` undecided → block and wait (the store already derives `blocked`); last `rejected` → the LOCKED rework rung runs and the gate IS re-obtained* (flow-control v6:36-38 — "resume point decided by the feedback"; this design does not override it). **`execute` is NEVER skipped** — it has no tail marker; its replay safety rests ENTIRELY on intent idempotence (§3) — as requirements-spec-v3:87 prescribes ("node restarts with the same context packet + evidence"). **L2 is not a monolithic loop** — gates are L1 writes the flow observes, never assumed.

## 2. The step contract + the flow-data fields + the v13 amendment

```
step = { id, inputs[], rules[], execute(ctx) }
ctx  = { taskId · packet (materialized state, injected) ·
         params? (this chain entry's params) ·
         read (the L1 content read view, injected by L2) ·
         abilities { llm · interact · shell · tool } (L3 seams; shell = an OS-process
                ability, NEVER the L1 command surface — the name collision is
                deliberate and resolved by this clause; review-5 N12) ·
         prior (earlier steps' artifacts — BOUND to inputs[]; a step may consume
                only what it declares; on a replay, prior resolves from the LOCKED
                artifact via the name in that step's own lock-artifact intent) ·
         feedback? (last rejected.feedback for this task — the rework channel) }
out  = { ok
         artifact?  — in-memory result for DOWNSTREAM steps (or via the locked artifact)
         verdict?   — a GENERIC human-decision outcome: {decision, feedback?}
                      (the flow routes it via the chain entry's verdict map; a
                       GATE-BOUND step returning NO verdict → fail closed, named;
                       an unmapped decision → fail closed, named; the step's own
                       feedback wins over the map's static feedback? — review-5 N9)
         intents?[] — what the step wants done; the flow translates to L1 writes }
```

Rules:
- **A step never touches the store or the CLI.** State arrives injected (packet + read + prior); effects depart declared (intents + verdict). **Steps have no write hook.** The two-log trace survives at the ABILITY layer: `llm`/`interact` emit runtime task-fact events through an L2-owned record hook ending at `append!` — a multi-round session leaves a durable per-call trace even if it crashes before returning. Steps do NOT duplicate in intents what their ability calls already emitted.
- **Two `inputs[]` semantics, NAMED:** a packet-dependency input resolves to the bounded excerpt; an earlier step's id resolves to that step's **full** artifact. **`prior` and `read.resolve` are both bound to `inputs[]`** — one content mechanism, one grounding story (review-5 N13).
- **A step is re-runnable and ALL intents are IDEMPOTENT, by predicate** (review-5 N1 — this is the entire replay-safety mechanism):
  - `lock-artifact` → **no-op when `current(name).producer === taskId`** (a fact of the tail, not the bytes — LLM steps are non-deterministic)
  - `propose-spawn` → **no-op when the node id already exists** (NOT contract equality — contracts are LLM-generated)
  - `supersede` → no-op when the old locker already carries `superseded{successor.name === name}`
  - `close` → no-op when the same closure event is already in the tail
  - `evidence` → dedup keyed on `commits[].sha` / `refs[]` / `answers[].id`; ABILITY-HOOK trace emissions are keyed by the flow on `(stepId, seq)` — the call's deterministic ordinal within the step's execution for the same packet; on replay, events already in the tail are skipped
- **Failure is a value:** `{ok:false, blocker}` (named, never fabricated). A step whose intents the store rejects fails with the reason named.
- The flow's knowledge of a step is exactly the interface: id, inputs, rules, execute, out. No step internals.

**THE v13 §2 AMENDMENT (the flow-data fields)** — the chain-selecting fields `contract.workType` · `contract.flow` · `contract.model` are NOT in the enumerated journey-format v13 §2 contract, which declares *"strict schema; unknown fields rejected"*. **Recorded amendment: journey-format v13 → v14** (complete superseding artifact under the same logical name + `superseded` event + **referrer re-pointing** — including AGENTS.md, which is already stale). The amended **node.json schema** `spawn!` enforces: `id (required) · contract{ intent · acceptanceCriteria · targetAreas · requiredInputs · expectedOutputs · openQuestions[] · workType · flow · model } · createdAt (required)` — `openQuestions.blocking` survives (it gates the node; review-5 N2a).

## 3. The intent vocabulary + translation rules

Steps speak **intents**, not events. The flow translates intents into L1 writes; **only commands write events** (single writer preserved).

| intent | step declares | flow does |
|---|---|---|
| `evidence` | `{note, refs?, answers?[]}` — answers `{id, answer, provenance?}` per the store schema | `append!` → `evidence` event (idempotent, §2) |
| `lock-artifact` | `{name, content\|path, type?}` — **type drives placement** (below) | **materialize** (write the file · blob sha · one-current-per-name) → `lock!` → `artifact-locked`; no-op per §2; **the RECORDED path is the task-local ref** (the symlink for shared types; v13:74) |
| `propose-spawn` | `{id, contract}` — a **task** (F-AC19-valid contract) | validate → `spawn!` → node.json + `created`; no-op if the id exists (§2) |
| `supersede` | `{name, path}` — the old artifact (AC-7) | **the flow writes `superseded` on the OLD LOCKER's node** — the ONLY cross-task write, permitted for supersession alone; then the lock may land (§3 rule 3) |
| `close` | `{transferred? {target, scope} · deferred? {reason} · gate-revised? {old, new}}` | validate (F-AC16) → `append!` → closure events (idempotent, §2) |

**Not step-declarable — the frame's own writes via L1:** lifecycle (`activated` · `completed` · `failed`) · gates (`submitted` · `confirmed` · `rejected`). **Leg spawns are the frame's, not steps'** — tasks = step intents; the next leg = the frame's advance, gated by `legGateMet`. (`extended` is annotate-only, reachable via `append!` alone — no intent declares it.)

**Translation rules (stable, enforced by the flow — REJECT, never silently reorder):**
1. `spawn` is **not** an event — v13 §3 removed `spawned`; a child's `created` event *is* the spawn record.
2. **Lock-before-spawn:** `lock-artifact` for a name precedes any `propose-spawn` whose contract's `requiredInputs` reference that name (F-AC19 resolves via `current()` at spawn). Violation → rejected, named.
3. **Supersede-before-lock:** the store refuses a lock on an already-current name — a superseding artifact's flow writes `supersede` (old locker) BEFORE `lock` (current task).
4. **Gate-bound ordering:** a step bound to the grill gate runs to PRODUCE the gate decision. Its non-gate intents translate **only AFTER the gate is CONFIRMED** — on rejection, only the verdict/feedback flows to the gate (a rejected round's content is not locked). This lets `idea-validate` lock its doc (the store refuses `artifact-locked` before `confirmed(grill)`).
5. **Chain validation is SPLIT across the layer line** (review-5 N3): **L1 `spawn!` validates the contract SHAPE** (the amended node.json schema — no registry, no chain semantics); **L2 validates the chain's MEANING** (ids registered, execution order, inputs resolvable) against the **prospective contract** BEFORE calling `spawn!`, and again on the resolved chain AT EXECUTE (project data is mutable). Both fail closed, named. The L0/L1 floor carries zero step-registry dependency.
6. **One human decision per gate:** the chain data names at most one step per gate (validated statically); the frame never double-presents (the §1 resume rule).
7. **Materialization ownership:** only the flow writes files. **Placement derives from the artifact's TYPE**, read from the vocab registry: each `artifactTypes` entry carries its category — shared contract-stack types (`spec · system-design · architecture`) → `docs/<category>/` + symlink; task-local types (`record · vision · validation`) → task-local real file (v13 §15 has no catch-all category; a new artifact type is a DATA change — add the entry + category to the registry, never code; review-5 N8).

## 4. The frame (the resumable coordinator)

Gates are named by the VOCAB (`grill` · `confirm`, read via `getVOCAB()`); chain phase bindings use the same values.

```
frontmost-ready (L1 look-back) → task
materialize    packet (context engine; reads via L1). THE RESOLUTION LADDER LIVES
               HERE: derive → probe → infer → ask → block (flow-control v6 §4) —
               rung enablement is registry data (§1); v1 ships block enabled.
GATE·grill     obtain the grill decision — ONE source: the frame's present-via-interact
               (default) or a chain step bound to at:'grill'. Written via gate!
               (submitted + confirmed/rejected). rejected → RE-MATERIALIZE from
               rejected.feedback (LOCKED routing, flow-control v6 §3), bounded: 3 →
               escalate.
validate       deterministic (L1/validators + packet readiness) — judgment stays with the runner
activate       the frame writes `activated` (the ONLY writer; `active` status derives from it)
execute        run the chain's at:'execute' steps in EXECUTION ORDER — which is:
               grill-bound steps first (at the grill phase), then execute entries in
               list order, then confirm-bound steps (at the confirm phase, which the
               locked lifecycle places AFTER execute) — review-5 N10. Each step:
               inject ctx → execute → translate intents → L1 writes → run the step's
               co-located rules → next; stop on failure (named). validateChain's
               "earlier" means EXECUTION ORDER, not list order.
               EMPTY CHAIN = the runner's work: the runner works via abilities; its
               outcomes arrive as L1 writes (append! evidence.commits[]) that the
               frame OBSERVES — the general case, not an exception.
verify         ACs + evidence + step rules; judgment stays with the runner
GATE·confirm   obtain the confirm decision (frame present, or a step bound to
               at:'confirm') → gate! → rejected → RE-EXECUTE from feedback (LOCKED
               routing); feedback that invalidates the approach escalates to the
               grill loop (flow-control v6 §3)
commit         the RUNNER does the git checkpoint (its evidence.commits[] arrives
               via append! — OBSERVED, not written by the frame); the commit phase
               verifies conclusion evidence exists, then writes `completed`
               (append!) — every task concludes; `completed`/`failed` always written
look-back      derived review (L1 reads): where we are + what's ahead — never assumed
advance        propose the next task (frontmost) or spawn the next leg when the leg
               gate is met — derived from the tail, never stored
```

**The reject bound (3/gate, then escalate) is a CONSTANT** owned by `gate!` (L1) — never adjustable, never bypassable (`append!` composite-kind refusal, which includes `created` — owned by `spawn!`; review-5 N14). L2 reads `{escalated}` only.

## 5. The read view (an L1 derived read)

- **`read.resolve(name) → {content, path, sha}` is an L1 derived read** — exactly `current()` + a bounded file read (both already L0/L1) — **injected into ctx by L2**. It is NOT an L3 servant reading L0 files: L1 is the ONLY path to the store, including content (review-5 N11). Full artifact content by logical name; **provenance `derived-from`** (resolution via `current()` is the derive rung, context-packet-spec §3/§4; `observation` stays reserved for the probe rung, unused in v1 — no packet-spec amendment needed). How provenance reaches the store: `evidence.answers[].provenance` today; a locked artifact's origin is its locking task.
- **BOUND to declared inputs:** refuses names outside `inputs[]` ∪ `requiredInputs` (fail closed) — preserving F-AC19 grounding; `inputs[]` is the declaration (chain-validated), `read.resolve` is the only accessor, `prior` is bound the same way — ONE content mechanism (§2).
- The packet stays the navigation/grounding view (statuses · capped excerpts · deps · siblings · questions) — never grows to carry content.

## 6. Flows are DATA — the design target

**Chain entries carry phase binding, params, and the verdict map:**

```
chain entry = { id, params?, at?: 'grill' | 'confirm' | 'execute' (default execute),
                verdict?: { decision → {gate: 'accept'|'reject', feedback?} } }
```

- The **gate-source data IS the chain**: a step bound to `at:'grill'` supplies the grill decision; at most one step per gate (statically validated); no bound step → the frame's present-via-interact. The verdict map routes `out.verdict.decision` to gate decisions — unmapped or missing → fail closed, named. The gate SET and POSITIONS are protected by the locked lifecycle; only the SOURCE is data (§1).
- **What a work type is (stated as a DEFERRAL, not a collapse):** flow-control v6 §7's table has FOUR parameterization columns (Materialize · Missing input · Verify · Chain effect) — there is no "chain column." This design RECORDS A DEFERRAL: v1 implements none of the four columns; which steps run is the design's own seam, expressed as chain data; chain-effect is served by `propose-spawn` intents; the rest is the runner (S6). Recorded against the locked table, not misdescribed as conformance (review-5 Q5).
- **New work types/steps/chains/gate sources/artifact types = data changes** — the chain schema, step registration, intent vocabulary, and the vocab registry are the seams; the L0/L1 floor carries zero flow knowledge.
- **AC-7 amendments** (amendment node → complete superseding artifact → `supersede!` on the old locker → referrer re-pointing) and **closure** (`close` intent; closure tasks run their own gates) are reachable through the command surface + intents.
- The 3-reject bound, gate sequence, gate set/positions, and single-writer are NOT adjustable (§1) — that is the line.

```
rules/flow/default.json:
chains: {
  planning:        [{id:'idea-validate', at:'grill',
                     verdict:{solid:{gate:'accept'}, revise:{gate:'reject'}, reject:{gate:'reject'}}},
                    {id:'envision'}, {id:'spec'}],
  implementation:  []
}
```

**The two default flows (illustrative data):**
- *Flow 1 — initial project* (planning): `idea-validate` (grill-bound; its verdict IS the grill decision; its doc locks AFTER the gate confirms) → `envision` (vision doc) → `spec` (detailed specs; chain effect declares build-task spawns via `propose-spawn`; lock-before-spawn enforced).
- *Flow 2 — working with a task* (implementation): chain `[]` — the frame + runner work; evidence `commits[]` (observed); commit → next frontmost.

## 7. Explicit non-goals (what the design forbids)

- steps never write files or events directly — intents are declarations; the flow materializes and writes; the per-call runtime trace lives at the ability layer, also ending at `append!`
- steps never see the store — packet + read + abilities only; `shell` is an OS-process ability, never the L1 command surface
- the flow never writes directly — all writes via L1 commands (the only cross-task write: `superseded` on the old locker, for AC-7)
- no unbounded loops — 3-reject bound is a constant, chains are bounded and validated (shape at spawn, meaning at execute), resumable not restartable (idempotent intents, resume derived from the tail)
- no gate-skipping — the STORE refuses the writes (L0, post-cutoff); the frame observes gates from the log (L2); prose paths grandfathered for legacy nodes only
- no hard-wired flow content in code — flows are data; the builtin fallback is the EMPTY CHAIN (lifecycle only — always valid, never a code-side step id; review-5 N15)
- no silent inference — the resolution ladder is named; v1 ships `block` enabled (registry data)
- no prose as truth — machine-truth events; legacy prose parsing grandfathered by cutoff

## 8. What v1 ships (the re-implementation slice)

1. **L1: the command surface** — complete over the vocabulary; `spawn!` enforces the amended node.json schema (shape) + F-AC19 + artifact gate + leg gate + id naming (moved from the CLI); `append!` refuses composite-owned kinds + `created`; `read` as a derived view; `--json` structured emit; CLI = a thin binding (and DROPS `cmdGate`'s duplicate gate-sequence check — L0 owns it)
2. **L2: the frame** — §4 with `activate`, the idempotent driver (resume from the tail, three states; execute never skipped), gate observation, locked rework rungs
3. **L2: intent translation** — §3 (all five intents idempotent by predicate; supersede-before-lock; gate-bound ordering; shape-vs-meaning validation split; type-derived placement)
4. **L2: gate-source routing + verdict maps** — §6 (chain entries with at:/params/verdict; static validation)
5. **L2: steps** rebuilt on the new contract — `idea-validate` (interactive session, grill-bound), `envision`, `spec` — declaring intents/verdict, never touching the store
6. **L2: read view wiring** — §5 (L1 derived read, bound to declared inputs)
7. **L3: abilities** — llm (existing adapter; runtime task-fact emission through the L2 record hook), interact (console, 4 verbs), read (the L1 view), shell/tool (protocol-declared, unbuilt)
8. **Amendments recorded BEFORE implementation** (each a complete superseding artifact + `superseded` + referrer re-pointing): journey-format v13 → v14 (workType/flow/model; node.json schema as stated) · architecture v2 → v3 (multi-client commands; the :66 enforcement-split clause moves artifact gate/contract invariants to L1 `spawn!`; reconciles ann-system-design-v3:59; fixes AGENTS.md's stale pointer) · resource-registry v2 → v3 (`schema` category added — the vocab registry the gate names and artifact types stand on) · flow-control v6 (recorded DEFERRAL of the §7 four-column parameterization, not a change)
9. L0 substrate unchanged: store, format, packet, validators, provider adapter
