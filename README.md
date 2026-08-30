# ann — the journey-of-legs engine

Ann converts ambiguous human goals into a living chain of gated legs (epics): sequential
gated legs, parallel task groups, every step self-aware with a materialized context
packet, human gates at each step end. The product is the journey itself — plan, project
memory, and observer in one. Structured data, not just markdown.

Local-first: a web app in the making (client-server, packaged together), currently
shipped as a CLI. Each project has its own journey under `<project>/.ann/`.

## Quick start

```bash
npm run build
npm run ann -- journey          # where we are + what's ahead
npm run ann -- check            # integrity + gates + hashes + the journey state line
npm run ann -- specs            # the locked contract stack
npm run ann -- detail <id>      # a node's full derived detail (short ids work)
npm run ann -- results <id> [n] # results by kind, drill by type
npm run ann -- packet <id>      # the node's deterministic context packet
npm run ann -- validate <id>    # the validator rules (self-contained modules)
npm run ann -- providers        # the adapter registry (masked)
npm run ann -- project          # multi-project management by path
```

State comes from commands only — never read `events.jsonl` directly; never hand-edit
`node.json`/`events.jsonl`. Writes end in `!` (the mutator marker).

## Commands

Everything runs through one binary: `npm run ann -- <command> [args]`. Reads have
**no marker**; writes always end in `!` — a bare write name is refused with a hint
(the `!` is a guarantee, not a convention). `ann commands` prints the reference table
below as markdown — it is regenerated from the command registry
(`src/surface/cli.ts`), never hand-maintained. `RECORDED_BY=<name>` stamps provenance
on recorded events (default: `agent`).

### The full reference

| Command | Args | What it does |
|---|---|---|
| `<name>` | `` | current path for one logical name |
| `journey` | `[id]` | the look-back (no id) · one node's walk (with id) · alias --journey |
| `status` | `[filter]` | every node's derived status (+ superseded marker) · alias --status |
| `check` | `` | integrity + gates + hashes + the journey state line · alias --check |
| `verify` | `` | the DRIFT read — reconcile the log's recorded claims vs filesystem/git reality (D1-D5 + store-external); exits 1 on any drift · alias --verify |
| `ledger` | `` | the write-rev ledger — rev + per-node last-write rev/at + hashes (the store-external integrity guard) · alias --ledger |
| `specs` | `` | the locked contract stack (name · type · @sha · path) · alias --specs |
| `providers` | `` | the adapter registry: providers, models, defaults (env-resolved, api key masked) · alias --providers |
| `config` | `` | the user config file (~/.ann/config.json; apiKey masked) · alias --config |
| `config!` | `set <key> <value>` | WRITE — save a config value (provider\|model\|baseUrl\|apiKey\|maxTokens); chmod 600, outside the repo; apiKey never echoed |
| `project` | `` | show the current project + known projects · alias --project |
| `project!` | `add\|use\|remove <path>` | WRITE — manage projects by PATH (each has its OWN journey); add <path> registers one |
| `cred!` | `set\|delete <service> <account> [secret]` | WRITE — OS keychain (macOS, DEV-ONLY local CLI): save/remove a secret via stdin; production = server-side env (12-factor) |
| `branch` | `<id>` | a node + every descendant's events, one walk · alias --branch |
| `confirm` | `<id>` | a node's gate card: intent · ACs · artifacts · gates |
| `detail` | `<id>` | a node's full derived detail: contract · gate states · artifacts (current/superseded) · blockers · events tail |
| `results` | `<id> [n]` | a task's results by kind (doc/commit/ref/evidence/link); with n, drill into one (doc=content, commit=git show, ref=file/dir, evidence=event) · alias --results |
| `packet` | `<id>` | the node's deterministic context packet (context-packet-spec; derived on demand, never saved) · alias --packet |
| `validate` | `[id]` | run the enabled validator rules (all nodes, or one node) — rule-id'd deterministic findings · alias --validate |
| `rules` | `[--write]` | the DERIVED check-rules registry (self-contained rule modules are the source) · alias --rules; --write regenerates rules/check/rules.json |
| `chain` | `` | the project flow config as data (work-type chains, F3 view) · alias --chain |
| `steps` | `` | the step registry — the pluggable surface future steps implement against · alias --steps |
| `next` | `` | the run-next proposal (F5 pull): active leg, frontmost-ready, pending gates, leg gate — derived, never assumed · alias --next |
| `flow` | `<id>` | a task's RESOLVED flow + chain validation (the data the frame will execute) · alias --flow |
| `run!` | `<id>` | WRITE — run a task through the FRAME (materialize → grill → activate → execute → verify → confirm → commit); resumable, stops at the first block |
| `commands` | `` | this table as markdown (the derived doc) · alias --commands |
| `help` | `` | usage · alias --help / -h |
| `read` | `<name>` | the L1 CONTENT read view — a current artifact's marker-stripped content + path + sha (core-design §5) · alias --read |
| `append!` | `<id> '<json>'` | WRITE — single-writer append; REFUSES the composite-owned kinds (created/submitted/confirmed/rejected/artifact-locked/superseded) |
| `spawn!` | `<id> '<contract-json>'` | WRITE — create a node; enforces the v14 contract schema + F-AC19 + id naming + the artifact/leg gates |
| `submit!` | `<id> grill\|confirm [confirmedSha]` | WRITE — the resumable gate write: `submitted` alone, so an interrupted gate stays blocked (confirm records the gate② content binding) |
| `gate!` | `<id> grill\|confirm accept\|reject [feedback]` | WRITE — human gate decision (submit + decide; the 3-reject bound is a CONSTANT owned here) |
| `lock!` | `<id> <name> <path> [type]` | WRITE — thin artifact record over the producer's own file: verifies path, hashes it, records artifact-locked {name, path, lockSha, type?, version?}; never writes/stamps/symlinks the file |
| `supersede!` | `<id> <name> <path> [note]` | WRITE — superseded event with a forward pointer (the one cross-task write; refuses a live locker) |

