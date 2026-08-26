# Design Review v3 — the core re-design (third pass)

*Reviewed against the locked contracts (flow-control-spec-v6, journey-format-spec-v13, requirements-spec-v3, functional-spec, context-packet-spec, resource-registry-spec-v2) and the current `src/` (store, cli, kernel, flow, steps, engines). Every claim below was checked against the contract text or the code; file:line or §-quotes given. Owner priority applied: **is the DESIGN sound so that later FLOW changes are sound** — flow content is not the subject.*

---

## Q1 — Were review-2 edits 1–8 applied?

**6 applied correctly · 1 applied incorrectly · 1 applied in name only.**

| # | Edit | Verdict |
|---|---|---|
| 1 | Resolve GATE① vs validate verdict | **NAME ONLY** — decision made, mechanism absent |
| 2 | Carry the verdict generically | **APPLIED** |
| 3 | Name the commit boundary | **APPLIED, verified** |
| 4 | Empty-chain evidence path | **APPLIED**, one category error remains |
| 5 | Read-view provenance amendment | **APPLIED INCORRECTLY** — wrong provenance slot |
| 6 | Fix the `answer` intent | **APPLIED, verified** |
| 7 | Intent ordering | **APPLIED** — correct and load-bearing; "enforces" undefined |
| 8 | AC-7 / closure scope | **APPLIED as a sentence**, claim unverified and partly false |

**Edit 1 — the decision is stated, the mechanism is not.** v3 §3.3 + §6 choose option (a): the validate step's verdict *is* gate①. But §4 still draws GATE① as an unconditional frame phase *before* `validate`/`execute`, while the validate step runs *inside* `execute`. v3 says "the frame never double-presents a gate" and "routing is data" — it never says how the frame knows to withhold its own present, nor that gate① consequently lands after execute begins. Two consequences it doesn't record:
- flow-control-spec-v6 §2 fixes the lifecycle as `materialize → [GATE① grilling] → validate → activate → execute → …`. Routing gate① out of an execute-phase step **moves a locked gate position**. v3 flags a packet-spec amendment (§5) but not this one. Inconsistent rigor.
- The chain must then satisfy an *ordering* constraint that nothing validates: the store refuses `artifact-locked` without a prior `confirmed(gate=grill)` (`store.ts:581-583`). Chain `[validate, envision, spec]` works only because `validate` is first. Reorder it in data to `[envision, validate, spec]` — a legal data change under §6 — and the store fails closed mid-chain. Correct failure, unrecoverable task (see Q2/B1).

**Edit 2 — applied.** `out.verdict = {decision, feedback?}`, generic, flow routes it. Fixes review-2's "flow digs into `artifact.doc.verdict`". Note the decision vocabulary is open (`solid|revise|reject` today) and no rule says what happens to a decision value the routing data doesn't map. Fail-closed should be stated.

**Edit 3 — applied and verified true.** Checked: `taskStatus` sets `done` **only** on a `completed` event (`store.ts:165-167`) — so "the frame writes `completed`" is required, not optional. `append!` genuinely can write it: `validateEventShape` accepts `completed` (`store.ts:474-489`) and `appendEvent` is the single event writer (`store.ts:452-467`). §1's "COMPLETE over the event vocabulary" is **true**. Gate-guarded, correctly: `completed` requires a prior `confirmed(gate=confirm)` (`store.ts:578-580`).

**Edit 4 — applied, one category error left.** §4's "the frame records its outcomes … on its behalf" still makes the frame the actor for work it cannot observe. The runner is outside the system; its evidence arrives as an L1 write (`ann append! … evidence`) that the frame *observes* — exactly like a gate. Say that, and the empty-chain case stops being an exception to the model and becomes an instance of it.

**Edit 5 — applied with the wrong label. This is a factual error, not a wording nit.** context-packet-spec §4: *"every entry carries its ladder label (`derived-from` — current-name resolution; `observation` — probed from git/files, unused in v1)"*, and §3: *"`sourceType` is always `derived-from` (resolution via `current()`)"*. `read.resolve(name)` resolves a **logical name via `current()`** — that is `derived-from`, the *derive* rung. `observation` is the *probe* rung (flow-control §4.2: *"probe — read project state / external systems (files, git, APIs). Provenance: `observation`"*). So v3 §5 mislabels every read, and the amendment it flags is **not needed** for name resolution. Two residuals also survive: "the observation label … flows forward in the step's intents" has **no channel** — of the three intents, only `evidence.answers[]` carries `provenance?` (`store.ts:527-529`); a `lock-artifact` carries no provenance at all.

