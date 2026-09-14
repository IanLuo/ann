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
npm run ann -- serve            # the minimal SERVICE + UI: the journey views + the gate
                                # queue over HTTP; the bind resolves --host/--port >
                                # ANN_HOST/ANN_PORT > the general config (server.host/
                                # server.port) > builtin 127.0.0.1:8787
```

State comes from commands only — never read `events.jsonl` directly; never hand-edit
`node.json`/`events.jsonl`. Writes end in `!` (the mutator marker).

## Commands

Everything runs through one binary: `npm run ann -- <command> [args]`. Reads have
**no marker**; writes always end in `!` — a bare write name is refused with a hint
(the `!` is a guarantee, not a convention). **The two-tier writing model:** a dedicated
command exists where a write is a GATE/STRUCTURE transition (`spawn!` · `submit!` ·
`gate!` · `goal!` · `complete!`) or a COMMON GESTURE (`evidence!` — every task
concludes by citing its commit); everything else stays a shaped fact on `append!`
(`activated` · `waiting` · `extended` · refs/answers/trace evidence · `cancelled` · …).
`ann commands` prints the reference table
below as markdown — it is regenerated from the command registry
(`src/surface/cli.ts`), never hand-maintained. `RECORDED_BY=<name>` stamps provenance
on recorded events (default: `agent`). `ANN_STORE=<path>` points every command at a
DIFFERENT journey for session-read: an archived session (`…/journey`) or any project
root, both read-only unless they ARE the active project. Empty/unset = the active
session (unchanged); a bad/absent target fails closed at startup (named error, exit 1).

### The full reference

| Command | Args | What it does | --json |
|---|---|---|---|
| `<name>` | `` | the path for one doc (docs manifest) or a current artifact's logical name | `yes` |
| `journey` | `[id]` | the look-back (no id) · the COMPLETE NODE VIEW (with id): every node.json field (workType · flow · model too) + openQuestions · createdAt · the RESOLVED requiredInputs + status/gates/artifacts/blockers + the full numbered event walk · alias --journey | `yes` |
| `events` | `<id> [n]` | the EVENT LIST (numbered exactly as journey <id> numbers it) · with n, the DRILL: that event's raw record + LINKS to more data (commit → the results drill · ref → its existence · artifact → ann read <name> · gate event → ann confirm <id>) — the shared drill every node view points at | `yes` |
| `status` | `[filter]` | every node's derived status (+ superseded marker) · alias --status | `yes` |
| `check` | `` | integrity + gates + docs-manifest freshness + the journey state line · alias --check | `yes` |
| `verify` | `` | the DRIFT read — reconciles the log's recorded claims vs filesystem/git reality (D1-D5 + store-external); exits 1 on any drift · alias --verify | `yes` |
| `ledger` | `` | the write-rev ledger — rev + per-node last-write rev/at + hashes (the store-external integrity guard) · alias --ledger | `yes` |
| `log` | `[--task <id>] [--run <runId>] [--level <level>] [--since <iso|30m>] [--tail <n>]` | THE OPERATIONAL LOG READ (leg 12/05 — observability for debugging): the scratch JSONL action log (logs/operation.jsonl, GITIGNORED — never the record) as a derived tail — one line per engine action (command · write · frame phase · driver turn · stop) carrying a WALL-CLOCK ts (the journey events are date-only), the actor/provenance, the REDACTED inputs, the outcome, the duration and the CORRELATION ID (runId · taskId · turn); a whole run reconstructs from one --run. Filters: --task <id> · --run <runId> · --level info|warn|error (that level and above) · --since <iso|30m|2h|1d> · --tail <n> (default 50) · alias --log | `yes` |
| `specs` | `` | the docs contract stack — the manifest → docs/<name>.md @ content-sha (upstream/referrers prose from the file head) · alias --specs | `yes` |
| `providers` | `` | the adapter registry: providers, models, defaults (env-resolved, api key masked) · alias --providers | `yes` |
| `config` | `` | the user config file (~/.ann/config.json; apiKey masked) · alias --config | `yes` |
| `config!` | `set <key> <value>` | WRITE — save a config value (provider|model|baseUrl|apiKey|maxTokens); chmod 600, outside the repo; apiKey never echoed | `yes` |
| `project` | `` | show the current project + known projects · alias --project | `yes` |
| `project!` | `add|use|remove <path>` | WRITE — manage projects by PATH (each has its OWN journey); add <path> registers one | `yes` |
| `cred!` | `set|delete <service> <account> [secret]` | WRITE — OS keychain (macOS, DEV-ONLY local CLI): save/remove a secret via stdin; production = server-side env (12-factor) | `yes` |
| `branch` | `<id>` | a node + every descendant's events, one walk · alias --branch | `yes` |
| `confirm` | `<id>` | a node's gate card: intent · ACs · gates · results | `yes` |
| `detail` | `<id>` | a node's full derived detail: contract · gate states · artifacts (historical only) · blockers · events tail | `yes` |
| `results` | `<id> [n]` | a task's results by kind (commit/ref/evidence/link); with n, drill into one (commit=git show, ref=file/dir, evidence=event) · alias --results | `yes` |
| `packet` | `<id>` | the node's deterministic context packet (context-packet-spec; derived on demand, never saved) · alias --packet | `yes` |
| `validate` | `[id]` | run the enabled validator rules (all nodes, or one node) — rule-id'd deterministic findings · alias --validate | `yes` |
| `rules` | `[--write]` | the DERIVED check-rules registry (self-contained rule modules are the source) · alias --rules; --write regenerates rules/check/rules.json | `yes` |
| `docs` | `[--write]` | the docs→git resolution index (docs/manifest.json — generated from docs/, never hand-maintained) · alias --docs; --write regenerates the manifest | `yes` |
| `sessions` | `` | the archived sessions of this project (goal! archive history) — one line each: goal · status · verdict · legs; point at one read-only via ANN_STORE · alias --sessions | `yes` |
| `chain` | `` | the project flow config as data (work-type chains, F3 view) · alias --chain | `yes` |
| `steps` | `` | the step registry — the pluggable surface future steps implement against · alias --steps | `yes` |
| `next` | `` | the run-next proposal (F5 pull): active leg, frontmost-ready, pending gates, leg gate — derived, never assumed · alias --next | `yes` |
| `goal` | `` | the goal-session view (goal-session-design §9): goalId · status · the authored goal doc (docs/goal.md) · the generated contract · structural state · verdict (met/unconfirmed/open) · legs (status words only) · alias --goal | `yes` |
| `flow` | `<id>` | a task's RESOLVED flow + chain validation (the data the frame will execute) · alias --flow | `yes` |
| `run!` | `<id>` | WRITE — run a task through the FRAME (materialize → grill → activate → execute → verify → confirm → commit); resumable, stops at the first block | `yes` |
| `advance!` | `` | WRITE — the OPERATOR ACTION (F5 approve→execute): integrity re-checked fail-closed → the advance re-derived (a stale proposal executes nothing) → the ADVANCE card + the builder's ONE approve → continue-leg runs the frontmost-ready through the frame (run!) and lands at its next human gate; advance-leg / closure-needed / none are NOT machine-executable — the boundary/closure/goal-consult card, then stop | `yes` |
| `commands` | `` | this table as markdown (the derived doc) · alias --commands | `yes` |
| `help` | `` | usage · alias --help / -h | `yes` |
| `read` | `<name>` | the L1 CONTENT read view — marker-stripped content + path + sha; resolves via the docs manifest (the forward path), with a legacy current-artifact fallback for history · alias --read | `yes` |
| `append!` | `<id> '<json>'` | WRITE — single-writer append; REFUSES the composite-owned kinds (created/submitted/confirmed/rejected/goal-met) and the RETIRED doc-artifact vocab (artifact-locked/superseded). `cancelled` (a task no longer needed — the counterpart of the submit!/gate! close) is recordable here with a REQUIRED reason | `yes` |
| `spawn!` | `<id> '<contract-json>'` | WRITE — create a node; enforces the v14 contract schema + F-AC19 + id naming + the conclusion (commit-evidence)/leg gates | `yes` |
| `submit!` | `<id> grill|confirm [confirmedSha]` | WRITE — submit finished work at a gate for the human decision (the SUCCESS half of the task close; the counterpart is cancel — no longer needed): records `submitted` — the task blocks and waits for `gate! accept|reject`; an interrupted gate stays blocked (resumable), never looks un-started. `[confirmedSha]` (confirm gate only) binds the decision to the exact bytes under review | `yes` |
| `gate!` | `<id> grill|confirm accept|reject [feedback]` | WRITE — human gate decision (submit + decide; the 3-reject bound is a CONSTANT owned here); a CONFIRM accept AUTO-CLOSES the task when the conclusion evidence is already present (the same rule the frame runs) — with the evidence missing the task stays `accepted` and the result names the `complete!` still owed | `yes` |
| `evidence!` | `<id> <sha>[,<sha>…] [--refs a.md,b.md] [--note '<text>'] [--claims '<json>'] [--checks '<json>']` | WRITE — the CONCLUSION record (F-AC18): structured commit evidence naming the committed doc/code that carries the deliverable (commits[] non-empty, a sha per entry) plus the OPTIONAL structured conclusion (format v18, MECHANICAL since leg 12/03): --claims = one {ac, check?, statement?, evidence?} per acceptance criterion — `check` is the ac→CHECK MAPPING (the recorded run that covers the AC; `statement` is optional prose, derived from the mapping when absent) and evidence entries are POINTERS (commit sha · ref path · doc name) resolved at READ time; --checks = {command, result: pass|fail, detail?, sha?, source?} (what was RUN) — a check without a `source` is LABELLED `reported` by the writer, and `source:'captured'` is REFUSED here (engine-produced: run capture!); the shape stays the store's — a validated front over the same L1 write, provenance from RECORDED_BY, and a bad JSON argument writes nothing | `yes` |
| `capture!` | `<id> '<command>'` | WRITE — THE CAPTURED CHECK (leg 12/03: the record is a consequence, not a claim): the engine RUNS one project command and records what happened as a FACT — {command, result (the REAL exit code: 0 → pass, else fail), exitCode, detail (output digest/summary), sha (the repo bytes the run saw), source:'captured'} — distinguishable in the log from a REPORTED check (--checks on evidence!, which stays available but is LABELLED 'reported' by the writer). MECHANISM: (a) engine-run with a CLOSED ALLOWLIST (npm test · npm run typecheck · npm run build · ann check · ann verify); GUARD: the caller names a command — the name must be one of those literals, each mapped to a fixed argv spawned with shell:false, so no arbitrary string ever reaches an exec and the engine does not become a general shell (the shell ability is contract-declared and UNBUILT); the tree must be clean outside the ann store, and the sha is READ FROM GIT, never typed. REJECTED: (b) runner-supplied capture with engine validation (sha resolves · command allowlisted · result ∈ pass|fail) — it cannot produce the outcome (the result stays typed by the reporter, which is the hole this closes) and its guards are a strict subset of (a). The write is the SAME L1 write (store.appendCaptured; the general writer refuses a captured check by name) and provenance comes from RECORDED_BY. A failing run records result=fail and the close REFUSES (no-captured-pass). | `yes` |
| `complete!` | `<id> [--note '<text>']` | WRITE — the EXPLICIT DONE terminal (a confirm accept auto-closes on evidence, so this gesture is the accepted-without-evidence exception; an already-completed task gets an idempotent refusal): refuses without the confirm gate's LAST decision being an ACCEPT and without the conclusion evidence — the F-AC18 predicate (TIGHTENED, leg 12/03: a REPORTED check is refused by name; leg 12/02: so is a CAPTURED FAILURE recorded on a CITED commit — `cited-check-failed`): evidence.commits[] AND the structured conclusion (a claim per acceptance criterion, each mapped to a check the log holds) AND at least one CAPTURED pass bound to a cited commit AND no captured failure on one | `yes` |
| `goal!` | `met [feedback]` | WRITE — the HUMAN verdict that seals a structurally-exhausted session (goal-met on the goal root); refused for automated (agent) initiators, double-met, and any undecided submission | `yes` |
| `goal!` | `archive [--override]` | WRITE — guarded structural reset: move .ann/journey → .ann/archive/sessions/<ts>-<slug>/ for a fresh goal; refuses without a met verdict (or --override), on store-external verify drifts, and on uncommitted tracked .ann/journey changes | `yes` |
| `goal!` | `seed [goal-statement]` | WRITE — grill a goal at SESSION scope (EMPTY journey seeds new; a RE-SEEDABLE sole unconsumed goal is REPLACED after re-grilling — consumed/met goals refuse): the interactive idea-validation session (grill → batch-ask → research → re-grill → human verdict); on solid, synthesize goal.md (Goal:/Success criteria:) + seed/re-seed the goal leg + write docs/goal.md + regenerate the manifest; revise/reject seeds nothing | `yes` |
| `spec!` | `[docName] [--amend]` | WRITE — grill the SEEDED goal at REQUIREMENTS/SYSTEM-DESIGN level into ONE amendable spec doc docs/<docName>.md (default requirements): PRODUCE grills the goal into a NEW name; --amend REWRITES an EXISTING in-force doc in place (specs are LIVING, amendable — the goal is not): the interactive SPECS grilling session; on GO it writes docs/<name>.md + regenerates the manifest — commit to publish (JSON refuses: interactive terminal only) | `yes` |
| `serve` | `[--host <h>] [--port <n>]` | RUN — the minimal SERVICE + UI vertical (the goal's AC-1): a thin HTTP binding over THIS command layer (same L1 reads/writes, the SAME value-canonical JSON as --json; no second state derivation) — reads journey·status·next·detail·confirm·results·packet·the whole-journey gate queue, the gate write (accept|reject + feedback), and the UI page at /; the BIND comes from --host/--port > ANN_HOST/ANN_PORT > the general config (server.host/server.port — the project registry + the ~/.ann/config.json overlay) > the builtin 127.0.0.1:8787; credentials stay server-side (JSON refuses: a daemon has no one-document answer) | `yes` |

### When to use each

**Orient — start here.** `journey` (where the journey is + what's ahead) → `next`
(the run-next proposal: the one thing to do now — to ACT on it, `advance!` (the
operator action, functional-spec v2 F5) re-checks integrity fail-closed, re-derives
the advance (a stale proposal executes nothing), and on the builder's ONE approve runs
the frontmost-ready through the frame, landing at the next human gate) →
`status [filter]` (statuses at a glance) → `check` (integrity + gates + hashes +
the state line — run it before and after any change).
status · the locked `goal.md` · verdict); when `next` falls quiet and every leg is
done, it names the choice — `goal! met` seals the verdict, `goal! archive` resets
for a fresh goal.

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

1. `spawn! <id> '<contract-json>'` — create the node (a bare id spawns a leg; `leg/task`
   spawns a task). The v14 contract schema is enforced; a leg spawn checks the leg gate
   (every previous-leg task done — the derived aggregate); `workType`/`flow`/`model` are
   task-level (legs typically omit them), and `flow` is an array when present.
2. `submit! <id> grill` → `gate! <id> grill accept|reject [feedback]` — GATE① (entry):
   the approach is validated before execution (3-reject bound is a constant).
3. Do the work, then conclude it as STRUCTURED COMMIT EVIDENCE (docs-as-git): content
   work stages its doc to `docs/<name>.md` (code work lands in `src/`) and commits it;
   the task records the conclusion with the gesture command —
   `evidence! <id> <sha> [--refs a.md,b.md] [--note '<text>'] [--claims '<json>']`
   (commits[] non-empty, a sha per entry). The retired artifact-lock/supersede vocab
   (v16) is refused by `append!`.
3a. VERIFY BY ACT, not by typing (leg 12/03 — the record is a consequence, not a claim):
   `capture! <id> '<command>'` RUNS one allowlisted project command (`npm test` ·
   `npm run typecheck` · `npm run build` · `ann check` · `ann verify`) and records the
   REAL exit code, an output digest and the sha the run saw, as a FACT
   (`source: 'captured'`); `--checks` on `evidence!` stays available but is LABELLED
   `reported` (what a runner says, not what the engine saw). The claims MAPPED each AC to
   the act that covers it (`--claims '[{"ac":"AC-1","check":"npm test"}]'`).
4. Close: `submit! <id> confirm` then `gate! <id> confirm accept` — GATE② (exit): the
   human confirms the result. When the conclusion evidence is already in the log the
   ACCEPT closes the task in the same gesture (`completed` rides the accept — the same
   rule the frame runs, one rule everywhere). Without the evidence the task honestly
   reads `accepted`, and `complete! <id>` (which refuses without the accept and without a
   CAPTURED pass bound to a cited commit — a reported-only conclusion is refused by name)
   records the explicit `completed` — `done` follows only from that event.

**Debug — what ann actually DID.** `log [--task <id>] [--run <runId>] [--level w] [--since 30m] [--tail <n>]`
tails the OPERATIONAL log (below): one line per engine action with a wall-clock
timestamp, the actor, the redacted inputs, the outcome and the duration — correlated by
`runId` · `taskId` · `turn`, so one run rebuilds in order (what ran, why, how it ended).
Three views of the trace, no duplication: the events (the record) · the op-log
`logs/provider.jsonl` (the model calls) · this operational log (commands · writes ·
phases · turns · stops).

**Automate.** `run! <id>` drives a task through the frame (materialize → grill →
activate → execute → verify → confirm → commit) and stops at the first block
(fail-closed when no provider is configured). It is resumable, but re-enters the frame
— do **not** run it on an already-`completed` task to "close" it: it re-executes and
can regress the status. Close via the gate + `evidence!` (+ `complete!` when the
accepted task still lacks the evidence) flow instead.
`advance!` (the operator action) is the approved-execute half of `run next`
(functional-spec v2 F5): `next` proposes the frontmost-ready action, the builder's ONE
approve makes `advance!` re-check integrity (fail-closed on dirty state), re-derive the
advance (a stale proposal executes nothing), and on continue-leg run the
frontmost-ready through the frame — landing at the next human gate, never silently
past one. advance-leg / closure-needed / none are NOT machine-executable: the
boundary/closure/goal-consult card is presented and it stops (the authored-work
boundary, flow-control-spec v7 §5 — never a machine spawn, never a machine gate
answer).

### The operational log — observability for debugging

A self-driving loop is undebuggable without a detailed log of what ann is doing, why, and
how it ended (design record: `.agents/plan/self-driving-design.md`). The engine writes one
JSONL line per ACTION to **`<project>/logs/operation.jsonl`** — the SAME gitignored scratch
home as the provider op-log, never the record (the journey events stay the record) — and
`ann log` is the derived read over it (plus `GET /api/log` for the page).

```
{ts, level, event, actor, runId, taskId?, turn?, command?, phase?, inputs?, outcome, durationMs?, error?}
```

* **ts** — a WALL-CLOCK ISO instant (the journey's `at` is DATE-only: time lives here).
* **event** — `command` (one per CLI/HTTP invocation) · `write` (one per mutator, a
  REFUSAL included) · `phase` (the frame: materialize · gate:grill · activate · execute ·
  verify · gate:confirm · commit · advance — enter + exit with the duration) · `turn` (the
  driver's proposal + the CODE verdict — accepted / refused-by-name) · `stop` (the route
  reason it ended on).
* **correlation** — `runId` (a command invocation · a driver run · an HTTP request · a
  service boot) · `taskId` · `turn`: `ann log --run <runId>` reconstructs a whole run in
  order. The op-log lines carry the SAME `runId`, so the two files join: one `--run` spans
  the model calls, the driver's turns, the frame's phases and the writes.
* **inputs** — REDACTED (NFR-SEC-1): a value under a secret-looking key is dropped, a
  value matching a known secret (env-derived) is dropped, and a prompt/completion is
  stored as `{chars, sha}` — never verbatim.
* **invariants** — logging NEVER throws into the flow (a write failure warns and the
  engine proceeds); the file is BOUNDED (rotates to `.1` at 4 MiB — 2×cap on disk, max);
  the scratch home ignores ITSELF (`logs/.gitignore`), so no `git add -A` can sweep it
  into the record.

## Architecture (current code)

The layers are architecture v3's L0–L3 model: **L3 surface/abilities** (handlers +
the provider/human channels) ← **L2 flow** (frames, engines, composite drivers) ←
**L1 commands** (the ONLY store interface — reads and writes) ← **L0 store** (the
single writer + derived views).

```
┌──────────────────────────────────────────────────────────────────────────┐
│  L3 SURFACE — src/surface/ (cli.ts · handlers.ts · command-renderers.ts │
│  renderers.ts · talk.ts) — the value-canonical CLI: every command is a  │
│  PURE HANDLER returning an Outcome; runMain routes → the ONE emit       │
│                                                                          │
│   READS:  journey · status · check · verify · ledger · specs ·          │
│           providers · config · project · branch · confirm · detail ·    │
│           results · packet · validate · rules · docs · sessions ·       │
│           chain · steps · next · goal · flow · read · commands ·        │
│           help · <name>   (derived views — F3/F5)                       │
│   WRITES: spawn! · append! · submit! · gate! · evidence! · capture! ·        │
│           complete! · goal! · spec! · run! · advance! · config! ·             │
│           project! · cred!   (mutators end in !)                            │
└───────────────┬───────────────────────────────┬────────────────────────────┘
                │ handlers compose              │ interactive carve-outs
                ▼                               ▼ (goal! seed · spec! · run! · advance!)
