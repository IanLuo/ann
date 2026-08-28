<!-- specs:locked:9e60cd8 2026-08-16 type=spec -->

## Link contract
- **upstream** (this doc relies on): tree/rounds/05-engine/00/05-requirements-amendment/artifacts/requirements-spec-v3.md,05-engine/00/01-flow-control/artifacts/flow-control-spec.md
- **referrers** (must cite this when they change): architecture,ann-system-design implementation slices,review-task

# Functional Spec (v1)
*Artifact of task `05-engine/00/06-functional-spec`. Type: spec. The function contract: the surface (what the builder can DO with Ann), the settled flow decisions, and the interaction model. Deep per-function detail (exact commands, output formats, edge cases) is written into the slice task contracts during the build; this spec fixes the surface + interaction shape. Upstream: `requirements-spec` (v3), `flow-control-spec`. Referrers: architecture · ann-system-design · implementation slices · review-task.*

## 1. The surface (settled)

**Phase 0 — Project start**
| F | Function | Gesture | Serves |
|---|---|---|---|
| F1 | init | `ann init <name>` — create store + goal node | AC-1 |
| F2 | idea | `ann idea <text>` — the loose idea lands on the goal node (empty/greeting rejected) | AC-1, §8 |
| F3 | chain | `ann chain` view / edit the project's step chain (config as data) | AC-3 |

**Phase 1 — The flow**
| F | Function | Gesture | Serves |
|---|---|---|---|
| F4 | **validate** | the idea's exit gate — grills the idea; **only a confirmed idea lets the next steps begin** | AC-4 |
| F5 | **run next** | pull — Ann proposes the frontmost-ready action; user approves (one interaction) | K3, K4 |
| F6 | **specify task** | push — the user can always proactively name/point at a task to work on; spawns/activates → gate card → confirm. Covers amendments (AC-7) and steering | AC-3, AC-7 |
| F7 | **gate interaction** | every task's first step: the card is presented at gate①; user interacts, confirms, or answers — gate② confirms the result | NFR-USE-2, AC-2 |
| F8 | envision | the beginning build step: product vision (usage + look) — after the idea is confirmed | AC-4 |
| F9 | spec | the beginning build step: detailed specs from the vision | AC-4 |

**Phase 2 — Navigation & memory**
| F | Function | Gesture | Serves |
|---|---|---|---|
| F10 | status | `ann status` — tree view: goal, per-node status, next action (derived) | K1, K2 |
| F11 | history | `ann history <id>` — a node's append-only event log | K1, NFR-OBS-1 |
| F12 | artifact | `ann artifact <name>` — open current artifact by logical name (resolver) | F-AC13 |

**Phase 3 — Bindings**
| F | Function | Gesture | Serves |
|---|---|---|---|
| F13 | github | create issue/PR from a step; destructive actions confirm first | D3, NFR-SEC-1 |

**Phase 4 — Maintenance**
| F | Function | Gesture | Serves |
|---|---|---|---|
| F14 | resume | crash recovery from checkpoint (also implicit on start) | AC-8/RPO |
| F15 | prune | remove superseded subtrees (git = archive; referenced nodes never pruned) | depth policy, F-AC12 |
| F16 | check | integrity: one-current-per-name, files exist, gates respected | F-AC1–13 |
| F17 | config | provider · ask-vs-assume preference · defaults | §8 |

## 2. Settled flow decisions

- **Default step chain:** idea → validate → envision → spec → continue. The chain is configurable per project (F3, AC-3).
- **validate = the idea's gate:** the idea must be confirmed before envision/spec (the beginning steps) start. Nothing proceeds from an unconfirmed idea.
- **run next = pull; specify task = push.** Both converge on the same gate interaction: task → gate① card → user confirms/answers. No separate machinery.
- **card = gate presentation** (F7): every task's first step is the card at gate①; there is no standalone "browse a card" function (status/artifact cover viewing).
- **change has no dedicated function** (F13 dropped): a requirement change IS the user specifying an amendment task via F6 — the change-protocol's amendment node is a task like any other. AC-7 is served by F6.
- Gates at each step end per flow-control: gate① grilling (entry), gate② confirm-result (exit); rejection → bounded rework, closed through the same gate.

## 3. Interaction model (the gate talk-loop)

Every gate interaction has one shape, used by all functions:

```
present  → Ann shows the step card (intent, ACs, artifacts, status, history tail) + any pending questions
decide   → user: accept | reject + feedback | answer a question (batched, deduped)
result   → gate② confirm-result: accept | reject + feedback → bounded rework, same-gate return (flow-control §3)
```

- "Easy and natural" (NFR-USE-1): locate ≤ 2 interactions, advance ≤ 1 — the talk-loop is the interaction; the structure answers, the user approves.
- Human unreachable → step stays blocked, blocker named (fail-closed).

## 4. Boundaries

- This spec fixes the **surface + interaction shape**. Deep per-function detail (command syntax, output rendering, edge cases, fixture verification) is written into the **slice task contracts** during the build (S1–S9, ann-system-design §1), each tracing to its function here.
- Views for v1 are CLI text (status/tree, card, gate presentation); visual/HTML design is a later phase (design-task), never before the surface holds.

## 5. Open (by design)

- Function detail contracts pending the build (per §4 boundary).
- F17 config scope: provider + ask-vs-assume + defaults (step-chain templates land in F3).
