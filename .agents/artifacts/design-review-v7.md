# Design Review v7 — the core re-design (seventh pass)

*Reviewed against the locked contracts (journey-format-spec v13 @ 699615a, flow-control-spec v6 @ 5898f89, requirements-spec v3 @ 80eeaae, functional-spec @ 9e60cd8, context-packet-spec, architecture v2 @ e6d07ed, ann-system-design v3 @ 2b0a30f, resource-registry-spec v2 @ 4f95b5a, `.ann/rules/schema/vocab.json` v2, `.ann/rules/decide/rules.json`, `.ann/rules/flow/default.json` v2) and the current `src/` — **169 tests pass, run and verified** (`npx vitest run`, 10 files, 864 ms). Every spec line quoted was read in the source file; every code line was read. Three findings below were **executed against the real `Store`** on throwaway fixtures, not reasoned about — those are marked ⚙ MEASURED. Owner priority applied: is the DESIGN sound so that later FLOW changes are sound. Flow content is not the subject.*

---

## Headline

**v7 answers review-6's three mechanism questions with three new mechanisms. One of them (B1) is refuted by the locked store — I ran it. One (B8) is replaced by a failure mode that is worse than the one it fixes. One (B4) is correct but is re-opened by a command v7 deliberately keeps. B6 is sound in kind with one hole.**

The other eight blockers and all sixteen completeness items landed, most of them clean, several of them verified by measurement. The architecture is unchanged from review-6's assessment and I still would defend it. **The document is one mechanism away from lockable, and that one mechanism is the one the whole revision was sent back for.**

---

## Q1 — Were the review-6 edits applied? (11 blocking + 16 completeness + cosmetics)

**7 of 11 blockers clean · 1 clean-but-re-opened · 1 sound-with-a-hole · 1 refuted · 1 not resolved. 14 of 16 completeness items clean · 2 partial. Cosmetics: still unswept.**

| # | Edit | Verdict |
|---|---|---|
| B1 | replay-vs-rework discriminator | **REFUTED BY THE STORE — N1, N2** ⚙ |
| B2 | `openQuestions` back to top level + REQUIRED set | **APPLIED, CORRECT** ✓ (consequence: **N10**) |
| B3 | architecture amendment → the layer model | **APPLIED, one clause still missing** (`:63`) |
| B4 | submit-only mutator | **APPLIED, CORRECT — and re-opened by the retained composite: N15** ⚙ |
| B5 | artifact filename rule | **APPLIED, CORRECT** ✓ |
| B6 | inputs as chain-entry role bindings | **APPLIED, SOUND IN KIND — one-directional validation: N5** |
| B7 | ladder row + §4 deferral | **DEFERRAL RECORDED ✓ — the row is still false: N8** |
| B8 | gate-bound step at an already-confirmed gate | **ANSWERED, THE ANSWER IS UNSOUND: N3** |
| B9 | `eventTypes` / `statuses` ownership rows | **APPLIED, VERIFIED CORRECT** ✓ |
| B10 | amendment procedure + referrer list | **APPLIED, VERIFIED CORRECT** ✓ |
| B11 | artifact-type row + type/category split | **APPLIED; migration now listed** ✓ |
| C1–C16 | completeness | **14 clean · C1 half (N4) · C3 words-only (N13)** |
| — | cosmetics | AC citations **still unswept** · system-design title **still `(v2)`** |

### The ones that landed clean — with the evidence

