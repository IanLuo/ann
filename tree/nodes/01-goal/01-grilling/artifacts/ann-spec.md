<!-- specs:locked:2664511 2026-08-15 type=spec -->

## Link contract
- **upstream** (this doc relies on): design
- **referrers** (must cite this when they change): n03-system-design,implementation slices review-task

# Ann Requirements Spec (v1)
*Artifact of node `01-goal/01-grilling`. Supersedes `ann-prd.md` draft (incl. extension 03440cc — its decisions are merged here verbatim). Complete requirements contract for building Ann. Model semantics live in `design` §21 (locked @ eb07146); this doc freezes project decisions. Type: spec (root).*

## 1. Problem & who breaks

- Who: the builder (engineer/lead) with a vague goal ("make onboarding better", "build a sync service") who must get it built by agents without babysitting every step.
- Break: one-shot plans fail mid-execution because execution discovers reality; agents are stateless (5–20k tokens/session context reconstruction); every vague goal forces either over-planning up front or drift during execution.
- If nothing is done: building with agents stays a gamble — plan quality can't be trusted, and each new goal restarts from zero memory.

## 2. Non-negotiable outcome

- A vague natural-language goal becomes a step tree that a downstream runner executes to completion — each step's contract, context, and artifacts present — **without the runner guessing**.
- Tester pass/fail without arguing: run fixture goal F1 → runner completes it; every executed node's acceptance criteria have evidence; no runner clarification needed. (Measured: K1, §5.)
- Dogfooding is the v1 validation path: Ann's own build runs through this tree, so the format is exercised before the engine exists.

## 3. Scope in / out + primary flow

- In (v1, design §21.12): intake · grilling → PRD-or-questions artifact · skeleton expand + validate · agent-mode node execution with context packets · artifact gate + lazy leaves · per-node deterministic validation + one repair loop · GitHub issue/PR binding · branch checkpoints + trace · renders (tree view / step cards / full plan).
- Out (v1): joins (DAG edges) until single-branch flow proven · more than one external binding · plugins/marketplace · multi-UI · human-mode execution as the primary path · agent-created subtrees (planner-only) · **hosted/multi-tenant service (local-first)**.
- Primary flow — one path, **agent-executed CLI run**; the user is a reviewer and question-answerer, not an executor:
  1. User types a vague goal into the CLI: "build me X". (Empty/greeting-only rejected at intake.)
  2. Grilling node runs → PRD-or-questions draft artifact appears; blocking questions surfaced.
  3. User answers blocking questions or accepts defaults.
  4. Skeleton expands + validates: goal → grilling → branches, every branch with acceptance criteria; artifact gate enforced.
  5. The frontmost ready node executes via agent, with its context packet (§21.7).
  6. Verification runs: on success the node commits (checkpoint) and its artifact is recorded; on failure the subtree re-plans, bounded (§6.2, §21.5).
  7. Tree renders; user reviews step cards; partial execution only where the plan marks it safe.
  8. Goal's success definition verified → done; execution feedback flows into evals (§21.11).
- Explicitly not v1: human/automation node *execution* (modes exist in the model; v1 executes agent-mode nodes only — human = reviewer/answerer, automation deferred).
- Execution order: leaves activate **sequentially** in v1; parallel ready-node execution deferred (design §19 deferred advanced parallel planning).
- "Standard mode" in this spec = design §9 depth mode; quick/deep modes exist in the model but only standard mode is in the v1 fixture suite.

## 4. Acceptance criteria

- AC1: Given a vague goal, a validated skeleton (goal → grilling → branches) exists before any execution. (Automated fixture.)
- AC2: *Given* a node whose output artifact does not exist, *when* the planner tries to spawn children, *then* validation rejects it. (Deterministic validator; artifact gate.)
- AC3: Every active node's context packet contains: path decisions · node contract · resolved inputs · sibling status · bindings state · open questions with provenance. (Inspector fixture.)
- AC4: A failed node re-plans its subtree with route reason, max 3 iterations, checkpoint preserved, fallback defined; never fails upward silently.
- AC5: Distance-to-goal renders as a set (unverified ACs + frontier leaves + open questions); no scalar progress number in any render.
- AC6: *Given* a node with a GitHub binding, *when* the action completes, *then* the action and its result are recorded with provenance and the result becomes a tree artifact.
- AC7: Standard-mode plans pass deterministic validation + one runner-simulation review before finalization.
- AC8: *Given* a process killed mid-node, *when* resumed, *then* execution continues from the last committed checkpoint with no lost committed nodes (RPO = 0).
- Edge: smallest accepted input = one-sentence goal. Smallest rejected = empty string or greeting with no goal. Unsupported claims dropped, not hedged.

## 5. KPIs & failure signal

- K1 — eval runner success: fixture node executions completing with ACs verified on first pass, **≥ 85%** (v1 end; §21.11 node-level evals).
- K2 — intake → validated skeleton latency, standard mode, **< 2 min** (trace timestamps).
- K3 — questions asked per plan, standard mode, **≤ 3** (§8 human-interaction policy).
- K4 — subtree re-plans per completed branch, **≤ 2 on average across the eval fixture suite** (trace route history; AC4 remains the per-node hard bound of 3).
- **Failure signal (the "this bet was wrong" metric):** K4 exceeds **5 re-plans per branch** across eval fixtures → the tree model itself is wrong (skeleton quality, context packets, or artifact gates), not individual node bugs. Stop feature work and re-plan the model.
- All targets measured against the eval fixture suite (§11). Not launch gates; measured continuously from the first fixture.

## 6. Non-functional requirements

