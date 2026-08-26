# Design Review — the layered core (L0–L3 + step contract)

Reviewed against the locked contracts (journey-format v13, flow-control v6, requirements v3, functional-spec, context-packet, system-design v3, resource-registry) and the current `src/` (store, cli, kernel, steps, engines, executor, interact). Verdicts per question, then a top-5 risks list, then uncertainties.

---

## Q1 — Layered model + "steps never touch the store"

**Verdict: agree with the direction; flag two things.**

The L0/L1/L2/L3 split is sound, and "steps declare events, the flow is the only event-writer" is the right instinct — it makes steps pure and testable, consistent with the failure-as-value philosophy already in the kernel.

But two boundaries need tightening before you lock:

1. **This is an aspirational tightening, not the current code.** Today `StepContext` carries `store` (read-only) *and* `recordEvidence` (an imperative write hook), and the llm executor emits evidence *mid-execution* on every `evidence:true` call (the two-log trace, R3-D2). "Steps never touch the store, effects depart as declared events[] at the end of `execute()`" loses the per-call evidence emission of a multi-round session (idea-validation grills 2–3 rounds). Decide explicitly: either steps accumulate their own events and return them, or you keep a thin imperative `recordEvidence` for runtime facts and reserve declarative `events[]` for the step's *conclusion*. I'd keep both — "effects depart declared" overstates; you still need the op-log path.

2. **The "loop" isn't a single loop.** flow-control v6 gates (GATE①/GATE②) are human L1 writes (`gate!`), and the current `execute()` does *not* stop at gates — `validate()` only catches gate gaps *retroactively*. The design lists gate1/gate2 as part of "the loop's shape," but gates interrupt the loop and resume is external. Lock the honest picture: **L2 is a resumable coordinator, gates are L1 writes that L2 observes via look-back/`pendingGates`**, not a monolithic loop.

---

## Q2 — Step contract `ctx in / {ok, artifact, events} out`

**Verdict: mostly clean; three awkwardnesses, one of them serious.**

1. **`artifact` vs `artifact-locked` duality is the serious one.** `out.artifact` is in-memory (for downstream steps); `out.events` includes `artifact-locked` (durable). But a lock needs: a *file written to disk*, a computed blob sha, the one-current-per-name check, and (for shared docs) a symlink into `docs/`. Today all of that lives in the CLI `lock!` command. The flow can't materialize `out.artifact` generically — so "artifact-locked is step-emittable" is false as stated; it's an *intent* that only the flow can fulfill, and the flow needs a materialization policy the design doesn't specify. This is the single most likely seam to break.

2. **No file-write (or read) ability in ctx.** Steps producing spec/vision/validation docs must write a file for the lock to point at. `tool`/`command` executors are unbuilt. There's no sanctioned way for a step to persist its output. The flow would have to own the write — more responsibility than the design acknowledges.

3. **`inputs[]` has two different resolution semantics.** A packet-dependency input resolves to a *bounded 2000-char excerpt*; a prior-step input resolves to the *full* `ctx.results[id].artifact`. That's why `spec` declares `inputs: ['envision']` rather than reading the vision as a packet dep. Coherent, but a step author must know the asymmetry; worth naming in the contract.

---

## Q3 — Where engines live

**Verdict: agree.** "Engines (grilling/envision/context/validators) = L2 internal logic; steps are built from them; abilities are L3" is correct — with one sharpening. The clean rule is: **engines are pure L2 logic parameterized by abilities** (never reach the store/CLI); the step (also L2) is the binding point that injects the abilities. The current code already does exactly this (`EnvisionStep` wraps `DefaultEnvisionEngine(adapterFromExecutor(llm))`). The idea-validation *session* straddles L2/L3 (engine logic + the `interact` ability) — fine, as long as it never imports the store, which it doesn't. Keep that: don't let any engine import `Store`.

---

## Q4 — Does the packet carry enough state?

**Verdict: flag — this is the thinnest part and most likely to force a redesign.**

The packet carries statuses, capped excerpts, and the contract — enough for *navigation/grounding*, insufficient for *content-heavy* steps. Two concrete gaps:

1. **No full-content read for non-step-produced deps.** A spec task whose `requiredInput` is a prior *leg's* artifact (e.g. `journey-format-spec`) gets only a 2000-char excerpt in the packet, and no step in its chain produced it. If it needs the full doc, there's no sanctioned read (probe is unbuilt, `observation` provenance is reserved-but-unused). The design's "declared `inputs[]`" gives *chain validation* but not *content access*.

2. **Removing `ctx.store` forces the packet to grow.** The current `ctx.store` gives steps live reads. Removing it is the right instinct, but then the packet must carry everything — and it doesn't (no full artifact content, no sibling/child *content*, only statuses).

Recommendation: commit to **a narrow injected read view** (e.g. `resolve(name) → full content`, provenance-tracked as `observation`) as an ability — not raw store-in-ctx, not unbounded packet growth. The design's "inputs[] vs narrow read view" is the fork; pick the read view now or you'll bolt it on later.

---

## Q5 — Event-vocabulary split

**Verdict: the split is conceptually right; the step-emittable list is wrong in two places.**