**Edit 6 — applied and verified.** The separate `answer` intent is gone; `evidence.answers` is `{id, answer, provenance?}` — exactly what `validateEventShape` enforces (`store.ts:525-529`). `commits[{sha, note?}]` + `refs[string]` in §4 also match (`store.ts:519-524`).

**Edit 7 — applied, correct, and genuinely load-bearing.** Verified: `cmdSpawn` → `store.contractProblems` → *"requiredInput '…' does not resolve via `current()`"* (`store.ts:257`, `cli.ts:723`); F-AC19 is journey-format-spec-v13 §7/§2 (not functional-spec). The rule is right. Undefined: does "the flow enforces this when translating" mean **reorder** or **reject**? Pick one — reorder silently and a step author never learns; reject and the chain fails closed. There is also a **second, unstated instance of the same rule** (see edit 8).

**Edit 8 — the sentence is there; the claim is unverified and partly false.** §6: AC-7 amendments are "served by `spawn!`/`supersede!`/`append!` today."
- Partly true: `current(name)` returns the last **non-superseded** locker (`store.ts:207-227`), so supersession does re-point referrers by name. Good.
- But `cmdLock` **refuses** a name that is already current (`cli.ts:773-776`). So AC-7 has a mandatory order — `supersede!` the old *before* `lock!` the new. That is the same class of ordering constraint as edit 7 and is nowhere stated.
- **False for closure:** §6 lists "review/closure/binding work types" as data changes. They are not — see Q2/M4.

---

## Q2 — Soundness for change: does a later flow change stay data?

**Genuinely data (verified in code, no change needed):** a new work-type→chain mapping (`flow.ts:93-96`, `.ann/rules/flow/default.json`); a per-task `contract.flow` override beating work type (`flow.ts:86-89`); empty chain = lifecycle only; unknown work type = named problem, kernel refuses to execute (`flow.ts:101`, `kernel.ts:239-241`). Chains are also **safe by construction**: `validateChain` rejects unregistered ids, forward references, and **duplicate ids** (`flow.ts:113-146`) — so chain data cannot encode a loop. `store.ts` carries **zero** flow/work-type/step knowledge. The L0/L1 floor is clean. That part of the design target is met and already proven by 169 tests.

Now the couplings.

**B1 (blocker) — a chain that fails partway leaves an unrecoverable task, and every added step makes it likelier.**
The event vocabulary has **no step-scoped event** (v13 §3: `created · activated · extended · evidence · artifact-locked · completed · failed · superseded · submitted · confirmed · rejected` + closure). `execute()` always starts at `chain[0]` (`kernel.ts:264`). A step that declares no intent leaves no trace. Therefore the frame **cannot** derive which chain steps already ran — and v3 asserts "resumable, not restartable" (§7) and "a step is re-runnable" (§2) with no mechanism behind either.
Concretely: chain `[validate, envision, spec]`; `envision` locks `vision`; `spec` fails. Re-run → `envision` re-declares `lock-artifact(vision)` → `cmdLock` refuses ("already current", `cli.ts:773-776`) → step fails. The task can never complete its chain. This is not hypothetical; it follows from three verified behaviours. It is **the** soundness-for-change defect: the failure probability scales with chain length, and chain length is the thing the owner wants to change freely.
v3 must choose and state one of: (i) intents are **idempotent** — `lock-artifact` whose content sha equals the current lock is a no-op, not a refusal; (ii) the frame **records step conclusion** (a step-scoped fact in the log) so mid-chain resume is derivable; (iii) chain execution is **atomic** — a failed chain rolls forward to `failed`, never re-runs. (i) is the smallest.

**B4 (blocker) — the frame dropped `activate`.**
flow-control-spec-v6 §2 verbatim: `spawn → materialize → [GATE① grilling] → validate → activate → execute → verify → [GATE② confirm] → commit → LOOK-BACK → determine next → propose / advance`. v3 §4 lists nine phases with **no activate**. `taskStatus` assigns `active` **only** on an `activated` event (`store.ts:162-164`), and `frontmostReady` selects queued/active tasks (`kernel.ts:116-125`). As drawn, no task ever becomes active. §3 lists `activated` as a frame write but §4 gives it no phase — a write with no writer.

