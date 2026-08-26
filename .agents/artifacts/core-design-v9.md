# Ann Core Design — v9 (draft, for review)

*Re-implementation target. The locked substrate (journey-format v13, store single-writer, packet spec, provider adapter, S4 validators, honesty-layer engines) stays. Incorporated: design reviews #1–#8 (2026-08-25). The design target: a system that is SIMPLE and FLEXIBLE — the machinery is small and stable; everything that varies (flows, steps, chains, gate sources, rework) is ADJUSTABLE DATA, so later flow changes are sound changes, not design changes.*

**The mechanism (review-7 decision, review-8 MEASURED SOUND):** *files are working state, events are acceptance.* A step's `lock-artifact` intent writes the file immediately (re-written each rework pass); the `artifact-locked` EVENT records only at commit (after gate② confirms). **`propose-spawn` defers to commit alongside it** (both acceptance-shaped writes). No `superseded` is ever written on a live node. The trace is a schema-legal **transcript** that makes replay deterministic; the replay/rework discriminator is **transcript presence**, not `ctx.feedback` alone.

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
                      Writes (the mutators): spawn! · submit! · gate! · append! ·
                      lock! · supersede!. COMPLETE over the event vocabulary; the
                      composite commands encode invariants (gate sequence, artifact
                      sha, per-name supersession, reject bound, contract schema).
                      MULTI-CLIENT = multiple IN-PROCESS initiators (the flow, the
                      validators, the adapters — ann-system-design-v3:59's actual
                      list; the CLI is a binding, not an initiator; requirements-spec
                      A1 parks multi-PROCESS for v1, and the store's in-memory event
                      cache means one writer process in v1 — stated, review-8 P13).
L0  STORE            JOURNEY DATA — node.json (immutable contract) · events.jsonl
                      (append-only, tasks) · artifacts (locked files) · registries
                      (rules/schema/flow). Single writer (appendEvent), strict
                      schema (v13 §3), derived views (status/current/results/check).
                      Knows nothing above.
