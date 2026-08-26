<!-- specs:locked:17bbf06 2026-08-26 type=record -->
# Flow-Control Deferrals — the recorded scope of flow-control-spec v6 under the L0–L3 re-implementation

*Artifact of task `06-engine-build/23-flow-control-records`. Type: record (task-local, real file — not a shared contract-stack doc). Logical name: `flow-control-deferrals`.*

**THIS RECORD SUPERSEDES NOTHING.** `flow-control-spec` v6 (locked @ 5898f89) is **unchanged and stays current** — no text of it is amended, and no `superseded` event is written. The `core-design` amendment list (§8, locked @ f7fb400) calls for flow-control's items to be **RECORDED, not amended**, because none of them contradicts v6's text: two are **scope statements** (what v1 builds of what v6 specifies) and one is a **naming note** (a phase label v6 uses for one thing that the frame now uses for another). A spec is amended when it becomes false; it is recorded against when it stays true and something about its *realization* must be known. — change-protocol v2 §3.

Upstream: `flow-control-spec` v6 (locked @ 5898f89) · `core-design` (locked @ f7fb400) · `journey-format-spec` v14 (locked @ 71fa442).

---

## 1. Work-type parameterization — THREE OF FOUR COLUMNS DEFERRED (v6 §7)

**What v6 specifies.** §7's table parameterizes a common skeleton per work type across **four columns**:
`Materialize` · `Missing input` · `Verify` · `Chain effect` — nine work-type rows (validate/grilling, envision, planning/expansion, implementation, binding/external, review, human-mode, closure).

**What v1 builds.**

| Column | v1 | Where it goes instead |
|---|---|---|
| **Chain effect** | **BUILT — as `propose-spawn` intents** | A step declares `propose-spawn {id, contract}`; the flow defers it to commit and spawns a **leg sibling** (depth 2) after the parent's artifacts are `current()`. "specs spawn after", "detailed specs spawn after", "commit → next frontmost" are all this one mechanism — expressed per task in data, not per work type in a table. |
| **Materialize** | **DEFERRED** | One materialize phase for every work type: assemble the packet + run the ladder (§2 below). Per-work-type materialize behaviour ("batch-ask at end", "derive → probe", "probe/derive aggressively") is **the runner's judgment (S6)**, not a frame parameter. |
| **Missing input** | **DEFERRED** | Follows the ladder deferral (§2) — with only `block` built, there is nothing per-work-type to select between. |
| **Verify** | **DEFERRED** | One verify phase: outputs produced (materialized locks / `evidence.commits[]`) + ACs + the step's own rules. **Judgment stays with the runner (S6)** — v6 §7's per-type verify semantics ("artifact = validation + questions", "tests + evidence", "verdict pass/confusion") describe what a runner should look for, and v6 already qualifies the artifact column as guidance rather than constraint.

**Why deferred, not dropped.** The three columns are *policy per work type*; v1's frame is deliberately **one shape for every task**, with variation carried by the chain (which steps run) rather than by the phase (how a phase behaves). Reintroducing them later is a chain/registry change if the variation turns out to be step-shaped, and a frame change only if it turns out to be phase-shaped — the deferral does not pick.

**What v1 keeps of §7 regardless.** Flows are configuration data, not code (requirements-spec AC-3); `workType` selects the chain (`chains[workType]`, format v14 §2); an absent `workType` with no `contract.flow` is as loud as an unknown one; the default product template ships as data.