- **`spawn` is not an event type.** journey-format v13 §3 removed `spawned` — a child's `created` event *is* the spawn record — and vocab.json has no `spawn`. Spawn is a structural L1 action (`spawn!`), and creation is planner-only (flow-control §5: "agents propose, the system materializes"). **This is a direct format contradiction — remove it from step-emittable.**
- **`artifact-locked` is not a pure event.** As in Q2, it requires file-write + sha + one-current-per-name + symlink. It's an *intent* the flow fulfills, not a declaration a step emits on its own.
- The flow-emittable half (activated/completed/failed · gates · superseded/transferred/closure) is correct. Minor note: nothing in the kernel currently emits `activated` or `failed` — fine as vocab, but the flow frame must actually write them or they're dead vocabulary.

Better statement of the split: **steps declare *intents* (evidence · lock-artifact-with-content · propose-spawn); the flow is the only event-writer and translates intents into L1 writes.** The "step-emittable events (the store vocabulary)" phrasing is what muddies it.

---

## Q6 — What's missing/wrong for the two flows

**Verdict: four real gaps, two of which will force redesign if ignored.**

1. **Step verdicts aren't wired to gate events.** The `validate` step ends in a human verdict (solid/revise/reject) *inside the step* via `interact`. Nothing maps that verdict to `submitted/confirmed/rejected(gate=grill)` or the 3-reject bound. Two different "human decision" mechanisms (interactive verdict vs gate event) now coexist with no bridge. This will bite the moment you test AC-4 end-to-end.
2. **No feedback/rework channel in ctx.** flow-control §3 rework (re-materialize / re-execute from feedback) has no representation: `rejected.feedback` lives in the store but nothing injects it into the re-run. The stateless step contract can't express bounded rework as-is.
3. **`advance` doesn't describe how the next work gets proposed/spawned.** Both flows describe *content* steps (validate/envision/spec) but not *structure growth* — F5 run-next proposes, F6 specify-task spawns, F9 spec-expansion "eager skeleton, lazy leaves" should emit child tasks. Until the flow owns spawn *proposals*, the journey can't "continue" per the primary flow (requirements §3.5).
4. **`commit` in flow (2) is half-wired.** The implementation chain is `[]` (lifecycle only), and the kernel has `commit()` — but no CLI command dispatches to it. The "runner does work → commit evidence → next frontmost" path has no command surface. Not a design flaw, but the design claims it's the flow when the glue is missing.

---

## Q7 — Contradictions with locked contracts

- **`spawn` as a step-emittable event** — **contradicts journey-format v13 §3** (spawned removed; child's `created` is the spawn record) **and vocab.json** (no `spawn` type). This is the one hard contradiction; it must not ship.
- **`artifact-locked` as step-emittable** — not a format contradiction (the type is valid), but a *mechanism* gap (the format's `artifact-locked` carries name+path+lockSha and is "written the moment the artifact locks" — the flow must materialize the file first).
- **`evidence (+answers)`** — consistent: vocab.json and `validateEventShape` already accept `evidence.answers`.
- **Gates/closure as flow-emittable, on tasks only** — consistent with F-AC15/16/17 and flow-control v6 §3/§5.
- **`chains` as project data (`rules/flow/default.json`)** — consistent with resource-registry spec and flow-control §7; current `default.json` (`default: [validate,envision,spec]`, `implementation: []`) matches.
- **The interactive validate session** is a *strengthening* of flow-control §7's "validate = batch-ask at end" — not a contradiction, but note it does more than the work-type table describes; make sure that's a deliberate amendment, not drift.

---

## Top 5 risks if you lock this now

1. **The `artifact` → `artifact-locked` materialization seam is undefined.** Every content step ends at a lock, and locking needs file-write + blob sha + one-current-per-name + symlink-into-`docs/` — none of which the step contract or flow specifies. The clean "declare effects" promise breaks exactly where every step ends.

2. **Gate loop and step verdicts aren't connected.** flow-control's GATE①/GATE② are human L1 writes; the interactive validate verdict is a second, unbridged human decision. Locking "steps declare events" without a verdict→gate-event mapping and a feedback→rework channel means reworking both the step contract and the flow when AC-4/AC-2 are tested for real.

3. **`spawn` listed as step-emittable encodes a format violation.** journey-format v13 §3 has no `spawn`; the child's `created` is the spawn record. Concrete, must fix before lock.

4. **No feedback/rework channel in ctx.** The stateless step contract can't express flow-control §3 bounded rework (re-materialize/re-execute from `rejected.feedback`). Either add a feedback field to ctx now, or accept that rejection/rework is outside the step model and specify it separately.

5. **No sanctioned content read/write for steps.** Steps see 2000-char excerpts and prior-step results only; `tool`/`command` are unbuilt. Until a narrow read view (`resolve(name)`) and an artifact-write path exist, non-trivial steps will either reach back into `Store` (reintroducing the coupling the design removes) or silently under-contextualize.

---

## Uncertainties (honest)

- Whether the design intends to *remove* `ctx.store`/`recordEvidence` or merely *re-describe* them. The text ("never touches the store," "effects depart declared") reads as removal, but the existing `StepContext` injects both. Confirm which before I'd treat the Q1/Q4 flags as binding.
- I did not read the full `architecture.md` decision log or the S1–S9 slice contracts, so I may be missing a recorded decision that already answers Q6's "who proposes/spawns next" — that decision may live there rather than being genuinely missing.
- I'm inferring the design's "spawn" from its own wording; if you meant the `spawn!` *command* rather than an *event type*, the Q5/Q7 contradiction shrinks to a wording fix — but the design says "step-emittable events (the store vocabulary)", which reads as events.
