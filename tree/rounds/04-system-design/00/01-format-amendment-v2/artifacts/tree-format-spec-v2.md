<!-- specs:locked:a414a0b 2026-08-16 type=spec -->

## Link contract
- **upstream** (this doc relies on): tree/rounds/01-goal/artifacts/design.md,02-grilling/artifacts/ann-spec.md
- **referrers** (must cite this when they change): AGENTS.md,02-system-design-doc implementation slices

# Tree Format Spec v2 — rounds (table of epics)
*Artifact of task `04-system-design/00/01-format-amendment-v2`. Type: spec. Supersedes `tree-format-spec.md` v1 (locked @ ba528d1) and absorbs `depth-policy.md` (11c3de2) per §10 evolution. Upstream: `design` (locked @ eb07146), `02-grilling/artifacts/ann-spec.md` (locked @ 2664511).*

## 1. Layout — the table of rounds

- `tree/rounds/` is the **TABLE**: a chain of rounds — the project's forward progress. One store per project.
- **A round = one step of work = an epic.** Round dir = `<NN>-<name>/`, `NN` = round index (chain order). A round closes **only when its goal is met** (artifacts produced, ACs verified) → then the next round may begin. Rounds are sequential gates; done rounds never change.
- Round dir contains the **round root** (the epic: `node.json` · `events.jsonl` · `description.md` · `artifacts/`) plus **level dirs** (`00/`, `01/`, …) grouping nodes by depth inside the round:
  - `00/` = the round's **task group** — children of the epic, one subtree each. Tasks are **independent and may proceed in parallel**; dependent ordering uses the sort prefix / `order`.
  - deeper levels nest the same way (a task's sub-steps).
- **id = relative path from `tree/rounds/`** (`04-system-design/00/01-format-amendment-v2`). Parent = dirname · children = subdirectories · no `parentId`/`children` fields.
- **Round dependency:** each round's root `requiredInputs` names the previous round's artifact (R1 has none — it is the base step; every round after builds on it).
- Chain order = round index; a round's "goal met" = its epic ACs verified (all tasks' goals met + artifacts locked) → `completed` event → next round spawns.

## 2. node.json — immutable creation record

Schema unchanged from v1. `id` = path from `tree/rounds/`. Round root: `contract` = the epic (intent, `acceptanceCriteria` = the round gate, `requiredInputs` = previous round's artifact). Task node: `contract` = the task (intent, ACs, expected output artifact). `openQuestions` optional; `blocking: true` gates the node (and its round). `createdAt` required. **IMMUTABLE** — written once; strict schema; unknown fields rejected. Corrections = new nodes, never edits.

## 3. events.jsonl — append-only process log

Schema unchanged from v1. One JSON object per line: `{"at","type","note"}`. Types: `created · activated · extended · evidence · artifact-locked · completed · failed · superseded` (+ `spawned` with `parent`+`order` when a child task is created). **Status = tail mapping** (v1). **`superseded` ANNOTATES — never overrides a `completed`/`failed` status** (a completed round whose artifact is later superseded stays `done`; only a non-completed node derives `superseded`). A round's status is derived from its root: `queued` (created) · `active` (activated) · `done` (completed, gate met). **APPEND-ONLY** — no reorder, no rewrite, no deletion.

## 4. description.md — searchable card

Required per node (v1 conventions +): `parent round:` line (round index + id), `round goal met?` snapshot, `group position:` (order within `00/`), children pointers. Search terms line required. Live state always from `events.jsonl`.

## 5. artifacts/ — per-node outputs

v1 rules unchanged: outputs in the node's own `artifacts/`; artifact gate (children spawn only after `expectedOutputs` exist); artifacts immutable; supersession = new artifact + `superseded` event, never overwrite. **A superseding artifact is the COMPLETE merged version, never a delta** (flow-control §8) — deltas are side-notes; the current artifact is the full truth in one file. **Round artifacts = the round's gate evidence** (e.g., a locked spec).

## 6. Checkpoints & RPO

v1 rules unchanged: committed node = git commit incl. node files + artifacts; **RPO = 0** for committed nodes; checkpoint ref = git SHA. **Round completion is a checkpoint** — the chain is resumable at round granularity.

## 7. Engine ACs

- F-AC1..F-AC8 — v1 (strict validation, append-only enforcement, derived status, prefix order, grep-able cards, path-discoverable artifacts, no edit/re-parent API, lossless round-trip).
- F-AC9 — **round gate:** no node of round N+1 is created before round N's root has a `completed` event (goal met).
- F-AC10 — **parallel group:** independent siblings in `00/` may execute in parallel; the round completes only when all its tasks complete.
- F-AC11 — **sibling retry:** the engine can create a node as a sibling of a failed/superseded node (higher prefix, same level); frontmost-ready skips failed/superseded siblings regardless of prefix.
- F-AC12 — **pruning:** completed/superseded subtrees may be pruned from the working tree (git is the archive); a node referenced by any live node's `requiredInputs` must not be pruned (validation refuses). The tree stays valid after pruning.

## 8. Depth policy (absorbed from depth-policy.md, 11c3de2)

- **Depth expectation:** typical 3–6 levels; budget **≤ 8 levels and ≤ 260 chars full path** (Windows-compatible). Approaching the budget = rebalance signal.
- **Sibling-correction (main control):** repairs/retries/amendments are **siblings at the same level** with a higher prefix — never nested children. Failure never adds depth.
- **Pruning:** completed/superseded subtrees may be removed from the working tree; git is the archive and source of truth. Active tree = live frontier + recent/adjacent nodes.
- **Name discipline:** path segments ≤ 24 chars, kebab-case, no dates/versions in segment names (versions = round index / sibling prefix).
- **Pure decomposition still nests:** honest depth (a node whose contract genuinely decomposes) is bounded by the work itself, never by failure.

## 9. Edge cases

- First round (R1) has no input artifact — it is the base step.
- Round with no tasks: valid (root-only; its artifact = the goal's evidence).
- Single-task round: sequential by construction.
- Retry ordering: `01-attempt` (failed) + `02-retry` (active) → frontmost-ready = `02-retry` (`01` skipped). Correct.
- Prune of a referenced node → validation refuses, naming the referencing node.
- A pruned subtree re-hydrates from git; pruning is not deletion.
- Empty `note` valid; missing `description.md` invalid; unknown field/event type rejected.

## 10. Non-goals (v1)

- No DAG edge files / cross-task joins (deferred — spec §3; independence is the v1 default).
- No binary blobs in artifacts (text/structured only).
- No hot-migration of existing trees beyond this v2 migration.

## 11. Evolution — supersede, never edit

- This spec is immutable once locked. Amendments = **new nodes** (tasks) whose artifacts supersede it — back-reference + `superseded` event. Node structure updates are tasks, and tasks are nodes: the table cannot be reshaped by editing — only by growing.
