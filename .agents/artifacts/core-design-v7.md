# Ann Core Design — v7 (draft, for review)

*Re-implementation target. The locked substrate (journey-format v13, store single-writer, packet spec, provider adapter, S4 validators, honesty-layer engines) stays. Incorporated: design reviews #1–#6 (2026-08-25). The design target: a system that is SIMPLE and FLEXIBLE — the machinery is small and stable; everything that varies (flows, steps, chains, gate sources, rework) is ADJUSTABLE DATA, so later flow changes are sound changes, not design changes.*

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
                      MULTI-CLIENT BY DESIGN (amends architecture v2:24,61 — see §8).
L0  STORE            JOURNEY DATA — node.json (immutable contract) · events.jsonl
                      (append-only, tasks) · artifacts (locked files) · registries
                      (rules/schema/flow). Single writer (appendEvent), strict
                      schema (v13 §3), derived views (status/current/results/check).
                      Knows nothing above.
```

**THE INVARIANT-OWNERSHIP TABLE** (per invariant, the enforcing layer — the line between adjustable and protected):

| Invariant | Layer | How |
|---|---|---|
| gate sequence: no `artifact-locked`/`completed` without the prior gate confirmed; no `confirm` gate without `grill` | **L0 — store** | refused by the writer. Unconditional for nodes with `createdAt >= CUTOFF` (`'2026-08-21'` — verified safe; 19 legacy tasks carry `retrospective` notes, all ≤ 2026-08-18, 5 leg roots exempt); the prose paths are GRANDFATHERED for pre-cutoff nodes only, removed from new writes |
| single writer: only commands write | **L1 + L0** | every write ends at `appendEvent`; L2/L3 never touch the store |
| leg status derived, never asserted | **L0** | derived views only; no component writes leg events |
| **node.json contract schema** (v14 §2, §2 below) | **L1 — `spawn!`** | shape enforcement + F-AC19 (hard reject) + id naming/prefix/sibling + artifact gate + leg gate — moved INTO `spawn!` from the CLI |
| reject bound: 3 per gate, then escalate | **L1 — `gate!`** | counts and refuses the 4th; `append!` refuses composite-owned kinds + `created`; L2 reads only `{escalated}` (never the threshold) |
| one-current-per-name | **L1 — `lock!`** | refused except the idempotent no-op / rework supersede (§3) |
| **vocab.eventTypes · vocab.statuses** | **protected** (v13:57-61) | enforced by code literals (`validateEventShape`, the status mappings); adding a kind/value = a v13 amendment — registry entries alone are a silent no-op or a wrong-named refusal (review-6 B9) |
| **vocab.gates** | **set/positions protected** (flow-control v6:17,34) | only the gate SOURCE is data; a new gate value = a gate no phase obtains |
| **vocab.artifactTypes** | **adjustable (data)** | entries carry a category; placement derives from it (§3) — a new type in an existing category is data; a new `docs/` category is a v13 §15 amendment |
| F-AC16 closure · F-AC18 conclusion + traceability | **post-hoc `check()`** | check-time validations, not write-path invariants — stated, not claimed as enforced |
| chain validity · intent ordering · gate-source routing · **intent idempotence + the replay/rework discriminator** · **cross-task write permission** · **artifact placement + filename + recorded path** · **chain linearity (no branching)** | **L2 — flow** | conventions, not invariants — statically validated before execution; bypassable only by another L1 client writing raw events, which the composite-kind refusal blocks |
| resolution-ladder rung enablement | **registry data** (`rules/decide/rules.json` — gains `enabled` flags, a listed §8 migration) | v1 ships `block` enabled; enabling a rung is data |

**The coordination loop:** get store info (L1 reads) → work the current task → run the step interface → translate intents → emit via L1 → observe gates → repeat. **Resumable**: interruption (pending gate, rejection, crash) leaves the task blocked/pending in the store; the resume point is **DERIVED from the event tail — never stored**, in THREE tail states: *last-at-gate `confirmed` → skip; `submitted` undecided → block and wait (produced by `submit!` — the submit-only mutator; review-6 B4); last `rejected` → the LOCKED rework rung runs and the gate IS re-obtained* (flow-control v6:36-38 — this design does not override it). **`execute` is NEVER skipped** (no tail marker; requirements-spec-v3:87); its replay safety rests on **intent idempotence DISCRIMINATED BY `ctx.feedback`** (§3): replay = no-op, rework = fresh facts. **L2 is not a monolithic loop** — gates are L1 writes the flow observes.

## 2. The step contract + the flow-data fields + the v14 amendment

```
step = { id, roles[] (the ROLES it consumes, code-side shape), rules[],
         decisions?[] (its possible verdict decisions — closes the verdict-map
                      static validation, review-6 C10),
         paramsSchema? (validated by the flow before injection — review-6 C5),
         execute(ctx) }
