# Ann Core Design — v3 (draft, for review)

*Re-implementation target. The locked substrate (journey-format v13, store single-writer, packet spec, provider adapter, S4 validators, honesty-layer engines) stays. This document is the contract the core is re-implemented against. Incorporated: design review #1 (2026-08-25) and review #2 (2026-08-25).*

**The design target:** a system that is **simple and flexible** — the machinery is small and stable; everything that varies (flows, steps, chains, gates, rework) is **adjustable data**, so later changes to the flows are sound changes, not design changes.

## 0. The model

The product is the journey. The journey is data: nodes, events, artifacts — status **derived** from the event tail, never asserted. A journey moves through a **fixed frame**: materialize → gate① → validate → execute → verify → gate② → commit → look-back → advance. The frame runs the current task's **chain of steps**; steps are **pure units** that receive injected state and declare **intents**; the flow translates intents into store writes **via the command layer**. The human is a seam: present, ask, decide. **Commands are the only interface to the store.**

## 1. Layers (strict down-only dependency)

```
L3  UI + ABILITIES   human channel (present·ask·decide) · llm · tool/command ·
                      read-view implementation. Servants: injected into L2 seams,
                      work as the flow moves. Implement L2-defined interfaces;
                      never imported by L2/L1/L0.
L2  FLOW             THE RESUNABLE COORDINATOR. Owns: the frame (lifecycle),
                      steps + chains (data), intent → command translation, gate
                      observation, bounded rework, advance/spawn proposals.
                      Reads L1; writes ONLY via L1; defines the step/intent/ability
                      interfaces; ability implementations injected from L3.
L1  COMMANDS         THE STORE'S INTERFACE — and the ONLY path to the store.
                      Reads (derived views: status · packet · flow · results ·
                      look-back · specs · check).
                      Writes (the mutators): spawn! · append! · gate! · lock! ·
                      supersede!. COMPLETE over the event vocabulary: every event
                      kind is writable (append! is the generic strict-schema path;
                      the composite commands encode invariants — gate sequence,
                      artifact sha, per-name supersession).
                      The CLI binds commands to argv; the flow binds them to its
                      logic; a future web server binds them to HTTP.
L0  STORE            JOURNEY DATA — node.json (immutable contract) · events.jsonl
                      (append-only, tasks) · artifacts (locked files) · registries
                      (rules/schema/flow). Single writer (appendEvent), strict
                      schema (v13 §3), derived views (status/current/results/check).
                      Knows nothing above.
```

**The coordination loop:** get store info (L1 reads) → work the current task → run the step interface → translate intents → emit via L1 → observe gates → repeat. **Resumable**: any interruption (pending gate, rejection) leaves the task blocked/pending in the store; resumption reads state and continues from the resume point. **L2 is not a monolithic loop** — gates are L1 writes the flow observes (`pendingGates`), never assumed.

## 2. The step contract

```
step = { id, inputs[], rules[], execute(ctx) }
ctx  = { taskId · packet (materialized state, injected) ·
         read (narrow read view) ·
         abilities { llm · interact · tool · command · request } (L3 seams) ·
         prior (earlier steps' artifacts) ·
         feedback? (last rejected.feedback for this task — the rework channel) }
out  = { ok
         artifact?  — in-memory result for DOWNSTREAM steps
         verdict?   — a GENERIC human-decision outcome: {decision, feedback?}
                      (the flow routes it per flow data — never reads step internals)
         intents?[] — what the step wants done; the flow translates to L1 writes }
```

Rules:
- **A step never touches the store or the CLI.** State arrives injected (packet + read + prior); effects depart declared (intents + verdict). No `ctx.store`, no imperative write hook — the flow is the only writer.
- **Two `inputs[]` semantics, NAMED:** a packet-dependency input resolves to the bounded excerpt; an earlier step's id resolves to that step's **full** artifact.
- **A step is re-runnable:** it receives `feedback` and can re-execute; bounded rework (3 rejects per gate, then escalate) lives in the frame, keyed to the resume point — never unbounded.
- Failure is a value: `{ok:false, blocker}` (named, never fabricated). A step whose intents the store rejects fails with the reason named.
- The flow's knowledge of a step is exactly the interface: id, inputs, rules, execute, out. No step internals.

## 3. The intent vocabulary + translation rules

Steps speak **intents**, not events. The flow translates intents into L1 writes; **only commands write events** (single writer preserved).

| intent | step declares | flow does |
|---|---|---|
| `evidence` | `{note, refs?, answers?[]}` — answers `{id, answer, provenance?}` **per the store schema** | `append!` → `evidence` event |
| `lock-artifact` | `{name, content\|path, type?}` | **materialize** (write the file · blob sha · one-current-per-name) → `lock!` → `artifact-locked` |
| `propose-spawn` | `{id, contract}` | validate contract (F-AC19) → `spawn!` → node.json + `created` |

**Not step-declarable — the frame's own writes via L1:** lifecycle (`activated` · `completed` · `failed`) · gates (`submitted` · `confirmed` · `rejected`) · closure/amendment (`superseded` · `transferred` · `deferred` · `gate-revised`).