- **B2 — correct, and the census backs the choice.** `journey-format-spec-v13.md:33` puts `openQuestions` at the top level, sibling of `contract`; `v13:41` makes `contract.intent` and `contract.acceptanceCriteria` REQUIRED. v7 §2:89-99 reproduces both exactly. ⚙ I re-ran the census over all 45 nodes: **`openQuestions` top-level: 1 · inside `contract`: 0 · absent: 44.** v7 follows the spec *and* the single real instance. Review-6's B2 regression is fully reversed.
- **B5 — correct, and it is the fix AC-7 needed.** v7 §3:120 now states the whole rule: real versioned file `docs/<category>/<name>-v<N>.md`, task-local ref `artifacts/<name>.md` (symlink), recorded path = the symlink, `N` computed by the flow. Checked against `store.ts:74` (`logicalNameFromFile` strips `-v\d+$`), `requirements-spec-v3:44` (AC-7 — *"the old artifact stays byte-identical"*), `journey-format-spec-v13:74` (*"`path` is the task-local ref"*), and the disk: ⚙ **35 symlinks under `.ann/journey`**, `docs/specs/` holding `journey-format-spec-v10.md … -v13.md` side by side. The rule matches reality on every point.
- **B9 — verified against the code literals.** `store.ts:474-489` is the per-type allow-list (a code literal); `store.ts:158-175` is the status mapping (a code literal). Both rows are in v7 §1:46 marked **protected**, with the correct consequence stated (*"registry entries alone are a silent no-op or a wrong-named refusal"*). ⚙ I confirmed the wrong-named refusal directly: appending an `evidence` event with extra structured fields yields `append rejected: unknown field(s) 'step, runId, seq' on evidence (strict schema, format v12 §3)` — a refusal that names the field, not the vocabulary. The row is exactly right. (It is also the mechanism that kills B1 — see N2.)
- **B10 — complete.** `journey-format-spec-v13:164` requires *"reusing the logical name … and preserving section anchors — with a back-reference + `superseded` event"*; v7 §2:86 carries all four plus referrer re-pointing (correctly sourced to `requirements-spec-v3:44` / `AGENTS.md:43`, not to v13:164). The three stale pointers are named with their actual versions — I re-verified each: `AGENTS.md:41` → `4b4c8c3` = **v11** (current v13 @ 699615a); `:46` → `fcfa661` = **v1** (current v2 @ e6d07ed); `:48` → `9c3705e` = **v1** (current v2 @ 4f95b5a); and `context-packet-spec` has **no pointer**, correctly added.
- **C8 — the numbers are now the measured numbers.** ⚙ I re-ran review-6's measurement independently: **25 nodes carry a retrospective grill confirmation; 5 are leg roots (`01-goal`, `02-grilling`, `03-tree-format`, `04-system-design`, `05-engine`), exempted at `store.ts:561`; 19 tasks would trip the GATE-1 predicate without `retroGrill`; their `createdAt` range is 2026-08-15 … 2026-08-18; zero are ≥ `'2026-08-21'`.** v7 §1:40 states 19, 5 leg roots, all ≤ 2026-08-18, cutoff `'2026-08-21'`. Every figure correct. This is the cleanest-verified row in the document.
- **C15 — both halves true.** ⚙ `find .ann/journey -name description.md` → **0**. `journey-format-spec-v13:15` removed the card; `cli.ts:735` still writes it; v7 §8:221 retires the write. `request` (`executor.ts:58`) is noted as dropped in §8:227.
- **C13, C14, C16, C4, C5, C6, C9, C10, C11, C12 — all applied and checked.** `prune` deferred (§6:193) against `functional-spec:45` / `ann-system-design-v3:66`; error shape `{ok:false, error:{code, blocker}}` (§2:83) matching `architecture-v2:97` and `executor.ts:28`; three-of-four columns (§6:189) matching `flow-control-spec-v6:80`'s four-column table; `feedback {gate, text}` (§2:72); `paramsSchema` (§2:61); linearity stated (§6:190) matching `flow.ts:139-144`; marker-stripped `read.resolve` (§5:172) matching `cli.ts:781-783`; `decisions[]` (§2:60); the `vocab` instance row + `architecture-v2:84` reconciliation (§8:231) — I verified `resource-registry-spec-v2:36` enumerates `ask | check | decide | adapter | flow | binding | surface` with no `schema`, and `:51-57` has no `vocab` row; the `activate` redefinition note (§4:139-141) against `flow-control-spec-v6:24`.

### The three mechanism decisions

#### B1 — **REFUTED.** `ctx.feedback` is the right *idea*; `self-supersede-then-lock` is not implementable against the locked store, and the trace key it depends on cannot be written.

v7 §2:80-82 picks the discriminator (`ctx.feedback` present = rework, absent = replay) and then specifies what a reworked `lock-artifact` does: *"**self-supersede-then-lock** (its own prior lock at the name is superseded, then the new content locks)"*, repeated at §3:106 and §3 rule 3 (`:116`).

**⚙ I ran it.** Fixture: one leg, one task, real `Store`, real `appendEvent`. Round 1 = activate → submit/confirm grill → lock `vision` → submit confirm → reject. Round 2 = the design's rework path.

```
after round-1 reject → status: active     | current(vision): {...producer: 07-leg/01-task}
after SELF-SUPERSEDE → status: superseded | current(vision): undefined
after REWORK LOCK    → status: superseded | current(vision): undefined
check() says: []
contractProblems({requiredInputs:['vision']}): ["requiredInput 'vision' does not resolve via current()"]
```

Three separate failures, all permanent, all silent:

1. **The artifact is orphaned forever.** `store.ts:207-212` — `current()` computes `lockers(name).filter(p => !supersededLocks(name).has(p))`. `lockers` (`:410-425`) collects **node ids**; `supersededLocks` (`:432-446`) is a **Set of node ids**. Supersession is per-**(producer, name)**, not per-lock-event. A node that supersedes a name **removes every lock it will ever hold at that name**, including ones written afterwards. Self-supersede-then-lock is structurally impossible in this store.
2. **The task dies.** `store.ts:171-173` maps a `superseded` event to status `superseded` unless the node is already `done`/`failed` — and a task mid-rework is `active`. `journey-format-spec-v13:78` locks this: *"only a **non-completed node derives `superseded`**"*. The consequence is not cosmetic: `kernel.ts:116-125` `frontmostReady` filters to `['queued','active']`, so the reworking task **disappears from the next-action proposal**, and `store.ts:191` `legStatus` counts it as concluded. A crash between the self-supersede and the re-submit loses the task.
3. **Nothing complains.** `check()` returned `[]`. The `NO CURRENT` orphan rule at `store.ts:663-666` skips the case because `producers.every(p => supersededLocks.has(p))` is true. The design's loudest safety net is silent on its own central mechanism.

Downstream, `store.ts:257` resolves `requiredInputs` through `current()`, so every later task naming that artifact becomes unspawnable (F-AC19), and `read.resolve` (§5:172 — `current()` + a file read) returns nothing.

This is not a wording problem. **Any resolution must obey two locked facts: (a) supersession is per-producer-per-name, so a producer cannot supersede itself and stay current; (b) `v13:78` forces a non-completed node carrying `superseded` to derive that status.** The design space that remains is real — defer the `artifact-locked` *event* until the confirm gate accepts while re-writing the *file* on each rework pass; or lock a fresh logical name per pass; or amend `v13` to make supersession per-lock-event. Which one is the owner's call. What is not available is what v7 wrote.