```

**THE INVARIANT-OWNERSHIP TABLE** (per invariant, the enforcing layer — the line between adjustable and protected):

| Invariant | Layer | How |
|---|---|---|
| gate sequence: no `artifact-locked`/`completed` without the prior gate confirmed; no `confirm` gate without `grill` | **L0 — store** | refused by the writer. Unconditional for nodes with `createdAt >= CUTOFF` (`'2026-08-21'` — measured safe; 19 legacy tasks carry `retrospective` notes, all ≤ 2026-08-18, 5 leg roots exempt); the prose paths are GRANDFATHERED for pre-cutoff nodes only |
| single writer: only commands write | **L1 + L0** | every write ends at `appendEvent`; L2/L3 never touch the store |
| leg status derived, never asserted | **L0** | derived views only; no component writes leg events |
| **node.json contract schema** (v14 §2, §2 below) | **L1 — `spawn!`** | shape + F-AC19 (hard reject) + id naming/prefix/sibling + artifact gate + leg gate — moved INTO `spawn!` from the CLI |
| reject bound: 3 per gate, then escalate | **L1 — `gate!`** | counts and refuses the 4th; `append!` refuses composite-owned kinds + `created`; L2 reads only `{escalated}` |
| one-current-per-name | **L1 — `lock!`** | refused except the acceptance-record path (§3 — locks record only at commit, so a rework never re-locks) |
| **vocab.eventTypes** | **protected** (v13:57-61) | code-literal enforcement — a knowing duplicate of the registry, recorded as a reconciliation in the resource-registry amendment (review-7 Q5-3) |
| **vocab.statuses** | **protected** (vocab.json:23-30 — v13 has no status list; review-8 P13) | the event→status mapping is a code literal; adding a value is a silent no-op |
| **vocab.gates** | **set/positions protected** (flow-control v6:17,34) | only the gate SOURCE is data |
| **vocab.artifactTypes** | **adjustable (data)** | entries carry category + versioned flag (§3); a new type in an existing category = data; a new `docs/` category = a v13 §15 amendment |
| F-AC16 closure · F-AC18 conclusion + traceability | **post-hoc `check()`** | check-time validations, not write-path invariants — stated |
| chain validity · intent ordering · gate-source routing · **intent idempotence + the transcript-presence discriminator** · **cross-task write permission** · **artifact placement/filename/recorded path** · **chain linearity** · **frame-write idempotence** · **working-file lifecycle** (task-local, unpoliced; `check()` is event-anchored — a file without an event is outside the integrity model; never pruned — stated, review-8 P4/P12) | **L2 — flow** | SPLIT: STATICALLY VALIDATED (chain validity · gate-source routing · intent ordering — via the step's declared `roles[]`/`produces?[]`/`decisions[]`) · RUNTIME/CONVENTION-ONLY (idempotence · cross-task permission — `supersede!` accepts an arbitrary target, no enforcer exists · placement/filename · frame-write idempotence) — nothing over-claimed (review-8 Q5) |
| resolution-ladder rung enablement | **registry data** — `rules/decide/rules.json` gains `enabled` flags (a LISTED §8 migration); **enablement is data once a rung exists; v1 builds only `block`** (review-7 N8) | enabling an unbuilt rung is a no-op or crash — the row says so |

**The coordination loop:** get store info (L1 reads) → work the current task → run the step interface → translate intents → emit via L1 → observe gates → repeat. **Resumable** — interruption (pending gate, rejection, crash) leaves the task blocked/pending; the resume point is **DERIVED from the event tail**, in THREE tail states: *last-at-gate `confirmed` → skip; `submitted` undecided → block and wait (produced by `submit!`); last `rejected` → the LOCKED rework rung runs and the gate IS re-obtained* (flow-control v6:36-38). **`execute` is NEVER skipped**; its replay safety = **intent idempotence + the transcript** (§2/§3), discriminated by `ctx.feedback` (present = rework → fresh run; absent = replay → served from the transcript). **L2 is not a monolithic loop** — gates are L1 writes the flow observes.

## 2. The step contract + the flow-data fields + the v14 amendment

```
step = { id, roles[] (each REQUIRED or OPTIONAL — the shape it consumes),
         produces?[] (the intents it MAY declare — makes the confirm-bound deadlock
         check and intent-ordering validation statically decidable; review-8 P5),
         rules[], decisions?[], paramsSchema?, execute(ctx) }
ctx  = { taskId · packet · params? (validated) ·
         read (L1 content view, injected) ·
         abilities { llm · interact · shell · tool } (shell = OS-process, NEVER the L1 surface) ·
         prior (role-bound in-memory artifacts: {role → artifact}) ·
         feedback? {gate, text} — the rework channel, SCOPED BY GATE; DELIVERY: steps
                        at or after the rejecting gate's position in execution order
                        receive it; earlier gate-bound steps REPLAY (review-8 P10) }
