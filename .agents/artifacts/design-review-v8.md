# Design Review v8 — the core re-design (eighth pass)

*Reviewed against the locked contracts (journey-format-spec v13 @ 699615a, flow-control-spec v6 @ 5898f89, requirements-spec v3 @ 80eeaae, functional-spec @ 9e60cd8, context-packet-spec, architecture v2 @ e6d07ed, ann-system-design v3 @ 2b0a30f, resource-registry-spec v2 @ 4f95b5a, `.ann/rules/schema/vocab.json`, `.ann/rules/decide/rules.json`, `.ann/rules/flow/default.json`) and the current `src/` — **169 tests pass, run and verified** (`npx vitest run`, 10 files, 870 ms). Every spec line quoted was read in the source file. **Fourteen findings below were executed against the real `Store` on throwaway fixtures** — five fixture programs, not reasoning — and are marked ⚙ MEASURED. Owner priority applied: is the DESIGN sound so that later FLOW changes are sound.*

---

## Headline

**The mechanism works. I ran the review-7 B1 fixture end-to-end against the real store under defer-record and it is clean at every point — status never collapses, `current()` never orphans, `check()` is silent because there is nothing to say, and the gate-sequence invariant is satisfied at commit for free.** That is the first time in eight passes that the load-bearing mechanism has survived measurement. §0, §1's layer model, the ownership table, §5, §6's chain schema and §7 are in good shape and I would lock them today.

**What defer-record did not do is pay its own bill.** Moving `artifact-locked` from execute to commit moves the *acceptance boundary* — and three other things were standing on the old boundary and fell over when it moved:

1. **`propose-spawn` is now refused for the entire execute phase** (⚙ measured, two independent refusals) — which breaks the shipped Flow 1, whose `spec` step spawns build tasks that name the spec as a `requiredInput`. §3 rule 2 sees the problem and prescribes a remedy that does not exist.
2. **The confirm gate no longer decides on an identified artifact.** Before defer-record, `artifact-locked{lockSha}` was in the log *before* gate②, so the human's `confirmed` provably referred to a sha. Now the file is unhashed working state at decision time and the sha is computed at commit. Nothing binds what was confirmed to what is recorded.
3. **`ctx.feedback` does not discriminate a crash during a rework cycle** (⚙ measured) — the tail state after a rejection is *stable*, so every resume looks like a fresh rework: the human is re-interviewed, every LLM call re-fires, and none of it is capped by the 3-reject bound. v8 also **deleted v7's definition of `runId`** and put nothing in its place, leaving the transcript's primary key undefined.

Beyond that: the confirm-bound deadlock check v8 added is **not statically decidable** from the step contract v8 declares; verify's failure behaviour is still stated as "X *or* Y"; and the design deviates from a locked timing rule — **`journey-format-spec-v13:90`, "`artifact-locked` is written the moment the artifact locks"** — which is *not* in the v14 amendment list.

**Verdict: LOCK AFTER the nine edits in §Q6.** None of them reopens the architecture and none requires exploring a design space. Three touch §2/§3 contract text, so v9 needs a short confirmation pass on those sections — not a ninth full review.

---

## Q1 — The mechanism, measured

### Q1-a. Defer-record, end-to-end on the review-7 B1 fixture ⚙ **SOUND**

Real `Store`, real `appendEvent`, one leg, one task. Sequence: spawn → activate → submit/confirm grill → *execute writes the file, no event* → submit confirm → **reject** → *rework re-writes the file, no supersede, no event* → submit confirm → confirm → commit records `artifact-locked` then `completed`.

```
spawned                             status=queued     current(vision)=null
activated                           status=active     current(vision)=null
submitted(grill)                    status=blocked    current(vision)=null
confirmed(grill)                    status=active     current(vision)=null
execute r1 (file written, no event) status=active     current(vision)=null   file=true
submitted(confirm)                  status=blocked    current(vision)=null
rejected(confirm)                   status=active     current(vision)=null
rework r2 (file re-written)         status=active     current(vision)=null
submitted(confirm) r2               status=blocked    current(vision)=null
confirmed(confirm) r2               status=active     current(vision)=null
COMMIT: artifact-locked recorded    status=active     current(vision)="07-leg/01-task"
COMMIT: completed                   status=done       current(vision)="07-leg/01-task"

gateProblems: []      check(): []      contractProblems({requiredInputs:['vision']}): []
```

Point by point against review-7's three measured failures:

- **The task never dies.** Status walks `queued → active → blocked → active → … → done`. No `superseded` is written, so `store.ts:171-173` never fires and `journey-format-spec-v13:78` (*"only a non-completed node derives `superseded`"*) is never engaged. `frontmostReady` (`kernel.ts:116-125`, filtering `['queued','active']`) keeps proposing the task through the whole rework cycle. Review-7 N1's second failure is gone.
- **The artifact is never orphaned.** `current('vision')` is `undefined` for the entire working period and becomes the producer exactly once, at commit. `store.ts:207-212`'s per-(producer, name) supersession is never exercised, so review-7 N1's first failure cannot arise. Review-7 N1's third failure (`check()` silent on the orphan) is moot — there is no orphan.
- **`gate!` never double-locks.** `cmdLock`'s `current(name)` refusal (`cli.ts:773-776`) — review-3's chain-length defect — cannot fire, because the name is not current until the one lock that ever happens.
- **The gate-sequence invariant is satisfied at commit, and defer-record makes it *easier*, not harder.** ⚙ `store.ts:571-583` computes `firstWork` as the first `artifact-locked`-or-`completed`; deferring the lock to commit guarantees `firstWork` lands *after* every `confirmed(gate=grill)`, so GATE-1 is trivially satisfied even when a confirm rejection escalates back into the grill loop and writes a second grill confirmation. GATE-2 (`:578`) needs `confirmed(gate=confirm)` before `completed` — commit follows gate②. Measured `gateProblems: []`.
- **The store refuses the writes it is supposed to refuse.** ⚙ `submitted(gate=confirm)` with no confirmed grill → `GATE-SEQ GAP`; `artifact-locked` with no confirmed grill → `GATE-1 GAP`. **`evidence` pre-gate is accepted** — which is what makes a grill-bound step's transcript legal, and is correct: the gate-sequence invariant polices `artifact-locked`/`completed` only. §1:46 states it exactly that way.
- **Crash-resume across the gate is coherent.** Crash after `confirmed(confirm)`, before commit: tail state 1 (`confirmed` → skip the gate), execute re-runs from the transcript and rebuilds the frame's in-memory deferred-lock list, commit records. The reason `execute` is NEVER SKIPPED (§1:59) is exactly that the deferred list is in-memory and must be rebuilt — that is a real, non-obvious consequence and the design has it right.

**This is the strongest result in the series. The mechanism decision review-7 sent v7 back for is answered and it measures correct.**

