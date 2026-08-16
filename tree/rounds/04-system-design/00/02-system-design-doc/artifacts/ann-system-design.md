<!-- specs:locked:ca32421 2026-08-16 type=system-design -->

## Link contract
- **upstream** (this doc relies on): design,02-grilling/artifacts/ann-spec.md 01-format-amendment-v2/artifacts/tree-format-spec-v2.md
- **referrers** (must cite this when they change): R5 implementation slices,architecture (future) review-task

# Ann System Design (v1)
*Artifact of task `04-system-design/00/02-system-design-doc`. Type: system-design. Upstream: `design` (locked @ eb07146), `02-grilling/artifacts/ann-spec.md` (locked @ 9e37c8f), `01-format-amendment-v2/artifacts/tree-format-spec-v2.md` (locked @ 9e37c8f). Referrers: architecture (future), R5 implementation slices.*

## 0. Q1–Q4 resolutions (blocking questions closed)

- Q1 runtime: **Node.js + TypeScript** — single-process CLI; mature LLM/agent ecosystem; matches original skeleton.
- Q2 model provider: **adapter-first** (§16); first adapter = OpenAI-compatible chat completions via local config/env; swap by config, never by code changes.
- Q3 storage: **the file tree per tree-format-spec-v2 IS the source of truth. No SQLite in v1** — ≤1k nodes makes full-tree scans trivial; a read-only in-memory index is built at startup from the files. Revisit only at scale. *(Deviation from the recorded default — justified by scale assumptions §5; nothing else reads the store.)*
- Q4 UI: **CLI** — `tree view`, `step cards`, `full plan` renders (spec §7). No other surface in v1.

## 1. Components & ownership