out  = { ok · artifact? · verdict? {decision ∈ decisions[], feedback?} · intents?[] }
```

Rules:
- **A step never touches the store or the CLI.** State arrives injected; effects depart declared. Steps have no write hook.
- **The TRACE is a TRANSCRIPT** (review-7 N2, review-8 measured): `llm`/`interact` emit runtime records — keyed `(taskId, stepId, runId, seq)` with the LLM completion text and the interact question+answer — through an L2-owned record hook ending at `append!`, in a **schema-legal home**: the v14 §3 amendment lets an `evidence` event carry an optional structured `trace` record `{stepId, runId, seq, kind: 'llm'|'ask'|'research'|'decide', prompt?, completion?, question?, answer?, research?, sources?[]}` — shape-policed for ALL FOUR kinds (`research` returns an array with `sources[]`; `present` is deliberately unrecorded); machine-truth, never prose. The transcript makes replay deterministic: on replay the LLM calls are served the recorded completions and the interact calls the recorded answers **by question identity** — the human is NEVER re-interviewed and the questions never drift (review-7 N3). NOTE: this reverses the two-log split (op-log = metrics, never text; the transcript puts text in `events.jsonl`) — stated; NFR-SEC-1 (`no secrets in the tree`) now applies to prompt text (review-8 P12).
- **The replay/rework discriminator is TRANSCRIPT PRESENCE, not `ctx.feedback`** (review-8 P3, measured): an attempt is NEW when no `trace` record post-dates the latest `rejected` event at the step's bound gate; otherwise it REPLAYS (served from the transcript; a MISS falls through to a live call and appends at the next `seq` under the same `runId` — the miss policy, without which a first attempt could not run). `ctx.feedback` marks the attempt kind (rework) and carries the rejection text. **`runId` = 1 + the number of `rejected` events at the step's bound gate in the tail** — derivable, monotonic; replay keeps the same runId (stranded partial records are served), a NEW rejection advances it (fresh records never collide).
- **`inputs[]` are role bindings on the CHAIN ENTRY** (AC-3): the step declares `roles[]` (with required/optional markers); chain data binds `{role → source}`; `validateChain` checks BOTH directions — every bound role is declared AND every REQUIRED role is bound (review-7 N5); the flow injects `ctx.prior`. Rewiring consumption = data.
- **A step is re-runnable; intents are IDEMPOTENT ON REPLAY, FRESH ON REWORK** — the discriminator is TRANSCRIPT PRESENCE (new attempt when no trace post-dates the latest rejection at the bound gate; else replay), never the bytes:
  - **replay (crash-resume):** `lock-artifact` → the file already exists (working state) → no re-write needed, no event to record (events record at commit); `propose-spawn` no-ops when the id exists; `supersede` no-ops on the identical event; `close` no-ops on the identical event; `evidence` dedups on `commits[].sha`/`refs[]`/`answers[].id` (trace records on `(stepId, runId, seq)`)
  - **rework (rejection):** every intent produces FRESH work — the lock file re-writes, runId advances (a new rejection), the event still records only at commit (no re-lock conflict, NO `superseded` on a live node — review-7 B1 resolved)
- **Failure is a value** in the locked shape `{ok:false, error:{code, blocker}}`. A step whose intents the store rejects fails named.

**THE v14 AMENDMENT** (complete superseding artifact, same logical name, preserving section anchors, back-reference, `superseded` event, referrer re-pointing — AGENTS.md:41/46/48 fixed, a `context-packet-spec` pointer added):
- **§2 — the node.json schema**: `id (REQUIRED) · contract{ intent (REQUIRED) · acceptanceCriteria (REQUIRED, non-empty) · targetAreas · requiredInputs · expectedOutputs · workType · flow · model } · openQuestions[] (TOP-LEVEL SIBLING — as v13:33 has it) · createdAt (REQUIRED)`. The packet assembler's read (`context.ts:88-91`) and `store.spawn`'s write are changed to match — **the "L0 substrate unchanged" ship list is corrected to own these two small changes** (review-7 N10).
- **§3 — the event schema**: `evidence` may carry the optional structured `trace` record (above) — the transcript's home.
- **§14/§15 — the artifact filename rule** (§3 rule 7 below).

## 3. The intent vocabulary + translation rules

| intent | step declares | flow does |
|---|---|---|
| `evidence` | `{note, refs?, answers?[]}` | `append!` → `evidence` (dedup per §2) |
| `lock-artifact` | `{name, content\|path, type?}` | **materialize the WORKING FILE immediately** — a TASK-LOCAL real file in `artifacts/` (the shared `docs/<category>/<name>-v<N>.md` placement, the symlink, and `N` happen AT COMMIT, with the event — review-8 P4: a failed task's draft never sits unaccepted in the shared contract stack; v13:223) — **the `artifact-locked` EVENT records only at COMMIT** (§4), once the task's gates are accepted. Rework re-writes the working file; the event never double-locks; no `superseded` on live nodes (review-7 B1) |
| `propose-spawn` | `{id, contract}` — a task (F-AC19-valid) | **DEFERS TO COMMIT alongside `lock-artifact`** (review-8 P1, measured): the child is NOT spawned during execute — it is spawned at commit, after the parent's artifacts are `current()` (F-AC19 + the artifact gate resolve then; a child naming the parent's artifact would otherwise be unspawnable — the shipped Flow 1). The step's spawn INTENT is recorded (in-memory), the `spawn!` happens at commit; no-op if the id exists |
| `supersede` | `{name, path}` — the old artifact (AC-7) | **`superseded` on the OLD LOCKER's node** (the ONLY cross-task write); node-level supersession (a sibling superseding a task) is **NOT REACHABLE in v1** — `supersede!`'s `{name, path}` is artifact-shaped; stated, so the status-collapse in `store.ts:171-173` covers TWO meanings (artifact replaced · node replaced — rework is NOT a third; rework is the defer-record path) (review-8 P11) |
| `close` | `{transferred? {target, scope} · deferred? {reason} · gate-revised? {old, new}}` | validate (F-AC16) → `append!` (dedup per §2) |

**Not step-declarable — the frame's own writes:** lifecycle (`activated` · `completed` · `failed`) · gates (`submitted` via `submit!` · `confirmed`/`rejected` via `gate!`). **Leg spawns are the frame's.** (`extended` is annotate-only, `append!`-only.)

**Translation rules (stable, enforced by the flow — REJECT, never silently reorder):**
1. `spawn` is **not** an event — a child's `created` *is* the spawn record.
2. **Lock-before-spawn:** `lock-artifact` for a name precedes any `propose-spawn` whose contract's `requiredInputs` reference it. Violation → rejected, named. (At spawn time, the name's FILE exists even though the event records at commit — the spawn's F-AC19 check resolves via `current()`, so a chain that spawns tasks referencing its own not-yet-committed artifacts must bind them through `prior`/the chain, not `requiredInputs` — stated, review-7 N6's boundary.)
3. **Supersede-before-lock** applies to AC-7 amendments (the old locker supersedes, then the new locks). Rework NEVER supersedes (the defer-record path).
4. **Gate-bound ordering:** a gate-bound step runs to produce the gate decision; its `lock-artifact` FILE writes immediately, its EVENT records when the gate confirms (at commit — the gate sequence invariant is satisfied because commit follows gate②). On resume at a decided gate, the step re-runs **from the transcript** (same completions, same questions, same answers by identity) — the human is never re-interviewed.
5. **Chain validation split:** L1 `spawn!` validates the contract SHAPE; L2 validates the chain's MEANING (ids registered, role bindings bidirectional, execution order, inputs resolvable) against the prospective contract BEFORE `spawn!`, and again AT EXECUTE. Both fail closed, named. The floor carries zero step-registry dependency. **A chain edit that introduces a new packet-dep binding applies only to unspawned tasks** — `node.json` is immutable (v13:43); the remedy for a spawned task is a new task (review-7 N6, stated).
6. **One human decision per gate:** at most one step per gate (statically validated); the frame never double-presents (the resume rule + the transcript).
7. **Materialization + filename:** only the flow writes files; placement/filename/versioning derive from the artifact's TYPE via the vocab registry (each `artifactTypes` entry carries category + versioned flag — a LISTED vocab.json migration); a new type in an existing category = data; a new `docs/` category = a v13 §15 amendment.
8. **The confirm-bound deadlock is rejected at VALIDATION** — via the step's declared `produces?[]`: a chain whose ONLY artifact-producing step is confirm-bound fails static validation (verify runs before the confirm gate; a deferred-only producer would deadlock verify). Verify's failure behaviour is NAMED — **ONE branch: verify fails → the frame writes `failed` (the finding as a named blocker), task concludes-as-failed** — bounded, never a gate-less loop (review-8 P6).

## 4. The frame (the resumable coordinator)

Gates named by the VOCAB (`grill` · `confirm`). Gate acquisition is TWO L1 writes: **`submit!` (writes `submitted`; the task derives `blocked`) then `gate! accept|reject` (writes the decision)** — an interrupted gate leaves the task genuinely resumable. `gate!`'s composite keeps convenience: it auto-writes `submitted` when no UNDECIDED submission exists — the predicate checks for a later `confirmed` **OR `rejected`** (review-7 N15 — the store's own derivation), so a rework cycle always re-enters `blocked`.

```
frontmost-ready (L1 look-back) → task
materialize    packet (context engine; reads via L1). THE RESOLUTION LADDER LIVES
               HERE: derive → probe → infer → ask → block (flow-control v6 §4) —
               rung enablement is registry data; v1 builds block only (deferral
               recorded; ask is buildable via interact but deferred with the rest).