ctx  = { taskId · packet (materialized state, injected) ·
         params? (validated against paramsSchema) ·
         read (the L1 content read view, injected by L2) ·
         abilities { llm · interact · shell · tool } (L3 seams; shell = an OS-process
                ability, NEVER the L1 command surface) ·
         prior (the ROLE-BOUND inputs from the chain entry: {role → artifact};
                in-memory structured artifacts — NOT the same mechanism as
                read.resolve's text; the "one mechanism" claim is dropped) ·
         feedback? {gate, text} — the rework channel, SCOPED BY GATE (review-6 C4);
                PRESENT = rework, ABSENT = replay (the discriminator, §3) }
out  = { ok · artifact? · verdict? {decision ∈ decisions[], feedback?}
         intents?[] }
```

Rules:
- **A step never touches the store or the CLI.** State arrives injected; effects depart declared (intents + verdict). Steps have no write hook. The two-log trace survives at the ABILITY layer: `llm`/`interact` emit runtime task-fact events (keyed `(taskId, stepId, runId, seq)` — runId = the rejection count at the step's bound gate, derivable and monotonic) through an L2-owned record hook ending at `append!`; on REWORK runId advances so round-2 trace never collides with round-1 (review-6 B1). Steps do NOT duplicate in intents what their ability calls already emitted.
- **`inputs[]` move to the CHAIN ENTRY as role bindings** (review-6 B6 — AC-3): the step declares `roles[]` (e.g. `spec` needs role `vision`); the chain data binds `{role → source}` (a packet dep name or an earlier step id); the flow injects `ctx.prior = {role → artifact}`; `validateChain` checks role keys ⊆ step.roles and sources produced earlier. **Rewiring what a step consumes = data.** The step's `inputs[]` field is GONE from the step contract.
- **A step is re-runnable; intents are IDEMPOTENT ON REPLAY, FRESH ON REWORK** — the discriminator is `ctx.feedback` (present = rework; absent = replay), never the bytes:
  - replay: `lock-artifact` no-ops when `current(name).producer === taskId`; `propose-spawn` no-ops when the id exists; `supersede` no-ops when the old locker already carries `superseded{successor.name}`; `close` no-ops on the identical event in the tail; `evidence` dedups on `commits[].sha`/`refs[]`/`answers[].id` (trace emissions on `(stepId, runId, seq)`)
  - rework: every intent produces a FRESH fact — `lock-artifact` = **self-supersede-then-lock** (its own prior lock at the name is superseded, then the new content locks — supersede-before-lock, §3 rule 3); the trace advances by runId
- **Failure is a value** in the LOCKED shape: `{ok:false, error:{code, blocker}}` (architecture-v2:97; review-6 C14). A step whose intents the store rejects fails with the reason named.
- The flow's knowledge of a step is exactly the interface: id, roles, rules, decisions, paramsSchema, execute, out. No step internals.

**THE v14 AMENDMENT (the flow-data fields + the schema, precisely):** the chain-selecting fields `contract.workType · contract.flow · contract.model` are NOT in v13 §2. **Recorded: journey-format v13 → v14** (complete superseding artifact, same logical name, **preserving section anchors** + a **back-reference** + `superseded` event + **referrer re-pointing** — AGENTS.md:41/46/48 are already stale (v11/v1/v1) and get fixed; a `context-packet-spec` pointer is added). The amended **node.json schema** (matching v13's structure exactly, with the three fields added — NOT relocating anything):

```
node.json: {
  id (REQUIRED),
  contract: { intent (REQUIRED, non-empty) · acceptanceCriteria (REQUIRED, non-empty)
              · targetAreas · requiredInputs · expectedOutputs
              · workType (new) · flow (new) · model (new) },
  openQuestions: [] (TOP-LEVEL SIBLING of contract — as v13:33 has it; the packet
              assembler's read is fixed to match; 04-system-design's top-level
              openQuestions stays valid),
  createdAt (REQUIRED)
}
```

## 3. The intent vocabulary + translation rules

| intent | step declares | flow does |
|---|---|---|
| `evidence` | `{note, refs?, answers?[]}` — answers `{id, answer, provenance?}` | `append!` → `evidence` (dedup per §2) |
| `lock-artifact` | `{name, content\|path, type?}` — type drives placement + filename (§3 rule 7) | **materialize** (write `docs/<category>/<name>-v<N>.md` for shared types — real versioned file — or a task-local real file; `N` computed by the flow as next-version; task-local ref `artifacts/<name>.md` = symlink for shared types) → `lock!`; the RECORDED path = the task-local ref (symlink); replay no-op / rework self-supersede-then-lock (§2) |
| `propose-spawn` | `{id, contract}` — a task (F-AC19-valid) | validate → `spawn!`; no-op if the id exists |
| `supersede` | `{name, path}` — the old artifact (AC-7) | **the flow writes `superseded` on the OLD LOCKER's node** (the ONLY cross-task write, permitted for supersession alone); node-level supersession (a task superseded by a sibling) = the frame's `supersede!` on the old node |
| `close` | `{transferred? {target, scope} · deferred? {reason} · gate-revised? {old, new}}` | validate (F-AC16) → `append!` (dedup per §2) |

**Not step-declarable — the frame's own writes:** lifecycle (`activated` · `completed` · `failed`) · gates (`submitted` via `submit!` · `confirmed`/`rejected` via `gate!`). **Leg spawns are the frame's** (tasks = step intents; the next leg = advance, gated by `legGateMet`). (`extended` is annotate-only, `append!`-only.)

**Translation rules (stable, enforced by the flow — REJECT, never silently reorder):**
1. `spawn` is **not** an event — a child's `created` *is* the spawn record.
2. **Lock-before-spawn:** `lock-artifact` for a name precedes any `propose-spawn` whose contract's `requiredInputs` reference it (F-AC19 resolves via `current()` at spawn). Violation → rejected, named.
3. **Supersede-before-lock** (including rework self-supersede, §2): the store refuses a lock on an already-current name.
4. **Gate-bound ordering:** a step bound to the grill gate runs to produce the gate decision; its non-gate intents translate ONLY AFTER the gate is CONFIRMED (on rejection, only the verdict/feedback flows to the gate). **On resume with the gate already confirmed, the gate-bound step re-runs in REPLAY mode — its interact calls are served from the recorded answer trace (keyed by runId), the human is NEVER re-interviewed at a decided gate** (review-6 B8; the trace is the replay source, not just a crash log).
5. **Chain validation split across the layer line:** L1 `spawn!` validates the contract SHAPE (the v14 schema); L2 validates the chain's MEANING (ids registered, role bindings valid, execution order, inputs resolvable) against the **prospective contract** (the entry's declared inputs + requiredInputs — L2 reads those from the contract data, never from a packet that doesn't exist pre-spawn) BEFORE calling `spawn!`, and again on the resolved chain AT EXECUTE. Both fail closed, named. The floor carries zero step-registry dependency.
6. **One human decision per gate:** at most one step per gate (statically validated); the frame never double-presents (the §1 resume rule + the replay channel, rule 4).
7. **Materialization + filename:** only the flow writes files. Placement and filename derive from the artifact's TYPE via the vocab registry (each `artifactTypes` entry carries its category + whether it is versioned): shared contract-stack types (`spec · system-design · architecture`) → real versioned file `docs/<category>/<name>-v<N>.md` + symlink ref `artifacts/<name>.md`; task-local types (`record · vision · validation`) → task-local real file. The `-vN` suffix is how the logical-name resolver works (`store.ts:74`); AC-7's "old artifact stays byte-identical" is preserved because the real file is versioned. A new type in an existing category = data; a new `docs/` category = a v13 §15 amendment.

## 4. The frame (the resumable coordinator)

Gates named by the VOCAB (`grill` · `confirm`). Gate acquisition is TWO L1 writes: **`submit!` (writes `submitted`, task → blocked) then `gate! accept|reject` (writes the decision)** — so an interrupted gate leaves the task genuinely `blocked`, resumable at leisure (review-6 B4). `gate!` keeps the composite submit+decide for CLI convenience.

```
frontmost-ready (L1 look-back) → task
materialize    packet (context engine; reads via L1). THE RESOLUTION LADDER LIVES
               HERE: derive → probe → infer → ask → block (flow-control v6 §4) —
               rung enablement is registry data; v1 ships block enabled (the §4
               deferral is RECORDED: rungs 2-4 deferred; `ask` is buildable via the
               interact ability but deferred with the rest).
GATE·grill     obtain the grill decision — ONE source: the frame's present-via-
               interact (default) or a chain step bound to at:'grill'. submit! →
               present → collect → gate! accept|reject. rejected → RE-MATERIALIZE
               from rejected.feedback (LOCKED routing), bounded: 3 → escalate.
validate       deterministic (L1/validators + packet readiness) — judgment stays with the runner
activate       the frame writes `activated` (the ONLY writer). (Note: redefines
               flow-control v6:24's "activate = frontmost-ready selection" — the
               selection moved to the top of the frame; the phase name now means
               "write activated" — recorded in the §8 amendment list.)
execute        run the chain's steps in EXECUTION ORDER: grill-bound first (at the
               grill phase), then at:'execute' entries in list order, then
               confirm-bound (at the confirm phase — the locked lifecycle places
               GATE② AFTER verify). validateChain's "earlier" = EXECUTION ORDER.
               Each step: inject ctx → execute → translate intents → L1 writes →
               run the step's rules → next; stop on failure (named). EMPTY CHAIN =
               the runner's work: outcomes arrive as L1 writes (append!
               evidence.commits[]) that the frame OBSERVES — the general case.
               NEVER SKIPPED; replay/rework discriminated by ctx.feedback (§2).
