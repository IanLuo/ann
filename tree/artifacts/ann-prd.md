# Ann PRD — Tree-of-Steps Planning System (v1)

*Produced by node `n02-requirement-grilling`. Draft — gated on Q1–Q4 + user accept. Canonical contract: design §21 (locked @ eb07146).*

## 1. What & why

Ann converts ambiguous human goals into **living step trees** that downstream runners execute node-by-node. The tree is simultaneously the plan (contracts pointing forward), the project memory (artifacts/decisions pointing backward), and the observer (recorded project state and external bindings).

Why: one-shot plans fail because execution discovers reality; stateless agents burn 5–20k tokens/session reconstructing context. A self-aware step tree with per-step context packets and artifact gates makes each step grounded in what actually happened.

## 2. Who runs it

- **Primary user:** the person with the vague goal.
- **Runners (per node, `mode`):** coding agents (v1 primary), humans (review/answer; step execution is a mode, not the v1 primary path), automation.
- **Meta-user:** Ann's own team — Ann manages its own build via this tree (dogfooding; also the v1 validation path).

## 3. Primary flow (v1)

One primary flow — **agent-executed CLI run**. The user is a reviewer and question-answerer, not an executor.

1. User types a vague goal into the CLI: "build me X".
2. Grilling node runs → PRD (or open-questions) draft artifact appears; blocking questions surfaced.
3. User answers blocking questions or accepts defaults.
4. Skeleton expands + validates: goal → grilling → branches, every branch with acceptance criteria.
5. The frontmost ready node executes via agent, with its context packet (§21.7).
6. Verification runs: on success the node commits (checkpoint) and its artifact is recorded; on failure the subtree re-plans, bounded (§6.2, §21.5).
7. Tree renders; user reviews step cards; partial execution only where the plan marks it safe.
8. Goal's success definition verified → done; execution feedback flows into evals (§21.11).

*Explicitly not a v1 primary flow:* a human manually executing every step of a large tree (exists as `mode: human`, deferred as primary).

## 4. Goals

1. Vague goal → requirement grilling → PRD/decision artifact → validated skeleton → lazy artifact-gated execution.
2. Every step is self-aware: path from root, siblings, remaining work as a set, artifacts.
3. External systems (GitHub, Figma, resource finders) bind as node I/O with provenance.
4. Quality gates per node: deterministic validation + runner simulation review before a node executes.
5. Evals at node, path, and tree level — judged by downstream runner success.

## 5. Non-goals (v1)

- No plugin/marketplace ecosystem.
- No multi-UI surfaces.
- No unbounded autonomous execution: subtree creation is planner-only; agents propose.
- Not a general chat/RAG system.
- No hosted/multi-tenant service (local-first).

## 6. Success definition

A downstream runner completes the user's goal using only the tree-derived context (context packets + artifacts + ordinary project access), and the tree records what happened well enough that any failed subtree re-plans instead of failing upward silently.

## 7. Product acceptance criteria

| # | Criterion | Verification |
|---|---|---|
| AC1 | Given a vague goal, the system produces a validated skeleton (goal → grilling → branches) before any execution | Run fixture goal; check tree state + validation report |
| AC2 | A node may not have children until its output artifact exists — enforced, not advisory | Deterministic validation rejects violating trees |
| AC3 | Every active node's context packet contains: path decisions, node contract, resolved inputs, sibling status, bindings state, open questions with provenance | Inspect packet for a fixture node |
| AC4 | A failed node re-plans its subtree with route reason, max iterations, checkpoint, fallback; never fails upward silently | Inject failing fixture; observe route + bounded retries |
| AC5 | Distance-to-goal renders as a set (unverified ACs + frontier leaves + open questions); no scalar progress number anywhere | Render tree view; grep for numeric progress |
| AC6 | Every external binding action is recorded with provenance; its result becomes a tree artifact | GitHub issue fixture; check trace + artifact |
| AC7 | Standard-mode plans pass deterministic validation + one runner simulation review before finalization | Fixture; check qualityReport (§4.15) |
| AC8 | Tree resumes from the last branch checkpoint after a crash | Kill process mid-node; resume; verify no lost commits |

## 8. KPIs + failure signal

| KPI | Target (v1 end) | Source |
|---|---|---|
| K1 Eval runner success: fixture node executions completing with ACs verified on first pass | ≥ 85% | §21.11 node-level evals |
| K2 Intake → validated skeleton latency, standard mode | < 2 min | trace timestamps |
| K3 Questions asked per plan, standard mode | ≤ 3 | §8 human-interaction policy |
| K4 Subtree re-plans per completed branch | ≤ 2 | trace route history |

