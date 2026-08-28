<!-- specs:locked:bee8e89 2026-08-19 type=spec -->

## Link contract
- **upstream** (this doc relies on): journey/legs/01-goal/artifacts/design.md,02-grilling/01-spec-rework/artifacts/requirements-spec.md,05-engine/00/17-format-amendment-v6/artifacts/tree-format-spec-v6.md
- **referrers** (must cite this when they change): flow-control-spec,change-protocol ann-system-design,architecture AGENTS.md,implementation slices

# Journey Format Spec (v7)
*Artifact of task `06-engine-build/00/01-format-amendment-v7`. Type: spec. Complete superseding version — v6 (locked @ 1a52771) + the derived-leg-status closures (leg roots carry no status/decision events · leg status derived from tasks · leg gate = aggregate check · closure-by-transfer recorded on a task). Produced per the change protocol: amendment node → complete artifact → superseded event. Upstream: `journey/legs/01-goal/artifacts/design.md` (v3, locked), `02-grilling/01-spec-rework/artifacts/requirements-spec.md` (locked), `journey-format-spec` (formerly `tree-format-spec`) v6 (locked). Referrers: flow-control-spec · change-protocol · ann-system-design · architecture · AGENTS.md · implementation slices.*

## 1. Layout — the table of legs

- `journey/legs/` is the **TABLE**: a chain of legs — the project's forward progress. One store per project. **Multi-user ready:** a shared store is a future deployment concern; events carry no single-machine assumptions — identity/permissions are future amendments, not blocked by this format (requirements-spec §7 A1).
- **A leg (formerly `round`) = one step of work = an epic.** Leg dir = `<NN>-<name>/`, `NN` = leg index (chain order). A leg closes **only when its goal is met** (artifacts produced, ACs verified) → then the next leg may begin. Legs are sequential gates; done legs never change.
- Leg dir contains the **leg root** (`node.json` · `description.md` · `artifacts/` — **no `events.jsonl`**: v7, §4) plus **level dirs** (`00/`, `01/`, …) grouping nodes by depth inside the leg:
  - `00/` = the leg's **task group** — children of the epic, one subtree each. Tasks are **independent and may proceed in parallel**; dependent ordering uses the sort prefix.
  - deeper levels nest the same way (a task's sub-steps).
- **Legacy note (v4):** legs 2–3 historically placed tasks flat under the leg dir (no `00/`). This is tolerated as legacy (no hot migration, §9/§10); **new tasks always use `00/`**; the validator accepts both shapes.
- **id = relative path from `journey/legs/`** (`04-system-design/00/01-format-amendment-v2`). Parent = dirname · children = subdirectories · no `parentId`/`children` fields.
- **Leg dependency:** each leg's root `requiredInputs` names the previous leg's artifact **by logical name** (new nodes; legacy nodes may hold historical paths — resolvable via forward pointers). L1 has none — it is the base step.
- Chain order = leg index; a leg's "goal met" = its epic ACs verified (all tasks' goals met + artifacts locked) → **leg status derives `done` from its tasks (§12)** → next leg spawns. **(v7: the leg root carries no events — completion is derived from tasks, never asserted.)**

## 2. node.json — immutable creation record (schema enumerated)

