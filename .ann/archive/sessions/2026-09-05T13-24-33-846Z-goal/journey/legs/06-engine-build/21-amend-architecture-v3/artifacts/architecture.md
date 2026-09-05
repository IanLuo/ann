<!-- specs:locked:adeaf98 2026-08-26 type=architecture -->
## Link contract
- **upstream** (this doc relies on): 05-engine/00/06-functional-spec/artifacts/functional-spec.md,04-system-design/00/02-system-design-doc/artifacts/ann-system-design.md,06-engine-build/19-core-design/artifacts/core-design-spec.md
- **referrers** (must cite this when they change): S1-S9 dev tasks,design tasks

# Architecture Spec (v3)
*Artifact of task `06-engine-build/21-amend-architecture-v3`. Type: architecture. Complete superseding version — v2 (locked @ e6d07ed) + **the L0–L3 layer model** (`core-design` §1, locked @ f7fb400). What changed: the five-tier stack (store ← kernel ← engines ← adapters ← surface) becomes **FOUR layers — L0 store ← L1 commands ← L2 flow ← L3 surface/abilities**; the **engines fold into L2** and the **adapter tier dissolves into L3 abilities**; **commands become the ONLY interface to the store** (reads and writes both); the single-initiator claim becomes **multi-client in-process** (reconciling `ann-system-design` §2's actual initiator list); and the **enforcement split moves the contract invariants + the artifact gate into L1 `spawn!`**. One v2 claim is **FALSIFIED and recorded as such** (LB-4/:63 "the kernel routes each step to its engine"). Upstream: `functional-spec` (locked @ 9e60cd8), `ann-system-design` (locked @ 2b0a30f), `journey-format-spec` v14 (locked), `core-design` (locked @ f7fb400). Referrers: S1–S9 dev tasks, design tasks. Lock management: `specs` skill (lock marker + link contract) + change-protocol v2 (logical names, resolver, amendment path) — this doc locks the same way.*

## Rung 1 — Load-bearing decisions

**LB-1 — Node.js + TypeScript.**
- Constraint: Q1 (resolved), the resolver already lives in Node, single-builder v1 (A1).
- Concurrency model (declared, not assumed): **single writer + shared readers**. v1 ships a single-process engine for scope, but the model is architectural: atomic appends (O_APPEND) under one writer; reads are pure functions of the log and share freely. This is the multi-user-ready shape (A1).
- ✗ Rejected: Python/Go — one runtime, resolver already Node, no gain for a file-driven tool.

**LB-2 — The file tree IS the source of truth (no SQLite in v1).**
- Constraint: tree-format-spec v3 (files = the tree, append-only, RPO=0 via git); no node limit, big-data N/A v1.
- Concurrency: same single-writer/shared-readers model — appends atomic, all reads derived.
- ✗ Rejected: SQLite — an index would be a second stored copy of the truth = the dual-write drift we banned. The in-memory index is **derived, never stored**.

**LB-3 — All state is derived from events; no mutable state anywhere.**
- Constraint: immutability + append-only invariants; replay integrity; resolution (current(name)); status (tail mapping).
- **Who writes:** ONE function owns the write — the store's single `appendEvent()` is the only writer and the unified-format choke point (schema enforced there). **(v3) The INITIATOR claim is corrected: writes are MULTI-CLIENT — several IN-PROCESS initiators reach `appendEvent` through the L1 command layer** (the flow, the validators, the adapters — `ann-system-design` §2's actual list: "planner kernel, adapters, validators/reviewer"). v2's "the kernel is the only *initiator* (planner-only)" was never true of the design it cited. **The CLI is a BINDING, not an initiator** — it calls the same commands a UI or a test calls. Multi-PROCESS writing is parked for v1 (requirements-spec §7 A1), and the store's in-memory event cache means **one writer PROCESS in v1** — stated, not assumed.
- ✗ Rejected: mutable DB state — breaks replay, enables history-editing, kills "structure is the log".