GATE·grill     obtain the grill decision — ONE source: the frame's present-via-
               interact (default) or a chain step bound to at:'grill'. submit! →
               present → collect → gate! accept|reject. rejected → RE-MATERIALIZE
               from rejected.feedback (LOCKED routing), bounded: 3 → escalate.
validate       deterministic (L1/validators + packet readiness) — judgment stays with the runner
activate       the frame writes `activated` (idempotent on replay — no duplicate
               lifecycle events; review-7 N11). (Note: redefines flow-control v6:24's
               "activate" — recorded in §8.)
execute        run the chain in EXECUTION ORDER: grill-bound first, then at:'execute'
               in list order, then confirm-bound (GATE② is AFTER verify, locked);
               PHASE PLACEMENT is explicit: the grill-bound step runs AT the grill
               phase (before validate — it produces the grill decision), the
               confirm-bound step at the confirm phase; validateChain's "earlier"
               means EXECUTION ORDER (review-8 P9).
               Each step: inject ctx → execute → translate intents → L1 writes →
               run the step's rules → next; stop on failure (named). EMPTY CHAIN =
               the runner's work via abilities; outcomes arrive as L1 writes
               (append! evidence.commits[]) that the frame OBSERVES — the general
               case. NEVER SKIPPED; replay/rework discriminated by ctx.feedback;
               REPLAY SERVES LLM + INTERACT FROM THE TRANSCRIPT (zero model calls —
               NFR-CST-1 met; review-7 N12); rework re-fires, capped by the bound.
