<!-- synced: 89ace76 -->

# CURSOR — Meta-Assistant (2026-08-16)

**Position:** Fresh spec locked. Next: re-derive the downstream contracts against the fresh spec (tree-format-spec-v2 / flow-control-spec / ann-system-design — they reference the superseded ann-spec) OR proceed to activate R5 (S1–S9 engine build). Recommended: quick contract re-derivation first, then R5.

**Blockers:** none. (Q1–Q4 resolved: Node.js+TS · adapter-first OpenAI-compatible · file-based, no SQLite v1 · CLI.)

**Open:** (design v3 §10 + fresh spec §7) multi-user = design constraint, not v1 · big-data query perf N/A v1 · bindings beyond GitHub · UI beyond CLI · joins/DAG · cross-round parallelism · human-gate weakening · storage at scale.

**Health:** 🟢 — no build to break (no code yet; R5 starts the build)

**Verification:** Fresh requirements-spec locked @ 89ace76 (clean-room; supersedes ann-spec, which got a superseded event @ 02-grilling). Stack: design v3 @ fd1125c → requirements-spec @ 89ace76 → tree-format-spec-v2 / flow-control-spec / ann-system-design @ 2522b6c (references to re-derive). R1–R4 done → R5 queued. K4>5 / advance-friction failure signals armed.

**Errors-that-changed-plan:** spec promotion dropped user's 03440cc PRD extension — reconciled. Storage default deviated (no SQLite) — flagged + user-informed. Flow-control defaults initially chat-only — recorded as node events. R3 status "superseded" wart — format v2 §3 fix (superseded annotates). Accreted spec stack → user directed clean-room fresh spec (this one) — the old docs are history.

**Decisions:**
- Product = the tree (living table of rounds), NOT a planner/plan artifact; self-similarity invariant (Ann's output structure = Ann's own structure)
- Fresh requirements: configurable step chain (default: idea → validate → envision → detailed specs → continue); steps = separately-managed gated nodes; flow config = data
- KPIs: K1 derived-accuracy 100% · K2 locate ≤2 · K3 advance ≤1 · K4 correctness ≥95% · failure signal = advance friction/wrong next-action
- Multi-user designed-for (not v1); no node limit; big-data perf N/A v1
- 12 invariants (design v3 §4); human gates at each step end; resolution ladder; complete artifacts; fail-closed everywhere

**Active pointers:** `AGENTS.md`, `tree/README.md`, `tree/rounds/`, design v3 + requirements-spec (fresh) + tree-format-spec-v2 + flow-control-spec + ann-system-design (all under `tree/rounds/` artifacts)
