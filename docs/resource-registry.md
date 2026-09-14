## Link contract
- **upstream** (this doc relies on): 04-system-design/00/10-system-design-amendment/artifacts/ann-system-design-v2.md,docs/architecture.md,docs/core-design.md,docs/journey-format-spec.md
- **referrers** (must cite this when they change): implementation slices,validators the specs ritual,review-task

# Resource / Registry Spec (v5)
*Artifact of task `10-server-ui/02-implementation-resource-registry-v5`. Type: spec. Complete superseding version — v4 (locked @ a4c8262) + **the SERVE BIND joins the config class (v5 — the code half landed first on leg 10 task 03, commit 4e3ab25):** §4's config row, §5's builtin-duplicate row, §7's non-goal, §8's overlay schema and §8a's class take `server.host` + `server.port` — the PROJECT registry AND the per-user overlay both carry them (ONE CONFIG CLASS, TWO INSTANCES, unchanged), the env layer is `ANN_HOST`/`ANN_PORT`, the builtin floor `127.0.0.1:8787` is the §5 duplicate row, and each leaf is validated by NAME (a bare host — no scheme, port, path or whitespace; an integer port 0..65535). Recorded in §5/§8a, not §9: an amendment and a reconciliation already executed, not a migration listed for the re-implementation. History (v4): **the GOAL-SESSION RECONCILIATIONS (leg 10 — the recorded half of the landed goal-scoped-sessions change)**: §5's reconciliation register gains TWO rows — **`goal-met`** (the new PROTECTED event type + its store-literal) and **the leg-root no-events rule's GOAL-LEG CARVE-OUT** (the one named leg-root exception, live in the single writer's append path) — each phrased like the existing rows; the register's preamble is EXTENDED so it also records a **NAMED CODE EXCEPTION to a recorded rule**, not only data/code duplicates. The code half landed first (the goal-scoped-sessions commit); this v4 records it — §5, not §9: these are reconciliations already executed, not migrations listed for the re-implementation. Upstream: `ann-system-design` (v3, locked @ 2b0a30f), `architecture` v3 (locked), `journey-format-spec` v17 (locked), `core-design` (locked @ f7fb400). Referrers: implementation slices, validators, the specs ritual, review-task. **(leg 08 task 01 — the task-close vocabulary: reconciled here, never re-specced here):** §5's register gains TWO further rows for the codes landed on that task — **`cancelled`** (the PROTECTED event type + its REQUIRED `reason` literal, and the terminal `taskStatus` case) and **`accepted`** (the confirm-gate-accepted / no-`completed` status). **(leg 09 — the `deferred` terminal: the same register, the code half that was missing):** the `deferred` event type was already declared and its `reason` shape-checked at the single writer, but nothing derived a status from it, so a deferred task never closed and its leg never derived done — `vocab.statuses` gains the word and §5 gains its row. Registered here, never re-specced here. **(leg 12/08 — the gate lifecycle, DERIVED ONCE: the decision vocabularies reconciled):** the schema registry gains `gateDecisions` (`accept` → `confirmed`, `reject` → `rejected`), the DECLARED half of the pair whose code half is `GATE_DECISION_EVENTS` in the ONE derivation (`src/store/workflow.ts`, §5's row); the derivation also replaced ~11 independent re-readings of the submitted|confirmed|rejected triple (the store's status/detail/check, the command layer's gateState/undecidedSubmission/pendingGates/rejections, lookBack, the frame's private gate-state copy, the transcript's attempt boundary, the operator action's landing label, the UI's next-line table) with one `gateLifecycle` + one `workflowState` projection, and `check()` gained the RECONCILIATION rule (a status word that contradicts the derived lifecycle — a READY word beside an owed rework, `accepted` without a confirm accept, `blocked` with nothing pending — is a NAMED finding). Registered here, never re-specced here.*

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
- **`config` (v3 — NEW).** The general user-facing configuration — the knobs an end user is allowed to turn (§8a). Data, never code. **(v5)** The class carries a THIRD group beside `flow.*`/`preferences.*`: the `server.*` serve bind (`server.host` · `server.port` — §8a).
- A **file-level registry** (`vocab.json`, `flow/default.json`, `config/default.json`, `decide/rules.json`) carries the entry fields at the top of the file — `{registry, version, category, kind, definition, …}` — instead of repeating them per entry. Same schema, one instance per file.

## 4. Instances (share the pattern)

| Category | What it holds | Example entries (instance #1 = the rule registry) |
|---|---|---|
| **ask** | the elicitation ladders (what to ask per doc type) | spec / system-design / architecture rungs; **+ the tech-stack rung**: language/runtime, tooling, dependencies — elicited before components lock; inherited choices re-elicited if load-bearing |
| **check** | the deterministic validation rules (what to check) | gate-1 · gate-2 · event-schema · one-current-per-name · resolution-files · depth · name · leg-gate · **high-impact-defaulted** (flags any high-impact resolution recorded `defaulted`/`inferred` without an explicit user decision) |
| **decide** | the resolution rules (how to decide) | the ladder: derive → probe → infer → ask → block; **+ provenance**: every resolution carries `how: discussed \| defaulted \| inferred`; **high-impact must be `discussed`**. **(v3) Each rung carries an `enabled` flag — rung enablement is DATA once the rung exists; v1 builds `block` only** (§9) |
| **adapter** | providers/models, bindings, surfaces | LLM provider list · per-task model selection (`contract.model`) · GitHub binding · human-interface surfaces (talk v1, web target) |
| **schema (v3 — NEW)** | the store's vocabulary — ONE instance: `rules/schema/vocab.json` | `eventTypes` · `statuses` · `gates` · **`gateDecisions` (v4, leg 12/08)** · `artifactTypes`. **Data-or-code is per-key and is stated in §5:** `artifactTypes` is ADJUSTABLE data (each entry carrying its category + versioned flag, §9); `eventTypes` / `statuses` / the gate SET and POSITIONS are **PROTECTED** — enforced as code literals, recorded as reconciliations |
| **config (v3 — NEW; v5 AMENDED)** | the general user-facing configuration — **ONE CLASS, TWO INSTANCES**: the per-project `rules/config/default.json` and the per-user `~/.ann/config.json` overlay | §8a — `flow.conditionals` · `flow.verifyFailCycles` · `preferences.askVsAssume` · `preferences.defaults` · **(v5)** `server.host` · `server.port` (the SERVE BIND — where this machine's `ann serve` listens) |
| **user-config (v2)** | the per-user settings contract — ONE instance on disk: `~/.ann/config.json` (override `ANN_CONFIG`), chmod 600, outside any project | §8 — credentials, provider overrides, PATH-ONLY project registry, **+ the v3 `flow.*`/`preferences.*` overlay** — **(v5)** and the `server.*` serve bind |
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
| **the general-config BUILTIN DEFAULTS** (v5 — every leaf, the SERVE BIND included: `server.host` = `127.0.0.1`, `server.port` = `8787`) | the config loader's fallback literal (`BUILTIN_CONFIG`, `src/flow/config.ts`) | precedence must terminate: `env > user > project > builtin`, and `builtin` cannot itself be a file, or an empty registry would have no floor | editing `rules/config/default.json` changes the PROJECT layer only; the builtin floor is a code change. Values must be kept in step — including the bind: a project `server.port` does not move the floor an absent/empty registry falls back to |
| **`vocab.eventTypes` — `goal-met`** (v4) | the store's write path — `validateEventShape`'s `goal-met` branch (allowed keys `at`/`type`/`note`/`decision`/`feedback`; `decision === 'met'`; `feedback` an optional string) | `goal-met` is a PROTECTED verdict type with its own shape — the single writer validates it before the registry is readable as a consumer (the same circularity as the parent `eventTypes` row); only the sealed HUMAN met verdict may be recorded | adding `goal-met` to `vocab.json` alone neither makes it writable nor shape-checks it — the writer still refuses it. Both must change together (a CODE change — landed with the goal-session feature) |
| **the leg-root no-events rule — the GOAL-LEG CARVE-OUT** (v4; journey-format-spec v17 §17) | the single writer's goal-root branch — the structural predicate `goalLegId()`/`goalRootEvent()` ("childless AND carries the goal seed/artifact") | the one leg root allowed to carry events must be recognized by CODE before the writer can serve any goal-session state (the seed, the goal.md lock, `goal-met`); the exception is id-scoped by the structural predicate, never by a name or a registry edit | re-tagging a leg or editing registry/naming data alone neither moves nor widens the carve-out — an ordinary childless leg is still refused root events. Both must change together (a CODE change — landed with the goal-session feature) |
| **`vocab.eventTypes` — `cancelled` + its REQUIRED `reason`** (leg 08 task 01) | the store's write path — `validateEventShape`'s `cancelled` branch (allowed keys `at`/`type`/`note`/`reason`; `reason` a non-blank string) and the `taskStatus` case that derives the `cancelled` terminal; the general `append!` additionally stamps the initiator's provenance (`RECORDED_BY`) as the record's note when the caller gives none | `cancelled` is a PROTECTED terminal event type whose record is worthless without a WHY — the single writer validates the shape before the registry is readable as a consumer (the same circularity as the parent `eventTypes` row), and the status it derives is a function (see the `vocab.statuses` row) | adding `cancelled` to `vocab.json` alone neither makes it recordable (the `reason` stays unchecked) nor derives the status — both must change together (a CODE change — landed with the task-close vocabulary) |
| **`vocab.statuses` — `cancelled` / `accepted`** (leg 08 task 01) | the `taskStatus` derivation — the `cancelled` case (terminal in BOTH directions: never overrides done/failed, and the undecided-submission / `waiting` blocked re-derivations join its guard) and the `confirmed(gate=confirm)` case (`accepted`); plus the `CLOSED_TASK_STATUSES` set that `legStatus`, `legGateMet`, the goal's structural exhaustion, the `distance-to-goal` rule and the dogfood K1 read consume | status is a DERIVATION over the event tail, i.e. a function — the list documents the function's range; `accepted` in particular must not be a registry-only word, or a confirm-gate-accepted task falls back to the created default and looks re-runnable to `next`/`advance!`/`run!` | adding either word to `vocab.json` alone is still a silent no-op: nothing derives it (the K1 read now consumes this list rather than hardcoding the range). Both must change together (a CODE change) |
| **`vocab.statuses` — `deferred`** (leg 09) | the `taskStatus` derivation — the `deferred` case, mirroring `cancelled` (terminal in BOTH directions: never overrides done/failed/cancelled, and the undecided-submission / `waiting` blocked re-derivations join its guard), plus `deferred` in the same `CLOSED_TASK_STATUSES` set and in `undecidedEverywhere`'s skip | `deferred` was a registry word with no derived status: the event type and its `reason` shape-check existed at the single writer, but a deferred task stayed unclosed, so its leg never derived done and the undecided sweep still counted it — the vocabulary was half-implemented | adding `deferred` to `vocab.json` alone again derives nothing: the case, the closed set and the sweep skip must change with it (a CODE change — the writer's `deferred.reason is a string` check is the pre-existing half) |

| **`vocab.gateDecisions`** (v4 — leg 12/08) | the derivation's code literal `GATE_DECISION_EVENTS` (`src/store/workflow.ts`) — what `gate!` writes (`type: GATE_DECISION_EVENTS[accept|reject]`) and `gateLifecycle` reads | the ONE gate-lifecycle derivation must map the human's `accept|reject` onto the recorded event types *before* the store is readable as a registry consumer (the same circularity as the parent `eventTypes` row), and the mapping IS the reconciliation between the two decision vocabularies the engine had never written down — a third form must be impossible | editing `gateDecisions` alone changes nothing: the writer still records the code literal's event type and the derivation still reads it. Both must change together (a CODE change) — and the pair is pinned by a TABLE test (per gate event type: the allowed fields · the closed gate set · the total mapping), so a silent third form fails the suite |

- **The GATE REJECT BOUND (3) is NOT in this register — it is not data at all.** It is a locked constant owned by the `gate!` command; there is no registry key for it, by design (`core-design` §1). The same holds for the `flow.verifyFailCycles` **CEILING (3)**: the *value* is data, the *ceiling* is a constant.

## 6. Boundaries

- The registry holds **definitions + config**, not implementations. A check's *code* lives with its consumer (the validators); the registry is the contract that the code implements. (One exception: where the registry's `ref` points to an implementation seed.)
- Not a plugin marketplace in v1 — the registries are versioned project data, extended by amendments (change-protocol), not by third-party additions.
- **(v3) The data/code line for the flow registry, stated exactly:** new work types · new chain shapes · new gate sources · new artifact types in an existing category · rung enablement (once the rung exists) = **DATA**. New chain STEPS (code units) · new roles on a step · new intents · new ladder rungs (unbuilt) · a new `docs/` category · a third `when` condition kind = **CODE**.

## 7. Non-goals

- No hot-loading of arbitrary code from registry entries in v1 (implementations are the consumer's code, keyed by id).
- No cross-project sharing in v1 (the registries are per-store; the generic defaults seed them on init).
- **(v3) No user-overridable project semantics.** `flow.conditionals` is a PROJECT decision and is deliberately NOT in the user overlay's reach (§8a) — two people must not run the same journey as different chains. **(v5)** The `server.*` bind IS in the overlay's reach (§8a): which address my own machine's server listens on is a MACHINE preference, not journey semantics.

## 8. Instance: the user config (v2 — NEW; **v3 AMENDED**)

**One instance of the registry pattern lives per-USER (not per-project):** `~/.ann/config.json`
(override with `ANN_CONFIG`). It is the single source of truth for the user's app settings;
consumers (the provider adapter, the project resolver, **the flow — v3**) read it; `ann config!` manages it.

**Schema (frozen — v3: `flow` and `preferences` ADMITTED; v5: `server` ADMITTED):**

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
  "preferences": { "askVsAssume": "ask", "defaults": {} },
  "server": { "host": "127.0.0.1", "port": 8787 }
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
- **(v3; v5 AMENDED) The overlay carries only what a PERSON may set** — `preferences.*`, the
  single cost knob `flow.verifyFailCycles`, and **(v5)** the `server.*` serve bind (a MACHINE
  preference: which address my own server listens on is not a property of the journey, so two
  people may differ without running it differently). **`flow.conditionals` is NOT accepted
  here**; a user config that sets it gets a NAMED problem, never a silent apply (§8a).

## 8a. Instance: the general config (v3 — NEW; **v5 AMENDED: the `server` group**)

**The project instance:** `rules/config/default.json` — per-project registry data, created by the
re-implementation (a NEW FILE, not a migration).

```json
{ "registry": "config", "version": 2, "category": "config", "kind": "registry",
  "definition": "the general user-facing configuration — DATA, never code (F17)",
  "flow": { "conditionals": false, "verifyFailCycles": 1 },
  "preferences": { "askVsAssume": "ask", "defaults": {} },
  "server": { "host": "127.0.0.1", "port": 8787 } }
```

- **ONE CONFIG CLASS, TWO INSTANCES.** The project file holds `flow.*` + `preferences.*` +
  **(v5)** `server.*`; the per-user overlay (§8) overrides `preferences.*` **and
  `flow.verifyFailCycles`** — **and (v5) `server.*`, both leaves.**
- **PRECEDENCE, per LEAF key: `env > user > project > builtin`.** Per-leaf, not per-object — a
  user setting one preference does not blank the project's others.
- **`flow.conditionals` is PROJECT SEMANTICS and is NOT user-overridable** (§7). It enables `when?`
  on chain entries; with it `false`, a chain carrying `when` **FAILS CLOSED, named** — never a
  silent ignore.
- **`flow.verifyFailCycles`** — verify retries before the frame writes `failed`. Default 1,
  **CEILING 3 (a constant, not a key)**. Inert for an empty chain, where a verify failure means
  "the runner has not committed yet": the frame records `waiting` (format v14 §3) and blocks.
- **(v5) `server.host` / `server.port` — the SERVE BIND.** Where `ann serve` listens: builtin
  `127.0.0.1`:`8787`, env layer **`ANN_HOST`**/**`ANN_PORT`**, the project registry above, and the
  user overlay — and per INVOCATION `--host`/`--port`, which outrank every layer (a one-off, never
  persisted). Each leaf is validated by NAME, fail-closed: a host must be BARE (no scheme, port,
  path or whitespace — the port is `server.port`) and a port must be an INTEGER 0..65535 (`0` =
  the OS picks a free port). `ann serve` refuses on a named problem — it never clamps and never
  silently falls back.
- **The knobs are the limits the design chose, never the invariants the store enforces.** The gate
  set, the gate positions and the 3-reject bound are not reachable from any config file.
- **MANAGEMENT SURFACE:** `ann config` gains a PROJECT view (today it shows the user file only);
  `ann config! set` gains the new keys (§9) — **(v5)** `ann config! set server.host|server.port`
  writes the overlay and `ann config` shows each leaf with the layer it resolved from.
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
| 5 | `rules/config/default.json` | **NEW FILE** — the general config registry (§8a). A creation, not a migration. **(v5)** The file also carries the `server` serve-bind group | there is no project layer in the precedence chain; the end-user knobs have nowhere to live |
| 6 | `~/.ann/config.json` schema + `ann config! set` keys | **admit `flow.*` / `preferences.*`** (the frozen §8 schema, its `UserConfig` type, and the CLI's accepted-key list) — **(v5)** and `server.*` | the overlay the design leans on is not writable by a user — the documented precedence has an unreachable layer |

- **Ordering note:** #2 and #4 are paired with code (the store's event-type literal; the flow loader
  and the step registry). #1, #3, #5, #6 are data-plus-consumer changes.
- **Nothing above rewrites recorded events.** These are registry files and a per-user config; the
  store's history is append-only and untouched (format v14 §15: no migration for v14).