┌────────────────────────────────────────┐  ┌──────────────────────────────────┐
│  L2 FLOW — src/flow/                 │  │  L3 ABILITIES — src/abilities/     │
│  frame.ts (the run! driver)          │  │  llm/     provider adapter (http,  │
│  grill-session.ts (portable core +    │  │           registry, credentials,   │
│    GOAL/DESIGN/SPECS profiles)        │  │           config, oplog)           │
│  goal-grill · goal-seed · spec-grill  │  │  github/  the S7 binding           │
│    · spec-doc · design-grill          │  │  recording.ts  the transcript half │
│  operator-action.ts (advance!)        │  │                                   │
│  materialize (packet) · validators ·  │  │  interact = the human channel (S8  │
│  steps/ · chain · config ·            │  │  seam; console impl in surface)    │
│  session-shared · runner-review       │  └──────────────────────────────────┘
└───────────────┬────────────────────────┘
                │ compose mutators + derived views (the ONLY store interface)
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  L1 COMMANDS — src/commands/index.ts  (Commands — the single-writer      │
│  facade: spawn/submit/gate/append · goal-seed/met/archive · advance() ·  │
│  look-back · status/journey/goal derivations · F-AC18/19 · vocab)        │
└───────────────┬────────────────────────────────────────────────────────┘
                │ reads/writes
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  L0 STORE — src/store/store.ts  (THE single writer, LB-3)                │
│  appendEvent() ← the only write path · ledger (write-rev guard) ·        │
│  derived views · docs.ts (the docs→git manifest)                         │
└───────────────┬────────────────────────────────────────────────────────┘
                │ reads/writes
                ▼
