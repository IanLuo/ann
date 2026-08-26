# Ann Core Design — v2 (draft, for review)

*Re-implementation target. Supersedes the accreted kernel/flow/commands layer. The locked substrate (journey-format v13, store single-writer, packet spec, provider adapter, S4 validators, the honesty-layer engines) stays; this document is the contract the core is re-implemented against. Incorporates the first design review (2026-08-25).*

## 0. The model in one paragraph

The product is the journey. The journey is data: nodes, events, artifacts — status **derived** from the event tail, never asserted. A journey moves through a fixed frame: materialize → gate① → validate → execute → verify → gate② → commit → look-back → advance. The frame runs the current task's **chain of steps**; steps are **pure units** that receive injected state and declare **intents**; the flow translates intents into store writes **via the command layer**. The human is a seam: present, ask, decide. **Commands are the only interface to the store.**

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
L1  COMMANDS         THE STORE'S INTERFACE. Reads (derived views: status · packet ·
                      flow · results · look-back) + writes (spawn! · gate! · append! ·
                      lock! · supersede! — the "!" mutators). The only path to the
                      store. The CLI binds commands to argv; the flow binds commands
                      to its logic; a future web server binds them to HTTP.
L0  STORE            JOURNEY DATA — node.json (immutable contract) · events.jsonl
                      (append-only, tasks) · artifacts (locked files) · registries
                      (rules/schema/flow). Single writer (appendEvent), strict
                      schema (v13 §3), derived views (status/current/results/check).
                      Knows nothing above.
