<!-- specs:locked:012ca5f 2026-08-16 type=spec -->

## Link contract
- **upstream** (this doc relies on): tree/rounds/01-goal/artifacts/design.md,02-grilling/01-spec-rework/artifacts/requirements-spec.md
- **referrers** (must cite this when they change): flow-control-spec,change-protocol ann-system-design,AGENTS.md implementation slices

# Tree Format Spec (v3)
*Artifact of task `05-engine/00/04-format-amendment-v3`. Type: spec. Complete superseding version — v2 (locked @ 257cb79) + **the resolution mechanism** (structured event schema + derived logical-name resolution; change-protocol v2 §2). Produced per the change protocol: amendment node → complete artifact → superseded event. Upstream: `tree/rounds/01-goal/artifacts/design.md` (v3, locked), `02-grilling/01-spec-rework/artifacts/requirements-spec.md` (locked). Referrers: flow-control-spec · change-protocol · ann-system-design · AGENTS.md · implementation slices.*

## 1. Layout — the table of rounds

- `tree/rounds/` is the **TABLE**: a chain of rounds — the project's forward progress. One store per project. **Multi-user ready:** a shared store is a future deployment concern; events carry no single-machine assumptions — identity/permissions are future amendments, not blocked by this format (requirements-spec §7 A1).
- **A round = one step of work = an epic.** Round dir = `<NN>-<name>/`, `NN` = round index (chain order). A round closes **only when its goal is met** (artifacts produced, ACs verified) → then the next round may begin. Rounds are sequential gates; done rounds never change.
- Round dir contains the **round root** (the epic: `node.json` · `events.jsonl` · `description.md` · `artifacts/`) plus **level dirs** (`00/`, `01/`, …) grouping nodes by depth inside the round:
  - `00/` = the round's **task group** — children of the epic, one subtree each. Tasks are **independent and may proceed in parallel**; dependent ordering uses the sort prefix / `order`.
  - deeper levels nest the same way (a task's sub-steps).
- **id = relative path from `tree/rounds/`** (`04-system-design/00/01-format-amendment-v2`). Parent = dirname · children = subdirectories · no `parentId`/`children` fields.
- **Round dependency:** each round's root `requiredInputs` names the previous round's artifact by **logical name** (R1 has none — it is the base step; every round after builds on it).
- Chain order = round index; a round's "goal met" = its epic ACs verified (all tasks' goals met + artifacts locked) → `completed` event → next round spawns.

## 2. node.json — immutable creation record

