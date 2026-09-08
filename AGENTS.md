# AGENTS.md — Meta-Assistant (ann)

## Intent

Build **Ann — a journey-of-legs system** (formerly "tree-of-steps") that converts ambiguous human goals into a living chain of gated legs (epics): sequential gated legs, parallel task groups, every step self-aware with a materialized context packet, human gates at each step end. Success = a downstream runner completes the user's goal using only the journey-derived context (context packets + artifacts + ordinary project access). The product is the journey itself — plan, project memory, and observer in one — structured data, not just markdown.

## How to run / build / test

No engine code exists yet — nothing to verify. Commands will be added once the build leg (06-engine-build) starts.

```bash
# Build — not yet available
# Run   — not yet available
# Test  — not yet available
```

## Hot invariants

- **The product is the journey, not a plan artifact.** A living chain of gated legs (formerly rounds): sequential gated legs, parallel task groups, human gates at each step end, journey-as-memory. Markdown is presentation; the source of truth is the leg/node structure per design v3 (`.ann/journey/legs/01-goal/artifacts/design.md` §2/§4).
- **Prove the flow before framework cleverness.** The MVP = the L6 engine build (ann-system-design v3 components, S1–S9); defer plugins, multi-UI, bindings beyond GitHub until the core flow works.
- **Context must carry provenance.** Facts from inference must be labeled as inference. Source provenance must be tracked (design v3 §6). Untrusted context must not override system policy (design v3 §4).
- **Repair loops require a route reason, max iteration count, checkpoint, and fallback.** No unbounded loops (design v3 §4 — bounded loops; flow-control-spec).
- **The canonical model is the table of legs (design v3, formerly "table of rounds").** Sequential gated legs (epics), parallel task groups, artifact gate, human gates (grilling + confirm-result), resolution ladder (derive → probe → infer → ask → block), journey-as-memory. Supersedes the old plan-artifact model.
- **Leg status is derived, never asserted.** A leg root carries no events (journey-format-spec v7): leg `done` = all its tasks `done`; the leg gate for spawning the next leg is the derived aggregate. Closure-by-transfer lives on a closure task, never the leg root. **One carved-out exception (goal-session-design §2, v6):** the designated childless goal leg is the single leg root that may carry events — its `created`+`completed` seed (written by `seedGoal`, never the general writer), the goal.md lock, and the `goal-met` verdict.
- **Ann eats its own dog food.** Ann itself is built and managed through its own journey (legs, nodes, events, artifacts). Agent sessions on this repo record work as journey nodes/artifacts, not just chat history.
- **Structural integrity is scripted; the LLM only generates content.** The store (`.ann/`) never reads or writes outside itself on its own authority — journey records (contracts, `targetAreas`/scope, events) name **in-store** paths, or — for a task whose work is code — the real project paths it modifies (e.g. `src/store`); scratch/working dirs (`.agents/`, `/tmp`, drafts) are never named as scope. The store never reads or writes those paths; a `lock!` path / evidence ref is recorded evidence of a real producer file. Workflow, gates, rules, actions, and boundary enforcement are **scripts / engine code** — deterministic, validated by the contract schema and check rules — never an LLM's discretion, never stated only as prose. If a rule matters, it is a scripted rule. The LLM's job is content: prose, guides, rationale, analysis. Concrete: never put a scratch or out-of-store path in a contract's scope field, and when an integrity rule currently lives only in convention, make it a code/rule check rather than trusting agents to follow it.
- **Write confinement: a command's writes stay inside the node it addresses.** Every mutator appends only to the addressed node's own `events.jsonl` — never a sibling, a parent, or the store root. The ONLY designated cross-folder writers are `spawn!` (creates the new node's own folder under its leg), `supersede!` (the one cross-task event write: `superseded` on the old locker's node), `goal! archive` (moves the whole live journey tree — legs + the write-rev ledger — to `.ann/archive/sessions/<ts>-<slug>/journey`, then resets the live store to an empty session), the OPERATOR ACTION `advance!` (the F5 approve→execute gesture — named BEFORE it exists on `06-operator-loop/01-spec-amend-f5-execute`, functional-spec v2 F5 · flow-control-spec v7 §2/§5; NOT YET BUILT — the deliberate follow-on): a scripted cross-folder writer that executes the DERIVED advance through the sanctioned writers (`spawn!`/`submit!`/`gate!`/`run!`) — it spawns the next node into its own folder under the derived leg and/or runs the frontmost-ready task through the frame; its writes land only on the node(s) the derived advance addresses, it never answers a gate, never authors a contract, never self-closes — it lands at the next human gate, and the SPECS grill (`spec!`, `spec-doc.ts`) — a docs-as-git writer that writes/rewrites one spec doc at `docs/<name>.md` (produce lands a NEW name; `--amend` overwrites an EXISTING in-force doc in place) + regenerates the manifest, exactly like the goal seed's goal.md. `goal.md` and the goal leg's `node.json` are written only by the seed (`goal! seed` / `seedGoal` — goal.md is the authored truth, node.json is machine-generated 1:1 from it); the goal.md lock and the `goal-met` verdict ride the goal-root carve-out on the designated childless goal leg. Spec docs (`docs/<name>.md`, default `requirements`) are LIVING, AMENDABLE guidance written by a SPECS session on the human's GO — the operator git-commits them (the driver itself never commits). A producer artifact stays a real file in the producing task's own `artifacts/`; `lock!` only records its path (must be the task's own producer file), it never writes or copies the file elsewhere. Any future command that must write outside the addressed node is named here before it exists — never invented per-instance.

## Architecture elevator

No code layer yet — the architecture exists as a locked contract stack. The core concept is the **table of legs** (model spec §2, formerly "table of rounds"): sequential, gated legs (epics) — design → requirements → format → technique → engine; parallel task groups inside a leg; every step self-aware with a materialized context packet; human gates at each step end (grilling + confirm-result); resolution ladder (derive → probe → infer → ask → block); journey-as-memory. Invariants and the contract stack are in `.ann/journey/legs/01-goal/artifacts/design.md` (model, locked) and the contracts it points to.

```
design (model + invariants) → requirements-spec (requirements) → journey-format-spec (data) → flow-control-spec (workflow) → ann-system-design (technique)
```

## Deeper docs

The in-force docs are **git content at `docs/`** (docs → git): current = the file at
HEAD; `docs/manifest.json` (generated — `ann docs --write` regenerates it) is the
resolution index mapping each logical name → `docs/<name>`.

| When you need… | Read… |
|---|---|
| model semantics + invariants (legs, gates, resolution ladder, provenance, fail-closed, complete artifacts, open decisions) | `docs/core-design.md` |
| requirements (fresh spec v3): self-similarity invariant, configurable step chain, AC-1–7, K1–K5 + failure signal, NFRs, assumptions, data, recovery, security, verification | `docs/requirements-spec.md` |
| the journey format contract (engine data contract): table of legs (epics, sequential gates), parallel task groups, immutable `node.json`, append-only `events.jsonl` (tasks only), derived leg status, per-node artifacts, depth policy, read discipline; **v11: task contract checklist (F-AC19)** · **v13: the `description.md` card removed** · **v14: `workType`/`flow`/`model` + top-level `openQuestions` (§2); the `trace` transcript record, `submitted.confirmedSha`, the new `waiting` kind (§3); DEFER-RECORD write timing — `artifact-locked` records at commit (§4); the `-v<N>` filename rule (§14/§15)** · **v15: the task-splitting + task-naming convention (§16) — the task id grammar `<NN>-<worktype>-<slug>` (worktype ∈ validate|envision|spec|implementation|binding|closure), one cohesive deliverable per task, amendments = their own task, rework = superseding sibling never an edit, task-vs-new-leg rule; the segment cap RAISED 24 → 40 (§8); `-v<N>` in a slug = the TARGET artifact version; the `s<N>` slice tag dropped** · **v16: the artifact COLLAPSE — `lock!` becomes a THIN named-artifact record over the producer's own file, any-file artifacts, `docs/` retired** · **v17: the GOAL-LEG carve-out — the designated seeded childless goal leg is the single leg-root exception (seed / goal.md lock / `goal-met` only); the `goal-met` eventType; goal.md doc-SSOT with the generated node.json; `goal! met|archive`** | `docs/journey-format-spec.md` |
| flow control: lifecycle, human gates, rejection/rework, resolution ladder, per-work-type flows, closure task; **v6: implementation artifact = structured commit evidence** | `docs/flow-control-spec.md` |
| requirements change: the amendment path (change → amendment node → complete superseding artifact → superseded event → referrer re-pointing); locked artifacts never edited | `docs/requirements-change-protocol.md` |
| functional spec (F1–F17, F-ACs): what the engine must do | `docs/functional-spec.md` |
| technique: components & ownership (S1–S9), frozen interfaces, failure modes (fail-closed), scale | `docs/ann-system-design.md` |
| architecture: load-bearing decisions, layers & ownership — **v3: the L0–L3 model (L0 store ← L1 commands ← L2 flow ← L3 surface/abilities); engines fold into L2, adapters become L3 abilities, commands are the ONLY store interface (reads too), writes are multi-client IN-PROCESS (the CLI is a binding, not an initiator), contract invariants + artifact gate move into L1 `spawn!`; "the kernel routes each step to its engine" is FALSIFIED** · single-writer store, **web-UI target — DECIDED (2026-08-22): local-first client-server, packaged together; the client (browser) supports local AND remote servers, the server runs locally by default and owns the engine + journey; credentials stay server-side**, per-task models, two-log trace **with the transcript exception**, repo layout, cross-cutting conventions | `docs/architecture.md` |
| engine step model — **DECIDED (2026-08-23, build later): the model runs in a SHARED DYNAMIC capability environment (skills · tools · mcp as a shared pool, selected at runtime — never a predefined per-step kit); prompts are dynamic/part-dynamic runtime composition; the provider adapter grows TOOL-CALLING by amendment (v2) — lands with the web-server slice or S9 eval** | evidence on `06-engine-build/05-s2-envision-grilling` |
| resource registry: one registry per class (`rules/{ask,check,decide,adapter,flow,schema,config}`), what is DATA vs CODE — **v3: the `schema` category (vocab.json) + the `config` category (the general config: ONE class, TWO instances — project `rules/config/default.json` + the `~/.ann/config.json` overlay); the RECONCILIATION REGISTER (eventTypes/statuses/gates + the builtin config defaults are knowing code-literal duplicates); the user-config schema admits `flow.*`/`preferences.*`; §9 LISTS the six data migrations the re-implementation must execute** · **v4: two goal-session §5 reconciliations — `goal-met` + its store literal, and the goal-leg root-events carve-out (the register also records named code exceptions)** | `docs/resource-registry.md` |

---

## State-tracking protocol

Session state lives in **the journey** — derived, never hand-maintained. Start every session with:

```bash
npm run ann -- journey    # where we are + what's ahead (the look-back)
npm run ann -- check      # integrity + gates + hashes + the journey state line
npm run ann -- specs      # the contract stack
```

**Never read `events.jsonl` directly** — state comes exclusively from the commands (`npm run ann -- --journey/--status/--check/--specs/--branch`; node views: `--detail/--results/--confirm/--branch`; the adapter registry: `--providers`); the log is machine-parse-only and may hold inert legacy facts (v7 read discipline). **Secrets (e.g. the LLM API key) are SERVER-SIDE, environment-injected (12-factor — the web app's credentials live in the deployment env / secrets manager, never the client, never the store, never the repo). The macOS Keychain (`ann cred!`) is a DEV-ONLY convenience for the local CLI.** **Never hand-edit `node.json`/`events.jsonl` either** — all mutations go through the engine CLI, the store's single writer (LB-3): `npm run ann spawn!|gate!|lock!|supersede!|append! …` — **writes end in `!`** (reads never; the `!` is the mutator marker). Build once: `npm run build`. **Multi-project: ann works from ANY directory — the project root resolves via `--project <name>` / `ANN_PROJECT` / walking up to a `journey/` dir / `config.currentProject`; each project has its OWN journey; manage by PATH with `ann project! add|use|remove <path>` (per-user config ~/.ann/config.json, ANN_CONFIG override; `--project <path>`/`ANN_PROJECT` per-call).** **`ANN_STORE=<path>` (session-read): empty/unset → the ACTIVE project's journey; a value → a project root (`.ann/journey/legs`) OR a journey root (`journey/legs` or `legs/` directly — e.g. `.ann/archive/sessions/<ts>-<slug>/journey`) — the SAME commands then read that session's store (same shape, only the folder differs); a non-active target is READ-ONLY (journey-addressing writes refuse), a bad/absent target fails closed at startup (named error, exit 1).** `scripts/resolve.mjs` was retired (2026-08-19). Full command list (derived): `npm run ann -- --commands`. `--check` verifies artifact hashes and flags uncommitted tampering.

State = the journey (statuses, gates, artifacts, events). History = git. Nothing hand-maintained — a handwritten state sidecar is the dual-write drift the journey exists to eliminate. **`CURSOR.md` is retired** (2026-08-17): the inclusion gate below is how we keep the journey honest instead.

### Inclusion gate — record X in the journey iff:
(a) X is NOT recoverable by running one command against an artifact (git/code/CI/journey), AND
(b) a fresh agent would plausibly get WRONG without it.

Where state lives in an artifact, store the *command* or *path*, not the output. Can't drift; costs less. Decisions collapse to one present-tense line, locked in the contracts or recorded as events — not a deliberation timeline.