```json
{
  "id": "06-engine-build/00/01-format-amendment-v7",
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

- `id` REQUIRED, equals the directory path from `journey/legs/`. `contract.intent` REQUIRED. `contract.acceptanceCriteria` REQUIRED, non-empty. `targetAreas` / `requiredInputs` / `expectedOutputs` optional but SHOULD be present when known. `openQuestions` optional; `blocking: true` gates the node (and its leg). `createdAt` REQUIRED.
- Leg root: `contract` = the epic (goal, gate ACs, requiredInputs, leg-level openQuestions). Task node: `contract` = the task (intent, ACs, expected output artifact).
- **IMMUTABLE** — written once at spawn; strict schema; unknown fields rejected. Corrections = new nodes, never edits.

## 3. events.jsonl — append-only process log

- One JSON object per line. Types: `created · activated · extended · evidence · artifact-locked · completed · failed · superseded · submitted · confirmed · rejected`. (v4: **`spawned` removed** — a child's `created` event IS the spawn record; children are structural via directories.)
- **Closure events (v6) — the close-by-transfer record (flow-control v4):**
  - `gate-revised` — the gate re-scope: `{"at","type":"gate-revised","gate":{"old":"…","new":"…"},"note":""}`.
  - `transferred` — scope moved to a new task/leg: `{"at","type":"transferred","target":"06-engine-build","scope":"<the transferred ACs, verbatim>","note":""}`.
  - `deferred` — scope parked (no target yet): `{"at","type":"deferred","reason":"…","note":""}`.
  - **Closure rule (F-AC16):** a node whose `completed` follows a `gate-revised` must have a `transferred` or `deferred` event before completion; a `transferred` target must exist as a leg/task id. Closure is never prose-only.
  - **Closure lives on TASKS (v7):** `gate-revised` / `transferred` / `deferred` are recorded on the **closure task** — a sibling at the same level with a higher prefix (sibling-correction), or the task that surfaced the gate-unmet — never on the leg root (§12).
- **Gate events (v5):**
  - `submitted` — node presented at a gate: `{"at","type":"submitted","gate":"grill|confirm","note":""}`.
  - `confirmed` — gate accepted: `{"at","type":"confirmed","gate":"grill|confirm","note":""}`.
  - `rejected` — gate rejected: `{"at","type":"rejected","gate":"grill|confirm","feedback":"…","note":""}` — rejection → bounded rework, same-gate return (flow-control §3).
  - **Gate flow:** `submitted(gate=grill)` → `confirmed`/`rejected(gate=grill)` before execution · `submitted(gate=confirm)` → `confirmed`/`rejected(gate=confirm)` before `completed`.
  - **Derivation:** a node with `submitted` but no `confirmed`/`rejected` at that gate = `blocked` (waiting on human) — a gate cannot be skipped silently.
  - **Completion rule:** `completed` may be written **only after** `confirmed (gate=confirm)` — validator-enforced (F-AC15).
- **Leg-root discipline (v7):** the leg root carries **no events** — `events.jsonl` is absent (validators treat absent as empty). A leg's existence is structural (its directory + `node.json`); its activity is its tasks; its status is **derived from its tasks (§12)**, never asserted. `created`/`activated` were dropped in v7 — a directory that exists IS created, and unfinished tasks ARE active. Root events recorded before v7 (L1's design work, L5's closure record, L6's spawn record) stand as historical (§12 migration) — and are **inert: never read for state** (resolver derives leg status from tasks only; validators skip leg roots — F-AC17; read discipline §6).
- **Ordering (v4):** file order = **append order** — the only order. `at` is **informational** (`YYYY-MM-DD` for humans); never sort by `at`. Resolution and status derive from append order + the superseded mechanism, never from timestamps.
- **Structured event fields:**
  - `artifact-locked` carries the artifact's durable identity: `{"at","type":"artifact-locked","artifact":{"name":"requirements-spec","path":"…/requirements-spec.md","lockSha":"89ace76"},"note":""}`.
  - `superseded` carries the successor: `{"at","type":"superseded","successor":{"name":"requirements-spec","path":"…-v2.md"},"note":""}`.
  - Missing or unknown fields are **rejected** (strict schema — a fresh engine fails loudly, never silently).
- **Status = tail mapping (TASKS).** **`superseded` ANNOTATES — never overrides a `completed`/`failed` status** (a completed task whose artifact is later superseded stays `done`; only a non-completed node derives `superseded`). `extended` / `evidence` annotate only; they do not change status. **(v7: leg roots have no tail-mapped status — §12 derives it from tasks.)**
- **APPEND-ONLY** — no reorder, no rewrite, no deletion.

## 4. File ownership & write timing (v4 — NEW; v7 amended)

| File | What it holds | When written |
|---|---|---|
| `node.json` | leg root = epic contract; task = task contract | **once, at spawn** — never rewritten |
| `events.jsonl` | leg root = **— (absent — v7)** · task = **task lifecycle** (`created`-as-spawn-record/`activated`/`evidence`/`artifact-locked`/`completed`/`failed`/`superseded` + gates + closure events) | **appended only**; `artifact-locked` on the **producing node** (L1's root holds design's — grandfathered; tasks hold theirs). **(v7) The leg root carries no process log — all process/status events live on tasks; the leg root is structural (node.json + description.md + optional artifacts)** |
| `description.md` | the **regenerable derived card** (frontmatter §6 + free-form body) | the **only rewritable file** — may be regenerated from events |
| `artifacts/` | node outputs | written when produced; immutable once recorded |

**Timing rules:** a leg spawns only after **all previous-leg tasks are `done`** — the derived leg gate (§12), no `completed` event required · a task spawns only after its parent's artifact exists (artifact gate) · `artifact-locked` is written the moment the artifact locks · appends happen at each lifecycle transition (activated, evidence, artifact-locked, completed, failed, superseded).

## 5. Logical names & resolution

- **Every artifact carries a logical name**, globally unique within the store (`requirements-spec`, `journey-format-spec`, `flow-control-spec`, `change-protocol`, …). **A superseding artifact reuses the name.**
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
type: task                      # leg | task
leg: 05-engine                # home leg
status: done                    # DERIVED snapshot, never stored
summary: "One line — what this node is for"
find-me-when:
  - "how do steps run?"
  - "lifecycle / gates / rework"
---
# <NAME>
<free-form body: artifacts (by logical name + current path), children, pointers, notes>
```

