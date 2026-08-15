# Ann PRD — Tree-of-Steps Planning System (v1)

*Produced by node `n02-requirement-grilling`. Draft — gated on Q1–Q4. Canonical contract: design §21 (locked @ eb07146).*

## 1. What & why

Ann converts ambiguous human goals into **living step trees** that downstream runners execute node-by-node. The tree is simultaneously the plan (contracts pointing forward), the project memory (artifacts/decisions pointing backward), and the observer (recorded project state and external bindings).

Why: one-shot plans fail because execution discovers reality; stateless agents burn 5–20k tokens/session reconstructing context. A self-aware step tree with per-step context packets and artifact gates makes each step grounded in what actually happened.

## 2. Who runs it

- **Primary user:** the person with the vague goal.
- **Runners (per node, `mode`):** coding agents, humans, automation.
- **Meta-user:** Ann's own team — Ann manages its own build via this tree (dogfooding).

## 3. Goals

1. Vague goal → requirement grilling → PRD/decision artifact → validated skeleton → lazy artifact-gated execution.
2. Every step is self-aware: path from root, siblings, remaining work as a set, artifacts.
3. External systems (GitHub, Figma, resource finders) bind as node I/O with provenance.
4. Quality gates per node: deterministic validation + runner simulation review before a node executes.
5. Evals at node, path, and tree level — judged by downstream runner success.

## 4. Non-goals (v1)

- No plugin/marketplace ecosystem.
- No multi-UI surfaces.
- No unbounded autonomous execution: subtree creation is planner-only; agents propose.
- Not a general chat/RAG system.

## 5. Success definition

A downstream runner completes the user's goal using only the tree-derived context (context packets + artifacts + ordinary project access), and the tree records what happened well enough that any failed subtree re-plans instead of failing upward silently.

## 6. Product acceptance criteria

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

## 7. Scope — MVP (design §21.12)

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

## 8. Blocking open questions (grilling output — answer to unlock this node's children)

| # | Question | Default if unanswered | Impact if wrong |
|---|---|---|---|
| Q1 | Runtime/language? | Node.js + TypeScript | Re-do of every slice; high |
| Q2 | First model provider? | Adapter-first; local OpenAI-compatible config | Re-work of grilling slice only; medium |
| Q3 | Storage for tree + checkpoints? | SQLite (better-sqlite3) + JSON artifacts on disk | Core API re-shape; high |
| Q4 | v1 UI form factor? | CLI + tree artifacts on disk | Re-skin of renderers; low-medium |

## 9. Constraints

- Structured data is canonical (§4); markdown is presentation only.
- Provenance mandatory; untrusted context never overrides planner policy (§17).
- Repair loops bounded: route reason + max iterations + checkpoint + fallback (§6.2).
- Dogfooding: Ann's own build is managed through this tree — same format the engine will consume.

## 10. Initial slices (children to spawn after PRD final)

1. **Tree persistence + node CRUD** — the format bootstrapped in `tree/`; schema validation.
2. **Grilling step impl** — template + LLM call, PRD/open-questions artifact output.
3. **Context packet assembler** — deterministic 6-layer assembly (§21.7).
4. **Deterministic validators** — AC2/AC5/AC6 checks, schema completeness, artifact gate.
5. **Skeleton expander** — eager top, lazy leaves, expansion policy (§21.5).
6. **Runner simulation review** — §6.2 reviewer pass per node.
7. **GitHub binding** — issue/PR create + provenance artifact (AC6).
8. **Renderers** — tree view, step cards, full plan (§18).
9. **Evals** — node/path fixtures (§21.11), regression goals.

## 11. Risks

- **Novelty of tree-engine semantics** → mitigation: the tree already exists as plain artifacts; engine reads/writes the same format. Keep the format honest before the framework is clever.
- **Overplanning** → lazy leaves + expansion policy (§21.5).
- **Agent drift** → context packets + per-node ACs + artifact gate.
- **Dogfood stall** → every slice ships by adding to this tree, not by building a parallel toy.
