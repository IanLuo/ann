# Design Review v6 — the core re-design (sixth pass)

*Reviewed against the locked contracts (journey-format-spec v13 @ 699615a, flow-control-spec v6 @ 5898f89, requirements-spec v3 @ 80eeaae, functional-spec @ 9e60cd8, context-packet-spec, architecture v2 @ e6d07ed, ann-system-design v3 @ 2b0a30f, resource-registry-spec v2 @ 4f95b5a, `rules/schema/vocab.json` v2, `rules/decide/rules.json`, `rules/flow/default.json`) and the current `src/` — **169 tests pass, run and verified** (`npx vitest run`, 10 files). Every spec line quoted below was read in the source file; every code line was read. Owner priority applied: **is the DESIGN sound so that later FLOW changes are sound.** Flow content is not the subject.*

---

## Q1 — Were review-5 edits 1–19 (+ cosmetics) applied?

**13 applied clean · 4 applied with a defect · 1 applied backwards · 1 unapplied.** This is the best application rate of the six passes. The failures are concentrated in the two edits that touch registries and the one that touches the v13 schema.

| # | Edit | Verdict |
|---|---|---|
| 1 | execution order grill → execute → confirm | **APPLIED, VERIFIED CORRECT** ✓ (new consequence: **C1**) |
| 2 | shape/meaning validation split | **APPLIED** ✓ (mechanism still unstated: **C-note in Q3**) |
| 3 | idempotence for all five intents | **APPLIED IN FORM, BROKEN IN SUBSTANCE: B1** |
| 4 | `execute` never skipped | **APPLIED** ✓ (collides with gate-bound steps: **B8**) |
| 5 | resume rule in three tail states | **APPLIED** ✓ (state 2 has no write path: **B4**) |
| 6 | prose-path cutoff | **APPLIED, and I verified it actually works** ✓ (**C8**) |
| 7 | v13 amendment field set | **APPLIED WRONG — regression: B2** |
| 8 | amendments as complete changes | **APPLIED, PROCEDURE INCOMPLETE: B10** |
| 9 | extend architecture amendment to :66 | **APPLIED** ✓ — but the amendment still misses its largest clause: **B3** |
| 10 | the two missing amendments | **PARTIAL — one is short, one more is missing: B7, C11** |
| 11 | `abilities.command` → `shell` | **APPLIED, VERIFIED** ✓ (**C15**) |
| 12 | `read.resolve` as an L1 derived read | **APPLIED, VERIFIED, consistent in §1/§2/§5** ✓ (**C9**) |
| 13 | artifact-type → placement registry home | **APPLIED IN WORDS ONLY: B11** |
| 14 | recorded path = task-local ref | **APPLIED** ✓ — but the filename rule is missing and AC-7 lives there: **B5** |
| 15 | six new ownership rows | **APPLIED, all six present** ✓ — table still short by two: **B9** |
| 16 | bind `prior` to `inputs[]` | **APPLIED** ✓ — "ONE content mechanism" is still false: **C2** |
| 17 | close the verdict map | **APPLIED, VERIFIED** ✓ (**C10**) |
| 18 | `created` in `append!`'s refusal list | **APPLIED, VERIFIED** ✓ |
| 19 | builtin fallback = empty chain | **APPLIED** ✓ — introduces a silent fallback: **C7** |
| — | cosmetics | read-view split ✓ · `cmdGate` drop ✓ · **AC citations NOT swept** · system-design title not noted |

### The ones that landed clean — with the evidence