### When to use each

**Orient — start here.** `journey` (where the journey is + what's ahead) → `next`
(the run-next proposal: the one thing to do now) → `status [filter]` (statuses at a
glance) → `check` (integrity + gates + hashes + the state line — run it before and
after any change).

**Inspect a node.** `detail <id>` (full derived detail: contract · ACs · gates ·
artifacts · blockers) · `confirm <id>` (the gate card — exactly what a human decides
on at a gate) · `branch <id>` (the full event walk, node + descendants) ·
`results <id> [n]` (what the task produced — docs/commits/refs/evidence; drill into
one) · `packet <id>` (the deterministic context packet a runner would receive).

**Read the contracts.** `specs` (the locked stack: name · type · sha · path) ·
`read <name>` (one artifact's content by logical name) · bare `<name>` (just its
current path).

**See the engine.** `flow <id>` (a task's resolved step chain — the data the frame
will execute) · `chain` (the flow config as data) · `steps` (the step registry) ·
`rules [--write]` (the check-rule registry) · `validate [id]` (the validator rules).

**Configure.** `project` / `project!` (multi-project by path) · `config` / `config!`
(user config: provider wiring, keys) · `providers` (is my provider/key set?) ·
`cred!` (dev-only keychain for a secret).

**Drive a task — the lifecycle.**

1. `spawn! <id> '<contract-json>'` — create the node (a bare id spawns a leg;
   `leg/task` spawns a task). The v14 contract schema is enforced; `workType`/`flow`/
   `model` are task-level (legs typically omit them), and `flow` is an array when
   present.
2. Do the work, then record evidence: `append! <id> '{"at":"<date>","type":"evidence","refs":[...]}'`.
3. Open the task: `submit! <id> grill` then `gate! <id> grill accept|reject [feedback]`.
4. Record the deliverable: `lock! <id> <name> <path> [type]` — a THIN named-artifact
   record over the producer's own file (the collapse, leg 07). `path` is project-
   relative; ann verifies it exists, hashes the raw bytes, and records `artifact-locked
   {name, path, lockSha, type?, version?}`. It NEVER writes, copies, stamps, or symlinks
   the file — the bytes on disk are untouched, and any file type locks. `type` is an
   optional free-form tag with no placement meaning.
5. Close: `submit! <id> confirm` then `gate! <id> confirm accept`, then
   `append! <id> '{"at":"<date>","type":"completed",...}'`. A task is `done` only after
   a `completed` event — the confirm gate alone does not record it.
6. Advance a version: the NEW producer writes its draft and closes, then
   `supersede! <old-id> <name> <path-to-successor>` (the successor path is
   **project-relative and the file must already exist**; `supersede!` refuses a producer
   that isn't done). Then `lock! <new-id> <name> <path> [type]` —
   `current(<name>)` flips to the new producer.

**Automate.** `run! <id>` drives a task through the frame and stops at the first block
(fail-closed when no provider is configured). It is resumable, but re-enters the frame
— do **not** run it on an already-`completed` task to "close" it: it re-executes and
can regress the status. Close via the gate + `append! completed` flow instead.

## Architecture (current code)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  SURFACE — src/surface/cli.ts  (the CLI surface; src/cli.ts is a         │
│  compat symlink that keeps the immutable cli refs resolving)             │
│                                                                          │
│   READS:  journey · status · check · specs · providers · config ·        │
│           project · detail · results · packet · validate · rules ·       │
│           branch · confirm · chain · steps · next · flow · read ·        │
│           commands · help · <name>   (derived views — F3/F5)             │
│   WRITES: spawn! · append! · gate! · lock! · supersede! · submit! ·      │
│           run! · config! · project! · cred!   (single-writer binding)    │
│   cross-cutting: project resolution (--project/ANN_PROJECT/cwd-walk),    │
│                  lazy store proxy, resolveId (short ids)                 │
└───────────────┬───────────────────────────────┬────────────────────────────┘
                │ reads (store proxy)           │ composes prompts + calls
                ▼                               ▼
┌────────────────────────────────────────┐  ┌──────────────────────────────────┐
│  KERNEL — src/kernel/ (S5)             │  │  PROVIDER ADAPTER —              │
│                                        │  │   src/adapters/provider/         │
│  kernel.ts  orchestrator:             │  │                                  │
│   frontmostReady · lookBack ·         │──▶│  types.ts    frozen contract     │
│   materialize · validate · execute ·  │  │  registry.ts provider registry   │
│   verify · commit · advance           │  │  http.ts     OpenAI-compatible    │
│  step.ts    Step protocol             │  │              client (retry,       │
│  registry.ts id → implementation      │  │              fail-closed)         │
│  flow.ts    work-type chains (data)   │  │  credentials.ts keychain (dev)    │
│  interact.ts human channel (S8 seam)  │  │  config.ts   ~/.ann/config.json   │
│  steps/     validate (interactive     │  │  oplog.ts    logs/provider.jsonl  │
│              idea validator) ·        │  │                                  │
│             envision · spec (F9)      │  │                                  │
└───────────────┬────────────────────────┘  └──────────────────────────────────┘
                │ reads (derived views)
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  STORE — src/store/store.ts  (the single writer, LB-3)                    │
│                                                                            │
│   appendEvent()  ← THE ONLY write path (strict schema, gate sequencing,   │
│                   unknown-field rejection, per-type shapes)               │
│   derived views: current(name) · status · detail · results · check ·      │
│                  packet · parentConcluded · F-AC18/19 · traceability      │
│   vocab.ts      rules/schema/vocab.json (lazy-loaded)                     │
└───────────────┬──────────────────────────────────────────────────────────┘
                │ reads/writes
                ▼
┌──────────────────────────────┐   ┌───────────────────────────────────────┐
│  PER-PROJECT  <proj>/.ann/   │   │  PER-USER  ~/.ann/                     │
│  journey/   legs·nodes·events│   │  config.json  credentials + project    │
│  docs/      specs·designs    │   │   paths (chmod 600, masked)            │
│  rules/     vocab·check·adap.│   │  keychain     dev-only secret          │
└──────────────────────────────┘   └───────────────────────────────────────┘
```

## What's real vs planned

| Component | Status | Where |
|---|---|---|
| Store (single writer + derived views) | ✅ built | `src/store/` |
| Provider adapter (registry/config/credentials/http/oplog) | ✅ built | `src/abilities/llm/` |
| Grilling + Envision engines | ✅ built | `src/flow/steps/` |
| Context assembler (S3 packet) | ✅ built | `src/flow/materialize.ts` |
| Validators (S4, rule modules) | ✅ built | `src/flow/validators/` |
| CLI surface (reads + `!` writes) | ✅ built | `src/surface/cli.ts` |
| **Kernel (S5)** — planner, flow config, lifecycle orchestration | ✅ built — folded into the flow layer | `src/flow/` (`chain.ts` · `frame.ts`) |
| **Runner reviewer (S6)** | ✅ built | `src/flow/runner-review.ts` |
| **GitHub binding (S7)** | ✅ built | `src/abilities/github/` |
| **Human interface + renderers (S8)** | ✅ built (web UI = target surface) | `src/surface/renderers.ts` · `talk.ts` |
| **Evals harness (S9)** | ✅ built | `src/evals/` |
| **Skills/tools/MCP (step model)** | ❌ decided, build deferred | — |

The layer fold left compat symlinks in place: `src/cli.ts → surface/cli.ts`,
`src/kernel → flow`, `src/engines/* → src/flow/*`, `src/adapters/provider → src/abilities/llm`.

## Contract stack

The locked contracts live in `.ann/docs/` (the journey's own specs, per the change
protocol — supersede, never edit). `npm run ann -- specs` lists them with their lock
shas. The engine step model is decided: a shared dynamic capability environment
(skills · tools · mcp), with the provider adapter growing tool-calling by amendment.