┌──────────────────────────────┐   ┌───────────────────────────────────────┐
│  PER-PROJECT  <proj>/.ann/   │   │  PER-USER  ~/.ann/                     │
│  journey/   legs·nodes·events│   │  config.json  credentials + project    │
│  docs/      the doc home     │   │   paths (chmod 600, masked)            │
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
| **Goal-session lifecycle (v6/v17)** — `goal` view · `goal! seed` grill → `docs/goal.md` · `goal! met` verdict · `goal! archive` reset | ✅ built | `src/flow/goal-grill.ts` · `goal-seed.ts` + `src/commands/` (seedGoal · verdict · archiveJourney) |
| **SPECS grill area (leg 05)** — `spec!` produce/amend: grill the seeded goal into ONE amendable spec doc `docs/<name>.md`, PRODUCE lands a new name · `--amend` rewrites an in-force doc in place | ✅ built | `src/flow/spec-grill.ts` · `spec-doc.ts` |
| **Operator action (leg 07)** — `advance!`: F5 approve→execute (functional-spec v2 F5 · flow-control v7 §2/§5) — integrity re-checked fail-closed, advance re-derived, continue-leg runs the frame, boundary stops presented | ✅ built | `src/flow/operator-action.ts` |
| **Operational log (leg 12/05)** — the third view of the trace: JSONL action log (`logs/operation.jsonl`, scratch) + the `ann log` read + `GET /api/log`; correlated by runId · taskId · turn | ✅ built | `src/abilities/obs/log.ts` |
| **Skills/tools/MCP (step model)** | ❌ decided, build deferred | — |