**LB-4 (v3 — REPLACED) — Strict one-way layering: L0 store ← L1 commands ← L2 flow ← L3 surface/abilities.**
- v2 read: *"store ← kernel ← engines ← adapters ← surface"* — five tiers. **Three of those tiers were not layers.** The engines were executors of work-type flows, which is what the coordinator does (they fold into **L2**); the adapters were capability providers, which is what a step consumes (they become **L3 abilities**); and "kernel" named both the coordinator and the store's interface, which are different jobs with different rules (they split into **L2 flow** and **L1 commands**).
- **FALSIFIED, recorded:** v2:63's *"The kernel routes each step to its engine"* is **false under v3** and is not carried forward. There is no engine tier to route to: L2 runs a task's **chain of steps** — pure units that receive injected state and declare intents — and the flow translates intents into store writes via L1. Routing-to-an-engine was a dispatch table over hard-wired work types; the chain is **data** (core-design §6).
- Constraint: component ownership (system-design §1), fail-closed gates, the function surface.
- ✗ Rejected: flat modules — cycles, no owner, gate enforcement leaks. ✗ Rejected: keeping five tiers — two of them had no invariant to own, and a layer that owns no invariant is a naming convention, not a boundary.

**LB-5 — The tree is the data; the UI derives from it but presents simply.**
- Constraint: "structure is the log" + K1–K3; functional-spec views.
- Refined: views are **logically derived** from the structure (no drift), but the presentation is a **simple, human-friendly surface — not the raw tree**. UI/UX is a first-class layer (web UI is the target).
- **(v3)** The derived views are **L1 reads** (`status` · `packet` · `flow` · `results` · `look-back` · `specs` · `check` · `read`); every surface renders those, and none of them reach past L1.
- ✗ Rejected: a separate UI-state model — drift between shown and true (K1 violation).

## Rung 2 — Layers & ownership

```
┌──────────────────────────────────────────────────────────┐
│ L3  UI + ABILITIES   human channel (present · ask ·      │
│                      research · decide) · llm · shell/   │
│                      tool · read view. SERVANTS: injected│
│                      into L2 seams. Implement L2-defined │
│                      interfaces; NEVER imported by L2/   │
│                      L1/L0. v1 = CLI talk; WEB UI is the │
│                      target (same commands underneath).  │
├──────────────────────────────────────────────────────────┤
│ L2  FLOW             THE RESUMABLE COORDINATOR. Owns the │
│                      frame (lifecycle), steps + chains   │
│                      (DATA), intent → command translation│
│                      gate observation, bounded rework,   │
│                      advance/spawn proposals. Reads L1;  │
│                      writes ONLY via L1.                 │
├──────────────────────────────────────────────────────────┤
│ L1  COMMANDS         THE STORE'S INTERFACE — the ONLY    │
│                      path to the store. Reads (derived   │
│                      views) + writes (spawn! · submit! · │
│                      gate! · append! · lock! ·           │
│                      supersede!). COMPLETE over the event│
│                      vocabulary; composites encode the   │
│                      invariants.                         │
├──────────────────────────────────────────────────────────┤
│ L0  STORE            JOURNEY DATA — node.json · events.  │
│                      jsonl · artifacts · registries.     │
│                      Single writer (appendEvent), strict │
│                      schema (format v14 §3), derived     │
│                      views. Knows nothing above.         │
└──────────────────────────────────────────────────────────┘
```

