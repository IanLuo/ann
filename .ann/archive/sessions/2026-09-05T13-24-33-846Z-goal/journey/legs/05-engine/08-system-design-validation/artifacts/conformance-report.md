# System-Design Conformance Report (v1)

*Artifact of task `05-engine/00/08-system-design-validation`. Validates ann-system-design (components) against functional-spec (locked @ 9e60cd8). Method: function↔component coverage + settled-flow conformance (functional-spec §2/§3). Findings: severity error = must amend (change-protocol); warning = advisory.*

## 1. Function → component coverage

| F | Function | Component(s) | Status |
|---|---|---|---|
| F1 | init | Tree store, Planner kernel | ✓ |
| F2 | idea | Tree store, Grilling engine (intake rules) | ✓ |
| F3 | chain | Flow config, Planner kernel | ✓ |
| F4 | validate (idea gate) | Grilling engine, Human interface | ✓ |
| F5 | run next (pull) | Planner kernel, Human interface | ✓ |
| F6 | specify task (push) | Planner kernel, Flow config, Human interface | ✓ |
| F7 | gate interaction | Human interface, Planner kernel, Renderers (card) | ✓ |
| F8 | envision | Envision engine, Human interface | ✓ |
| F9 | spec | **Planner kernel (expansion) + Grilling engine — owner ambiguous** | ⚠ warning |
| F10 | status | Tree store (derived views), Renderers | ✓ |
| F11 | history | Tree store, Renderers | ✓ |
| F12 | artifact | Tree store (resolver), Renderers | ✓ |
| F13 | github | GitHub binding, Human interface (confirm) | ✓ |
| F14 | resume | Tree store (checkpoints) | ✓ |
| F15 | prune | Tree store, Validators | ✓ |
| F16 | check | Validators, Tree store | ✓ |
| F17 | config | Provider adapter (providers/models), Flow config, Human interface | ✓ |

## 2. Component → function coverage

- **Orphan check:** all 13 components serve ≥1 function OR a flow step consumed by functions. Internal components (Context assembler, Validators, Runner reviewer, Eval harness) are **flow executors** — they serve functions via execution, not as direct user functions: Context assembler → F5/F7 (packets at execution) · Validators → F7/F16 (gates + check) · Runner reviewer → F7 (gate② review) · Eval harness → F16 + K1–K5 measurement. **Criterion refined:** a component must serve a function or a flow step; no orphans found. ✓

## 3. Settled-flow conformance (functional-spec §2/§3)

| Decision | Component shape | Status |
|---|---|---|
| Gate talk-loop (present → decide → confirm) | Human interface + Planner kernel | ✓ |
| run-next pull / specify-task push converge on gate card | Planner kernel (frontmost-ready + materialize) | ✓ |
| validate = idea's exit gate | Grilling engine + Human interface | ✓ |
| card = gate① presentation | Human interface + Renderers | ✓ |
| Web UI target (CLI v1, swappable) | Human interface: "talk v1; interactive HTML via plugins" | ✓ |
| **Per-task model selection (v1 grain = task)** | **Provider adapter: "adapter-first" only — per-task grain NOT stated** | **✗ ERROR** |
| **Two-log trace (project events in tree + runtime op log)** | **System-design: "the tree IS the trace" — single-log framing** | **✗ ERROR** |
| Single-writer appendEvent (architecture LB-3) | Tree store: not cross-referenced | ⚠ warning |

## 4. Findings

- **E-1 (error):** Provider adapter lacks the per-task model-selection grain (architecture rung 2: each task can specify provider/model; F17 holds lists + defaults). → amend.
- **E-2 (error):** Two-log trace not reflected — the runtime operational log (requests, errors, timings) must be separate from the project event tree (architecture rung 4). → amend.
- **W-1 (warning):** F9 spec owner ambiguous — clarify: **Planner kernel owns spec expansion** (it is the planning engine); Grilling engine covers validate/requirements-grilling only.
- **W-2 (warning):** Tree store should cross-reference the single-writer `appendEvent()` choke point (architecture LB-3).
- **W-3 (warning):** Coverage criterion wording — components serve functions OR flow steps (internal executors are not orphans).

## 5. Routing

E-1, E-2 → change-protocol amendment of ann-system-design (complete superseding artifact, same logical name). W-1..W-3 folded into the same amendment.