### Q1-b. `check()`'s MISSING test, event→file vs file→event ⚙

`store.ts:659` checks one direction only: a recorded lock whose file is absent.

```
event with no file  → check(): ["MISSING: ghost → journey/legs/07-leg/05-missing/artifacts/ghost.md"]
file with no event  → check(): []      (nothing, by construction)
```

Under defer-record the file is written *before* the event, so the MISSING test cannot fire on the happy path. That is fine. What is new is that **the reverse direction is now the common transient state and `check()` is blind to it by design** — `journey-format-spec-v13:99` defines resolution verification as *"file exists at the derived path · an `artifact-locked` event matches that exact path+name · no later `superseded`"*, i.e. event-anchored. Working files are outside the integrity model entirely. See **P4**.

### Q1-c. The F-AC18 conclusion rule and commit ordering ⚙

F-AC18 (`store.ts:631-639`) requires a `completed` task to carry an `artifact-locked` **or** non-empty `evidence.commits[]`. It scans the whole log, so it is order-insensitive; measured clean. ⚙ I also confirmed `artifact-locked` appended *after* `completed` is accepted and status stays `done` — so §4's stated order (locks, then `completed`) is a **convention with no enforcer**. Harmless today; worth one word in the ownership table rather than a rule.

### Q1-d. `read.resolve` during a task's own execution ⚙ **BROKEN AS SPECIFIED**

```
file exists on disk:                    true
current("vision") during execute:       undefined   → read.resolve returns NOTHING
```

§5:161 binds `read.resolve` to *"the chain entry's inputs ∪ requiredInputs"*. But a chain entry's `inputs` **source** may be an earlier step id in the same task (§6:168, and the shipped sample `inputs:{vision:'envision'}` at §6:184). Those artifacts are not locked until commit, so `read.resolve` cannot serve them. The stated bound therefore includes a set the accessor cannot resolve — silently, returning `undefined`. `ctx.prior` is the right channel and the design knows it (§2:70), but §5 never says the bound splits. See **P8**.

### Q1-e. The transcript — schema legality, determinism, NFR-CST-1

**Schema legality ⚙ — the amendment is genuinely required, and v8 records it.**

```
trace:{stepId,runId,seq,kind,prompt,completion}   REFUSED — unknown field(s) 'trace' on evidence
flat {stepId,runId,seq}                           REFUSED — unknown field(s) 'stepId, runId, seq'
answers:[{id,answer}]                             ACCEPTED
answers:[{id,answer,provenance}]                  ACCEPTED
answers entry with an OBJECT answer               REFUSED — evidence.answers must be [{id, answer, provenance?}, …]
```

`store.ts:478` allows `at·type·note·commits·refs·answers`; `journey-format-spec-v13:77` locks it — *"Missing or unknown fields are **rejected** (strict schema — a fresh engine fails loudly, never silently)."* v8 §2:85 / §8:214 record the v14 §3 amendment. **Correct, and the most important of review-7's edits.**

**But the record's declared shape cannot hold one of its four kinds.** §2:76 declares `{stepId, runId, seq, kind: 'llm'|'ask'|'research'|'decide', prompt?, completion?, question?, answer?}` — all scalars. `Interactor.collectResearch` (`interact.ts:21`) takes `topics: string[]` and returns `Array<{topic, findings, sources?}>`. That does not fit `question?: string` / `answer?: string` without JSON-stuffing, and `sources[]` is load-bearing: `session.ts:143` pushes findings into the grilling context with `sourceType: 'web source'`, which the honesty layer uses. Lose it on replay and the artifact differs. Also note `present` is deliberately absent from `kind` (it returns `void`) — correct, but unstated.

**Determinism — sound in kind, and it fixes review-7 N3.** `session.ts:100-159` is driven entirely by `engine.grill()` (LLM) and the four interact verbs; I found no other nondeterminism (no clock, no randomness, no file reads). Replaying the LLM completions makes `g.artifact.questions` identical, which makes the `askQuestion` question texts identical, which makes replay-by-question-identity well-founded. Review-7's positional-drift failure is genuinely closed *because* the llm half is now recorded. Good.

**NFR-CST-1 — the claim is true in one cell and false in another.** §4:135 asserts *"REPLAY SERVES LLM + INTERACT FROM THE TRANSCRIPT (zero model calls — NFR-CST-1 met)"*. True for crash-resume of a first attempt. False for crash-resume of a rework attempt — see **P3**, measured.

**Two unstated rules the transcript needs to be implementable:**
- **The miss policy.** A step that crashed mid-execute has a *partial* transcript. On resume, replay serves the prefix and then misses. The design never says what a miss does. It must be "fall through to a live call and append to the same runId" — otherwise a first attempt (empty transcript, feedback absent = "replay") could not run at all. That the first-attempt case works *only because* of an unstated fallback is a hole, not a convenience.
- **`runId` allocation.** v7 §2:78 defined it: *"runId = the rejection count at the step's bound gate, derivable and monotonic."* **v8 deleted the definition and kept the key.** §2:79-80 uses `runId` for dedup and says rework "advances" it, but nothing says who allocates it or from what. Worse, v7's own definition is the one that breaks: the rejection count does not change *during* a rework pass, so a fresh rework would write records at keys already occupied by the stranded partial pass, and the stated dedup on `(stepId, runId, seq)` would **silently drop the new records and keep the stale ones**. See **P3**.

### Q1-f. `ctx.feedback` as the discriminator ⚙ **DOES NOT DISCRIMINATE**

```
tail after rejection:        submitted → rejected     status=active
 → frame reads: last-at-gate rejected ⇒ REWORK ⇒ ctx.feedback PRESENT ⇒ fresh run
...CRASH mid-rework...
tail is now:                 rejected → evidence      status=active
 → frame reads the SAME tail state ⇒ ctx.feedback PRESENT AGAIN ⇒ FRESH RUN AGAIN
trace records present for run2: [{"id":"s#1#0",…},{"id":"s#2#0",…}]   ← run-2 records stranded
```

The `rejected` event is the last gate event whether or not a rework pass has started, so **`ctx.feedback` is a property of the *attempt kind*, not of *whether this attempt has already run*.** Those are orthogonal axes and v8 collapses them into one flag:

| | transcript for this attempt: absent | transcript for this attempt: present |
|---|---|---|
| **first attempt** (no `rejected` in tail) | feedback absent → "replay" → empty → falls through to live calls ✔ *(only via the unstated miss policy)* | feedback absent → replay ✔ |
| **rework attempt** (`rejected` in tail) | feedback present → fresh ✔ | feedback present → **fresh again** ✘ — partial transcript stranded, human re-interviewed, every LLM call re-fires |

