<!-- specs:locked:3c04f99 2026-08-22 type=spec -->

## Link contract
- **upstream** (this doc relies on): journey/legs/01-goal/artifacts/design.md,02-grilling/01-spec-rework/artifacts/requirements-spec.md,05-engine/17-format-amendment-v6/artifacts/tree-format-spec-v6.md
- **referrers** (must cite this when they change): flow-control-spec,change-protocol ann-system-design,architecture AGENTS.md,implementation slices

# Journey Format Spec (v9)
*Artifact of task `06-engine-build/13-format-amendment-v9`. Type: spec. Complete superseding version — v8 (locked @ 6fe3c1e) + the artifact model (an artifact = a file ref into the project or an external link + commit clues + a conclusion; content files move to `docs/` categorized by type; code tasks produce a commit-record doc; every task concludes with an artifact; future tasks gate on traceable commit clues). Produced per the change protocol: amendment node → complete artifact → superseded event. Upstream: `journey/legs/01-goal/artifacts/design.md` (v3, locked), `02-grilling/01-spec-rework/artifacts/requirements-spec.md` (locked), `journey-format-spec` v8 (locked @ 6fe3c1e). Referrers: flow-control-spec · change-protocol · ann-system-design · architecture · AGENTS.md · implementation slices.*

## 1. Layout — the table of legs

- `journey/legs/` is the **TABLE**: a chain of legs — the project's forward progress. One store per project. **Multi-user ready:** a shared store is a future deployment concern; events carry no single-machine assumptions — identity/permissions are future amendments, not blocked by this format (requirements-spec §7 A1).
- **A leg (formerly `round`) = one step of work = an epic.** Leg dir = `<NN>-<name>/`, `NN` = leg index (chain order). A leg closes **only when its goal is met** (artifacts produced, ACs verified) → then the next leg may begin. Legs are sequential gates; done legs never change.
- Leg dir contains the **leg root** (`node.json` · `description.md` · `artifacts/` — **no `events.jsonl`**: v7, §4) plus the leg's **task group** — tasks live **directly under the leg dir**: `<NN>-<name>/`, one subtree each. Tasks are **independent and may proceed in parallel**; dependent ordering uses the sort prefix. **A task's sub-steps nest inside its own dir** (no level dirs — v8).
- **Migration (v8):** legs 4–6 used a `00/` level dir (2026-08-16–19); flattened to `leg/<NN>-<name>/` — a sanctioned migration, 21 tasks lifted and `node.json` ids updated. `00 → .` compat symlinks remain in L4–L6 so historical paths (locked docs, recorded events) keep resolving; the walkers skip symlinks, so the old shape is invisible to state. Tasks are flat everywhere — L2/L3 always were.
- **id = relative path from `journey/legs/`** (`04-system-design/01-format-amendment-v2`). Parent = dirname · children = subdirectories · no `parentId`/`children` fields.
- **Leg dependency:** each leg's root `requiredInputs` names the previous leg's artifact **by logical name** (new nodes; legacy nodes may hold historical paths — resolvable via forward pointers). L1 has none — it is the base step.
- Chain order = leg index; a leg's "goal met" = its epic ACs verified (all tasks' goals met + artifacts locked) → **leg status derives `done` from its tasks (§12)** → next leg spawns. **(v7: the leg root carries no events — completion is derived from tasks, never asserted.)**

## 2. node.json — immutable creation record (schema enumerated)

