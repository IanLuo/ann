# REQUIREMENT GRILLING — Ann requirements contract

- id: `02-grilling` · status: **done** (R2 — round gate met: requirements-spec locked @ 89ace76; ann-spec superseded)
- round: R2 · input: R1's artifact (design §21)
- intent: convert the vague goal into the complete, locked requirements contract
- **artifact: `01-spec-rework/artifacts/requirements-spec.md`** (fresh clean-room spec, specs-locked @ 89ace76 — self-similarity, configurable step chain, AC-1–5, K1–K4 + failure signal, NFRs, assumptions, data, recovery, security, verification)
- key decisions frozen: agent-executed CLI primary flow · human = reviewer/answerer · rounds sequential, tasks parallel in v1 · local-first · RPO=0 · K4>5 = model-bet failure signal
- surfaced blocking questions Q1-Q4 (runtime/provider/storage/UI) — **carried by R4 (04-system-design)**
- rounds chain: ← `01-goal` · → `03-tree-format` (R3)
- search terms: requirements, spec, PRD, acceptance criteria, KPI, NFR, assumptions, recovery, security, verification, grilling
