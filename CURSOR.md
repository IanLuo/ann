<!-- synced: 1584bfa -->

# CURSOR — Meta-Assistant (2026-08-16)

**Position:** /specs redo complete — contract stack fully locked and drift-free. Next: activate R5's task group — spawn S1–S9 slices (ann-system-design §1) and build the engine, starting with S1 tree store.

**Blockers:** none. (All contracts locked; Q1–Q4 resolved: Node.js+TS · adapter-first OpenAI-compatible · file-based, no SQLite v1 · CLI.)

**Open:** (design v3 §10 — NOT decided) evals detail beyond K1–K4 · bindings beyond GitHub · UI beyond CLI · joins/DAG · cross-round parallelism · human-gate weakening per work type · storage beyond file-based.

**Health:** 🟢 — no build to break (no code yet; R5 starts the build)

**Verification:** Stack @ 2522b6c: design v3 (system-design, upstream none) → ann-spec → tree-format-spec-v2 → flow-control-spec → ann-system-design. Flow-control task done (all ACs + defaults locked). Rounds: R1–R4 done → R5 queued (task 01-flow-control done; S1–S9 not yet spawned) (1584bfa). K4>5 failure signal armed (ann-spec §5).

**Errors-that-changed-plan:** spec promotion dropped user's 03440cc PRD extension — reconciled. Storage default deviated (no SQLite) — flagged + user-informed. Flow-control defaults initially chat-only — recorded as node events. R3 status showed "superseded" (not done) — format v2 §3 now: superseded annotates, never overrides completed.

**Decisions:**
- Product = the tree (living table of rounds), NOT a planner/plan artifact (design v3 §2; AGENTS.md synced)
- 12 invariants (design v3 §4): immutability, append-only, artifact/round/human gates, no silent inference, provenance, fail-closed, complete artifacts, bounded loops, dogfooding, untrusted-context
- Human gates at each step end (grilling + confirm-result), rejection → bounded rework closed through the same gate; pluggable human interface (talk / HTML plugins)
- Resolution ladder: derive → probe → infer → ask → block; K3 = blocking questions only, K2 = machine time excluding human wait
- Complete-artifact rule; depth policy (≤8 levels/260 chars); superseded annotates
- Nodes immutable; corrections = sibling nodes; structure updates are tasks

**Active pointers:** `AGENTS.md`, `tree/README.md`, `tree/rounds/`, design v3 + ann-spec + tree-format-spec-v2 + flow-control-spec + ann-system-design (all under `tree/rounds/` artifacts)
