# Ann Requirements Spec (v1)

*Artifact of node `n02-requirement-grilling`. Supersedes `ann-prd.md` draft (promoted per specs ladder). Complete requirements contract for building Ann. Model semantics live in `design` §21 (locked @ eb07146); this doc freezes project decisions. Type: spec (root).*

## 1. Problem & who breaks

- Who: the builder (engineer/lead) with a vague goal ("make onboarding better", "build a sync service") who must get it built by agents without babysitting every step.
- Break: one-shot plans fail mid-execution because execution discovers reality; agents are stateless (5–20k tokens/session context reconstruction); every vague goal forces either over-planning up front or drift during execution.
- If nothing is done: building with agents stays a gamble — plan quality can't be trusted, and each new goal restarts from zero memory.

## 2. Non-negotiable outcome

- A vague natural-language goal becomes a step tree that a downstream runner executes to completion — each step's contract, context, and artifacts present — **without the runner guessing**.
- Tester pass/fail without arguing: run fixture goal F1 → runner completes it; every executed node's acceptance criteria have evidence; no runner clarification needed. (Measured: KPI-1, §5.)

## 3. Scope in / out + primary flow

- In (v1, design §21.12): intake · grilling → PRD-or-questions artifact · skeleton expand + validate · agent-mode node execution with context packets · artifact gate + lazy leaves · per-node deterministic validation + one repair loop · GitHub issue/PR binding · branch checkpoints + trace · renders (tree view / step cards / full plan).
- Out (v1): joins (DAG edges) until single-branch flow proven · more than one external binding · plugins/marketplace · multi-UI · human-mode execution as the primary path · agent-created subtrees (planner-only).
- Primary flow (one path — confirm §5 decisions):
  1. User submits vague goal (one sentence; empty/greeting-only rejected at intake).
  2. Grilling node runs → requirements artifact; blocking questions surfaced.
  3. User answers blocking questions or accepts defaults.
  4. Planner expands + validates skeleton (goal → grilling → branches); artifact gate enforced.
  5. Leaves activate one at a time; each receives a materialized context packet (§21.7) and executes in agent mode.
  6. Each node verifies its ACs (deterministic checks + evidence) before commit.
  7. Failed node → subtree re-plan (route reason, ≤3, checkpoint, fallback).
  8. Human intervenes only at blocking questions + final plan review.
  9. Tree renders on demand: tree view + step cards + full plan.
- Decision locked unless overridden: v1 primary runner = **agent**; human = blocking questions + review.

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

- KPI-1: runner success rate ≥ 80% on standard-mode fixture goals (runner completes goal without clarification). [proposed]
- KPI-2: blocking questions per plan ≤ 2 (standard mode). [proposed]
- KPI-3: grilling → first artifact p95 ≤ 2 min. [proposed]
- KPI-4: standard-mode runs needing > 1 subtree repair ≤ 20%. [proposed]
- **Failure signal (off-switch):** runner success on tree-of-steps fixtures ≤ upfront plan-and-execute baseline on the same fixtures → the tree model is the wrong bet → halt, re-design, ship no more slices.
- Confirmed-by-user needed: the four numbers above.

## 6. Non-functional requirements

- NFR-SEC-1: no secrets in plans, traces, or renders — enforced, not best-effort (design §17).
- NFR-REL-1: RPO = 0 for committed nodes; a committed node survives crash/kill (AC8).
- NFR-PERF-1: context packet assembly p95 < 1s on a 500-node tree. [proposed number]
- NFR-USE-1: a human can act on a single step card without reading the whole plan (step-card comprehension fixture).
- NFR-OPS-1: one command to run; one command to resume from last checkpoint.
- N/A — cost & compatibility NFRs: adapter-based (§16), no fixed budget in v1; revisit at system-design. 10×-worse check: PERF-1 at 10s stalls every step → keep. OPS-1 at 10× = 10 commands → cut; one-command is load-bearing.
- Confirmed-by-user needed: PERF-1 number; drop any NFR that feels decorative.

## 7. Assumptions & dependencies

- A1: downstream runner has ordinary project access (design §1). Invalidation: runner without repo access → plan must inline all context (out of scope v1; flag at intake).
- A2: agent-mode is the v1 executor; human-mode nodes exist but are not primary. Invalidation: human-executed nodes become primary → scope change.
- A3: tree ≤ ~1k nodes in v1 (anchors NFR-PERF-1). Invalidation: larger trees → revisit perf budget.
- A4: planner's only external runtime dependency is the LLM provider (adapter, §16). Invalidation: provider down/rate-limited → retry / alternate / ask_user per §12 outcomes.
- A5: smallest accepted input = one-sentence goal; rejected = empty/greeting-only (intake rule).
- D1 (dependency): LLM provider API availability (any adapter). Trigger: unavailable → §12 failure outcomes, never silent degradation.

## 8. Data requirements

- Required inputs: user goal (must exist). Optional: project context, blocking-question answers, observed project state (§21.9).
- Expected outputs: step tree (nodes + edges + status) · node artifacts · context packets · trace events (§14) · renders.
- Must survive (crash/redeploy, RPO = 0): committed nodes, artifacts, open questions, checkpoint refs. Uncommitted node state may be lost (documented).
- Empty record: goal node with no children = valid leaf. Plan with no goal = rejected. Context packet with empty inputs = valid only if the node declares no requiredInputs.

## 9. Rollback & recovery

- Failed node → subtree re-plan: route reason, targeted feedback, max 3, checkpoint, fallback (design §6.2/§7; AC4).
- Crash/kill → resume from last committed checkpoint (AC8); uncommitted node restarts from spawn.
- Destructive binding action → confirmation before execution (§17).
- The one failure that would wreck the product: tree/checkpoint corruption (RPO violation). Mitigation: append-only commits + artifact checksums (decided at system-design).

## 10. Security & compliance

- Secrets redaction in plans/traces/renders (NFR-SEC-1).
- Destructive-action confirmation (§17).
- Provenance on all context facts and bindings (§4.5, §21.10).
- Untrusted context cannot override planner policy (§17).
- Compliance: N/A — personal tool, no regulated data. Explicit, not invented.

## 11. Verification plan

- AC1 → fixture: vague goal → assert skeleton exists pre-execution (automated).
- AC2 → deterministic validator rejects child-without-artifact (automated).
- AC3 → packet inspector fixture (automated).
- AC4 → failing-fixture test: assert route reason + ≤3 retries + checkpoint preserved (automated).
- AC5 → render fixture + grep: no scalar progress value (automated).
- AC6 → GitHub integration fixture: action + provenance artifact in trace (automated).
- AC7 → standard-mode fixture: validation + one runner review (automated + model review).
- AC8 → kill -9 mid-node, resume, assert no lost committed nodes (automated crash test).
- NFR-SEC-1 → redaction check on fixtures with planted secrets (automated).
- NFR-REL-1 → covered by AC8.
- NFR-PERF-1 → benchmark fixture at 500 nodes (automated).
- NFR-USE-1 → step-card comprehension sample (human eval, sampled).
- NFR-OPS-1 → documented commands + smoke test (automated).
- KPI-1/2/3/4 → eval harness over the fixture suite (design §21.11) — the bridge to review-task.

---

**Contract rung (confirm before lock):** upstream = `design` (locked @ eb07146). Referrers = `tree/nodes/n03-system-design` (next node), `tree/nodes/n04+ implementation slices`, review-task.
