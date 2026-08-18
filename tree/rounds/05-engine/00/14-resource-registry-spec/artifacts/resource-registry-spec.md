# Resource / Registry Spec (v1)

*Artifact of task `05-engine/00/14-resource-registry-spec`. Type: spec. The general management pattern for **anything configurable that consumers reference** — rules, ladders, adapters, models, flows, bindings, surfaces. One registry per class = single source of truth; consumers read; config manages; no layer duplicates. Instance #1: the rule registry (ask/check/decide), carrying the root-cause fixes. Upstream: `ann-system-design` (v2, locked), `architecture` (locked). Referrers: implementation slices, validators, the specs ritual, review-task.*

## 1. The problem this fixes

- The tech stack fell through the seam: **requirements excluded it by design, the system-design ladder never asked it, architecture assumed it was settled, and the default→resolution→lock chain made it look decided.** No layer owned "what to ask."
- Root cause: **scattered knowledge.** Four places knew pieces of the same rule — each assumed another owned it. The fix is not more patches; it is **one registry per class, consumed by all.**

## 2. The pattern (general)

```
REGISTRY (single source of truth for one rule/resource class)
  entries: {id, category, kind, definition|ref, config:{enabled, priority/severity, params}}
CONSUMERS (read the registry; never duplicate, never hardcode)
  validators · the ritual (what to ask) · the resolution mechanism · docs/contracts
MANAGEMENT (one surface)
  list · add · version · enable/disable · tune severity/params
```

- **One registry per class.** Every rule/resource lives in exactly one registry. A layer that needs a rule *reads* it — it never carries its own copy.
- **The seam-killer:** a rule can no longer be absent because no layer owned it — the registry owns every rule of its class, and consumers reference it.
- **Versioned.** Registry entries carry version/commit provenance; changes are additions (or amendments), never silent rewrites.
- **Inherited choices are re-elicited if load-bearing** — prior art is evidence of *an assumption*, not a decision (the skeleton rule).

## 3. The registry schema (frozen)

```json
{
  "id": "ask-system-design-stack",
  "category": "ask",              // ask | check | decide | adapter | flow | binding | surface
  "kind": "rung",                 // rung | rule | resolver | adapter | template | ...
  "definition": "...",            // or "ref": "<registry or doc location>"
  "config": {
    "enabled": true,
    "priority": "load-bearing",   // or severity for checks
    "params": {}
  }
}
```

## 4. Instances (share the pattern)

| Category | What it holds | Example entries (instance #1 = the rule registry) |
|---|---|---|
| **ask** | the elicitation ladders (what to ask per doc type) | spec / system-design / architecture rungs; **+ the tech-stack rung**: language/runtime, tooling, dependencies — elicited before components lock; inherited choices re-elicited if load-bearing |
| **check** | the deterministic validation rules (what to check) | gate-1 · gate-2 · event-schema · one-current-per-name · resolution-files · card · depth · name · round-gate · **high-impact-defaulted** (flags any high-impact resolution recorded `defaulted`/`inferred` without an explicit user decision) |
| **decide** | the resolution rules (how to decide) | the ladder: derive → probe → infer → ask → block; **+ provenance**: every resolution carries `how: discussed \| defaulted \| inferred`; **high-impact must be `discussed`** (the silent-inference rule extended from facts to decisions) |
| **adapter** | providers/models, bindings, surfaces | LLM provider list · per-task model selection · GitHub binding · human-interface surfaces (talk v1, web target) |
| **flow** | step-chain templates | the default product chain: idea → validate → envision → spec → continue; per-project overrides |
| **surface** | UI/UX resources | the gate-confirmation template (confirm card), views |

## 5. Management & maintenance

- One surface to list/add/version/enable/tune: the registry is data; management is a command/UI over it.
- A rule change happens in the registry once — every consumer picks it up (validators read `check`, the ritual reads `ask`, resolution reads `decide`).
- Registry integrity is itself a check: *every consumed rule exists in a registry; no hardcoded rule outside it* — a validator rule over the registries.

## 6. Boundaries

- The registry holds **definitions + config**, not implementations. A check's *code* lives with its consumer (the validators); the registry is the contract that the code implements. (One exception: where the registry's `ref` points to an implementation seed in `scripts/`.)
- Not a plugin marketplace in v1 — the registries are versioned project data, extended by amendments (change-protocol), not by third-party additions.

## 7. Non-goals

- No hot-loading of arbitrary code from registry entries in v1 (implementations are the consumer's code, keyed by id).
- No cross-project sharing in v1 (the registries are per-store; the generic defaults seed them on init).
