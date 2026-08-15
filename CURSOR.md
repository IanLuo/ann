<!-- synced: c01464a -->

# CURSOR — Meta-Assistant (2026-08-15)

**Position:** Requirements + tree format locked. Next: run `02-system-design` (queued) — answer Q1–Q4, produce `tree/nodes/01-goal/01-grilling/02-system-design/artifacts/ann-system-design.md`, lock it, then spawn implementation slices.

**Blockers:** 02-system-design blocked until Q1–Q4 answered (runtime, provider, storage, UI — defaults in node.json openQuestions).

**Open:**
- Q1 runtime (default Node.js + TypeScript)
- Q2 first model provider (default adapter-first, local OpenAI-compatible)
- Q3 storage (default SQLite better-sqlite3 + JSON artifacts)
- Q4 v1 UI (default CLI + tree artifacts on disk)

**Health:** 🟢 — no build to break (no code yet)

**Verification:** `design` locked @ eb07146. Requirements spec locked @ 2664511 (11 rungs; K1–K4; upstream design). Tree-format spec locked @ ba528d1 (9 sections + §10 evolution rule; upstream design + ann-spec; referrers AGENTS.md/02-system-design/slices). Tree: 01-goal done → 01-grilling done → 02-tree-format done → 02-system-design queued (c01464a).

**Errors-that-changed-plan:** spec promotion initially dropped user's 03440cc PRD extension — reconciled, decisions merged verbatim.

**Decisions:**
- Canonical model = tree-of-steps v2: eager skeleton, lazy artifact-gated leaves, per-step context packets, tree-as-memory (§21)
- Ann is built and managed with its own tree-of-steps pattern (dogfooding)
- Requirements = locked spec: agent-executed CLI primary flow, human = reviewer/answerer, sequential leaves v1, local-first, K4>5 = model-bet failure signal
- Nodes immutable — corrections are new nodes, never edits; process = append-only events
- Node structure updates are tasks, and tasks are nodes: format amendments = new superseding nodes (§10 tree-format-spec)
- Tree format locked: dir = node, id = path, per-node artifacts, searchable description.md, prefix order, status from events tail
- Subtree creation planner-only in v1; agents propose
- Q1–Q4 are system-design decisions (not spec); carried in 02-system-design context

**Active pointers:** `design`, `AGENTS.md`, `tree/nodes/`, `tree/nodes/01-goal/01-grilling/artifacts/ann-spec.md`, `tree/nodes/01-goal/02-tree-format/artifacts/tree-format-spec.md`