**M1 — "work type" is reduced to "a chain", but the locked work-type table parameterizes four things.**
flow-control-spec-v6 §7 defines each work type by **Materialize / Missing input / Verify / Chain effect** — e.g. `review`: *"probe evidence only | never infer; ask if ambiguous | verdict pass/confusion | confusion → re-plan"*; `implementation`: *"probe/derive aggressively | infer w/ fallback; ask high-impact | tests + evidence…"*. v3's data model is `chains[workType] = [stepId…]` and nothing else. Adding `review` or `binding` per the locked table therefore needs **code**, not data — the missing-input policy, the verify semantics and the chain effect have no representation. Either widen the flow data (`{chain, missingInput, verify, chainEffect}`) or state explicitly that v1 collapses the work-type table to its chain column and that the rest is deferred. As written, §6's "any chain expressible" is true and "new work types are data changes" is false.

**M4 — the intent vocabulary is closed at 3; the event vocabulary is 14. Closure is not reachable.**
`superseded · transferred · deferred · gate-revised` are listed in §3 as "the frame's own writes" — but **no frame phase in §4 emits any of them**, and no intent declares them. `transferred` requires `{target, scope}` and `deferred` requires `{reason}` (`store.ts:531-536`) — these are *work outcomes*, decided by the closure task's own work, not frame positions the coordinator knows. So a closure step can never declare its result. §6's claim that closure work types are "data changes within this design" is false under §3's own partition. Choose: add a `close` intent, or state that closure is a runner-invoked L1 act outside the step model (lifecycle-only chain + `append!`).

**M3 — the resolution ladder is missing from the design entirely.**
`derive → probe → infer → ask → block` is locked three times over: flow-control-spec-v6 §4 ("at materialize"), design.md §4 hot invariant ("No silent inference"), resource-registry `decide` category. v3 mentions it **nowhere**. The current kernel implements only the `block` rung (`kernel.ts:159-166`). A re-implementation contract that omits a locked mechanism is how it gets lost. Say where it lives (the materialize phase) even if v1 still ships only `block`.

**M5 — chain entries cannot parameterize a step.** A chain is a list of ids. The same step at two depths/settings requires a second step, i.e. code. The chain schema is precisely what's being locked here; `{id, params?}` costs nothing now and is a data-format migration later.

**M6 — chain validity is checked at execute, but `node.json` is immutable.** `validateChain` runs in `execute()` (`kernel.ts:242-245`). A `contract.flow` override with a bad step id is written into an immutable node and only discovered when the task runs — leaving a task that can never be fixed, only superseded. Validate the chain when translating `propose-spawn`, at spawn time, fail closed.

**M8 — `read.resolve` bypasses F-AC19's grounded inputs.** F-AC19 makes a task self-sufficient: *"every `requiredInputs` entry must resolve via `current()`"*, enforced at spawn. If a step may `read.resolve` any logical name at will, the contract's declared grounding becomes advisory and the packet stops being the honest picture of what the task consumed. Either bind `read.resolve` to names in `inputs[]` ∪ `requiredInputs` (fail closed otherwise), or state the exemption and how the read is recorded.

**M10 — leg vs task spawn is not expressible.** `propose-spawn {id, contract}` doesn't distinguish node kinds; §4's advance separately says the frame spawns the next leg. That split (tasks = intent, legs = frame) is right and unstated. It is at least safe: a step-declared leg spawn fails closed on `legGateMet` (`store.ts:671-683`).

---

## Q3 — Simplicity: is this the smallest sound core?

**Mostly yes.** Three layers plus abilities, three intents, one write path, chains as data — the core is small and most of it is already proven in code. Trims and collisions:

