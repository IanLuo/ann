# Design Review v2 — the core re-design (second pass)

*Reviewed against the locked contracts (journey-format v13, flow-control v6, requirements v3, functional-spec, context-packet, resource-registry, vocab.json, flow default.json) and the current `src/` (store, cli, kernel, steps, engines). Verdicts per question, then the lock verdict + exact changes.*

---

## Q1 — Did v2 fix review-1 findings 1–5?

**Finding 1 — spawn-is-not-an-event: FIXED, cleanly.**
v13 §3 event list has no `spawned`; vocab.json `eventTypes` has no `spawn`; `store.spawn()` writes `created` on tasks and nothing on legs. v2 §3's "Format correction" states exactly this: `propose-spawn` is an *intent*, `spawn!` records `created`. Accurate against the contract and the code. No residual.

**Finding 2 — artifact materialization seam: FIXED in text.**
`lock-artifact → materialize (write file · blob sha · one-current-per-name · symlink into docs/) → lock! → artifact-locked` names all four elements that `cmdLock` + `validateEventShape` actually enforce (`artifact-locked` = `{name,path,lockSha?}`; one-current check; blob sha). One imprecision: "symlink into docs/" overstates — only the *shared contract-stack* docs symlink (v13 §14/§15); the product docs a flow produces (validation / vision / spec) are **task-local real files**, no symlink. Cosmetic, but the `type?` field doesn't actually drive that decision, so it's worth a one-line correction.

**Finding 3 — sanctioned content read/write: FIXED in text, two residuals (see Q4).**

**Finding 4 — verdict→gate bridge: NOT cleanly fixed — it exists now but collides with the frame's own GATE①.** See Q5 and Q6.

**Finding 5 — feedback/rework channel: FIXED.** `ctx.feedback` (§2) + §4 rework + 3-reject bound all match `cmdGate`'s reject count and `store`'s `rejected.feedback`. The channel is specified; the *routing* is still ambiguous (below).

---

## Q2 — The intent vocabulary: coherent? complete? contradictions?

**Coherent**, with two nits and two gaps:

- **`answer` is redundant and half-storable.** §3 lists `evidence {note, refs?, answers?[]}` *and* a separate `answer {questionId, answer, impact}` intent that "folds into `evidence.answers`". But `validateEventShape` accepts `evidence.answers` only as `[{id, answer, provenance?}]` — so `questionId` must be renamed to `id`, and **`impact` has no field to land in**. The intent declares data the schema can't store. Drop `impact` or drop the separate `answer` intent and keep `evidence.answers`.
- **No contradiction with the store schema** otherwise: `evidence`, `lock-artifact`→`artifact-locked`, `propose-spawn`→`created`, and the frame-owned lifecycle/gates/closure events all match `validateEventShape`'s allowed-fields table exactly.

**Missing/under-specified:**

- **Flow 2 has no declarer for `evidence.commits[]`.** The `evidence` intent is *step-declared*, but implementation tasks run an empty chain (`implementation: []`) — there is no step to declare it. §6 says "the runner's work via abilities; `evidence.commits[]` intents", which is a category error: the runner is not a step, so it can't declare intents. The design never says who records commit evidence for lifecycle-only chains. (Review-1 Q6-4 flagged "no command surface" for this; v2 still hasn't closed it — see Q6.)
- **Lifecycle/closure events have no named command.** §3 says `activated`/`completed`/`failed` and `superseded`/`transferred`/`deferred`/`gate-revised` are "the frame's own writes, via commands". But §1's command list is `spawn! · gate! · append! · lock! · supersede!` — there is **no `complete!`/`activate!`/`fail!`/`transferred!`/`deferred!`/`gate-revised!`**. Only the raw `append!` can write them. That's *workable* (append! is the single writer), but §1's "the mutators" list is incomplete as the statement of the command surface.

---

## Q3 — The frame as a resumable coordinator: sound? Where does commit live?