#### B1 (second failure) — **the `(stepId, runId, seq)` trace key has no schema-legal home, and no amendment is recorded.**

v7 §2:78 makes the trace the durable substrate for both rework (*"on REWORK runId advances so round-2 trace never collides with round-1"*) and replay (§3 rule 4 — *"served from the recorded answer trace (keyed by runId)"*). It emits through `append!` → `evidence`.

⚙ `store.ts:478` allows exactly `['at','type','note','commits','refs','answers']` on an `evidence` event, and `store.ts:490` rejects anything else. I tried all four homes:

| where the key would live | result |
|---|---|
| `{step, runId, seq}` as fields | **REFUSED** — `unknown field(s) 'step, runId, seq'` |
| a single `trace:{...}` object | **REFUSED** — `unknown field(s) 'trace'` |
| `answers:[{id:'idea-validate#1#0', …}]` | **OK** |
| `refs:['trace/envision/1/0']` | writes, then `check()` flags `F-AC18: ref 'trace/envision/1/0' does not exist` (`store.ts:401`) |

So the **interact** half of the trace has a legal home (`answers[].id`) and the **llm** half does not. `executor.ts`'s emission is `recordEvidence({note, refs})` — note is prose, which §7:216 forbids as truth (*"no prose as truth — machine-truth events"*), and refs is policed. v7's v14 amendment (§8:229) covers `workType`/`flow`/`model`, the node.json schema and the filename rule — **it does not touch `v13 §3`'s event schema.** The design asserts a key it cannot write. This is precisely the failure pattern review-6 caught three times (B7, B11, the ladder row): *present-tense claims about data shapes that do not exist* — here it is the design's own load-bearing mechanism.

#### B4 — **the mutator is right.** ⚙

`submit!` genuinely produces the undecided-`submitted` tail state: `store.ts:178-184` derives `blocked` from a `submitted` with no later `confirmed`/`rejected` at that gate, and I confirmed the two-write sequence lands the task in `blocked` and that the rework re-submit produces a second pending gate correctly. `store.ts:587-591` makes `submitted(gate=confirm)` itself participate in the gate-sequence invariant (no confirm submission without a confirmed grill), which is a bonus the design gets for free. The L1 surface going from five to six mutators is the correct answer. **See N15 for what re-opens it.**

#### B6 — **sound in kind.** One hole (N5), one unstated limit (N6).

`requirements-spec-v3:40` (AC-3) verbatim: *"changing the chain requires **no code change** — only project data."* v7 §2:79 moves `inputs[]` off the step and onto the chain entry as `{role → source}`, deletes the step's `inputs[]` field, and has the step declare only `roles[]` — a shape. Review-6's three failing scenarios now pass as data: insert a step, drop a step, repoint `spec` at a different producer. `flow.ts:125-137` + `spec-step.ts:73` (`readonly inputs = ['envision']`) are correctly slated for replacement. This is the right resolution and it is the one that serves the owner's priority.

The residual honesty problem is §6:191, unchanged in substance from review-6's complaint about §6:181: *"**New work types/steps/chain shapes/gate sources/artifact types (existing category) = data changes**"*. **"New steps" is false.** `src/kernel/steps/index.ts:8-12` states the seam in its own words: *"1. implement `Step` … in this dir, 2. add it to `defaultSteps()`, 3. reference its id in the project's chain data"* — two code steps, one data step. Adding a **role** to an existing step is also code. The owner's stated criterion is *"is anything left that forces a code change"*, so the sentence that answers it must be exact.

#### B8 — **answered, and the answer is unsound (N3).** See Q2.

---

## Q2 — NEW soundness holes

### N1 (blocking) — self-supersede destroys `current()` and kills the task ⚙
See B1 above. Measured, three failures, silent.

### N2 (blocking) — the trace key is unwritable under the locked event schema ⚙
See B1 above. Measured. No amendment recorded.

### N3 (blocking) — the replay channel serves recorded answers to *different questions*

v7 §3 rule 4 (`:117`) closes B8 like this: *"On resume with the gate already confirmed, the gate-bound step re-runs in REPLAY mode — its interact calls are served from the recorded answer trace (keyed by runId), **the human is NEVER re-interviewed at a decided gate**."* The key is `(taskId, stepId, runId, seq)`, and §2:78 defines `seq` positionally.

Positional replay is sound only if the step's call sequence is deterministic. The design's flagship gate-bound step is not. `idea-validate/session.ts:103-120`: each round calls `engine.grill(req)` — an **LLM call** — and then asks one question **per element of `g.artifact.questions`**, i.e. per LLM-generated question, deduped by `q.question.trim().toLowerCase()` (LLM-generated text). LLM output is not deterministic, so on re-entry the question list differs, `seq` no longer indexes the same question, and **a recorded answer is bound to a question the human never answered.** That is silently wrong data flowing into the artifact that guides envision and spec — strictly worse than review-6's B8, which was merely a re-interview.

There is no escape inside the current design: replaying the LLM calls too would make the sequence deterministic, but `executor.ts:createExecutorSet` records only `{note, refs}` — **the completion text is never stored**, and per N2 there is nowhere in `evidence` to put it. The `Interactor` protocol (`interact.ts:24-33`) also gives `collectResearch`, `collectDecision` and `present` no identity at all — only `askQuestion` carries a `GrillQuestion`, so only that verb could key on anything but position.

The design must say what actually happens. The honest options are: skip a gate-bound step whose gate is decided (which requires its intents to have been durable *before* the gate wrote — the thing rule 4 forbids), or re-run and re-ask whatever does not match by question identity (loud, and it breaks *"NEVER re-interviewed"*). Both are defensible. The current sentence is not.