verify         ACs + evidence + step rules; judgment stays with the runner.
               (A confirm-bound step's output is gated by the confirm gate itself —
               its deferred lock lands after verify; stated, not silent, review-6 C1.)
GATE·confirm   obtain the confirm decision (frame present, or a step bound to
               at:'confirm') — submit! → gate!. rejected → RE-EXECUTE from feedback
               (LOCKED routing — and the rework discriminator makes it produce fresh
               facts, review-6 B1); feedback that invalidates the approach escalates
               to the grill loop (flow-control v6 §3).
commit         the RUNNER does the git checkpoint (its evidence.commits[] arrives
               via append! — OBSERVED, not written by the frame); the commit phase
               verifies conclusion evidence exists, then writes `completed` — every
               task concludes; `completed`/`failed` always written.
look-back      derived review (L1 reads): where we are + what's ahead — never assumed
advance        propose the next task (frontmost) or spawn the next leg when the leg
               gate is met — derived from the tail, never stored.
```

**The reject bound (3/gate, then escalate) is a CONSTANT** owned by `gate!` (L1) — never adjustable, never bypassable. L2 reads `{escalated}` only.

## 5. The read view (an L1 derived read)

- **`read.resolve(name) → {content, path, sha}` is an L1 derived read** (current() + a bounded file read) injected into ctx by L2 — NOT an L3 servant. **Returns MARKER-STRIPPED content** (the lock marker is stripped before hashing at lock time; a step re-hashing what it read must match — review-6 C9). Provenance `derived-from` (current() = the derive rung; `observation` stays reserved for the probe rung, unused in v1).
- **BOUND to the chain entry's inputs ∪ requiredInputs** (fail closed) — `inputs[]` (role bindings) is the declaration, `read.resolve` the only accessor, `prior` the structured channel (§2 — NOT one mechanism with read; the claim is dropped).
- The packet stays the navigation/grounding view — never grows to carry content.

## 6. Flows are DATA — the design target

**Chain entries carry everything an instance needs — inputs, params, phase, verdict:**

```
chain entry = { id,
                inputs?: {role → source},   (role ∈ the step's roles[]; source = a
                                             packet dep name or an earlier step id)
                params?, at?: 'grill' | 'confirm' | 'execute' (default execute),
                verdict?: {decision ∈ step.decisions[] → {gate:'accept'|'reject', feedback?}} }
