# Ann Core Design — v4 (draft, for review)

*Re-implementation target. The locked substrate (journey-format v13, store single-writer, packet spec, provider adapter, S4 validators, honesty-layer engines) stays. Incorporated: design reviews #1–#3 (2026-08-25). The design target: a system that is SIMPLE and FLEXIBLE — the machinery is small and stable; everything that varies (flows, steps, chains, gate sources, rework) is ADJUSTABLE DATA, so later flow changes are sound changes, not design changes.*

## 0. The model

The product is the journey. The journey is data: nodes, events, artifacts — status **derived** from the event tail, never asserted. A journey moves through a **fixed frame**: materialize → gate① → validate → activate → execute → verify → gate② → commit → look-back → advance. The frame runs the current task's **chain of steps**; steps are **pure units** that receive injected state and declare **intents**; the flow translates intents into store writes **via the command layer**. The human is a seam: present, ask, decide. **Commands are the only interface to the store.**

## 1. Layers (strict down-only dependency) + invariant ownership

```
L3  UI + ABILITIES   human channel (present·ask·decide) · llm · tool/command ·
                      read view. Servants: injected into L2 seams, work as the flow
                      moves. Implement L2-defined interfaces; never imported by
                      L2/L1/L0.
L2  FLOW             THE RESUMABLE COORDINATOR. Owns: the frame (lifecycle),
                      steps + chains (data), intent → command translation, gate
                      observation, bounded rework, advance/spawn proposals.
                      Reads L1; writes ONLY via L1; defines the step/intent/ability
                      interfaces; ability implementations injected from L3.
L1  COMMANDS         THE STORE'S INTERFACE — the ONLY path to the store.
                      Reads (derived views: status · packet · flow · results ·
                      look-back · specs · check).
                      Writes (the mutators): spawn! · append! · gate! · lock! ·
                      supersede!. COMPLETE over the event vocabulary: every event
                      kind is writable (append! is the generic strict-schema path;
                      the composite commands encode invariants — gate sequence,
                      artifact sha, per-name supersession, reject bound).
                      The CLI binds commands to argv; the flow binds them to its
                      logic; a future web server binds them to HTTP.
L0  STORE            JOURNEY DATA — node.json (immutable contract) · events.jsonl
                      (append-only, tasks) · artifacts (locked files) · registries
                      (rules/schema/flow). Single writer (appendEvent), strict
                      schema (v13 §3), derived views (status/current/results/check).
                      Knows nothing above.
```

**INVARIANT OWNERSHIP (review-3 B5 — per invariant, the enforcing layer):**

| Invariant | Enforcing layer | How |
|---|---|---|
| gate sequence: no `artifact-locked`/`completed` without the prior gate confirmed; no `confirm` gate without `grill` | **L0 — the store** | `appendEvent`/`validateEventShape` refuse the write (already true today, `store.ts:559-593`). *No flow data can skip a gate because the store won't take the write.* |
| reject bound: 3 per gate, then escalate | **L1 — `gate!`** | `gate!` counts rejects and refuses the 4th; `append!` REFUSES event kinds owned by composite commands (`submitted`/`confirmed`/`rejected`/`artifact-locked`/`superseded`) so the bound is not bypassable |
| single writer: only commands write | **L1 + L0** | every write path ends at `appendEvent`; L2/L3 never touch the store |
| chain validity · intent ordering · gate-source routing | **L2 — the flow** | conventions, not invariants — statically validated before execution (see §3/§6); bypassable only by another L1 client writing raw events, which the composite-kind refusal above blocks |
| leg status derived, never asserted | **L0** | derived views only; no component writes leg events |

**The coordination loop:** get store info (L1 reads) → work the current task → run the step interface → translate intents → emit via L1 → observe gates → repeat. **Resumable**: any interruption (pending gate, rejection) leaves the task blocked/pending in the store. **The frame's driver is ONE idempotent advance operation**: it runs phases until it blocks (pending gate / missing input / rejected chain), then stops; the resume point is **derived from the event tail — never stored** (a step-scoped fact is not needed because intents are idempotent, §2/§3). **L2 is not a monolithic loop** — gates are L1 writes the flow observes (`pendingGates`), never assumed.

## 2. The step contract

```
step = { id, inputs[], rules[], execute(ctx) }
ctx  = { taskId · packet (materialized state, injected) ·
         read (narrow read view) ·
         abilities { llm · interact · tool · command } (L3 seams) ·
         prior (earlier steps' artifacts — a locked artifact is automatically
                available downstream; content is never double-carried) ·
         feedback? (last rejected.feedback for this task — the rework channel) }
out  = { ok
         artifact?  — in-memory result for DOWNSTREAM steps (or via the locked artifact)
         verdict?   — a GENERIC human-decision outcome: {decision, feedback?}
                      (the flow routes it per the gate-source data — never reads step internals)
         intents?[] — what the step wants done; the flow translates to L1 writes }
```