### N4 (blocking) — a data-only chain change can deadlock the frame, and no static check catches it

v7 §4:151-153 states half of review-6's C1 (*"A confirm-bound step's output is gated by the confirm gate itself — its deferred lock lands after verify"*) and drops the half that mattered: what happens when it is the task's only artifact.

Trace it. §4's order is `execute → verify → GATE·confirm`. `kernel.ts:308-314` fails verify unless the task has a locked artifact or an `evidence` event with non-empty `commits[]`. A confirm-bound step's lock is deferred until the gate confirms (§3 rule 4). The ability record hook emits `evidence` with `{note, refs}` — **no `commits[]`** (`executor.ts` emission) — so it does not satisfy verify either. Therefore: **verify cannot pass until the gate confirms; the gate cannot be reached until verify passes.** Deadlock.

Two things make this a design problem rather than a curiosity:
- It is reachable by **editing chain data only** — move the artifact-producing step to `at:'confirm'`. That is exactly the class of change the owner intends to make freely.
- **The design never says whether `verify` blocks.** §4:143-149 says execute stops on failure, named. §4:151 says verify runs and *"judgment stays with the runner"* — it does not say what the frame does when verify fails. A frame phase whose failure behaviour is unspecified is a hole independent of this deadlock.

### N5 (blocking, small) — `validateChain`'s role check is one-directional: roles can be declared and never bound

v7 §2:79: *"`validateChain` checks role keys ⊆ step.roles and sources produced earlier."* Only ⊆. Nothing checks that every role a step needs **is** bound. §6:182's chain entry makes `inputs?` optional, and the shipped sample (§6:200) exercises exactly that: `{id:'envision'}` with no `inputs` at all.

So a step declaring `roles:['vision','constraints']` bound only on `vision` passes static validation, and `ctx.prior.constraints` is `undefined` at execute — a runtime failure in a design whose whole claim is that chain data is statically validated before it runs. The step contract has no required/optional marker on `roles[]` to make the check possible. This is the same hole in the opposite direction from the one B6 fixed, and it is squarely inside the owner's question about "roles declared but not bound".

### N6 (blocking, small) — chain data and `node.json` immutability collide, and the design never says so

A role source may be *"a packet dep name"* (§6:183). Packet deps come from `contract.requiredInputs` (`context.ts:94`). `journey-format-spec-v13:53` locks `node.json` as **IMMUTABLE** — *"written once at spawn … Corrections = new nodes, never edits."*

Therefore: **for an already-spawned task, a chain edit that introduces a new packet-dep binding cannot be satisfied by data at all.** The chain fails validation at execute (correctly, fail-closed, §3 rule 5), and the only remedy is a new task. The design's central promise is that flows are adjustable data; the boundary is that they are adjustable *for work not yet spawned*. That sentence is missing, and it is the single most likely surprise the owner will hit.

### N7 (blocking, small) — §6:191 claims new steps are data changes; they are not
See B6 above. `src/kernel/steps/index.ts:8-12` is the counter-evidence, in the repo's own words.

### N8 (blocking, small) — the ladder row is false for a third time, in a new way

v7 fixed the tense (§1:51 — *"gains `enabled` flags"*, future) and recorded the §4 deferral (§8:232) against `flow-control-spec-v6:45-51`'s *"resolve in order"*. Both correct. But §1:51 and §4:130-132 still assert *"enabling a rung is data"* while §4:131-132 says rungs 2–4 are **deferred**, i.e. unbuilt. Flipping `enabled:true` on a rung with no implementation is not a data change; it is a no-op or a crash. The row should read: *rung enablement is data **once the rung exists**; v1 builds only `block`*.

Also: §1:51 calls the `rules/decide/rules.json` change *"a listed §8 migration"*. It is not listed. §8:232's flow-control bullet mentions *"enablement as registry data"* in passing; the `vocab.json` migration by contrast **is** explicitly listed as a data change (§8:231). One of the two got a list entry.

### N9 (blocking, small) — "MULTI-CLIENT BY DESIGN" is asserted without a concurrency model, against a store that caches events in memory

§1:28 amends `architecture-v2:24,61` (*"the kernel is the only *initiator*"*) to **multi-client**, reconciling against `ann-system-design-v3:59`. That reconciliation is sound only for **in-process initiators** — `:59` lists *"planner kernel …, adapters …, validators/reviewer"*, all components, not processes.

If "client" means a separate process, the store cannot support it as built: `store.ts:85` caches `nodes` in a `Map` populated once in the constructor (`:102-111`), and `appendEvent` mutates that cache (`:466`) without re-reading. Two clients ⇒ each validates `gateProblems` against a stale prospective log ⇒ the store's own invariants (the ones §1:40 calls *"refused by the writer"*) can be violated by interleaving. `requirements-spec-v3` A1 says multi-user is *"supported by design … **not implemented in v1**"*. The design is recording an amendment to a locked architecture doc on the strength of a word it never defines. Say "multiple in-process initiators" (which is all `:59` licenses and all v1 needs), or state the concurrency model.

### N10 (completeness) — B2's correct choice contradicts §8:233's "L0 substrate unchanged"

Keeping `openQuestions` at the top level is right (B2 ✓), but nothing in the repo can produce that shape. `store.ts:548-551` writes `JSON.stringify({id, contract: c, createdAt})` — structurally incapable of emitting a top-level `openQuestions`. `context.ts:88-91` reads `c.openQuestions` off the **unwrapped contract**, so `04-system-design`'s blocking questions never reach `packet.readiness` (`context.ts:113`) today.

