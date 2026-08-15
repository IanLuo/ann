<!-- synced: 03440cc -->

# CURSOR — Meta-Assistant (2026-08-15)

**Position:** Requirements spec complete (PRD draft, 16 sections). Grilling node `n02` still blocked on Q1–Q4. Next: user answers Q1–Q4 + accepts PRD → prd-lock `tree/artifacts/ann-prd.md` → flip n02 to done → spawn system-design node (technique details) + implementation slices.

**Blockers:** n02 blocked on Q1–Q4 (runtime, provider, storage, UI — defaults in PRD §13).

**Open:**
- Q1 runtime (default Node.js + TypeScript)
- Q2 first model provider (default adapter-first, local OpenAI-compatible)
- Q3 storage (default SQLite better-sqlite3 + JSON artifacts)
- Q4 v1 UI (default CLI + tree artifacts on disk)

**Health:** 🟢 — no build to break (no code yet)

**Verification:** `design` locked @ eb07146 (type=system-design). Tree @ 03440cc: `n01-goal` (done), `n02-requirement-grilling` (blocked), `tree/artifacts/ann-prd.md` (16-section draft incl. KPIs K1–K4, NFRs, assumptions, recovery). Library entry saved (agent-engineering/tree-of-steps-*).

**Errors-that-changed-plan:** none

**Decisions:**
- Canonical model = tree-of-steps v2: eager skeleton, lazy artifact-gated leaves, per-step context packets, tree-as-memory (§21)
- Ann is built and managed with its own tree-of-steps pattern (dogfooding); tree lives at `tree/` with per-node JSON + artifacts
- Distance-to-goal is a SET (unverified ACs + frontier leaves + open questions), never a scalar
- Tree = ownership tree; dependencies = DAG layered on top (joins via requiredInputs)
- Subtree creation is planner-only in v1; executing agents propose
- Artifact gate: a node may not spawn children until its own output artifact exists
- v1 primary flow = agent-executed CLI run; human is reviewer/answerer (PRD §3)
- K4 failure signal (re-plans/branch > 5) stops feature work — the tree-model-wrong bet metric (PRD §8)
- MVP re-scoped (§21.12 + PRD §12): grilling → PRD → skeleton → context-packet execution → one GitHub binding

**Active pointers:** `design`, `AGENTS.md`, `tree/nodes/`, `tree/artifacts/ann-prd.md`
