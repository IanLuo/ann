<!-- specs:locked:4f95b5a 2026-08-22 type=spec -->

## Link contract
- **upstream** (this doc relies on): 04-system-design/00/10-system-design-amendment/artifacts/ann-system-design-v2.md,05-engine/00/07-architecture/artifacts/architecture.md
- **referrers** (must cite this when they change): implementation slices,validators the specs ritual,review-task

# Resource / Registry Spec (v2)
*Artifact of task `06-engine-build/17-resource-registry-amendment-v2`. Type: spec. Complete superseding version — v1 (locked @ 9c3705e) + the **USER-CONFIG instance** (the per-user `~/.ann/config.json` contract — credentials, provider overrides, and the PATH-ONLY project registry). The general management pattern for **anything configurable that consumers reference** — rules, ladders, adapters, models, flows, bindings, surfaces, user settings. One registry per class = single source of truth; consumers read; config manages; no layer duplicates. Instances: the rule registry (ask/check/decide) + the user config. Upstream: `ann-system-design` (v2, locked), `architecture` (v2, locked), `journey-format-spec` v12 (locked). Referrers: implementation slices, validators, the specs ritual, review-task.*

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
| **user-config (v2)** | the per-user settings contract — ONE instance on disk: `~/.ann/config.json` (override `ANN_CONFIG`), chmod 600, outside any project | §8 — credentials, provider overrides, PATH-ONLY project registry |
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

## 8. Instance: the user config (v2 — NEW)

**One instance of the registry pattern lives per-USER (not per-project):** `~/.ann/config.json`
(override with `ANN_CONFIG`). It is the single source of truth for the user's app settings;
consumers (the provider adapter, the project resolver) read it; `ann config!` manages it.

**Schema (frozen):**

```json
{
  "provider": "string — preferred provider id",
  "model": "string — preferred model",
  "baseUrl": "string — provider endpoint",
  "apiKey": "string — the secret (MASKED in every display; never logged)",
  "maxTokens": 1024,
  "projects": ["/path/to/project-a", "/path/to/project-b"],
  "currentProject": "/path/to/project-a"
}
```

- **Projects are PATH-ONLY — no names** (a path is unambiguous; names were dropped 2026-08-22).
  Each path has its OWN journey (recognized by the `.ann/` marker). The legacy
  `{name, path}[]` shape is normalized on read.
- **Resolution order per setting:** `env` (deployment override) > `user config` > `keychain`
  (secrets only, macOS dev) > registry fallback. Project root: `--project <path>` /
  `ANN_PROJECT` > cwd-walk to `.ann/` > `config.currentProject`.
- **Security:** the file is chmod 600 (user-only) and lives OUTSIDE any project (never
  committed); `apiKey` is masked everywhere (`ann config`/`ann providers` show
  `SET (masked)`); the key is never in the repo, the store, or the op-log.
- **Versioning:** changes are additions/amendments, never silent rewrites (the pattern's
  rule). The legacy `{name,path}` projects shape is the one sanctioned migration.