v7 §2:94 says *"the packet assembler's read is fixed to match"* — a `context.ts` change. §8:233 says *"L0 substrate unchanged: store, format, **packet**, validators, provider adapter"*. Those two sentences contradict each other, and the `store.spawn` write-path change is not mentioned at all. Both changes are small; the list must own them.

### N11 (completeness) — the frame's own writes have no idempotence rule

§2:80-82 specifies idempotence for the five **intents**. §3:111 makes `activated`/`completed`/`failed` and the gate writes *"the frame's own writes"* — and no rule covers them. On resume after a crash following `activate`, does the frame re-write `activated`? It is schema-legal and status-idempotent, so nothing fails; you just accumulate duplicate lifecycle events in an append-only log that is the product. §1:53's three tail states cover the gates; the lifecycle writes are uncovered.

### N12 (completeness) — execute re-entry re-runs every LLM call, against NFR-CST-1

`ctx.prior` is *"in-memory structured artifacts"* (§2:70) and `execute` is *"NEVER skipped"* (§4:150), so every re-entry — every crash-resume and every confirm-rework — re-runs **every step in the chain from the top**, including its LLM calls. `requirements-spec-v3:65` locks **NFR-CST-1: *"bounded model calls per step — one grilling pass, one review pass, capped rework"*** with *"10× = cost explosion. KEEP."* and `:106` names a *model-call counter* as its verification. The 3-reject bound caps *rework*; it does not cap crash-resumes. The design built a replay channel for `interact` and none for `llm`; it should say that model calls re-fire on re-entry and how NFR-CST-1 is met, or state the bound.

### N13 (completeness) — C3 answered in words, but the command cannot express it

§3:108 assigns node-level supersession to *"the frame's `supersede!` on the old node"*. `supersede!` takes `{name, path}` and writes `successor:{name,path}` (`cli.ts:793-796`), which is artifact-shaped; a node superseded by a sibling has no successor artifact. ⚙ A bare `superseded` with only a note **is** writable through `appendEvent` (`store.ts:513` validates `successor` only when present), but §1:44 has `append!` refuse composite-owned kinds, and `superseded` is `supersede!`'s. So the event is legal and the design's own surface cannot produce it. ⚙ **14 such events exist in the repo** (12 carry a successor, 14 do not).

Worth naming plainly: with §2:82, `superseded` now carries **three** meanings — this artifact was replaced by another task, this node was replaced by a sibling, and this task is reworking its own output — and `store.ts:171-173` collapses all three into one status transition. That collapse is what makes N1 lethal.

### N14 (completeness) — there are three content channels, not two

§5:173 calls `read.resolve` *"the only accessor"* of content. It is the third one. `prior` carries structured artifacts (§2:70, correctly separated now — C2 ✓). And the **packet already carries content**: `context-packet-spec:41` defines `excerpt` as *"bounded head of the artifact"*, `:65` gives every resolved dependency *"a **bounded excerpt**"*, and `context.ts:106` fills it (2 000 chars, `context.ts:63`). §5:174's *"never grows to carry content"* is true of `siblingStatus` (`:67`) and false of `dependencies`. No reach-through results — excerpts are bounded to `requiredInputs`, which is inside `read.resolve`'s own bound — but "the only accessor" is not accurate and this document is accurate everywhere else.

### N15 (completeness, but it undoes B4) — the retained `gate!` composite skips the `submitted` write on every rework cycle

§4:124: *"`gate!` keeps the composite submit+decide for CLI convenience."* Its current submit-detection is `cli.ts:752`:

```js
const pending = evs.filter((e) => e.type === 'submitted' && e.gate === gate &&
  !evs.slice(evs.indexOf(e) + 1).some((x) => x.type === 'confirmed' && x.gate === gate));
```

It looks only for a later **`confirmed`**. `store.ts:181` — the derivation the whole resumability claim rests on — looks for `confirmed` **or** `rejected`. So after a rejection the store says *decided*, `gate!` says *still pending*, and `gate!` therefore **does not write a new `submitted`** for round 2. The second gate cycle never enters `blocked`, never appears in `lookBack().pendingGates` (`kernel.ts:134-142`), never shows *"WAITING ON YOU"* (`cli.ts:447`) — exactly the state B4 was added to make reachable, lost on every rework. v7 §8:221 fixes one thing about `cmdGate` (dropping its duplicate gate-sequence check) and not this. Either specify the composite's predicate or drop the composite; two gate-acquisition paths with different tail effects, only one of them specified, is not a seam the design should keep.

### Answering the owner's question directly: what still forces a code change?

| change | data? | stated correctly in v7? |
|---|---|---|
| new work type (existing steps) | ✅ data | ✅ |
| new chain shape (linear, unspawned task) | ✅ data | ✅ (linearity §6:190) |
| new gate source | ✅ data | ✅ |
| new artifact type, existing category | ✅ data (after the vocab migration) | ✅ |
| new `docs/` category | ❌ v13 §15 amendment | ✅ |
| new event kind / status / gate | ❌ v13 amendment / protected | ✅ |
| **new step** | ❌ **code** (implement + register) | ❌ **N7** |
| **new role on an existing step** | ❌ **code** | ❌ unstated |
| **new intent** | ❌ **code** (translator) | ~ listed as a "seam", predicate bleeds |
| **new ladder rung** | ❌ **code** (rung unbuilt) | ❌ **N8** |
| **chain edit needing a new packet dep on a spawned task** | ❌ **new task** (node.json immutable) | ❌ **N6** |

