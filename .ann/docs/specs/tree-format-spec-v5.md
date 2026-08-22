<!-- specs:locked:20cd9cc 2026-08-17 type=spec -->

## Link contract
- **upstream** (this doc relies on): tree/rounds/01-goal/artifacts/design.md,02-grilling/01-spec-rework/artifacts/requirements-spec.md
- **referrers** (must cite this when they change): flow-control-spec,change-protocol ann-system-design,architecture AGENTS.md,implementation slices

# Tree Format Spec (v5)
*Artifact of task `05-engine/00/09-format-amendment-v4`. Type: spec. Complete superseding version — v3 (locked @ 012ca5f) + the store-review closures (file ownership & write timing · description.md frontmatter · drop `spawned` · append-order · logical-name `requiredInputs` · legacy-placement note · name discipline enforce-new). Produced per the change protocol: amendment node → complete artifact → superseded event. Upstream: `tree/rounds/01-goal/artifacts/design.md` (v3, locked), `02-grilling/01-spec-rework/artifacts/requirements-spec.md` (locked). Referrers: flow-control-spec · change-protocol · ann-system-design · architecture · AGENTS.md · implementation slices.*

## 1. Layout — the table of rounds

- `tree/rounds/` is the **TABLE**: a chain of rounds — the project's forward progress. One store per project. **Multi-user ready:** a shared store is a future deployment concern; events carry no single-machine assumptions — identity/permissions are future amendments, not blocked by this format (requirements-spec §7 A1).
- **A round = one step of work = an epic.** Round dir = `<NN>-<name>/`, `NN` = round index (chain order). A round closes **only when its goal is met** (artifacts produced, ACs verified) → then the next round may begin. Rounds are sequential gates; done rounds never change.
- Round dir contains the **round root** (`node.json` · `events.jsonl` · `description.md` · `artifacts/`) plus **level dirs** (`00/`, `01/`, …) grouping nodes by depth inside the round:
  - `00/` = the round's **task group** — children of the epic, one subtree each. Tasks are **independent and may proceed in parallel**; dependent ordering uses the sort prefix.
  - deeper levels nest the same way (a task's sub-steps).
- **Legacy note (v4):** rounds 2–3 historically placed tasks flat under the round dir (no `00/`). This is tolerated as legacy (no hot migration, §9/§10); **new tasks always use `00/`**; the validator accepts both shapes.
- **id = relative path from `tree/rounds/`** (`04-system-design/00/01-format-amendment-v2`). Parent = dirname · children = subdirectories · no `parentId`/`children` fields.
- **Round dependency:** each round's root `requiredInputs` names the previous round's artifact **by logical name** (new nodes; legacy nodes may hold historical paths — resolvable via forward pointers). R1 has none — it is the base step.
- Chain order = round index; a round's "goal met" = its epic ACs verified (all tasks' goals met + artifacts locked) → `completed` event → next round spawns.

## 2. node.json — immutable creation record (schema enumerated)

```json
{
  "id": "05-engine/00/01-flow-control",
  "contract": {
    "intent": "string",
    "acceptanceCriteria": ["string"],
    "targetAreas": ["string"],
    "requiredInputs": ["string — logical names for new nodes"],
    "expectedOutputs": ["string"]
  },
  "openQuestions": [
    {"id": "Q1", "question": "string", "blocking": true, "reason": "string",
     "defaultIfUnanswered": "string", "affectedTaskIds": ["string"]}
  ],
  "createdAt": "YYYY-MM-DD"
}
```

- `id` REQUIRED, equals the directory path from `tree/rounds/`. `contract.intent` REQUIRED. `contract.acceptanceCriteria` REQUIRED, non-empty. `targetAreas` / `requiredInputs` / `expectedOutputs` optional but SHOULD be present when known. `openQuestions` optional; `blocking: true` gates the node (and its round). `createdAt` REQUIRED.
- Round root: `contract` = the epic (goal, gate ACs, requiredInputs, round-level openQuestions). Task node: `contract` = the task (intent, ACs, expected output artifact).
- **IMMUTABLE** — written once at spawn; strict schema; unknown fields rejected. Corrections = new nodes, never edits.

## 3. events.jsonl — append-only process log

