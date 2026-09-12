# The SEMANTIC DRIVER — design note (authored 2026-09-12, by a planning session)

**What it is.** An LLM loop that takes a COMMAND's output (the value-canonical JSON), decides, and emits the NEXT COMMAND CALL. This is the recorded follow-up to `flow-control-spec v7 §5`: *"Auto-DRAFTING a task contract from a leg's epic for the builder to approve is LLM-surface work — deferred with the operator action's implementation, never an L1/engine derivation."*

**Why now.** `advance!` (leg 07) executes every machine-derivable advance and stops at the AUTHORED-WORK boundary (`advance-leg` / `closure-needed` / `none`). Today a human/agent supplies the authored content by hand.

## The design (pinned decisions)

```
read (derived JSON) ─► LLM decides ─► VALIDATE (closed set, CODE) ─► execute via the command layer ─► repeat
                                        │
                                        └── route reason · stop: human gate · boundary · turn bound · fail-closed
```

| Point | Decision | Rejected alternative |
|---|---|---|
| **The LLM's output** | It **proposes**; CODE **validates the proposed call against the CLOSED SET** of commands — the LLM never gets a raw write, never an invented call | letting the model emit free-form shell/writes |
| **Where it lives** | L2/L3 (flow/surface), composing the existing command layer — **never an L1/engine derivation** (v7 §5, binding) | an L1 derivation |
| **Bounds** | Max turn bound; an out-of-range proposed call = a **refusal**, no clamp; checkpoint = **every human gate**; resume = **re-derive** | silent clamping; unbounded self-direction |
| **Persistence (Q1)** | op-log metrics only; **the draft is re-derivable** | a new event kind / turn transcript (needs a registry entry + a leg-root-less home) |
| **The boundary** | The driver **DRAFTS** (a contract from the epic + goal + upstream artifacts) → the **human approves the BYTES** → `spawn!` → `submit! grill` → **STOP** (never a machine spawn) | machine `spawn!` |
| **Gates** | It never answers a gate; it SUBMITS and presents, landing at the next human decision | self-accepting |
| **Provenance** | The draft header says **GENERATED** (model · provider · turn · run) + `RECORDED_BY` on the landed write | silently authoring content that reads as human-authored |
| **Credentials** | **Server-side only**, asserted absent from every response body; a provider failure = a named stop with ZERO writes | client-held key; proceeding on a guessed call |

## How it meets the WHAT'S NEXT card (leg 11, in flight)

```
WHAT'S NEXT: approve ─► advance! ─► continue-leg ─► … ─► STOP at the AUTHORED-WORK boundary
                                                                    │
driver:                          DRAFT (generated) ─► human approves the BYTES ─► spawn! ─► submit! grill ─► STOP
```

The card executes the machine-derivable advance; the driver supplies the authored content at the boundary.

## Deliberately left to the human (task-level openQuestions, non-blocking)

- **Q1 — persistence** (see the table; default = op-log metrics only, draft re-derivable)
- **Q2 — UI wiring**: does the first slice also wire the driver into the WHAT'S NEXT card's UI? (default: **no** — a sibling task; leg 11 is in flight over that surface)
- **Q3 — the `none` consult**: may the driver draft a candidate next-leg epic at `none`? (default: **present the derived consult and STOP** — `goal! met` / `archive` / a new leg stay human moves)

## Spawn state

**SPAWNED (2026-09-12)** as leg `12-operate-loop` (the epic: the operate loop completed — the deferred surface + the driver):
- `12-operate-loop/01-implementation-deferred-surface` — a deferred task must stay VISIBLE in next/journey/the UI (found live: `09-spec-fidelity/01` is deferred and invisible to `next`)
- `12-operate-loop/02-implementation-semantic-driver` — this design
Both entry gates are SUBMITTED and await the human's confirm on the web UI. Q1-Q3 are the task's open decisions (to be resolved or explicitly recorded).
