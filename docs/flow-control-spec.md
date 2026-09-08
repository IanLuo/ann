## Link contract
- **upstream** (this doc relies on): journey/legs/01-goal/artifacts/design.md,02-grilling/01-spec-rework/artifacts/requirements-spec.md,journey-format-spec v10
- **referrers** (must cite this when they change): S5 planner kernel,implementation slices review-task

# Flow Control Spec (v7)
*Artifact of task `06-operator-loop/01-spec-amend-f5-execute`. Type: spec. Complete superseding version — v6 (locked @ d9b25f7) + F5's accept half lands: §2 names the OPERATOR ACTION `advance!` (deterministic approve→execute — integrity re-check fail-closed · advance re-derived from the logs · execution only through the sanctioned writers, no LLM discretion · land at the next human gate, never silently past one) and §5 RESOLVES the advance-leg contract-source question (an advance selects among ALREADY-AUTHORED tasks; an empty front leg is the authored-work boundary — a stop, never a machine spawn). Amended in place per the docs convention (the old version stays in git history); upstream/referrer conventions preserved. Upstream: `journey/legs/01-goal/artifacts/design.md` (v3, locked), `02-grilling/01-spec-rework/artifacts/requirements-spec.md` (locked), `journey-format-spec` v10 (locked). Referrers: S5 planner kernel, implementation slices, review-task.*

## 1. Scope

- The **workflow semantics** of the engine: node lifecycle, creation, completion, chain append, human gates, input-resolution ladder, **configurable work-type flows** (step chains are project data — requirements-spec AC-3). Common structure × per-type variation (design v3 §2/§4).

## 2. Node lifecycle (common skeleton)

```
 spawn → materialize → [GATE① grilling] → validate → activate → execute → verify → [GATE② confirm]
   → commit → LOOK-BACK (journey review) → determine next (grounded) → propose / advance
```

- **States:** `queued · active · blocked (incl. waiting on human gate) · done · failed · superseded` (derived from events, format v2 §3). **(v4) Legs have the same states — derived from their tasks (format v7 §12); leg roots carry no events.**
- **materialize:** assemble the context packet (path decisions · node contract · resolved inputs · sibling status · binding state · open questions with provenance); run the resolution ladder (§4) for missing inputs.
- **validate:** deterministic — schema, artifact gate, leg gate, ACs declared, inputs resolved, distance-to-goal as a set.
- **activate:** frontmost-ready selection — the **OUTPUT of the look-back** (§2a): prefix orders candidates; readiness is gate-validated from the log; failed/superseded siblings skipped. Never assumed. **(v4) The same rule derives a leg's status (§2, format v7 §12).**
- **LOOK-BACK (v2, after commit — the observer action):** when a task completes, the engine briefly reviews the journey — statuses, gates, artifacts, leg state — all **derived from the events** **(v4: leg state derives from its tasks — format v7 §12; leg-root events are inert and never read)**, and determines: **where we are** (current position, completed work, pending gates) and **what's ahead** (frontmost-ready task, remaining leg work, next leg after the leg gate). The next-task proposal is **grounded in that review, never assumed**. This powers F5 `run next` (functional-spec). Pre-engine implementation: `scripts/resolve.mjs --journey`.
- **(v7) THE OPERATOR ACTION `advance!` — F5's accept half (functional-spec v2 F5; named before it exists on `06-operator-loop/01-spec-amend-f5-execute`):** the look-back's proposal (`next`, a read) has no approve→execute counterpart in the surface, so after a human gate nothing advances — every spawn this session was hand-authored (the operator-loop gap). `advance!` is the deterministic approve→execute gesture: ONE interaction that executes the DERIVED advance on the builder's approval, under four rules:
  1. **Integrity re-check, fail closed.** The action begins by re-running the integrity reads (the check/verify equivalents); any dirty state — store drift, uncommitted tracked journey or docs changes, a gate gap, a stale manifest — REFUSES the advance and reports. The journey never advances on a state the engine does not recognize.
  2. **The advance is re-derived at execution, never replayed.** The proposal is a point-in-time derivation; `advance!` re-derives continue-leg/advance-leg/closure-needed/none from the logs at execution and REFUSES when the re-derivation no longer matches — a stale proposal executes nothing.
  3. **Executed only through the sanctioned writers** (`spawn!`/`submit!`/`gate!`/`run!`) — deterministic scripted orchestration of the L1 mutators, never an LLM judgment and never a new write path. The content boundary holds: the action authors no contract, answers no gate, self-closes nothing (AGENTS.md write-confinement names it before it exists).
  4. **Land at the next human gate, never silently past one.** After execution the journey is AT the next human decision and stops: the advanced task's gate① card, a run's gate② card, or the boundary/closure card below. `advance!` never decides a gate — the approve is the builder's single decision over the ADVANCE card (an F7-shaped interaction), and every task gate stays a human `gate!`.
  Per derivation, what "execute" means: **continue-leg** (a ready authored task) → run the frontmost-ready through the frame (`run!`) and land at its next gate. **advance-leg** (an empty front leg whose predecessor is done) → NOT machine-executable: the authored-work boundary (§5) — present and stop. **closure-needed** → NOT machine-executable: the gated closure decision (§5, F-AC16) — present the closure card and stop. **none** → NOT machine-executable: present the four-state goal consult (goal-session-design §5) — `goal! met`/`goal! archive` stay human moves.