The layer fold is complete — the legacy tier paths are gone, and current code
lives at `src/surface` · `src/commands` · `src/flow` · `src/abilities` · `src/store`.

## Goal-scoped sessions

> **Status: implemented (v6 + v17 docs-as-git)** — `goal` · `goal! met` · `goal! archive`
> (and `goal! seed`, the interactive grill) are in the registry above. Authoritative design:
> `.agents/artifacts/goal-session-design.html` · implementation plan:
> `~/.claude/plans/enchanted-growing-wombat.md`.

### Session lifecycle — one glance

```text
 GRILL ─► goal.md ─► 01-goal/node.json ─► WORK LEGS ─► exhausted ─► goal! met ─► goal! archive
          locked        generated 1:1      (gated)      (unconfirmed)  guarded     │
   ┌────────────────────── ONE SESSION (immutable) ────────────────────────┘          ▼
   └────────── a changed goal = NEW SESSION (archive → re-grill) ◄──────── fresh goal
```

### 1 · One source of truth

```text
  grilling first                 deterministic 1:1              the machinery
     │                                │                             │
     ▼                                ▼                             ▼
  goal.md                   01-goal/node.json        goal · next · goal! met · packets
  ────────────────────      ─────────────────────        │
   Goal:  <…>                 intent:  ← Goal:            │ reads node.json only
   Success criteria: <…>      acs:     ← Success criteria: │ (never a hand-authored
  ────────────────────      ─────────────────────        │  duplicate — no drift)
  AUTHORED truth            GENERATED data              │
  LOCKED (docs/goal.md —   IMMUTABLE                   │
  git content, manifest sha)             never hand-edited           ▼
     │                        │                    fixed per session —
     └──────── changed goal ⇒ NEW SESSION (no in-place edit anywhere)
```

