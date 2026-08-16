# Architecture Spec (v1)

*Artifact of task `05-engine/00/07-architecture`. Type: architecture. The load-bearing structure: layers, ownership, repo tree, cross-cutting concerns, pointers. Upstream: `functional-spec` (locked @ 9e60cd8), `ann-system-design` (locked). Referrers: S1–S9 dev tasks, design tasks. Lock management: `specs` skill (lock.sh marker + link contract) + change-protocol v2 (logical names, resolver, amendment path) — this doc locks the same way.*

## Rung 1 — Load-bearing decisions

**LB-1 — Node.js + TypeScript.**
- Constraint: Q1 (resolved), the resolver already lives in Node, single-builder v1 (A1).
- Concurrency model (declared, not assumed): **single writer + shared readers**. v1 ships a single-process CLI for scope, but the model is architectural: atomic appends (O_APPEND) under one writer; reads are pure functions of the log and share freely. This is the multi-user-ready shape (A1).
- ✗ Rejected: Python/Go — one runtime, resolver already Node, no gain for a file-driven tool.

**LB-2 — The file tree IS the source of truth (no SQLite in v1).**
- Constraint: tree-format-spec v3 (files = the tree, append-only, RPO=0 via git); no node limit, big-data N/A v1.
- Concurrency: same single-writer/shared-readers model — appends atomic, all reads derived.
- ✗ Rejected: SQLite — an index would be a second stored copy of the truth = the dual-write drift we banned. The in-memory index is **derived, never stored**.

**LB-3 — All state is derived from events; no mutable state anywhere.**
- Constraint: immutability + append-only invariants; replay integrity; resolution (current(name)); status (tail mapping).
- **Who writes:** ONE function owns the write — the store's single `appendEvent()` API is the only writer and the unified-format choke point (schema enforced there); the kernel is the only *initiator* (planner-only); nobody else touches event files.
- ✗ Rejected: mutable DB state — breaks replay, enables history-editing, kills "structure is the log".

**LB-4 — Strict one-way layering: store ← kernel ← engines ← adapters ← surface.**
- Constraint: component ownership (system-design §1), fail-closed gates, the function surface.
- ✗ Rejected: flat modules — cycles, no owner, gate enforcement leaks.

**LB-5 — The tree is the data; the UI derives from it but presents simply.**
- Constraint: "structure is the log" + K1–K3; functional-spec views.
- Refined: views are **logically derived** from the structure (no drift), but the presentation is a **simple, human-friendly surface — not the raw tree**. UI/UX is a first-class layer (web UI is the target).
- ✗ Rejected: a separate UI-state model — drift between shown and true (K1 violation).

## Rung 2 — Layers & ownership

```
┌────────────────────────────────────────────────────┐
│ Surface / UI   F1–F17 · gate talk-loop · renders.  │
│                v1 = CLI talk; WEB UI is the target │
│                (human-interface adapter swaps it)  │
├────────────────────────────────────────────────────┤
│ Adapters       provider (LLM) · github · human-    │
│                interface. Multiple providers +     │
│                PER-TASK MODEL SELECTION (v1 grain) │
├────────────────────────────────────────────────────┤
│ Engines        executors of the work-type flows    │
│                (flow-control §7): grilling ·       │
│                envision · spec · context assembler │
│                · validators · runner reviewer      │
├────────────────────────────────────────────────────┤
│ Kernel         planner kernel · flow config        │
├────────────────────────────────────────────────────┤
│ Store          tree store · resolver · derived     │
│                views (status/resolution/tree)      │
└────────────────────────────────────────────────────┘
```