- **Edit 1 (execution order).** §4:138-144 now reads grill-bound → execute entries in list order → confirm-bound. Verified against `flow-control-spec-v6:17`: `spawn → materialize → [GATE① grilling] → validate → activate → execute → verify → [GATE② confirm] → commit`. GATE② is after `verify`; confirm-bound last is correct. Review-5's N10 inversion is fixed.
- **Edit 6 (cutoff) — and I measured it.** §1:48 uses the `V9_CUTOFF` mechanism (`store.ts:630,636,648`). I re-ran the measurement: **25 nodes carry a `retrospective` grill confirmation; 24 would trip the GATE-1 predicate without `retroGrill`; every one has `createdAt` between 2026-08-15 and 2026-08-18.** So the existing value `'2026-08-21'` is safe with margin. The edit is sound. Two corrections in C8.
- **Edit 12 (`read.resolve`).** §1:23-24 lists `read` among the L1 derived reads, §2:67 injects it via ctx, §5:166 calls it an L1 derived read and explicitly denies the L3-servant reading. All three sections finally agree. Review-5's N11 is closed.
- **Edit 14 (recorded path) — verified against reality, not just the spec.** `v13:74`: *"**`path` is the task-local ref** — a symlink into `docs/` (shared document artifacts) or the real file in `artifacts/`"*. Every shared-type lock in the repo records exactly that: e.g. `06-engine-build/15-format-amendment-v11` records `journey/legs/06-engine-build/15-format-amendment-v11/artifacts/journey-format-spec.md`, which **is a symlink** (35 symlinks under `.ann/journey`). §3:106 is correct.
- **Edit 18.** §1:25-29 and §4:162 both carry `created`; §3:111 states `extended` is `append!`-only. Correct against `store.ts:553-555`.
- **Edit 17.** §2:78-81 closes all three cases (missing verdict → fail closed; unmapped decision → fail closed; step feedback wins over the map's static `feedback?`). I read the trailing `?` as the optional-field marker, not an undecided question — the precedence **is** decided. Correct.
- **Edit 9's reconciliation.** `ann-system-design-v3:59` verbatim: *"Initiators: planner kernel (spawn/expand/commit), adapters (binding results as artifacts + evidence events), validators/reviewer (evidence events)."* v6:32-36 is right that the multi-initiator position was already locked and architecture-v2:24 is the outlier. Good call, and it does make the amendment easier to approve.

---

## Q2 — NEW soundness holes

### B1 (blocking, the worst one) — the idempotence predicates cannot tell crash-replay from gate-rework, and §2 and §3 give contradictory answers for the identical tail state

This is internal to v6; no interpretation of any spec is needed to see it.

- **§2:89** — *"`lock-artifact` → **no-op when `current(name).producer === taskId`**"*.
- **§3:116, rule 3** — *"Supersede-before-lock: the store refuses a lock on an already-current name — a superseding artifact's flow writes `supersede` (old locker) BEFORE `lock` (current task)."*

On confirm-gate rework the old locker **is** the current task, so `current(name).producer === taskId` holds. Rule §2 says *no-op*; rule §3 says *supersede, then lock*. **Two rules, one tail state, opposite outcomes, nothing disambiguating them.**

Take the §2 reading, which is the one the design calls "the entire replay-safety mechanism" (§2:88). Walk `flow-control-spec-v6:37` — the locked routing v6 §4:149-152 promises to honour:

> `GATE② reject → **re-execute** (rework output from artifacts + feedback) → re-verify → back to GATE②.`

1. `envision` runs, locks `vision`. 2. GATE·confirm rejects with feedback. 3. The frame re-executes (`execute` is never skipped, §1:59). 4. `envision` re-runs, produces a **better** doc, declares `lock-artifact{name:'vision'}`. 5. Predicate fires → **no-op**. 6. `verify` passes (an artifact exists). 7. GATE·confirm is re-presented **with the rejected artifact**. 8. Repeat until the 3-reject bound escalates.

**The rework channel is dead for every execute-phase step that locks an artifact.** The same defect hits the trace: §2:93 keys ability-hook emissions on `(stepId, seq)` — *"the call's deterministic ordinal within the step's execution for the same packet"*. On rework the step re-runs, `seq` restarts at 0, the keys collide with round 1's, and round 2's LLM calls are skipped — directly contradicting §2:86's justification (*"a multi-round session leaves a durable per-call trace"*), and `idea-validate` is by construction a multi-round session.

The root cause is one sentence the design never writes: **`execute` is re-entered for two different reasons that require opposite behaviour** — crash-replay (must be a no-op) and gate-rework (must produce a new fact). Every predicate in §2:88-93 is written for the first and silently wrong for the second. `lock-artifact` and `evidence` are actively broken; `propose-spawn` and `close` are merely questionable. "Same packet" is doing all the work and is never defined.

Note the asymmetry that proves the design already knows this problem exists: §3 rule 4 (`:117`) protects **grill** rework by deferring a gate-bound step's non-gate intents until the gate confirms. There is no counterpart for **confirm** rework.

### B2 (blocking, regression) — `openQuestions` is moved inside `contract{}`, contradicting v13 and review-5's own correction

`journey-format-spec-v13.md:24-38` is an enumerated JSON block. `openQuestions` is at **line 33, a top-level sibling of `contract`**:

```
26    "contract": { "intent", "acceptanceCriteria", "targetAreas", "requiredInputs", "expectedOutputs" },
33    "openQuestions": [ {"id","question","blocking","reason","defaultIfUnanswered","affectedTaskIds"} ],
37    "createdAt": "YYYY-MM-DD"
```

v6:97 writes it as `contract{ intent · acceptanceCriteria · targetAreas · requiredInputs · expectedOutputs · openQuestions[] · workType · flow · model }` — **inside the braces** — while citing review-5 N2a, which had asked for `id · contract{…} · openQuestions[] · createdAt`. This is the one row the design says most needs to be exactly right, because `spawn!` is built from it.

Consequences, all measured:

- The repo has **45 `node.json` files; exactly one carries `openQuestions`, at the top level** (`04-system-design/node.json`). `spawn!` built from v6:97 rejects it as an unknown field.
- The divergence is already live in code: `context.ts:88-91` reads `c.openQuestions` where `c` is the **unwrapped contract**, so `04-system-design`'s blocking questions never reach `packet.readiness` (`context.ts:113`). v6:97 would **lock that bug into the amended schema** while claiming *"`openQuestions.blocking` survives (it gates the node)"*.
- v13:41 also makes `contract.intent` and `contract.acceptanceCriteria` REQUIRED (*"`contract.intent` REQUIRED. `contract.acceptanceCriteria` REQUIRED, non-empty"*). v6:97 marks only `id` and `createdAt` as required.

Either placement is defensible as a v14 decision — `store.spawn` (`store.ts:545,550`) can only ever produce the in-contract form, so the tooling has already voted. What is not defensible is changing v13's structure **while presenting the line as a quotation of it**. If v14 relocates the field, say so as a second amendment item and state the migration for `04-system-design`.

### B3 (blocking) — the architecture amendment still covers less than half its own diff: it omits the layer model itself

v6:32-36 and §8:219 amend architecture v2 at `:24`, `:61`, `:66`. All three citations verified verbatim. What is not amended is the clause the whole design replaces:

- `architecture-v2:27` — **`LB-4 — Strict one-way layering: store ← kernel ← engines ← adapters ← surface.`** That is **five** layers.
- `architecture-v2:60` — *"**Dependencies point down only** — Surface → adapters → engines → kernel → store. Never up."*
- `architecture-v2:38-58` — the five-tier layer diagram.
- `architecture-v2:63` — *"The kernel routes each step to its engine."*
- `architecture-v2:71-80` — the `src/` repo tree assigning one dir per layer (`store/` `kernel/` `engines/` `adapters/` `surface/`).

v6 ships a **four**-layer stack, **inserts a new COMMANDS layer between store and kernel that LB-4 does not contain**, and folds the engines into L2 as steps (§8:216 — *"L2: steps rebuilt on the new contract"*). This is a larger change to architecture v2 than the initiator clause, the enforcement-split clause, and the multi-client clause combined, and it is the design's own headline structure. It is not recorded anywhere.

Also unamended: `architecture-v2:97` locks the error shape as `{ok:false, error:{code, blocker}}`; v6:94 says `{ok:false, blocker}` (see C14).

### B4 (blocking) — the resumability claim has no write path: nothing can produce an undecided `submitted`

§1:59 states three tail states, the middle being *"`submitted` undecided → block and wait (the store already derives `blocked`)"*, and the whole paragraph rests on *"**Resumable**: any interruption (pending gate, rejection) leaves the task blocked/pending in the store."*

The L1 surface as enumerated cannot create that state. §1:24 lists five mutators; §4:133-134 defines the gate one as *"Written via gate! (submitted + confirmed/rejected)"* — one atomic call that writes the submission **and** the decision. That is exactly today's behaviour and today's documentation: `cli.ts:829` describes `gate!` as *"WRITE — human gate decision (**submit + decide**; 3-reject bound)"*, implemented at `cli.ts:752-753`.

So the derived `blocked` status (`store.ts:179-183`), `lookBack().pendingGates` (`kernel.ts:134-142`) and the CLI's *"WAITING ON YOU"* line (`cli.ts:447`) are all views of a state **no write path produces**. And more to the point: for an interruption *during* a gate to leave the task blocked, the frame must write `submitted`, then present, then write the decision — two calls. The design needs a submit-only mutator (or `gate!` split into submit/decide) and does not have one. Without it, tail state 2 is unreachable and "resumable, not restartable" (§7:204) is unbacked at the one phase where a human can take arbitrarily long.

### B5 (blocking) — type-derived placement stops at the directory; AC-7 lives in the filename

§3:120 derives the **directory** from the artifact type (`docs/<category>/` + symlink, or task-local). It never states the **filename**. The filename is load-bearing in three places:

- `store.ts:74` — `logicalNameFromFile` resolves a logical name by stripping `.md` **and a `-vN` suffix**. The versioned filename is how the resolver works.
- `requirements-spec-v3:44` (AC-7) — *"a **complete superseding artifact** under the same logical name; **the old artifact stays byte-identical** with a `superseded` event"*.
- The repo's actual layout: `docs/specs/` holds `journey-format-spec-v10.md … -v13.md` side by side (real files, versioned), while each locking task's `artifacts/<logical-name>.md` is an **unversioned symlink** to the current one.

If `lock!` materializes a shared type to `docs/<category>/<logical-name>.md`, then locking `journey-format-spec` v14 **overwrites v13** and AC-7's byte-identical guarantee is gone on the very first amendment the design itself schedules (§8:219). The design must state: real file = `docs/<category>/<name>-v<N>.md`, task-local ref = `artifacts/<name>.md` (symlink), recorded path = the symlink, and who computes `N`.

### B6 (blocking) — a step's `inputs[]` is code-side, so chain data cannot rewire what a step consumes — AC-3 is a locked AC and the design fails it

`requirements-spec-v3:40` (AC-3), verbatim:

> **AC-3:** the chain is **configurable**: a project defines its step sequence (default template: idea → validate → envision → specs → …); **changing the chain requires no code change — only project data.**

In v6, `inputs[]` is a field of the **step** (§2:64, `step.ts:68`), not of the chain entry (§6:175 carries only `id`, `params?`, `at?`, `verdict?`). And `inputs[]` is what chain validation binds on (§3:118, `flow.ts:125-137`), what `prior` is bound to (§2:71), and what `read.resolve` is bound to (§5:167). The current code makes it concrete: `spec-step.ts:73` — `readonly inputs = ['envision']`.

So a purely-data chain edit — insert a `research` step before `envision`; drop `envision` for a work type that doesn't need a vision; have `spec` consume `research` instead — either **fails chain validation** or **requires editing the step's `inputs[]` in TypeScript**. That is the owner's stated criterion ("is anything left that forces a code change for a new … chain shape?") failing against a locked AC, and no review in the chain has raised it.

Two honest resolutions: put `inputs` on the chain entry (data, with the step declaring only a *shape* it needs), or state plainly that a step's inputs are intrinsic and rewiring consumption is a new step — and then correct the §6:181 claim that *"New work types/steps/chains/gate sources/artifact types = data changes"*, which as written is false.

### B7 (blocking) — the resolution ladder: enablement is asserted as registry data that does not exist, and the §4 deferral is unrecorded

§1:57 gives the ladder a table row: *"**registry data** (`rules/decide/rules.json`) | the rungs are registry data with enablement read by the flow — v1 ships `block` enabled; enabling a rung is data, not code"*. §4:129-130 repeats it.

`rules/decide/rules.json` contains five `{step, note}` entries and **no enablement field of any kind**. The design asserts, in the present tense, a data shape that is not there — the same defect it fixed for gates and repeated for artifact types (B11).

Worse, the underlying deferral is unrecorded. `flow-control-spec-v6:45-51`:

> Missing `requiredInputs` or blocking `openQuestions` → **resolve in order:** 1. **derive** … 2. **probe** … 3. **infer** … 4. **ask** … 5. **block** …

The spec mandates an *ordered ladder*, not an *enablement set*. Shipping "only `block`" means rungs 2–4 never run, which is a deviation from a locked section. v6 records a deferral for flow-control **§7** (§8:219) and none for **§4**. Note this is no longer academic: rung 4 (`ask`) is now buildable — the `interact` ability exists with four verbs (§1:12, `interact.ts`) — so "we can't" is not the reason.

Also relevant: `resource-registry-spec-v2:63` — *"Registry integrity is itself a check: **every consumed rule exists in a registry; no hardcoded rule outside it**"*.

### B8 (blocking) — "execute is never skipped" + gate-bound steps ⇒ the frame re-grills a human at an already-confirmed gate, contradicting §3 rule 6

Three v6 statements that cannot all hold:

1. §1:59 — *"last-at-gate `confirmed` → skip"* and *"**`execute` is NEVER skipped**"*.
2. §4:138-141 — execution order begins with *"grill-bound steps first (at the grill phase)"*.
3. §3:119, rule 6 — *"**One human decision per gate** … the frame never double-presents (the §1 resume rule)."*

Crash after `confirmed(grill)` but before the grill-bound step's deferred intents were translated (§3:117 defers them until after confirmation — a window the design creates deliberately). On resume: the gate is skipped (1), but the grill-bound step is re-run (2) because execute is never skipped. For `idea-validate` **the step is the grilling conversation** — a bounded multi-round session with the user. The human is re-interviewed for a decision already recorded, which is precisely what (3) forbids.

The store survives (idempotent intents) but the human does not. The design needs to say what happens to a gate-bound step whose gate is already confirmed: skipped (and then its intents must have been durable before the gate wrote, which §3 rule 4 forbids), or re-run (and then §3 rule 6 is false).

### B9 (blocking, small) — `vocab.json`'s other two arrays are the same trap v6 just fixed for gates

Review-5's Q4 caught `vocab.json.gates` looking adjustable while being protected, and v6:56 added the row. **The same file has two more arrays with the same property and no row:**

- **`eventTypes`.** `appendEvent` accepts any value in it (`store.ts:456`), but `validateEventShape`'s per-type allow-list is a **code literal** (`store.ts:474-489`). Adding `"reviewed"` to the registry yields `allowed[e.type] ?? []` → every field is "unknown" → `store.ts:490-491` throws *"unknown field(s) 'at, type'"*. It fails closed, with a message that names the wrong problem, after looking like a supported data change. (Correct answer: the event vocabulary is **protected** by `journey-format-spec-v13:57-61`, and adding a kind is a v13 amendment.)
- **`statuses`.** Adding one is a **silent no-op** — `taskStatus` hardcodes the event→status mapping (`store.ts:158-175`) and `legStatus` hardcodes the aggregate (`store.ts:191`). No error at all.

The ownership table's job is exactly this line. It now covers one of the registry's four arrays as protected and one (`artifactTypes`) as adjustable, and leaves two undeclared.

### B10 (blocking, small) — the amendment procedure drops two of v13's four requirements, and AGENTS.md has three stale pointers, not one

`journey-format-spec-v13:164` verbatim:

> Amendments = **new nodes** (tasks) whose artifacts **completely supersede** it — reusing the logical name `journey-format-spec` and **preserving section anchors** — with a **back-reference** + `superseded` event.

v6:97 and §8:219 state: complete superseding artifact under the same logical name + `superseded` event + referrer re-pointing. **"Preserving section anchors" and "a back-reference" are both dropped.** Anchor preservation is not decoration — this design cites `v13 §2`, `§3`, `§14`, `§15` by section throughout, and every one of those citations breaks if v14 renumbers. (Referrer re-pointing is correctly required but comes from `requirements-spec-v3:44` and `AGENTS.md:43`, not from v13:164 — worth citing accurately.)

On referrers, v6:219 says the architecture amendment *"fixes AGENTS.md's stale pointer"*, singular. There are three, plus an absence:

- `AGENTS.md:41` → `journey-format-spec.md (locked @ 4b4c8c3)` = **v11**; current is v13 @ 699615a. Two versions of drift, and this design's own v13→v14 amendment must fix it.
- `AGENTS.md:46` → `architecture.md (locked @ fcfa661)` = **v1**; current is v2 @ e6d07ed.
- `AGENTS.md:48` → `resource-registry-spec.md (locked @ 9c3705e)` = **v1**; current is v2 @ 4f95b5a.
- `context-packet-spec.md` has **no AGENTS.md pointer at all**, though the design leans on it in §5:166.

### B11 (blocking, small) — artifact-type placement: asserted registry data that isn't there, and "new type" conflated with "new category"

§3:120: *"**Placement derives from the artifact's TYPE**, read from the vocab registry: **each `artifactTypes` entry carries its category**"*. `vocab.json`'s `artifactTypes` is a flat string array: `["spec","system-design","architecture","record","vision","validation"]`. No categories. Present tense against absent data, identical in form to B7. §8's ship list never includes the `vocab.json` migration.

Second, the claim *"a new artifact type is a DATA change — add the entry + category to the registry, never code"* is only true for a type that reuses an existing category. `journey-format-spec-v13:223` — *"**No catch-all category.** Everything else is task-local"* — with exactly three directories enumerated at `v13:227-229`. A new type needing a **new** `docs/` category is a **v13 §15 amendment**, not a data change. The design should split the two cases; as written it invites someone to invent `docs/policies/` by editing a registry.

---

## Q3 — Simplicity: is this the smallest sound core?

**The shape is right and I would defend it unchanged.** Four layers, one write path, five intents, steps as pure units, chains as data, the gate source *is* the chain, `read.resolve` as an L1 read, gate-bound intent deferral. Nothing here is speculative machinery. Review-5's structural verdict stands and v6 improved on it. The remaining weight:

1. **Two content mechanisms, claimed as one (C2).** §5:167 — *"`prior` is bound the same way — ONE content mechanism"*. They are not one. `prior` carries the **structured** `out.artifact` (`spec-step.ts:73-90` consumes `envision`'s object and calls `renderVision` on it); `read.resolve` returns `{content, path, sha}` — markdown text. They carry different types and cannot substitute. §2:73's replay clause — *"on a replay, `prior` resolves from the LOCKED artifact via the name in that step's own `lock-artifact` intent"* — is therefore **either dead or contradictory**: since `execute` is never skipped, the whole chain re-runs and `prior` is always repopulated in memory, so the clause is never reached; if it *is* reached, execute was partially skipped and §1:59 is false. And a step with no `lock-artifact` intent has no name for it to resolve through. Pick: delete the clause, or state that `prior` is in-memory-only and drop the "one mechanism" claim.
2. **Two evidence paths, one job, no enforcer.** The `evidence` intent (§3:105) and the ability record hook (§2:86) both produce `evidence` events, with **different dedup keys** (`commits[].sha`/`refs[]`/`answers[].id` vs `(stepId, seq)`). The only thing keeping them apart is a convention with no enforcement — *"Steps do NOT duplicate in intents what their ability calls already emitted"* (§2:86).
3. **Contract self-sufficiency is checked three times.** `spawn!` (F-AC19, §1:51), the `validate` phase (§4:136 → `kernel.ts:180`), and `check()` (`store.ts:645-650`). Defensible (project data is mutable between spawn and execute) but never justified in the text — one clause would retire the question permanently.
4. **The spawn-time chain check overlaps `spawn!`'s F-AC19.** §3:118 has L2 validate *"inputs resolvable"* against the prospective contract; `spawn!` already resolves `requiredInputs` via `current()` (`store.ts:251-258`). Also, the mechanism review-5's N3 identified is still unstated: `validateChain` takes a **packet** (`flow.ts:113`) and `assemblePacket` reads `node.json` from disk (`context.ts:88`), which does not exist pre-spawn. Saying "against the prospective contract" resolves the layering objection in words; it does not say what L2 actually reads. One sentence.

**Can a step still reach the store?** No. Both review-5 reach-throughs are closed: `abilities.command` → `shell` with an explicit clause (§2:69-70, §7:202), and `read.resolve` is an L1 read (§5:166). `ctx.store` and `recordEvidence` are gone from §2 (they are still on `step.ts:43,49` today — correctly slated for deletion). This is the cleanest the boundary has been.

---

## Q4 — The line between adjustable and protected

The table is the strongest part of the document and is **true against the code** row by row, with the exceptions named above. Verified spot-checks: `gate!` reject bound (`cli.ts:755`, `kernel.ts:88`) with L2 now reading only `{escalated}` (`kernel.ts:211-215` — right computation, wrong side today, correctly reassigned by §1:52); one-current-per-name (`cli.ts:773-776`); leg roots refuse events (`store.ts:453-455`); `store.ts` carries **zero** flow/work-type/step knowledge (grepped — confirmed); unknown `workType` is a named refusal (`flow.ts:97-102` → `kernel.ts:239-241`); chains cannot encode a loop (`flow.ts:139-144`).

**Correctly protected, verified against the locked text:** the 3-reject bound (`flow-control-spec-v6:39` — *"**Bound:** 3 rejection cycles per gate"*, a bare prose constant with no config path); rework rungs (`v6:36-38`); gate set (`v6:34` — *"Both gates are **HARD on every node in v1**"*); gate positions (fixed by the `v6:17` skeleton — note v6:56 cites `:34` for both, but `:34` locks only the *set*; the *positions* come from `:17`); gate sequence; single writer; lifecycle order.

**Correctly adjustable:** chains, work types, gate source, verdict maps, params, `contract.flow`.

**Still wrongly declared:** ladder enablement (B7), artifact-type category (B11), `eventTypes`/`statuses` (B9). Two of those three are rows v6 *added* in this pass, which is worth saying plainly: **the table's two new "adjustable" rows both point at data that does not exist.** A table whose job is to be checkable should not contain unverifiable present-tense claims.

**Missing rows** (beyond B9): the artifact **filename/versioning** convention (B5 — no owner anywhere); **chain linearity** (chains are sequential and unconditional — `flow.ts:139-144`; branching is not expressible and the limit is never stated, C6); **`params`** (C5 — unvalidated data crossing into steps with no schema and no static check); **`at:` values** (a mixed namespace: `'grill'`/`'confirm'` come from `vocab.gates`, `'execute'` is a phase literal — §4:124 says *"chain phase bindings use the same values"*, which is true for two of three).

---

## Q5 — Are the four recorded amendments the COMPLETE set?

**No. One recorded amendment is materially short (B3), one recorded one is short by a row (C11), and one more locked section is silently deviated from (B7).** Verifications first, because two of the four are correct and hard-won:

- **flow-control §7 — v6's description is CORRECT, and I checked it character by character.** `flow-control-spec-v6:80`: `| Work type | Materialize | Missing input | Verify | Chain effect |`. There is no chain column. `:78`: *"Work types parameterize the common skeleton (materialize / missing-input / verify / chain effect)."* v6:180 states this accurately and records a deferral rather than claiming conformance. Review-5's Q5 is properly discharged. **One flaw:** v6:180 contradicts itself inside one sentence — *"v1 implements **none** of the four columns; … **chain-effect is served by `propose-spawn` intents**"* (C16).
- **context-packet-spec — verified NOT violated.** `:65` *"`sourceType` is always `derived-from` (resolution via current()). No inference, no probing in v1"*, `:75`/`:86` *"`observation` … reserved, unused"*. §5:166's provenance claim is exactly right, and the packet never carries content (`:67`, `:73-74`), so §5:168 holds.
- **v13 on cross-task appends — verified permitted.** All locality rules in v13 concern **leg roots** (`:63`, `:71`, `:172`, `:182`) and the producing node for `artifact-locked` (`:86`). No task-to-task prohibition exists. §3:108 and §7:203 are safe.

**Missing / short:**

1. **architecture v2 — LB-4 (`:27`), the dependency chain (`:60`), the five-tier diagram (`:38-58`), the repo tree (`:71-80`).** B3. This is the design's own structure and it is unamended.
2. **flow-control v6 §4** — shipping only `block` deviates from *"resolve in order"* (`:45-51`); no deferral recorded. B7.
3. **resource-registry v2 — the instance table, not just the category.** v6:219 records *"`schema` category added"*. `:36` is the enumeration (`ask | check | decide | adapter | flow | binding | surface`) — correct target — but `:51-57` is the **instance table** and it has **no `vocab` row**. Both need the amendment. And like the initiator clause, this is partly a **reconciliation**: `architecture-v2:84` already lists *"`rules/` registries (**vocab** · decide/ask/check · adapter/provider)"*. Saying so makes it a two-line approval instead of a debate. (C11)
4. **The `vocab.json` migration itself** — `artifactTypes` flat array → entries with a category — is a registry data change on which two of the design's mechanisms stand, and it appears nowhere in §8's ship list. (B11)
5. **flow-control v6:24 — `activate` is redefined without a note.** `:24`: *"**activate:** frontmost-ready selection — the **OUTPUT of the look-back**"*. v6 §4:137 redefines it as *"the frame writes `activated`"* and moves frontmost-ready selection to the top of §4. Both things happen, so nothing breaks — but the design claims conformance to the locked lifecycle and quietly reassigns one of its phase names. One clause. (C12)
6. **journey-format v13 §2's `openQuestions` relocation** is a second, substantive change to v13 that v6 presents as a quotation rather than an amendment item. (B2)

---

## Completeness items (16)

- **C1 — a confirm-bound step's output escapes `verify`, and can starve it.** §4:148 puts `verify` before GATE·confirm (correct per `flow-control-spec-v6:17`), and §3:117 defers a gate-bound step's non-gate intents until the gate confirms. So a confirm-bound step's artifact locks **after** verify has already run: its output is never verified, and a chain whose only artifact-producing step is confirm-bound fails verify's evidence requirement (`kernel.ts:310-313`) for a reason no static check catches.
- **C2 — `prior` vs `read.resolve`.** See Q3-1.
- **C3 — node-level `superseded` is unwritable through the new surface.** The `supersede` intent is artifact-only (§3:108, *"the old artifact (AC-7)"*), `append!` refuses `superseded` (§1:25-29), and `supersede!` requires `{name, path}` (`cli.ts:793-796`, `store.ts:513-518`). But `superseded` also means *this node was superseded*: `taskStatus` maps it to the `superseded` status (`store.ts:171-173`), `legStatus` counts it as concluded (`store.ts:191`), `frontmostReady` skips it (`kernel.ts:121`), and **14 such events exist in the repo without a `successor`**. One event kind, two meanings, one of them now unreachable.
- **C4 — `feedback?` is not scoped by gate.** §2:74 — *"last `rejected.feedback` for this task"*. A task can hold both grill and confirm rejections; a grill-bound step reworking approach and an execute step reworking output need different feedback. This is the rework channel; it should name its gate.
- **C5 — `params` are unvalidated.** §6:175 puts arbitrary data on a chain entry, §2:66 injects it into ctx, and nothing declares or checks a shape. A typo in flow data becomes silent wrong behaviour in a design whose §7 forbids exactly that. Either add `paramsSchema?` to the step contract or state that a step must validate its own params and fail closed.
- **C6 — chains are linear and unconditional, and this is never stated as a limit.** `flow.ts:139-144` rejects duplicates; entries run in order; no branch, no condition, no repeat. That is the right v1 choice — but the owner will read §6:181's *"new … chains = data changes"* and eventually try to express "run `research` only when inputs are missing." Say the limit, and say the escape (a new work type, or a step's internal decision).
- **C7 — an absent `workType` silently falls to the empty chain.** Unknown `workType` is a named refusal (`flow.ts:97-102`) ✓. **Missing** `workType` is not: `flow.ts:104` falls to `chains.default`, and with edit 19 making the builtin empty (§7:206) and §6:187-192's sample data dropping the `default` key, a task that simply forgot to declare its work type runs **lifecycle-only and silently**. §7:207 forbids silent inference; this is one. Make the absent case as loud as the unknown case, or state that lifecycle-only is the deliberate default.
- **C8 — the cutoff value is unnamed, and "25 nodes" is 19 tasks.** §1:48 writes `createdAt >= CUTOFF` and never names it; pick `'2026-08-21'` (I verified all 24 affected nodes are ≤ 2026-08-18, so it is safe with three days of margin). And of the 25 nodes carrying retrospective grill confirms, **5 are leg roots**, which `gateProblems` exempts at `store.ts:561` — so **19 tasks** actually become unwritable, not 25. The argument is right; the design cites the number as measured evidence, so it should be the right number.
- **C9 — `read.resolve`'s `sha` does not match its `content`.** `cmdLock` computes the blob sha over **marker-stripped** content and then writes `<!-- specs:locked:<sha> … -->` into the file (`cli.ts:779-781`). `context.ts:64,77` already strips the marker for excerpts. §5:166 must say `read.resolve` returns marker-stripped content, or a step that re-hashes what it read will always mismatch.
- **C10 — verdict-map completeness cannot be statically validated.** §6:179 says *"statically validated"*; what is checkable is "at most one step per gate". Nothing declares a step's possible `decision` values, so a step gaining a decision in code without a data update fails at runtime. Fail-closed, so not dangerous — but the static-validation claim is broader than the mechanism. A `decisions[]` on the step contract would close it.
- **C11 — the resource-registry amendment needs the `vocab` instance row and should be framed as a reconciliation.** See Q5-3.
- **C12 — `activate` redefinition.** See Q5-5.
- **C13 — `prune` has no home and no deferral.** `functional-spec:45` (F15) and `ann-system-design-v3:66` (*"`prune(subtreeId)` (validated)"*) both lock a prune capability; `depth-policy`/F-AC12 depend on it. §1:24's five mutators do not include it, and it is absent from `src/` entirely today. Pre-existing, not a v6 regression — but a design that claims L1 is *"the ONLY path to the store"* (§1:21) and *"COMPLETE over the event vocabulary"* (§1:26) should say prune is deferred rather than leave a locked function homeless.
- **C14 — error-model shape.** `architecture-v2:97` locks *"failure is a value (`{ok:false, error:{code, blocker}}`)"*. §2:94 says `{ok:false, blocker}`. The executor already uses the locked shape (`executor.ts:28`); steps use the short one (`step.ts:56`). Pick one and, if it is the short one, add it to the architecture amendment.
- **C15 — silent drops in the ability set and the spawn path.** §2:68 lists `llm · interact · shell · tool`; `request` (`executor.ts:58`) disappears with no note. And `cmdSpawn` still writes `description.md` (`cli.ts:735`), which `journey-format-spec-v13:15,105` **removed** (*"the `description.md` card is gone"*; 0 exist on disk). §1:37-40's L0 enumeration correctly omits it, but §8:212's `spawn!` description should say the card write is retired.
- **C16 — §6:180 contradicts itself.** *"v1 implements none of the four columns … chain-effect is served by `propose-spawn` intents."* Both cannot be true. Say: three of four deferred, chain-effect served by `propose-spawn`.

**Cosmetic, unapplied from review 5:** the dangling AC citations were not swept — `functional-spec:44` cites `AC-8/RPO` (requirements-spec-v3 stops at AC-7), and `requirements-spec-v3:43` cites `F-AC8`, which lives in `tree-format-spec.md:82`, not in functional-spec. `ann-system-design-v3.md:7` is still internally titled *"# Ann System Design (v2)"*. Also: §1:48 cites *"machine-truth, NFR-COM-1"* — `requirements-spec-v3:64` reads *"answerable from structure alone — no prose parsing"*, which is apt; "machine-truth" is journey-format's phrase. Trivial, but this design is precise everywhere else.

**Regression check against reviews 1–4:** every numbered blocker from reviews 1, 2, 3 and 4 is accounted for in v6. One genuine regression (B2). Two soft absorptions worth knowing about: review-1 Q3's *"engines never import Store"* survives only generically via §2:86, and review-2 Q6-5 (how `spec` **derives** which tasks to propose) is still unspecified after five passes — though that is legitimately a step-internal concern under §2:95 and is covered by the §7 deferral. No hard silent drops.

---

## Q6 — Lock verdict

# LOCK AFTER the 11 blocking edits — but v7 is a revision, not a copy-edit, and three of the eleven need review #7.

The architecture is right and I would defend it as-is: L0–L3, one write path, five intents, steps as pure units with no store and no write hook, chains as data, gates as observed L1 writes, the gate source *is* the chain, `read.resolve` as an L1 derived read, gate-bound intent deferral, type-derived placement. **Thirteen of nineteen review-5 edits landed clean** — the best pass yet, and the two reach-throughs that let a step touch the store are now genuinely closed. The cutoff fix is not just applied but *correct*: I measured it.

What stops the lock is that this pass's two new "adjustable" table rows both point at data that does not exist, one edit relocated a v13 field while quoting it, and — the serious one — **the idempotence mechanism the design calls "the entire replay-safety mechanism" makes gate-2 rework a no-op.** §2:89 and §3:116 give opposite answers for `current(name).producer === taskId`, and the locked routing at `flow-control-spec-v6:37` runs straight through that contradiction.

Unlike review 5, I cannot say "everything else is a sentence or a field." **B1, B4 and B6 are mechanism, not prose:**
- **B1** needs a discriminator between replay and rework (derivable from the tail — the count of prior rejections at the bound gate — but it must be designed, not asserted).
- **B4** needs a submit-only mutator, which changes the L1 surface from five to six.
- **B6** needs a decision about where `inputs[]` lives, which changes either the step contract or the chain schema — and it is a locked AC (`requirements-spec-v3:40`), not a preference.

Send v7 back for a targeted review of those three. The other eight blockers and all sixteen completeness items are edits.

### Blocking (11)

1. **Resolve the replay-vs-rework collision.** Name the two reasons `execute` is re-entered and give each its own rule. §2:89's no-op predicate and §3:116's supersede-before-lock currently contradict each other for the identical tail state; §2:93's `(stepId, seq)` key suppresses round-2's trace for the same reason. Define what discriminates them (the rejection count at the bound gate is derivable and stored) and say what a reworked `lock-artifact` does — supersede-then-lock, per §3 rule 3. *(B1)*
2. **Put `openQuestions` back at node.json top level** (`v13:24-38`, sibling of `contract`), or record its relocation as an explicit v14 amendment item with the migration for `04-system-design/node.json` and the `context.ts:88-91` read. Add `contract.intent` and `contract.acceptanceCriteria` to the REQUIRED set (`v13:41`). *(B2)*
3. **Extend the architecture amendment to the layer model:** `LB-4` (`:27`, five layers), `:60` (dependencies point down: surface → adapters → engines → kernel → store), the five-tier diagram (`:38-58`), the repo tree (`:71-80`). v6 inserts a COMMANDS layer LB-4 does not contain and folds engines into L2. *(B3)*
4. **Add a submit-only mutator** (or split `gate!` into submit/decide). Without it nothing can produce the undecided `submitted` that §1:59's tail state 2, `store.ts:179-183`, `kernel.ts:134-142` and `cli.ts:447` all depend on — and "resumable, not restartable" has no write path at the one phase that waits on a human. *(B4)*
5. **State the artifact filename rule:** real file `docs/<category>/<name>-v<N>.md`, task-local ref `artifacts/<name>.md` (symlink), recorded path = the symlink, and who computes `N`. `store.ts:74` resolves on the `-vN` suffix and AC-7's *"the old artifact stays byte-identical"* (`requirements-spec-v3:44`) breaks on the design's own first amendment without it. *(B5)*
6. **Decide where `inputs[]` lives.** Either move it onto the chain entry (data) or state that a step's inputs are intrinsic and correct §6:181 — because as written, `spec-step.ts:73`'s `inputs = ['envision']` means a data-only chain rewiring requires a code change, and `requirements-spec-v3:40` (AC-3) forbids that in so many words. *(B6)*
7. **Fix the ladder row and record the §4 deferral.** `rules/decide/rules.json` has no enablement field — either add one and say §8 ships that data change, or drop the "registry data" claim. Then record the deferral against `flow-control-spec-v6:45-51` (*"resolve in order"*), noting that `ask` is now buildable via the `interact` ability. *(B7)*
8. **Say what happens to a gate-bound step whose gate is already confirmed.** §1:59 (skip the gate) + §4:138-141 (grill-bound steps run first) + *"execute is NEVER skipped"* currently re-run a human grilling session at a decided gate, contradicting §3:119's *"the frame never double-presents."* *(B8)*
9. **Add two ownership rows: `vocab.eventTypes` and `vocab.statuses` — both PROTECTED** (`v13:57-61`; enforced by the code literal at `store.ts:474-489` and the mapping at `store.ts:158-175`). They are the same trap v6 just fixed for `gates`, in the same file. *(B9)*
10. **Complete the amendment procedure and the referrer list:** add *"preserving section anchors"* and *"a back-reference"* (`v13:164`), and re-point all three stale AGENTS.md pointers — `:41` (journey-format @ v11), `:46` (architecture @ v1), `:48` (resource-registry @ v1) — plus add the missing `context-packet-spec` pointer. *(B10)*
11. **Fix the artifact-type row and split the two cases.** Give `vocab.json.artifactTypes` its category field as a listed §8 data migration, and separate "new type in an existing category" (data) from "new `docs/` category" (a `v13 §15` amendment — `:223` *"No catch-all category"*, three dirs at `:227-229`). *(B11)*

### Required for completeness (16)

12. State that a confirm-bound step's output is not covered by `verify`, and what happens when it is the task's only artifact. *(C1)*
13. Drop the "ONE content mechanism" claim or the dead `prior`-on-replay clause — `prior` carries structured artifacts, `read.resolve` carries text. *(C2)*
14. Give node-level `superseded` a path, or state that it is retired and that the derived `superseded` status is legacy-only. *(C3)*
15. Scope `ctx.feedback` to a gate. *(C4)*
16. Say who validates `params` and what happens when they are wrong. *(C5)*
17. State that chains are linear and unconditional, and name the escape. *(C6)*
18. Make an absent `workType` as loud as an unknown one — or state that lifecycle-only is the deliberate default. *(C7)*
19. Name the cutoff (`'2026-08-21'` is verified safe) and correct 25 → 19 tasks. *(C8)*
20. Say `read.resolve` returns marker-stripped content matching `sha`. *(C9)*
21. Narrow the "statically validated" claim for verdict maps, or have steps declare `decisions[]`. *(C10)*
22. Add the `vocab` instance row to the resource-registry amendment and frame it as reconciling `architecture-v2:84`. *(C11)*
23. Note the `activate` redefinition against `flow-control-spec-v6:24`. *(C12)*
24. State that `prune` (F15, `ann-system-design-v3:66`) is deferred. *(C13)*
25. Reconcile the error shape with `architecture-v2:97`. *(C14)*
26. Note the `request` ability's removal and retire the `description.md` write (`v13:15,105`). *(C15)*
27. Fix §6:180's self-contradiction: three of four columns deferred; chain-effect served by `propose-spawn`. *(C16)*

---

## What I am not sure of

- **Whether B6 is a defect or a deliberate boundary.** A step's inputs being intrinsic is a perfectly respectable position — a step is defined partly by what it eats. My confidence is in the *contradiction* (AC-3 says data-only chain changes; `spec-step.ts:73` says otherwise) and in the design never choosing. Which way it should resolve is the owner's call, and it is the single most consequential open question for the "flows are data" goal.
- **Whether B4 is already intended.** §4:133-134's *"gate! (submitted + confirmed/rejected)"* may be shorthand for two calls rather than one atomic write. If so it is a wording fix, not a surface change — but `cli.ts:829`'s *"submit + decide"* is the current meaning, and the design is a re-implementation target that an implementer will read literally.
- **Whether the `openQuestions` placement should follow v13 or the code.** `store.spawn` (`store.ts:545,550`) structurally cannot produce v13's shape, so every node the tooling has ever written disagrees with the spec. I lean toward v14 relocating it into `contract` (fewer moving parts, matches every real node but one), but the amendment must *say* it — that is what makes B2 blocking rather than cosmetic.
- **Whether B8 is reachable in practice.** It needs a crash inside the window between `confirmed(grill)` and the deferred-intent translation — a window §3 rule 4 creates deliberately, so it exists, but I did not construct the run. The contradiction between §1:59, §4:138-141 and §3:119 is textual and certain; its frequency is not.
- **I did not run the flow end-to-end.** No provider is configured (`spec-step.ts` defers the live run). Everything above is contract reading, code reading, direct measurement over `.ann/journey`, and the 169-test suite, which I ran and which passes.