The first six rows are the design working. The last five are the ones to state.

---

## Q3 — Simplicity: is this the smallest sound core?

**The shape is right and I would defend it unchanged, for the third review running.** Four layers, one write path, six mutators complete over the 14-kind vocabulary (I checked the partition: `spawn!`→`created`; `submit!`→`submitted`; `gate!`→`confirmed`/`rejected`; `lock!`→`artifact-locked`; `supersede!`→`superseded`; `append!`→the remaining eight — §1:26's completeness claim is **true**), five intents, steps as pure units, chains as data, the gate source *is* the chain, `read.resolve` as an L1 read, role-bound inputs.

**Can a step still reach the store?** No. `ctx.store` and `recordEvidence` (`step.ts:43,49`) are gone from §2; `shell` is explicitly an OS-process ability (§2:69, §7:210); `read` is an L1 derived read. The boundary is clean and it stays clean under the role-binding change.

Remaining weight, in order:

1. **Two mechanisms for one job: gate-bound intent deferral + the replay channel.** §3 rule 4 defers a gate-bound step's non-gate intents until the gate confirms, which creates a window; the replay channel exists only to survive a crash inside that window; and per N3 it does not survive it soundly. One mechanism could do this job — make the post-gate translation itself the resume point (the tail already tells you the gate is confirmed and the lock is absent), instead of re-running the step. v7 never considers it. This is the simplification I would push hardest for, because it also removes N3 entirely.
2. **Two evidence paths, one job, still no enforcer.** The `evidence` intent (§3:105) and the ability record hook (§2:78) both produce `evidence` events with different dedup keys (`commits[].sha`/`refs[]`/`answers[].id` vs `(stepId, runId, seq)`), separated only by the convention *"Steps do NOT duplicate in intents what their ability calls already emitted"* (§2:78). Unchanged from review-6, and now one of the two keys cannot be written (N2).
3. **Three content channels claimed as two** (N14).
4. **Two gate-acquisition paths, one specified** (N15).
5. **Contract self-sufficiency is still checked three times** — `spawn!` (§1:43), the `validate` phase (§4:137 → `kernel.ts:180`), `check()` (`store.ts:645-650`). Defensible because project data mutates between spawn and execute; still never justified in one clause. Unchanged from review-6.

Nothing here is speculative machinery. The core is small. The weight is in duplicated mechanisms, not in invented ones.

---

## Q4 — The line between adjustable and protected

**The table remains the strongest part of the document, and it is true against the code row by row except where noted.** Spot-checks re-run this pass: gate sequence refused by the writer (`store.ts:463,559-593` — and `submitted(gate=confirm)` participates, `:587-591`); single writer (every path ends at `appendEvent`); leg status derived (`store.ts:188-196`); reject bound owned by `gate!` (`cli.ts:754-758`) with L2 reading only `{escalated}` (`kernel.ts:211-215`); one-current-per-name (`cli.ts:773-776`); leg roots refuse events (`store.ts:453-455`); `store.ts` carries zero flow/work-type/step knowledge (grepped — confirmed); unknown `workType` is a named refusal (`flow.ts:97-102`); chains cannot encode a loop (`flow.ts:139-144`). `vocab.eventTypes`/`statuses` (B9) are correctly protected and I proved the failure mode.

**Still wrong:**
- **Ladder rung enablement** (N8) — third pass, third form.
- **The L2 bundle row over-claims its own "How".** Seven distinct things share one row whose mechanism is *"conventions … statically validated before execution"*. Two of the seven are not statically validated: *artifact placement + filename + recorded path* is a runtime materialization rule, and *cross-task write permission* has **no enforcer at all** — `cmdSupersede(id, name, path)` (`cli.ts:793-796`) writes `superseded` on **any** id with no check that the caller produced the successor. The row's escape clause (*"bypassable only by another L1 client writing raw events, which the composite-kind refusal blocks"*) is false for this one: `supersede!` **is** the L1 surface, and it accepts an arbitrary target.
- **`vocab.artifactTypes`** is still present-tense (*"entries carry a category"*) about data that is a flat string array today — but the migration is now listed in §8:231, which is what review-6 asked for. Downgraded to cosmetic.

**Still missing rows:** `params` (C5 gave them a `paramsSchema`, but no ownership row says who owns the schema or what a mismatch does); `at:` values (a mixed namespace — `'grill'`/`'confirm'` come from `vocab.gates`, `'execute'` is a phase literal); **frame-write idempotence** (N11); **role completeness** (N5).

**Correctly adjustable, verified:** chains, work types, gate source, verdict maps, params, `contract.flow`, artifact types within a category.
**Correctly protected, verified against the locked text:** the 3-reject bound (`flow-control-spec-v6:39`), rework rungs (`:36-38`), the gate set (`:34` — *"Both gates are **HARD on every node in v1**"*), gate positions (`:17`), gate sequence, single writer, lifecycle order, event vocabulary (`journey-format-spec-v13:57-61`), status vocabulary.

---

## Q5 — Are the amendments the COMPLETE set?

**No — one recorded amendment is short by a clause, one required amendment is entirely absent, one locked line is deviated from without a note, and §8's own ship list contradicts §2.**

Verified first, because most of it is right:

- **journey-format v13 → v14** — the field set, the schema, the REQUIRED set, the filename rule, and the full procedure (anchors + back-reference + `superseded` + referrer re-pointing) are all correct against `v13:24-41`, `:74`, `:164`. ✓
- **architecture v2 → v3** — `:27` LB-4, `:60`, `:38-58`, `:71-80`, `:24`, `:61`, `:66`, `:97` all verified verbatim against `architecture-v2.md` (line numbers match exactly). B3's main gap is closed. ✓
- **resource-registry v2 → v3** — `:36` enumeration and `:51-57` instance table both confirmed to lack `schema`/`vocab`; the `architecture-v2:84` reconciliation (*"`rules/` registries (**vocab** · decide/ask/check · adapter/provider)"*) is real and makes it a two-line approval. ✓
- **flow-control v6 deferrals** — §7's four columns (confirmed at `:80`) and §4's ladder (`:45-51`) both recorded; the `activate` note against `:24` recorded. ✓
- **context-packet-spec — not violated on provenance.** `:65` *"`sourceType` is always `derived-from`"*, `:75`/`:86` *"`observation` … reserved, unused"*. §5:172 is exactly right. (It **is** imprecise on content — N14.)
- **v13 on cross-task appends — permitted.** All locality rules concern leg roots (`v13:63,71,86`); no task-to-task prohibition exists. §3:108 and §7:211 are safe.

**Missing / short:**

1. **`journey-format v13 §3` — the event schema — is not amended, and B1's trace key requires it.** (N2) Either amend `v13 §3` to carry the trace key structurally, or drop the `(stepId, runId, seq)` key and say what replaces it. As written the design silently requires a locked schema change it does not record. **This is the most serious amendment gap.**
2. **`architecture-v2:63` is still unamended.** *"**The kernel routes each step to its engine.**"* plus the whole *"Engines explained"* clause. v7 folds engines into L2 as step internals (§8:225), which falsifies that sentence directly. Review-6's B3 listed `:63` explicitly; §8:230 lists `:27`, `:60`, `:38-58`, `:71-80`, `:24`, `:61`, `:66`, `:97` — and not `:63`.
3. **`resource-registry-spec-v2:63` is deviated from without a note.** *"Registry integrity is itself a check: **every consumed rule exists in a registry; no hardcoded rule outside it**."* v7 §1:46 makes `eventTypes` and `statuses` **protected by code literals** (`store.ts:474-489`, `:158-175`) that duplicate the registry — and `vocab.json`'s own definition says *"one registry per class, **no layer duplicates**"*. The position is correct and honestly stated as a position; it is a knowing deviation from a locked line and belongs in the resource-registry v3 amendment as a reconciliation, next to the `schema`/`vocab` additions.
4. **§8:233 contradicts §2:94** on whether the packet (and `store.spawn`) change. (N10)
5. **The `rules/decide/rules.json` migration is claimed as listed and is not.** (N8)
6. **Cosmetics still unswept, third pass:** `functional-spec:44` cites `AC-8/RPO` (requirements-spec-v3 stops at AC-7); `requirements-spec-v3:43` cites `F-AC8`, which lives in `tree-format-spec.md:82`; `ann-system-design-v3.md:7` is still internally titled *"# Ann System Design (v2)"*. Trivial, and trivial to sweep.

**Regression check against reviews 1–6:** no numbered blocker from reviews 1–5 has regressed. Review-6's B2 regression is reversed. The one item that has now survived six passes unaddressed — how `spec` *derives* which tasks to propose (review-2 Q6-5) — remains legitimately step-internal under §2:84 and covered by the §6:189 deferral.

---

## Q6 — Lock verdict

# DO NOT LOCK — v8 required. The architecture is finished; the rework/replay mechanism is not.

I want to be precise about the size of this. **This is not a re-design.** §0, §1's layer model, §1's ownership table, §4's frame, §5, §6's chain schema, §7 and §8's amendment list are all in good shape and I would lock every one of them today. Of the 27 review-6 items, 21 landed clean and several are the best-evidenced work in the whole series (B2, B5, B9, B10, C8, C15 are all verified by measurement, not by reading).

**What blocks the lock is that the single mechanism the whole revision existed to produce does not work against the store it is built on.** Review-6 sent v7 back for three decisions. B4 came back right. B6 came back right in kind. B1 came back with `self-supersede-then-lock` — which I ran, and which orphans the artifact permanently, derives the task to `superseded` so `frontmostReady` stops proposing it, and reports nothing in `check()` — resting on a trace key the strict event schema refuses to store. And B8's fix binds recorded human answers to LLM-regenerated questions by position.

I cannot call those edits. **B1 and B8 need one joint mechanism decision, and it is the same decision**: *what makes a gate-bound or gate-reworked step's output durable across a gate, without re-running the step and without writing `superseded` on a live node.* Both failures dissolve if that is answered once. Everything else on this list is a sentence, a row, or a line in the amendment list.

### Blocking — the mechanism decision (one decision, two symptoms)

1. **Replace `self-supersede-then-lock`.** The constraints are hard and measured: supersession is per-(producer, name) (`store.ts:207-227`, `:432-446`), and `journey-format-spec-v13:78` derives `superseded` status on any non-completed node carrying the event. Any mechanism that writes `superseded` on the reworking task is dead on arrival. State which of the open routes the design takes (defer the `artifact-locked` event until the confirm gate accepts while re-writing the file each pass · lock a distinct logical name per pass · amend `v13` to per-lock-event supersession) and say what `current()` returns at every point in a rework cycle. *(N1)*
2. **Give the trace key a schema-legal home or drop it.** `evidence` allows only `at·type·note·commits·refs·answers` (`store.ts:478`); `answers[].id` fits the interact half, nothing fits the llm half, `note` is prose (§7:216 forbids it as truth) and `refs` is policed by F-AC18 (`store.ts:401`). If the key stays, **add a `journey-format v13 §3` event-schema amendment to §8**. *(N2)*
3. **Say what actually happens to a gate-bound step at a decided gate.** Positional replay is unsound because `idea-validate` interleaves LLM calls with interact calls (`idea-validate/session.ts:103-120`) and the questions are LLM-generated. Pick: skip the step (and make its intents durable before the gate write), or re-run and re-ask what does not match by question identity (and delete *"the human is NEVER re-interviewed"*). *(N3)*

### Blocking — edits (each is one to three sentences)

4. **State what the frame does when `verify` fails**, and that a chain whose only artifact producer is confirm-bound deadlocks — with whichever static check or stated prohibition prevents it. *(N4)*
5. **Make the role check bidirectional**: every *required* role must be bound, not just every bound role declared. That needs a required/optional marker on `roles[]`. *(N5)*
6. **State the spawned-task limit**: a chain edit introducing a new packet-dep binding cannot apply to an already-spawned task, because `node.json` is immutable (`v13:53`) — the remedy is a new task, not a data edit. *(N6)*
7. **Fix §6:191.** New **steps** are code (`src/kernel/steps/index.ts:8-12`), and so is a new **role** on an existing step. List them in the code column, not the data column. *(N7)*
8. **Fix the ladder row again**: enablement is data *once a rung exists*; v1 builds only `block`. And actually list the `rules/decide/rules.json` migration in §8, the way the `vocab.json` one is listed. *(N8)*
9. **Define "multi-client."** If it means multiple in-process initiators, say so — `ann-system-design-v3:59` licenses exactly that and the amendment becomes uncontroversial. If it means multiple processes, state the concurrency model, because `store.ts:85,102-111,466` caches events in-process and two writers will validate against stale logs. *(N9)*
10. **Specify the `gate!` composite's submit predicate, or drop the composite.** `cli.ts:752` checks only for a later `confirmed`, so on every rework cycle it skips the `submitted` write and B4's resumable state never appears. *(N15)*
11. **Add `architecture-v2:63`** (*"The kernel routes each step to its engine"* + the Engines-explained clause) to the architecture v3 amendment. *(Q5-2)*
12. **Add the `resource-registry-spec-v2:63` reconciliation** — code-literal enforcement of `eventTypes`/`statuses` is a knowing duplicate of the registry; record it next to the `schema`/`vocab` additions. *(Q5-3)*
13. **Resolve §8:233 vs §2:94** — keeping `openQuestions` top-level requires changing `store.spawn` (`store.ts:548-551`) and `context.ts:88-91`; the "L0 substrate unchanged" list must say so. *(N10)*

### Required for completeness

14. State idempotence for the frame's own writes (`activated`/`completed`/`failed`), not only for the five intents. *(N11)*
15. State that execute re-entry re-runs every step's LLM calls, and reconcile with **NFR-CST-1** (`requirements-spec-v3:65`, verified by a model-call counter at `:106`). *(N12)*
16. Give node-level `superseded` a surface that fits it — `supersede!`'s `{name, path}` is artifact-shaped — and name the three meanings the event now carries. *(N13)*
17. Correct §5:173/§5:174: the packet carries **bounded excerpts** of resolved inputs (`context-packet-spec:41,65`, `context.ts:106`), so `read.resolve` is not "the only accessor". *(N14)*
18. Sweep the cosmetics, third time of asking: `functional-spec:44`'s `AC-8/RPO`, `requirements-spec-v3:43`'s `F-AC8`, and `ann-system-design-v3.md:7`'s `(v2)` title. *(Q5-6)*

---

## What I am not sure of

- **Whether N4's deadlock is reachable in a shape the owner would ever write.** The shipped chains do not hit it (Flow 1's artifact producers are at `execute`; Flow 2 is empty). I am certain of the mechanics — `kernel.ts:308-314` fails verify without an artifact or `commits[]`, and §3 rule 4 defers the lock past verify — and certain that only chain **data** is needed to reach it. I did not construct the run. The related finding, that **the design never states verify's failure behaviour**, is certain and independent.
- **Whether N9 matters in v1.** If "multi-client" is loose phrasing for "several in-process initiators", it is a wording fix and nothing else. I flag it because it is being written into an amendment against a locked architecture doc, and because `requirements-spec-v3` A1 explicitly parks multi-user for v1 — so the amendment claims more than v1 delivers either way.
- **Whether N3 has a clean fix inside the current shape.** I am confident the *stated* mechanism is unsound and confident about why (LLM-generated question lists, positional keys, no stored completions, `Interactor`'s verbs have no identity). I am not confident that skipping the step is safe either — it depends on whether a gate-bound step's intents can be made durable before the gate write without breaking §3 rule 4's reason for existing, which is a decision I do not think a reviewer should make for the owner.
- **Whether B1's third route (amending `v13` to per-lock-event supersession) is cheap or expensive.** `supersededLocks` returns a `Set<string>` of node ids and 14 legacy events carry no successor at all, so per-lock-event semantics would need a migration story for those. I did not scope it.
- **I did not run the flow end-to-end.** No provider is configured. Everything above is contract reading, code reading, four executed fixtures against the real `Store`, direct measurement over `.ann/journey` (45 nodes), and the 169-test suite, which I ran and which passes.
