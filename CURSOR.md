<!-- synced: e088045 -->

# CURSOR — Meta-Assistant (2026-08-15)

**Position:** Spec locked, grilling done. Next: run n03-system-design (queued) — answer Q1–Q4, produce `tree/artifacts/ann-system-design.md` (components/data/interfaces/failure/scale), lock it, then spawn implementation slices.

**Blockers:** n03 blocked until Q1–Q4 answered (runtime, provider, storage, UI — defaults in node `n03` openQuestions).

**Open:**
- Q1 runtime (default Node.js + TypeScript)
- Q2 first model provider (default adapter-first, local OpenAI-compatible)
- Q3 storage (default SQLite better-sqlite3 + JSON artifacts)
- Q4 v1 UI (default CLI + tree artifacts on disk)

**Health:** 🟢 — no build to break (no code yet)

**Verification:** `design` locked @ eb07146. `tree/artifacts/ann-spec.md` specs-locked @ 2664511 (11-rung contract; K1–K4; NFRs; AC1–AC8; contract upstream=design, referrers n03/slices/review-task). Tree: n01 done, n02 done, n03 queued (e088045). Library entry saved.

**Errors-that-changed-plan:** none (one false step: spec promotion initially dropped user's 03440cc PRD extension — reconciled, decisions merged verbatim)

**Decisions:**
- Canonical model = tree-of-steps v2: eager skeleton, lazy artifact-gated leaves, per-step context packets, tree-as-memory (§21)
- Ann is built and managed with its own tree-of-steps pattern (dogfooding); tree at `tree/` with per-node JSON + artifacts
- Requirements = locked spec: agent-executed CLI primary flow, human = reviewer/answerer, sequential leaves v1, local-first, K4>5 = model-bet failure signal
- Distance-to-goal is a SET, never a scalar; artifact gate enforced
- Subtree creation planner-only in v1; agents propose
- Q1–Q4 are system-design decisions (not spec); carried in n03 context

**Active pointers:** `design`, `AGENTS.md`, `tree/nodes/`, `tree/artifacts/ann-spec.md`
