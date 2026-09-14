# The self-driving product — design record (pre-spec, DRAFT)

*Status: DRAFT — feeder for SPECS sessions. Nothing in force until it lands as doc amendments + code.*

## The endgame (the human's statement)

> *"When ann becomes a working product, it has to work on its own — no more operator; only the driver drives the work forward."*

Today **four things are out-of-band** (an operator or a habit owns them). In the product, each becomes a capability:

| Today (operator-dependent) | The capability | The gap the engine already models |
|---|---|---|
| The work is done by a herded agent pane | **THE RUNNER** — the `execute` step: a bounded, tool-using agent loop (the SHARED DYNAMIC capability environment: skills · tools · mcp, selected at runtime) that does the task and produces the evidence commits | the implementation chain is EMPTY and the frame says: *"waiting for the runner: no evidence.commits[] recorded since activation (empty chain — the runner does the work)"* |
| The operator commits the journey writes after each accept | **THE COMMIT MIRROR** — one act, one commit, with a rule, a check, and an owner (the drafted record) | *"The engine writes the store and never commits; the commit is an out-of-band actor duty with no rule, no check, and no owner."* |
| The driver runs when a human clicks DRIVE | **THE SUPERVISOR** — the loop drives until a human gate, waits, and resumes; the driver dispatches the runner | the driver is a route (`POST /api/drive`) invoked by a click |
| The operator watches status and fans out workers | **THE DISPATCH** — the driver dispatches the runner (bounded, fail-closed), landing at the next human decision | — |

**The human's role collapses to the gates** — accept/reject · approve a GENERATED draft · the goal verdict (met/archive) · the decision forks. Nothing else.

## Observability — the detailed operational log (the debugger of the loop)

A self-driving loop is undebuggable without a *detailed* log of what ann is doing, why, and how it ended. Design:

- **A structured JSONL operational log** — one line per engine action: a **wall-clock timestamp** (the journey events are DATE-only — this log carries the time), the actor/provenance, the phase/command, the inputs (redacted), the outcome, the duration, an error when one occurs, and a **correlation id** (run · task · turn) so a whole run can be reconstructed.
- **What it complements (no duplication):** the existing **op-log** (the model calls: provider · model · promptChars · tokens · latency · retries) and the **trace/transcript** (the step-level transcript inside the event log). The operational log is the THIRD view: **commands · phases · decisions · stops**, with time.
- **Integration points:** every CLI/command invocation + outcome · the driver's turns (the proposal, the CODE verdict — accepted / refused-by-name, the stop/route reason) · the frame's phases (materialize · gate · activate · execute · verify · confirm · commit) · the gate writes · the provider calls' outcomes.
- **Invariants:** logging **never throws into the flow** (fail-open, with a warning — observability must not break the engine); **secrets never appear** (NFR-SEC-1: no api key, no headers; prompts not verbatim — chars/hash, as the op-log already does); **bounded** (rotation/size caps, never unbounded growth); the log is **scratch, never the record** (the journey events remain the record — gitignored, like `logs/`).
- **A read for debugging:** an `ann log`-style read (tail/filter by task · run · level · time) so no raw-file spelunking is needed — plus the same over the service, for the page.

## The slices (in landing order — the log first, so the rest is debuggable)

1. **THE OBSERVABILITY LOG** — the detailed operational log + its read (this is what makes the autonomous slices debuggable). *(spawned as `12-operate-loop/05-implementation-observability-log`)*
2. **THE RUNNER** — the WORKER PROTOCOL + the pluggable worker registry (below), `pi` as the **first** worker kind, the execute step. Hard guard: a worker kind is NOT a general shell (allowlists · sandboxing · the container form — the `12/03` lesson).
3. **THE COMMIT MIRROR** — one act, one commit, a rule + a check + an owner.
4. **THE SUPERVISOR** — drive → gate → wait → resume; the driver dispatches the runner.

## The WORKER PROTOCOL — pluggable workers (pi is one kind, never the only one)

**The principle.** Ann's comparative advantage is **context micro-management + process control**; a coding harness's is **doing the work**. So the runner must be an interchangeable **worker**: a protocol (what a worker is) + a registry of **kinds** (how each is launched), selected per task — *not* a hardcoded `pi`.

**The protocol (L2 declares it; L3 modules implement it — like the `llm`/`interact`/`shell`/`tool` abilities):**

```
IN     the task contract (ACs) · the MATERIALIZED CONTEXT PACKET (Ann's scoping — exactly this job's context)
       · the workdir · the allowed capabilities (skills · tools · mcp — a CLOSED pool) · the sandbox policy
       · the evidence contract (what must come back: the committed work + the captured checks)
OUT    the work itself (committed) · the CAPTURED evidence (the checks run + their results + the sha they ran against)
       · a machine-readable stop reason
RULES  never decides a gate · never writes the journey except through the sanctioned evidence path
       · bounded (turns/time) · fail-closed (a failure = a named stop, zero fabricated evidence)
```

**The registry (one registry per class — the repo's existing pattern; DATA, not code):** a `worker` registry beside the provider registry (`rules/adapter/`), each kind naming its launch spec + capabilities + defaults:

| Kind (examples) | Launch | Notes |
|---|---|---|
| `pi-cli` | `pi -p` (headless: process prompt and exit) with `--mode json\|rpc`, `--system-prompt`, `--session`/`--no-session` | MIT-licensed; the SDK form (`createAgentSession`/`ModelRuntime`/`SessionManager`) is the in-process alternative |
| `pi-container` | the same, in the documented container form (`docs/containerization.md`) | the safest default for an unattended loop |
| `herdr:<kind>` | herdr's agent kinds (claude · codex · gemini · opencode · …) | the visible-pane form — a human can watch |
| `human` | no launch — the work is done by a person; the evidence arrives as commits | the honest fallback |
| `script` / `tool` | a deterministic command (no model) | for work that should never touch an LLM |

**SELECTION — per type of work.** The task's `workType` (and/or `contract.flow`/`contract.model`, the existing per-task overrides) selects the worker kind, so the same journey can route a `spec` task to one kind and an `implementation` task to another. The mapping is configuration (like the flow chains), with the driver free to choose within the allowed kinds — never outside them.

**THE DRIVER'S EXTENSION POINT.** The driver's dispatch step resolves a worker kind through the registry and invokes the module; the driver NEVER hardcodes a worker (adding a kind = data + a module — no core change). This is the extension seam: **the journey decides WHAT and WHY; Ann's context packet supplies WHAT THE JOB NEEDS; the worker kind supplies the HOW.**

**Correlation for debugging:** the worker's own session (pi's `--session`, or the pane) is linked to Ann's **operational log** by the correlation id (the `12/05` work) — so a run in the log points at the worker transcript that produced it, and vice versa.

## Risks (named, not hidden)

- **Cost**: an always-on loop makes real provider calls per step — the turn bound and the gate stops are the brakes.
- **Security**: the runner executes tools/code — the same guard class as *no general shell*; the capability pool must be closed and sandboxed.
- **The gates become the ONLY brake** — which is why the bound record (captured checks) and the GENERATED-draft approval had to land first. They did.