- **Dependencies point down only** — L3 → L2 → L1 → L0. Never up. **L3 is injected, not imported**: L2 defines the ability interfaces and receives implementations; nothing below L3 names a concrete adapter.
- **Writes:** every write ends at the store's single `appendEvent()`, and **every initiator gets there through L1** — L2 and L3 never touch the store. The composite commands encode the invariants (gate sequence, artifact sha, per-name supersession, reject bound, contract schema), so an invariant cannot be bypassed by choosing a different caller.
- **Reads (v3 — CHANGED):** v2 said "any layer via the store's derived views". Now: **reads go through L1 too** — the same command layer, its read half (`status` · `packet` · `flow` · `results` · `look-back` · `specs` · `check` · `read`). One interface, both directions; the store's internals are not a public surface.
- **The flow explained (v3 — REPLACES "engines explained"):** L2 runs the **frame** — materialize → grill gate → validate → activate → execute → verify → confirm gate → commit → look-back → advance — and inside `execute` it runs the current task's **chain of steps**. A step is a pure unit: injected `ctx` in, `{ok, artifact?, verdict?, intents?[]}` out; it never touches the store, the CLI, or a file. What v2 called engines are steps or frame phases now: *grilling* → the grill-bound `idea-validate` step · *envision* / *spec* → chain steps · *context assembler* → the `materialize` phase (L1 `packet`) · *validators* → the `validate` phase (L1 `check`/`validate`) · *runner reviewer* → the `verify` phase. **The chain is data** (`rules/flow/default.json`, keyed by `workType`), so changing what runs is a data change; adding a NEW step is code (implement + register).
- **Surface explained:** v1 = CLI (talk-loop, functional-spec §3). **Web UI is the important surface for Ann** — end users will mostly use web UI. **(v2, carried) PRODUCT FORM DECIDED (2026-08-22): LOCAL WEB APP — local-first client-server, packaged together; the browser client supports local AND remote servers; the server runs locally by default and owns the engine + the journey (single-writer store); multi-user deferred. Credentials are SERVER-side — env/config/keychain for local runs; env/secrets-manager for remote hosting; the client never holds them.** **(v3 correction) The surface is NOT a tier that adapters sit under, and it is NOT an initiator**: CLI and web are two bindings over the same L1 commands. Swapping presentation swaps a binding, not a layer.
- **Abilities explained (v3 — REPLACES "adapters explained"):** the adapter TIER dissolves. What adapters provided becomes **L3 abilities injected into steps**: `llm` (the existing provider adapter — multiple providers and **per-task model selection**, `contract.model`, format v14 §2; F17 config holds provider/model lists + defaults) · `interact` (the human channel: present · ask · research · decide) · `shell` (an OS-process ability — **never the L1 command surface**) · `tool` (protocol-declared, unbuilt in v1) · `read` (the L1 content view, injected — an L1 derived read, not an L3 servant). GitHub binding keeps the same shape: fail-closed, confirm-before-destructive.
- **Two enforcement points, non-overlapping (v3 — MOVED):** v2 split enforcement between the store (format invariants) and the validators/engines (contract invariants: ACs declared, inputs resolved, artifact gate for children). **v3 moves the contract invariants and the artifact gate INTO L1 `spawn!`** — a contract that fails the checklist (F-AC19), the id/prefix/sibling rules, the artifact gate, or the leg gate is **refused at the write**, not flagged after it. What stays post-hoc in `check()` is stated as post-hoc: F-AC16 closure, F-AC18 conclusion + commit traceability. **L0 still owns the format invariants unconditionally** (schema, append-only, gate sequence — the writer refuses, and it reads no timestamps, so there is no "old node" escape).
- **The invariant-ownership table** — per invariant, the enforcing layer — is `core-design` §1 and is not duplicated here; this rung names the boundaries, that table names the enforcement.

## Rung 3 — Repo tree (one responsibility per dir)

```
ann/
├── src/
│   ├── store/     L0 — journey data + single writer + derived views  (S1)
│   ├── commands/  L1 — THE store interface: reads + the `!` mutators (S1/S5)
│   ├── flow/      L2 — the frame, chains, intent translation, gates  (S5)
│   │   └── steps/ L2 — the chain steps (idea-validate · envision ·   (S2–S4,
│   │               spec · …) + the step registry (the add-a-step seam) S6)
│   ├── abilities/ L3 — llm (provider) · interact · shell/tool · read (S5, S7, S8)
│   ├── surface/   L3 — bindings over L1: CLI v1 · web UI target      (S8)
│   └── evals/     fixture suite · K1–K5 harness                      (S9)
├── .ann/          ALL ann-owned project files (machine-owned):
│   ├── journey/   the store: legs · nodes · events · artifacts
│   ├── docs/      shared contract-stack content (specs · designs · architecture)
│   └── rules/     registries (schema/vocab · decide · flow · config · check)
├── journey → .ann/journey   (compat symlinks — historical paths resolve)
├── docs    → .ann/docs       (recognition marker: .ann/ IS an ann project)
├── rules   → .ann/rules
├── logs/          runtime operational log (NOT project state)
└── AGENTS.md · package.json · tsconfig.json
```

**Ann-owned files are MACHINE-managed — never hand-edited; users interact via ann (CLI/UI), not the raw files. Root-level `journey`/`docs`/`rules` are compat symlinks.**