Schema unchanged from v2. `id` = path from `tree/rounds/`. Round root: `contract` = the epic (intent, `acceptanceCriteria` = the round gate, `requiredInputs` = previous round's artifact **by logical name**). Task node: `contract` = the task (intent, ACs, expected output artifact). `openQuestions` optional; `blocking: true` gates the node (and its round). `createdAt` required. **IMMUTABLE** — written once; strict schema; unknown fields rejected. Corrections = new nodes, never edits.

## 3. events.jsonl — append-only process log (with the resolution schema)

- One JSON object per line. Types: `created · activated · extended · evidence · artifact-locked · completed · failed · superseded` (+ `spawned` with `parent`+`order` when a child task is created).
- **Structured event fields (v3):**
  - `artifact-locked` events carry the artifact's durable identity:
    ```json
    {"at":"YYYY-MM-DD","type":"artifact-locked","artifact":{"name":"requirements-spec","path":"02-grilling/01-spec-rework/artifacts/requirements-spec.md","lockSha":"89ace76"},"note":"..."}
    ```
  - `superseded` events carry the successor:
    ```json
    {"at":"YYYY-MM-DD","type":"superseded","successor":{"name":"requirements-spec","path":".../requirements-spec-v2.md"},"note":"..."}
    ```
  - Missing or unknown fields are **rejected** (strict schema — a fresh engine fails loudly, never silently).
- **Status = tail mapping** (v2). **`superseded` ANNOTATES — never overrides a `completed`/`failed` status** (a completed round whose artifact is later superseded stays `done`; only a non-completed node derives `superseded`). A round's status is derived from its root: `queued` (created) · `active` (activated) · `done` (completed, gate met). `extended` / `evidence` annotate only; they do not change status.
- **APPEND-ONLY** — no reorder, no rewrite, no deletion.

## 4. Logical names & resolution (v3 — the reference mechanism)

- **Every artifact carries a logical name**, globally unique within the store (`requirements-spec`, `tree-format-spec`, `flow-control-spec`, `change-protocol`, …). **A superseding artifact reuses the name.**
- **The correct path is never stored as a live pointer.** Paths are *facts in events* (`artifact-locked` records name+path+sha; `superseded` records the successor). There is no mutable "current → path" mapping to keep in sync.
- **Resolution is derived at read time** — a pure function of the log:
  `current(name)` = the artifact of the **latest `artifact-locked` event** with that name whose producer is **not superseded**.
- **Durable references are logical names + stable section anchors** (`requirements-spec §5`), never paths — resolvable forever, whatever version is current. **Section anchors never renumber** across supersessions (new sections append; validator-enforced).
- **One current per name** — an artifact may lock only if no other non-superseded artifact shares its logical name (validator error otherwise).
- **Resolution verification (fail-closed):** at resolve time the engine checks — file exists at the derived path · an `artifact-locked` event matches that exact path+name · no later `superseded` for it. Any mismatch = validation error, blocker named.
- **Forward pointers:** every `superseded` event names its successor; a reader hitting a historical direct-path reference to a superseded artifact follows the pointer and gets "superseded → current is X" — never a dead end.
- **Historical records may use paths/shas** (events, git, changelog notes); only durable references are logical names.

## 5. description.md — searchable card

Required per node (v2 conventions +): `parent round:` line (round index + id), `round goal met?` snapshot, `group position:` (order within `00/`), children pointers, artifact lines by **logical name + current path (derived view)**. Search terms line required. Live state always from `events.jsonl`.

## 6. artifacts/ — per-node outputs

v2 rules unchanged: outputs in the node's own `artifacts/`; artifact gate (children spawn only after `expectedOutputs` exist); artifacts immutable; supersession = new artifact + `superseded` event, never overwrite. **A superseding artifact is the COMPLETE merged version, never a delta** (change-protocol) — deltas are side-notes; the current artifact is the full truth in one file. **Round artifacts = the round's gate evidence** (e.g., a locked spec). Artifacts are referenced by logical name; the derived pointer view maps names to current paths for discovery.

## 7. Engine ACs

- F-AC1..F-AC12 — v2 (strict validation, append-only enforcement, derived status, prefix order, grep-able cards, path-discoverable artifacts, no edit/re-parent API, lossless round-trip, round gate, parallel group, sibling retry, pruning).
- **F-AC13 — resolution:** the resolver returns the correct current artifact for any logical name (latest non-superseded, verified against the log + disk); a wrong/missing resolution is a validation error, never a silent fallback.

## 8. Depth policy (absorbed from depth-policy.md, 11c3de2)

- **Depth expectation:** typical 3–6 levels; budget **≤ 8 levels and ≤ 260 chars full path** (Windows-compatible). Approaching the budget = rebalance signal.
- **Sibling-correction (main control):** repairs/retries/amendments are **siblings at the same level** with a higher prefix — never nested children. Failure never adds depth.
- **Pruning:** completed/superseded subtrees may be removed from the working tree; git is the archive and source of truth. Active tree = live frontier + recent/adjacent nodes.
- **Name discipline:** path segments ≤ 24 chars, kebab-case, no dates/versions in segment names (versions = round index / sibling prefix).
- **Pure decomposition still nests:** honest depth (a node whose contract genuinely decomposes) is bounded by the work itself, never by failure.
- **Node count: no limit** (the format caps nothing; big-data query performance N/A for v1 — requirements-spec §7 A4).

## 9. Edge cases

- First round (R1) has no input artifact — it is the base step.
- Round with no tasks: valid (root-only; its artifact = the goal's evidence).
- Single-task round: sequential by construction.
- Retry ordering: `01-attempt` (failed) + `02-retry` (active) → frontmost-ready = `02-retry` (`01` skipped). Correct.
- Prune of a referenced node → validation refuses, naming the referencing node.
- A pruned subtree re-hydrates from git; pruning is not deletion.
- **Supersession chain (v1 → v2 → v3):** resolution follows events to the latest; every superseded event carries its successor.
- **Direct path reference to a superseded artifact (historical body):** resolver warns "superseded → current is X".
- **Section renumbering in a superseding artifact:** validator rejects.
- **Two current artifacts sharing a logical name:** validator rejects (one current per name).
- Empty `note` valid; missing `description.md` invalid; unknown field/event type rejected.

## 10. Non-goals (v1)

- No DAG edge files / cross-task joins (deferred — requirements-spec §3; independence is the v1 default).
- No binary blobs in artifacts (text/structured only).
- No live pointer maintenance — references are resolvable, not kept fresh.
- No hot-migration of existing trees beyond this v3 amendment.

## 11. Evolution — supersede, never edit

- This spec is immutable once locked. Amendments = **new nodes** (tasks) whose artifacts **completely supersede** it — reusing the logical name `tree-format-spec` and preserving section anchors — with a back-reference + `superseded` event. Node structure updates are tasks, and tasks are nodes: the table cannot be reshaped by editing — only by growing (change-protocol v2).