1. **Two mechanisms, one job — `inputs[]` vs `read.resolve`.** §5 "reconciles" them by *when you knew you needed it*, which is a judgment call, not a rule. Collapsing them is both simpler and closes M8: `inputs[]` is the declaration (chain-validated); `read.resolve` is the only accessor and refuses undeclared names. One mechanism, static validation retained.
2. **Two mechanisms, one job — the reject bound.** Verified: `cmdGate` refuses the 4th reject (`cli.ts:754-758`) **and** the kernel has `REJECT_BOUND = 3` (`kernel.ts:88`, enforced `kernel.ts:220-228`). v3 §4 keeps the frame as enforcer. That is two enforcers today and two after the rewrite — and *neither* is the store, so `append! rejected` bypasses both (`validateEventShape` has no reject-count rule). Name one owner.
3. **`validate` names two different things.** The frame's `validate` phase (deterministic readiness, §4) and the chain step `validate` (interactive idea validation, §6) share a word in the same document. In a locked contract that is a permanent ambiguity. Rename one — the step to `idea-validate` is the cheaper change.
4. **The ability surface doesn't match itself.** §2 declares five abilities (`llm · interact · tool · command · request`); §8 ships three and never mentions `request` again. Either drop `request` or say what it is. (In the code it is an unbuilt guard-stub, `executor.ts:113-117`.)
5. **Double-carried content.** A doc step returns its content twice — as `out.artifact` (for `prior`) and inside `lock-artifact`. One line fixes it: a locked artifact is automatically available to downstream steps as `prior`.
6. **The frame is the right size** — nine phases, one missing (`activate`, B4). `look-back`/`advance` could merge but the split matches F5 and the locked lifecycle; leave it.

**Intent vocabulary: minimal — arguably too minimal** (M4). Three intents cover the two example flows and nothing else.

---

## Q4 — Flexibility vs over-flexibility: where is the line drawn?

**The line is not drawn, and v3 contradicts itself about where it is.** §6: "gates, verdicts, rework, spawn proposals **adjustable** — routing is flow data." §7: "**no gate-skipping** … enforced by the frame"; "no unbounded loops — 3-reject bound." Both cannot be true unless the design says exactly which facet of a gate is adjustable (the decision *source* and the routing) and which is protected (the gate must exist, be written, and precede the effects it guards).

**The good news, which v3 understates and should claim:** the strongest protections are already at **L0**, not the frame. `appendEvent` refuses `completed` without a prior `confirmed(gate=confirm)`, refuses `artifact-locked` without a prior `confirmed(gate=grill)`, and refuses a `confirm` gate with no `grill` (`store.ts:559-593`), plus leg-root events, unknown fields and malformed shapes. **No flow data can skip a gate, because the store won't take the write.** That is the real answer to "is flows-as-data bounded," and v3 attributes it to the wrong layer.

**B5 (blocker) — attributing invariants to the frame is a layering error with teeth.** §1 states L1 has multiple clients (CLI now, web server later) and §7 says gates are "enforced by the frame." An invariant enforced at L2 is **bypassable by any other L1 client** — including the CLI the design keeps. The 3-reject bound proves it: it lives in `cmdGate` and is bypassed by `append!`. The design needs one explicit table: per invariant, the enforcing layer. Gate sequence + completion gate → **L0** (already true). Reject bound → **L1** `gate!`, and `append!` must refuse the event kinds that composite commands own, or the bound is decorative. Intent ordering, chain validity, rework routing → **L2** (and therefore *conventions*, not invariants — say so).

**B2 (blocker) — the routing data has no schema, no home, and no validation.** "Routing is data" appears three times (§3.3, §4, §6) and is the mechanism both prior reviews forced into the design. Nowhere does v3 say what the routing data looks like, whether it lives in `rules/flow/default.json` or `contract.flow`, what a *valid* routing is, or that it is checked before execution. Compare chains: a home, a schema, and `validateChain`. As it stands, flow data could route two decisions to one gate, route nothing to gate① (deadlock — the store then refuses every lock), or route the same verdict to both gates. Nothing in v3 forbids any of it, and "one human decision per gate" (§3.3) has **no enforcement point anywhere**: `cmdGate` will happily append two `confirmed(grill)` events; the store has no such rule. Locking a design whose newest mechanism exists only as prose means it gets invented during implementation — which is exactly what reviews 1 and 2 were trying to prevent.