**(v3) The tree above is the LAYER TARGET, and it is a rename-and-fold of what exists, not new machinery:** today's `src/kernel/` holds the L2 flow (frame, chains, steps, registry) and today's `src/engines/` holds units that are steps or frame phases; `src/adapters/provider/` is the `llm` ability. The re-implementation lands the boundary; **the directory names follow the layer that owns the invariant** — a dir that owns nothing gets folded, which is the whole of LB-4's correction.

## Rung 4 — Cross-cutting concerns

- **Error model** — fail-closed, blocker named, failure is a value (`{ok:false, error:{code, blocker}}`), never exceptions-as-flow. **(v3) This shape is now UNIVERSAL and explicitly binds STEPS: a step that fails returns it; a step whose intents the store rejects fails named, with the store's refusal as the blocker.** The type lives with the flow layer; a new component returns the structured error, never fabricates success.
- **Events** — append-only, unified schema per **format v14 §3** (structured `artifact-locked` / `superseded` / `evidence` with `commits[]`·`refs[]`·`trace`, `submitted` with `confirmedSha`, the `waiting` kind), written ONLY through the store's `appendEvent()` — **reached only through L1**. Components emit via commands; never touch event files directly.
- **Write timing (v3 — NEW, format v14 §4):** **files are working state, events are acceptance.** A step's artifact materializes as a task-local working file immediately (re-written on rework); the `artifact-locked` event and any deferred child spawns record **at COMMIT**, after gate②. Architecturally this is why rework needs no supersession and why the gate-sequence invariant holds by construction.
- **Provenance** — every fact carries `sourceType` + confidence; inference labeled. Convention lives in the context-packet schema; declare the source of every fact.
- **Trace / observability — TWO logs, WITH ONE STATED EXCEPTION (v3):** (NFR-OBS-1 = both)
  1. **Project event log (the tree)** — immutable project memory: decisions, artifacts, status, gates. Replayable.
  2. **Runtime operational log (separate)** — requests sent (LLM/GitHub), errors and where they occurred, timing, retries. **Not in the tree**; lives in `logs/`.
  **THE EXCEPTION — the TRANSCRIPT (core-design §2, format v14 §3).** Replay determinism requires that model completions and human answers be *facts in the log, keyed by identity* — so `llm` and `interact` emit structured `trace` records `(stepId, runId, seq)` into `events.jsonl` via an L2-owned record hook ending at `append!`. **This REVERSES v2's "op-log = the text, tree = never the text" split** for those records, and the consequence is stated, not hidden: **NFR-SEC-1 (no secrets in the tree) now covers prompt and completion text.** The op-log keeps metrics, timing, retries and failures; it does not become the transcript, and the transcript does not become prose.
- **Secrets** — never stored in events/artifacts; redacted at render boundaries (NFR-SEC-1). Held by L3 abilities (server-side for the web form); the surface redacts. **(v3: the transcript is now inside the scope of this rule — above.)**
- **State** — derived only; no mutable state in any layer; caches are immutable snapshots rebuilt from the log (rung 1 concurrency model). **Resumability is a state property, not a component:** the resume point is DERIVED from the event tail (the four tail states — core-design §1), never stored.

## Rung 5 — Pointers (locked, resolvable via `npm run ann -- specs`)

- design (model + invariants)
- requirements-spec v3 (AC-1–7 · K1–K5 · NFRs)
- journey-format-spec v14 (the engine data contract — schema · events · write timing)
- tree-format-spec v6 (data contract, historical lineage)
- flow-control-spec v6 (gates · ladder · work types)
- change-protocol v2 (amendment path)
- ann-system-design v3 (components · interfaces · failure · scale)
- functional-spec v1 (function surface F1–F17 · interaction model)
- **core-design (the L0–L3 re-implementation contract — the source of this amendment)**
- resource-registry (registries: what is data, what is code)

**Lock management (embedded):** contracts are locked via the `specs` skill (marker `<!-- specs:locked:… -->` + link contract) and changed via change-protocol v2 (logical names · resolver · amendment path). The architecture doc itself locks this way. *(v3: `scripts/resolve.mjs` was retired 2026-08-19 — the commands are the resolver.)*

## Contract rung

- upstream: `functional-spec`, `ann-system-design`, `core-design` (all locked).
- referrers: S1–S9 dev tasks, design tasks.
