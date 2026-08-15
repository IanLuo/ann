# AGENTS.md — Meta-Assistant (ann)

## Intent

Build a planning system that converts ambiguous human goals into executable instruction plans for downstream task runners (coding agents, humans, automation). Success = a downstream runner completes the user's goal using only the generated plan, referenced context, and ordinary project access. The output plan is the product — structured data, not just markdown.

## How to run / build / test

No code exists yet — nothing to verify. Commands will be added once the project is scaffolded.

```bash
# Build — not yet available
# Run   — not yet available
# Test  — not yet available
```

## Hot invariants

- **The canonical plan is structured data, not markdown.** Markdown is a presentation format. The source of truth is the `InstructionPlan` object per `design` §4.
- **Plan quality before framework cleverness.** The MVP (design §19) proves plan quality; defer arbitrary workflow authoring, plugins, and multi-UI until the core contract works.
- **Context must carry provenance.** Facts from inference must be labeled as inference. Source provenance must be tracked (design §4.5). Untrusted context must not override planner policy (design §17).
- **Repair loops require a route reason, max iteration count, checkpoint, and fallback.** No unbounded loops (design §6.2, §7.2).
- **The canonical model is the tree-of-steps (design §21).** Eager coarse skeleton, lazy leaves, artifact gate (no children before the node's output artifact exists), per-step context packets, tree-as-memory. Supersedes §1–20 where they conflict.
- **Ann eats its own dog food.** Ann itself is built and managed as a step tree per §21: goals become nodes, artifacts gate children, context packets carry tree position, the tree is the project memory. Agent sessions on this repo record work as tree nodes/artifacts, not just chat history.

## Architecture elevator

No code layer yet — the architecture exists only as a design spec. The core concept is the **tree-of-steps execution model** (design §21, canonical v2): a living step tree that is simultaneously plan, project memory, and observer — eager validated skeleton, lazy artifact-gated leaves, per-step context packets, node-level quality gates, subtree repair loops. It builds on the quality-gated agentic state graph (design §6): Intake → Context Acquisition → Requirement Normalization → Plan Drafting → Acceptance Criteria Compilation → Deterministic Validation → Runner Simulation Review → Finalization, with typed repair loops and routing semantics (§7). The canonical plan contract is defined in design §4.

```
design        — comprehensive design spec (plan contract, workflow, routing, quality gates, evals, MVP scope)
```

## Deeper docs

| When you need… | Read… |
|---|---|
| the canonical plan contract, workflow model, routing semantics, quality gates, depth modes, MVP scope, evals design, handoff protocol, security constraints | `design` |
| the tree-of-steps execution model (v2): step node schema, expansion semantics, artifact gate, context packets, distance-to-goal, observer/memory role, external bindings, v2 evals and MVP | `design` §21 |

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