The **coordinator model is sound** — gates as L1 writes the flow observes is exactly what `store` (status derivation, `pendingGates`), `lookBack()`, and `cmdGate` already do. Review-1 Q1-2 is properly fixed.

**The "commit" boundary is NOT clear.** §4 lists "commit" as a frame phase and glosses it as "structured commit evidence … or a locked artifact". But:

- The **git checkpoint is not the frame's act — it's the runner's.** The current `PlannerKernel.commit()` only validates a sha and appends `evidence.commits[{sha}]`; it never runs git, never writes `completed`. The design never states "the runner does the `git commit`; the frame only *records the resulting sha*."
- **`completed` is never written by anyone** — no code path in the current kernel or CLI emits it, and v2 doesn't name the command that will. "Every task concludes" (§4) is aspirational until the frame's `completed`/`failed` write path is named.
- This is the same seam review-1 Q6-4 called out ("no CLI command dispatches to commit()"), and v2 §8's ship-list does **not** include a commit/lifecycle command — it ships the frame, intent translation, bridge, rework, steps, read view, abilities, and structured emit, but not the completion write.

So: coordinator sound, commit boundary under-specified.

---

## Q4 — The read view: does it close risk #5 without breaking single-writer/provenance?

**Mostly yes, one concrete conflict.** `read.resolve(name) → {content, path, sha}` is read-only, so single-writer (`appendEvent`) is untouched. But:

- **Provenance is under-specified.** §5 says "provenance recorded as `observation`", but `read.resolve` returns `{content, path, sha}` — *no provenance field, and no stated mechanism for where the `observation` label gets attached*. A read is a pure function; the labeling happens only when a step *uses* the content and records a fact. The design doesn't say how.
- **`observation` is "reserved, unused in v1"** in context-packet-spec §3/§6, and the packet code hardcodes `sourceType: 'derived-from'` (context.ts:40, 105). The read view would be the **first producer** of `observation` — a legitimate use of the reserved slot, but it is a *spec amendment*, and v2 doesn't flag that it changes the packet spec's "unused" note. It also doesn't reconcile `inputs[]` (flow materializes) vs `read.resolve` (step pulls) — review-1 Q4 said "pick the fork"; v2 kept both and never says when to use which.

Net: risk #5 is *closed* for "can a step read full content" (yes, via the injected read ability), but the provenance wiring and the packet-spec amendment are unresolved.

---

## Q5 — Verdict→gate bridge vs `cmdGate` semantics: conflict?

**Yes — two conflicts.**

1. **Double grill on one task.** The frame (§4) runs GATE① (`present → gate! → observe`) *before* `execute`; then the `validate` step runs *inside* `execute` and its verdict maps to `gate! grill accept/reject`. `cmdGate` auto-submits when nothing is pending, so a planning task ends up with `submitted/confirmed(grill)` **twice** — once from the frame's gate①, once from the bridge — or the design silently intends the bridge to *replace* gate① and never says so. Both readings are broken: the first produces duplicate grill acceptances on the same task; the second contradicts §4's unconditional "GATE① present" phase.
2. **Overloaded gate + wrong rework routing.** "revise → `gate! grill reject`" records a *grill* rejection, which the frame (§4) routes to **re-materialize**. But the validate step is an *execute*-phase step; re-running it is **re-execute**, not re-materialize. The verdict's reject is semantically "the idea needs more work," not "the entry approach was rejected," yet it's forced into the grill slot and its rework lands on the wrong rung. The 3-reject bound itself is consistent (`cmdGate` refuses the 4th), but the routing is not.

Separately, the verdict is carried in `validate`'s `artifact.doc.verdict` — the flow must dig into a concrete step's artifact internals to read it, which breaks the "flow never knows a step's internals" principle (§2). A generic `out.verdict` field in the step contract would fix this.

---

## Q6 — NEW problems the first review missed