**B3 (blocker) — making the rework rung "data" contradicts a locked contract.** flow-control-spec-v6 §3 verbatim: *"GATE① reject → **re-materialize** … → back to GATE①. GATE② reject → **re-execute** … → back to GATE②. If the feedback invalidates the approach, escalate to the GATE① loop. **Resume point is decided by the feedback — never `activate`.** Bound: 3 rejection cycles per gate."* The rung is **fixed per gate** by contract, with escalation decided by *feedback*, not by flow data. v3 §3.3/§4 make the rung flow data. That is an unflagged amendment to a locked spec, and it converts a protection into a knob. If it is deliberate, record it as an amendment; otherwise restore the locked routing and drop it from the adjustable list.

**Also unbounded by data:** if the 3-reject bound is "adjustable" (§6 lists rework as adjustable), a flow could set it to 999 and violate the hot invariant "no unbounded loops." Say the bound is a frame/command constant, or data with a hard ceiling.

---

## Q5 — Do the two example flows demonstrate the design works?

**They expose four design gaps, which is what good examples are for.**

1. **Flow 1 reveals the chain has one slot but needs two.** All steps run in `execute`; the `validate` step must produce a *gate①* decision. That is a step bound to a different frame phase, and the design has no way to say so. Either a chain entry carries a phase binding (`{step, at:'gate1'|'execute'}` — phase binding becomes data too, which serves the design target) or the frame's gate① is defined as "obtain a grill decision — by default by presenting; per flow data, from a designated step." Right now it is neither, and the correctness of `[validate, envision, spec]` depends on an unwritten ordering rule enforced only by the store failing closed at the second step (Q1/edit 1).
2. **Flow 1 reveals `propose-spawn` has no payload contract.** "spec's chain effect declares the build-task spawns" requires the step to emit a **F-AC19-valid contract** (non-empty `intent`, non-empty `acceptanceCriteria`, every `requiredInputs` entry resolving via `current()` — v13 §2/§7, enforced `store.ts:242-260`). §3's intent row says `{id, contract}` and points at no schema. This is the intent with the most demanding payload and the least specification.
3. **Flow 2 reveals the frame has no driver.** With chain `[]`, who advances the phases? v3 never states the invocation model — one idempotent "advance" that runs phases until it blocks, with the **resume point derived from the event tail** (never stored, per "status derived, never asserted"). The doc leans on "resume point" twice (§2, §4) without defining it, and B1 shows it isn't derivable mid-chain.
4. **Flow 2 reveals the empty chain is described as an exception** rather than the general case of "the frame observes L1 writes it did not make" (edit 4).

Flow content itself is fine and matches the locked defaults (`chains: {default:[validate,envision,spec], implementation:[]}` — verified in `.ann/rules/flow/default.json`).

---

## Q6 — Lock verdict

# LOCK AFTER the edits below.

The architecture is right and I'd defend it: L0–L3 with a single write path, steps as pure units, intents translated by the flow, chains as data, gates as observed L1 writes. Most of it is already true in code and covered by tests. Two of the blockers, though, are not writing-down exercises — they are decisions the design still hasn't made (B1: what happens when a chain re-runs; B2: what routing data *is*). Both prior reviews flagged the same seam and both times it came back as prose. A third round of prose will not survive contact with the implementation.

### Blocking (7)