verify         outputs produced (materialized locks / evidence.commits[]) + ACs +
               step rules; judgment stays with the runner. FAILURE BEHAVIOUR NAMED
               (§3 rule 8). (Events record at commit, so verify checks OUTPUTS, not
               acceptance events.)
GATE·confirm   obtain the confirm decision — **submit!(confirm) RECORDS the working
               artifact's blob sha** (via the v14 §3 amendment — the gate② content
               binding, review-8 P2); submit! → gate!. rejected → RE-EXECUTE
               from feedback (LOCKED routing — rework produces fresh facts via the
               defer-record path, never supersede); feedback invalidating the
               approach escalates to the grill loop (flow-control v6 §3).
commit         the RUNNER does the git checkpoint (evidence.commits[] arrives via
               append! — OBSERVED); the commit phase RECORDS the task's deferred
               intents — materializes the shared `docs/<category>/<name>-v<N>.md`
               real file (placement, symlink, and `N` happen here — review-8 P4),
               records the `artifact-locked` events (sha computed from the file;
               REFUSES when it differs from the sha recorded at submit!(confirm) —
               review-8 P2), executes the deferred `propose-spawn`s (P1), then
               writes `completed` (idempotent on replay). Every task concludes;
               `completed`/`failed` always written.
look-back      derived review (L1 reads): where we are + what's ahead — never assumed
advance        propose the next task (frontmost) or spawn the next leg when the leg
               gate is met — derived from the tail, never stored.
