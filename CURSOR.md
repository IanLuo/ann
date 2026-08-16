<!-- synced: 29bfa69 -->

# CURSOR — Meta-Assistant (2026-08-16)

**Position:** R4 active. Task 01 done (format v2 locked). Next: task 02 — answer Q1–Q4, produce `tree/rounds/04-system-design/00/02-system-design-doc/artifacts/ann-system-design.md`, lock it → R4 gate met → spawn R5 (engine, parallel group).

**Blockers:** 02-system-design-doc blocked until Q1–Q4 answered (runtime, provider, storage, UI — defaults in R4 root node.json openQuestions).

**Open:**
- Q1 runtime (default Node.js + TypeScript)
- Q2 first model provider (default adapter-first, local OpenAI-compatible)
- Q3 storage (default SQLite better-sqlite3 + JSON artifacts)
- Q4 v1 UI (default CLI + tree artifacts on disk)

**Health:** 🟢 — no build to break (no code yet)

**Verification:** design locked @ eb07146. ann-spec locked @ 9e37c8f (rotated — one line: rounds sequential / tasks parallel). tree-format-spec-v2 locked @ 9e37c8f (rounds model: table of epics, sequential gates, parallel task groups, depth policy ≤8 levels/260 chars; supersedes v1 + depth-policy 11c3de2). Table: R1 done → R2 done → R3 done → R4 active (task 01 done, task 02 queued) → R5 future (29bfa69).

**Errors-that-changed-plan:** spec promotion initially dropped user's 03440cc PRD extension — reconciled. Depth-policy node (11c3de2, user's) absorbed into format v2 rather than duplicated.

**Decisions:**
- Canonical model = tree-of-steps v2: table of rounds (epics), sequential gated rounds, parallel task groups inside a round, per-step context packets, tree-as-memory (§21)
- Node structure updates are tasks, and tasks are nodes; corrections = sibling nodes, never edits
- Ann is built and managed with its own tree-of-steps pattern (dogfooding)
- Requirements = locked spec: agent-executed CLI primary flow, human = reviewer/answerer, rounds sequential + tasks parallel in v1, local-first, K4>5 = model-bet failure signal
- Format v2 locked: rounds table, id = path from tree/rounds/, per-node artifacts, searchable description.md, depth policy (sibling-correction, pruning, name discipline)
- Subtree creation planner-only in v1; agents propose
- Q1–Q4 are system-design decisions (not spec); carried in R4 context

**Active pointers:** `design`, `AGENTS.md`, `tree/README.md`, `tree/rounds/`, `tree/rounds/02-grilling/artifacts/ann-spec.md`, `tree/rounds/04-system-design/00/01-format-amendment-v2/artifacts/tree-format-spec-v2.md`
