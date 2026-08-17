# Ann System Design (v2)

*Artifact of task `05-engine/00/10-system-design-amendment`. Type: system-design. Complete superseding version — v1 + the conformance closures (per-task model selection · two-log trace · F9 owner · single-writer cross-ref · coverage criterion). Produced per the change protocol: amendment node → complete artifact → superseded event. Upstream: `tree/rounds/01-goal/artifacts/design.md` (v3, locked), `requirements-spec` (v3, locked), `tree-format-spec` (v4, locked), `architecture` (locked). Referrers: S1–S9 implementation slices, design tasks, review-task.*

## 0. Q1–Q4 resolutions (blocking questions closed)

- Q1 runtime: **Node.js + TypeScript** — single-process CLI in v1 (scope), single-writer/shared-readers concurrency model per architecture LB-1.
- Q2 model provider: **adapter-first, multiple providers + per-task model selection** (v1 grain = task — each task may specify its provider/model; F17 config holds provider/model lists + defaults; tasks override; swap by config, never by code).
- Q3 storage: **the file tree per tree-format-spec v4 IS the source of truth. No SQLite in v1** — realistic v1 tree sizes make full-tree scans trivial (no node-count limit per requirements-spec §7 A4; big-data query performance N/A for v1); a read-only in-memory index is built at startup from the files. Revisit only at scale. *(Deviation from the recorded default — justified by scale assumptions §5; nothing else reads the store.)*
- Q4 UI: **CLI is v1** — `tree view`, `step cards`, `full plan` renders. **Web UI is the target surface** (architecture rung 2); the human-interface adapter makes the surface swappable (CLI talk → web HTML).

## 1. Components & ownership

*Coverage criterion: every component serves at least one function (F1–F17) OR a flow step consumed by a function; no orphans.*