### 2 · The goal leg — designated SEEDED CHILDLESS leg

```text
 01-goal/        the journey's ONE childless leg — seeded, self-evented
  ├─ goal.md          node-owned, locked
  ├─ node.json        generated 1:1
  └─ events.jsonl     ← ROOT-EVENTS EXCEPTION (this leg only — id-scoped)
       created ──────┐
       completed ────┴─ seed events ⇒ legStatus derives done
       artifact-locked│              ⇒ first work leg's gate (legGateMet) OPENS
       goal-met ──────┘ protected · STATUS-INERT (no new status word)
       ── nothing else may sit on leg roots
       ── goal-met refused on any task id or non-frontmost leg

  identity test: a 01-goal-named leg that CARRIES TASKS is an ordinary work leg, not the goal.
  why the seed events matter: status-inert alone would hard-block all work —
  the childless leg needs derived done for the first gate to open.
```

### 3 · The stability ladder

```text
  GOAL    goal.md + generated node      IMMUTABLE — criteria change ⇒ NEW SESSION
   │
  SPECS   docs-in-force                 revisable INSIDE the goal
   │      (leg 05: spec! produce/amend — grill the seeded goal into ONE amendable
   │      doc docs/<name>.md; specs are living, amendable guidance — the goal is not)   │
  TASKS   code / small functions        MAY revise a spec · never the goal
   │
  RUN     the realized journey

  discriminator = SUCCESS CRITERIA, not size:
    same criteria → add a task   ·   criteria change → new goal / new session
```