| Component | One-line job | Refuses to | Owner (slice) |
|---|---|---|---|
| **Tree store** | Reads/writes rounds, nodes, events, artifacts per format v2; builds the in-memory tree; enforces schema, append-only, immutability, round gate | Rewrite history · reorder/delete events · spawn round N+1 before N's `completed` · accept unknown fields/types | S1 |
| **Planner kernel** | Orchestrates node lifecycle (spawn → materialize → validate → execute → verify → commit), frontmost-ready selection, subtree re-plan with route reasons + bounds | Edit nodes · run unbounded loops · execute unverified nodes · spawn children before the artifact gate | S1/S5 |
| **Grilling engine** | Runs the requirement grilling step (template + LLM) → PRD or open-questions artifact | Invent facts · fake precision on novel work (§21.6) | S2 |
| **Context assembler** | Materializes per-node context packets (deterministic 6-layer, §21.7) | Include unprovenanced facts · put the whole tree in a packet · let LLM summarization override the deterministic skeleton | S3 |
| **Validators** | Deterministic checks: schema, artifact gate, append-only, round gate, distance-to-goal as set, redaction | Judgment calls (that is the reviewer's job) · scalar progress numbers | S4 |
| **Runner reviewer** | Runner-simulation review per node ("can the runner execute without guessing?") | Pass blocking confusion · unbounded review loops (max iterations) | S6 |
| **Provider adapter** | Uniform LLM interface (grilling, review, optional summarization); retries + rate-limit handling | Leak provider specifics into plan semantics · degrade silently · fabricate on failure | S2/S5 |
| **GitHub binding** | Create issue/PR; record action + result as provenance artifact (AC6) | Act without confirmation on destructive actions · fake success on failure | S7 |
| **Renderers** | Tree view, step cards, full plan (CLI) | Render scalar progress (AC5) · show secrets | S8 |
| **Eval harness** | Run fixture suite; measure K1–K4; regression goals | Count unverified ACs as passes | S9 |

## 2. Data model

- **Entities:** `Round` (dir in `tree/rounds/`, index = chain order, status derived) · `Node` (node.json immutable + events.jsonl append-only + description.md + artifacts/) · `Event` `{at, type, note}` + `spawned {parent, order}` · `Artifact` (text/structured files, per-node) · `ContextPacket` (frozen schema §3) · `Trace` (the run's event stream, design §14).
- **Writers:** planner kernel (spawn/expand/commit events, `completed`/`failed`), adapters (binding results as artifacts + evidence events), validators/reviewer (evidence events). **Readers:** context assembler (builds packets from nodes/events), renderers, eval harness, planner kernel.
- **Stale reads:** status is derived from the events tail **at read time**; v1 is single-process, so no cross-process cache — the in-memory index is rebuilt only at startup, kept current by direct mutation on append.
- **Empty records:** node with no artifacts = valid until it must gate children · round with no tasks = valid (root-only) · packet with empty inputs = valid only if the node declares no `requiredInputs` · tree with no rounds = invalid (R1 must exist) · node with no `created` event = invalid.

## 3. Boundaries & interfaces (frozen schemas)

- **Node/event schemas:** `tree-format-spec-v2` §2–3 (locked) — the shared boundary between store, kernel, validators, assembler. No component may extend them silently; additions = format amendment (§11).
- **Store API:** `createNode(roundId, nodeJson)` · `appendEvent(nodeId, event)` · `readNode(id)` · `readTree() → {rounds, nodes, edges(derived), statuses}` · `prune(subtreeId)` (validated). Immutability/append-only/round-gate enforced inside the store.
- **Context packet schema (frozen):**
  ```json
  {"pathDecisions":[], "nodeContract":{}, "resolvedInputs":[], "siblingStatus":{}, "bindingState":[], "openQuestions":[{"id","question","default","provenance"}]}
  ```
- **Validator contract:** input `{nodeId}` → output `{findings:[{severity: error|warning, code, detail}]}`; `error` blocks execution.
- **Reviewer contract:** input `{nodeId, packet, artifacts}` → output `{verdict: pass|confusion, findings:[], routeReason?}`; `confusion` triggers subtree re-plan (bounded).
- **Binding API:** `execute({system, action, params}) → {ok, artifactRef?, provenance}` — result becomes a tree artifact (AC6).
- **LLM adapter contract:** `complete(prompt, {model, maxTokens}) → {text, usage}` with bounded retry/backoff; provider errors map to design §12 outcomes, never silent.
- **Renderer input:** derived tree + packets + artifacts → text (no secrets, no scalar progress).

## 4. Failure modes

| Component | Down/slow | Garbage | Decision |
|---|---|---|---|
| Provider adapter | Rate-limited/down → bounded retry/backoff, then **fail-closed**: node stays queued, ask_user/block (§12) | Unstructured/empty → treated as failure, never fabricated | fail-closed |
| Tree store | Disk full/write error → commit fails **fail-closed**, node not marked done; resume from last checkpoint (RPO=0) | Schema violation → validation refuses with the violating path | fail-closed |
| Context assembler | Missing required input → packet incomplete → node **blocked** naming the missing input | — | fail-closed |
| GitHub binding | Down → action **fails-closed** (no fake success), node blocked, retry ≤3 | Non-2xx → recorded as failed action with response | fail-closed |
| Runner reviewer | Model failure → verdict `confusion` (safe default) → bounded repair loop | — | fail-closed |
| Renderers | — | Corrupt tree → refuse render, name the invalid node | fail-closed |
| Eval harness | Fixture fails to run → counted as FAIL (no silent skip) | — | fail-closed |

- **The one failure that would wreck the product:** tree corruption / RPO violation (lost committed node). Mitigation: append-only + artifact checksums + git as archive (format v2 §6, depth policy); detection: validator refuses on mismatch; recovery: regenerate from git, never silent.
- **Fail-open is never chosen in v1** — every gate fails closed and names the blocker; partial execution only where the plan marks it safe (spec §3).

## 5. Scale assumptions

- Tree ≤ **1k nodes**, ≤ **8 levels**, ≤ **260-char paths** (format v2 §8).
- Rounds: ≤ dozens. Tasks per round: typical ≤ 20, worst ~100 (fits `00/` one level).
- Write rate: v1 single-user CLI — < 1 event/sec typical; bursts at node commits. No concurrency in v1 (parallelism = sequential task group execution; store is single-process).
- Context packets: bounded — path + siblings + relevant ancestors (never whole tree); target < 8k tokens.
- Fixture suite: ≤ 50 fixtures; full eval run < 10 min (K1–K4 measured per run).

## 6. Non-goals (v1 design)

- No SQLite/DB index (Q3 — files + in-memory index only).
- No multi-process/concurrent store access.
- No DAG/join edges (spec §3 — independence is the default).
- No plugin/marketplace hooks.
- No hosted service.