Rules:
- **A step never touches the store or the CLI.** State arrives injected (packet + read + prior); effects depart declared (intents + verdict). No `ctx.store`, no imperative write hook — the flow is the only writer.
- **Two `inputs[]` semantics, NAMED:** a packet-dependency input resolves to the bounded excerpt; an earlier step's id resolves to that step's **full** artifact.
- **A step is re-runnable and intents are IDEMPOTENT:** re-running a step is always safe — `lock-artifact` whose content sha equals the current lock is a **no-op**, not a refusal; `evidence` and `propose-spawn` dedupe on the produced fact. This is what makes "resumable, not restartable" true (review-3 B1).
- **Failure is a value:** `{ok:false, blocker}` (named, never fabricated). A step whose intents the store rejects fails with the reason named.
- The flow's knowledge of a step is exactly the interface: id, inputs, rules, execute, out. No step internals. A verdict decision value the routing data doesn't map → fail closed, named.

## 3. The intent vocabulary + translation rules

Steps speak **intents**, not events. The flow translates intents into L1 writes; **only commands write events** (single writer preserved).

| intent | step declares | flow does |
|---|---|---|
| `evidence` | `{note, refs?, answers?[]}` — answers `{id, answer, provenance?}` per the store schema | `append!` → `evidence` event |
| `lock-artifact` | `{name, content\|path, type?}` | **materialize** (write the file · blob sha · one-current-per-name) → `lock!` → `artifact-locked`; idempotent: matching sha = no-op |
| `propose-spawn` | `{id, contract}` — a **task** (F-AC19-valid contract: intent, ACs, resolvable requiredInputs) | validate contract + chain (at spawn time) → `spawn!` → node.json + `created` |
| `close` | `{transferred? {target, scope} · deferred? {reason} · gate-revised? {old, new}}` | validate (F-AC16) → `append!` → closure events |

**Not step-declarable — the frame's own writes via L1:** lifecycle (`activated` · `completed` · `failed`) · gates (`submitted` · `confirmed` · `rejected`). **Leg spawns are the frame's, not steps'** (M10): tasks = step intents; the next leg = the frame's advance, gated by `legGateMet`.

**Translation rules (stable, enforced by the flow — REJECT, never silently reorder):**
1. `spawn` is **not** an event — v13 §3 removed `spawned`; a child's `created` event *is* the spawn record. `propose-spawn` is an intent; `spawn!` records `created`.
2. **Intent ordering:** within and across steps, `lock-artifact` for a name precedes any `propose-spawn` whose contract's `requiredInputs` reference that name (F-AC19 resolves via `current()` at spawn). The flow **rejects** a violation (named) — never silently reorders.
3. **AC-7 ordering:** `supersede!` the old artifact BEFORE `lock!` the new (the store refuses a lock on an already-current name). Stated, enforced by the flow.
4. **`contract.flow` / chain validity is validated AT SPAWN** (when `propose-spawn` is translated), not at execute — `node.json` is immutable; a bad chain must never be written (review-3 M6).
5. **One human decision per gate:** the gate-source data (§6) names at most one step per gate; the frame never double-presents. Verdict → `gate!` mapping is validated statically (review-3 B2).
6. **Materialization ownership:** only the flow writes files (the single writer owns all persistence); product docs are task-local real files (no symlink — only the shared contract-stack symlinks).

## 4. The frame (the resumable coordinator)

```
frontmost-ready (L1 look-back) → task
materialize    packet (context engine; reads via L1). THE RESOLUTION LADDER LIVES
               HERE: derive → probe → infer → ask → block (flow-control v6 §4).
               v1 ships ONLY the block rung (missing input → named blocker); the
               other rungs are NAMED, deferred — never silently inferred.
GATE①          obtain the grill decision — ONE source: per the gate-source data,
               either the frame's present-via-interact (default) or a chain step
               bound to at:'gate1' (e.g. the interactive idea-validation session).
               The decision is written via gate! (submitted + confirmed/rejected).
               rejected → RE-MATERIALIZE from rejected.feedback (LOCKED routing,
               flow-control v6 §3 — the rung is not adjustable), bounded: 3 →
               escalate to a human design decision.
validate       deterministic (L1/validators + packet readiness) — judgment stays
               with the runner (S6)
activate       the frame writes `activated` (the ONLY writer; `active` status
               derives from it, store.ts:162-164)
execute        run the chain's at:'execute' steps — each: inject ctx → execute →
               translate intents → L1 writes → run the step's co-located rules →
               next; stop on failure (named blocker). EMPTY CHAIN = the runner's
               work: the runner does the work via abilities; its outcomes arrive
               as L1 writes (append! evidence.commits[]) that the frame OBSERVES —
               the general case, not an exception.
verify         ACs + evidence + step rules; judgment stays with the runner
GATE②          obtain the confirm decision (frame present via interact, or a
               step bound to at:'gate2') → gate! → rejected → RE-EXECUTE from
               feedback (LOCKED routing); if the feedback invalidates the approach,
               escalate to the GATE① loop (flow-control v6 §3)
commit         the RUNNER does the git checkpoint; the frame's commit phase records
               the resulting evidence.commits[] (append!) + writes `completed`
               (append!) — every task concludes; `completed`/`failed` always written
look-back      derived review (L1 reads): where we are + what's ahead — never assumed
advance        propose the next task (frontmost) or spawn the next leg when the leg
               gate is met — derived from the tail, never stored
```