### 4 · `goal! met` — guards

```text
  goal! met
   ├─ HUMAN initiator only        refuse an automated RECORDED_BY
   ├─ no DOUBLE-met               refuse when verdict already met
   ├─ no UNDECIDED submissions    a done task may still hide one → refuse
   ├─ no POST-met spawns          a stale verdict is never silently carried
   └─ no reopen (today)           a wrong met is recoverable ONLY via the
                                  specced archive override path
```

### 5 · `next` = four-state consult

```text
         ann next (read: frontmost leg + structural state + verdict)

 ┌─────────────┬──────────────────┬────────────────────────┬────────────────────┐
 │ no goal     │ seeded, no work  │ exhausted, unconfirmed │ met                │
 │ (empty)     │ (goal done)      │ (all derived done)     │                    │
 ├─────────────┼──────────────────┼────────────────────────┼────────────────────┤
 │ grill+seed  │ open first task  │ CHOICE MENU            │ session complete → │
 │             │                  │                         │ archive / new goal │
 └─────────────┴──────────────────┴────────────────────────┴────────────────────┘

  the choice menu (never the blind "journey goal complete"):
   1  new goal     criteria met  → goal! met → goal! archive
   2  add a task   spec refinement → ordinary superseding task under the same goal
   3  subtle task  e.g. a quality gate
  the session ends only when a HUMAN says met.
```

