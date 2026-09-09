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
on recorded events (default: `agent`). `ANN_STORE=<path>` points every command at a
DIFFERENT journey for session-read: an archived session (`…/journey`) or any project
root, both read-only unless they ARE the active project. Empty/unset = the active
session (unchanged); a bad/absent target fails closed at startup (named error, exit 1).

### The full reference

| Command | Args | What it does |
|---|---|---|
| `<name>` | `` | the path for one doc (docs manifest) or a current artifact's logical name |
| `journey` | `[id]` | the look-back (no id) · one node's walk (with id) · alias --journey |
| `status` | `[filter]` | every node's derived status (+ superseded marker) · alias --status |
| `check` | `` | integrity + gates + docs-manifest freshness + the journey state line · alias --check |
| `verify` | `` | the DRIFT read — reconciles the log's recorded claims vs filesystem/git reality (D1-D5 + store-external); exits 1 on any drift · alias --verify |
| `ledger` | `` | the write-rev ledger — rev + per-node last-write rev/at + hashes (the store-external integrity guard) · alias --ledger |
| `specs` | `` | the docs contract stack — the manifest → docs/<name>.md @ content-sha (upstream/referrers prose from the file head) · alias --specs |
| `providers` | `` | the adapter registry: providers, models, defaults (env-resolved, api key masked) · alias --providers |
| `config` | `` | the user config file (~/.ann/config.json; apiKey masked) · alias --config |
| `config!` | `set <key> <value>` | WRITE — save a config value (provider|model|baseUrl|apiKey|maxTokens); chmod 600, outside the repo; apiKey never echoed |
| `project` | `` | show the current project + known projects · alias --project |
| `project!` | `add|use|remove <path>` | WRITE — manage projects by PATH (each has its OWN journey); add <path> registers one |
| `cred!` | `set|delete <service> <account> [secret]` | WRITE — OS keychain (macOS, DEV-ONLY local CLI): save/remove a secret via stdin; production = server-side env (12-factor) |
| `branch` | `<id>` | a node + every descendant's events, one walk · alias --branch |
| `confirm` | `<id>` | a node's gate card: intent · ACs · gates · results |
| `detail` | `<id>` | a node's full derived detail: contract · gate states · artifacts (historical only) · blockers · events tail |
| `results` | `<id> [n]` | a task's results by kind (commit/ref/evidence/link); with n, drill into one (commit=git show, ref=file/dir, evidence=event) · alias --results |
| `packet` | `<id>` | the node's deterministic context packet (context-packet-spec; derived on demand, never saved) · alias --packet |
| `validate` | `[id]` | run the enabled validator rules (all nodes, or one node) — rule-id'd deterministic findings · alias --validate |
| `rules` | `[--write]` | the DERIVED check-rules registry (self-contained rule modules are the source) · alias --rules; --write regenerates rules/check/rules.json |
| `docs` | `[--write]` | the docs→git resolution index (docs/manifest.json — generated from docs/, never hand-maintained) · alias --docs; --write regenerates the manifest |
| `sessions` | `` | the archived sessions of this project (goal! archive history) — one line each: goal · status · verdict · legs; point at one read-only via ANN_STORE · alias --sessions |
| `chain` | `` | the project flow config as data (work-type chains, F3 view) · alias --chain |
| `steps` | `` | the step registry — the pluggable surface future steps implement against · alias --steps |
| `next` | `` | the run-next proposal (F5 pull): active leg, frontmost-ready, pending gates, leg gate — derived, never assumed · alias --next |
| `goal` | `` | the goal-session view (goal-session-design §9): goalId · status · the authored goal doc (docs/goal.md) · the generated contract · structural state · verdict (met/unconfirmed/open) · legs (status words only) · alias --goal |
| `flow` | `<id>` | a task's RESOLVED flow + chain validation (the data the frame will execute) · alias --flow |
| `run!` | `<id>` | WRITE — run a task through the FRAME (materialize → grill → activate → execute → verify → confirm → commit); resumable, stops at the first block |
| `advance!` | `` | WRITE — the OPERATOR ACTION (F5 approve→execute): integrity re-checked fail-closed → the advance re-derived (a stale proposal executes nothing) → the ADVANCE card + the builder's ONE approve → continue-leg runs the frontmost-ready through the frame (run!) and lands at its next human gate; advance-leg / closure-needed / none are NOT machine-executable — the boundary/closure/goal-consult card, then stop |
| `commands` | `` | this table as markdown (the derived doc) · alias --commands |
| `help` | `` | usage · alias --help / -h |
| `read` | `<name>` | the L1 CONTENT read view — marker-stripped content + path + sha; resolves via the docs manifest (the forward path), with a legacy current-artifact fallback for history · alias --read |
| `append!` | `<id> '<json>'` | WRITE — single-writer append; REFUSES the composite-owned kinds (created/submitted/confirmed/rejected/goal-met) and the RETIRED doc-artifact vocab (artifact-locked/superseded) |
| `spawn!` | `<id> '<contract-json>'` | WRITE — create a node; enforces the v14 contract schema + F-AC19 + id naming + the conclusion (commit-evidence)/leg gates |
| `submit!` | `<id> grill|confirm [confirmedSha]` | WRITE — the resumable gate write: `submitted` alone, so an interrupted gate stays blocked (confirm records the gate② content binding) |
| `gate!` | `<id> grill|confirm accept|reject [feedback]` | WRITE — human gate decision (submit + decide; the 3-reject bound is a CONSTANT owned here) |
| `goal!` | `met [feedback]` | WRITE — the HUMAN verdict that seals a structurally-exhausted session (goal-met on the goal root); refused for automated (agent) initiators, double-met, and any undecided submission |
| `goal!` | `archive [--override]` | WRITE — guarded structural reset: move .ann/journey → .ann/archive/sessions/<ts>-<slug>/ for a fresh goal; refuses without a met verdict (or --override), on store-external verify drifts, and on uncommitted tracked .ann/journey changes |
| `goal!` | `seed [goal-statement]` | WRITE — grill a goal at SESSION scope (EMPTY journey seeds new; a RE-SEEDABLE sole unconsumed goal is REPLACED after re-grilling — consumed/met goals refuse): the interactive idea-validation session (grill → batch-ask → research → re-grill → human verdict); on solid, synthesize goal.md (Goal:/Success criteria:) + seed/re-seed the goal leg + write docs/goal.md + regenerate the manifest; revise/reject seeds nothing |
| `spec!` | `[docName] [--amend]` | WRITE — grill the SEEDED goal at REQUIREMENTS/SYSTEM-DESIGN level into ONE amendable spec doc docs/<docName>.md (default requirements): PRODUCE grills the goal into a NEW name; --amend REWRITES an EXISTING in-force doc in place (specs are LIVING, amendable — the goal is not): the interactive SPECS grilling session; on GO it writes docs/<name>.md + regenerates the manifest — commit to publish (JSON refuses: interactive terminal only) |

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
   the task records the conclusion: `append! <id> '{"at":"<date>","type":"evidence","commits":["<sha>"]}'`.
   The retired artifact-lock/supersede vocab (v16) is refused by `append!`.