1. **State chain re-run semantics.** Pick one: intents are idempotent (`lock-artifact` matching the current sha is a no-op — smallest); or the frame records step conclusion so mid-chain resume is derivable; or a failed chain is terminal (`failed`, never re-run). Without this, "resumable, not restartable" is false and a task can become unrecoverable. *(B1)*
2. **Specify the routing data**: its shape, its home (`rules/flow/default.json` and/or `contract.flow`), its defaults, and that it is **validated statically before execution** — exactly one decision source per gate, every frame gate has a source, and the gate-producing step precedes any effect-producing step in the chain. Extend `validateChain` to cover it. *(B2)*
3. **Restore, or explicitly amend, the locked rework routing.** flow-control-v6 §3 fixes GATE①→re-materialize / GATE②→re-execute, escalation decided by feedback. Remove the rung from the "adjustable" list, or record an amendment. Also state the 3-reject bound is a constant (or data with a hard ceiling), never open. *(B3)*
4. **Put `activate` back in the frame** between validate and execute, and name it as the writer of `activated` — `active` status exists only via that event (`store.ts:162-164`). *(B4)*
5. **Add the invariant-ownership table**: per invariant, the enforcing layer. Gate sequence + completion gate = **L0** (`store.ts:559-593`, already true — claim it, it is the design's strongest guarantee). Reject bound = **L1** `gate!`, and state that `append!` refuses event kinds owned by composite commands, or the bound is bypassable. Everything the frame enforces is a **convention**, not an invariant — say so. Correct §7's "enforced by the frame." *(B5)*
6. **Fix the read-view provenance.** `read.resolve(name)` is `current()` resolution = **`derived-from`**, not `observation` (context-packet-spec §3/§4). Drop the packet-spec amendment claim for name resolution; reserve `observation` for the probe rung when probing ships. State how provenance reaches the store — today only `evidence.answers[].provenance` exists. *(M2)*
7. **Resolve the closure/amendment claim.** Either add a `close` intent covering `transferred {target, scope}` / `deferred {reason}` / `gate-revised {old,new}`, or state that closure is a runner-invoked L1 act outside the step model — and remove "closure work types are data changes" from §6. *(M4)*

### Required for completeness (7)

8. **Say what a work type is.** Either widen flow data past the chain column (`{chain, missingInput, verify, chainEffect}` per flow-control-v6 §7) or state that v1 collapses the work-type table to its chain and defer the rest. Then correct §6's "new work types are data changes."
9. **Name the resolution ladder** (derive → probe → infer → ask → block) and its home (the materialize phase), even if v1 ships only `block`. It is a locked invariant that v3 omits entirely.
10. **Bind `read.resolve` to declared inputs** (`inputs[]` ∪ `requiredInputs`, fail closed otherwise) — this collapses the two content mechanisms into one and preserves F-AC19 grounding.
11. **Validate `contract.flow` at spawn**, not at execute — `node.json` is immutable, so a bad chain is otherwise unfixable.
12. **Two ordering rules, stated as rules:** (a) edit 7's lock-before-spawn — and say whether the flow *reorders* or *rejects*; (b) AC-7's `supersede!` before `lock!` (`cmdLock` refuses a name that is already current, `cli.ts:773-776`).
13. **State the frame's driver**: one idempotent advance operation, phases until it blocks, **resume point derived from the event tail** — never stored.
14. **Allow chain entries to carry params** (`{id, params?}`) or state that steps are unparameterized by design. This is the chain schema being locked; migrating it later is a data-format change.

### Cosmetic but in a locked document

- "RESU**N**ABLE" → "RESUMABLE" (§1 — survived two revisions).
- "L0–L5" → "L0–L3" (§6).
- Rename the `validate` **step** (e.g. `idea-validate`) so it stops colliding with the `validate` **phase**.
- §7's "(AC-4)" should be **AC-3** — AC-3 is the no-code-change chain requirement; AC-4 is the end-to-end fixture run.
- §2 lists five abilities, §8 ships three; `request` is never explained.
- Name the gate values concretely (`grill`, `confirm` — vocab data, `vocab.json:31-34`) so routing data has real values to reference.
- Note `BUILTIN_CHAIN` (`flow.ts:24`) and the display fallback (`cli.ts:415`) hardcode `[validate, envision, spec]` — flow content in code. It never *overrides* project data, so AC-3 holds, but §7's "no hard-wired flow content in code" is literally false today. Say "seed/fallback, never an override," or move it to data.

---

## What I am not sure of

- **Whether B1 has already been decided elsewhere.** I read the design docs, the locked specs and `src/`, not `architecture.md`'s decision log or the S1–S9 slice contracts. A recorded decision on chain atomicity or step-conclusion recording may exist there and simply be missing from this document. If so, edit 1 shrinks to a cross-reference.
- **Whether the gate①-from-a-step inversion is intended as an amendment.** I read it as one because flow-control-v6 §2 fixes the position, but v3 may intend gate① to remain at its position with the step *supplying* the decision at that position — which would be sound and would make edit 5 in Q5 a phase-binding question rather than a lifecycle change. The document supports both readings, which is itself the problem.
- **The exact severity of M1.** If the owner's plan is that per-work-type materialize/verify policy will be expressed *as steps in the chain* rather than as flow fields, then chain-only data is sufficient and M1 collapses to a wording fix. v3 doesn't say, and the locked table's columns don't obviously decompose into steps.
- **`request`'s intended meaning.** If it is the ladder's `ask` rung, then M3 and the ability list are the same edit.