```

**The reject bound (3/gate) is a CONSTANT** owned by `gate!` (L1) — never adjustable, never bypassable. L2 reads `{escalated}` only. **Frame-write idempotence** (review-7 N11): on replay, `activated`/`completed`/`failed` already in the tail are not re-written.

## 5. The read view (an L1 derived read)

- **`read.resolve(name) → {content, path, sha}`** is an L1 derived read (current() + a bounded file read) injected by L2 — NOT an L3 servant. **Marker-stripped content** (matching the lock-time hash). Provenance `derived-from`; `observation` stays reserved for the probe rung, unused in v1.
- **BOUND: `read.resolve` serves `requiredInputs` (cross-task, committed) only** — same-task chain sources resolve through `prior` (role-bound in-memory), never through read (review-8 P8). **The packet carries BOUNDED EXCERPTS of resolved inputs** (context-packet-spec:41,65) — `read.resolve` is the only **full-content** accessor; `prior` is the structured channel (NOT one mechanism with read — the claim was dropped).
- The packet never grows to carry full content.

## 6. Flows are DATA — the design target

```
chain entry = { id,
                inputs?: {role → source},   (bidirectional check vs step.roles)
                params?, at?: 'grill' | 'confirm' | 'execute' (default execute),
                verdict?: {decision ∈ step.decisions[] → {gate:'accept'|'reject', feedback?}} }
