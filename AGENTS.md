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
| the tree format contract (engine data contract): table of rounds (epics, sequential gates), parallel task groups, immutable `node.json`, append-only `events.jsonl`, status derivation, searchable `description.md`, per-node artifacts, depth policy, checkpoint/RPO | `tree/rounds/05-engine/00/04-format-amendment-v3/artifacts/tree-format-spec-v3.md` (locked @ 012ca5f) |
| flow control: lifecycle, human gates, rejection/rework, resolution ladder, per-work-type flows | `tree/rounds/05-engine/00/01-flow-control/artifacts/flow-control-spec.md` (locked @ 2522b6c) |
| requirements change: the amendment path (change → amendment node → complete superseding artifact → superseded event → referrer re-pointing); locked artifacts never edited | `tree/rounds/05-engine/00/03-change-protocol-amendment/artifacts/requirements-change-protocol-v2.md` (locked @ be67673) |
| technique: components & ownership, frozen interfaces, failure modes (fail-closed), scale | `tree/rounds/04-system-design/00/02-system-design-doc/artifacts/ann-system-design.md` |

---

## State-tracking protocol

Current state is tracked in **`CURSOR.md`** at the repo root. Read it before every
session. It carries forward-looking state git can't express. git history IS the
work-history record. Rewrite `CURSOR.md` in-place at the end of every session.
Never append — append is rot. Hard cap: ≤40 lines / ≤2000 characters.
Every file path in it must exist at write time.

### Inclusion gate — record X iff:
(a) X is NOT recoverable by running one command against an artifact (git/code/CI), AND
(b) a fresh agent would plausibly get WRONG without it.

### Cursor fields

| Field | Content |
|---|---|
| synced | `<!-- synced: <git sha> -->` — staleness oracle (compare to `git rev-parse HEAD`) |
| Position | current step + next action, merged into one field |
| Blockers | what's stuck + why — to avoid re-hitting the wall |
| Open issues | unresolved questions / assumptions / pending decisions |
| Health | 🟢 green or 🔴 broken + known-broken items |
| Verification | claimed-done vs verified-done, with evidence (test/command @ sha) |
| Errors-that-changed-plan | only failures that redirected the work, not transient retries |
| Decisions | one present-tense line per resolved invariant, not a deliberation timeline |
| Active pointers | file paths → verified to exist at write time |

### Rules
- **Rewrite in-place, never append.** A cursor that only grows is a bug.
- **Pointers over contents.** Where state lives in an artifact, store the *command* or *path*, not the output. Can't drift; costs less.
- **Every path must exist at write time.**
- **Decisions collapse to one present-tense line.** Not a timeline.