1. **The verdict→gate bridge creates the double-grill / gate①-replacement ambiguity** (Q5) — this is the top implementation risk; it sits directly on AC-4's end-to-end path.
2. **Empty-chain implementation flow has no evidence declarer** (Q2). Flow 2's whole "runner produces `evidence.commits[]`" story needs a statement that the runner records evidence + completion directly via commands, outside the intent vocabulary — the clean "steps declare intents" line doesn't cover lifecycle-only chains.
3. **`completed`/`failed`/`activated` and closure events have no named command** — the "command layer" (§0: "Commands are the only interface to the store") is incomplete as specified.
4. **Intent ordering is unspecified.** `spec` declares `lock-artifact(spec)` *and* `propose-spawn(build tasks with requiredInputs=['spec'])`. `spawn!` enforces F-AC19 (`requiredInputs` must resolve via `current()`), so the spec **must be locked before** the spawn is validated. The intent table gives no ordering guarantee within or across a step's intents. This will bite the first time "eager skeleton, lazy leaves" is tested.
5. **"eager skeleton, lazy leaves" is asserted, not specified.** The spec step must *derive* which legs/tasks to spawn from the spec content (an LLM structure-generation capability), and the current `spec-step.ts` returns a bare markdown string with no spawn proposal. v2 §8 says steps are "rebuilt … declaring intents" but never defines *how* the spec step knows what to propose.
6. **AC-7 / closure / amendment are absent from the two flows.** flow-control §7 defines `closure`, `binding/external`, `review`, `human-mode` work types; journey-format §14 lists `closure/amendment`. v2 defines only `planning` and `implementation`. AC-7 (change → amendment node → superseded artifact → referrer re-point) is a locked AC and has no flow. It's arguably served by the existing `supersede!`, but v2 never says that, so the design reads as if the change path doesn't exist.
7. **`answer` intent's `impact` is not storable** (Q2) — a field-level contradiction with `validateEventShape`.

---

## Q7 — Lock-readiness and exact changes

**Verdict: LOCK AFTER the edits below.** The architecture is sound — the layer model, single-writer, intent→command translation, read view, and rework channel are all correct against the contracts. The blockers are specification gaps, not redesigns. Two of them (the verdict bridge, the commit boundary) are design-level decisions that must be written down before implementation, or they'll surface as contradictions exactly where AC-2/AC-4 get tested.

**Exact changes required before lock:**

1. **Resolve GATE① vs the validate verdict.** Decide and state one of: (a) for planning tasks, the `validate` step's verdict bridge *is* GATE① (the frame runs no separate `present`), or (b) the verdict is a distinct decision that does *not* emit `gate! grill`. State which, and state the rework routing (re-materialize vs re-execute) for a `revise` verdict. This is the single most load-bearing edit.
2. **Carry the verdict generically** — add a step-contract field (e.g. `out.verdict`) instead of forcing the flow to read `validate`'s `artifact.doc.verdict`.
3. **Name the commit boundary**: git checkpoint = the runner's act; the frame's "commit" phase = record `evidence.commits[]` + write `completed` via `append!` (or name dedicated `complete!`/`fail!`/`activate!` commands and add them to §1's mutator list).
4. **State the empty-chain evidence path**: for lifecycle-only chains, the runner records evidence/completion directly via commands — outside the step-intent vocabulary.
5. **Flag the read-view provenance amendment**: `read.resolve` claims the `observation` slot that context-packet-spec marks "reserved, unused"; note it's an amendment and specify *where* the observation label is attached (and reconcile `inputs[]` vs `read.resolve`).
6. **Fix the `answer` intent**: drop `impact` (or add it to the `evidence.answers` schema) and align `questionId` → `id`.
7. **State intent ordering**: within a step, `lock-artifact` for a name precedes any `propose-spawn` whose contract's `requiredInputs` reference that name.
8. **State the AC-7 / closure scope explicitly** — either "out of the two flows, served by existing `supersede!`" or add the closure/amendment work type. As written it's a silent omission.

Everything else (spawn fix, artifact seam, rework channel, coordinator model, the intent vocabulary's core) is ready. Fix 1–3 are the only ones I'd call blocking; 4–8 are spec-completeness edits that can be one line each.