- `status` is always the derived snapshot (from events — for a leg, from its tasks, §12), never stored truth.
- `find-me-when` mirrors skill trigger lists — an agent matches its goal against the forest's cards.
- The body is free-form; artifact lines use logical names + the derived current path.
- **Regenerable:** the store may rewrite `description.md` from events (the only rewritable file, §4).
- **Read discipline (v7):** agents **never read `events.jsonl` directly** — state is understood through the derived commands (`--journey` · `--status` · `--check` · `--specs` · `--branch`). `events.jsonl` is a **machine-parse-only log**; a raw read can surface stale or legacy facts (pre-v7 leg-root events) that the derived state ignores by construction. The card + the scripts are the interface; the log is not.

## 7. Engine ACs

- F-AC1..F-AC13 — v3 (strict validation, append-only enforcement, derived status, prefix order, grep-able cards, path-discoverable artifacts, no edit/re-parent API, lossless round-trip, leg gate, parallel group, sibling retry, pruning, resolution).
- **F-AC14 (v4):** events are ordered by append order, never by `at`; `spawned` is not an accepted type.
- **F-AC15 (v5) — gate invariants:** the validator flags every node whose `completed` lacks a later `confirmed (gate=confirm)` — deterministic, no model judgment. A `submitted` without a decision = `blocked`.
- **F-AC16 (v6) — closure invariants:** completed-after-`gate-revised` requires `transferred` or `deferred`; `transferred` targets must exist; closure is never prose-only.
- **F-AC17 (v7) — leg-status invariants:** the validator derives leg status from children: all tasks `done` → leg `done`; else the leg's status = the frontmost-ready child's; no tasks → `queued` (a leg without tasks can never be `done`). A leg root carrying ANY event (new legs; pre-v7 roots grandfathered, §12) = validator error. **Gate/closure rules (F-AC15/16) apply to TASKS only — leg roots are skipped**, so legacy root events can never trip or contradict gate checks.

## 8. Depth policy (absorbed from depth-policy.md, 11c3de2)

- **Depth expectation:** typical 3–6 levels; budget **≤ 8 levels and ≤ 260 chars full path** (Windows-compatible). Approaching the budget = rebalance signal.
- **Sibling-correction (main control):** repairs/retries/amendments are **siblings at the same level** with a higher prefix — never nested children. Failure never adds depth. **The closure task is a sibling too (v7).**
- **Pruning:** completed/superseded subtrees may be removed from the working tree; git is the archive and source of truth. Active tree = live frontier + recent/adjacent nodes.
- **Name discipline:** path segments ≤ 24 chars, kebab-case, no dates/versions in segment names. **Enforced for NEW nodes** (v4); existing over-length names (`05-requirements-amendment`, `03-change-protocol-amendment`, `08-system-design-validation`) are historical — no hot migration.
- **Pure decomposition still nests:** honest depth (a node whose contract genuinely decomposes) is bounded by the work itself, never by failure.
- **Node count: no limit** (the format caps nothing; big-data query performance N/A for v1 — requirements-spec §7 A4).

## 9. Edge cases