### 6 · `goal! archive` — guarded structural reset

```text
  goal! archive                     WRITE · significant · dogfoodable

  SCOPED guard:
    requires   verdict MET (or explicit override — so it can archive its own journey)
    refuses    NEW check/verify problems        (NOT the repo's known 15/4 baseline)
    refuses    uncommitted TRACKED changes      (never untracked scratch)

  reset (a designated cross-folder writer — alongside spawn! · advance! · spec!):
    .ann/journey/legs/*  +  .ledger.json
        │  move
        ▼
    .ann/archive/sessions/<ts>-<slug>/journey/{legs, .ledger.json}
        │  layout round-trips Store()  ⇒ archived session loads READ-ONLY
        ▼
    live ledger entry removed   ⇒ verify sees no node-deleted · id reuse safe
    legs emptied                ⇒ back to state: no goal (MISSING)
```

### 7 · Docs-in-use = the DERIVED index

```text
  in-force docs (locked specs in journey legs/artifacts)
        │  current() — derived, always fresh, never duplicated
        ▼
  "ann specs"  = THE index of in-force docs  ← docs-in-use
        │
        │  NO on-disk .ann/docs layer (deleted leg 07; e2e asserts it's gone —
        │  a store-unwalked folder silently goes stale)
        │
        ▼  optional, generated
  project-root docs/        browseable copy · scripted + committed (like README regen)
                            NEVER read by the store · ship it with the specs tier?
```

## Contract stack

The in-force contracts are git content at **`docs/`** — `npm run ann -- specs` lists the
manifest → `docs/<name>.md` @ content-sha (the manifest is generated, never
hand-maintained). Specs are LIVING guidance: `spec!` produce writes a NEW doc,
`spec! --amend` rewrites an in-force doc in place (the old version stays in git
history) — the goal doc (`docs/goal.md`) is the one immutable contract. The engine
step model is decided: a shared dynamic capability environment (skills · tools · mcp),
with the provider adapter growing tool-calling by amendment.