The bottom-right cell is the crash-during-rework case the owner asked about. Its consequences are concrete: the human is re-interviewed at a gate the design promises never to re-interview at; and because the 3-reject bound counts `rejected` events (`kernel.ts:207-209`), **crash-resumes are unbounded** — a crash loop re-fires the whole chain's model calls without limit, against `requirements-spec-v3:65` (NFR-CST-1, *"bounded model calls per step … 10× = cost explosion. KEEP."*) and against §7:197's own *"no unbounded loops"*.

---

## Q2 — Review-7's 13 blocking edits + 5 completeness items

**8 of 13 blockers clean · 3 clean-with-a-new-consequence · 2 half-applied. 3 of 5 completeness clean · 1 half · 1 not done (fourth ask).**

| # | Edit | Verdict |
|---|---|---|
| 1 | replace `self-supersede-then-lock` | **APPLIED — MEASURED SOUND** ⚙ (new consequences: **P1, P2, P4**) |
| 2 | trace schema-legal home + v13 §3 amendment | **APPLIED, CORRECT** ⚙ (shape short for `research`; **§4:90 amendment missing — Q5-1**) |
| 3 | gate-bound step at a decided gate | **APPLIED IN KIND, SOUND** (`runId` undefined + miss policy unstated — **P3**) |
| 4 | verify-failure named + confirm-bound deadlock check | **HALF APPLIED — P5, P6** |
| 5 | bidirectional role check | **APPLIED, CORRECT** ✓ |
| 6 | spawned-task immutability limit | **APPLIED, CORRECT** ✓ (mis-cited: `v13:53` → `:43`) |
| 7 | new steps are code | **APPLIED** ✓ (collides with `requirements-spec-v3:33` — **P7**) |
| 8 | ladder row + listed migration | **APPLIED, CORRECT** ⚙ |
| 9 | define "multi-client" | **APPLIED, CORRECT** ✓ (initiator list imprecise vs `:59`) |
| 10 | `gate!` composite predicate | **APPLIED, CORRECT** ⚙ |
| 11 | `architecture-v2:63` | **APPLIED** ✓ (list still incomplete — **Q5-2**) |
| 12 | `resource-registry-v2:63` reconciliation | **APPLIED, CORRECT** ✓ |
| 13 | resolve §8:233 vs §2:94 | **APPLIED** ✓ (phrasing sloppy) |
| 14 | frame-write idempotence | **APPLIED** ✓ |
| 15 | NFR-CST-1 / execute re-entry | **APPLIED, BUT ONE CELL OF THE CLAIM IS FALSE** ⚙ — **P3** |
| 16 | node-level `superseded` surface + three meanings | **HALF APPLIED** ⚙ — **P11** |
| 17 | `read.resolve` / packet excerpts | **APPLIED, CORRECT** ✓ (bound now overlaps an unresolvable set — **P8**) |
| 18 | sweep the cosmetics | **NOT DONE — fourth ask** ⚙ |

### The ones that landed clean, with the evidence

- **Edit 5 (bidirectional roles).** §2:77 now requires *"every bound role is declared AND every REQUIRED role is bound"*, with required/optional markers on `roles[]` (§2:64). This is statically decidable from the declared shape — unlike the check in edit 4 (see **P5**). Correct.
- **Edit 8 (ladder row).** ⚙ `.ann/rules/decide/rules.json` today holds five rungs (`derive · probe · infer · ask · block`) as `{step, note}` objects with **no `enabled` field**. §1:57's *"gains `enabled` flags"* is correctly future-tense, and the row now reads *"enablement is data once a rung exists; v1 builds only `block`"* — the third rewrite and the first correct one. §8:216 lists the migration. Both halves of review-7 N8 done.
- **Edit 10 (`gate!` composite).** ⚙ I replicated both predicates. `cli.ts:752` looks only for a later `confirmed`; `store.ts:181` looks for `confirmed` **or** `rejected`. Measured after a confirm rejection: `cli` sees 1 pending submission and **skips** the new `submitted`; the store derives `pendingGate: false`, status `active`. So round 2 never enters `blocked` — exactly what review-7 measured. §4:112 specifies the fixed predicate (*"the predicate checks for a later `confirmed` **OR `rejected`**"*). Correct.
- **Edit 9 (multi-client).** §1:30-34 now says *"multiple IN-PROCESS initiators"* and names the in-memory event cache as the reason v1 is one writer process. `ann-system-design-v3:59` licenses multiple initiators (*"Initiators: planner kernel …, adapters …, validators/reviewer"*) and `:59`'s own *"no cross-process cache in v1"* backs the caveat. **Imprecision:** v8 says `:59` licenses *"the CLI, the flow, the validators"* — `:59`'s list is *"planner kernel, adapters, validators/reviewer"*. The CLI is not on it. Substantively fine, factually loose.
- **Edits 11, 12, 13, 14, 17.** All present and correct against the sources. §5:161 now states the packet's bounded excerpts accurately against `context-packet-spec:41` (*"bounded head of the artifact"*) and `:65` (*"a **bounded excerpt**"*), and drops the false "one mechanism" claim about `prior` — review-7 N14 fully answered.

### Edit 4 — **HALF APPLIED.** Both halves.

§3 rule 8: *"a chain whose ONLY artifact-producing step is confirm-bound is rejected at validation … Verify's failure behaviour is NAMED: verify fails → the task goes back to the failing phase (execute, with the finding as feedback) **or** fails closed."*

- **The static check cannot be built from the declared contract.** §2:64 declares `step = { id, roles[], rules[], decisions?[], paramsSchema?, execute(ctx) }`. There is **no declared output or intent set** — `intents?[]` is a *runtime* field of `out` (§2:71). `src/kernel/step.ts:64-72` confirms the same shape today (`id · inputs[] · rules[] · execute`). "Artifact-producing" is therefore not a static property. The same gap hits §1:56, which claims *"intent ordering … statically validated before execution"*. See **P5**.
- **"or" is not a name.** Review-7 edit 4 asked what the frame *does*. v8 offers two options and picks neither. And the option it lists first — *"back to execute, with the finding as feedback"* — introduces a loop that **writes no event and is bounded by nothing** (the 3-reject bound counts `rejected` at gates), and produces a `feedback` with no gate, against §2:70's declared shape `feedback? {gate, text} — SCOPED BY GATE`. See **P6**.

### Edit 16 — **HALF APPLIED**, and the sentence contradicts itself.

§3:95: *"the event carries **THREE meanings** (artifact replaced · node replaced · — NOT rework; rework is the defer-record path, §2)"*. It says three and enumerates two. The *content* is right and is an improvement — defer-record genuinely eliminated the third meaning. The *sentence* is wrong.

The surface half was not done. ⚙ A bare `superseded` carrying only a note is accepted by `appendEvent` (`store.ts:513` validates `successor` only when present) and derives status `superseded`. But `supersede!`'s signature is `{name, path}` (`cli.ts:793-796`) — artifact-shaped — and §1:50 has `append!` refuse composite-owned kinds. **No L1 surface can produce a node-level `superseded`.** Review-7 measured 14 such events already in the repo. Unchanged.

