## Link contract
- **upstream** (this doc relies on): journey/legs/01-goal/artifacts/design.md,02-grilling/01-spec-rework/artifacts/requirements-spec.md,05-engine/17-format-amendment-v6/artifacts/tree-format-spec-v6.md,06-engine-build/19-core-design/artifacts/core-design-spec.md,06-engine-build/20-journey-format-v14/artifacts/journey-format-spec.md,06-engine-build/27-journey-format-v15/artifacts/journey-format-spec.md
- **referrers** (must cite this when they change): flow-control-spec,change-protocol ann-system-design,architecture AGENTS.md,implementation slices

# Journey Format Spec (v16)
*Artifact of task `07-artifact-collapse/06-spec-v16`. Type: spec. Complete superseding version — v15 (locked @ 8a51ce6) + **the ARTIFACT COLLAPSE (leg 07)** — `lock!` becomes a THIN NAMED-ARTIFACT RECORD over the producer's own file: **§1** — the project layout DROPS `docs/` (retired, not relocated); **§3** — the `artifact-locked` event records the thin record `{name, path, lockSha, type?, version?}` — no symlink, no `-v<N>` filename, no marker stamp; **§4** — defer-record's "shared docs/ placement at commit" step is GONE — commit records the EVENT only, the bytes on disk are untouched (AC1); **§14** — the artifact model REWRITTEN: ANY file type locks (the Markdown-only rule is dead, F3), `type` is an optional free-form tag with ZERO placement semantics (F2), `read`/`current`/`specs` are pure log-derived views; **§15** — the `docs/` layer is RETIRED: the 12 inert symlinks are cleaned up in this amendment, and legacy marker-stamped files keep reading — the marker strip is a read-time NO-OP on unstamped files (the LEGACY-READER rule). Produced per the change protocol: amendment node → complete artifact → superseded event. Upstream: `journey/legs/01-goal/artifacts/design.md` (v3, locked), `02-grilling/01-spec-rework/artifacts/requirements-spec.md` (locked), `journey-format-spec` v15 (locked @ 8a51ce6), `core-design` (locked @ f7fb400). Referrers: flow-control-spec · change-protocol · ann-system-design · architecture · AGENTS.md · implementation slices.*

## 1. Layout — the table of legs

