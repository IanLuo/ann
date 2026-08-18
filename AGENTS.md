# AGENTS.md — Meta-Assistant (ann)

## Intent

Build **Ann — a tree-of-steps system** that converts ambiguous human goals into a living table of rounds: sequential gated rounds (epics), parallel task groups, every step self-aware with a materialized context packet, human gates at each step end. Success = a downstream runner completes the user's goal using only the tree-derived context (context packets + artifacts + ordinary project access). The product is the tree itself — plan, project memory, and observer in one — structured data, not just markdown.

## How to run / build / test

No code exists yet — nothing to verify. Commands will be added once the project is scaffolded.

```bash
# Build — not yet available
# Run   — not yet available
# Test  — not yet available
```

## Hot invariants

- **The product is the tree, not a plan artifact.** A living table of rounds: sequential gated rounds, parallel task groups, human gates at each step end, tree-as-memory. Markdown is presentation; the source of truth is the round/node structure per design v3 (`tree/rounds/01-goal/artifacts/design.md` §2/§4).
- **Prove the flow before framework cleverness.** The MVP = the R5 engine (ann-system-design components, S1–S9); defer plugins, multi-UI, bindings beyond GitHub until the core flow works.
- **Context must carry provenance.** Facts from inference must be labeled as inference. Source provenance must be tracked (design v3 §6). Untrusted context must not override system policy (design v3 §4).
- **Repair loops require a route reason, max iteration count, checkpoint, and fallback.** No unbounded loops (design v3 §4 — bounded loops; flow-control-spec).
- **The canonical model is the table of rounds (design v3).** Sequential gated rounds (epics), parallel task groups, artifact gate, human gates (grilling + confirm-result), resolution ladder (derive → probe → infer → ask → block), tree-as-memory. Supersedes the old plan-artifact model.
- **Ann eats its own dog food.** Ann itself is built and managed through its own tree (rounds, nodes, events, artifacts). Agent sessions on this repo record work as tree nodes/artifacts, not just chat history.

## Architecture elevator

No code layer yet — the architecture exists as a locked contract stack. The core concept is the **table of rounds** (model spec §2): sequential, gated rounds (epics) — design → requirements → format → technique → engine; parallel task groups inside a round; every step self-aware with a materialized context packet; human gates at each step end (grilling + confirm-result); resolution ladder (derive → probe → infer → ask → block); tree-as-memory. Invariants and the contract stack are in `tree/rounds/01-goal/artifacts/design.md` (model, locked) and the four locked contracts it points to.

```
design (model + invariants) → ann-spec (requirements) → tree-format-spec-v3 (data) → flow-control-spec (workflow) → ann-system-design (technique)
```

## Deeper docs

| When you need… | Read… |
|---|---|
| model semantics + invariants (rounds, gates, resolution ladder, provenance, fail-closed, complete artifacts, open decisions) | `tree/rounds/01-goal/artifacts/design.md` |
| requirements (fresh spec v3): self-similarity invariant, configurable step chain, AC-1–7, K1–K5 + failure signal, NFRs, assumptions, data, recovery, security, verification | `tree/rounds/05-engine/00/05-requirements-amendment/artifacts/requirements-spec-v3.md` (locked @ 80eeaae) |
| the tree format contract (engine data contract): table of rounds (epics, sequential gates), parallel task groups, immutable `node.json`, append-only `events.jsonl`, status derivation, searchable `description.md`, per-node artifacts, depth policy, checkpoint/RPO | `tree/rounds/05-engine/00/04-format-amendment-v3/artifacts/tree-format-spec-v4.md` (locked @ fbaba13) |
| flow control: lifecycle, human gates, rejection/rework, resolution ladder, per-work-type flows | `tree/rounds/05-engine/00/01-flow-control/artifacts/flow-control-spec.md` (locked @ 2522b6c) |
| requirements change: the amendment path (change → amendment node → complete superseding artifact → superseded event → referrer re-pointing); locked artifacts never edited | `tree/rounds/05-engine/00/03-change-protocol-amendment/artifacts/requirements-change-protocol-v2.md` (locked @ be67673) |
| technique: components & ownership, frozen interfaces, failure modes (fail-closed), scale | `tree/rounds/05-engine/00/10-system-design-amendment/artifacts/ann-system-design-v2.md` (locked @ 04ee80e) |
| architecture: load-bearing decisions, layers & ownership (single-writer store, web-UI target, per-task models, two-log trace), repo tree, cross-cutting conventions | `tree/rounds/05-engine/00/07-architecture/artifacts/architecture.md` (locked @ fcfa661) |

---

## State-tracking protocol

Session state lives in **the tree** — derived, never hand-maintained. Start every session with:

```bash
node scripts/resolve.mjs --journey   # where we are + what's ahead (the look-back)
node scripts/resolve.mjs --check     # integrity + gates
node scripts/resolve.mjs --specs     # the contract stack
```

State = the tree (statuses, gates, artifacts, events). History = git. Nothing hand-maintained — a handwritten state sidecar is the dual-write drift the tree exists to eliminate. **`CURSOR.md` is retired** (2026-08-17): the inclusion gate below is how we keep the tree honest instead.

### Inclusion gate — record X in the tree iff:
(a) X is NOT recoverable by running one command against an artifact (git/code/CI/tree), AND
(b) a fresh agent would plausibly get WRONG without it.

Where state lives in an artifact, store the *command* or *path*, not the output. Can't drift; costs less. Decisions collapse to one present-tense line, locked in the contracts or recorded as events — not a deliberation timeline.