```json
{
  "id": "06-engine-build/03-format-amendment-v8",
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
  - `artifact-locked` carries the artifact's durable identity: `{"at","type":"artifact-locked","artifact":{"name":"requirements-spec","path":"…/requirements-spec.md","lockSha":"89ace76"},"note":""}`. **`path` is the task-local ref** — a symlink into `docs/` (document artifacts) or the record doc in `artifacts/` (code/implementation artifacts, §14). **`lockSha` remains the blob sha of the file content** (doc integrity); **commit clues live in the record content, not the event** (§14).
  - `superseded` carries the successor: `{"at","type":"superseded","successor":{"name":"requirements-spec","path":"…-v2.md"},"note":""}`.
  - Missing or unknown fields are **rejected** (strict schema — a fresh engine fails loudly, never silently).
- **Status = tail mapping (TASKS).** **`superseded` ANNOTATES — never overrides a `completed`/`failed` status** (a completed task whose artifact is later superseded stays `done`; only a non-completed node derives `superseded`). `extended` / `evidence` annotate only; they do not change status. **(v7: leg roots have no tail-mapped status — §12 derives it from tasks.)**
- **APPEND-ONLY** — no reorder, no rewrite, no deletion.

## 4. File ownership & write timing (v4 — NEW; v7 amended; v9 amended)

| File | What it holds | When written |
|---|---|---|
| `node.json` | leg root = epic contract; task = task contract | **once, at spawn** — never rewritten |
| `events.jsonl` | leg root = **— (absent — v7)** · task = **task lifecycle** (`created`-as-spawn-record/`activated`/`evidence`/`artifact-locked`/`completed`/`failed`/`superseded` + gates + closure events) | **appended only**; `artifact-locked` on the **producing node** (L1's root holds design's — grandfathered; tasks hold theirs). **(v7) The leg root carries no process log — all process/status events live on tasks; the leg root is structural (node.json + description.md + optional artifacts)** |
| `description.md` | the **regenerable derived card** (frontmatter §6 + free-form body) | the **only rewritable file** — may be regenerated from events |
| `artifacts/` | node outputs — **a ref (symlink into `docs/`) for document artifacts, or a record doc (refs + commit clues + conclusion) for code/implementation artifacts** (§14). **Content files live in `docs/`, never in the tree** (§15) | written when produced; immutable once recorded |
| `docs/` | the **artifact content files**, categorized by type (§15) — the one place content lives; git is the change tracker | written when an artifact is produced |

**Timing rules:** a leg spawns only after **all previous-leg tasks are `done`** — the derived leg gate (§12), no `completed` event required · a task spawns only after its parent's artifact exists (artifact gate — satisfiable by any locked artifact, incl. a record doc, §14) · `artifact-locked` is written the moment the artifact locks · appends happen at each lifecycle transition (activated, evidence, artifact-locked, completed, failed, superseded).

## 5. Logical names & resolution

- **Every artifact carries a logical name**, globally unique within the store (`requirements-spec`, `journey-format-spec`, `flow-control-spec`, `change-protocol`, …). **A superseding artifact reuses the name.**
- **The correct path is never stored as a live pointer.** Paths are *facts in events* (`artifact-locked` records name+path+sha; `superseded` records the successor). No mutable "current → path" mapping. *(A symlink in `artifacts/` is a filesystem-level ref, not a logical pointer — resolution still derives the path from events, and the symlink merely relocates the content to `docs/`.)*
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
- **F-AC18 (v9) — artifact invariants:** every completed TASK must have locked an artifact (document or record doc); if a task produced nothing, its artifact is a **reason doc** naming why (§14). A record doc must carry **traceable commit clues** — the refs resolve to existing files and the commits exist in git (§14); the one-time v9 migration (§15) is exempt.

## 8. Depth policy (absorbed from depth-policy.md, 11c3de2)

- **Depth expectation:** typical 2–5 levels (leg/name = 2, sub-steps +2 per nesting); budget **≤ 8 levels and ≤ 260 chars full path** (Windows-compatible). Approaching the budget = rebalance signal.
- **Sibling-correction (main control):** repairs/retries/amendments are **siblings at the same level** with a higher prefix — never nested children. Failure never adds depth. **The closure task is a sibling too (v7).**
- **Pruning:** completed/superseded subtrees may be removed from the working tree; git is the archive and source of truth. Active tree = live frontier + recent/adjacent nodes.
- **Name discipline:** path segments ≤ 24 chars, kebab-case, no dates/versions in segment names. **Enforced for NEW nodes** (v4); existing over-length names (`05-requirements-amendment`, `03-change-protocol-amendment`, `08-system-design-validation`) are historical — no hot migration.
- **Pure decomposition still nests:** honest depth (a node whose contract genuinely decomposes) is bounded by the work itself, never by failure.
- **Node count: no limit** (the format caps nothing; big-data query performance N/A for v1 — requirements-spec §7 A4).

## 9. Edge cases

- First leg (L1) has no input artifact — it is the base step.
- Leg with no tasks: **`queued` and can never derive `done`** — nothing worked (v7). L1's root-level design work predates the task-group model (its artifact lives on the root) and is grandfathered (§12).
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
- Legacy `00/` nesting (L4–L6, removed v8): invisible to the walkers (symlink-skipped); historical paths resolve through the `00 → .` compat symlinks.
- Empty `note` valid; missing `description.md` invalid; unknown field/event type rejected.
- **Artifact ref via symlink (v9):** `readFileSync`/`existsSync` follow the symlink transparently — a document artifact's content reads identically whether at its `docs/` location or its task-local `artifacts/` ref; the blob-sha integrity check is therefore unaffected by the relocation. A broken symlink (content file missing) = validation error, blocker named.
- **External artifact (v9):** a product not inside the project is referenced by a link (URL) in the record doc; existence is not file-checked — the link is the durable ref.
- **Empty task (v9):** a task that produces nothing concludes with a **reason doc** — the artifact IS the conclusion; it is never absent.
- **Commit traceability (v9):** a record doc's commit clues must resolve (`git cat-file -t <sha>` succeeds + the ref paths exist). Unresolvable → validator error. **Exemption: the one-time v9 migration (§15) — pre-v9 artifacts whose commit history is untraceable are skipped, never failed.**

## 10. Non-goals (v1)

- No DAG edge files / cross-task joins (deferred — requirements-spec §3; independence is the v1 default).
- No binary blobs in artifacts (text/structured only).
- No live pointer maintenance — logical references are resolvable, not kept fresh. *(The `docs/` relocation uses filesystem symlinks — a mechanical ref, not a maintained logical pointer.)*
- No hot-migration of existing trees — **except** the sanctioned one-time migrations (v8 flat shape; v9 artifact relocation) which are explicit, reviewed, single-commit operations.

## 11. Evolution — supersede, never edit

- This spec is immutable once locked. Amendments = **new nodes** (tasks) whose artifacts **completely supersede** it — reusing the logical name `journey-format-spec` and preserving section anchors — with a back-reference + `superseded` event. Node structure updates are tasks, and tasks are nodes: the table cannot be reshaped by editing — only by growing (change-protocol v2).
- v7 was produced after the L5 incident: the leg root asserted `done` + "all gates confirmed" while tasks 16/17 held no confirmations — a contradiction only a validator could have caught. v7 makes the contradiction **impossible by construction**: leg status derives from tasks, so a leg can never claim what its tasks don't substantiate.
- v9 closes the artifact seam: under v8, a code task had no lockable artifact type (the vocab held only `spec`/`system-design`/`architecture`), so the artifact gate (§4) was mechanically un-satisfiable for code tasks and flow-control's "done ⇔ artifact recorded" was silently false for implementation work. v9 makes the artifact universal (§14): every task concludes with a lockable artifact — a document, a commit-record doc, a link, or a reason doc.

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

## 13. Flat task group (v8 — NEW)

**The shape.** Tasks live **directly under the leg dir**: `leg/<NN>-<name>/` — no level dirs, no `00/` group. A task's sub-steps nest inside its own dir (`leg/<NN>-<task>/<NN>-<substep>/`). One shape at every depth; the id IS the path from `journey/legs/` (`05-engine/01-flow-control`).

- **Why.** The `00/` segment (v4–v7) was structurally meaningless — no code read it — and its presence misled: a phantom middle segment in ids (`05-engine/00/01-flow-control`), two coexisting shapes (flat L2/L3 vs `00/` L4–L6), and the spec implying `01/`/`02/` level groups that had no semantics. Meaningless structure is exactly what pattern-matching models pattern-match on; the flat shape removes it.
- **Migration (2026-08-19, sanctioned).** 21 tasks in L4–L6 lifted one level (`leg/00/task` → `leg/task`); `node.json` `id` fields updated (an explicit, reviewed, single-commit migration — the immutability rule yields to a deliberate model change, recorded here). `00 → .` compat symlinks remain in L4–L6 so historical paths (locked docs, recorded events, the structured `artifact-locked` paths of v7/v4) keep resolving. The walkers skip symlinks (`lstat`), so the old shape is invisible to state.
- **No level dirs.** The format defines no `01/`/`02/` child-group semantics — the task group is the only child layer, and nesting is inside tasks. Any future child-grouping idea is a format amendment, not an ad-hoc level dir.
- **Depth policy (§8)** applies unchanged; the children filter is `depth === 2` (leg/task) in the resolver and validators.

## 14. The artifact model (v9 — NEW)

**The shape.** An artifact = **a logical name + a file ref + commit clues + a conclusion**:

- **file ref** — a path into the project (`docs/`, categorized by type, §15), realized in the task's `artifacts/` as a **symlink** for document artifacts; or an **external link** (URL) in a record doc for products outside the project.
- **commit clues** — the git commits that produced/changed the file. For document artifacts the lock sha + git history are the clue; for code/implementation artifacts a **record doc** lists the related commits (with messages) + refs + test evidence.
- **conclusion** — what the task concluded. A task that produced nothing concludes with a **reason doc**; the conclusion is never absent.

**No strict work-type → artifact-type mapping.** A task produces *whatever* it produces. The following table is **guidance** (what to expect, never a constraint):

| Work type | Typical artifact | Content |
|---|---|---|
| idea (chain seed) | document | the idea statement |
| validate/grilling (F4) | document | validation (verdicts + claims + provenance) + batch questions |
| envision (F8) | document | product vision: usage + look + open questions |
| spec/planning (F9) | document | detailed specs (requirements, ACs, scope, data, NFRs) |
| implementation | **record doc** | refs + commit clues (well-committed, described) + test evidence |
| binding/external | record doc or link | provenance: action, result, response; or the external link |
| closure/amendment | record doc or events | gate-revised + transferred scope verbatim |

- **Every task concludes with an artifact.** Completion of a task requires a locked artifact; an "empty" task locks a reason doc. (F-AC18; flow-control v5 §6.)
- **The artifact gate is satisfiable for every task type.** A code task's record doc satisfies the gate (§4), so code tasks can spawn children — previously impossible (v8 had no code artifact type).
- **Commit traceability (future tasks).** A record doc's commit clues must resolve — the ref paths exist and the commits exist in git (`git cat-file -t <sha>`). Enforced by the validator (F-AC18); the one-time v9 migration (§15) is exempt. *(Presupposition for implementation tasks: task code is committed with descriptive messages.)*

## 15. docs/ layout & the v9 migration (v9 — NEW)

**Where content lives.** Artifact content files live in `docs/`, categorized by artifact type — one place per file; git tracks changes; the tree holds refs (symlinks) + records. Categories:

| Category | Contents |
|---|---|
| `docs/specs/` | specs and policies (requirements-spec, format specs, flow-control, functional, resource-registry, depth-policy) |
| `docs/system-designs/` | system designs (design, ann-system-design*) |
| `docs/architecture/` | architecture |
| `docs/records/` | records (goal, conformance reports, commit records) |

- **Updating a file needs no reference resolution** — the task-local symlink still points at the same `docs/` path; the commit advances, the ref does not.
- **Migration (2026-08-21, sanctioned — the hot fix).** 27 artifact content files moved from `journey/legs/…/artifacts/` to `docs/` (categorized); a symlink replaces each at its old path, so every recorded `artifact-locked` path and blob sha keeps resolving — append-only preserved, **zero event rewrites**. Untraceable pre-v9 commit history is **skipped** (not failed) for this migration only; the commit-traceability gate (§14) applies to future tasks in code.
- **Platform caveat (recorded):** this migration introduces filesystem symlinks (first use). They are transparent to `readFileSync`/`existsSync` (verified), but are platform-fragile on checkouts that materialize symlinks as text.