- **Dependencies point down only** — Surface → adapters → engines → kernel → store. Never up.
- **Writes:** only the kernel appends (planner-only creation, flow-control); engines/adapters/surface *propose*, the kernel materializes — through the store's single `appendEvent()`.
- **Reads:** any layer via the store's derived views (shared readers).
- **Engines explained:** executors of the work-type flows — *grilling* validates the idea → validation + open questions · *envision* produces the product vision (usage + look) · *spec* produces detailed specs from the vision · *context assembler* builds the per-step context packet (§21.7, deterministic layers) · *validators* run deterministic contract checks (ACs declared, inputs resolved, artifact gate for children, distance-to-goal as a set) · *runner reviewer* runs the simulation review ("can the runner execute without guessing?"). The kernel routes each step to its engine.
- **Surface explained:** v1 = CLI (talk-loop, functional-spec §3). **Web UI is the important surface for Ann** — end users will mostly use web UI — so the human-interface adapter makes the presentation swappable (CLI text → web HTML, per flow-control's plugin path). UI/UX is a first-class concern, not an afterthought.
- **Adapters explained:** the provider adapter supports **multiple providers and model selection at the task grain in v1** — each task can specify its provider/model; F17 config holds provider/model lists + defaults; tasks override. GitHub + human-interface follow the same adapter pattern (fail-closed, confirm-before-destructive).
- **Two enforcement points, non-overlapping:** the store enforces **format invariants** (schema, append-only, immutability, round-gate at data level); the validators (engines) enforce **contract invariants** (ACs declared, inputs resolved, artifact gate for children, distance set).

## Rung 3 — Repo tree (one responsibility per dir)

```
ann/
├── src/
│   ├── store/     tree store + resolver + derived views        (S1)
│   ├── kernel/    planner kernel + flow config                 (S5)
│   ├── engines/   grilling · envision · spec · assembler ·     (S2–S4, S6)
│   │             validators · runner reviewer
│   ├── adapters/  provider · github · human interface          (S5, S7)
│   ├── surface/   function surface F1–F17 · gate talk-loop     (S8)
│   │             (CLI v1; web UI target)
│   └── evals/     fixture suite · K1–K5 harness                (S9)
├── scripts/       pre-engine tools (resolve.mjs → migrates into src/store)
├── tree/          Ann's own dogfooding tree (the reference instance)
├── logs/          runtime operational log (NOT project state)
├── AGENTS.md · CURSOR.md · package.json · tsconfig.json
```

## Rung 4 — Cross-cutting concerns

- **Error model** — fail-closed, blocker named, failure is a value (`{ok:false, error:{code, blocker}}`), never exceptions-as-flow. Lives in `src/kernel/errors`; a new component returns the structured error, never fabricates success.
- **Events** — append-only, unified schema per format v3 §3 (structured `artifact-locked`/`superseded`), written ONLY through the store's `appendEvent()`. Components emit via that API; never touch event files directly.
- **Provenance** — every fact carries `sourceType` + confidence; inference labeled. Convention lives in the context-packet schema (engines); declare the source of every fact.
- **Trace / observability — TWO distinct logs** (NFR-OBS-1 = both):
  1. **Project event log (the tree)** — immutable project memory: decisions, artifacts, status, gates — what happened to the project. Replayable.
  2. **Runtime operational log (separate)** — the dynamic process: requests sent (LLM/GitHub), errors and where they occurred, timing, retries. **Not in the tree** — the forest holds project state, not request noise. Lives in `logs/`; debuggable without polluting the structure.
  A new component: project decisions → events (via append API); runtime operations → operational log. Never the tree.
- **Secrets** — never stored in events/artifacts; redacted at render boundaries (NFR-SEC-1). Lives in adapters (they hold secrets) + surface (redacts).
- **State** — derived only; no mutable state in any layer; caches are immutable snapshots rebuilt from the log (rung 1 concurrency model).

## Rung 5 — Pointers (locked, resolvable via `scripts/resolve.mjs --specs`)

- design (model + invariants)
- requirements-spec v3 (AC-1–7 · K1–K5 · NFRs)
- tree-format-spec v3 (data contract)
- flow-control-spec (gates · ladder · work types)
- change-protocol v2 (amendment path)
- ann-system-design (components · interfaces · failure · scale)
- functional-spec v1 (function surface F1–F17 · interaction model)

**Lock management (embedded):** contracts are locked via the `specs` skill (`lock.sh` marker `<!-- specs:locked:… -->` + link contract) and changed via change-protocol v2 (logical names · resolver · amendment path). The architecture doc itself locks this way.

## Contract rung

- upstream: `functional-spec`, `ann-system-design` (both locked).
- referrers: S1–S9 dev tasks, design tasks.