```

**The coordination loop (what L2 does):** get store info (L1 reads) → work the current task → run the step interface → translate intents → emit via L1 → observe gates → repeat. Resumable: any interruption (pending gate, rejection) leaves the task blocked/pending in the store; resumption reads state and continues from the resume point. **L2 is not a monolithic loop — gates are L1 writes the flow observes, never assumed.**

## 2. The step contract

```
step = { id, inputs[], rules[], execute(ctx) }
ctx  = { taskId · packet (materialized state, injected) ·
         read (narrow read view) ·
         abilities { llm · interact · tool · command · request } (L3 seams) ·
         prior (earlier steps' artifacts) ·
         feedback? (last rejected.feedback for this task — the rework channel) }
out  = { ok · artifact? (in-memory result for DOWNSTREAM steps) ·
         intents?[] (what the step wants done — the flow translates to L1 writes) }
```

Rules:
- **A step never touches the store or the CLI.** State arrives injected (packet + read + prior); effects depart declared (intents). No `ctx.store`, no `recordEvidence` imperative hook — the flow is the only writer.
- **Two `inputs[]` semantics, NAMED in the contract:** a packet-dependency input resolves to the bounded excerpt; an earlier step's id resolves to that step's **full** artifact.
- **A step is re-runnable:** it receives `feedback` and can re-execute; bounded rework (3 rejects per gate, then escalate) lives in the frame, keyed to the resume point — never unbounded.
- Failure is a value: `{ok:false, blocker}` (named, never fabricated). A step whose intents the store rejects fails with the reason named.

## 3. The intent vocabulary (what steps may declare)

Steps speak **intents**, not events. The flow translates intents into L1 commands; **only commands write events** (single writer preserved).

| intent | step declares | flow does |
|---|---|---|
| `evidence` | `{note, refs?, answers?[]}` | `append!` → `evidence` event |
| `lock-artifact` | `{name, content\|path, type?}` | **materialize** (write file · blob sha · one-current-per-name · symlink into docs/) → `lock!` → `artifact-locked` |
| `propose-spawn` | `{id, contract}` | validate contract (F-AC19) → `spawn!` → node.json + `created` event |
| `answer` | `{questionId, answer, impact}` | folds into `evidence.answers` or the gate collection |

**NOT step-declarable (the frame's own writes, via commands):**
- lifecycle: `activated` · `completed` · `failed` — the coordinator marks them (only it knows the frame position)
- gates: `submitted` · `confirmed` · `rejected` — collected via the L3 channel → `gate!`
- closure/amendment: `superseded` · `transferred` · `deferred` · `gate-revised`

**Format correction from review #1:** `spawn` is **not** an event type — journey-format v13 §3 removed `spawned`; a child's `created` event *is* the spawn record, and `vocab.json` has no `spawn`. Step-declared `propose-spawn` is an *intent*; the flow's `spawn!` is what records `created`.

## 4. The frame (the resumable coordinator)

```
frontmost-ready (L1 look-back) → task
materialize    packet (context engine; reads via L1)
GATE①          present via L3 → human decides → gate! (L1) → observe
               rejected → rework: ctx.feedback = rejected.feedback → re-materialize
               (bounded: 3 → escalate to a human design decision)
validate       deterministic (L1/validators + packet readiness) — judgment stays with the runner (S6)
execute        run the chain — each step: inject ctx → execute → translate intents →
               L1 writes → run the step's co-located rules → next; stop on failure (named)
verify         ACs + evidence + step rules; judgment stays with the runner
GATE②          present via L3 → gate! (L1) → rejected → re-execute from feedback
commit         structured commit evidence (evidence.commits[] + refs[] via append!) —
               or a locked artifact; every task concludes
look-back      derived review (L1 reads): where we are + what's ahead — never assumed
advance        propose the next task (frontmost) or spawn the next leg when the leg
               gate is met (F5 run-next / F6 specify-task; eager skeleton, lazy leaves)
```

The **verdict → gate bridge** (review #1, #4): interactive steps (idea validation) conclude with a human verdict (solid/revise/reject) collected via the `interact` ability. The **flow maps the verdict to gate events** — one human-decision mechanism:
- `solid` → `gate! grill accept`
- `revise` → `gate! grill reject` + feedback (the step's remaining unknowns) → rework loop (bounded 3)
- `reject` → `gate! grill reject` + feedback → task failed or escalated

## 5. The read view (narrow content access)

Steps need content, not just excerpts (review #1, #3). The packet stays the navigation/grounding view (statuses · capped excerpts · deps · siblings · questions). **Content access is a narrow injected read view — an ability, not `ctx.store`, not packet growth:**
- `read.resolve(name) → {content, path, sha}` — full artifact content by logical name; provenance recorded as `observation` (design §6 taxonomy)
- interface defined at L2, implementation injected from L3 (file-based in v1; the web server later)
- a step that needs more than the packet declares it via `inputs[]`; the flow materializes and injects it

## 6. The two flows

**Flow 1 — initial project** (planning tasks, `contract.workType: 'planning'`): chain `[validate, envision, spec]`
- `validate` — interactive idea-validation session (via `interact`): bounded rounds, research with the user, human verdict → **verdict→gate bridge** → the **idea validation doc** (lock-artifact intent) becomes the `requiredInput` for envision/spec
- `envision` — product vision (usage + look; lock-artifact intent)
- `spec` — detailed specs from the vision (F9; lock-artifact intent); chain effect = the flow **proposes spawn** of the build legs/tasks (eager skeleton, lazy leaves)

**Flow 2 — working with a task** (execution tasks, `workType: 'implementation'`): chain `[]` — lifecycle only
- the frame: materialize → gate① → execute (the runner's work via abilities; `evidence.commits[]` intents) → verify (tests + evidence) → gate② → commit → look-back → advance (commit → next frontmost)
- `rules/flow/default.json` selects the chain by work type; `contract.flow` overrides all (data over data)

## 7. Explicit non-goals (what the design forbids)

- steps never write files directly — `lock-artifact` is an intent; the flow materializes (the single writer owns all persistence)
- steps never see the store — packet + read + abilities only
- the flow never writes directly — all writes via L1 commands
- no unbounded loops — 3-reject bound per gate, bounded chains, resumable not restartable
- no gate-skipping — gates are observed from the log (`pendingGates`), enforced by the frame, never by step discipline

## 8. What v1 ships (the re-implementation slice)

1. L1: the **command registry** — named ops (kind read/write · args · structured result); CLI = a thin binding; the flow calls the same ops
2. L2: the **frame** (resumable coordinator) + **intent translation** (evidence → append!, lock-artifact → materialize+lock!, propose-spawn → spawn!) + **verdict→gate bridge** + **rework channel**
3. L2: **steps** rebuilt on the new contract: validate (interactive session), envision, spec — declaring intents, never touching the store
4. L2: **read view** interface (v1 file implementation) + packet stays the navigation view
5. L3: abilities — llm (existing adapter), interact (console), read-view (file); tool/command stay protocol-declared
6. L1: structured emit (`--json` on derived-view commands) — the data surface
