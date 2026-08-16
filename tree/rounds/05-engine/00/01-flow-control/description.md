# FLOW CONTROL — the workflow semantics

- id: `05-engine/00/01-flow-control` · status: **queued** (first task of R5; contract set, work pending)
- task of round 5 · group position: 01 (before S1–S9 slices — they run under it)
- intent: define + lock the **flow-control spec**: common skeleton (creation/completion/chain-append) × per-work-type flows × input-resolution ladder
- origin: user decision — missing-input handling (resolve/ask/block) is part of flow control; node/nodeGroup appended to the chain based on previous rounds/steps; varies by work type, common structure
- required inputs: design §6/§21.5/§21.6 · ann-spec (ACs, K1–K4, §8) · tree-format-spec-v2 · ann-system-design §1
- deliverable: `artifacts/flow-control-spec.md` (locked) — S5 planner kernel implements it
- search terms: flow control, workflow, lifecycle, spawn, materialize, validate, execute, verify, commit, gates, round gate, artifact gate, completion, chain, append, resolution ladder, derive, probe, infer, ask, block, sibling correction, parallel group, work types
