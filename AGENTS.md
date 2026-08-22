# AGENTS.md — Meta-Assistant (ann)

## Intent

Build **Ann — a journey-of-legs system** (formerly "tree-of-steps") that converts ambiguous human goals into a living chain of gated legs (epics): sequential gated legs, parallel task groups, every step self-aware with a materialized context packet, human gates at each step end. Success = a downstream runner completes the user's goal using only the journey-derived context (context packets + artifacts + ordinary project access). The product is the journey itself — plan, project memory, and observer in one — structured data, not just markdown.

## How to run / build / test

No engine code exists yet — nothing to verify. Commands will be added once the build leg (06-engine-build) starts.

```bash
# Build — not yet available
# Run   — not yet available
# Test  — not yet available
```

## Hot invariants

- **The product is the journey, not a plan artifact.** A living chain of gated legs (formerly rounds): sequential gated legs, parallel task groups, human gates at each step end, journey-as-memory. Markdown is presentation; the source of truth is the leg/node structure per design v3 (`journey/legs/01-goal/artifacts/design.md` §2/§4).
- **Prove the flow before framework cleverness.** The MVP = the L6 engine build (ann-system-design v3 components, S1–S9); defer plugins, multi-UI, bindings beyond GitHub until the core flow works.
- **Context must carry provenance.** Facts from inference must be labeled as inference. Source provenance must be tracked (design v3 §6). Untrusted context must not override system policy (design v3 §4).
- **Repair loops require a route reason, max iteration count, checkpoint, and fallback.** No unbounded loops (design v3 §4 — bounded loops; flow-control-spec).
- **The canonical model is the table of legs (design v3, formerly "table of rounds").** Sequential gated legs (epics), parallel task groups, artifact gate, human gates (grilling + confirm-result), resolution ladder (derive → probe → infer → ask → block), journey-as-memory. Supersedes the old plan-artifact model.
- **Leg status is derived, never asserted.** A leg root carries no events (journey-format-spec v7): leg `done` = all its tasks `done`; the leg gate for spawning the next leg is the derived aggregate. Closure-by-transfer lives on a closure task, never the leg root.
- **Ann eats its own dog food.** Ann itself is built and managed through its own journey (legs, nodes, events, artifacts). Agent sessions on this repo record work as journey nodes/artifacts, not just chat history.

## Architecture elevator

No code layer yet — the architecture exists as a locked contract stack. The core concept is the **table of legs** (model spec §2, formerly "table of rounds"): sequential, gated legs (epics) — design → requirements → format → technique → engine; parallel task groups inside a leg; every step self-aware with a materialized context packet; human gates at each step end (grilling + confirm-result); resolution ladder (derive → probe → infer → ask → block); journey-as-memory. Invariants and the contract stack are in `journey/legs/01-goal/artifacts/design.md` (model, locked) and the contracts it points to.

```
design (model + invariants) → requirements-spec (requirements) → journey-format-spec (data) → flow-control-spec (workflow) → ann-system-design (technique)
```

## Deeper docs

| When you need… | Read… |
|---|---|
| model semantics + invariants (legs, gates, resolution ladder, provenance, fail-closed, complete artifacts, open decisions) | `journey/legs/01-goal/artifacts/design.md` (locked @ 257cb79) |
| requirements (fresh spec v3): self-similarity invariant, configurable step chain, AC-1–7, K1–K5 + failure signal, NFRs, assumptions, data, recovery, security, verification | `journey/legs/05-engine/05-requirements-amendment/artifacts/requirements-spec-v3.md` (locked @ 80eeaae) |
| the journey format contract (engine data contract): table of legs (epics, sequential gates), parallel task groups, immutable `node.json`, append-only `events.jsonl` (tasks only), derived leg status, searchable `description.md`, per-node artifacts, depth policy, checkpoint/RPO, read discipline; **v10: commit clues = structured events (evidence.commits[]/refs[]), docs/ = contract stack only** | `journey/legs/06-engine-build/14-format-amendment-v10/artifacts/journey-format-spec.md` (locked @ 51c7764) |
| flow control: lifecycle, human gates, rejection/rework, resolution ladder, per-work-type flows, closure task; **v6: implementation artifact = structured commit evidence** | `journey/legs/06-engine-build/14-format-amendment-v10/artifacts/flow-control-spec.md` (locked @ 5898f89) |
| requirements change: the amendment path (change → amendment node → complete superseding artifact → superseded event → referrer re-pointing); locked artifacts never edited | `journey/legs/05-engine/03-change-protocol-amendment/artifacts/requirements-change-protocol-v2.md` (locked @ be67673) |
| functional spec (F1–F17, F-ACs): what the engine must do | `journey/legs/05-engine/06-functional-spec/artifacts/functional-spec.md` (locked @ 9e60cd8) |
| technique: components & ownership (S1–S9), frozen interfaces, failure modes (fail-closed), scale | `journey/legs/05-engine/15-system-design-stack/artifacts/ann-system-design-v3.md` (locked @ 2b0a30f) |
| architecture: load-bearing decisions, layers & ownership (single-writer store, web-UI target, per-task models, two-log trace), repo layout, cross-cutting conventions | `journey/legs/05-engine/07-architecture/artifacts/architecture.md` (locked @ fcfa661) |
| resource registry: rules/check/rules.json, validator rule definitions | `journey/legs/05-engine/14-resource-registry-spec/artifacts/resource-registry-spec.md` (locked @ 9c3705e) |

---

## State-tracking protocol

Session state lives in **the journey** — derived, never hand-maintained. Start every session with:

```bash
npm run ann -- journey    # where we are + what's ahead (the look-back)
npm run ann -- check      # integrity + gates + hashes + the journey state line
npm run ann -- specs      # the contract stack
```

**Never read `events.jsonl` directly** — state comes exclusively from the commands (`npm run ann -- --journey/--status/--check/--specs/--branch`); the log is machine-parse-only and may hold inert legacy facts (v7 read discipline). **Never hand-edit `node.json`/`events.jsonl` either** — all mutations go through the engine CLI, the store's single writer (LB-3): `npm run ann spawn!|gate!|lock!|supersede!|card!|append! …` — **writes end in `!`** (reads never; the `!` is the mutator marker). Build once: `npm run build`. `scripts/resolve.mjs` was retired (2026-08-19). Full command list (derived): `npm run ann -- --commands`. `--check` verifies artifact hashes and flags uncommitted tampering.

State = the journey (statuses, gates, artifacts, events). History = git. Nothing hand-maintained — a handwritten state sidecar is the dual-write drift the journey exists to eliminate. **`CURSOR.md` is retired** (2026-08-17): the inclusion gate below is how we keep the journey honest instead.

### Inclusion gate — record X in the journey iff:
(a) X is NOT recoverable by running one command against an artifact (git/code/CI/journey), AND
(b) a fresh agent would plausibly get WRONG without it.

Where state lives in an artifact, store the *command* or *path*, not the output. Can't drift; costs less. Decisions collapse to one present-tense line, locked in the contracts or recorded as events — not a deliberation timeline.