- One JSON object per line. Types: `created · activated · extended · evidence · artifact-locked · completed · failed · superseded · submitted · confirmed · rejected`. (v4: **`spawned` removed** — a child's `created` event IS the spawn record; children are structural via directories.)
- **Gate events (v5):**
  - `submitted` — node presented at a gate: `{"at","type":"submitted","gate":"grill|confirm","note":""}`.
  - `confirmed` — gate accepted: `{"at","type":"confirmed","gate":"grill|confirm","note":""}`.
  - `rejected` — gate rejected: `{"at","type":"rejected","gate":"grill|confirm","feedback":"…","note":""}` — rejection → bounded rework, same-gate return (flow-control §3).
  - **Gate flow:** `submitted(gate=grill)` → `confirmed`/`rejected(gate=grill)` before execution · `submitted(gate=confirm)` → `confirmed`/`rejected(gate=confirm)` before `completed`.
  - **Derivation:** a node with `submitted` but no `confirmed`/`rejected` at that gate = `blocked` (waiting on human) — a gate cannot be skipped silently.
  - **Completion rule:** `completed` may be written **only after** `confirmed (gate=confirm)` — validator-enforced (F-AC15).
- **Ordering (v4):** file order = **append order** — the only order. `at` is **informational** (`YYYY-MM-DD` for humans); never sort by `at`. Resolution and status derive from append order + the superseded mechanism, never from timestamps.
- **Structured event fields:**
  - `artifact-locked` carries the artifact's durable identity: `{"at","type":"artifact-locked","artifact":{"name":"requirements-spec","path":"…/requirements-spec.md","lockSha":"89ace76"},"note":""}`.
  - `superseded` carries the successor: `{"at","type":"superseded","successor":{"name":"requirements-spec","path":"…-v2.md"},"note":""}`.
  - Missing or unknown fields are **rejected** (strict schema — a fresh engine fails loudly, never silently).
- **Status = tail mapping.** **`superseded` ANNOTATES — never overrides a `completed`/`failed` status** (a completed round whose artifact is later superseded stays `done`; only a non-completed node derives `superseded`). `extended` / `evidence` annotate only; they do not change status.
- **APPEND-ONLY** — no reorder, no rewrite, no deletion.

## 4. File ownership & write timing (v4 — NEW)

| File | What it holds | When written |
|---|---|---|
| `node.json` | round root = epic contract; task = task contract | **once, at spawn** — never rewritten |
| `events.jsonl` | round root = **round lifecycle only** (`created`/`activated`/`extended`/`completed`/`failed`) · task = **task lifecycle** (`created`-as-spawn-record/`activated`/`evidence`/`artifact-locked`/`completed`/`failed`/`superseded`) | **appended only**; `artifact-locked` on the **producing node** (R1's root holds design's; tasks hold theirs). Round facts never leak into task events and vice versa — the path disambiguates |
| `description.md` | the **regenerable derived card** (frontmatter §6 + free-form body) | the **only rewritable file** — may be regenerated from events |
| `artifacts/` | node outputs | written when produced; immutable once recorded |

**Timing rules:** a round spawns only after the previous round's `completed` event (round gate) · a task spawns only after its parent's artifact exists (artifact gate) · `artifact-locked` is written the moment the artifact locks · appends happen at each lifecycle transition (activated, evidence, artifact-locked, completed, failed, superseded).

## 5. Logical names & resolution

- **Every artifact carries a logical name**, globally unique within the store (`requirements-spec`, `tree-format-spec`, `flow-control-spec`, `change-protocol`, …). **A superseding artifact reuses the name.**
- **The correct path is never stored as a live pointer.** Paths are *facts in events* (`artifact-locked` records name+path+sha; `superseded` records the successor). No mutable "current → path" mapping.
- **Resolution is derived at read time** — a pure function of the log: `current(name)` = the artifact of the `artifact-locked` event with that name whose producer is **not superseded**. "Latest" is guaranteed by the **one-current-per-name validator + superseded events**, never by timestamp comparison.
- **Durable references are logical names + stable section anchors** (`requirements-spec §5`), never paths. **Section anchors never renumber** across supersessions (new sections append; validator-enforced).
- **One current per name** — an artifact may lock only if no other non-superseded artifact shares its logical name (validator error otherwise).
- **Resolution verification (fail-closed):** file exists at the derived path · an `artifact-locked` event matches that exact path+name · no later `superseded` for it. Any mismatch = validation error, blocker named.
- **Forward pointers:** every `superseded` event names its successor; a historical direct-path reference follows the pointer — never a dead end.
- **Historical records may use paths/shas** (events, git, changelog notes); only durable references are logical names.

## 6. description.md — the AI-facing card (v4: frontmatter + body)

The card works like a skill's frontmatter: it gives an agent an instant "is this the node I need?" signal.

```yaml
---
name: flow-control              # logical name
type: task                      # round | task
round: 05-engine                # home round
status: done                    # DERIVED snapshot, never stored
summary: "One line — what this node is for"
find-me-when:
  - "how do steps run?"
  - "lifecycle / gates / rework"
---
# <NAME>
<free-form body: artifacts (by logical name + current path), children, pointers, notes>
```

- `status` is always the derived snapshot (from events), never stored truth.
- `find-me-when` mirrors skill trigger lists — an agent matches its goal against the forest's cards.
- The body is free-form; artifact lines use logical names + the derived current path.
- **Regenerable:** the store may rewrite `description.md` from events (the only rewritable file, §4).

## 7. Engine ACs

- F-AC1..F-AC13 — v3 (strict validation, append-only enforcement, derived status, prefix order, grep-able cards, path-discoverable artifacts, no edit/re-parent API, lossless round-trip, round gate, parallel group, sibling retry, pruning, resolution).
- **F-AC14 (v4):** events are ordered by append order, never by `at`; `spawned` is not an accepted type.
- **F-AC15 (v5) — gate invariants:** the validator flags every node whose `completed` lacks a later `confirmed (gate=confirm)` — deterministic, no model judgment. A `submitted` without a decision = `blocked`.

## 8. Depth policy (absorbed from depth-policy.md, 11c3de2)

- **Depth expectation:** typical 3–6 levels; budget **≤ 8 levels and ≤ 260 chars full path** (Windows-compatible). Approaching the budget = rebalance signal.
- **Sibling-correction (main control):** repairs/retries/amendments are **siblings at the same level** with a higher prefix — never nested children. Failure never adds depth.
- **Pruning:** completed/superseded subtrees may be removed from the working tree; git is the archive and source of truth. Active tree = live frontier + recent/adjacent nodes.
- **Name discipline:** path segments ≤ 24 chars, kebab-case, no dates/versions in segment names. **Enforced for NEW nodes** (v4); existing over-length names (`05-requirements-amendment`, `03-change-protocol-amendment`, `08-system-design-validation`) are historical — no hot migration.
- **Pure decomposition still nests:** honest depth (a node whose contract genuinely decomposes) is bounded by the work itself, never by failure.
- **Node count: no limit** (the format caps nothing; big-data query performance N/A for v1 — requirements-spec §7 A4).

## 9. Edge cases

- First round (R1) has no input artifact — it is the base step.
- Round with no tasks: valid (root-only; its artifact = the goal's evidence).
- Single-task round: sequential by construction.
- Retry ordering: `01-attempt` (failed) + `02-retry` (active) → frontmost-ready = `02-retry` (`01` skipped). Correct.
- Prune of a referenced node → validation refuses, naming the referencing node.
- A pruned subtree re-hydrates from git; pruning is not deletion.
- Supersession chain (v1 → v2 → v3): resolution follows the superseded events to the latest; every `superseded` event carries its successor.
- Direct path reference to a superseded artifact (historical body): resolver warns "superseded → current is X".
- Section renumbering in a superseding artifact: validator rejects.
- Two current artifacts sharing a logical name: validator rejects (one current per name).
- Two events on the same day for the same name: ordered by append position, never by `at`.
- Node `completed` without `confirmed (gate=confirm)`: validator flags (GATE GAP); the confirm must be recorded before completion is accepted.
- Legacy flat task placement (R2/R3): accepted by the validator (no hot migration).
- Empty `note` valid; missing `description.md` invalid; unknown field/event type rejected.

## 10. Non-goals (v1)

- No DAG edge files / cross-task joins (deferred — requirements-spec §3; independence is the v1 default).
- No binary blobs in artifacts (text/structured only).
- No live pointer maintenance — references are resolvable, not kept fresh.
- No hot-migration of existing trees (legacy shapes tolerated, never restructured).

## 11. Evolution — supersede, never edit

- This spec is immutable once locked. Amendments = **new nodes** (tasks) whose artifacts **completely supersede** it — reusing the logical name `tree-format-spec` and preserving section anchors — with a back-reference + `superseded` event. Node structure updates are tasks, and tasks are nodes: the table cannot be reshaped by editing — only by growing (change-protocol v2).
- This version (v5) was produced after the first real gate-confirmation action (17 nodes confirmed 2026-08-17) — the gates it specifies were exercised before they were locked.
