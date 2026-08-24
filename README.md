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

## Architecture (current code)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  SURFACE — src/cli.ts  (the ONLY surface today)                            │
│                                                                            │
│   READS:  journey · status · check · specs · providers · config · project  │
│           detail · results · packet · validate · rules · branch · confirm  │
│           chain · steps · next · flow   (kernel data — F3/F5 views)        │
│   WRITES: spawn! · append! · gate! · lock! · supersede! · config! ·        │
│           project! · cred!   (all through the store's single writer)       │
│   cross-cutting: project resolution (--project/ANN_PROJECT/cwd-walk),      │
│                  lazy store proxy, resolveId (short ids)                   │
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
| Provider adapter (registry/config/credentials/http/oplog) | ✅ built | `src/adapters/provider/` |
| Grilling + Envision engines | ✅ built (dogfood deferred) | `src/engines/` |
| Context assembler (S3 packet) | ✅ built | `src/engines/context.ts` |
| Validators (S4, 15 rule modules) | ✅ built | `src/engines/validators/` |
| CLI surface (reads + `!` writes) | ✅ built | `src/cli.ts` |
| **Kernel (S5)** — planner, flow config, lifecycle orchestration | ❌ not built — the CLI calls the store directly | `src/kernel/` |
| **Web surface (S8)** — the local-first client-server split | ❌ not built (decided, deferred) | `src/surface/` |
| **GitHub binding (S7)** · **Runner reviewer (S6)** · **Evals (S9)** | ❌ not built | — |
| **Skills/tools/MCP (step model)** | ❌ decided, build deferred | — |

## Contract stack

The locked contracts live in `.ann/docs/` (the journey's own specs, per the change
protocol — supersede, never edit). `npm run ann -- specs` lists them with their lock
shas. The engine step model is decided: a shared dynamic capability environment
(skills · tools · mcp), with the provider adapter growing tool-calling by amendment.
