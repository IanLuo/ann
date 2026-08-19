<!-- specs:locked:ba528d1 2026-08-15 type=spec -->

## Link contract
- **upstream** (this doc relies on): design,01-goal/01-grilling/artifacts/ann-spec.md
- **referrers** (must cite this when they change): AGENTS.md,02-system-design implementation slices

# Tree Format Spec (v1)
*Artifact of node `01-goal/02-tree-format`. Type: spec. Freezes the v0 bootstrap format as the engine's data contract — ann-spec A5 (format stability, no migration). Model semantics: design §21. Requirements: `01-goal/01-grilling/artifacts/ann-spec.md` (locked @ 2664511).*

## 1. Layout — the directory tree IS the tree

- Root: `tree/nodes/`. Every node is a **directory**: `<NN>-<name>/`.
- Node contents: `node.json` · `events.jsonl` · `description.md` · `artifacts/` (may be empty).
- **Parent = dirname · children = subdirectories · id = relative path** (`01-goal/01-grilling`). No `parentId`/`children` fields anywhere — a second copy of a fact would drift.
- **Sibling order = zero-padded sort prefix** (`01-`, `02-`). v1 sequential execution: "frontmost ready node" = lowest prefix among ready siblings.
- Pruning a subtree = removing its directory (history remains in git).

## 2. node.json — immutable creation record

```json
{
  "id": "01-goal/01-grilling",
  "contract": {
    "intent": "string",
    "acceptanceCriteria": ["string"],
    "targetAreas": ["string"],
    "requiredInputs": ["string"],
    "expectedOutputs": ["string"]
  },
  "openQuestions": [
    {"id": "Q1", "question": "string", "blocking": true, "reason": "string", "defaultIfUnanswered": "string", "affectedTaskIds": ["string"]}
  ],
  "createdAt": "YYYY-MM-DD"
}
```

- `id` REQUIRED, must equal the directory path. `contract.intent` REQUIRED. `contract.acceptanceCriteria` REQUIRED, non-empty.
- `targetAreas` / `requiredInputs` / `expectedOutputs` optional but SHOULD be present when known.
- `openQuestions` optional; `blocking: true` means the node may not execute until answered or defaulted.
- `createdAt` REQUIRED (YYYY-MM-DD).
- **IMMUTABLE**: written once at creation. The engine refuses any rewrite. Corrections = new nodes (amendment/repair branches), never edits.
- Strict schema: unknown fields rejected — a fresh engine fails loudly, never silently.

## 3. events.jsonl — append-only process log

- One JSON object per line: `{"at": "YYYY-MM-DD", "type": "<enum>", "note": "string"}`.
- `type` enum: `created · activated · extended · evidence · artifact-locked · completed · failed · superseded`.
- `at` and `type` REQUIRED; unknown `type` rejected. `note` optional, encouraged.
- **APPEND-ONLY**: no reordering, no rewriting, no line deletion. File order = append order (never sort by timestamp on read).
- **Status derivation** (never stored): status = mapping of the LAST event line —
  - `created` → `queued` · `activated` → `active` · `completed` → `done` · `failed` → `failed` · `superseded` → `superseded`
  - `extended` / `evidence` / `artifact-locked` annotate only; they do not change status.
- A node with no events file or no `created` event is invalid.

## 4. description.md — searchable card

- REQUIRED for every node (agents `rg` it; design §21.9 tree-as-memory).
- MUST contain: `# <NAME>` title · `id:` line · `status:` line (derived snapshot, never authoritative — events.jsonl is) · `intent` · artifact pointers · children pointers · trailing `search terms:` line.
- Written at creation; live state always comes from `events.jsonl`.

## 5. artifacts/ — per-node outputs

- A node's output artifacts live in its own `artifacts/` dir — discoverable by path, no index file needed.
- **Artifact gate:** children may be spawned only after the node's `expectedOutputs` exist in `artifacts/`.
- Artifacts immutable once recorded; supersession = new artifact or `superseded` event, never overwrite.

## 6. Checkpoints & RPO

- A committed node = a git commit containing that node's files + artifacts.
- **RPO = 0** for committed nodes (ann-spec NFR-REL-1): crash → resume from last commit; uncommitted events may be lost (documented, not silent).
- Checkpoint ref = git SHA; branch checkpoint = the commit where the node's event was appended.

## 7. Acceptance criteria for the format (what the engine must support)

- F-AC1: engine reads any conforming tree with zero ambiguity — strict schema validation; unknown fields/events rejected.
- F-AC2: engine refuses to rewrite `node.json` or reorder/delete event lines (append-only enforcement).
- F-AC3: node status is always derived from the events tail, never stored.
- F-AC4: sibling order = sort prefix; frontmost-ready = lowest prefix among ready siblings.
- F-AC5: `rg <term> tree/nodes/**/description.md` finds relevant nodes.
- F-AC6: a node's artifacts are discoverable at `<node>/artifacts/` without index files.
- F-AC7: no re-parenting API, no edit API — corrections are new nodes only.
- F-AC8: a conforming tree round-trips (read → append new node → read) without loss.

## 8. Edge cases

- Root node (goal) has no parent: id = `01-goal`.
- Node with no children: valid leaf. Node with no artifacts: valid until it must gate children.
- Empty `note`: valid. Empty `acceptanceCriteria`: invalid. Missing `description.md`: invalid. Unknown event type / unknown field: rejected.
- `superseded` node: stays on disk (history); excluded from distance-to-goal frontier.

## 9. Non-goals (v1 format)

- No DAG edge files (joins deferred, ann-spec §3).
- No binary blobs in artifacts (text/structured only).
- No hot-migration of existing trees (A5: this spec freezes v0).

## 10. Evolution — supersede, never edit

- Once locked, this spec is **immutable**. Amending the node structure or format = **a new node** (a task) whose artifact supersedes this spec — with a back-reference to this doc, and a `superseded` event appended here.
- A superseding spec is a new artifact, never an edit. The format's history stays as visible as the project's.
- General rule this enforces: **node structure updates are tasks, and tasks are nodes.** The tree cannot be reshaped by editing — only by growing.
