<!-- specs:locked:7ddc09b 2026-08-18 type=spec -->

## Link contract
- **upstream** (this doc relies on): tree/rounds/01-goal/artifacts/design.md,02-grilling/01-spec-rework/artifacts/requirements-spec.md 05-engine/00/09-format-amendment-v4/artifacts/tree-format-spec-v4.md
- **referrers** (must cite this when they change): S5 planner kernel,implementation slices review-task

# Flow Control Spec (v1)
*Artifact of task `05-engine/00/01-flow-control`. Type: spec. Upstream: `tree/rounds/01-goal/artifacts/design.md` (v3, locked @ 257cb79), `02-grilling/01-spec-rework/artifacts/requirements-spec.md` (locked @ 89ace76), `01-format-amendment-v2/artifacts/tree-format-spec-v2.md` (locked @ 257cb79). Referrers: S5 planner kernel, implementation slices, review-task.*

## 1. Scope

- The **workflow semantics** of the engine: node lifecycle, creation, completion, chain append, human gates, input-resolution ladder, **configurable work-type flows** (step chains are project data — requirements-spec AC-3). Common structure × per-type variation (design v3 §2/§4).

## 2. Node lifecycle (common skeleton)

```
 spawn → materialize → [GATE① grilling] → validate → activate → execute → verify → [GATE② confirm]
   → commit → LOOK-BACK (journey review) → determine next (grounded) → propose / advance
```

- **States:** `queued · active · blocked (incl. waiting on human gate) · done · failed · superseded` (derived from events, format v2 §3).
- **materialize:** assemble the context packet (path decisions · node contract · resolved inputs · sibling status · binding state · open questions with provenance); run the resolution ladder (§4) for missing inputs.
- **validate:** deterministic — schema, artifact gate, round gate, ACs declared, inputs resolved, distance-to-goal as a set.
- **activate:** frontmost-ready selection — the **OUTPUT of the look-back** (§2a): prefix orders candidates; readiness is gate-validated from the log; failed/superseded siblings skipped. Never assumed.
- **LOOK-BACK (v2, after commit — the observer action):** when a task completes, the engine briefly reviews the journey — statuses, gates, artifacts, round state — all **derived from the events**, and determines: **where we are** (current position, completed work, pending gates) and **what's ahead** (frontmost-ready task, remaining round work, next round after the round gate). The next-task proposal is **grounded in that review, never assumed**. This powers F5 `run next` (functional-spec). Pre-engine implementation: `scripts/resolve.mjs --journey`.
- **execute:** mode `agent` (v1 primary) · `human` · `automated`.
- **verify:** ACs met + evidence.
- **commit:** checkpoint (git), artifact recorded. Gates enforced: **round gate** (round N+1 only after N's `completed`), **artifact gate** (children only after the node's artifact exists), **completion** (ACs + evidence + GATE② accepted).

## 3. Human gates (structural — every step stops and waits)

- **GATE① grilling (entry):** human validates understanding/approach before execution. Presents: step card (intent, ACs, packet summary, artifacts). Collects: `accept` | `reject + feedback`.
- **GATE② confirm-result (exit):** human confirms the output before commit. Presents: artifacts + evidence. Collects: `accept` | `reject + feedback`.
- Both gates are **HARD on every node in v1**; work-type weakening = v2 plugin concern (design v3 §10).
- **Rejection → rework, closed through the same gate:**
  - GATE① reject → **re-materialize** (rework context/approach from artifacts + feedback) → re-validate → back to GATE①.
  - GATE② reject → **re-execute** (rework output from artifacts + feedback) → re-verify → back to GATE②. If the feedback invalidates the *approach*, escalate to the GATE① loop (re-materialize).
  - Resume point is decided by the feedback — never `activate`.
- **Bound:** 3 rejection cycles per gate; then escalate to a human design decision (force-approve / restructure / block). Rejection cycles **feed the advance-correctness signal (K4, requirements-spec §5)** — sustained rework means the structure isn't producing acceptable output.
- **Human interface is pluggable (adapter):** talk (v1 — round-and-round: present-draft · collect-decision · collect-feedback · present-question · collect-answer) · interactive HTML / other forms via plugins (deferred, design v3 §9/§10).
- **Human unreachable/unresponsive → step stays `blocked`** (fail-closed), blocker named.

## 4. Input-resolution ladder (at materialize)

Missing `requiredInputs` or blocking `openQuestions` → resolve in order:

1. **derive** — from ancestors/siblings (tree memory). Provenance: `derived-from`.
2. **probe** — read project state / external systems (files, git, APIs). Provenance: `observation`.
3. **infer** — labeled `inference` + confidence + fallback. **FORBIDDEN when impact-if-wrong is high AND no safe fallback exists** (the silent-inference rule — the Q1–Q4 lesson).
4. **ask** — user question (impact, options, default), **batched per task**, **deduped** via tree memory (never ask the same question twice).
5. **block** — node `blocked`, missing input named; `partial_final` only with user acceptance.

Ask-vs-infer gate (design v3 §4): **ask** if high impact ∨ low confidence ∧ no safe fallback ∨ irreversible/destructive ∨ user prefers questions. **infer** if low impact ∨ safe fallback exists ∨ user prefers speed ∨ deferrable as a visible assumption. Every resolution is recorded with provenance in the context packet.

## 5. Creation & chain append

- **Planner-only creation** in v1 — agents propose, the system materializes.
- New node: within the active round (artifact gate if it has a parent), or a **new round after round N's `completed` event** (round gate).
- **Chain append:** a node/nodeGroup is appended to the chain based on previous rounds'/steps' artifacts (`requiredInputs` = previous artifacts). Parallel group = independent siblings in `00/` (prefix order). **Sibling-correction** for retries/amendments: same level, higher prefix — never nested children.
- A round completes only when all its tasks' goals are met + the round root's ACs verified → `completed` event → next round may spawn. **The advance decision comes from the look-back:** the round gate is validated from the log before the next round spawns — never assumed.
- **Closure-by-transfer (v3):** when the look-back shows **gate-unmet with identified remaining work**, a **HUMAN decision** (gated — never automatic) may close the round/task by:
  1. **Re-scoping the gate** — the round's ACs revise to what actually completed (an amendment record; node.json is immutable, so the revision is a decision artifact + event, e.g. "scope revised: the build transfers to R6").
  2. **Transferring the unmet ACs verbatim** — they become the next round/task's epic contract (inherited as its goal + `requiredInputs`), no loss, no assumption.
  3. **Closing** — the current node completes (`completed` + gate② confirm), then the next round spawns carrying the transferred goal.
  - The closure is a **gated human decision**, recorded honestly (a gate-revision event + the transfer); a round can never silently re-scope itself. Same mechanism at task level (a task whose scope shifts into another task/round).

## 6. Completion

- `done` ⇔ ACs verifiably met + evidence + artifact recorded + GATE② accepted.
- `failed`: bounded attempts exhausted or unrecoverable → preserved via events; sibling retry or escalate.
- `superseded`: annotates — never overrides a `completed`/`failed` status (format v2 §3).

## 7. Work-type flows — CONFIGURABLE step templates (requirements-spec AC-3)

- Flows are **configuration data, not code**: a project defines its step chain; the engine follows it. A default **product template** ships: **idea → validate → envision → detailed specs → continue**.
- Work types parameterize the common skeleton (materialize / missing-input / verify / chain effect):

| Work type | Materialize | Missing input | Verify | Chain effect |
|---|---|---|---|---|
| validate/grilling | batch-ask at end | **ask** (its job is questions) | artifact = validation + questions | specs spawn after |
| envision | vision questions; batch-ask | **ask** (what should it be / look like) | artifact = product vision (usage + look) | detailed specs spawn after |
| planning/expansion | derive → probe | infer only low-impact | ACs per branch | eager skeleton, lazy leaves |
| implementation | probe/derive aggressively | infer w/ fallback; ask high-impact | tests + evidence | commit → next frontmost |
| binding/external | confirm destructive | ask creds/params | provenance artifact (AC6) | result = artifact |
| review | probe evidence only | never infer; ask if ambiguous | verdict pass/confusion | confusion → re-plan |
| human-mode | human supplies | — | human-confirmed | — |

## 8. Complete-artifact rule

- A **superseding artifact is the complete merged version**, never a delta; deltas are side-notes. The current artifact is the full truth in one file (depth-policy = the violation example; format v2 = the model).

## 9. Non-goals (v1 flow)

- No cross-round parallelism · no DAG/join edges · no gate weakening · no autonomous subtree creation.

## 10. Evolution

- Immutable once locked. Amendments = **new nodes** whose artifacts **completely supersede** this spec (back-reference + `superseded` event).