**Translation rules (stable, enforced by the flow):**
1. `spawn` is **not** an event — v13 §3 removed `spawned`; a child's `created` event *is* the spawn record. `propose-spawn` is an intent; `spawn!` records `created`.
2. **Intent ordering:** within and across steps, `lock-artifact` for a name precedes any `propose-spawn` whose contract's `requiredInputs` reference that name (F-AC19 resolves via `current()` at spawn). The flow enforces this when translating.
3. **One human decision per gate:** a step verdict is routed to `gate!` events by the flow **per the task's flow data** (see §6) — the frame never double-presents a gate, and the routing (which gate, which rework rung) is data, not code.
4. **Materialization ownership:** only the flow writes files (the single writer owns all persistence). `lock-artifact`'s content is written by the flow, then locked; the product docs are task-local real files (no symlink — only the shared contract-stack symlinks).

## 4. The frame (the resumable coordinator)

```
frontmost-ready (L1 look-back) → task
materialize    packet (context engine; reads via L1)
GATE①          present via L3 → human decides → gate! (L1) → observe
               rejected → rework from rejected.feedback (rung per flow data;
               bounded: 3 → escalate to a human design decision)
validate       deterministic (L1/validators + packet readiness) — judgment stays with the runner
execute        run the chain — each step: inject ctx → execute → translate intents →
               L1 writes → run the step's co-located rules → next; stop on failure (named)
               EMPTY CHAIN = the runner's work: the runner does the task work via
               abilities; the frame records its outcomes (evidence.commits[] + refs[])
               via append! on its behalf — outside the step-intent vocabulary
verify         ACs + evidence + step rules; judgment stays with the runner
GATE②          present via L3 → gate! (L1) → rejected → re-execute from feedback
commit         the RUNNER does the git checkpoint; the frame's commit phase records
               the resulting evidence.commits[] (append!) + writes completed (append!)
               — every task concludes; `completed`/`failed` are always written
look-back      derived review (L1 reads): where we are + what's ahead — never assumed
advance        propose the next task (frontmost) or the next leg when the leg gate is
               met; spawn proposals are DATA (the task/leg the next step declares)
```

**Gates are L1 writes the flow observes** (`pendingGates`, status derivation) — never assumed, never skipped. The 3-reject bound is enforced by the frame (the flow refuses the 4th). **`completed`/`failed`/`activated` have a named write path** (the frame via `append!`; dedicated commands are CLI sugar, not design).

## 5. The read view (narrow content access)

Steps need content, not just excerpts. The packet stays the navigation/grounding view (statuses · capped excerpts · deps · siblings · questions). **Content access is a narrow injected read view — an ability, not `ctx.store`, not packet growth:**
- `read.resolve(name) → {content, path, sha, sourceType: 'observation'}` — full artifact content by logical name; **the observation label attaches at the read** and flows forward in the step's intents (provenance, design §6).
- **Flag:** this claims the `observation` slot that context-packet-spec marks "reserved, unused in v1" — a **packet-spec amendment**, recorded via the amendment path when this design locks (never silent).
- **`inputs[]` vs `read.resolve` reconciled:** declare via `inputs[]` when the need is known at step definition (the flow materializes + injects, chain-validated); pull via `read.resolve` when the content need is conditional or discovered during execution. Both read-only; neither touches the store.

## 6. Flows are DATA — the design target

The design's stable core (L0–L5 above) guarantees, once and for all:
- **any chain expressible** — work-type → chain in `rules/flow/default.json`; `contract.flow` overrides; empty chain = lifecycle only; unknown work type = named problem, never silent
- **any step pluggable** — implement `Step`, register in `defaultSteps()`, reference by id in chain data; no other wiring
- **any event writable** — the command surface is complete over the vocabulary
- **gates, verdicts, rework, spawn proposals adjustable** — routing is flow data with defaults, not code

**The two default flows are ILLUSTRATIVE DATA, not the design:**
- *Flow 1 — initial project* (planning): chain `[validate, envision, spec]`; validate = interactive idea-validation session → generic verdict → routed by flow data to gate① (the idea verdict IS the grill decision — one human decision per gate); envision + spec produce docs (`lock-artifact`); spec's chain effect declares the build-task spawns (`propose-spawn` — eager skeleton, lazy leaves).
- *Flow 2 — working with a task* (implementation): chain `[]` (lifecycle only) — the frame + runner work, evidence `commits[]`, commit → next frontmost.

Future flow changes — new steps, review/closure/binding work types, AC-7 amendments (served by `spawn!`/`supersede!`/`append!` today) — are **data changes within this design**, not design changes. The design is sound so those later changes are sound.

## 7. Explicit non-goals (what the design forbids)

- steps never write files or events directly — `lock-artifact`/intents are declarations; the flow materializes and writes (single writer owns all persistence)
- steps never see the store — packet + read + abilities only
- the flow never writes directly — all writes via L1 commands
- no unbounded loops — 3-reject bound per gate, bounded chains, resumable not restartable
- no gate-skipping — gates observed from the log, enforced by the frame, never by step discipline
- no hard-wired flow content in code — flows are data; code never overrides project config (AC-4)

## 8. What v1 ships (the re-implementation slice)

1. L1: the **command surface** as stated (§1) — complete over the vocabulary; CLI = a thin binding; the flow calls the same ops; structured emit (`--json` on derived-view commands)
2. L2: the **frame** (resumable coordinator, §4) + **intent translation** (§3 rules) + **rework channel** + **gate observation**
3. L2: **steps** rebuilt on the new contract (§2): validate (interactive session), envision, spec — declaring intents/verdict, never touching the store
4. L2: **read view** interface (§5; v1 file implementation) — with the packet-spec amendment recorded
5. L3: abilities — llm (existing adapter), interact (console), read-view (file); tool/command stay protocol-declared
6. L0/L1 substrate unchanged: store, format, packet, validators, provider adapter