- **execute:** mode `agent` (v1 primary) · `human` · `automated`.
- **verify:** ACs met + evidence.
- **commit:** checkpoint (git), **artifact recorded** — the task's conclusion per journey-format-spec v10 §14 (a locked document, or **structured commit evidence** in an `evidence` event: `commits[]` + `refs[]`; every task concludes). Gates enforced: **leg gate** (leg N+1 only after all of leg N's tasks are `done` — the derived aggregate, format v7 §12), **artifact gate** (children only after the node's artifact exists — satisfied by a locked artifact **or** commit evidence), **completion** (ACs + evidence + GATE② accepted).

## 3. Human gates (structural — every step stops and waits)

- **GATE① grilling (entry):** human validates understanding/approach before execution. Presents: step card (intent, ACs, packet summary, artifacts). Collects: `accept` | `reject + feedback`.
- **GATE② confirm-result (exit):** human confirms the output before commit. Presents: artifacts + evidence. Collects: `accept` | `reject + feedback`.
- Both gates are **HARD on every node in v1**; work-type weakening = v2 plugin concern (design v3 §10). **(v4) Gates live on TASKS. Leg roots carry no gates and no events (format v7 §3/§12) — the epic's gates are its tasks' gates; every human decision, including a closure (§5), is made at a task gate.**
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

## 5. Creation, advance & closure

- **Planner-only creation** in v1 — agents propose, the system materializes.
- New node: within the active leg (artifact gate if it has a parent), or a **new leg after the derived leg gate** (all previous-leg tasks `done` — format v7 §12).
- **Chain append:** a node/nodeGroup is appended to the chain based on previous legs'/steps' artifacts (`requiredInputs` = previous artifacts). Parallel group = independent siblings in `00/` (prefix order). **Sibling-correction** for retries/amendments: same level, higher prefix — never nested children.
- A leg is `done` **only when all its tasks are done** — **derived from the task logs** (format v7 §12); the leg root writes no events at all. **The advance decision comes from the look-back:** the leg gate is validated from the logs before the next leg spawns — never assumed.
- **(v7) The advance-leg CONTRACT SOURCE — resolved:** `advance-leg` fires exactly when the derived advance points at an EMPTY front leg (no pre-spawned tasks) whose predecessor is fully done. Task contracts are AUTHORED content — `spawn!` takes an authored contract, and the engine derives order/readiness/gates (the look-back, `next`), never content (the content/scripts boundary — AGENTS.md). There is therefore **no deterministic engine source for the next task's contract**: an advance selects among ALREADY-AUTHORED tasks only, and `advance-leg` on an empty front leg is the **authored-work boundary** — the operator action (§2) stops there and presents it. The next task's contract comes from the SAME authoring act that spawned every leg: a human or agent authors it — grounded on the front leg's epic contract + the look-back + the completed predecessor's artifacts — and lands it as a push (functional-spec v2 F6, `spawn!`); `advance!` then re-derives **continue-leg** and runs it. In the WELL-FORMED flow a leg is spawned with its task skeleton (a parallel group), so crossing a leg boundary is a `continue-leg` on the pre-spawned frontmost-ready — and `advance-leg`-as-empty-shell is the honest signal that authoring is the missing next action: a STOP, never a machine spawn, never hand-waved. (Auto-DRAFTING a task contract from a leg's epic for the builder to approve is LLM-surface work — deferred with the operator action's implementation, never an L1/engine derivation.)
- **Closure-by-transfer (v3 mechanism, v4 recording):** when the look-back shows **gate-unmet with identified remaining work**, a **HUMAN decision** (gated — never automatic) may close the leg/task by executing a **closure task**:
  1. **The closure task spawns as a sibling** — same level, higher prefix (sibling-correction) — or the task that surfaced the gate-unmet carries the closure in its own completion.
  2. **Re-scoping the gate** — the leg's ACs revise to what actually completed; recorded **on the closure task** as a `gate-revised` event + amendment record (node.json is immutable; the revision is a decision artifact + event, e.g. "scope revised: the build transfers to L6").
  3. **Transferring the unmet ACs verbatim** — `transferred {target, scope verbatim}`; they become the next leg/task's epic contract (inherited as its goal + `requiredInputs`), no loss, no assumption.
  4. **Closing** — the closure task completes **through its own GATE①/GATE②** (grill: is this closure right? confirm: is the record correct?), then the next leg spawns carrying the transferred goal.
  - The closure is a **gated human decision recorded on a task**, never a leg-root event (format v7 §3/§12); a leg can never silently re-scope itself. Same mechanism at task level (a task whose scope shifts into another task/leg). L5's v3-era leg-root closure record is grandfathered (format v7 §12).

## 6. Completion

- `done` ⇔ ACs verifiably met + evidence + **artifact recorded** + GATE② accepted. **(v6) "artifact recorded" is universally satisfiable** — a task concludes with a **locked document** (spec/design/architecture/task-local doc) **or structured commit evidence** (an `evidence` event with non-empty `commits[]` — journey-format-spec v10 §3/§14); a task that produced nothing records its reason. The record doc (v9) is deprecated.
- `failed`: bounded attempts exhausted or unrecoverable → preserved via events; sibling retry or escalate.
- `superseded`: annotates — never overrides a `completed`/`failed` status (format v2 §3).
- **(v4) Leg `done` ⇔ every task `done` — derived (format v7 §12). A leg never writes its own `done`; its tasks substantiate it.**

## 7. Work-type flows — CONFIGURABLE step templates (requirements-spec AC-3)

- Flows are **configuration data, not code**: a project defines its step chain; the engine follows it. A default **product template** ships: **idea → validate → envision → detailed specs → continue**.
- Work types parameterize the common skeleton (materialize / missing-input / verify / chain effect). **(v6) The artifact column is guidance, not a constraint — a task produces whatever it produces (journey-format-spec v10 §14); every task concludes with a locked doc or structured commit evidence.**

| Work type | Materialize | Missing input | Verify | Chain effect |
|---|---|---|---|---|
| validate/grilling | batch-ask at end | **ask** (its job is questions) | artifact = validation + questions | specs spawn after |
| envision | vision questions; batch-ask | **ask** (what should it be / look like) | artifact = product vision (usage + look) | detailed specs spawn after |
| planning/expansion | derive → probe | infer only low-impact | ACs per branch | eager skeleton, lazy leaves |
| implementation | probe/derive aggressively | infer w/ fallback; ask high-impact | tests + evidence; **artifact = structured commit evidence (evidence.commits[] + refs[]; presupposition: task code is well-committed and described)** | commit → next frontmost |
| binding/external | confirm destructive | ask creds/params | provenance artifact (AC6) | result = artifact |
| review | probe evidence only | never infer; ask if ambiguous | verdict pass/confusion | confusion → re-plan |
| human-mode | human supplies | — | human-confirmed | — |
| **closure (v4)** | derive from look-back | **ask** (the closure decision) | gate-revised + transferred/deferred recorded, F-AC16 | leg derives done → next spawns |

## 8. Complete-artifact rule

- A **superseding artifact is the complete merged version**, never a delta; deltas are side-notes. The current artifact is the full truth in one file (depth-policy = the violation example; format v2 = the model).

## 9. Non-goals (v1 flow)

- No cross-leg parallelism · no DAG/join edges · no gate weakening · no autonomous subtree creation.

## 10. Evolution

- Immutable once locked. Amendments = **new nodes** whose artifacts **completely supersede** this spec (back-reference + `superseded` event). v5 resolved the v4 §6/§7 contradiction via the record doc; v6 aligns with journey-format-spec v10 — the implementation artifact is **structured commit evidence in events** (machine-readable, never prose-parsed), and the record doc is deprecated (task 05's `s2-record` grandfathered). v7 names F5's accept half — the operator action `advance!` (§2) — and resolves the advance-leg contract source (§5), amended in place per the docs convention (git holds the old version; recorded on 06-operator-loop/01-spec-amend-f5-execute).
