<!-- synced: 7d89a09 -->

# CURSOR — Meta-Assistant (2026-08-16)

**Position:** Foundation rework complete — all contracts re-derived from the fresh spec. Next: activate R5 — spawn S1–S9 (ann-system-design §1: incl. new Flow-config + Envision components) and build the engine.

**Blockers:** none. (Q1–Q4 resolved: Node.js+TS · adapter-first OpenAI-compatible · file-based, no SQLite v1 · CLI.)

**Open:** (design v3 §10 + requirements-spec §7) multi-user = design constraint, not v1 · big-data query perf N/A v1 · bindings beyond GitHub · UI beyond CLI · joins/DAG · cross-round parallelism · human-gate weakening · storage at scale.

**Health:** 🟢 — no build to break (no code yet; R5 starts the build)

**Verification:** Chain @ 257cb79: design v3 (fd1125c→257cb79) → requirements-spec (89ace76, fresh clean-room) → tree-format-spec-v2 / flow-control-spec / ann-system-design (all re-locked @ 257cb79 on the fresh upstream). Rework scope: K4→advance-correctness, configurable step templates + envision (flow-control §7), Flow-config + Envision components + no-limit scale + multi-user notes (system-design), multi-user-ready note (format v2). Zero stale ann-spec cites in current docs (7d89a09). R1–R4 done → R5 queued.

**Errors-that-changed-plan:** 03440cc PRD extension dropped→reconciled · storage default deviated→flagged · flow-control defaults chat-only→recorded as events · R3 status wart→format §3 fix · accreted spec stack→clean-room fresh spec · downstream contracts consumed wrong foundation→re-derived this session.

**Decisions:**
- Product = the tree (living table of rounds), NOT a planner/plan artifact; self-similarity invariant
- Fresh requirements: configurable step chain (default: idea → validate → envision → detailed specs → continue); steps = separately-managed gated nodes; config = data
- KPIs: K1 derived-accuracy 100% · K2 locate ≤2 · K3 advance ≤1 · K4 correctness ≥95% · failure signal = advance friction / wrong next-action
- Multi-user designed-for (not v1); no node limit; big-data perf N/A v1
- Human gates at each step end; resolution ladder; complete artifacts; fail-closed everywhere; 12 invariants (design v3 §4)

**Active pointers:** `AGENTS.md`, `tree/README.md`, `tree/rounds/`, design v3 + requirements-spec + tree-format-spec-v2 + flow-control-spec + ann-system-design (all under `tree/rounds/` artifacts)