### Edit 18 — **NOT DONE, fourth ask** ⚙

`.ann/docs/system-designs/ann-system-design-v3.md:7` still reads `# Ann System Design (v2)`. `functional-spec.md:44` still cites `AC-8/RPO` (requirements-spec-v3 stops at AC-7). `requirements-spec-v3.md:43` still cites `F-AC8` (which lives in `tree-format-spec.md`). v8 does not mention the sweep at all — the word "cosmetic" does not appear in the document.

---

## Q3 — NEW soundness holes

### P1 (blocking) — `propose-spawn` is refused for the whole execute phase, and it breaks the shipped Flow 1 ⚙

```
file exists on disk:                   true
current("vision") during execute:      undefined
contractProblems(child requiring 'vision'):
  ["requiredInput 'vision' does not resolve via current() (use the artifact's logical name)"]
```

Two independent refusals, both consequences of moving the lock event to commit:

1. **F-AC19.** §1:49 makes `spawn!` enforce F-AC19 as a hard reject. `store.ts:257` resolves `requiredInputs` through `current()`. During execute the parent's artifact is not current. Every child naming it is unspawnable. ⚙ And it does not merely fail at spawn: I forced the spawn through `store.spawn` (which does not itself run F-AC19) and `check()` then reports the node as a standing integrity problem — `F-AC19: 07-leg/02-child — requiredInput 'vision' does not resolve`.
2. **The artifact gate.** `store.parentConcluded` (`store.ts:321`) requires an `artifact-locked` event or `evidence.commits[]`. `cli.ts:704` and `kernel.ts:194` gate on it for task parents. A document-producing parent is not "concluded" until commit.

**This is not an edge case — it is the shipped default flow.** §6:190: *"`spec` (role `vision` ← envision; chain effect declares build-task spawns via `propose-spawn`)"*. Build tasks that do not name the spec in `requiredInputs` are not self-sufficient, which is what F-AC19 exists to prevent.

§3 rule 2 sees the collision and prescribes: *"a chain that spawns tasks referencing its own not-yet-committed artifacts must bind them through `prior`/the chain, not `requiredInputs`."* **That remedy does not exist.** A spawned child is a different task executed later; it has no access to the parent's in-memory `ctx.prior`, and a chain entry's role source resolves either to an earlier step *in the same chain run* or to a packet dep — and packet deps come from `contract.requiredInputs` (`context.ts:94`). There is no third channel.

The fix is one sentence and it is a natural extension of the mechanism already chosen: **`propose-spawn` defers to commit alongside `lock-artifact`.** Commit is the acceptance boundary; `created`-as-spawn-record is an acceptance-shaped write exactly as `artifact-locked` is. v8 defers one of the two and not the other, with no stated reason. Deferring both also makes §3 rule 2 (lock-before-spawn) satisfied by construction rather than by an ordering check, and ⚙ I verified the child's contract resolves clean once the parent has committed (`contractProblems: []`).

### P2 (blocking) — the confirm gate no longer decides on an identified artifact

Under the pre-v8 model, `artifact-locked{name, path, lockSha}` was written during execute (`journey-format-spec-v13:90`), so `confirmed(gate=confirm)` provably referred to a specific blob sha — `v13:74`, *"`lockSha` remains the blob sha of the file content (doc integrity)"*. Defer-record reverses the order: at gate② the artifact is unhashed working state; the sha is computed at commit *from the file*, whatever the file then contains.

Three ways the confirmed content and the committed content diverge, none of which anything detects:

- **Replay drift.** If a step's transcript is incomplete (the LLM call succeeded, the record append did not), resume replays the prefix, misses, calls live, gets a different completion and re-writes the file — **after** the human already confirmed. The human confirmed X; the log records Y.
- **Concurrent clobber.** ⚙ Two live tasks can hold deferred working state at the same logical name; `current()` is `undefined` for both, and nothing refuses either write. This is reachable with the shipped `frontmostReady` rule (`kernel.ts:116-125`), which skips a task `blocked` at gate② and proposes the next one. If both materialize the same shared path (§3 rule 7 writes `docs/<category>/<name>-v<N>.md` immediately), the second clobbers the first and the first's commit records the second's bytes. One-current-per-name fires only at `lock!` — i.e. at commit, after the damage.
- **Anything else that touches the file** between gate② and commit.

⚙ There is also no schema-legal machine-truth place to put the confirmed sha today: `submitted`/`confirmed` allow only `at·type·note·gate` (`store.ts:483-484`); `evidence.commits[{sha}]` is accepted but `check()` then reports *"commit 0f1e2d3 does not resolve in git (traceability, format v10 §9)"*; `refs[]` carries no sha; `note` is prose, which §7:201 forbids as truth. The only slot that works is `evidence.answers[{id, answer}]` — a repurposed answer field.

v8 is already amending `v13 §3` for the trace. **Extend that amendment to carry the submitted artifact's sha, and make commit refuse when the computed sha differs from the confirmed one.** Otherwise the design has traded a measured bug (B1) for a silent one.

### P3 (blocking) — `ctx.feedback` does not discriminate a crash during rework; `runId` is undefined ⚙

Measured and tabulated in **Q1-f**. Two edits, both one sentence:

- **Split the axes.** Replay-vs-fresh is keyed on *transcript presence for the current attempt*; `ctx.feedback` carries the rejection text and marks the attempt as rework. Both are derivable from the tail: an attempt is *new* when no trace record post-dates the latest `rejected` event at the bound gate. State that, and the bottom-right cell behaves.
- **Define `runId`.** v7 had a definition (rejection count at the bound gate) and v8 deleted it; that definition is also the one that causes dedup to keep stale records over fresh ones. Whatever it becomes, it must be derivable from the tail — the frame holds no memory across a crash — and it must advance on a *new attempt*, not on *rework*.

State the replay **miss policy** in the same breath: a miss falls through to a live call and appends at the next `seq` under the same `runId`. Without it, the first-attempt path works only by accident.

### P4 (blocking, small) — working files are unpoliced state in a shared, human-read directory ⚙

§3 rule 7 materializes shared-type artifacts to `docs/<category>/<name>-v<N>.md` **immediately at execute**, plus the `artifacts/<name>.md` symlink. Consequences, measured:

- ⚙ **A failed task leaves an orphan and `check()` says nothing.** Three rejects → escalate → `failed`; the working file is on disk, zero `artifact-locked` events, `check()` returns nothing about it. For a task-local file that is litter. For a shared type it means an unaccepted `journey-format-spec-v14.md` sitting in `.ann/docs/specs/` beside the real locked stack — against `journey-format-spec-v13:223`, *"`docs/` … holds **only the SHARED contract stack**"*, and `:88`, *"`docs/` … written when a shared artifact is produced"*. `ann specs` is event-derived (`cli.ts:271-291` filters on `store.current(l.name)?.producer === id`) so the CLI is not fooled — but AGENTS.md points humans and agents at `.ann/docs/specs/` directly, and they will be.
- **Version numbers drift or collide.** §3 rule 7 says *"`N` computed by the flow"* and never says from what. From the event log → a failed task's orphan file gets silently overwritten by the next attempt. From disk → orphans permanently consume version numbers.
- **Concurrent same-name clobbering** (see **P2**).

All three dissolve with one edit: **the working file is task-local only; the `docs/` placement, the symlink, and `N` all happen at commit, with the event.** That keeps "files are working state" intact where it needs to be, keeps the shared contract stack accepted-only, makes `N` computable once from the log, and confines a failed task's litter to its own `artifacts/` directory. It costs nothing the mechanism needs.

### P5 (blocking, small) — three of the design's checks require a declaration the step contract does not have

§3 rule 8 promises the confirm-bound deadlock is *"rejected at validation"* (static). §1:56 claims *"intent ordering … statically validated before execution"*. §4:138 has verify check *"outputs produced"*. All three need to know what a step produces. §2:64's step declares `{id, roles[], rules[], decisions?[], paramsSchema?, execute}` — nothing about outputs; `intents?[]` is a runtime field of `out`. `src/kernel/step.ts:64-72` is the same shape today.

Either add a declared `produces?[]` / `intents?[]` to the step contract (symmetric with `roles[]`, and it makes the check decidable exactly the way the bidirectional role check is), or downgrade rule 8 and §1:56 to runtime checks and say so. **The current text promises a check that cannot be built.** This matters for the owner's priority specifically: the deadlock is reachable by editing chain data only (move the artifact producer to `at:'confirm'`), which is the class of change the design exists to make safe.

### P6 (blocking, small) — verify's failure behaviour is still an "or", and one branch is an unbounded gate-less loop

See **Q2 edit 4**. Pick one. If it is "back to execute with the finding as feedback", then say what bounds it and what event records the cycle — `store.ts` has no event for a verify failure, `kernel.ts:207-209` counts only `rejected` at gates, and §2:70's `feedback {gate, text}` has no gate to carry.

### P7 (blocking, small) — the flow registry's own data format changes, and it is the one migration not listed

§8:216 lists two data migrations with care: `vocab.json` (`artifactTypes` → category + versioned) and `rules/decide/rules.json` (`enabled` flags). ⚙ Today `.ann/rules/flow/default.json` holds `chains: {default: ["validate","envision","spec"], implementation: []}` — a map of **flat string arrays**, and `flow.ts:64` asserts `seq.every(s => typeof s === 'string')`. §6:167-171 redefines a chain entry as `{id, inputs?, params?, at?, verdict?}` and §6:184-187's sample is an array of objects. **That is a larger migration than either listed one, of the registry the whole design is about, and §8 does not list it.** The `chains.default` sample also renames `validate` → `idea-validate`, which is a second data change in the same file.

### P8 (completeness) — `read.resolve`'s stated bound includes sources it cannot serve

See **Q1-d**. One clause: the bound is `requiredInputs` (cross-task, committed) — same-task chain sources resolve through `prior` only.

### P9 (completeness) — §4's phase placement regressed from v7

v7 §4 read: *"grill-bound first **(at the grill phase)**, then at:'execute' entries in list order, then confirm-bound **(at the confirm phase — the locked lifecycle places GATE② AFTER verify)**. **validateChain's "earlier" = EXECUTION ORDER.**"* v8 §4:128-130 dropped both parentheticals and the `validateChain` sentence, leaving *"execute — run the chain in EXECUTION ORDER: grill-bound first, then at:'execute' in list order, then confirm-bound"*.

As written, all three appear to run inside the `execute` phase — which is impossible for the grill-bound step, since the frame's own order is `materialize → GATE·grill → validate → activate → execute` and that step *produces the grill decision*. This is the fix review-4 N14 and review-5 N10 were about; v8 loosened it back. It also leaves unanswered whether the grill-bound step runs before `validate` (it must), and how §1:59's *"last-at-gate `confirmed` → skip"* squares with §3 rule 4's *"the step re-runs from the transcript"* — skip the gate **write**, re-run the step. Restore v7's wording plus that clause.

### P10 (blocking, small) — which steps receive `ctx.feedback` on a rework is unstated, and both readings are wrong

§2:70 says `feedback? {gate, text} — SCOPED BY GATE`. §4:141-143 says a confirm rejection means *"RE-EXECUTE from feedback"*. Nothing says which steps in the chain see it, and the two natural readings both fail:

- **Only steps bound at the rejecting gate get it.** Then in the shipped chain `[idea-validate@grill, envision, spec]` — where `envision` and `spec` are at `execute` — a confirm rejection delivers feedback to nobody. Every step replays from the transcript, produces byte-identical output, and gate② is re-presented with the artifact that was just rejected. Bounded at 3, then escalate. **Rework changes nothing.** (This is review-6's B1 scenario returning through a different door.)
- **Every step gets it.** Then `idea-validate` — grill-bound, at a gate that is still `confirmed` — runs fresh and **re-interviews the human**, which §2:76 and §3 rule 4 both promise never happens.

The rule that works: **feedback reaches steps at or after the rejecting gate's position in execution order; steps bound at earlier, still-confirmed gates replay.** One sentence, and it is load-bearing.

`flow-control-spec-v6:37` (*"GATE② reject → **re-execute** (rework output from artifacts + feedback)"*) settles the phase, not the per-step routing — the design must.

### P11 (completeness) — "THREE meanings" enumerates two

See **Q2 edit 16**. And give node-level `superseded` a surface, or state that node-level supersession is not reachable in v1 and that `store.ts:171-173`'s status collapse is therefore dormant.

### P12 (completeness) — the transcript reverses the two-log split without a note

`src/adapters/provider/oplog.ts:4-8` states the position: the op-log holds *"the dynamic process — requests sent (provider/model), errors, timing, retries. **NOT project state, never in the tree.** The forest holds project state, not request noise."* It records `promptChars`, not text — so there is **no duplication** between the op-log and the transcript, which answers the owner's Q4 sub-question directly. But the transcript now writes full prompts and completions **into `events.jsonl`, which is the product**, deliberately reversing that split. v7 named the tension (*"the two-log trace survives at the ABILITY layer"*); v8 dropped the phrase entirely. Two consequences worth one clause each: the append-only journey now grows by every model call's text, and `requirements-spec-v3:62` (NFR-SEC-1, *"no secrets in the tree/artifacts/renders"*) now applies to prompt text that contains the whole packet plus the user's answers.

### P13 (completeness) — mis-citations ⚙

| v8 says | Actual |
|---|---|
| §3:105 — node.json immutable, `v13:53` | `journey-format-spec-v13:43` — *"**IMMUTABLE** — written once at spawn"*. `:53` is the work-type checklist item |
| §1:52 — `vocab.statuses` protected `(v13:57-61)` | `:57-61` enumerate **event types only**. The status vocabulary has no home in v13 §3; the only list is `vocab.json:23-30` |
| §2:86 / §8:214 — *"§14/§15 — the artifact filename rule"* | §14/§15 give the category layout (`:223-230`) and the symlink task-local ref (`:201`, `:74`). **No `-v<N>.md` filename rule exists anywhere in v13** — it appears only inside an event example at `:76`. The amendment *adds* the rule; the wording implies it amends one |
| §1:31 — `:59` licenses *"the CLI, the flow, the validators"* | `ann-system-design-v3:59` — *"Initiators: planner kernel …, adapters …, validators/reviewer"* |

### Answering the owner's question directly: what still forces a code change?

| change | data? | stated correctly in v8? |
|---|---|---|
| new work type (existing steps) | ✅ data | ✅ |
| new chain shape (linear, unspawned task) | ✅ data | ✅ |
| new gate source | ✅ data | ✅ |
| new verdict map / params | ✅ data | ✅ |
| new artifact type, existing category | ✅ data (after the vocab migration) | ✅ |
| new `docs/` category | ❌ v13 §15 amendment | ✅ |
| new event kind / status / gate | ❌ v13 amendment / protected | ✅ |
| new step *implementation* | ❌ code (implement + register) | ✅ (§6:176, seam cited) |
| new **journey** step (a task with an empty chain) | ✅ data (spawn) | ❌ **P7-adjacent** — see below |
| new role on an existing step | ❌ code | ✅ |
| new intent | ❌ code (translator) | ✅ |
| new ladder rung | ❌ code (rung unbuilt) | ✅ |
| chain edit needing a new packet dep on a spawned task | ❌ new task (`node.json` immutable) | ✅ |
| **chain entry gaining `at`/`inputs`/`verdict` structure** | ❌ **registry migration + loader change** | ❌ **P7** |
| **a chain whose only artifact producer is confirm-bound** | ✅ data — and it **deadlocks** | ~ check promised, **not buildable — P5** |

**One accuracy note on the "new step" row.** `requirements-spec-v3:33` (locked) says *"Every step is a predefined, separately-managed **node** … Adding/removing/reordering steps requires **no code change** — only project data"*, and `:32` describes *"the chain grows step by step: build, verify, ship, maintain — each new step appended as the work requires"*. That "step" is a **node**, and adding one is a spawn — data, satisfied by Flow 2's empty chain plus the runner. v8's "step" is a **code unit inside a task's chain**. Both statements are true; they use the same word for different things, and §6:176's flat *"New steps … = CODE"* reads as a contradiction of a locked requirement. Name the two senses once. This is exactly the sentence the owner's criterion turns on.

---

## Q4 — Simplicity: is this the smallest sound core?

**The shape is right and I would defend it unchanged, for the fourth review running.** Four layers, one write path, six mutators complete over the 14-kind vocabulary, five intents, steps as pure units, chains as data, the gate source *is* the chain, `read.resolve` as an L1 read, role-bound inputs. **Can a step still reach the store?** No — `ctx.store` and `recordEvidence` (`step.ts:43,49`) are gone from §2; `shell` is explicitly OS-process; `read` is an L1 view. The boundary is clean.

**Did the new mechanism introduce duplication? Mostly no — and one of the owner's three suspects is not real.**

- **trace vs op-log: NOT duplicates.** ⚙ `oplog.ts:10-20` records `promptChars`, latency, retries, error — metrics, never text. The transcript records text. Different records, different consumers. (The *architectural* tension is real — **P12** — but it is not duplication.)
- **trace vs the evidence intent: merged correctly.** The transcript rides on the same `evidence` event the ability hook already emits (`executor.ts:103-109`), gaining a structured field rather than a second event. Review-6/7's "two evidence paths" complaint is *reduced* by v8, not worsened: the dedup keys are now `commits[].sha`/`refs[]`/`answers[].id` for the intent and `(stepId, runId, seq)` for the hook, on one event kind, with the second key finally writable (after the amendment). The separating convention — *"steps do NOT duplicate in intents what their ability calls already emitted"* — still has no enforcer, but it is now one event type with two field families rather than two competing mechanisms.
- **Defer-record REMOVED weight.** It deletes the self-supersede path, deletes `superseded`'s third meaning, and makes GATE-1 satisfied by construction. Net simplification.

**Remaining weight, in order:**

1. **`ctx.feedback` carries two orthogonal axes** (**P3**). This is the one real conceptual over-load left, and splitting it is one sentence, not a mechanism.
2. **Two acceptance-shaped writes, one deferred** (**P1**). `artifact-locked` defers; `created`-via-`propose-spawn` does not. There is no principle behind the split — deferring both is simpler *and* correct.
3. **Two materialization moments claimed as one** (**P4**). The task-local file and the shared `docs/` file are written together at execute; they have different audiences and different acceptance semantics. Splitting them costs nothing and removes three problems.
4. **Contract self-sufficiency is still checked three times** — `spawn!` (§1:49), the `validate` phase (§4:124 → `kernel.ts:180`), `check()` (`store.ts:645-650`). Defensible, because project data mutates between spawn and execute; still never justified in one clause. Unchanged from reviews 6 and 7.
5. **Two gate-acquisition paths.** ⚙ A bare `confirmed` with no `submitted` is accepted by the store and derives `active`, not `blocked` — so the two-write sequence is an L1 convention inside `gate!`, not an L0 invariant. §4:112 makes `gate!` always produce both writes, which is the right answer; the ownership table has no row saying so.

Nothing here is speculative machinery. The core is small, and it got smaller this pass.

---

## Q5 — The line between adjustable and protected

**The table remains the strongest part of the document.** Spot-checks re-run and confirmed this pass: gate sequence refused by the writer (⚙ both GATE-SEQ and GATE-1 measured); single writer (every path ends at `appendEvent`); leg status derived (`store.ts:188-196`); reject bound owned by `gate!` (`cli.ts:754-758`) with L2 reading only `{escalated}` (`kernel.ts:211-215`); one-current-per-name at L1 (⚙ measured: `store.ts` does **not** enforce it — two lockers are accepted and `current()` silently last-wins, so §1:51's assignment to L1 `lock!` is exactly right); `store.ts` carries zero flow/work-type/step knowledge; unknown `workType` is a named refusal (`flow.ts:97-102`); chains cannot encode a loop (`flow.ts:139-144`). `vocab.eventTypes` protected by code literal (⚙ measured — the refusal names the *field*, not the vocabulary).

**Correctly adjustable, verified:** chains, work types, gate source, verdict maps, params, `contract.flow`, artifact types within a category.
**Correctly protected, verified against the locked text:** the 3-reject bound (`flow-control-spec-v6:39`), rework rungs (`:36-38`), the gate set (`:34` — *"Both gates are **HARD on every node in v1**"*), gate positions (`:17`), gate sequence, single writer, lifecycle order, event vocabulary (`journey-format-spec-v13:57-61`), status vocabulary (`vocab.json` — **not** v13, see **P13**).

**Rows that are wrong or missing:**

- **The L2 bundle row still over-claims its "How."** Nine things now share one row whose mechanism is *"conventions, statically validated before execution"*. **P5** shows two of them cannot be statically validated at all (intent ordering; the confirm-bound producer check). *Artifact placement/filename/recorded path* is a runtime materialization rule, not a validation. *Cross-task write permission* still has **no enforcer** — `cmdSupersede(id, name, path)` (`cli.ts:793-796`) writes `superseded` on any id — which v8 now states honestly (§1:56, *"convention-only … no enforcer exists"*). Splitting the row into "statically validated" and "runtime / convention-only" would make it true.
- **Still missing rows** (third ask): `params`/`paramsSchema` ownership — who owns the schema, what a mismatch does; `at:` values — a mixed namespace where `'grill'`/`'confirm'` come from `vocab.gates` and `'execute'` is a phase literal; the two-write gate-acquisition convention (Q4-5).
- **New rows the mechanism needs:** working-file lifecycle (who writes, when, who prunes, what `check()` sees — **P4**); the gate②-to-commit content binding (**P2**).

---

## Q6 — Are the amendments the COMPLETE set?

**No. One required amendment is entirely absent — and it is the one the whole mechanism deviates from. Two architecture lines are still missing. Everything else is right.**

Verified correct first, because most of it is:

- **journey-format v13 → v14, §2 and §3.** ✓ `openQuestions` top-level confirmed at `v13:33`; REQUIRED set at `:41`; the `trace` record on `evidence` genuinely requires the §3 amendment (⚙ measured refusal; `v13:77` locks strict rejection). The `store.spawn` (`store.ts:548-551`) and `context.ts:88-91` changes are owned (§2:84, §8:214/218) — review-7 N10 resolved.
- **architecture v2 → v3.** ✓ `:24`, `:27`, `:38-58`, `:60`, `:61`, `:63`, `:66`, `:71-80`, `:97` all verified verbatim. Review-7's `:63` gap is closed.
- **resource-registry v2 → v3.** ✓ `:36` enumerates `ask | check | decide | adapter | flow | binding | surface` — no `schema`; `:51-57` has no `vocab` row; both additions needed. The `:63` reconciliation (*"every consumed rule exists in a registry; no hardcoded rule outside it"*) is recorded — review-7 Q5-3 resolved.
- **flow-control v6 deferrals.** ✓ §7's four columns (`:80-89`) and §4's ladder (`:45-51`) recorded; the `activate` redefinition note against `:24` recorded.

**Missing / short:**

1. **`journey-format v13 §4:90` is not amended, and defer-record deviates from it.** The locked timing rule reads: *"**`artifact-locked` is written the moment the artifact locks** · appends happen at each lifecycle transition (activated, evidence, artifact-locked, completed, failed, superseded)."* §4's ownership table adds `:87` — *"`artifacts/` … written when produced; **immutable once recorded**"* — and `:88` — *"`docs/` … written when a shared artifact is produced."* Defer-record splits "produced" from "locked", rewrites the file on each rework pass, and moves the event to commit. That is a deliberate, defensible change to a locked timing rule; it is **not in v8's v14 amendment list**, which cites only §2, §3 and §14/§15. **This is the most serious gap of the pass** — the exact failure pattern reviews 5, 6 and 7 each caught once, now on the design's own headline mechanism. (Note `:70`, *"`completed` may be written **only after** `confirmed (gate=confirm)`"*, is **not** violated — commit follows gate②.)
2. **`architecture-v2:62` and `:65` are falsified and unlisted.** `:62` — *"**Reads:** any layer via the store's derived views (shared readers)."* Falsified: v8 routes reads through L1 (§1:23-24, §1:18 *"Reads L1"*, §1:16 *"never imported by L2/L1/L0"*). `:65` — *"**Adapters explained:** the provider adapter … GitHub + human-interface follow the same adapter pattern"* — falsified: the adapter tier dissolves into L3 abilities. (`:64`'s "Surface explained" is partially amended; its v2 product-form decision is not.)
3. **The `rules/flow/default.json` migration is not listed.** (**P7**)
4. **The trace record's declared shape cannot carry the `research` kind.** (Q1-e) The v14 §3 amendment must define the record precisely enough for all four kinds, including array-shaped returns and `sources[]`.
5. **The gate②-confirmed sha has no schema-legal home.** (**P2**) If the binding is added, it belongs in the same v14 §3 amendment.
6. **Cosmetics, fourth ask.** (Q2 edit 18)

**Regression check against reviews 1–7:** no numbered blocker from reviews 1–6 has regressed. Review-7's B1 and B8 are both genuinely resolved. **One wording regression:** §4's execution-order clause lost v7's phase parentheticals and the `validateChain`-earlier sentence (**P9**), and §2 lost v7's `runId` definition (**P3**). The item that has now survived seven passes — how `spec` *derives* which tasks to propose (review-2 Q6-5) — remains legitimately step-internal and covered by §6:174's deferral.

---

## Q7 — Lock verdict

# LOCK AFTER these nine edits — the mechanism is sound; the boundary it moved needs paying for.

I want to be precise about the difference from review 7. **That review sent v7 back because the central mechanism did not work against the store. This one does — I ran it.** Every finding below is a sentence, a row, or a list entry. None reopens §0, §1's layer model, the ownership table, §5, §6's chain schema or §7. Three of the nine (1, 3, 5) change §2/§3 contract text, so **v9 should get a short confirmation pass on those three sections only** — not a ninth full review.

### Blocking

1. **Defer `propose-spawn` to commit, alongside `lock-artifact`.** ⚙ During execute the parent's artifact is not `current()`, so `spawn!`'s F-AC19 (`store.ts:257`) and the artifact gate (`store.ts:321`, `cli.ts:704`, `kernel.ts:194`) both refuse every child that names it — which is the shipped Flow 1. §3 rule 2's stated remedy (bind through `prior`/the chain) does not exist for a spawned child. Deferring both acceptance-shaped writes to commit fixes it and makes rule 2 true by construction. *(P1)*
2. **Bind the gate② decision to the content it decided on.** Record the working artifact's blob sha at `submit!(confirm)` (extending the v14 §3 amendment — ⚙ no legal home exists today) and have commit refuse when the sha it computes differs. Without it, replay drift, a concurrent clobber, or any file touch between confirm and commit silently records content the human never saw. *(P2)*
3. **Split the replay discriminator from the rework flag, and define `runId`.** ⚙ Measured: the tail after a rejection is stable, so every crash-resume mid-rework re-runs fresh — re-interviewing the human and re-firing every LLM call, uncapped by the 3-reject bound (against NFR-CST-1, `requirements-spec-v3:65`, and §7:197). Replay-vs-fresh keys on transcript presence for the current attempt; `ctx.feedback` marks the attempt kind. Define `runId`'s allocation (v7 had a definition; v8 deleted it) and state the replay **miss** policy. *(P3)*
4. **State which steps receive `ctx.feedback` on a rework.** Both natural readings of "SCOPED BY GATE" fail: one makes rework change nothing, the other re-interviews the human at a confirmed gate. The rule that works — feedback reaches steps at or after the rejecting gate in execution order; earlier gate-bound steps replay. *(P10)*
5. **Make the confirm-bound deadlock check buildable, or downgrade it.** §2's step declares no outputs, so "artifact-producing" is not a static property; the same gap makes §1:56's *"intent ordering … statically validated"* false. Add a declared `produces?[]`/`intents?[]` to the step contract, or move rule 8 and that clause of §1:56 to runtime and say so. *(P5)*
6. **Name verify's failure behaviour — one branch, not "or".** If it is "back to execute with the finding as feedback", say what bounds the loop and what records it; today nothing does, and the feedback has no gate to fill `{gate, text}`. *(P6)*
7. **Materialize the shared `docs/` file at commit, not at execute.** ⚙ Today a failed task leaves an unaccepted spec in `.ann/docs/specs/` that `check()` never reports (against `v13:223`/`:88`), version numbering is undefined, and two live tasks can clobber the same shared path. Keep the working file task-local; place, symlink and number at commit. One edit, three problems. *(P4)*
8. **Amend `journey-format v13 §4`** — `:90` (*"`artifact-locked` is written the moment the artifact locks"*) and the `:87`/`:88` write-timing rows. Defer-record deviates from all three, and §8's v14 list cites only §2/§3/§14/§15. *(Q5-1)*
9. **List the `rules/flow/default.json` migration in §8** — `chains: {workType → string[]}` becomes `{workType → entry[]}` with `at`/`inputs`/`params`/`verdict`, and `flow.ts:64`'s loader assertion changes; the sample also renames `validate` → `idea-validate`. It is the largest of the three migrations and the only unlisted one. *(P7)*

### Required for completeness

10. **Add `architecture-v2:62` and `:65`** (and `:64` partially) to the architecture v3 amendment. *(Q5-2)*
11. **Define the `trace` record's shape for all four kinds** in the v14 §3 amendment — `research` returns an array with `sources[]`, which the declared scalar fields cannot carry; `present` is deliberately unrecorded, which should be said. *(Q1-e)*
12. **Correct §5's `read.resolve` bound**: `requiredInputs` (cross-task, committed); same-task chain sources resolve through `prior` only. *(P8)*
13. **Restore §4's phase placement** — grill-bound at the grill phase, confirm-bound at the confirm phase, `validateChain`'s "earlier" = execution order — and add that a decided gate on resume skips the gate **write**, not the step. *(P9)*
14. **Fix §3:95** — it says "THREE meanings" and enumerates two. Either give node-level `superseded` an L1 surface (⚙ `supersede!`'s `{name, path}` is artifact-shaped; `append!` refuses the kind) or state that node-level supersession is unreachable in v1. *(P11)*
15. **Note the two-log reversal** — the transcript puts prompt/completion text into `events.jsonl`, which `oplog.ts:4-8` explicitly says project state is not for; and NFR-SEC-1 (`requirements-spec-v3:62`) now applies to that text. *(P12)*
16. **Name the two senses of "step"** in §6:176 — a journey step (a node; adding one is data, per the locked `requirements-spec-v3:33`) vs a chain step (a code unit). As written §6:176 reads as contradicting a locked requirement. *(Q3 table)*
17. **Fix the four mis-citations** — `v13:53` → `:43`; `vocab.statuses` is not at `v13:57-61`; §14/§15 do not contain a `-v<N>` filename rule (the amendment *adds* it); `ann-system-design-v3:59`'s initiator list. *(P13)*
18. **Add the missing ownership rows** — `params`/`paramsSchema`, the `at:` namespace, the two-write gate convention, the working-file lifecycle — and split the L2 bundle row into "statically validated" vs "runtime / convention-only". *(Q5)*
19. **Sweep the cosmetics, fourth time of asking** — `ann-system-design-v3.md:7`'s `(v2)` title, `functional-spec:44`'s `AC-8/RPO`, `requirements-spec-v3:43`'s `F-AC8`. *(Q2 edit 18)*

---

## What I am not sure of

- **Whether edit 1 (deferring `propose-spawn`) has a downside I have not seen.** The refusals are measured and certain; the fix is the obvious symmetric one and I verified the child's contract resolves clean post-commit. What I did not test is whether any flow *needs* a child spawned mid-execute — e.g. a step that spawns and then consumes the child's result in the same run. Nothing in the shipped flows does, and §6:175's linear-unconditional limit argues against it, but I did not exhaust it.
- **Whether P2 is reachable in practice as often as I imply.** The concurrent-clobber path is certain in mechanism (⚙ measured that nothing refuses it) and reachable via `frontmostReady` skipping a blocked task — but I did not construct a full two-task run through the frame, which does not exist yet. The replay-drift path depends on the miss policy, which is unstated, so I am reasoning about a gap rather than a behaviour. The *general* point — that gate② no longer decides on an identified sha, where before it did — is certain and independent of both paths.
- **Whether edit 5 should add `produces?[]` or downgrade the check.** I am confident the current text promises something unbuildable. I am not confident which resolution the owner wants: a declaration makes chains more statically checkable (which serves the "flows are data" priority) but adds a field steps must keep in sync with their `execute` body, which is a new way for data and code to drift. That is a judgment call and I do not think a reviewer should make it.
- **How much of P4 the owner considers a problem.** The measurements are certain (orphan invisible to `check()`, no version rule, no collision guard). Whether an unaccepted draft in `.ann/docs/specs/` is *harmful* depends on how the owner reads that directory, and `ann specs` is correctly event-derived. I rate it blocking because the design's own locked text (`v13:223`) says `docs/` holds only the shared contract stack.
- **Whether v7's `runId` definition can be repaired rather than replaced.** I showed the rejection-count definition collides with the stranded-partial-pass case under the stated dedup rule. I did not search for a repair that keeps it.
- **I did not run the flow end-to-end.** No provider is configured, and L2 as designed does not exist yet. Everything above is contract reading, code reading, **five fixture programs executed against the real `Store`**, and the 169-test suite, which I ran and which passes.