**Failure signal (the "this bet was wrong" metric):** if K4 exceeds 5 re-plans per branch across eval fixtures — the tree model itself is wrong (skeleton quality, context packets, or artifact gates), not individual node bugs. Stop feature work and re-plan the model.

## 9. Non-functional requirements

- **Security (§17):** secrets never appear in plans, traces, or artifacts; destructive-action confirmation required; provenance mandatory; untrusted context never overrides planner policy.
- **Reliability:** crash-resume from branch checkpoint (AC8); repair loops always bounded (max iterations, fallback).
- **Performance:** context-packet assembly < 1s at ≤1k-node tree; full-skeleton deterministic validation < 5s (standard mode).
- **Usability:** a human can understand one step card without the whole plan; tree render is scannable (status-coded).
- **Observability (§14):** every run produces a full trace; failures debuggable without guessing.
- **Compatibility:** structured output is machine-consumable (`plan.json`); model provider is adapter-based (§16).
- **Cost:** bounded model calls per node — one grilling pass, one review pass, capped repairs.

## 10. Assumptions

- Downstream runner has ordinary project access.
- Node execution is agent-mode in v1; human step execution is a mode, not the primary path.
- Tree size stays under ~1k nodes in v1.
- Local-first; no hosted service in v1.
- The format bootstrapped in `tree/` is the engine's format — no migration.
- Chosen providers (LLM, GitHub) have stable APIs at v1 build time.

## 11. Recovery requirements (§4.13)

| Trigger | Response | Owner |
|---|---|---|
| Node execution fails verification | Subtree re-plan: route reason + targeted feedback, ≤3 iterations, checkpoint at last committed node; fallback = mark subtree blocked + keep partial artifact + ask user | planner kernel |
| Process crash mid-node | Resume from last branch checkpoint; node restarts with same context packet + evidence so far | planner kernel |
| Artifact corruption / schema drift | Validation refuses; artifact regenerated from node contract; never silent | planner kernel |

## 12. Scope — MVP (design §21.12)

1. Intake a vague goal.
2. Requirement grilling step → PRD or open-questions artifact.
3. Expand + validate the coarse skeleton.
4. Execute nodes with materialized context packets (agent mode).
5. Artifact gate + lazy leaf expansion.
6. Per-node deterministic validation + one repair loop.
7. One external binding: GitHub issue/PR.
8. Branch checkpoints + full trace.
9. Renders: tree view, per-step cards, full plan.

Deferred: joins (DAG edges) until single-branch flow is proven; multiple bindings; plugins; multi-UI.

## 13. Blocking open questions (grilling output — answer to unlock this node's children)

| # | Question | Default if unanswered | Impact if wrong |
|---|---|---|---|
| Q1 | Runtime/language? | Node.js + TypeScript | Re-do of every slice; high |
| Q2 | First model provider? | Adapter-first; local OpenAI-compatible config | Re-work of grilling slice only; medium |
| Q3 | Storage for tree + checkpoints? | SQLite (better-sqlite3) + JSON artifacts on disk | Core API re-shape; high |
| Q4 | v1 UI form factor? | CLI + tree artifacts on disk | Re-skin of renderers; low-medium |

## 14. Constraints

- Structured data is canonical (§4); markdown is presentation only.
- Provenance mandatory; untrusted context never overrides planner policy (§17).
- Repair loops bounded: route reason + max iterations + checkpoint + fallback (§6.2).
- Dogfooding: Ann's own build is managed through this tree — same format the engine will consume.

## 15. Initial slices (children to spawn after PRD final)

1. **Tree persistence + node CRUD** — the format bootstrapped in `tree/`; schema validation.
2. **Grilling step impl** — template + LLM call, PRD/open-questions artifact output.
3. **Context packet assembler** — deterministic 6-layer assembly (§21.7).
4. **Deterministic validators** — AC2/AC5/AC6 checks, schema completeness, artifact gate.
5. **Skeleton expander** — eager top, lazy leaves, expansion policy (§21.5).
6. **Runner simulation review** — §6.2 reviewer pass per node.
7. **GitHub binding** — issue/PR create + provenance artifact (AC6).
8. **Renderers** — tree view, step cards, full plan (§18).
9. **Evals** — node/path fixtures (§21.11), regression goals.

## 16. Risks

- **Novelty of tree-engine semantics** → mitigation: the tree already exists as plain artifacts; engine reads/writes the same format. Keep the format honest before the framework is clever.
- **Overplanning** → lazy leaves + expansion policy (§21.5).
- **Agent drift** → context packets + per-node ACs + artifact gate.
- **Dogfood stall** → every slice ships by adding to this tree, not by building a parallel toy.
- **Model-bet failure** → K4 failure signal stops feature work (§8).