- First leg (L1) has no input artifact — it is the base step.
- Leg with no tasks: **`queued` and can never derive `done`** — nothing worked (v7). L1's root-level design work predates the task-group model (its artifact lives on the root) and is grandfathered (§12).**
- Single-task leg: sequential by construction; leg `done` derives when the single task is `done`.
- Retry ordering: `01-attempt` (failed) + `02-retry` (active) → frontmost-ready = `02-retry` (`01` skipped). Correct. The leg's derived status follows the frontmost-ready child (§12), so an active retry keeps the leg `active`, not `failed`.
- Prune of a referenced node → validation refuses, naming the referencing node.
- A pruned subtree re-hydrates from git; pruning is not deletion.
- Supersession chain (v1 → v2 → v3): resolution follows the superseded events to the latest; every `superseded` event carries its successor.
- Direct path reference to a superseded artifact (historical body): resolver warns "superseded → current is X".
- Section renumbering in a superseding artifact: validator rejects.
- Two current artifacts sharing a logical name: validator rejects (one current per name).
- Two events on the same day for the same name: ordered by append position, never by `at`.
- Node `completed` without `confirmed (gate=confirm)`: validator flags (GATE GAP); the confirm must be recorded before completion is accepted.
- **Leg root with status-bearing events (v7): validator error on new legs; L5's v6-era record grandfathered (§12).**
- Legacy flat task placement (L2/L3): accepted by the validator (no hot migration).
- Empty `note` valid; missing `description.md` invalid; unknown field/event type rejected.

## 10. Non-goals (v1)

- No DAG edge files / cross-task joins (deferred — requirements-spec §3; independence is the v1 default).
- No binary blobs in artifacts (text/structured only).
- No live pointer maintenance — references are resolvable, not kept fresh.
- No hot-migration of existing trees (legacy shapes tolerated, never restructured).

## 11. Evolution — supersede, never edit

- This spec is immutable once locked. Amendments = **new nodes** (tasks) whose artifacts **completely supersede** it — reusing the logical name `journey-format-spec` and preserving section anchors — with a back-reference + `superseded` event. Node structure updates are tasks, and tasks are nodes: the table cannot be reshaped by editing — only by growing (change-protocol v2).
- This version (v7) was produced after the L5 incident: the leg root asserted `done` + "all gates confirmed" while tasks 16/17 held no confirmations — a contradiction only a validator could have caught. v7 makes the contradiction **impossible by construction**: leg status derives from tasks, so a leg can never claim what its tasks don't substantiate.

## 12. Derived leg status (v7 — NEW)

**The model.** A leg is a **container of tasks**; the leg root is structural, not procedural. All process facts — work, gates, decisions, closures — live on tasks. A leg's status is therefore a **pure function of its tasks' statuses**, computed at read time:

| Children | Leg status |
|---|---|
| all `done` (or `superseded`-annotated `done`) | **done** |
| no children (nothing spawned) | own lifecycle from root events — grandfathered childless legs only (L1, the base step); new legs carry no root events → **queued**, never `done` |
| frontmost-ready child exists (lowest prefix among not-done, not-failed, not-superseded) | that child's status (`queued` / `active` / `blocked`) |
| all remaining children `failed`/`superseded` (no frontmost-ready) | **blocked** — escalate: retry / transfer / close (flow-control §5) |

- **Frontmost-ready** is the engine's existing activate rule (flow-control §2a): prefix orders candidates; failed/superseded siblings skipped. Reusing it keeps one selection concept for tasks and legs.
- **No leg-root log.** The leg gate for spawning leg N+1 is the derived check: *all of leg N's tasks are `done`* (validated from the logs — flow-control v4 §2/§5). The look-back derives it; nothing asserts it. `created`/`activated` were dropped with the rest — a leg's existence is its directory, its activity is its tasks.
- **Closure-by-transfer on a task.** When the look-back shows gate-unmet with remaining work, the closure is executed as a **closure task** — a sibling at the same level with a higher prefix (sibling-correction, §8) — or by the task that surfaced the gate-unmet. The closure task records `gate-revised` + `transferred`/`deferred` (§3) and completes through its own GATE①/GATE② (flow-control v4 §5). The leg derives `done` when all its tasks — including the closure task — are done; the next leg spawns carrying the transferred goal (its `node.json` states the inherited contract, as L6's does).
- **Why.** Under v6 the leg root could assert `completed` while its tasks disagreed — a dual source of truth with no validator between them (the L5 incident, §11). Derivation removes the second source entirely: a contradiction becomes inexpressible instead of checkable.
- **Migration (grandfathering).** Legs recorded before v7 locked keep their root events as recorded — no hot migration, no history rewrite (append-only, §3): L1's root-level design work, L5's v6-era closure record (`completed`/`confirmed`/`submitted`/`gate-revised`/`transferred`), L6's `created` spawn record. Legs spawned under v7 (L7 onward) carry no root events; the validator enforces.
  - **Inertness guarantee:** grandfathered root events are **never read for state** — the resolver derives leg status from the §12 table, ignoring leg-root events; the validators skip leg roots for gate rules (F-AC17). They are history only, surfaced via the raw `--branch` walk; nothing derives from them, so they cannot mislead (read discipline §6).