```

- The **gate-source data IS the chain**; at most one step per gate (statically validated); the verdict map routes `out.verdict.decision` (∈ the step's declared `decisions[]` — the static-validation claim is now exact) to gate decisions; missing/unmapped → fail closed, named. The gate SET and POSITIONS are protected; only the SOURCE is data.
- **What a work type is (a recorded DEFERRAL):** flow-control v6 §7's table has four parameterization columns (Materialize · Missing input · Verify · Chain effect) — no "chain column." v1 implements **three of four deferred**; **chain-effect is served by `propose-spawn` intents**; the rest is the runner (S6). (Review-6 C16 — stated without self-contradiction.)
- **Chains are LINEAR and UNCONDITIONAL** (no branch/repeat — stated as the v1 limit); the escape is a new work type or a step's internal decision (review-6 C6).
- **New work types/steps/chain shapes/gate sources/artifact types (existing category) = data changes**; the seams are the chain schema, step registration, intent vocabulary, and the vocab registry; the L0/L1 floor carries zero flow knowledge.
- **An absent `workType` is as loud as an unknown one**: no workType and no `contract.flow` → the project's `chains.default` if present, else a NAMED problem (never a silent lifecycle-only fallback; review-6 C7).
- AC-7 amendments and **closure** (`close` intent; closure tasks run their own gates) are reachable through the command surface + intents. `prune` (F15) is **deferred** (stated; review-6 C13).

```
rules/flow/default.json:
chains: {
  default:         [{id:'idea-validate', at:'grill',
                     verdict:{solid:{gate:'accept'}, revise:{gate:'reject'}, reject:{gate:'reject'}}},
                    {id:'envision'}, {id:'spec', inputs:{vision:'envision'}}],
  implementation:  []
}
```

**The two default flows (illustrative data):** *Flow 1 — initial project* (planning): `idea-validate` (grill-bound; its verdict IS the grill decision; its doc locks AFTER the gate confirms — and re-runs in replay mode from the answer trace) → `envision` → `spec` (consumes role `vision` ← envision; chain effect declares build-task spawns via `propose-spawn`). *Flow 2 — working with a task* (implementation): chain `[]` — the frame + runner work; evidence `commits[]` (observed); commit → next frontmost.

## 7. Explicit non-goals (what the design forbids)

- steps never write files or events directly — intents are declarations; the flow materializes and writes; the runtime trace lives at the ability layer, also ending at `append!`
- steps never see the store — packet + read + abilities only; `shell` is an OS-process ability, never the L1 command surface
- the flow never writes directly — all writes via L1 commands (the only cross-task write: `superseded` on the old locker)
- no unbounded loops — 3-reject bound is a constant, chains bounded and validated, resumable not restartable (idempotence discriminated by feedback, resume from the tail)
- no gate-skipping — the STORE refuses the writes (post-cutoff); the frame observes gates; prose paths grandfathered for legacy nodes only
- no hard-wired flow content in code — flows are data; the builtin fallback is the EMPTY CHAIN (never a code-side step id); an absent workType is a named problem, never silent
- no silent inference — the resolution ladder is named; v1 ships `block` enabled (registry data)
- no prose as truth — machine-truth events; legacy prose parsing grandfathered by cutoff
- error shape is the LOCKED `{ok:false, error:{code, blocker}}` everywhere (steps included; review-6 C14)

## 8. What v1 ships + the recorded amendments

1. **L1: the command surface** — complete; `spawn!` enforces the v14 schema + F-AC19 + artifact gate + leg gate + id naming (moved from the CLI; the `description.md` card write is RETIRED — v13 removed the card); `submit!` (new — the resumable-gate write); `gate!` (decide, with the 3-reject bound); `append!` refuses composite-owned kinds + `created`; `read` as a derived view; `--json` structured emit; CLI = a thin binding (drops `cmdGate`'s duplicate gate-sequence check)
2. **L2: the frame** — §4 with `activate`, the idempotent driver (three tail states; execute never skipped), the submit/present/decide gate acquisition, the replay channel (gate-bound steps served from the answer trace), locked rework rungs
3. **L2: intent translation** — §3 (five intents, replay/rework discriminated by `ctx.feedback`; supersede-before-lock incl. self-supersede; gate-bound ordering; shape/meaning validation split; type-driven placement + filename)
4. **L2: gate-source routing + verdict maps + role-bound inputs** — §6 (chain entries with inputs/params/at/verdict; static validation against `roles[]`/`decisions[]`/`paramsSchema`)
5. **L2: steps** rebuilt — `idea-validate` (interactive session, grill-bound, replayable from the trace), `envision`, `spec` (roles/decisions/paramsSchema declared); never touching the store
6. **L2: read view wiring** — §5 (L1 derived read, marker-stripped, bound to inputs ∪ requiredInputs)
7. **L3: abilities** — llm (existing adapter; trace emission keyed (stepId, runId, seq) through the L2 record hook), interact (console, 4 verbs, replayable), read (the L1 view), shell/tool (protocol-declared, unbuilt; `request` is dropped — noted)
8. **Amendments recorded BEFORE implementation** (each: complete superseding artifact, same logical name, **preserving section anchors**, back-reference, `superseded` event, referrer re-pointing):
   - **journey-format v13 → v14**: `workType`/`flow`/`model`; the node.json schema as stated (§2 — `openQuestions` stays a top-level sibling; REQUIRED set per v13:41); the artifact filename/versioning rule (§3 rule 7)
   - **architecture v2 → v3**: the layer model itself — **LB-4 (:27) five tiers → L0 store ← L1 commands ← L2 flow ← L3 surface/abilities** (a COMMANDS layer is inserted; engines fold into L2 as step internals; adapters become abilities); :60 dependency chain; :38-58 diagram; :71-80 repo tree; :24,61 single-initiator → multi-client commands (RECONCILES ann-system-design-v3:59); :66 enforcement-split (artifact gate + contract invariants move to L1 `spawn!`); :97 error shape stays (steps use it); fixes AGENTS.md:46 (v1 → v2)
   - **resource-registry v2 → v3**: `schema` category added to the enumeration (:36) + a `vocab` instance row (:51-57) — a RECONCILIATION of architecture-v2:84; the vocab.json migration (artifactTypes → entries with category/versioned) is a listed §8 data change
   - **flow-control v6**: RECORDED DEFERRALS — §7's four parameterization columns (three deferred; chain-effect via `propose-spawn`) and §4's ladder rungs 2–4 (block only, enablement as registry data); the `activate` redefinition note (:24)
9. L0 substrate unchanged: store, format, packet, validators, provider adapter
