<!-- synced: 26cdcb4 -->

# CURSOR — Meta-Assistant (2026-08-16)

**Position:** Contract stack cleaned + relocated. Design v3 (lean model spec) locked @ a414a0b at `tree/rounds/01-goal/artifacts/design.md`; old 1146-line design removed. Next: write `flow-control-spec.md` draft (R5 · task 01) with the 9 ACs + 3 recorded defaults, lock it, then activate the S1–S9 engine group.

**Blockers:** none. (flow-control spec = frontmost-ready; its inputs are all locked + in-tree.)

**Open:** (per design v3 §10 — explicitly NOT decided) evals detail beyond K1–K4 · bindings beyond GitHub · UI beyond CLI · joins/DAG · cross-round parallelism · human-gate weakening per work type · storage beyond file-based.

**Health:** 🟢 — no build to break (no code yet; R5 starts the build)

**Verification:** Contract stack: design v3 @ a414a0b (system-design, upstream none) → ann-spec @ a414a0b (rotated) → tree-format-spec-v2 @ a414a0b (rotated) → ann-system-design @ ca32421 (rotated). Rounds: R1–R4 done → R5 queued (task 01-flow-control, frontmost) (26cdcb4). K4>5 failure signal armed (ann-spec §5).

**Errors-that-changed-plan:** spec promotion dropped user's 03440cc PRD extension — reconciled. Storage default deviated (no SQLite) — flagged + user-informed. Flow-control defaults initially chat-only — recorded as node events (handoff audit).

**Decisions:**
- Canonical model = table of rounds: sequential gated rounds (epics), parallel task groups, per-step context packets, tree-as-memory
- 12 invariants locked (design v3 §4): immutability, append-only, artifact/round/human gates, no silent inference, provenance, fail-closed, complete artifacts, bounded loops, dogfooding, untrusted-context
- Human gates at each step end (grilling + confirm-result), rejection → bounded rework closed through the same gate; pluggable human interface (talk / HTML plugins)
- Resolution ladder: derive → probe → infer → ask → block; Q1–Q4 resolved (Node.js+TS · adapter-first OpenAI-compatible · file-based, no SQLite v1 · CLI)
- Complete-artifact rule: superseding artifacts = complete merged versions, never deltas
- Depth policy: ≤8 levels/260 chars, sibling-correction, pruning
- Nodes immutable; corrections = sibling nodes; structure updates are tasks

**Active pointers:** `AGENTS.md`, `tree/README.md`, `tree/rounds/`, `tree/rounds/01-goal/artifacts/design.md`, `tree/rounds/02-grilling/artifacts/ann-spec.md`, `tree/rounds/04-system-design/00/01-format-amendment-v2/artifacts/tree-format-spec-v2.md`, `tree/rounds/04-system-design/00/02-system-design-doc/artifacts/ann-system-design.md`