- NFR-SEC-1 — security (§17): secrets never appear in plans, traces, or artifacts; destructive-action confirmation required; provenance mandatory; untrusted context never overrides planner policy. Enforced, not best-effort.
- NFR-REL-1 — reliability: crash-resume from branch checkpoint (AC8; RPO = 0 for committed nodes); repair loops always bounded (max iterations, fallback).
- NFR-PERF-1 — performance: context-packet assembly **< 1s** at ≤1k-node tree; full-skeleton deterministic validation **< 5s** (standard mode).
- NFR-USE-1 — usability: a human can understand one step card without the whole plan; tree render is scannable (status-coded).
- NFR-OBS-1 — observability (§14): every run produces a full trace; failures debuggable without guessing.
- NFR-COM-1 — compatibility: structured output is machine-consumable (plan.json / tree artifacts); model provider is adapter-based (§16).
- NFR-CST-1 — cost: bounded model calls per node — one grilling pass, one review pass, capped repairs.
- NFR-OPS-1 — operations: one command to run; one command to resume from the last checkpoint (AC8 requires a resume path).
- N/A — hosted/scale NFRs: local-first v1, no multi-tenant service. 10×-worse check: PERF-1 at 10s stalls every step → keep; OBS-1 at 10× = no trace → cut, it's load-bearing for evals; OPS-1 at 10× = 10 commands → cut.

## 7. Assumptions & dependencies

- A1: downstream runner has ordinary project access (design §1). Invalidation: runner without repo access → plan must inline all context (out of scope v1; flag at intake).
- A2: node execution is agent-mode in v1; human step execution is a mode, not the primary path. Invalidation: human-executed nodes become primary → scope change.
- A3: tree size stays under ~1k nodes in v1 (anchors NFR-PERF-1). Invalidation: larger trees → revisit perf budget.
- A4: local-first; no hosted service in v1. Invalidation: multi-user requirement → scope change.
- A5: the format bootstrapped in `tree/` is the engine's format — no migration. Invalidation: engine needs a different shape → treat as data migration, costed separately.
- A6: chosen providers (LLM, GitHub) have stable APIs at v1 build time. Invalidation: breaking API change → adapter layer absorbs it (§16); never in plan semantics.
- D1 (dependency): LLM provider API availability (any adapter). Trigger: unavailable/rate-limited → retry / alternate / ask_user per §12 outcomes, never silent degradation.

## 8. Data requirements

- Required inputs: user goal (must exist). Optional: project context, blocking-question answers, observed project state (§21.9).
- Expected outputs: step tree (nodes + edges + status) · node artifacts · context packets · trace events (§14) · renders.
- Must survive (crash/redeploy, RPO = 0): committed nodes, artifacts, open questions, checkpoint refs. Uncommitted node state may be lost (documented).
- Empty record: goal node with no children = valid leaf. Plan with no goal = rejected. Context packet with empty inputs = valid only if the node declares no requiredInputs.

## 9. Rollback & recovery

| Trigger | Response | Owner |
|---|---|---|
| Node execution fails verification | Subtree re-plan: route reason + targeted feedback, ≤3 iterations, checkpoint at last committed node; fallback = mark subtree blocked + keep partial artifact + ask user (§6.2/§7, AC4) | planner kernel |
| Process crash mid-node | Resume from last branch checkpoint; node restarts with same context packet + evidence so far (AC8) | planner kernel |
| Artifact corruption / schema drift | Validation refuses; artifact regenerated from node contract; never silent | planner kernel |

- Destructive binding action → confirmation before execution (§17).
- The one failure that would wreck the product: tree/checkpoint corruption (RPO violation). Mitigation: append-only commits + artifact checksums (decided at system-design).

## 10. Security & compliance

- Secrets redaction in plans/traces/renders (NFR-SEC-1).
- Destructive-action confirmation (§17).
- Provenance on all context facts and bindings (§4.5, §21.10).
- Untrusted context cannot override planner policy (§17).
- Compliance: N/A — personal tool, local-first, no regulated data. Explicit, not invented.

## 11. Verification plan

- AC1 → fixture: vague goal → assert skeleton exists pre-execution (automated).
- AC2 → deterministic validator rejects child-without-artifact (automated).
- AC3 → packet inspector fixture (automated).
- AC4 → failing-fixture test: assert route reason + ≤3 retries + checkpoint preserved (automated).
- AC5 → render fixture + grep: no scalar progress value (automated).
- AC6 → GitHub integration fixture: action + provenance artifact in trace (automated).
- AC7 → standard-mode fixture: validation + one runner review (automated + model review).
- AC8 → kill -9 mid-node, resume, assert no lost committed nodes (automated crash test).
- K1 → eval harness over fixture suite, first-pass AC completion (§21.11).
- K2 → trace timestamps on standard-mode fixture (automated).
- K3 → fixture count of surfaced blocking questions (automated).
- K4 → trace route history on failing fixtures (automated).
- NFR-SEC-1 → redaction check on fixtures with planted secrets (automated).
- NFR-REL-1 → covered by AC8.
- NFR-PERF-1 → benchmark fixture at 1k nodes: packet assembly + skeleton validation (automated).
- NFR-USE-1 → step-card comprehension sample (human eval, sampled).
- NFR-OBS-1 → trace completeness check on every fixture (automated).
- NFR-COM-1 → machine-consumable output assertion (automated).
- NFR-CST-1 → model-call counter on standard-mode fixture (automated).
- NFR-OPS-1 → documented commands + smoke test: run fixture, kill, resume (automated).

---

Locked: 2026-08-15 @ 2664511 · type=spec · upstream `design` (locked @ eb07146) · referrers n03-system-design, implementation slices, review-task
Last reviewed: 2026-08-15 · owner: user