| Component | One-line job | Refuses to | Owner (slice) |
|---|---|---|---|
| **Tree store** | Reads/writes rounds, nodes, events, artifacts per format v4; builds the in-memory tree; enforces schema, append-only, immutability, round gate; **owns the single `appendEvent()` write function** (architecture LB-3 — the only writer, unified-format choke point); exposes derived views (status/resolution/tree) for shared readers | Rewrite history · reorder/delete events · accept a write outside `appendEvent()` · spawn round N+1 before N's `completed` · accept unknown fields/types | S1 |
| **Planner kernel** | Orchestrates node lifecycle per flow-control-spec (spawn → materialize → gates → validate → activate → execute → verify → commit), frontmost-ready selection, bounded rework + chain append; consumes the project's flow config; **owns spec expansion** (F9: detailed specs from the vision — the planning engine) | Edit nodes · run unbounded loops · skip a human gate · spawn children before the artifact gate | S1/S5 |
| **Flow config** | Reads/validates per-project step chains (data, not code — requirements-spec AC-3); exposes the chain to the planner kernel; hosts step-chain templates (F3) | Hard-code flows · let code override project config | S5 |
| **Envision engine** | Runs the envision step (F8): helps the builder imagine usage + look, sorts out what to build, avoids mistakes; produces the vision artifact | Invent requirements · skip the human gate | S2 |
| **Human interface** | Presents step cards + artifacts at the human gates (GATE① grilling, GATE② confirm-result); collects accept/reject + feedback — the talk-loop (F7); talk v1, **web HTML via the same adapter** (web UI = target surface) | Skip a gate · fabricate an acceptance · invent feedback | S8 |
| **Grilling engine** | Runs the validate/grilling step (F4 — the idea's exit gate) and requirements-grilling (template + LLM) → validation + questions, or PRD artifact; **not the spec step** (that is the Planner kernel) | Invent facts · fake precision on novel work (§21.6) | S2 |
| **Context assembler** | Materializes per-node context packets (deterministic 6-layer, §21.7) — consumed by F5/F7 execution | Include unprovenanced facts · put the whole tree in a packet · let LLM summarization override the deterministic skeleton | S3 |
| **Validators** | Deterministic checks: schema, artifact gate, append-only, round gate, distance-to-goal as set, redaction — served in F7 (gates) + F16 (check) | Judgment calls (that is the reviewer's job) · scalar progress numbers | S4 |
| **Runner reviewer** | Runner-simulation review per node ("can the runner execute without guessing?") — consumed by F7 (gate② review) | Pass blocking confusion · unbounded review loops (max iterations) | S6 |
| **Provider adapter** | Uniform LLM interface (grilling, envision, spec, review, optional summarization); **multiple providers + per-task model selection** (each call carries its model spec; F17 lists + defaults; tasks override); retries + rate-limit handling | Leak provider specifics into plan semantics · degrade silently · fabricate on failure | S2/S5 |
| **GitHub binding** | Create issue/PR (F13); record action + result as provenance artifact (AC6); confirm before destructive | Act without confirmation on destructive actions · fake success on failure | S7 |
| **Renderers** | Tree view, step cards, full plan (F10/F11/F12 + card at F7) | Render scalar progress (AC5) · show secrets | S8 |
| **Eval harness** | Run fixture suite; measure K1–K5; regression goals (F16 + KPIs) | Count unverified ACs as passes | S9 |

## 2. Data model

- **Entities:** `Round` (dir in `tree/rounds/`, index = chain order, status derived) · `Node` (node.json immutable + events.jsonl append-only + description.md regenerable card + artifacts/) · `Event` `{at, type, note}` + structured `artifact-locked`/`superseded` (format v4 §3; no `spawned` — the child's `created` is the spawn record) · `Artifact` (text/structured files, per-node, immutable once recorded) · `ContextPacket` (frozen schema §3) · `ProjectLog` (the tree's event stream — project memory) · `OpLog` (runtime operational log, see §4).
- **Writers:** appends go through the store's single `appendEvent()` (architecture LB-3). Initiators: planner kernel (spawn/expand/commit), adapters (binding results as artifacts + evidence events), validators/reviewer (evidence events). **Readers:** context assembler, renderers, eval harness, planner kernel — via derived views (shared readers, no cross-process cache in v1).
- **Stale reads:** status is derived from the events tail **at read time**; v1 single-process, in-memory index rebuilt at startup, kept current by direct mutation on append. **Multi-user is a design constraint (requirements-spec §7 A1):** append-only events are concurrency-friendly; identity/permissions are future semantics.
- **Empty records:** node with no artifacts = valid until it must gate children · round with no tasks = valid (root-only) · packet with empty inputs = valid only if the node declares no `requiredInputs` · tree with no rounds = invalid (R1 must exist) · node with no `created` event = invalid.

## 3. Boundaries & interfaces (frozen schemas)

- **Node/event schemas:** `tree-format-spec` v4 §2–3 (locked) — the shared boundary between store, kernel, validators, assembler. No component extends them silently; additions = format amendment.
- **Store API:** `createNode(roundId, nodeJson)` · `appendEvent(nodeId, event)` — **the ONLY write path** (single-writer choke point) · `readNode(id)` · `readTree() → {rounds, nodes, statuses, current(name)…}` (derived views) · `prune(subtreeId)` (validated). Immutability/append-only/round-gate enforced inside the store.
- **Context packet schema (frozen):**
  ```json
  {"pathDecisions":[], "nodeContract":{}, "resolvedInputs":[], "siblingStatus":{}, "bindingState":[], "openQuestions":[{"id","question","default","provenance"}]}
  ```
- **Validator contract:** input `{nodeId}` → output `{findings:[{severity: error|warning, code, detail}]}`; `error` blocks execution.
- **Reviewer contract:** input `{nodeId, packet, artifacts}` → output `{verdict: pass|confusion, findings:[], routeReason?}`; `confusion` triggers subtree re-plan (bounded).
- **Binding API:** `execute({system, action, params}) → {ok, artifactRef?, provenance}` — result becomes a tree artifact (AC6).
- **LLM adapter contract:** `complete(prompt, {provider?, model?, maxTokens}) → {text, usage}` — **provider/model selectable per call** (task grain); bounded retry/backoff; provider errors map to design §12 outcomes, never silent.
- **Renderer input:** derived tree + packets + artifacts → text (no secrets, no scalar progress).

## 4. Trace & observability — TWO distinct logs (architecture rung 4)

1. **Project event log (the tree)** — immutable project memory: decisions, artifacts, status, gates — what happened to the project. Written via `appendEvent()`; replayable.
2. **Runtime operational log (`logs/`)** — the dynamic process: requests sent (LLM/GitHub with provider/model used), errors and where they occurred, timing, retries. **Not in the tree** — the forest holds project state, not request noise. Structured, debuggable, separate.
- NFR-OBS-1 = both: replayable project history + operational trace. A component records project decisions as events; runtime operations go to the OpLog.

## 5. Failure modes

| Component | Down/slow | Garbage | Decision |
|---|---|---|---|
| Provider adapter | Rate-limited/down → bounded retry/backoff, then **fail-closed**: node stays queued, ask_user/block (§12) | Unstructured/empty → treated as failure, never fabricated | fail-closed |
| Tree store | Disk full/write error → commit fails **fail-closed**, node not marked done; resume from last checkpoint (RPO=0) | Schema violation → validation refuses with the violating path | fail-closed |
| Context assembler | Missing required input → packet incomplete → node **blocked** naming the missing input | — | fail-closed |
| GitHub binding | Down → action **fails-closed** (no fake success), node blocked, retry ≤3 | Non-2xx → recorded as failed action with response | fail-closed |
| Human interface | Human unreachable/unresponsive → step stays `blocked`, blocker named; no timeout-fabrication | — | fail-closed |
| Runner reviewer | Model failure → verdict `confusion` (safe default) → bounded repair loop | — | fail-closed |
| Renderers | — | Corrupt tree → refuse render, name the invalid node | fail-closed |
| Eval harness | Fixture fails to run → counted as FAIL (no silent skip) | — | fail-closed |

- **The one failure that would wreck the product:** tree corruption / RPO violation (lost committed node). Mitigation: append-only + artifact checksums + git as archive (format v4 §4/§9); detection: validator refuses on mismatch; recovery: regenerate from git, never silent.
- **Fail-open is never chosen in v1** — every gate fails closed and names the blocker; partial execution only where the plan marks it safe.

## 6. Scale assumptions

- Tree: **no node-count limit** (the format caps nothing); depth ≤ **8 levels**, ≤ **260-char paths** (format v4 §8). Big-data query performance **N/A for v1**.
- Rounds: ≤ dozens. Tasks per round: typical ≤ 20, worst ~100 (fits `00/` one level).
- Write rate: v1 single-user CLI — < 1 event/sec typical; bursts at node commits. Single-writer/shared-readers (architecture LB-1); no cross-process concurrency in v1.
- Context packets: bounded — path + siblings + relevant ancestors (never whole tree); target < 8k tokens.
- Fixture suite: ≤ 50 fixtures; full eval run < 10 min (K1–K5 measured per run).

## 7. Non-goals (v1 design)

- No SQLite/DB index (Q3 — files + in-memory index only).
- No multi-process store access in v1 (single-writer model declared; shared readers fine).
- No DAG/join edges (independence is the default).
- No plugin/marketplace hooks.
- No hosted service (web UI is the target surface but served locally in v1).