```

- The **gate-source data IS the chain**; at most one step per gate; the verdict map routes `out.verdict.decision` (∈ `decisions[]`) to gate decisions; missing/unmapped → fail closed. The gate SET and POSITIONS are protected; only the SOURCE is data.
- **What a work type is (a recorded DEFERRAL):** flow-control v6 §7's four parameterization columns — v1 implements **three of four deferred**; **chain-effect is served by `propose-spawn` intents**; the rest is the runner (S6).
- **Chains are LINEAR and UNCONDITIONAL** (stated as the v1 limit); the escape = a new work type or a step's internal decision.
- **New work types · chain shapes · gate sources · artifact types (existing category) = data.** **New chain steps (code units) = CODE** — implement + register (`src/kernel/steps/index.ts:8-12`). **TWO SENSES OF "STEP" NAMED** (review-8 P16): a JOURNEY step = a node (adding one is a spawn — data, per the locked requirements-spec-v3:33 "every step is a separately-managed node… no code change"); a CHAIN step = the code unit inside a task's chain. New roles on a step · new intents · new ladder rungs (unbuilt) = CODE.
- **An absent `workType` is as loud as an unknown one**: no workType and no `contract.flow` → `chains.default` if present, else a NAMED problem.
- AC-7 amendments and **closure** (`close` intent) are reachable. `prune` (F15) is **deferred**.

```
rules/flow/default.json:
chains: {
  default:         [{id:'idea-validate', at:'grill',
                     verdict:{solid:{gate:'accept'}, revise:{gate:'reject'}, reject:{gate:'reject'}}},
                    {id:'envision'}, {id:'spec', inputs:{vision:'envision'}}],
  implementation:  []
}
```

**The two default flows (illustrative data):** *Flow 1 — initial project* (planning): `idea-validate` (grill-bound; its verdict IS the grill decision; its doc file writes during the session, its event records at commit) → `envision` → `spec` (role `vision` ← envision; chain effect declares build-task spawns via `propose-spawn`). *Flow 2 — working with a task* (implementation): chain `[]` — the frame + runner; evidence `commits[]` (observed); commit → next frontmost.

## 7. Explicit non-goals (what the design forbids)

- steps never write files or events directly — intents are declarations; the flow materializes and writes; the transcript lives at the ability layer, ending at `append!`
- steps never see the store — packet + read + abilities only; `shell` is an OS-process ability, never the L1 surface
- the flow never writes directly — all writes via L1 commands (the only cross-task write: `superseded` on the old locker)
- no unbounded loops — 3-reject bound is a constant, chains bounded + validated, resumable not restartable (transcript replay, defer-record rework, resume from the tail)
- no gate-skipping — the STORE refuses the writes (post-cutoff); the frame observes gates; prose paths grandfathered for legacy nodes only
- no hard-wired flow content in code — flows are data; the builtin fallback is the EMPTY CHAIN; absent workType is a named problem
- no silent inference — the resolution ladder is named; v1 builds `block` only (registry enablement)
- no prose as truth — machine-truth events; the transcript is structured (`trace` records), never prose
- error shape is the LOCKED `{ok:false, error:{code, blocker}}` everywhere

## 8. What v1 ships + the recorded amendments

1. **L1: the command surface** — complete; `spawn!` enforces the v14 schema + F-AC19 + artifact gate + leg gate + id naming (moved from the CLI; the `description.md` write is RETIRED); `submit!` (new); `gate!` (decide, bound, composite predicate fixed); `append!` refuses composite-owned kinds + `created`; `read` as a derived view; `--json` structured emit; CLI = a thin binding (drops `cmdGate`'s duplicate gate-sequence check)
2. **L2: the frame** — §4 with `activate`, the idempotent driver (three tail states; execute never skipped), submit/present/decide gates, the transcript replay channel, the defer-record lock path, verify-failure naming, frame-write idempotence
3. **L2: intent translation** — §3 (five intents; replay/rework via `ctx.feedback`; defer-record instead of supersede; gate-bound ordering; bidirectional role validation; the confirm-bound deadlock check; type-driven placement/filename)
4. **L2: gate-source routing + verdict maps + role-bound inputs** — §6
5. **L2: steps** rebuilt — `idea-validate` (interactive, grill-bound, transcript-replayable), `envision`, `spec` (roles/decisions/paramsSchema)
6. **L2: read view wiring** — §5
7. **L3: abilities** — llm (existing adapter; transcript emission `(stepId, runId, seq)` through the L2 record hook), interact (console, 4 verbs, transcript-replayable), read (the L1 view), shell/tool (protocol-declared, unbuilt; `request` dropped)
8. **Amendments recorded BEFORE implementation** (each: complete superseding artifact, same logical name, preserving section anchors, back-reference, `superseded` event, referrer re-pointing):
   - **journey-format v13 → v14**: §2 (workType/flow/model; node.json schema incl. top-level `openQuestions`; REQUIRED set) · **§3 (the `trace` record on `evidence` — the transcript's home, shape-policed for all four kinds; the gate②-confirmed sha record)** · **§4 (:90 "artifact-locked is written the moment the artifact locks" + :87/:88 write-timing — DEFER-RECORD deviates; recorded as the amendment's own rationale)** · §14/§15 (the `-v<N>` filename rule is ADDED, not amended — v13 has none); the `store.spawn` write + `context.ts` read changes are OWNED by this ship list (not "unchanged")
   - **architecture v2 → v3**: the layer model — LB-4 (:27), :60, :38-58, :71-80 (five tiers → L0 store ← L1 commands ← L2 flow ← L3 surface/abilities; engines fold into L2; adapters become abilities) · **:63 ("the kernel routes each step to its engine" — falsified by the fold)** · **:62 (reads via derived views — now via L1) · :65 (the adapter tier dissolves into L3 abilities) · :64 partially** · :24,61 single-initiator → multi-client in-process (RECONCILES ann-system-design-v3:59 — whose initiator list is "planner kernel, adapters, validators/reviewer", NOT the CLI) · :66 enforcement-split (artifact gate + contract invariants → L1 `spawn!`) · :97 error shape (steps use it); fixes AGENTS.md:46
   - **resource-registry v2 → v3**: `schema` category (:36) + `vocab` instance row (:51-57) + **the :63 code-literal-duplicates reconciliation** (eventTypes/statuses enforcement) — RECONCILES architecture-v2:84; **THREE LISTED data migrations: vocab.json (artifactTypes → category + versioned) · rules/decide/rules.json (enabled flags) · rules/flow/default.json (chains: workType → string[] becomes {workType → entry[]} with at/inputs/params/verdict, + the loader assertion at flow.ts:64 + the validate → idea-validate rename — review-8 P7)**
   - **flow-control v6**: RECORDED DEFERRALS — §7's four columns (three deferred; chain-effect via `propose-spawn`), §4's ladder rungs 2–4 (block only; enablement data once built); the `activate` redefinition note (:24)
   - **doc sweep (listed for the re-implementation, not the design)**: `ann-system-design-v3.md:7` internal title `(v2)` · `functional-spec:44`'s `AC-8/RPO` citation · `requirements-spec-v3:43`'s `F-AC8` citation — the cosmetics four prior reviews asked for (review-8 Q2 edit 18)
9. L0 substrate unchanged: store, format (as amended), packet (the two small read/write fixes owned above), validators, provider adapter
