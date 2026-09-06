## Link contract
- **upstream** (this doc relies on): journey/legs/01-goal/artifacts/design.md, journey-format-spec, flow-control-spec, ann-system-design
- **referrers** (must cite this when they change): S5 planner kernel, S8 human interface, engines, validators, renderers, review-task

# Context Packet Spec (v1)
*Artifact of task `06-engine-build/06-s3-context-assembler`. Type: spec. The CANONICAL field-level schema for the per-node context packet (ann-system-design §3's frozen shape, fleshed out) — the single spec ALL consumers cite: the planner kernel, the engines, the runner reviewer, the renderers, and the gate card. Deterministic assembly (no LLM in v1 — AC-4 guards a future summarizer that never overrides this skeleton). Upstream: `design` (v3, locked), `journey-format-spec` (v13, locked), `flow-control-spec` (v6, locked), `ann-system-design` (v3, locked — its §3 frozen shape is this doc's seed). Referrers: S5 planner kernel · S8 human interface · engines · validators · renderers · review-task.*

## 1. Purpose

- The context packet makes a node **mechanically self-sufficient**: everything a step needs to execute — its route, its contract, its dependencies and whether they are met, its surroundings' status, its open questions — in one deterministic, provenance-labeled, bounded structure. Consumers read the SAME spec; nothing is invented per consumer.
- **Deterministic, derived, never saved:** the packet is assembled on demand from the store's derived views (current(name), statuses, structure). No writes, no LLM, no stored packet file — rebuildable at any time, byte-identical given the same log.

## 2. The packet — canonical schema (field-level)

```json
{
  "pathDecisions": {
    "nodeId": "06-engine-build/06-s3-context-assembler",
    "isLeg": false,
    "leg": "06-engine-build",
    "route": ["06-engine-build", "06-s3-context-assembler"],
    "depth": 2
  },
  "nodeContract": {
    "intent": "string",
    "acceptanceCriteria": ["string"],
    "targetAreas": ["string"],
    "requiredInputs": ["string — logical names"],
    "expectedOutputs": ["string"],
    "openQuestions": [{ "id": "Q1", "question": "string", "blocking": true, "defaultIfUnanswered": "string", "provenance": "declared at spawn" }]
  },
  "dependencies": [
    {
      "name": "journey-format-spec",
      "status": "resolved | missing",
      "path": "string — current artifact path (resolved only)",
      "sha": "string — current lock sha (resolved only)",
      "sourceType": "derived-from",
      "excerpt": "string — bounded head of the artifact (resolved only, capped)",
      "blocker": "string — the missing input named (missing only)"
    }
  ],
  "readiness": { "ready": true, "blockers": [] },
  "siblingStatus": {
    "siblings": [{ "id": "06-engine-build/05-s2-envision-grilling", "status": "done" }],
    "children": [{ "id": "string", "status": "string" }]
  },
  "bindingState": {
    "links": [{ "url": "https://…", "note": "string", "at": "YYYY-MM-DD" }]
  },
  "openQuestions": [
    { "id": "Q1", "question": "string", "impact": "high | medium | low", "default": "string?", "provenance": "string", "status": "open" }
  ]
}
```

## 3. Layer derivation (deterministic — the assembler's contract)

| Layer | Derived from | Rules |
|---|---|---|
| `pathDecisions` | the node's id / structure | `nodeId` · `isLeg` (no `/`) · `leg` (first segment) · `route` (path segments) · `depth` (segment count) |
| `nodeContract` | `node.json` contract | the contract itself (intent · ACs · targetAreas · requiredInputs · expectedOutputs · openQuestions) — never rewritten, read only |
| `dependencies` | `requiredInputs` × `current(name)` | per input: `resolved` → the current artifact's `path` + `sha` + a **bounded excerpt**; `missing` → status missing + the name as `blocker`. `sourceType` is always `derived-from` (resolution via current()). **No inference, no probing in v1.** |
| `readiness` | the dependencies + blocking questions | `ready: true` iff every dependency is `resolved` AND no blocking open question is unanswered; else `ready: false` + named `blockers[]` |
| `siblingStatus` | the leg's task group + the node's children | direct siblings' + children's **statuses only — never content** (leg roots: siblings only, no children) |
| `bindingState` | the node's evidence events | external `links` (evidence.refs[] that are http(s) URLs) — nothing else in v1 |
| `openQuestions` | the contract's openQuestions | declared questions with provenance `declared at spawn`; status `open` in v1 (answers are not yet recorded as structured events) |

## 4. Boundaries & budget

- **Bounded (design scale §6):** total target < 8k tokens — "path + siblings + relevant ancestors", NEVER the whole tree. No ancestor content, no unrelated nodes.
- **Excerpts capped:** each resolved input's excerpt is the bounded head of its artifact (implementation cap, e.g. 2 000 chars); if the budget would overflow, excerpts shrink before anything is dropped — names/paths/shas are never dropped for the budget.
- **Provenance on every fact (AC-2):** every entry carries its ladder label (`derived-from` — current-name resolution; `observation` — probed from git/files, unused in v1). Nothing unprovenanced enters the packet; `inference` never appears in v1.
- **Pure (D6):** the assembler never writes — no `appendEvent`, no stored packet. `ann packet <id>` assembles on demand (D7).

## 5. Consumer contract

- **One spec, all consumers:** the kernel (routing), the engines (dynamic prompt composition — the step-model decision), the runner reviewer (`{nodeId, packet, artifacts}`), the renderers, and the GATE-card packet summary (F7) all read THIS schema. A field added here is a spec amendment; a consumer that needs more reads this doc and proposes the amendment — never a private extension.
- The packet is a READ-ONLY view: consumers derive, never mutate.

## 6. Non-goals (v1)

- No LLM summarization (deferred; AC-4 in the assembler task guards it when it arrives).
- No probing (git/file reads beyond current() resolution) — `observation` provenance is reserved, unused.
- No storing/versioning of packets (derived on demand).
