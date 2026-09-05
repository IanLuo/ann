## Link contract
- **upstream** (this doc relies on): 04-system-design/00/10-system-design-amendment/artifacts/ann-system-design-v2.md,05-engine/00/07-architecture/artifacts/architecture.md,06-engine-build/19-core-design/artifacts/core-design-spec.md,10-goal-record/01-implementation-goal-session-record/artifacts/journey-format-spec.md
- **referrers** (must cite this when they change): implementation slices,validators the specs ritual,review-task

# Resource / Registry Spec (v4)
*Artifact of task `10-goal-record/01-implementation-goal-session-record`. Type: spec. Complete superseding version — v3 (locked @ e2dfb46) + **the GOAL-SESSION RECONCILIATIONS (leg 10 — the recorded half of the landed goal-scoped-sessions change)**: §5's reconciliation register gains TWO rows — **`goal-met`** (the new PROTECTED event type + its store-literal) and **the leg-root no-events rule's GOAL-LEG CARVE-OUT** (the one named leg-root exception, live in the single writer's append path) — each phrased like the existing rows; the register's preamble is EXTENDED so it also records a **NAMED CODE EXCEPTION to a recorded rule**, not only data/code duplicates. The code half landed first (the goal-scoped-sessions commit); this v4 records it — §5, not §9: these are reconciliations already executed, not migrations listed for the re-implementation. Upstream: `ann-system-design` (v3, locked @ 2b0a30f), `architecture` v3 (locked), `journey-format-spec` v17 (locked), `core-design` (locked @ f7fb400). Referrers: implementation slices, validators, the specs ritual, review-task.*

## 1. The problem this fixes

- The tech stack fell through the seam: **requirements excluded it by design, the system-design ladder never asked it, architecture assumed it was settled, and the default→resolution→lock chain made it look decided.** No layer owned "what to ask."
- Root cause: **scattered knowledge.** Four places knew pieces of the same rule — each assumed another owned it. The fix is not more patches; it is **one registry per class, consumed by all.**
- **(v3) The same seam, one level down: a registry value duplicated as a code literal.** Where enforcement must be a literal (the writer cannot read a registry to decide whether the registry is legal), the duplicate is **RECORDED as a reconciliation** (§5) — not left for a reader to discover that changing the data changed nothing.

## 2. The pattern (general)

```
REGISTRY (single source of truth for one rule/resource class)
  entries: {id, category, kind, definition|ref, config:{enabled, priority/severity, params}}
CONSUMERS (read the registry; never duplicate, never hardcode)
  validators · the ritual (what to ask) · the resolution mechanism · the flow · docs/contracts
MANAGEMENT (one surface)
  list · add · version · enable/disable · tune severity/params
```

- **One registry per class.** Every rule/resource lives in exactly one registry. A layer that needs a rule *reads* it — it never carries its own copy.
- **The seam-killer:** a rule can no longer be absent because no layer owned it — the registry owns every rule of its class, and consumers reference it.
- **Versioned.** Registry entries carry version/commit provenance; changes are additions (or amendments), never silent rewrites.
- **Inherited choices are re-elicited if load-bearing** — prior art is evidence of *an assumption*, not a decision (the skeleton rule).
- **(v3) Data-or-code is a DECLARED property, never a guess.** For every registry, this spec says which changes are data (edit the file) and which are code (implement + register). A registry that quietly needs a code change to take effect is worse than no registry — hence §5's reconciliation register.
- **(v3) Validation is NAMED, never a silent clamp.** An ill-typed or out-of-range registry value fails closed with a named problem (the `flow.ts` standard); it is never rounded into the nearest legal value.

## 3. The registry schema (frozen; **v3 — the category list EXTENDED**)

```json
{
  "id": "ask-system-design-stack",
  "category": "ask",              // ask | check | decide | adapter | flow | binding | surface | schema | config
  "kind": "rung",                 // rung | rule | resolver | adapter | template | registry | ...
  "definition": "...",            // or "ref": "<registry or doc location>"
  "config": {
    "enabled": true,
    "priority": "load-bearing",   // or severity for checks
    "params": {}
  }
}
```

- **`schema` (v3 — NEW).** The vocabulary a store's data is written and validated against: event types, statuses, gates, artifact types. It is a registry like any other (`rules/schema/vocab.json`, `kind: "registry"`), and it was already on disk and consumed — v2's frozen category list simply had nowhere to put it. **This row is what reconciles `architecture` v2:84.**
- **`config` (v3 — NEW).** The general user-facing configuration — the knobs an end user is allowed to turn (§8a). Data, never code.
- A **file-level registry** (`vocab.json`, `flow/default.json`, `config/default.json`, `decide/rules.json`) carries the entry fields at the top of the file — `{registry, version, category, kind, definition, …}` — instead of repeating them per entry. Same schema, one instance per file.

## 4. Instances (share the pattern)

| Category | What it holds | Example entries (instance #1 = the rule registry) |
|---|---|---|
| **ask** | the elicitation ladders (what to ask per doc type) | spec / system-design / architecture rungs; **+ the tech-stack rung**: language/runtime, tooling, dependencies — elicited before components lock; inherited choices re-elicited if load-bearing |
| **check** | the deterministic validation rules (what to check) | gate-1 · gate-2 · event-schema · one-current-per-name · resolution-files · depth · name · leg-gate · **high-impact-defaulted** (flags any high-impact resolution recorded `defaulted`/`inferred` without an explicit user decision) |
| **decide** | the resolution rules (how to decide) | the ladder: derive → probe → infer → ask → block; **+ provenance**: every resolution carries `how: discussed \| defaulted \| inferred`; **high-impact must be `discussed`**. **(v3) Each rung carries an `enabled` flag — rung enablement is DATA once the rung exists; v1 builds `block` only** (§9) |
| **adapter** | providers/models, bindings, surfaces | LLM provider list · per-task model selection (`contract.model`) · GitHub binding · human-interface surfaces (talk v1, web target) |
| **schema (v3 — NEW)** | the store's vocabulary — ONE instance: `rules/schema/vocab.json` | `eventTypes` · `statuses` · `gates` · `artifactTypes`. **Data-or-code is per-key and is stated in §5:** `artifactTypes` is ADJUSTABLE data (each entry carrying its category + versioned flag, §9); `eventTypes` / `statuses` / the gate SET and POSITIONS are **PROTECTED** — enforced as code literals, recorded as reconciliations |
| **config (v3 — NEW)** | the general user-facing configuration — **ONE CLASS, TWO INSTANCES**: the per-project `rules/config/default.json` and the per-user `~/.ann/config.json` overlay | §8a — `flow.conditionals` · `flow.verifyFailCycles` · `preferences.askVsAssume` · `preferences.defaults` |
| **user-config (v2)** | the per-user settings contract — ONE instance on disk: `~/.ann/config.json` (override `ANN_CONFIG`), chmod 600, outside any project | §8 — credentials, provider overrides, PATH-ONLY project registry, **+ the v3 `flow.*`/`preferences.*` overlay** |
| **flow** | step-chain templates | the default product chain: idea-validate → envision → spec; per-project overrides. **(v3) `chains` maps a WORK TYPE to an array of chain ENTRIES** (`{id, at?, inputs?, params?, verdict?, when?}`), not bare step ids (§9) |
| **surface** | UI/UX resources | the gate-confirmation template (confirm card), views |

## 5. Management & maintenance

- One surface to list/add/version/enable/tune: the registry is data; management is a command/UI over it (`ann rules` · `ann chain` · `ann steps` · `ann config` / `ann config! set`).
- A rule change happens in the registry once — every consumer picks it up (validators read `check`, the ritual reads `ask`, resolution reads `decide`, the flow reads `flow` + `config`).
- Registry integrity is itself a check: *every consumed rule exists in a registry; no hardcoded rule outside it* — a validator rule over the registries.

**THE RECONCILIATION REGISTER (v3 — NEW).** A registry value that is ALSO a code literal is a **knowing duplicate**. Each one is recorded here with the reason it must be a literal and the consequence of editing the data alone. Nothing may be added to this list silently — an unrecorded duplicate is a defect. **(v4) The register ALSO records a NAMED CODE EXCEPTION to a recorded rule** — where a rule's single carve-out must exist in code before data can express the state it permits, the exception is recorded here beside the duplicates (the goal-leg carve-out below). The register is the store's code/data boundary, so its exceptions belong here with its duplicates.

| Duplicated value | Where the literal lives | Why it must be a literal | Consequence of editing the DATA only |
|---|---|---|---|
| **`vocab.eventTypes`** | the store's write path (schema enforcement) | the single writer validates every event *before* the store is readable as a registry consumer; a writer that read the registry to decide whether the registry is legal would be circular | adding a type to `vocab.json` alone does **not** make it writable — the writer still refuses it. Both must change together (a CODE change) |
| **`vocab.statuses`** | the event→status mapping (a code literal) | status is a *derivation* over the event tail, i.e. a function, not a list — the list documents the function's range | adding a status is a **silent no-op**: nothing derives it |
| **`vocab.gates` (the SET and POSITIONS)** | the frame + the gate commands | the gate sequence is a store-enforced invariant (format v14 §3); positions are the design, not a preference | adding a gate name is inert; **only the gate SOURCE is data** (which chain step produces the decision — the `flow` registry) |
| **the general-config BUILTIN DEFAULTS** | the config loader's fallback literal | precedence must terminate: `env > user > project > builtin`, and `builtin` cannot itself be a file, or an empty registry would have no floor | editing `rules/config/default.json` changes the PROJECT layer only; the builtin floor is a code change. Values must be kept in step |
| **`vocab.eventTypes` — `goal-met`** (v4) | the store's write path — `validateEventShape`'s `goal-met` branch (allowed keys `at`/`type`/`note`/`decision`/`feedback`; `decision === 'met'`; `feedback` an optional string) | `goal-met` is a PROTECTED verdict type with its own shape — the single writer validates it before the registry is readable as a consumer (the same circularity as the parent `eventTypes` row); only the sealed HUMAN met verdict may be recorded | adding `goal-met` to `vocab.json` alone neither makes it writable nor shape-checks it — the writer still refuses it. Both must change together (a CODE change — landed with the goal-session feature) |
| **the leg-root no-events rule — the GOAL-LEG CARVE-OUT** (v4; journey-format-spec v17 §17) | the single writer's goal-root branch — the structural predicate `goalLegId()`/`goalRootEvent()` ("childless AND carries the goal seed/artifact") | the one leg root allowed to carry events must be recognized by CODE before the writer can serve any goal-session state (the seed, the goal.md lock, `goal-met`); the exception is id-scoped by the structural predicate, never by a name or a registry edit | re-tagging a leg or editing registry/naming data alone neither moves nor widens the carve-out — an ordinary childless leg is still refused root events. Both must change together (a CODE change — landed with the goal-session feature) |

- **The GATE REJECT BOUND (3) is NOT in this register — it is not data at all.** It is a locked constant owned by the `gate!` command; there is no registry key for it, by design (`core-design` §1). The same holds for the `flow.verifyFailCycles` **CEILING (3)**: the *value* is data, the *ceiling* is a constant.

## 6. Boundaries

- The registry holds **definitions + config**, not implementations. A check's *code* lives with its consumer (the validators); the registry is the contract that the code implements. (One exception: where the registry's `ref` points to an implementation seed.)
- Not a plugin marketplace in v1 — the registries are versioned project data, extended by amendments (change-protocol), not by third-party additions.
- **(v3) The data/code line for the flow registry, stated exactly:** new work types · new chain shapes · new gate sources · new artifact types in an existing category · rung enablement (once the rung exists) = **DATA**. New chain STEPS (code units) · new roles on a step · new intents · new ladder rungs (unbuilt) · a new `docs/` category · a third `when` condition kind = **CODE**.

## 7. Non-goals

- No hot-loading of arbitrary code from registry entries in v1 (implementations are the consumer's code, keyed by id).
- No cross-project sharing in v1 (the registries are per-store; the generic defaults seed them on init).
- **(v3) No user-overridable project semantics.** `flow.conditionals` is a PROJECT decision and is deliberately NOT in the user overlay's reach (§8a) — two people must not run the same journey as different chains.

## 8. Instance: the user config (v2 — NEW; **v3 AMENDED**)

**One instance of the registry pattern lives per-USER (not per-project):** `~/.ann/config.json`
(override with `ANN_CONFIG`). It is the single source of truth for the user's app settings;
consumers (the provider adapter, the project resolver, **the flow — v3**) read it; `ann config!` manages it.

**Schema (frozen — v3: `flow` and `preferences` ADMITTED):**

```json
{
  "provider": "string — preferred provider id",
  "model": "string — preferred model",
  "baseUrl": "string — provider endpoint",
  "apiKey": "string — the secret (MASKED in every display; never logged)",
  "maxTokens": 1024,
  "projects": ["/path/to/project-a", "/path/to/project-b"],
  "currentProject": "/path/to/project-a",

  "flow": { "verifyFailCycles": 1 },
  "preferences": { "askVsAssume": "ask", "defaults": {} }
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
- **(v3) The overlay carries only what a PERSON may set** — `preferences.*` and the single
  cost knob `flow.verifyFailCycles`. **`flow.conditionals` is NOT accepted here**; a user
  config that sets it gets a NAMED problem, never a silent apply (§8a).

## 8a. Instance: the general config (v3 — NEW)

**The project instance:** `rules/config/default.json` — per-project registry data, created by the
re-implementation (a NEW FILE, not a migration).

```json
{ "registry": "config", "version": 1, "category": "config", "kind": "registry",
  "definition": "the general user-facing configuration — DATA, never code (F17)",
  "flow": { "conditionals": false, "verifyFailCycles": 1 },
  "preferences": { "askVsAssume": "ask", "defaults": {} } }
```

- **ONE CONFIG CLASS, TWO INSTANCES.** The project file holds `flow.*` + `preferences.*`; the
  per-user overlay (§8) overrides `preferences.*` **and `flow.verifyFailCycles`**.
- **PRECEDENCE, per LEAF key: `env > user > project > builtin`.** Per-leaf, not per-object — a
  user setting one preference does not blank the project's others.
- **`flow.conditionals` is PROJECT SEMANTICS and is NOT user-overridable** (§7). It enables `when?`
  on chain entries; with it `false`, a chain carrying `when` **FAILS CLOSED, named** — never a
  silent ignore.
- **`flow.verifyFailCycles`** — verify retries before the frame writes `failed`. Default 1,
  **CEILING 3 (a constant, not a key)**. Inert for an empty chain, where a verify failure means
  "the runner has not committed yet": the frame records `waiting` (format v14 §3) and blocks.
- **The knobs are the limits the design chose, never the invariants the store enforces.** The gate
  set, the gate positions and the 3-reject bound are not reachable from any config file.
- **MANAGEMENT SURFACE:** `ann config` gains a PROJECT view (today it shows the user file only);
  `ann config! set` gains the new keys (§9).
- **VALIDATION:** ill-typed or out-of-range → a NAMED problem; the builtin defaults are a code
  literal and a recorded reconciliation (§5).

## 9. The listed data migrations (v3 — NEW; LISTED HERE, EXECUTED BY THE RE-IMPLEMENTATION)

These are the registry/data changes the L0–L3 re-implementation must make. **This amendment does
not execute any of them** — recording the contract precedes the change (`core-design` §8). Each row
names the file, the change, and what breaks if it is skipped.

| # | File | Change | If skipped |
|---|---|---|---|
| 1 | `rules/schema/vocab.json` | **`artifactTypes` entries gain `category` + `versioned`** — from a flat string list to entries carrying the `docs/` category they place into and whether they take a `-v<N>` filename (format v14 §14/§15) | artifact placement and filenames stay a code convention; a new artifact type cannot be added as data |
| 2 | `rules/schema/vocab.json` | **`eventTypes` gains `waiting`** (format v14 §3) — together with the store's literal (a §5 reconciliation: both or neither) | the frame cannot record the empty-chain verify wait; a healthy blocked task has no honest state |
| 3 | `rules/decide/rules.json` | **each ladder rung gains `enabled`** — `block: true`; `derive`/`probe`/`infer`/`ask`: `false` (v1 builds `block` only) | rung enablement stays implicit; enabling a rung later means a code edit, and "the ladder is data" is untrue |
| 4 | `rules/flow/default.json` | **`chains` becomes `{workType → entry[]}`** — entries `{id, at?, inputs?, params?, verdict?, when?}` instead of bare step ids; **plus the loader assertion** (`flow.ts:64`, currently "must be an array of step ids") **and the `validate` → `idea-validate` rename** (the registered step id the chain must reference) | gate sources, role bindings, verdict maps and conditionals cannot be expressed as data — the flows-as-data target fails at its first requirement |
| 5 | `rules/config/default.json` | **NEW FILE** — the general config registry (§8a). A creation, not a migration | there is no project layer in the precedence chain; the end-user knobs have nowhere to live |
| 6 | `~/.ann/config.json` schema + `ann config! set` keys | **admit `flow.*` / `preferences.*`** (the frozen §8 schema, its `UserConfig` type, and the CLI's accepted-key list) | the overlay the design leans on is not writable by a user — the documented precedence has an unreachable layer |

- **Ordering note:** #2 and #4 are paired with code (the store's event-type literal; the flow loader
  and the step registry). #1, #3, #5, #6 are data-plus-consumer changes.
- **Nothing above rewrites recorded events.** These are registry files and a per-user config; the
  store's history is append-only and untouched (format v14 §15: no migration for v14).