**The reject bound (3/gate, then escalate) is a CONSTANT** owned by `gate!` (L1) — never adjustable by flow data, never bypassable by `append!` (composite-kind refusal, §1).

## 5. The read view (narrow content access)

- `read.resolve(name) → {content, path, sha}` — full artifact content by logical name. **Provenance: `derived-from`** — resolution via `current()` is the derive rung (context-packet-spec §3/§4). `observation` is reserved for the probe rung (git/files/external) and stays unused until probing ships — **no packet-spec amendment is needed for name resolution** (review-3 M2). How provenance reaches the store: `evidence.answers[].provenance` today; a locked artifact's origin is its locking task (derived-from by construction).
- **BOUND to declared inputs:** `read.resolve` refuses names outside `inputs[]` ∪ `requiredInputs` (fail closed) — preserving F-AC19 grounding; the packet stays the honest picture of what the task consumed (review-3 M8). This collapses `inputs[]` and `read.resolve` into ONE content mechanism: `inputs[]` is the declaration (chain-validated), `read.resolve` is the only accessor.
- The packet stays the navigation/grounding view (statuses · capped excerpts · deps · siblings · questions) — never grows to carry content.

## 6. Flows are DATA — the design target

**Chain entries carry phase binding + params:** `{id, params?, at?: 'gate1' | 'gate2' | 'execute'}` (default `execute`). The gate-source data IS the chain: a step bound to `at:'gate1'` supplies the grill decision; at most one step per gate (statically validated). The default (no bound step) = the frame's present-via-interact. **This resolves the review-3 Q5-1 problem as data**: the idea-validation step binds to gate① at its LOCKED position (flow-control §2) — the lifecycle is not moved; the decision source is data.

```
rules/flow/default.json (v3 shape):
chains: {
  planning:        [{id:'idea-validate', at:'gate1'}, {id:'envision'}, {id:'spec'}],
  implementation:  []
}
```

- **What a work type is (stated):** v1 collapses flow-control v6 §7's work-type table to its CHAIN column (which steps run). The materialize/missing-input/verify/chain-effect parameterization is expressed as steps in the chain or deferred to the runner (S6) — explicitly stated, not silently dropped (review-3 M1).
- **New work types/steps/chains/gate sources = data changes** within this design — the chain schema, step registration, and intent vocabulary are the seams; the L0/L1 floor carries zero flow knowledge.
- **AC-7 amendments** (change → amendment node → complete superseding artifact → `supersede!` → referrer re-pointing) and **closure** (`close` intent; closure tasks run their own gates) are served by the command surface + flow data — stated, reachable.
- The 3-reject bound, gate sequence, and single-writer are NOT adjustable (the ownership table, §1) — that is the line between adjustable and protected.

**The two default flows (illustrative data):**
- *Flow 1 — initial project* (planning): `idea-validate` (bound to gate① — the interactive session, verdict IS the grill decision, one human decision per gate) → `envision` (vision doc) → `spec` (detailed specs; chain effect declares the build-task spawns via `propose-spawn` — eager skeleton, lazy leaves; lock-before-spawn ordering enforced).
- *Flow 2 — working with a task* (implementation): chain `[]` — the frame + runner work; evidence `commits[]`; commit → next frontmost.

## 7. Explicit non-goals (what the design forbids)

- steps never write files or events directly — intents are declarations; the flow materializes and writes (single writer owns all persistence)
- steps never see the store — packet + read + abilities only
- the flow never writes directly — all writes via L1 commands
- no unbounded loops — 3-reject bound is a constant, chains are bounded and validated at spawn, resumable not restartable (idempotent intents)
- no gate-skipping — the STORE refuses the writes (L0); the frame observes gates from the log (L2); neither is bypassable
- no hard-wired flow content in code — flows are data; a builtin chain is a SEED/FALLBACK, never an override of project data (AC-3)
- no silent inference — the resolution ladder is named; v1 ships only `block`

## 8. What v1 ships (the re-implementation slice)

1. L1: the **command surface** as stated (§1) — complete over the vocabulary, composite-kind refusal on `append!`, `--json` structured emit on derived-view commands; CLI = a thin binding
2. L2: the **frame** (§4 — with `activate`, the driver = one idempotent advance, resume derived from the tail) + **intent translation** (§3 — idempotent, ordered, spawn-time chain validation) + **gate-source routing** (§6) + **rework channel** (locked rungs)
3. L2: **steps** rebuilt on the new contract (§2): `idea-validate` (interactive session, gate-bound), `envision`, `spec` — declaring intents/verdict, never touching the store; chain data updated (`idea-validate`, phase binding)
4. L2: **read view** (§5 — bound to declared inputs, derived-from provenance)
5. L3: abilities — llm (existing adapter), interact (console), read (file); tool/command protocol-declared, unbuilt
6. L0/L1 substrate unchanged: store, format, packet, validators, provider adapter
