# Ann Core Design — v13 (draft, for review)

*Re-implementation target. The locked substrate (journey-format v13, store single-writer, packet spec, provider adapter, S4 validators, honesty-layer engines) stays. Incorporated: design reviews #1–#12 (2026-08-25/26) + owner decisions (2026-08-26: general config; conditional chains; verify fail cycles). The design target: a system that is SIMPLE and FLEXIBLE — the machinery is small and stable; everything that varies (flows, steps, chains, gate sources, rework) is ADJUSTABLE DATA, so later flow changes are sound changes, not design changes.*

**The mechanism (review-7 decision, review-8 MEASURED SOUND):** *files are working state, events are acceptance.* A step's `lock-artifact` intent writes the file immediately (re-written each rework pass); the `artifact-locked` EVENT records only at commit (after gate② confirms). **`propose-spawn` defers to commit alongside it** (both acceptance-shaped writes). No `superseded` is ever written on a live node. The trace is a schema-legal **transcript** that makes replay deterministic; the replay/rework discriminator is **transcript presence**, never `ctx.feedback`.

**THE GENERAL CONFIG (owner decision, 2026-08-26):** a user-facing config file, `rules/config/default.json` (per-project registry data — the resource-registry pattern; the personal overlay stays at `~/.ann/config.json` for provider/model/credentials). **Precedence: user config > project config > builtin defaults.** It holds the END-USER KNOBS: `flow.conditionals` (lifts the linear-chain limit) and `flow.verifyFailCycles` (bounded retry at the verify rung), plus F17's spec'd preferences (ask-vs-assume, defaults). The GATE REJECT BOUND (3) and the gate set/positions stay LOCKED constants — the config moves the limits the design chose, not the invariants the store enforces. Full section: §1/§6/§8.

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
| gate sequence: no `artifact-locked`/`completed` without the prior gate confirmed; no `confirm` gate without `grill` | **L0 — store** | refused by the writer (UNCONDITIONAL — `gateProblems` reads no `createdAt`; review-9 N6). The re-implementation REMOVES the two prose escapes from `gateProblems` entirely — the `retrospective`-note suppression and the empty-gate fallback (they are legacy-only; 19 measured pre-cutoff tasks carry them, all ≤ 2026-08-18; the CUTOFF grandfathers them at CHECK-REPORTING, not at the writer) |
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
| chain validity · gate-source routing · **intent idempotence + the transcript-presence discriminator** · **cross-task write permission** · **artifact placement/filename/recorded path** · **frame-write idempotence** · **working-file lifecycle** (task-local, unpoliced; `check()` is event-anchored — a file without an event is outside the integrity model; never pruned — stated, review-8 P4/P12) | **L2 — flow** | SPLIT: STATICALLY VALIDATED (chain validity · gate-source routing · **the `when` condition's OWN references + the two skip-safety rules** (required-role binding, no gate-bound `when`) — via the step's declared `roles[]`/`produces?[]`/`decisions[]` + the config; NOT over-claimed: downstream skip-safety is the explicit rules, not a general claim — review-12 §II.2a/2b) · RUNTIME/CONVENTION-ONLY (intent ordering — satisfied BY CONSTRUCTION via deferral, not statically checkable · idempotence · cross-task permission — `supersede!` accepts an arbitrary target, no enforcer exists · placement/filename · frame-write idempotence) — nothing over-claimed (review-8 Q5, review-9 edit 7) |
| **chain linearity** | **configurable** (v12/v13) | chains are LINEAR by default (`flow.conditionals: false`; a chain carrying `when` under `false` FAILS CLOSED, named); setting `true` enables `when?` — linear-with-optional-skips, recorded as `kind:'skip'` trace records (a branch decision is derivable from the tail — NFR-OBS-1; review-12 §II.2e). The GATE reject bound and gate set/positions are NOT affected — they stay locked (§1:54) |
| **verify-fail cycles** | **configurable** (v12) | `flow.verifyFailCycles: N` — default 1 (today's fail-closed single branch), CEILING 3 (a constant; NFR-CST-1 — never open). Each retry re-runs execute FRESH with the finding as feedback; cycles are recorded in the trace (`kind: 'verify'` — schema-legal, tail-derivable, survives crashes). The GATE reject bound stays a locked constant — this knob is the verify rung only |
| **the general config registry** (`rules/config/default.json`) | **data, adjustable** | the user-facing knobs (conditionals · verify cycles · ask-vs-assume · defaults); precedence user > project > builtin; read via the resource-registry pattern — never hardcoded |
| resolution-ladder rung enablement | **registry data** — `rules/decide/rules.json` gains `enabled` flags (a LISTED §8 migration); **enablement is data once a rung exists; v1 builds only `block`** (review-7 N8) | enabling an unbuilt rung is a no-op or crash — the row says so |
| **`params`/`paramsSchema`** | **L2** (convention) | the flow validates params against the step's `paramsSchema` before injection; a mismatch → fail closed, named (review-8 Q5, fourth ask) |
| **`at:` values** | **mixed namespace, stated** | `'grill'`/`'confirm'` come from `vocab.gates`; `'execute'` is a phase literal — the chain loader validates against both (review-8 Q5) |
| **two-write gate acquisition** | **L1 `submit!` + `gate!`** (convention) | the two-write sequence (submitted, then the decision) is enforced inside `gate!`/`submit!` — a bare `confirmed` without `submitted` is legal in the store but the commands never produce it (review-8 Q4-5) |
| **gate②-to-commit content binding** | **L1 + L2** | `submitted.confirmedSha` at the gate (L1) vs the sha at commit (L2) — mismatch → commit writes `failed` (review-8 Q5, review-9 edit 5) |

**The coordination loop:** get store info (L1 reads) → work the current task → run the step interface → translate intents → emit via L1 → observe gates → repeat. **Resumable** — interruption (pending gate, rejection, crash) leaves the task blocked/pending; the resume point is **DERIVED from the event tail**, in THREE tail states: *last-at-gate `confirmed` → skip the gate WRITE (the step still re-runs from the transcript — a decided gate skips the write, never the step); `submitted` undecided → block and wait (produced by `submit!`); last `rejected` → the LOCKED rework rung runs and the gate IS re-obtained* (flow-control v6:36-38). **`execute` is NEVER skipped**; its replay safety = **intent idempotence + the transcript**, discriminated by **TRANSCRIPT PRESENCE** (§2 — NEVER `ctx.feedback`, which review-8 measured broken). **L2 is not a monolithic loop** — gates are L1 writes the flow observes.

## 2. The step contract + the flow-data fields + the v14 amendment

```
step = { id, roles[] (each REQUIRED or OPTIONAL — the shape it consumes),
         produces?[] (the intents it MAY declare — makes the confirm-bound deadlock
         check statically decidable (absence = "produces NOTHING" — fail-closed); review-8 P5),
         rules[], decisions?[], paramsSchema?, execute(ctx) }
ctx  = { taskId · packet · params? (validated) ·
         read (L1 content view, injected) ·
         abilities { llm · interact · shell · tool } (shell = OS-process, NEVER the L1 surface) ·
         prior (role-bound in-memory artifacts: {role → artifact}) ·
         feedback? {gate, text} — the rework channel, SCOPED BY GATE. DELIVERY keys on
                        the PHASE THE REWORK RE-ENTERS (review-9 N2): a grill rejection
                        re-enters at materialize (everything runs fresh with feedback);
                        a confirm rejection re-enters at execute (execute-phase and
                        confirm-bound steps run fresh with feedback; earlier grill-bound
                        steps REPLAY — their gate is still confirmed). THE DISCRIMINATOR
                        IS AUTHORITATIVE for fresh-vs-replay; this delivery rule governs
                        FEEDBACK ROUTING ONLY (review-10, recommended edit 4) }
out  = { ok · artifact? · verdict? {decision ∈ decisions[], feedback?} · intents?[] }
```

Rules:
- **A step never touches the store or the CLI.** State arrives injected; effects depart declared. Steps have no write hook.
- **The TRACE is a TRANSCRIPT** (review-7 N2, review-8 measured): `llm`/`interact` emit runtime records — keyed `(taskId, stepId, runId, seq)` with the LLM completion text and the interact question+answer — through an L2-owned record hook ending at `append!`, in a **schema-legal home**: the v14 §3 amendment lets an `evidence` event carry an optional structured `trace` record `{stepId, runId, seq, kind: 'llm'|'ask'|'research'|'decide', prompt?, completion?, question?, answer?, research?: [{topic, findings, sources?[]}], options?[]}` — shape-policed for ALL FOUR kinds (`research` is an ARRAY with per-topic `sources[]`; `decide` carries `options[]` — replay-by-identity needs both; `present` is deliberately unrecorded); machine-truth, never prose. **FRAME-PHASE records (v13, review-12 §III.3f): `kind: 'verify'` and `kind: 'skip'` are LEGALIZED by the same amendment with a key shape needing NO `stepId`/`runId` — `{phase: 'verify'|'skip', cycle, condition?}` — a verify cycle belongs to the frame's verify phase, a skip to the chain evaluator, neither to a step.** The transcript makes replay deterministic: on replay the LLM calls are served the recorded completions and the interact calls the recorded answers **by question identity** — the human is NEVER re-interviewed and the questions never drift (review-7 N3). NOTE: this reverses the two-log split (op-log = metrics, never text; the transcript puts text in `events.jsonl`) — stated; NFR-SEC-1 (`no secrets in the tree`) now applies to prompt text (review-8 P12).
- **The replay/rework discriminator is TRANSCRIPT PRESENCE, not `ctx.feedback`** (review-8 P3 measured; review-9 confirmed): an attempt is NEW when no `trace` record post-dates the **ATTEMPT BOUNDARY** — the LATER of (the latest `rejected` event at the step's bound gate, the latest verify-cycle record) — where the bound gate is `confirm` for `at:'execute'` steps and `grill` for grill-bound steps; otherwise it REPLAYS (served from the transcript; a MISS falls through to a live call and appends at the next `seq` under the same `runId`). `ctx.feedback` marks the attempt kind (rework) and carries the rejection text. **`runId` = 1 + (rejections at the bound gate) + (verify cycles in the current attempt)** — derivable from the tail, monotonic; replay keeps the same runId (stranded partial records are served), a NEW rejection or a NEW verify cycle advances it (fresh records never collide). **This amends the review-10-settled runId derivation — a verify cycle is an ATTEMPT (review-12 §III.3a, measured: without the verify-cycle term, a verify retry REPLAYS and fails identically).**
- **`inputs[]` are role bindings on the CHAIN ENTRY** (AC-3): the step declares `roles[]` (with required/optional markers); chain data binds `{role → source}`; `validateChain` checks BOTH directions — every bound role is declared AND every REQUIRED role is bound (review-7 N5); the flow injects `ctx.prior`. Rewiring consumption = data.
- **A step is re-runnable; intents are IDEMPOTENT ON REPLAY, FRESH ON REWORK** — the discriminator is TRANSCRIPT PRESENCE (§2; the step's bound gate = `confirm` for `at:'execute'` steps, `grill` for grill-bound steps), never the bytes:
  - **replay (crash-resume):** `lock-artifact` → the file already exists (working state) → no re-write needed, no event to record (events record at commit); `propose-spawn` no-ops when the id exists; `supersede` no-ops on the identical event; `close` no-ops on the identical event; `evidence` dedups on `commits[].sha`/`refs[]`/`answers[].id` (trace records on `(stepId, runId, seq)`)
  - **rework (rejection):** every intent produces FRESH work — the lock file re-writes, runId advances (a new rejection), the event still records only at commit (no re-lock conflict, NO `superseded` on a live node — review-7 B1 resolved)
- **Failure is a value** in the locked shape `{ok:false, error:{code, blocker}}`. A step whose intents the store rejects fails named.

**THE v14 AMENDMENT** (complete superseding artifact, same logical name, preserving section anchors, back-reference, `superseded` event, referrer re-pointing — AGENTS.md:41/46/48 fixed, a `context-packet-spec` pointer added):
- **§2 — the node.json schema**: `id (REQUIRED) · contract{ intent (REQUIRED) · acceptanceCriteria (REQUIRED, non-empty) · targetAreas · requiredInputs · expectedOutputs · workType · flow · model } · openQuestions[] (TOP-LEVEL SIBLING — as v13:33 has it) · createdAt (REQUIRED)`. The packet assembler's read (`context.ts:88-91`) and `store.spawn`'s write are changed to match — **the "L0 substrate unchanged" ship list is corrected to own these two small changes** (review-7 N10).
- **§3 — the event schema**: `evidence` may carry the optional structured `trace` record (above — the transcript's home); **`submitted` may carry an optional structured `confirmedSha`** (the gate② content binding — recorded at `submit!(confirm)`, over marker-stripped content; review-8 P2, review-9 edit 5).
- **§14/§15 — the artifact filename rule** (§3 rule 7 below).

## 3. The intent vocabulary + translation rules

| intent | step declares | flow does |
|---|---|---|
| `evidence` | `{note, refs?, answers?[]}` | `append!` → `evidence` (dedup per §2) |
| `lock-artifact` | `{name, content\|path, type?}` | **materialize the WORKING FILE immediately** — a TASK-LOCAL real file in `artifacts/` (the shared `docs/<category>/<name>-v<N>.md` placement, the symlink, and `N` happen AT COMMIT, with the event — review-8 P4: a failed task's draft never sits unaccepted in the shared contract stack; v13:223) — **the `artifact-locked` EVENT records only at COMMIT** (§4), once the task's gates are accepted. Rework re-writes the working file; the event never double-locks; no `superseded` on live nodes (review-7 B1) |
| `propose-spawn` | `{id, contract}` — a task (F-AC19-valid), **a leg SIBLING (depth 2 — schedulable by `frontmostReady`/`tasksOf`; a depth-3 child would be invisible to both, review-9 N7)** | **DEFERS TO COMMIT alongside `lock-artifact`** (review-8 P1 measured): the child spawns at commit, after the parent's artifacts are `current()` — **F-AC19 via `current()` is the load-bearing reason for the ordering** (at depth 2 the parent is the leg, and the artifact gate is not consulted — `cli.ts:702-705`; review-10 edit 5). CONSEQUENCES STATED: NO spawn-and-consume in one run (the child does not exist until the parent commits — no channel can read it; the linear-unconditional chain limit points the same way) · deferred spawns DIE with a `failed` task (acceptance-shaped writes die with acceptance, like the deferred lock) · no-op if the id exists |
| `supersede` | `{name, path}` — the old artifact (AC-7) | **`superseded` on the OLD LOCKER's node** (the ONLY cross-task write). Node-level supersession IS reachable through this artifact-shaped path (review-9 N5): the status collapse in `store.ts:171-173` applies to ANY non-`done`/`failed` node carrying `superseded` — so the frame REFUSES to supersede a locker that is not `done` (a live locker in the commit window is protected). TWO meanings, stated: artifact replaced · node replaced — rework is NOT a third (rework is the defer-record path) |
| `close` | `{transferred? {target, scope} · deferred? {reason} · gate-revised? {old, new}}` | validate (F-AC16) → `append!` (dedup per §2) |

**Not step-declarable — the frame's own writes:** lifecycle (`activated` · `completed` · `failed`) · gates (`submitted` via `submit!` · `confirmed`/`rejected` via `gate!`). **Leg spawns are the frame's.** (`extended` is annotate-only, `append!`-only.)

**Translation rules (stable, enforced by the flow — REJECT, never silently reorder):**
1. `spawn` is **not** an event — a child's `created` *is* the spawn record.
2. **Lock-before-spawn is satisfied BY CONSTRUCTION** (review-9 N1): with both `lock-artifact` and `propose-spawn` deferred to commit and commit ordering locks-before-spawns (§4), a child's `requiredInputs` always resolve when its `spawn!` runs. No ordering check needed — the v8 parenthetical that prescribed binding through `prior` (a remedy that does not exist for a spawned child) is DELETED.
3. **Supersede-before-lock** applies to AC-7 amendments (the old locker supersedes, then the new locks). Rework NEVER supersedes (the defer-record path).
4. **Gate-bound ordering:** a gate-bound step runs to produce the gate decision; its `lock-artifact` FILE writes immediately, its EVENT records when the gate confirms (at commit — the gate sequence invariant is satisfied because commit follows gate②). On resume at a decided gate, the step re-runs **from the transcript** (same completions, same questions, same answers by identity) — the human is never re-interviewed.
5. **Chain validation split:** L1 `spawn!` validates the contract SHAPE; L2 validates the chain's MEANING (ids registered, role bindings bidirectional, execution order, inputs resolvable) against the prospective contract BEFORE `spawn!`, and again AT EXECUTE. Both fail closed, named. The floor carries zero step-registry dependency. **A chain edit that introduces a new packet-dep binding applies only to unspawned tasks** — `node.json` is immutable (v13:43); the remedy for a spawned task is a new task (review-7 N6, stated).
6. **One human decision per gate:** at most one step per gate (statically validated); the frame never double-presents (the resume rule + the transcript).
7. **Materialization + filename:** only the flow writes files; placement/filename/versioning derive from the artifact's TYPE via the vocab registry (each `artifactTypes` entry carries category + versioned flag — a LISTED vocab.json migration); a new type in an existing category = data; a new `docs/` category = a v13 §15 amendment.
8. **The confirm-bound deadlock is rejected at VALIDATION** — via the step's declared `produces?[]` (its absence means "produces NOTHING" — fail-closed; the translator REFUSES an intent the step did not declare, so the declaration cannot drift from `execute`; review-9 edits 5/6): a chain whose ONLY artifact-producing step is confirm-bound fails static validation. Verify's failure behaviour is NAMED and CONFIGURABLE (v12; corrected v13): **verify fails → the frame re-runs execute FRESH with the finding as feedback, up to `flow.verifyFailCycles` attempts (config; default 1; CEILING 3, a constant — NFR-CST-1 bounded, never open; there is NO "10× cap" — that is the spec's stress annotation, review-12 §III.3c). The cycle count is anchored AT THE LATEST GATE DECISION at `confirm` (resetting per rework pass — review-12 §III.3b); each cycle ADVANCES THE ATTEMPT BOUNDARY and `runId` (§2 — so a retry is a FRESH run, never a replay; review-12 §III.3a); cycles are recorded as FRAME-PHASE trace records `kind:'verify'` (§2 — tail-derivable, survives crashes); ceiling reached → the frame writes `failed` (the finding as a named blocker). Ceiling consequence STATED: ≤ 3 chain executions per task (the reject bound) × ≤ 3 cycles = **≤ 9 chain executions**, each running every step's model calls — formally bounded under NFR-CST-1 (review-12 §III.3c). **INERT FOR AN EMPTY CHAIN (flow 2): verify-fail there means "the runner has not committed yet" — a WAIT condition, not a defect — so `verifyFailCycles` is FORCED TO 1 and the frame BLOCKS rather than fails** (review-12 §III.3e — without this, the knob converts "wait for the runner" into a terminal `failed` on the most-used work type).

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
               case. NEVER SKIPPED; replay/rework discriminated by TRANSCRIPT PRESENCE
               (never ctx.feedback — §2);
               REPLAY SERVES LLM + INTERACT FROM THE TRANSCRIPT (zero model calls —
               NFR-CST-1 met; review-7 N12); rework re-fires, capped by the bound.
verify         outputs produced (materialized locks / evidence.commits[]) + ACs +
               step rules; judgment stays with the runner. FAILURE: re-run execute
               FRESH with the finding as feedback, up to flow.verifyFailCycles (config;
               default 1; ceiling 3) — cycles recorded as trace kind:'verify';
               ceiling reached → failed. (Events record at commit, so verify checks
               OUTPUTS, not acceptance events.)
GATE·confirm   obtain the confirm decision — **submit!(confirm) RECORDS the working
               artifact's blob sha** (via the v14 §3 amendment — the gate② content
               binding, review-8 P2); submit! → gate!. rejected → RE-EXECUTE
               from feedback (LOCKED routing — rework produces fresh facts via the
               defer-record path, never supersede); feedback invalidating the
               approach escalates to the grill loop (flow-control v6 §3).
commit         the RUNNER does the git checkpoint (evidence.commits[] arrives via
               append! — OBSERVED); the commit phase RECORDS the task's deferred
               intents — materializes the shared `docs/<category>/<name>-v<N>.md`
               real file BYTE-VERBATIM from the working file (placement, symlink,
               and `N` happen here — review-8 P4), records the `artifact-locked`
               events (sha computed over MARKER-STRIPPED content of the file; the
               sha recorded at submit!(confirm) is over the same bytes — the v14 §3
               amendment carries `submitted.confirmedSha`; COMMIT REFUSES on
               mismatch → the frame writes `failed` (named) — bounded, consistent
               with the commit-phase invariant that every task concludes; review-9
               edit 5), executes the deferred `propose-spawn`s
               (P1, in the stated depth-2 form), then writes `completed`
               (idempotent on replay). Every task concludes; `completed`/`failed`
               always written.
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
                verdict?: {decision ∈ step.decisions[] → {gate:'accept'|'reject', feedback?}},
                when?: {hasOutput?: stepId | verdict?: {step, decision}}
                       — CONDITIONAL EXECUTION (v13, enabled by flow.conditionals:
                       true): a false condition SKIPS the step — recorded as a
                       FRAME-PHASE trace record kind:'skip' {stepId, condition,
                       evaluated:false} (NFR-OBS-1: the journey stays the log — a
                       branch decision must be derivable from the tail; review-12
                       §II.2e). `inputMissing` is DROPPED (measured dead — an
                       unresolved requiredInput blocks before execute, kernel.ts:230;
                       missing-input research belongs to the resolution ladder's
                       probe/ask rungs, flow-control v6:43-51 — review-12 §II.2d).
                       `verdict` is QUALIFIED {step, decision}: step precedes this
                       entry in EXECUTION order and declares decision in its
                       decisions[] (review-12 §II.2c). SKIP-SAFETY (review-12
                       §II.2a/2b, stated as VALIDATION): (a) a REQUIRED role may not
                       bind to a conditional step unless the consuming entry is
                       itself conditional on hasOutput of that step — validateChain
                       cannot see `when` (flow.ts:124-127), so the binding rule is
                       explicit; (b) a GATE-BOUND entry (at:'grill'|'confirm') may
                       NOT carry `when` — a skipped gate source would deadlock the
                       gate silently (rule 6 forbids two gate-bound steps, so
                       conditionals cannot express alternative gate sources).

rules/config/default.json (the GENERAL CONFIG — per-project registry data):
{ registry: 'config', version: 1, category: 'config', kind: 'registry',
  definition: 'the general user-facing configuration — DATA, never code (F17; owner decision 2026-08-26)' ,
  flow: { conditionals: false,        // enables `when?` on chain entries (lifts the linear limit)
          verifyFailCycles: 1 }       // verify retries before failed (default 1; CEILING 3)
  preferences: { askVsAssume: 'ask', defaults: { … } } }   // F17: ask-vs-assume + defaults
ONE CONFIG CLASS, TWO INSTANCES (review-12 §I.1b): the PROJECT file holds flow.*
and preferences.*; the USER overlay (~/.ann/config.json — the frozen user-config
schema, AMENDED to admit flow.*/preferences.*) overrides preferences only —
`flow.conditionals` is PROJECT SEMANTICS and is NOT user-overridable (two people
must not run the same journey as different chains — the product IS the journey;
review-12 §I.1c). PRECEDENCE per leaf key: env > user > project > builtin
(resource-registry-v2:98; review-12 §I.1d). MANAGEMENT SURFACE: `ann config` gains
a project view; `ann config! set` gains the new keys (review-12 §I.1b.3).
VALIDATION: ill-typed or out-of-range values → NAMED problem, never a silent
clamp (flow.ts:76's standard); the builtin defaults are a code literal — a
KNOWING DUPLICATE of the registry, recorded as a reconciliation (the :54
precedent; review-12 §IV)
```

- The **gate-source data IS the chain**; at most one step per gate; the verdict map routes `out.verdict.decision` (∈ `decisions[]`) to gate decisions; missing/unmapped → fail closed. The gate SET and POSITIONS are protected; only the SOURCE is data.
- **What a work type is (a recorded DEFERRAL):** flow-control v6 §7's four parameterization columns — v1 implements **three of four deferred**; **chain-effect is served by `propose-spawn` intents**; the rest is the runner (S6).
- **Chains are LINEAR by default** (`flow.conditionals: false`). **Setting `flow.conditionals: true` enables `when?` on chain entries** — linear-with-optional-skips; a runtime branch is then DATA, not code (owner decision 2026-08-26). **THE NEW BOUNDARY, STATED HONESTLY (review-12 §V): skip-shaped only — no else-branch, no alternative step, no join; THREE fixed predicates — a fourth condition kind is a CODE change; NO conditional gate sources (rule 6); the flag is PROJECT-WIDE (one boolean for every chain in the project).** `conditionals: false` + a chain carrying `when` → FAIL CLOSED, named (flow.ts:76's standard; review-12 §II.2e). The GATE reject bound and gate set/positions are untouched by the flag.
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
- no gate-skipping — the STORE refuses the writes UNCONDITIONALLY (`gateProblems` reads no `createdAt`); the frame observes gates; the two prose escapes (the `retrospective`-note suppression, the empty-gate fallback) are REMOVED in the re-implementation, not grandfathered by cutoff (§1:46)
- no hard-wired flow content in code — flows are data; the builtin fallback is the EMPTY CHAIN; absent workType is a named problem
- no silent inference — the resolution ladder is named; v1 builds `block` only (registry enablement)
- no prose as truth — machine-truth events; the transcript is structured (`trace` records), never prose
- error shape is the LOCKED `{ok:false, error:{code, blocker}}` everywhere

## 8. What v1 ships + the recorded amendments

1. **L1: the command surface** — complete; `spawn!` enforces the v14 schema + F-AC19 + artifact gate + leg gate + id naming (moved from the CLI; the `description.md` write is RETIRED); `submit!` (new); `gate!` (decide, bound, composite predicate fixed); `append!` refuses composite-owned kinds + `created`; `read` as a derived view; `--json` structured emit; CLI = a thin binding (drops `cmdGate`'s duplicate gate-sequence check)
2. **L2: the frame** — §4 with `activate`, the idempotent driver (three tail states; execute never skipped), submit/present/decide gates, the transcript replay channel, the defer-record lock path, verify-failure naming, frame-write idempotence
3. **L2: intent translation** — §3 (five intents; replay/rework via TRANSCRIPT PRESENCE, never `ctx.feedback`; defer-record instead of supersede; gate-bound ordering; bidirectional role validation; the confirm-bound deadlock check; type-driven placement/filename)
4. **L2: gate-source routing + verdict maps + role-bound inputs** — §6
5. **L2: steps** rebuilt — `idea-validate` (interactive, grill-bound, transcript-replayable), `envision`, `spec` (roles/decisions/paramsSchema)
6. **L2: read view wiring** — §5
7. **L3: abilities** — llm (existing adapter; transcript emission `(stepId, runId, seq)` through the L2 record hook), interact (console, 4 verbs, transcript-replayable), read (the L1 view), shell/tool (protocol-declared, unbuilt; `request` dropped)
8. **Amendments recorded BEFORE implementation** (each: complete superseding artifact, same logical name, preserving section anchors, back-reference, `superseded` event, referrer re-pointing):
   - **journey-format v13 → v14**: §2 (workType/flow/model; node.json schema incl. top-level `openQuestions`; REQUIRED set) · **§3 (the `trace` record on `evidence` — the transcript's home, shape-policed for ALL SIX kinds incl. the frame-phase `verify`/`skip` records {phase, cycle, condition?} — v13, review-12 §III.3f; the gate②-confirmed sha record)** · **§4 (:90 "artifact-locked is written the moment the artifact locks" + :87/:88 write-timing — DEFER-RECORD deviates; recorded as the amendment's own rationale)** · §14/§15 (the `-v<N>` filename rule is ADDED, not amended — v13 has none); the `store.spawn` write + `context.ts` read changes are OWNED by this ship list (not "unchanged")
   - **architecture v2 → v3**: the layer model — LB-4 (:27), :60, :38-58, :71-80 (five tiers → L0 store ← L1 commands ← L2 flow ← L3 surface/abilities; engines fold into L2; adapters become abilities) · **:63 ("the kernel routes each step to its engine" — falsified by the fold)** · **:62 (reads via derived views — now via L1) · :65 (the adapter tier dissolves into L3 abilities) · :64 partially** · :24,61 single-initiator → multi-client in-process (RECONCILES ann-system-design-v3:59 — whose initiator list is "planner kernel, adapters, validators/reviewer", NOT the CLI) · :66 enforcement-split (artifact gate + contract invariants → L1 `spawn!`) · :97 error shape (steps use it); fixes AGENTS.md:46
   - **resource-registry v2 → v3**: `schema` category (:36) + `vocab` instance row (:51-57) + **`config` category (:36) — ONE CONFIG CLASS, TWO INSTANCES (project file + the user overlay; the frozen user-config schema :81-93 + config.ts:19-30 is AMENDED to admit flow.*/preferences.*; `ann config` gains a project view and `ann config! set` the new keys — review-12 §I.1b)** + **the :63 code-literal-duplicates reconciliation** (eventTypes/statuses enforcement; the builtin-defaults literal is a SECOND recorded reconciliation — review-12 §IV) — RECONCILES architecture-v2:84; **LISTED data changes: vocab.json (artifactTypes → category + versioned) · rules/decide/rules.json (enabled flags) · rules/flow/default.json (chains: workType → string[] becomes {workType → entry[]} with at/inputs/params/verdict/when, + the loader assertion at flow.ts:64 + the validate → idea-validate rename — review-8 P7) · rules/config/default.json (NEW FILE — the general config registry, created, not a migration) · ~/.ann/config.json schema + `ann config! set` keys (cli.ts:492/:810 — the user overlay the design leans on must be writable by a user)**
   - **flow-control v6**: RECORDED DEFERRALS — §7's four columns (three deferred; chain-effect via `propose-spawn`), §4's ladder rungs 2–4 (block only; enablement data once built); the `activate` redefinition note (:24)
   - **doc sweep (listed for the re-implementation, not the design)**: `ann-system-design-v3.md:7` internal title `(v2)` · `functional-spec:44`'s `AC-8/RPO` citation · `requirements-spec-v3:43`'s `F-AC8` citation — the cosmetics four prior reviews asked for (review-8 Q2 edit 18)
9. L0 substrate unchanged: store, format (as amended), packet (the two small read/write fixes owned above), validators, provider adapter
