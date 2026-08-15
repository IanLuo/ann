<!-- synced: 4daa362 -->

# CURSOR — Meta-Assistant (2026-08-15)

**Position:** Spec locked, grilling done, format migrated. Next: run `02-system-design` (queued) — answer Q1–Q4, produce `tree/nodes/01-goal/01-grilling/02-system-design/artifacts/ann-system-design.md`, lock it, then spawn implementation slices.

**Blockers:** 02-system-design blocked until Q1–Q4 answered (runtime, provider, storage, UI — defaults in node.json openQuestions).

**Open:**
- Q1 runtime (default Node.js + TypeScript)
- Q2 first model provider (default adapter-first, local OpenAI-compatible)
- Q3 storage (default SQLite better-sqlite3 + JSON artifacts)
- Q4 v1 UI (default CLI + tree artifacts on disk)

**Health:** 🟢 — no build to break (no code yet)

**Verification:** `design` locked @ eb07146. Spec specs-locked @ 2664511 (11 rungs; K1–K4; upstream design; referrers 02-system-design/slices/review-task). Tree format migrated @ 4daa362: node = dir (immutable node.json + append-only events.jsonl + description.md + artifacts/); id = path; prefix order; status derived from events tail. Tree: 01-goal done → 01-grilling done → 02-system-design queued.

**Errors-that-changed-plan:** spec promotion initially dropped user's 03440cc PRD extension — reconciled, decisions merged verbatim.

**Decisions:**
- Canonical model = tree-of-steps v2: eager skeleton, lazy artifact-gated leaves, per-step context packets, tree-as-memory (§21)
- Ann is built and managed with its own tree-of-steps pattern (dogfooding)
- Requirements = locked spec: agent-executed CLI primary flow, human = reviewer/answerer, sequential leaves v1, local-first, K4>5 = model-bet failure signal
- Nodes immutable — corrections are new nodes, never edits; process = append-only events (can't travel in time)
- Tree format v0: directory = node, id = path, per-node artifacts, searchable description.md cards, sibling order = sort prefix — to be formalized by 02-system-design
- Subtree creation planner-only in v1; agents propose
- Q1–Q4 are system-design decisions (not spec); carried in 02-system-design context

**Active pointers:** `design`, `AGENTS.md`, `tree/nodes/`, `tree/nodes/01-goal/01-grilling/artifacts/ann-spec.md`