**Hand-off to the re-implementation.** Build the four phases uniformly. If a work type needs different *materialize*/*verify* behaviour, express it as a **step in that work type's chain** first; only propose a frame parameter if that fails. Do not restore the table as a dispatch mechanism — that is the shape `architecture` v3 recorded as falsified ("the kernel routes each step to its engine").

---

## 2. The resolution ladder — RUNGS DEFERRED, `block` ONLY (v6 §4)

**What v6 specifies.** At materialize, a missing `requiredInput` or an unanswered blocking `openQuestion` resolves through five rungs in order: **1 derive → 2 probe → 3 infer → 4 ask → 5 block**, with the ask-vs-infer gate (ask if high impact ∨ low confidence ∧ no safe fallback ∨ irreversible ∨ user prefers questions) and the silent-inference rule (infer FORBIDDEN when impact is high and no safe fallback exists).

**What v1 builds — MEASURED, not assumed.** `kernel.materialize` emits exactly one rung for every missing input: **`block`**, naming the input and stating that the runner resolves it. No rung above `block` executes.

- **`derive` (rung 1) is also unbuilt as a LADDER RUNG.** `core-design` §8 phrases this deferral as "rungs 2–4"; measured against the code, the honest statement is that **`block` is the only rung the frame runs**. What exists is the packet's *own* input resolution — `requiredInputs` resolved via `current()` with `derived-from` provenance — and an input that resolves is not missing, so the ladder is never entered for it. That is a resolution, not a ladder rung: the rung would be deriving a **missing** input from ancestors/siblings, and nothing does that.
- **`probe` (rung 2) is unbuilt.** `observation` provenance is reserved in the packet schema and unused in v1 (`core-design` §5).
- **`infer` (rung 3) is unbuilt** — and it is the rung with the strongest reason to stay unbuilt until it is asked for: the silent-inference rule exists because the tech-stack question fell through exactly this seam.
- **`ask` (rung 4) is BUILDABLE and still DEFERRED.** The `interact` ability provides the channel (present · ask · research · decide) and the transcript makes an answer replayable (format v14 §3), so `ask` has no missing machinery — it is deferred **with the rest of the ladder** so that rung enablement lands as one coherent piece rather than as a single rung with no ordering around it.

**Enablement is DATA once a rung exists.** `rules/decide/rules.json` gains an `enabled` flag per rung — a LISTED migration in `resource-registry` v3 §9 (row 3). The register is explicit about the consequence: **enabling a rung that was never built is a no-op or a crash, not a feature.** Data enables what code has built; it does not conjure it.

**Hand-off to the re-implementation.** Ship `block`. Add the `enabled` flags as data with everything except `block` set `false`. When a rung is built, flip its flag in the same change that lands its code — never before.

---

## 3. The `activate` redefinition — A NAMING NOTE (v6 §2:24)

**What v6 says.** `activate` = **frontmost-ready selection**: the output of the look-back (§2a) — prefix orders candidates, readiness is gate-validated from the log, failed/superseded siblings are skipped, never assumed. The same rule derives a leg's status (format v14 §12).

**What the frame now calls `activate`.** In the `core-design` §4 frame, `activate` is the phase that **writes the `activated` event** (idempotent on replay — an `activated` already in the tail is not re-written).

**Both meanings are live, and both are correct — they are different jobs that ended up sharing a word:**

| | v6 §2's `activate` | the frame's `activate` phase |
|---|---|---|
| **What it does** | SELECTS which task runs next | RECORDS that the selected task has started |
| **When** | before a task is chosen (the look-back's output) | after `validate`, before `execute` |
| **Output** | a task id (derived, never stored) | one `activated` event |
| **Where it lives now** | `frontmost-ready` — the L1 look-back read, and `ann next` | the frame's lifecycle write |

**No text changes.** v6's `activate` bullet stays true of what it describes; the frame's phase name is the collision. This note exists so that a reader holding both documents does not conclude one of them is wrong — **the selection rule was not replaced, it was renamed at the point of use.**

**Hand-off to the re-implementation.** Keep the frame phase named `activate` (it is the lifecycle write, and `core-design` §4 is the locked contract for the frame). Refer to the selection rule as **`frontmost-ready`** in code, comments and views — the name the L1 read already carries — so the collision stays confined to this one recorded note.

---

## 4. What is NOT deferred (stated, so absence is not read as scope)

- **Gates** — the two-gate structure (`grill`, `confirm`), their positions, the 3-reject bound, and the rejection→bounded-rework routing are v1, unchanged, and locked constants (`core-design` §1).
- **Closure** (v6 §5) — the `close` intent, `gate-revised` / `transferred` / `deferred` events, and F-AC16 are v1.
- **Complete-artifact rule** (v6 §8) and the amendment path — v1, and exercised by this very leg.
- **`prune`** (F15) is deferred, but that deferral belongs to the functional spec, not here.