- **THE PROJECT LAYOUT (v12; v16 amended): all ann-owned files live under `<project>/.ann/`** — `journey/` (the store) · `rules/` (registries). **`docs/` is RETIRED (v16)** — the shared contract-stack layer of §15 is gone; every artifact is a thin record over the producer's own file, so there is nothing left to mirror. The `.ann/docs/` directory and its 12 inert symlinks are cleaned up in the v16 amendment (§15); any stray `docs/` entry is inert filesystem history, invisible to state. Root-level `journey`/`rules` may exist as **compat symlinks → `.ann/*`** (historical recorded paths, external references, relative artifact links) — the walkers skip symlinks, so the old shape is invisible to state. **Recognition marker: a directory containing `.ann/` IS an ann project** (legacy: `journey/` is also accepted).
- `journey/legs/` (i.e. `.ann/journey/legs/`) is the **TABLE**: a chain of legs — the project's forward progress. One store per project. **Multi-user ready:** a shared store is a future deployment concern; events carry no single-machine assumptions — identity/permissions are future amendments, not blocked by this format (requirements-spec §7 A1).
- **A leg (formerly `round`) = one step of work = an epic.** Leg dir = `<NN>-<name>/`, `NN` = leg index (chain order). A leg closes **only when its goal is met** (artifacts produced, ACs verified) → then the next leg may begin. Legs are sequential gates; done legs never change.
- Leg dir contains the **leg root** (`node.json` · `artifacts/` — **no `events.jsonl`**: v7, §4) plus the leg's **task group** — tasks live **directly under the leg dir**: `<NN>-<name>/`, one subtree each. Tasks are **independent and may proceed in parallel**; dependent ordering uses the sort prefix. **A task's sub-steps nest inside its own dir** (no level dirs — v8). **(v13: the `description.md` card is gone — a leg dir is `node.json` + `artifacts/`.)**
- **Migration (v8):** legs 4–6 used a `00/` level dir (2026-08-16–19); flattened to `leg/<NN>-<name>/` — a sanctioned migration, 21 tasks lifted and `node.json` ids updated. `00 → .` compat symlinks remain in L4–L6 so historical paths (locked docs, recorded events) keep resolving; the walkers skip symlinks, so the old shape is invisible to state. Tasks are flat everywhere — L2/L3 always were.
- **id = relative path from `journey/legs/`** (`04-system-design/01-format-amendment-v2`). Parent = dirname · children = subdirectories · no `parentId`/`children` fields. **(v12: the canonical on-disk root is `.ann/journey/legs/`; ids remain relative paths — layout and identity stay orthogonal.)**
- **Task id grammar (v15 — NEW):** a NEW task's last segment is **`<NN>-<worktype>-<slug>`** — `NN` = zero-padded 2-digit sort prefix (the ordering guarantee: ordering is plain lexicographic `.sort()` over the full id — §3/§16 — so the zero-pad IS the order; never rename it), `<worktype>` ∈ {validate, envision, spec, implementation, binding, closure} (the task kind — the flow selector, §2 + flow-control §7; build slices + spec amendments → `implementation`), `<slug>` = a short kebab-case noun phrase naming the deliverable (§16). **Forward-only:** existing ids keep their shapes (renaming breaks immutable refs / F-AC18) — the grammar governs NEW nodes. A leg segment stays `<NN>-<name>` (legs are epics, not tasks).
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
    "expectedOutputs": ["string"],
    "workType": "string — the flow selector (validate | envision | spec | implementation | binding | closure)",
    "flow": "string | object — an EXPLICIT chain override; wins over workType",
    "model": "string — the per-task model override (provider registry id)"
  },
  "openQuestions": [
    {"id": "Q1", "question": "string", "blocking": true, "reason": "string",
     "defaultIfUnanswered": "string", "affectedTaskIds": ["string"]}
  ],
  "createdAt": "YYYY-MM-DD"
}
```

- `id` REQUIRED, equals the directory path from `journey/legs/`. `contract.intent` REQUIRED. `contract.acceptanceCriteria` REQUIRED, non-empty. `targetAreas` / `requiredInputs` / `expectedOutputs` optional but SHOULD be present when known. **`openQuestions` is a TOP-LEVEL SIBLING of `contract`** — not a contract field (v13's schema block already had it there; v14 states it, and the engine's write path (`store.spawn`) and read path (the packet assembler) are corrected to match — core-design §2). `openQuestions` optional; `blocking: true` gates the node (and its leg). `createdAt` REQUIRED.
- **THE FLOW FIELDS (v14 — NEW, core-design §2/§6):**
  - **`workType`** — the flow selector: the chain the frame runs for this task is `chains[workType]` in the flow registry (`rules/flow/default.json`). An **absent `workType` is as loud as an unknown one**: no `workType` and no `contract.flow` → `chains.default` if present, else a NAMED problem. An **empty chain is legal and meaningful** (the lifecycle-only flow: the frame + the runner, outcomes observed as `evidence.commits[]`).
  - **`flow`** — an explicit chain override for this one task; when present it **wins over `workType`**. For unusual work, the task carries its own chain rather than forcing a new work type into the registry.
  - **`model`** — the per-task model override, resolved against the provider registry; absent = the configured default. Per-task model selection is an architecture decision (architecture §"per-task models"), recorded here as data.
  - All three are **OPTIONAL and inert to F-AC19** — they select behaviour, they do not make a contract self-sufficient. Unknown values fail closed, NAMED, at flow resolution (never a silent default).
- Leg root: `contract` = the epic (goal, gate ACs, requiredInputs, leg-level openQuestions). Task node: `contract` = the task (intent, ACs, expected output artifact).
- **IMMUTABLE** — written once at spawn; strict schema; unknown fields rejected. Corrections = new nodes, never edits. **Consequence for the flow fields (v14):** a chain edit that introduces a new binding applies only to **unspawned** tasks — a spawned task's `workType`/`flow` are frozen; the remedy is a new task, never an edit (core-design §3 rule 5).

**TASK CONTRACT CHECKLIST (v11) — a node's contract must be SELF-SUFFICIENT:** a fresh agent reads only the `node.json` contract + resolvable inputs and can execute without guessing. Items 1–3 are **ENFORCED (F-AC19, §7) — spawn rejects, check flags (v9+ nodes)**; items 4–7 are guidance (SHOULD).

1. **`intent`** — REQUIRED, non-empty: what the task does (one clear sentence).
2. **`acceptanceCriteria`** — REQUIRED, non-empty array, each entry non-empty: when the task is done (verifiable, no judgment needed).
3. **`requiredInputs`** — every entry a **logical name** resolving via `current()` to a current artifact; never a path, never a guess. An input that does not resolve = the task is not spawnable yet (flow-control §5: inputs are previous artifacts).
4. **`targetAreas`** — SHOULD when the task produces files: where the work lands.
5. **`expectedOutputs`** — SHOULD, describing the **conclusion** (§14): a document artifact to lock, or code/commit evidence (`evidence.commits[]`).
6. **`openQuestions`** — SHOULD list known unknowns (TOP-LEVEL, above); `blocking: true` gates the node (and its leg). Never a silent assumption.
7. **Work type** — SHOULD be **stated in `contract.workType`** (v14 — v11 said "determinable from intent"; the flow now reads a field, so state it): validate / envision / spec / implementation / binding / closure (flow-control §7). Determinability is no longer enough where a chain must be selected. **(v15: the worktype ALSO names the task's kind in the id grammar — §1/§16 — so stating it is what makes the id meaningful.)**

## 3. events.jsonl — append-only process log

- One JSON object per line. Types: `created · activated · extended · evidence · artifact-locked · completed · failed · superseded · submitted · confirmed · rejected · waiting`. (v4: **`spawned` removed** — a child's `created` event IS the spawn record; children are structural via directories.) **(v14: `waiting` is NEW — below.)**
- **Closure events (v6) — the close-by-transfer record (flow-control v4):**
  - `gate-revised` — the gate re-scope: `{"at","type":"gate-revised","gate":{"old":"…","new":"…"},"note":""}`.
  - `transferred` — scope moved to a new task/leg: `{"at","type":"transferred","target":"06-engine-build","scope":"<the transferred ACs, verbatim>","note":""}`.
  - `deferred` — scope parked (no target yet): `{"at","type":"deferred","reason":"…","note":""}`.
  - **Closure rule (F-AC16):** a node whose `completed` follows a `gate-revised` must have a `transferred` or `deferred` event before completion; a `transferred` target must exist as a leg/task id. Closure is never prose-only.
  - **Closure lives on TASKS (v7):** `gate-revised` / `transferred` / `deferred` are recorded on the **closure task** — a sibling at the same level with a higher prefix (sibling-correction), or the task that surfaced the gate-unmet — never on the leg root (§12).
- **Gate events (v5):**
  - `submitted` — node presented at a gate: `{"at","type":"submitted","gate":"grill|confirm","confirmedSha":"<blob sha>","note":""}` — **`confirmedSha` is OPTIONAL and v14-NEW** (below).
  - `confirmed` — gate accepted: `{"at","type":"confirmed","gate":"grill|confirm","note":""}`.
  - `rejected` — gate rejected: `{"at","type":"rejected","gate":"grill|confirm","feedback":"…","note":""}` — rejection → bounded rework, same-gate return (flow-control §3).
  - **Gate flow:** `submitted(gate=grill)` → `confirmed`/`rejected(gate=grill)` before execution · `submitted(gate=confirm)` → `confirmed`/`rejected(gate=confirm)` before `completed`.
  - **Derivation:** a node with `submitted` but no `confirmed`/`rejected` at that gate = `blocked` (waiting on human) — a gate cannot be skipped silently.
  - **Completion rule:** `completed` may be written **only after** `confirmed (gate=confirm)` — validator-enforced (F-AC15).
- **`waiting` — the NON-HUMAN block (v14 — NEW; core-design §3 rule 8 / §4):** `{"at","type":"waiting","reason":"…","note":""}`. Recorded by the frame when the task cannot proceed and **no gate is pending** — the measured case is the **empty-chain verify wait**: verify finds no outputs because the runner has not committed yet, which is a WAIT CONDITION, not a defect. Before v14 the store could express "blocked" only through an undecided `submitted`, so this state had no honest record.
  - **Status mapping: `waiting` derives `blocked`** — the same status an undecided `submitted` derives, from a different cause. The two are distinguishable by the event that produced them (`submitted` = waiting on a HUMAN at a gate; `waiting` = waiting on the WORLD).
  - **Clearing is by supersession-in-tail, not deletion:** a `waiting` record is cleared by the next event that moves the task (the `evidence` the frame was waiting for, a gate event, `completed`, `failed`). The resume rule is *a `waiting` record with no subsequent commit evidence → block and wait* (core-design §1's fourth tail state).
  - `waiting` **annotates nothing else** — it never satisfies a gate, never concludes a task (§7 F-AC18 is unmoved), and never appears on a leg root (§12).
- **Ordering (v4):** file order = **append order** — the only order. `at` is **informational** (`YYYY-MM-DD` for humans); never sort by `at`. Resolution and status derive from append order + the superseded mechanism, never from timestamps.
- **Structured event fields:**
  - `artifact-locked` carries the artifact's durable identity — **v16 the THIN RECORD**: `{"at","type":"artifact-locked","artifact":{"name":"journey-format-spec","path":".ann/journey/legs/<producer>/artifacts/journey-format-spec.md","lockSha":"8a51ce6","type":"spec","version":16},"note":""}`. **`path` is the PRODUCER'S OWN FILE, project-relative** — the collapse (leg 07) made `lock!` a THIN record: ann verifies the path exists, hashes the raw bytes, derives the version from the log, and records the event. It **NEVER writes, copies, stamps, or symlinks the file** (AC1) — the bytes on disk are untouched, and ANY file type locks (F3: the Markdown-only rule is dead). **`lockSha`** is the blob sha of the raw file content, computed marker-tolerantly (the strip is a read-time NO-OP on unstamped files — the legacy-reader rule, §15). **`type` is an OPTIONAL free-form tag** with zero placement semantics (F2 — `unknown-type`/`placement-collision` no longer exist); **`version`** is derived from the log (§14). **(v14: the EVENT records at COMMIT — §4. The file exists earlier; the event is the acceptance record, not the write record.)**
  - **`evidence` carries STRUCTURED commit clues (v10):** `{"at","type":"evidence","commits":[{"sha":"8e94c58","note":"step 1: provider adapter"}],"refs":["src/adapters/provider/"],"note":"checkpoint …"}` — `commits[]` and `refs[]` are OPTIONAL but when present they are **machine-truth**: the validator may rely on them (F-AC18, §7) and NEVER parses prose for commit facts (NFR-COM-1). `note` may repeat them for humans; the structured fields are authoritative.
  - **`evidence` may ALSO carry a structured `trace` record (v14 — NEW; the transcript's home; core-design §2):**
    ```json
    {"at":"…","type":"evidence","trace":{
       "stepId":"idea-validate","runId":1,"seq":3,
       "kind":"llm|ask|research|decide|verify|skip",
       "prompt":"…","completion":"…",
       "question":"…","answer":"…",
       "research":[{"topic":"…","findings":"…","sources":["…"]}],
       "options":["…"],
       "cycle":2,
       "condition":"hasOutput:envision","evaluated":false},
     "note":""}
    ```
    - **Keyed `(stepId, runId, seq)`** — the identity a replay serves from. `runId` = 1 + (rejections at the step's bound gate) + (verify cycles since the latest gate decision at `confirm`, for execute/confirm-bound steps only) — **derivable from the tail, monotonic**. `seq` orders records within a run.
    - **SIX kinds, shape-policed** (unknown kind or wrong shape = rejected, strict schema): the **four step-level kinds** — `llm` (`prompt`, `completion`), `ask` (`question`, `answer`), `research` (`research[]`, an ARRAY with per-topic `sources[]`), `decide` (`question`, `answer`, `options[]` — replay-by-identity needs the option set) — and the **two frame-phase kinds** (v14, same discriminant name): `verify` → `{cycle}` with **NO `stepId`** (a verify cycle belongs to the frame's verify phase, not to a step) and `skip` → `{stepId, condition, evaluated:false}` with **NO `cycle`** (a skip is step-keyed; the record is what makes a conditional branch derivable from the tail — NFR-OBS-1).
    - **`present` is deliberately unrecorded** — presentation has no return value to replay.
    - **Why events and not a side log:** the transcript makes replay deterministic — on replay the LLM calls are served the recorded completions and the interact calls the recorded answers **by question identity**, so a human is never re-interviewed and the questions never drift. This **REVERSES the two-log split** (the op-log holds metrics and never text): the text lives in `events.jsonl`. **CONSEQUENCE, STATED:** NFR-SEC-1 ("no secrets in the tree") now applies to prompt/completion text — the transcript is machine-truth, never prose, and never a place to put credentials.
  - `superseded` carries the successor: `{"at","type":"superseded","successor":{"name":"requirements-spec","path":"…-v2.md"},"note":""}`.
  - **`submitted` may carry `confirmedSha` (v14 — NEW):** the blob sha (marker-stripped) of the working artifact **as presented at gate②**. It binds the bytes a human confirmed to the bytes committed: at commit the frame recomputes the sha over the materialized file and **REFUSES on mismatch**, writing `failed` with a named blocker. Optional (a task with no document artifact has nothing to bind); when present it is machine-truth.
  - Missing or unknown fields are **rejected** (strict schema — a fresh engine fails loudly, never silently).
- **Status = tail mapping (TASKS).** **`superseded` ANNOTATES — never overrides a `completed`/`failed` status** (a completed task whose artifact is later superseded stays `done`; only a non-completed node derives `superseded`). `extended` / `evidence` annotate only; they do not change status. **`waiting` derives `blocked`** (v14). **(v7: leg roots have no tail-mapped status — §12 derives it from tasks.)**
- **APPEND-ONLY** — no reorder, no rewrite, no deletion.

## 4. File ownership & write timing (v4 — NEW; v7 amended; v9 amended; v10 amended; **v14 amended — DEFER-RECORD**)

| File | What it holds | When written |
|---|---|---|
| `node.json` | leg root = epic contract; task = task contract | **once, at spawn** — never rewritten |
| `events.jsonl` | leg root = **— (absent — v7)** · task = **task lifecycle** (`created`-as-spawn-record/`activated`/`evidence` (with optional structured `commits`/`refs`/`trace`)/`artifact-locked`/`completed`/`failed`/`superseded`/`waiting` + gates + closure events) | **appended only**; `artifact-locked` on the **producing node** (L1's root holds design's — grandfathered; tasks hold theirs). **(v7) The leg root carries no process log** · **(v14) the `artifact-locked` event records AT COMMIT** — below |
| `artifacts/` | node outputs — **REAL FILES, the producer's own bytes (v16, the collapse)**. Every artifact's content is the file the producing task wrote here; the `artifact-locked` event records a thin `{name, path, lockSha, type?, version?}` over it (§14). ann NEVER copies or symlinks it anywhere | the file is written when the step produces it (re-written on rework); the **EVENT records at COMMIT** (§14) — the file itself is untouched by the record |
| `docs/` | **RETIRED (v16)** — the shared contract-stack layer is gone (§15); nothing is mirrored, nothing is symlinked | never written (removed in the v16 amendment) |

**Timing rules:** a leg spawns only after **all previous-leg tasks are `done`** — the derived leg gate (§12), no `completed` event required · a task spawns only after its parent's artifact exists (artifact gate — satisfied by a locked artifact **or structured commit evidence**, §14) · appends happen at each lifecycle transition (activated, evidence, artifact-locked, completed, failed, superseded, waiting).

**THE DEFER-RECORD RULE (v14 — the amendment; core-design §"the mechanism", §3, §4).** v13 §4 read *"`artifact-locked` is written the moment the artifact locks"*. **v14 SPLITS the file write from the event write:**

- **FILES ARE WORKING STATE; EVENTS ARE ACCEPTANCE.** A step's produce-artifact intent **materializes the working file IMMEDIATELY** — a task-local real file in the task's `artifacts/`. Rework **re-writes** it. Nothing is recorded.
- **THE `artifact-locked` EVENT RECORDS AT COMMIT** — after gate② (`confirmed(gate=confirm)`) — a THIN record only (v16): the path, the raw-file hash, the log-derived version, the optional type tag. There is NO shared placement step — no `docs/<category>/<name>-v<N>.md` materialization, no symlink, no marker stamp (the collapse, leg 07). **Deferred child spawns record there too** (both are acceptance-shaped writes; the commit phase orders **locks before spawns**, so a child's `requiredInputs` always resolve via `current()` when its spawn runs).
- **WHY (the rationale this amendment records):**
  1. **A rejected task never leaves a draft in the shared contract stack.** Under "record on write", a rework had to either edit a locked artifact (forbidden — change-protocol §1) or write `superseded` on a LIVE node (which collapses that node's status, §3). Deferral removes the dilemma: rework re-writes a working file, and **no `superseded` is ever written on a live node**.
  2. **The gate sequence invariant is satisfied by construction** — commit follows gate②, so an `artifact-locked` event can never precede its confirmation.
  3. **Replay is safe.** On crash-resume the file already exists (working state) and no event was written, so the step re-runs without double-locking; the one-current-per-name rule is never contended by a rework.
- **CONSEQUENCES, STATED:** a task's artifacts and its deferred child spawns **die with a `failed` task** — acceptance-shaped writes die with acceptance · there is **no spawn-and-consume in one run** (the child does not exist until the parent commits) · verify checks **OUTPUTS** (materialized files, `evidence.commits[]`), never acceptance events, because the acceptance events do not exist yet · the gate②-recorded `confirmedSha` (§3) is what binds the confirmed bytes to the committed bytes.
- **HISTORICAL RECORDS ARE UNAFFECTED.** Every `artifact-locked` event recorded under v4–v13 stands exactly as written (append-only, §3). Defer-record changes *when the engine writes*, never what a past event means.

## 5. Logical names & resolution

- **Every artifact carries a logical name**, globally unique within the store (`requirements-spec`, `journey-format-spec`, `flow-control-spec`, `change-protocol`, …). **A superseding artifact reuses the name.**
- **The correct path is never stored as a live pointer.** Paths are *facts in events* (`artifact-locked` records name+path+sha; `superseded` records the successor). No mutable "current → path" mapping. *(v16: under the collapse there is no symlink at all — the recorded path IS the producer's own file, and resolution derives the path purely from the log.)*
- **Resolution is derived at read time** — a pure function of the log: `current(name)` = the artifact of the `artifact-locked` event with that name whose producer is **not superseded**. "Latest" is guaranteed by the **one-current-per-name validator + superseded events**, never by timestamp comparison.
- **Durable references are logical names + stable section anchors** (`requirements-spec §5`), never paths. **Section anchors never renumber** across supersessions (new sections append; validator-enforced).
- **One current per name** — an artifact may lock only if no other non-superseded artifact shares its logical name (validator error otherwise). **(v14: because locks record at commit, a rework never re-locks — the rule is never contended by a live node, §4.)**
- **Resolution verification (fail-closed):** file exists at the derived path · an `artifact-locked` event matches that exact path+name · no later `superseded` for it. Any mismatch = validation error, blocker named.
- **Forward pointers:** every `superseded` event names its successor; a historical direct-path reference follows the pointer — never a dead end.
- **Historical records may use paths/shas** (events, git, changelog notes); only durable references are logical names.

## 6. Node discovery — the derived commands (v4 card REMOVED in v13)

- The v4 "description.md AI-facing card" is **removed** (v13): nothing read it — it was write-only, no consumer materialized, and the derived commands cover everything it offered, live:
  - `ann status [filter]` — every node's derived status (find by id substring)
  - `ann journey` — the look-back + frontmost-ready
  - `ann detail <id>` — the full node card: contract · gates · artifacts (roles) · blockers · events tail
  - `ann results <id> [n]` — a node's results by kind, drillable
  - `ann branch <id>` — a node + descendants' event walk
- **Read discipline:** agents **never read `events.jsonl` directly** — state is understood through the derived commands. `events.jsonl` is a **machine-parse-only log**; a raw read can surface stale or legacy facts that the derived state ignores by construction. The commands are the interface; the log is not. **(v14: this now covers the TRANSCRIPT — `trace` records are machine-truth for replay, not reading material; the derived views summarize them.)**
- **Discovery (deferred):** a `search` command over contract content (intent · acceptanceCriteria · summary) is planned but NOT built — node discovery today = `status [filter]`, `journey`, and grep over `node.json` files.

## 7. Engine ACs

- F-AC1..F-AC13 — v3 (strict validation, append-only enforcement, derived status, prefix order, path-discoverable artifacts, no edit/re-parent API, lossless round-trip, leg gate, parallel group, sibling retry, pruning, resolution).
- **F-AC14 (v4):** events are ordered by append order, never by `at`; `spawned` is not an accepted type.
- **F-AC15 (v5) — gate invariants:** the validator flags every node whose `completed` lacks a later `confirmed (gate=confirm)` — deterministic, no model judgment. A `submitted` without a decision = `blocked`.
- **F-AC16 (v6) — closure invariants:** completed-after-`gate-revised` requires `transferred` or `deferred`; `transferred` targets must exist; closure is never prose-only.
- **F-AC17 (v7) — leg-status invariants:** the validator derives leg status from children: all tasks `done` → leg `done`; else the leg's status = the frontmost-ready child's; no tasks → `queued` (a leg without tasks can never be `done`). A leg root carrying ANY event (new legs; pre-v7 roots grandfathered, §12) = validator error. **Gate/closure rules (F-AC15/16) apply to TASKS only — leg roots are skipped**, so legacy root events can never trip or contradict gate checks.
- **F-AC18 (v9; v10 amended) — conclusion invariants:** every completed TASK (spawned under v9+) must conclude with **a locked artifact (document) OR structured commit evidence** — an `evidence` event with a non-empty `commits[]` (the machine-truth record of the task's output, §3/§14). A task that produced nothing records the reason in its completed note or an evidence event. The one-time migrations (§15) are exempt. **(v14: an `evidence` event carrying ONLY a `trace` record does NOT conclude a task — the transcript is process, not product; and a `waiting` record concludes nothing.)**
- **F-AC19 (v11) — contract self-sufficiency (the checklist, §2):** every node contract must have a non-empty `intent` and non-empty `acceptanceCriteria` (each entry non-empty), and every `requiredInputs` entry must resolve via `current()` (a logical name of a current artifact). **Enforced at spawn (hard reject, named failures) and in `check()` for v9+ nodes** (pre-v9 contracts grandfathered — same cutoff as F-AC18). A contract that fails the checklist cannot be spawned: defining a task means following the checklist. **(v14: the new `workType`/`flow`/`model` fields are OPTIONAL and inert to F-AC19 — they select behaviour, not sufficiency.)**

## 8. Depth policy (absorbed from depth-policy.md, 11c3de2)

- **Depth expectation:** typical 2–5 levels (leg/name = 2, sub-steps +2 per nesting); budget **≤ 8 levels and ≤ 260 chars full path** (Windows-compatible). Approaching the budget = rebalance signal.
- **Sibling-correction (main control):** repairs/retries/amendments are **siblings at the same level** with a higher prefix — never nested children. Failure never adds depth. **The closure task is a sibling too (v7).** **(v15: the REWORK rule is spelled out in §16 — a rejected task's rework is a NEW superseding sibling, never an edit; `node.json` is immutable, §2.)**
- **Pruning:** completed/superseded subtrees may be removed from the working tree; git is the archive and source of truth. Active tree = live frontier + recent/adjacent nodes.
- **Name discipline (v15 amended):** path segments ≤ 40 chars (**RAISED from 24 — the v15 task grammar `<NN>-<worktype>-<slug>` is infeasible at 24: `27-implementation-journey-format-v15` is 35 chars — and enforced by spawn `id-naming` + the `name-discipline` check rule**), kebab-case, **no dates** in segment names, and **no self-referential task-version counters** — the `-v<N>` form is permitted in a SLUG only as the **TARGET artifact version** (the version a task exists to produce — §16 point B: e.g. `implementation-journey-format-v15`), never as a count of the task itself. **Enforced for NEW nodes** (v4); existing over-length names (`05-requirements-amendment`, `03-change-protocol-amendment`, `08-system-design-validation`) are historical — no hot migration.
- **Pure decomposition still nests:** honest depth (a node whose contract genuinely decomposes) is bounded by the work itself, never by failure.
- **Node count: no limit** (the format caps nothing; big-data query performance N/A for v1 — requirements-spec §7 A4).
- **A proposed child is a leg SIBLING (depth 2) (v14):** a task's `propose-spawn` creates a task **under the leg**, never a depth-3 child of the proposing task — a depth-3 node is invisible to `frontmostReady`/`tasksOf` and could never be scheduled. Honest decomposition inside a task still nests (above); *schedulable* work is depth 2.

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
- Empty `note` valid; unknown field/event type rejected.
- **Artifact ref via symlink (v9 — LEGACY-ONLY as of v16):** `readFileSync`/`existsSync` follow the symlink transparently — a shared document artifact's content reads identically whether at its `docs/` location or its task-local `artifacts/` ref; the blob-sha integrity check is therefore unaffected by the relocation. A broken symlink (content file missing) = validation error, blocker named. **(v10) Task-local artifacts (goal, reports, grandfathered records) are REAL files in `artifacts/` — no symlink.** ***(v16) New locks have no symlink at all — the recorded path is the producer's own real file; this case governs legacy reads only.***
- **External artifact (v9):** a product not inside the project is referenced by a link (URL) in an evidence/record; existence is not file-checked — the link is the durable ref.
- **Empty task (v9):** a task that produces nothing concludes with a reason — the completed note or an evidence event records why; a locked artifact is not forced.
- **Commit traceability (v10):** structured `commits[]` must resolve (`git cat-file -t <sha>` succeeds) and `refs[]` paths exist; unresolvable → validator error. **Exemption: the one-time migrations (§15) — pre-v10 artifacts whose commit history is untraceable are skipped, never failed.**
- **A task that FAILS after producing a working file (v14):** the file stays on disk, task-local and unrecorded — **it is outside the integrity model** (`check()` is event-anchored: a file with no `artifact-locked` event is invisible to it). It is never pruned automatically and never enters `docs/`. This is deliberate: working state is not history.
- **A `waiting` record that is never cleared (v14):** the task stays `blocked` forever — correct and visible. `waiting` is a wait, not a failure; escalation is a human decision (retry / transfer / close, flow-control §5), recorded as events like any other.
- **Gate②-confirmed bytes ≠ committed bytes (v14):** the commit phase recomputes the marker-stripped blob sha and compares it to `submitted.confirmedSha`; mismatch → the frame writes `failed` with the named blocker. The task concludes (every task concludes, §14) — it does not silently commit unconfirmed content.
- **A `trace` record whose replay lookup MISSES (v14):** the ability falls through to a **live call** and appends the result at the next `seq` under the same `runId` — a miss degrades to real work, never to a crash and never to silently skipped work.
- **Two shared artifacts whose `-v<N>` would collide (v14, §15):** the commit phase picks `N` = (highest existing `N` for that logical name) + 1, derived from the recorded `artifact-locked` paths — never from a counter and never from the filesystem alone. ***(v16) The log-derivation survives (recorded as `artifact.version`), but the COLLISION case is moot for new locks — there is no `docs/` filename for two artifacts to share.***

## 10. Non-goals (v1)

- No DAG edge files / cross-task joins (deferred — requirements-spec §3; independence is the v1 default).
- No binary blobs in artifacts (text/structured only).
- No live pointer maintenance — logical references are resolvable, not kept fresh. *(The `docs/` relocation uses filesystem symlinks — a mechanical ref, not a maintained logical pointer.)*
- No hot-migration of existing trees — **except** the sanctioned one-time migrations (v8 flat shape; v9 artifact relocation; v10 task-local return; v12 the `.ann/` layout) which are explicit, reviewed, single-commit operations.
- **No prose as truth (v14)** — the transcript is a STRUCTURED record (`trace`), never a narrative; `note` remains human-facing decoration over machine-truth fields.

## 11. Evolution — supersede, never edit

- This spec is immutable once locked. Amendments = **new nodes** (tasks) whose artifacts **completely supersede** it — reusing the logical name `journey-format-spec` and preserving section anchors — with a back-reference + `superseded` event. Node structure updates are tasks, and tasks are nodes: the table cannot be reshaped by editing — only by growing (change-protocol v2).
- v7 was produced after the L5 incident: the leg root asserted `done` + "all gates confirmed" while tasks 16/17 held no confirmations — a contradiction only a validator could have caught. v7 makes the contradiction **impossible by construction**: leg status derives from tasks, so a leg can never claim what its tasks don't substantiate.
- v9 closed the artifact seam: under v8, a code task had no lockable artifact type, so the artifact gate was mechanically un-satisfiable for code tasks. v9 made the artifact universal via the record doc.
- v10 replaces the record doc with **structured commit evidence in events** — the tree IS the log (NFR-OBS-1); a code task's output (commits + refs) is machine-readable from events, never prose-parsed (NFR-COM-1). The record doc is deprecated; task 05's `s2-record` is grandfathered (its `artifact-locked` event cannot be un-written — append-only).
- v11 makes **task self-sufficiency** a contract invariant (F-AC19): the task-definition checklist (intent · ACs · grounded inputs · targets · outputs · open questions · work type) is in §2, items 1–3 enforced by code — defining a task means following the checklist.
- v12 moved the ann-owned files under `.ann/`; v13 removed the `description.md` card (write-only, no consumer).
- **v14 records the core-design amendments** (`core-design` @ f7fb400 — the L0–L3 re-implementation contract). Four changes, one theme: **the format must be able to express what the coordinator actually does.**
  - **§2 flow fields.** The chain a task runs is data (`workType` / `flow`) and so is its model. v11 said the work type should be "determinable from intent" — a coordinator cannot select a chain from a hint, so v14 makes it a field. `openQuestions` is stated as a top-level sibling because the schema block always had it there while the engine's write and read paths had drifted into `contract.openQuestions`; **the drift is corrected in the engine as part of this amendment, not left as a documentation claim.**
  - **§3 the transcript.** Replay determinism needs the model completions and the human answers to be *facts in the log*, keyed by identity. Putting them in `evidence.trace` reverses the earlier two-log split (op-log = metrics, never text) and pulls NFR-SEC-1 over prompt text — stated, not hidden. The frame-phase kinds (`verify`, `skip`) exist so that a retry and a skipped conditional step are **derivable from the tail** (NFR-OBS-1): a branch that leaves no record is a branch the journey cannot review.
  - **§3/§4 defer-record.** The measured problem: recording the lock at write time forced a rework to either edit a locked file or write `superseded` on a live node — the first is forbidden, the second collapses the node's status. Splitting *file* (working state) from *event* (acceptance) dissolves it, and makes the gate-sequence invariant hold by construction. This is the amendment's load-bearing deviation from v13 §4, and §4 records the rationale rather than leaving the contradiction implicit.
  - **§3 `waiting`.** `blocked` derived only from an undecided human gate, so "the runner hasn't committed yet" had no honest expression — the frame would have had to fake a gate or fail a healthy task. A new kind is cheaper than a lie.
  - **§14/§15 the filename rule.** The `-v<N>` convention has governed every shared document since v9 but was never written down; an unwritten convention is not a contract. It is ADDED here, not amended.
- **v15 records the task-splitting + task-naming convention.** The task id and the task's scope were never designed — ids accreted organically (five amendment slug shapes for one act, `s<N>` slice ids doubling the sort prefix, opaque slugs like `16-layout-ann`), and the v14 `workType` field sat on ZERO nodes. One theme: **the id and the scope are now written down.** §16 defines the grammar `<NN>-<worktype>-<slug>` (one shape per act — an amendment is always `implementation-<name>-v<N>`), the worktype→task-kind mapping, the splitting rules (one cohesive deliverable per task · amendments = their own task · rework = a superseding sibling, never an edit), and the task-in-leg vs NEW-LEG decision rule. **The 24-char segment cap is RAISED to 40** — the grammar is infeasible at 24 (`27-implementation-journey-format-v15` is 35 chars) — and the code follows: `spawn`'s `id-naming` reject and the `name-discipline` check rule both move to 40 (the derived `rules/check/rules.json` regenerates). **Forward-only:** existing task ids are not renamed (renaming breaks immutable refs / F-AC18); the grammar governs new nodes.

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
- **Depth policy (§8)** applies unchanged; the children filter is `depth === 2` (leg/task) in the resolver and validators. **(v14: this is why a proposed child is a leg sibling — §8.)**
- **Task shape (v15 — one cohesive deliverable per task):** a task is ONE gate-able, evidence-able unit with a named contract — one deliverable (one artifact to lock, or one coherent unit of commit evidence), one gate sequence, one conclusion. A task that decomposes into independently-gateable deliverables is SPLIT into sibling tasks; amendments to locked artifacts are always their own task; a rework is a superseding sibling, never an edit — the full splitting rule and the task-vs-new-leg decision are in **§16**.

## 14. The artifact model (v9 — NEW; v10 amended; **v14 amended**)

**The shape (v16 — the COLLAPSE).** An artifact = **a logical name + a THIN LOG RECORD over the producer's own file + commit clues + a conclusion**:

- **file ref (v16)** — `lock! <id> <name> <path> [type]` records `{name, path, lockSha, type?, version?}` over a **project-relative `path` that the producing task already wrote** (its own file, wherever it lives — any file type, F3). ann **verifies the path exists, hashes the raw bytes, derives `version` from the log, and records the event**. It **NEVER writes, copies, stamps, or symlinks the file** (AC1 — the bytes on disk are untouched). **External products** (outside the project) are referenced by a **link** (URL) — no file existence check.
- **commit clues (v10) — STRUCTURED EVENTS, not docs.** A code/implementation task's output is its commits + refs, recorded as an `evidence` event with `commits: [{sha, note?}]` and `refs: [paths]` (§3). Machine-readable, never prose-parsed. **The record doc is DEPRECATED as the way to satisfy the artifact gate** — it was a v9 stopgap; the structured event is the honest form and satisfies F-AC18 directly. *(A record doc remains a legitimate task-local ARTIFACT when the record itself is the product — e.g. a deferral record; it is simply no longer required to make a code task lockable.)* Grandfathered: task 05's `s2-record`.
- **conclusion** — what the task concluded, in the `completed` event note or an evidence event. A task that produced nothing records the reason; a locked artifact is not forced.

**THE FILENAME RULE (v14 — SUPERSEDED by v16).** v14's rule named the shared content file `docs/<category>/<logical-name>-v<N>.md` and derived `N` from the log. **v16 RETIRES the placement entirely** — there is no `docs/`, no category, no `-v<N>` filename:

- **An artifact's content is the PRODUCER'S OWN FILE**, named whatever the producing task names it. Nothing is mirrored, versioned, or symlinked on disk.
- **`version` survives as LOG DATA ONLY** — derived from the log as (highest recorded `N` for the logical name) + 1, recorded on the `artifact-locked` event (`artifact.version`). It never appears in a filename.
- **`type` is an optional free-form tag** recorded on the event; it selects nothing and places nothing (the vocab `artifactTypes` registry is inert data — `unknown-type`/`no-working-file`/`placement-collision` no longer exist).
- **The recorded `path` is the ref.** Referrers resolve via `current()` (§5); a path never carries a version.
- **Historical exception stands:** files that landed in `docs/` under v9-v15 (the 12 inert symlinks cleaned up in this amendment, §15) stand as recorded — their `artifact-locked` paths are facts, and the legacy-reader rule keeps them readable. The thin rule governs new files; it never rewrites history.

**No strict work-type → artifact-type mapping.** A task produces *whatever* it produces. The following table is **guidance** (what to expect, never a constraint):

| Work type | Typical artifact | Content |
|---|---|---|
| idea (chain seed) | document (task-local) | the idea statement |
| validate/grilling (F4) | document | validation (verdicts + claims + provenance) + batch questions |
| envision (F8) | document | product vision: usage + look + open questions |
| spec/planning (F9) | document | detailed specs (requirements, ACs, scope, data, NFRs) |
| implementation | **commit evidence (events)** | `evidence.commits[]` + `refs[]` — the code's commits, machine-readable |
| binding/external | events or link | provenance: action, result, response; or the external link |
| closure/amendment | events or document | gate-revised + transferred scope verbatim; the superseding spec |

- **Every task concludes.** Completion requires a locked artifact (document) **or** structured commit evidence (F-AC18, §7); an "empty" task records its reason. **(v14: a `trace`-only evidence event does not conclude; a `waiting` record does not conclude.)**
- **The artifact gate is satisfiable for every task type.** A code task's commit-evidence satisfies the gate (§4), so code tasks can spawn children.
- **Commit traceability (v10).** Structured `commits[]` must resolve — the commit exists in git (`git cat-file -t <sha>`) and `refs[]` paths exist. Enforced by the validator (F-AC18); the one-time migrations (§15) are exempt. *(Presupposition for implementation tasks: task code is committed with descriptive messages.)*
- **Working files are not artifacts (v14).** A file a step wrote but no `artifact-locked` event records is **working state** — task-local, unpoliced, outside the integrity model. Acceptance is what makes a file an artifact — the `artifact-locked` event is the whole difference, and under the thin model (v16) it changes **nothing on disk**.

## 15. docs/ — RETIRED (v16; the layer's history)

**The `docs/` layer is GONE as of v16.** `docs/` (i.e. `.ann/docs/`) was the **SHARED contract-stack mirror** — shared document artifacts categorized by type, `-v<N>`-named, with the producer's `artifacts/` holding a symlink into it. The artifact collapse (leg 07) made every artifact a **THIN RECORD over the producer's own file**, so there is nothing left to mirror and no shared placement to maintain. **This amendment deletes the 12 inert `.ann/docs/` symlinks and removes the directory.**

**Why it could be retired.** The collapse removed every consumer: `lock!` no longer places files (`place()`/`workingFile()` deleted), `read`/`current`/`specs` are pure log-derived views, and `verify` no longer checks the docs layer (the D3/D5 docs checks are deleted). A `docs/` entry today is inert filesystem history, invisible to state.

**The LEGACY-READER rule (v16 — NEW).** Old marker-stamped files and old `docs/`-recorded paths keep working forward-looking:

- **Marker tolerance.** A locked file's `lockSha` is verified over MARKER-STRIPPED content and `read` still serves marker-stripped content; on a file with no marker the strip is a **NO-OP**, so the thin model reads old stamped files and new raw files identically.
- **Legacy recorded paths resolve.** The `legacyPath()` normalization still maps recorded `journey/` → `.ann/journey/`, `tree/rounds/` → `journey/legs/`, and `00/` levels to flat — historical `artifact-locked` paths keep resolving to real producer files even though the `docs/` symlink some of them may have traversed is gone.
- **No data migration.** Every `artifact-locked` event recorded under v9-v15 stands exactly as written (append-only, §3); the collapse changes *what the engine writes*, never what a past event means.

**The migrations, for the record.** The historical migrations stand as history: the v9 hot fix (27 content files → `docs/`, symlinked) · the v10 task-local return (`docs/records/` removed: `goal.md` → `01-goal/artifacts/`, `conformance-report.md` → `05-engine/08-system-design-validation/artifacts/`, `s2-record.md` → `06-engine-build/05-s2-envision-grilling/artifacts/`) · the v12 `.ann/` layout. **v16 is the REVERSE migration: the mirror is deleted, not relocated** — no event rewrites, no new files, just the 12 inert symlinks removed. *(The v14 platform caveat about symlink fragility is moot — there are no more ann-owned symlinks.)*

## 16. Task splitting & naming (v15 — NEW)

**Why it exists.** The task id and the task's scope were never designed — ids accreted organically, and `contract.workType` (v14 §2) sat on ZERO nodes. The measured mess: **five slug shapes for the same act** ("produce a superseding spec"): `format-amendment-vN` · `flow-control-vN` · `journey-format-v14` · `amend-architecture-v3` · `requirements-amendment`. **Double numbering**: `04-s1-tree-store` carries both a sort prefix and a slice id. **Opaque slugs**: `16-layout-ann` · `24-core-reimpl` · `15-system-design-stack` · `26-artifact-ownership`. This section writes the convention down — the grammar, the worktype→task-kind mapping, the splitting rules, and the task-vs-new-leg decision. **Forward-only:** nothing here renames an existing task (renaming breaks immutable refs / F-AC18); the convention governs NEW nodes.

### The grammar (v15)

- A new task's last segment is **`<NN>-<worktype>-<slug>`**:
  - **`NN`** — a zero-padded 2-digit sort prefix (01–99 per sibling set; `00` is illegal — v8 removed the `00/` level dir). The store orders by plain lexicographic `.sort()` over the full id (§1/§3), so the **zero-pad IS the ordering guarantee** — keep it load-bearing; never rename it.
  - **`<worktype>`** — the task kind, one of the six flow selectors (§2 / flow-control §7): `validate · envision · spec · implementation · binding · closure`. It selects the chain **and** names the kind (the worktype→task-kind mapping below).
  - **`<slug>`** — a short kebab-case noun phrase naming the deliverable (slug semantics, below).
- A leg segment stays `<NN>-<name>` (legs are epics, not tasks — no worktype).

### The worktype → task-kind mapping (v15)

| workType | task kind | typical deliverable |
|---|---|---|
| validate | validation/grilling | a validation document (verdicts + claims + provenance) + batch questions |
| envision | envisioning | a product vision document (usage + look + open questions) |
| spec | specification/planning | a NEW detailed spec — the FIRST version of a contract (requirements, ACs, scope, NFRs) |
| implementation | build slice · spec/format amendment | code (**structured commit evidence**, §14) OR a **COMPLETE SUPERSEDING artifact** — the `-v<N>` of a locked contract (§14/§15) |
| binding | external binding | a provenance record (action/result/response) or an external link |
| closure | closure | gate-revised + transferred/deferred scope verbatim (events, F-AC16) |

*(The locked mapping: build slices + spec amendments → `implementation`; closures → `closure`; validate/envision/spec/binding for their kinds. An amendment is `implementation` work — it implements a change to a locked artifact, and its `implementation` chain is the EMPTY lifecycle (flow-control §7): the runner produces the complete superseding artifact, outcomes observed as commit evidence.)*

### Splitting — one cohesive deliverable per task (v15)

1. **One deliverable per task.** A task's contract names exactly ONE deliverable — one artifact to lock, or one coherent unit of commit evidence — one gate sequence, one conclusion. A task with two independently-gateable deliverables is two tasks.
2. **Independent work → sibling tasks.** When a piece of work decomposes into independently-gateable deliverables, split it into SIBLING tasks under the leg, each with its own named contract, ordered by prefix.
3. **Amendments are always their own task.** A change to a locked artifact is never folded into another task's scope — it is its own amendment task producing a complete superseding artifact (change-protocol §3), a sibling of the original producer with a higher prefix (§8).
4. **A rework is a new task, never an edit.** A rejected task is NOT edited. The rework is a NEW superseding sibling (sibling-correction, §8, higher prefix) carrying the corrected contract; the rejected node stands as history. *(`node.json` is immutable, §2.)*
5. **Evidence-ability.** Every task must be able to conclude (F-AC18, §7): a locked artifact or structured commit evidence. If a slice cannot name its conclusion, it is not cohesive — split or re-scope.

### Task-in-leg vs NEW LEG — the decision rule (v15)

A new piece of work is a **TASK in the current leg** iff ALL:

- (a) **Same epic** — it advances the current leg's goal (its intent traces to the current epic's ACs; it is not a different goal), AND
- (b) **Schedulable now** — its `requiredInputs` resolve via `current()` without waiting for the leg to be `done` (it can run as a sibling now, after a lower-prefix sibling, or in parallel), AND
- (c) **Cohesive** — it is one gate-able, evidence-able deliverable (splitting rule).

A new piece of work is a **NEW LEG** iff ANY:

- (1) **New epic** — it is a distinct goal, not part of the current leg's goal, OR
- (2) **Sequential after the leg** — it structurally requires the current leg to be `done` first (its inputs are the current leg's outputs; the engine's LEG GATE — §12 — IS the sequential-dependency mechanism), OR
- (3) **Transferred scope** — it is the continuation of a closed leg's goal after a closure-by-transfer (the transferred scope becomes the next leg's epic; flow-control v6 §5).

Special cases:

- **Amendment to a locked artifact → a TASK in the active leg** (sibling-correction, higher prefix), never its own leg and never an edit — a single amendment is part of the current epic's contract-stack work, not a new epic.
- **A rejection that invalidates the EPIC** (not just the task's approach) is a closure decision: a closure task (same leg, worktype `closure`) records the transfer; the next leg carries the revised epic.

### Slug semantics (v15 — points B & D)

- **Short, self-describing, kebab-case noun phrase** naming the deliverable or action: `runner-reviewer` · `github-binding` · `human-interface` · `eval-harness` · `tree-store` · `journey-format-v15`.
- **No dates** (`2024-…`), **no abbreviations** (`impl` · `specs` — the worktype already names the kind), **no slice ids** — the `s<N>` tags (S1–S9) were project-local to `06-engine-build` and are **DROPPED** (point C): the worktype + slug carry the same information more durably; existing `s<N>` tasks keep their ids, forward-only.
- **`-v<N>` in a slug = the TARGET artifact version** (point B): allowed when producing that version IS the task's purpose (`implementation-journey-format-v15` produces journey-format-spec v15). It is **never** a counter of the task itself and never a revision of the task's own approach.
- The slug need not reproduce the logical name verbatim — it must let a reader say what the task produces.

### The grammar in action

- **Amendment:** `implementation-journey-format-v15` — the ONE shape replacing the five amendment slug variants.
- **Build slices:** `implementation-runner-reviewer` · `implementation-github-binding` · `implementation-human-interface` · `implementation-eval-harness`.
- **Rework:** the rejected `09-implementation-runner-reviewer` reworks to `10-implementation-runner-reviewer` (a superseding sibling, higher prefix) — never an edit.
- **Validation of a spec:** `validate-core-design-v3`. **Envision:** `envision-ann-web-ui`. **New spec:** `spec-requirements-v4`. **Binding:** `binding-github-oauth`. **Closure:** `closure-06-engine-build` (the closure task, §12).

*(Historical note: `27-journey-format-v15` — the task producing THIS artifact — is named legacy-style (no worktype) because it is the last task spawned under the v14-era 24-char cap; a worktype-tagged proof-of-concept name (`27-implementation-journey-format-v15`, 35 chars) was impossible before the cap raise this very amendment performs. The grammar applies from the next task onward.)*