4. Close: `submit! <id> confirm` then `gate! <id> confirm accept` — GATE② (exit): the
   human confirms the result — then `append! <id> '{"at":"<date>","type":"completed",...}'`.
   A task is `done` only after a `completed` event — the confirm gate alone does not
   record it.

**Automate.** `run! <id>` drives a task through the frame (materialize → grill →
activate → execute → verify → confirm → commit) and stops at the first block
(fail-closed when no provider is configured). It is resumable, but re-enters the frame
— do **not** run it on an already-`completed` task to "close" it: it re-executes and
can regress the status. Close via the gate + `append! completed` flow instead.
`advance!` (the operator action) is the approved-execute half of `run next`
(functional-spec v2 F5): `next` proposes the frontmost-ready action, the builder's ONE
approve makes `advance!` re-check integrity (fail-closed on dirty state), re-derive the
advance (a stale proposal executes nothing), and on continue-leg run the
frontmost-ready through the frame — landing at the next human gate, never silently
past one. advance-leg / closure-needed / none are NOT machine-executable: the
boundary/closure/goal-consult card is presented and it stops (the authored-work
boundary, flow-control-spec v7 §5 — never a machine spawn, never a machine gate
answer).

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
│   WRITES: spawn! · append! · submit! · gate! · goal! · spec! · run! ·   │
│           advance! · config! · project! · cred!   (mutators end in !)   │
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
| **Skills/tools/MCP (step model)** | ❌ decided, build deferred | — |

The layer fold left compat symlinks in place: `src/cli.ts → surface/cli.ts`,
`src/kernel → flow`, `src/engines/* → src/flow/*`, `src/adapters/provider → src/abilities/llm`.

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
