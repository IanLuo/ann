# Design Review v9 — the CONFIRMATION PASS review-8 prescribed

*Scope as prescribed: the three mechanism edits that changed §2/§3 contract text (review-8 edits 1, 3, 5), the gate② sha binding (edit 2), the six smaller blocking edits, the completeness set, and NEW holes in the mechanism text. The architecture — §0, §1's layer model, §5, §6's chain schema, §7 — is not re-litigated.*

*Evidence base: `core-design-v9.md` read in full; `design-review-v8.md` read in full; `src/store/store.ts` read in full; `src/cli.ts` (spawn/gate/lock/supersede surface), `src/kernel/kernel.ts`, `src/kernel/step.ts`, `src/kernel/flow.ts`, `src/kernel/executor.ts`, `src/kernel/interact.ts`, `src/engines/shared.ts` read at the cited lines; the locked contracts (journey-format v13, flow-control v6, requirements-spec v3, context-packet-spec, architecture v2, ann-system-design v3, resource-registry v2) and the three registry data files quoted line-by-line. **169 tests pass** (`npx vitest run`, 10 files, 824 ms). Unlike review-8 I ran NO store fixtures this pass — findings below are code-reading and contract-reading, and I say so where it matters.*

---

## Headline

**The three mechanisms are sound. The document is not, because it now contains both the fix and the text the fix replaced.**

Edits 1, 3 and 5 land correctly *where they were written* — §2:82 and §3:99-100. But the falsified v8 sentences they supersede are **still in the document, in three other places**, stating the opposite rule:

- **§1:60** still reads *"discriminated by `ctx.feedback` (present = rework → fresh run; absent = replay → served from the transcript)"* — verbatim the rule review-8 **measured broken**, spelled out with its broken semantics.
- **§4:144** still reads *"replay/rework discriminated by `ctx.feedback`"*.
- **§3 rule 2's parenthetical (:108)** still reads *"the spawn's F-AC19 check resolves via `current()`, so a chain that spawns tasks referencing its own not-yet-committed artifacts must bind them through `prior`/the chain, not `requiredInputs`"* — the remedy review-8 P1 proved does not exist, and the exact opposite of what §3:100 now prescribes.

Three sections of a document about to be locked as an implementation target say the discriminator is `ctx.feedback` and one says it is transcript presence. An implementer reading §1 and §4 builds the measured-broken version.

Beyond the leftovers, one new load-bearing defect: **§2:75's feedback-delivery rule, read against §4:134-139's own definition of execution order, delivers confirm-rejection feedback to nobody in the shipped Flow 1** — and contradicts §4:155. That is review-8 P10's first failing reading, re-entered through the wording chosen to fix it.

**Verdict: LOCK AFTER the edits in §V. All are text; none reopens the architecture; none needs exploring.**

---

## I. The three mechanism edits

### Edit 1 — `propose-spawn` defers to commit — **APPLIED, MECHANISM CORRECT; the document contradicts itself at §3:108**

**The mechanism resolves clean.** Walked through the real store:

- **F-AC19.** `store.contractProblems` (`store.ts:242-260`) resolves `requiredInputs` through `current()` (`:257`). `current()` (`:207-227`) reads `artifact-locked` events. §4:159-164 orders commit as *materialize docs file → record `artifact-locked` → **then** execute the deferred `propose-spawn`s → `completed`*. At the moment `spawn!` runs, the parent's locks are in the log, so `current(name)` resolves and the child's contract passes. ✓
- **The artifact gate.** `store.parentConcluded` (`:321-325`) is satisfied by *any* `artifact-locked` event — it does **not** require `completed`. So the gate is met at the spawn point inside commit, before `completed` is written. `cli.ts:704` and `kernel.ts:194` both gate on that predicate. ✓
- **The leg gate is not a problem, and v9 is why.** `store.legGateMet` (`:671-683`) requires every task of the predecessor leg to be `done`. At commit the parent task is still `active` (`completed` comes last), so a *leg* spawn at that moment would be refused. **§3:104 reserves leg spawns to the frame** (*"Leg spawns are the frame's"*), and `propose-spawn`'s declaration is *"`{id, contract}` — a task"*. The collision cannot arise. That is a correct, non-obvious call and it is stated.
- **Ordering is load-bearing and stated.** If commit ran spawns before locks, every child naming the parent's artifact would fail exactly as review-8 measured. §4:159-164 gets the order right.

**Downside analysis (review-8's open question).**

- **Spawn-and-consume in one run: not expressible, and correctly so.** The child does not exist until the parent commits; `ctx.prior` is same-chain in-memory results only (§2:70); packet deps come from `contract.requiredInputs`. There is no channel by which a step could read a child it just proposed. §6:190's linear-unconditional limit points the same way. **But v9 never says it.** One clause under §3's `propose-spawn` row would close review-8's stated uncertainty instead of leaving it open.
- **A failed or escalated task silently drops its deferred spawns.** §3 rule 8 concludes a verify failure as `failed`; commit never runs; the recorded spawn intents evaporate with the in-memory list. That is the right semantics (acceptance-shaped writes die with acceptance) and it is the same rule that drops the deferred `artifact-locked` — but it is stated for neither. The working *file* survives (§1:57 says so); the proposed *work* vanishes with no record. One clause.
- **Depth is unspecified, and it decides whether the child is ever scheduled.** `store.tasksOf` (`:128`) counts only `n.split('/').length === 2`; `kernel.frontmostReady` (`:116-125`) iterates `tasksOf`. A child spawned at depth 3 (`leg/task/child`) is invisible to `frontmostReady` and to `legStatus` forever — while `check()`'s F-AC19 loop (`store.ts:645-650`) *does* police it. v9 never says whether deferred spawns land as leg siblings (depth 2, schedulable) or as children of the spawning task (depth 3, orphaned-by-construction). §3:100 says only *"the child"*. This is the one substantive gap in edit 1.

**The defect: §3 rule 2's parenthetical was not updated.** `:108` still carries the v8 justification and the v8 remedy. It asserts F-AC19 *"resolves via `current()`"* at spawn time (false during execute — that is P1; true at commit — which is now the only spawn point, making the whole sentence pointless) and it forbids exactly the binding that edit 1 makes legal. Rule 2's normative half (*"Violation → rejected, named"*) is also now vestigial: with both intents deferred and commit ordering locks before spawns, lock-before-spawn is satisfied by construction — which is precisely what review-8 said the edit would buy. The rule should say that, not the opposite.

### Edit 3 — transcript-presence discriminator + `runId` + miss policy — **APPLIED AT §2:82, CORRECT; UNDEFINED FOR MOST STEPS; the v8 rule survives in §1:60 and §4:144**

**Does it fix the measured crash-during-rework case?** Yes, where it is written. Walking §2:82 against the tail:

| tail | rejections at bound gate | runId | trace post-dating the last rejection? | outcome |
|---|---|---|---|---|
| first run, empty log | 0 | 1 | no records at all → no | NEW → live calls, append seq 0.. | 
| `rejected` → *(crash mid-rework)* → partial traces | 1 | 2 | **yes** | **REPLAY** — stranded run-2 records served, miss at seq k → live call appends at seq k+1, same runId |
| `rejected` → traces → `rejected` again | 2 | 3 | no (traces pre-date the newer rejection) | NEW → fresh records at runId 3 |
| confirm rejection, grill-bound step (bound gate `grill`, 0 grill rejections) | 0 | 1 | yes (its run-1 traces) | REPLAY → **human not re-interviewed** ✓ |

The bottom-right cell of review-8's table is closed, the human is not re-interviewed, and the 3-reject bound (`kernel.ts:207-209`, counting `rejected` at gates) is no longer bypassed by a crash loop. **`runId` is collision-free under replay as the user asked**: stranded records live at `(stepId, runId, seq 0..k)`, the miss appends at `seq k+1` under the *same* runId, and a new rejection advances the runId before any fresh record is written. The zero-rejection case degenerates correctly in both directions (no rejection ⇒ every existing trace "post-dates" the start ⇒ replay; no traces ⇒ new).

**The defect: "the step's bound gate" is undefined for `at:'execute'` steps — which is every step in the shipped Flow 1 except one.** The chain entry's `at` is `'grill' | 'confirm' | 'execute'` (§6:184). Both the discriminator *and* the `runId` formula key on *"the step's bound gate"*. `envision` and `spec` have none. Reading it as `confirm` makes the whole table above work, including the flow-control v6:37 escalation path (confirm rejection → grill loop → re-materialize → execute re-runs: the run-1 traces pre-date the confirm rejection, so the re-run is NEW and picks up the re-materialized packet). Reading it as "none" leaves runId undefined and the reference point undefined. **The design needs the one sentence that says which.** As written, the primary key of the transcript is undefined for the majority of steps — the same category of hole as v8 deleting the definition outright.

**The leftovers.** §1:60 and §4:144 still carry the v8 rule. §1:60 is the worse of the two because it spells out the broken semantics in full (*"present = rework → fresh run"*), which is the behaviour review-8 measured re-firing every LLM call uncapped.

### Edit 5 — `produces?[]` on the step contract — **APPLIED; DECIDABLE FOR THE DEADLOCK CHECK ONLY, AND ONLY IF TWO THINGS ARE SAID**

Today's contract is `{id, inputs[], rules[], execute}` (`step.ts:64-72`) — review-8's premise confirmed. §2:66 adds `produces?[]` *"(the intents it MAY declare)"*.

- **Confirm-bound deadlock check (§3 rule 8): decidable in kind — with a hole.** The check needs "is there an artifact-producing step that is not confirm-bound", i.e. does any non-confirm entry declare `lock-artifact`. That is a static question over declared intent *kinds*. ✓ **But `produces` is OPTIONAL and v9 never says what absence means.** If absence = "produces nothing", a step that locks at runtime without declaring passes validation and deadlocks anyway; if absence = "may produce anything", any undeclared execute step satisfies the check vacuously. The check is decidable only once absence has a fail-closed meaning. Unstated.
- **Nothing binds `produces?[]` to what `execute` actually declares.** No rule says the translator refuses an intent absent from `produces?[]`. Without that, the declaration is advisory and drifts from the body — the exact risk review-8 flagged in its own "not sure" #3 before recommending the field. One clause fixes it and it is the clause that makes the field worth its weight.
- **Intent *ordering* is still over-claimed (§1:57).** §3 rule 2's ordering rule is **name-level**: *"`lock-artifact` for a name precedes any `propose-spawn` whose contract's `requiredInputs` reference it."* `produces?[]` carries kinds, not artifact names, and the child's contract is computed inside `execute` at runtime. That check is not statically decidable from any declaration v9 defines. It does not need to be — deferral makes it moot — but §1:57 lists *"intent ordering"* in the STATICALLY VALIDATED half of the split row, and that half is still false for the one ordering rule the design actually writes down.

---

## II. The gate② sha binding (edit 2)

**Right home, right instinct, two holes.**

- **The home is right.** `store.ts:483` allows `submitted` only `at·type·note·gate`; `store.ts:478` allows `evidence` only `at·type·note·commits·refs·answers`; `validateEventShape` (`:490`) rejects unknown fields. No legal slot exists today, so this must ride the v14 §3 (event-schema) amendment. §8:229 records it. ✓
- **Hole A — §2 and §8 disagree about what §3 amends.** §2:91 describes the §3 amendment as *"`evidence` may carry the optional structured `trace` record"* — the sha is not in it. Only §8:229 mentions *"the gate②-confirmed sha record"*. Nowhere does the design say **which event carries it or in what field**. That is not cosmetic: on `submitted` the sha re-versions naturally with each rework submission; as an `evidence` record it has to be found by "the latest one before the `confirmed`", which is a fragile derivation the design would then owe. One clause.
- **Hole B — "sha of what exactly" has two different answers in the same paragraph, and the code proves they differ.** §4:151 records *"the working artifact's blob sha"*; §4:162 recomputes *"sha computed from the file"* after §4:159-161 has materialized `docs/<category>/<name>-v<N>.md`. Those are two different files. And `cmdLock` (`cli.ts:780-786`) shows the subject is not the file at all: it **strips the lock marker, hashes the stripped content, then writes a marker back into the file**. §5:175 knows this (*"Marker-stripped content (matching the lock-time hash)"*). So the equality holds only if the design pins (a) both shas are over marker-stripped content and (b) commit-time materialization into `docs/` is byte-verbatim. It pins neither. As written the check is either vacuous or always-refusing depending on the implementer's choice.
- **Hole C — the refusal has no named outcome, and it collides with a stated invariant.** §4:162 says commit *"REFUSES"* on mismatch. §4:165 says *"Every task concludes; `completed`/`failed` always written."* A refused commit writes neither. And the refusal **is** reachable by exactly the path edit 3 leaves open: crash after `confirmed(confirm)` → §1:60's tail state 1 skips the gate → execute replays → a transcript miss falls through to a live call (the stated miss policy) → different completion → file re-written → sha differs. Edit 2 correctly *detects* the drift review-8 P2 described; the design then has nothing to do about it. §3 rule 8 was made to name exactly one branch for verify; this refusal deserves the same sentence and does not have it.
- **Credit where due:** edit 7 (task-local working files) closes P2's concurrent-clobber path outright — two live tasks no longer share a materialized `docs/` path during execute. The remaining exposure is replay drift, which is the case above.

---

## III. The six smaller blocking edits

| # | Edit | Verdict |
|---|---|---|
| 6 | verify fails closed, ONE branch | **APPLIED, CLEAN.** §3:114: *"verify fails → the frame writes `failed` … concludes-as-failed"*. No "or". No gate-less loop, no gateless `feedback`. Consistent with the store: `failed` before gate② is legal (GATE-2 fires only on `completed`, `store.ts:578`; F-AC18 only on `completed`, `:633`). **Consequence worth knowing, not blocking:** a first verify miss now kills the task with no rework path, while a *gate* rejection gets three. And `kernel.verify` today tests for `artifact-locked` **events** (`kernel.ts:310-311`), which under defer-record never exist at verify time — §4:149 sees this (*"verify checks OUTPUTS, not acceptance events"*), and §8 item 2 owns the rebuild. |
| 7 | `docs/` materialization at commit | **APPLIED, CLEAN.** §3:99 + §4:159-161 agree; §1:57 adds the working-file lifecycle (task-local, unpoliced, `check()` event-anchored, never pruned). §3 rule 7 (:113) states placement by type without a competing timing claim — no contradiction. This also kills P2's clobber path and makes `N` computable once from the log. |
| 8 | amend journey-format v13 §4 | **APPLIED, CORRECT.** §8:229 names `:90` verbatim and adds `:87`/`:88`. Verified against the source: `:90` is *"`artifact-locked` is written the moment the artifact locks"*; `:87` *"written when produced; immutable once recorded"*; `:88` *"written when a shared artifact is produced"*. Recording it as the amendment's own rationale is the right form. |
| 9 | list the `rules/flow/default.json` migration | **APPLIED, CORRECT.** §8:231 names the shape change, `flow.ts:64`'s loader assertion, and the `validate → idea-validate` rename. Verified: the file holds `"default": ["validate","envision","spec"]` — flat strings — and `flow.ts:64` asserts `seq.every(s => typeof s === 'string')`. All three migrations now listed; the other two verified still-unmigrated (`vocab.json` `artifactTypes` is a flat string array; `decide/rules.json` ladder entries are `{step, note}` with no `enabled`). |
| 12 | `read.resolve` bound | **APPLIED, CORRECT.** §5:176 states `requiredInputs` (cross-task, committed) only; same-task sources through `prior`; the false "one mechanism" claim stays dropped; the packet's bounded excerpts cite `context-packet-spec:41,65` accurately. |
| 16 | two senses of "step" | **APPLIED, CORRECT.** §6:191 names journey-step (a node; a spawn; data) vs chain-step (a code unit), citing `requirements-spec-v3:33` — verified verbatim: *"Every step is a predefined, separately-managed node … Adding/removing/reordering steps requires no code change — only project data."* The apparent contradiction with a locked requirement is resolved. |

---

## IV. The completeness set

| Item | Verdict |
|---|---|
| trace shape, all four kinds | **APPLIED, STILL IMPRECISE.** §2:81 adds `research?`, `sources?[]` and states `present` is deliberately unrecorded ✓. But `collectResearch` returns `Array<{topic, findings, sources?}>` (`interact.ts:21`) — per-topic sources. v9 declares `research?` and a sibling top-level `sources?[]`, with `topic`/`findings` unnamed: either `research?` is the array (making `sources?[]` redundant) or the sources are flattened and lose their topic binding. And the `decide` kind cannot carry `options[]` — `collectDecision({prompt, options})` (`interact.ts:23`) — which replay-by-identity needs, since the verdict map routes `decision ∈ decisions[]`. The ask was "precise enough for all four kinds"; it is now gestured at for three. |
| architecture `:62` / `:65` | **APPLIED, CORRECT.** §8:230 lists `:62`, `:65`, `:64 partially`. Verified: `:62` *"Reads: any layer via the store's derived views"*, `:65` *"Adapters explained: … GitHub + human-interface follow the same adapter pattern"* — both genuinely falsified by the fold. |
| phase placement restored | **APPLIED.** §4:134-139 restores both parentheticals and the `validateChain`-earlier = EXECUTION ORDER sentence, plus "before validate" for the grill-bound step. §3:110 carries the resume clause (*"the step re-runs from the transcript"*). **Half-short:** §1:60 still says a decided gate is *"skip"* without saying skip-the-**write**-not-the-step — the phrase review-8 asked for lives only in §3 rule 4. |
| node-level `superseded` | **APPLIED, AND THE NEW CLAIM IS FALSE.** §3:101 fixes the count (two meanings, two enumerated) ✓ but asserts node-level supersession is *"NOT REACHABLE in v1 — `supersede!`'s `{name, path}` is artifact-shaped"*. The payload shape is irrelevant to the status collapse: `store.ts:171-173` collapses **any** node carrying a `superseded` event that is not already `done`/`failed`, and `cmdSupersede` (`cli.ts:793-796`) writes that event on **whatever id it is given** — the AC-7 amendment path writes it on the old locker's node by design (§3:101 calls it *"the ONLY cross-task write"*). So: supersede an artifact whose locker crashed in the commit window between `artifact-locked` and `completed`, and that live task's status collapses to `superseded`, `frontmostReady` (`kernel.ts:116-125`, filtering `['queued','active']`) drops it, and it never concludes. Narrow, but it is review-7's B1 failure shape and the design now asserts it cannot happen. What is unreachable is a *bare* node-level supersede; that is not the same claim. |
| two-log reversal + NFR-SEC-1 | **APPLIED, CORRECT.** §2:81 states the reversal and applies NFR-SEC-1 to prompt text. Verified against `oplog.ts:5-7` (*"NOT project state, never in the tree"*) and `requirements-spec-v3:62`. |
| mis-citations | **ALL FOUR FIXED.** `v13:43` ✓ (verified: *"IMMUTABLE — written once at spawn"*); `vocab.statuses` re-homed to `vocab.json:23-30` with *"v13 has no status list"* ✓ (verified: v13:57-61 enumerate event types and closure-event schemas only; no status list exists in v13); `§14/§15 … the `-v<N>` filename rule is ADDED, not amended` ✓ (verified: no filename rule in v13; the pattern appears only inside the `:76` event example) — though §2:92 still calls it *"the artifact filename rule"* without the caveat that §8 carries; initiator list ✓ (verified `ann-system-design-v3:59` = *"planner kernel …, adapters …, validators/reviewer"*, CLI absent, and §1:31-33 now matches). |
| ownership rows | **PARTIALLY APPLIED — 2 of 6.** The L2 bundle row is split into STATICALLY VALIDATED / RUNTIME-CONVENTION-ONLY ✓ and the working-file lifecycle row is folded in ✓. **Still missing, fourth ask:** `params`/`paramsSchema` ownership; the `at:` mixed namespace (`'grill'`/`'confirm'` from `vocab.gates`, `'execute'` a phase literal); the two-write gate-acquisition convention. **Missing, first ask:** the gate②-to-commit content binding — the row review-8 Q5 asked for to carry edit 2. |
| cosmetics | **LISTED, NOT SWEPT — as v9 says.** §8:233 lists all three and scopes them *"for the re-implementation, not the design"*. Verified still unfixed: `ann-system-design-v3.md:7` = `# Ann System Design (v2)`; `functional-spec.md:44` cites `AC-8/RPO`; `requirements-spec-v3.md:43` cites `F-AC8`. Listing them in the ship list is a legitimate answer to the ask; the files are still wrong. |

---

## V. NEW holes in the mechanism text

**N1 (blocking) — the document states the falsified discriminator in two places and the falsified spawn remedy in a third.** §1:60, §4:144, §3:108. Detailed in §Headline and §I. This is not a wording nit: §1:60 and §4:144 are the two places an implementer reads to build the frame, and they describe the behaviour review-8 measured broken.

**N2 (blocking) — §2:75's feedback delivery, read against §4's own execution order, delivers confirm-rejection feedback to nobody.** §2:75: *"steps at or after the rejecting gate's position in execution order receive it; earlier gate-bound steps REPLAY."* §4:134-139 defines execution order as **grill-bound → `at:'execute'` in list order → confirm-bound**, with GATE② after verify. The confirm gate's position in that order is therefore **last**. So for a confirm rejection, "at or after" selects the confirm-bound step alone — and the shipped Flow 1 (`[idea-validate@grill, envision, spec]`, §6:199-200) has none. `envision` and `spec` re-run fresh (edit 3 makes them fresh — their run-1 traces pre-date the rejection) **with no feedback at all**: same packet, same prompts, no rejection text, model calls burned, artifact unchanged in substance, gate② re-presented, three cycles, escalate. That is review-8 P10's first failing reading, restored by the wording chosen to close it. It also contradicts §4:155's *"rejected → RE-EXECUTE from feedback"* and `flow-control-spec-v6:37` (*"GATE② reject → re-execute (rework output from artifacts + feedback)"*). The rule works only if "position" means the **phase the rework re-enters at** — grill → materialize (everything fresh), confirm → execute (execute-phase and confirm-bound fresh, grill-bound replays). Say that; the current words say the opposite.

**N3 (blocking, small) — "the step's bound gate" is undefined for `at:'execute'` steps.** §I, edit 3. It is the key of the transcript and the input to the discriminator, and it is undefined for most steps in the shipped flow.

**N4 (blocking, small) — the gate② sha's subject, its event home, and its refusal outcome.** §II, holes A/B/C.

**N5 (small) — §3:101's "node-level supersession is NOT REACHABLE in v1" is false.** §IV. The status collapse is not dormant; it rides the artifact-shaped path.

**N6 (small) — §1:46's grandfathering clause is wrong in the direction that matters.** The row claims the gate-sequence invariant is *"Unconditional for nodes with `createdAt >= CUTOFF`"* and that *"the prose paths are GRANDFATHERED for pre-cutoff nodes only"*. `store.gateProblems` (`:559-593`) reads **no `createdAt` at all** — the CUTOFF appears only in `check()`'s F-AC18/F-AC19 loops (`:630`, `:636`, `:648`). So the invariant is unconditional for *everyone* (stronger than claimed), while the two prose escapes are cutoff-**independent** (weaker than claimed): `:576` sets `retroGrill` from any `confirmed(gate=grill)` whose **note contains "retrospective"**, which suppresses the GATE-1 check for a brand-new node; and `:574` counts a `confirmed` with an **empty gate string** as the confirm-gate confirmation. §7:213's *"no gate-skipping — the STORE refuses the writes (post-cutoff)"* inherits the same over-claim. The ownership table is the document's load-bearing artifact; this row should describe the code.

**N7 (small) — `propose-spawn`'s unstated consequences.** Spawn-and-consume-in-one-run is forbidden by construction but never said; deferred spawns die silently with a `failed` task; and the spawn's **depth** is unspecified while `frontmostReady`/`tasksOf` only see depth 2 (§I).

---

## VI. Verdict

# LOCK AFTER these edits — all text, none reopening the architecture.

The mechanism review-8 measured sound is still sound, and edits 1/3/5 are the right shapes. What blocks the lock is that v9 is not internally consistent about them: three passages still assert the superseded rules, and one new passage (§2:75) reinstates a failure review-8 closed.

**Blocking**

1. **Delete the v8 discriminator from §1:60 and §4:144.** Both must point at §2:82's transcript-presence rule. §1:60's *"present = rework → fresh run; absent = replay"* is the measured-broken rule stated in full.
2. **Rewrite §3 rule 2 (:108).** Drop the parenthetical entirely — it prescribes the remedy review-8 P1 disproved and forbids the binding edit 1 legalises. State instead that deferral satisfies lock-before-spawn by construction (locks record before spawns inside commit, §4:159-164), which is what the rule now means.
3. **Fix §2:75's delivery rule.** "At or after the rejecting gate's position in execution order" selects nothing in the shipped chain for a confirm rejection, because §4 puts the confirm gate last. Key delivery on the **phase the rework re-enters** (grill → materialize; confirm → execute), so `envision`/`spec` receive confirm feedback and the grill-bound step replays. Reconcile with §4:155.
4. **Define "the step's bound gate" for `at:'execute'` entries** (`confirm` works throughout, including the v6:37 escalation path). Without it `runId` and the discriminator are undefined for most steps.
5. **Pin the gate② sha:** which event and field carries it (say it in §2:91, not only §8:229); that both shas are over the same bytes (marker-stripped content, byte-verbatim materialization — `cli.ts:780-786` hashes stripped content and then writes a marker into the file, so this cannot be left to the implementer); and **what happens when commit refuses** — today that branch writes neither `completed` nor `failed`, contradicting §4:165, and it is reachable via the stated miss policy.

**Required for completeness**

6. **Say what an absent `produces?[]` means** (fail-closed), and that the translator refuses an intent the step did not declare — otherwise the field drifts from `execute` and the static check is advisory.
7. **Downgrade "intent ordering" in §1:57** from STATICALLY VALIDATED, or restate rule 2 so the claim matches: name-level ordering is not decidable from declared kinds.
8. **Correct §3:101** — node-level supersession *is* reachable through the artifact-shaped `supersede!`; the status collapse in `store.ts:171-173` is not dormant. Either state the exposure (a live locker in the commit window) or say the frame refuses to supersede a non-`done` locker.
9. **Correct §1:46's grandfathering clause** to match `store.gateProblems`: no `createdAt` condition; the `retrospective`-note and empty-gate paths are open to new nodes. Adjust §7:213 to match.
10. **Add the four missing ownership rows** (`params`/`paramsSchema`, the `at:` namespace, the two-write gate convention) plus the gate②-content-binding row edit 2 needs.
11. **Finish the trace record's shape** — `research` as an array with per-topic `sources[]`, and `options[]` for `decide` (replay-by-identity depends on it).
12. **State `propose-spawn`'s three unstated consequences** — no spawn-and-consume in one run; deferred spawns die with a failed task; and the depth at which children land (`tasksOf`/`frontmostReady` see depth 2 only).
13. **One clause in §1:60** — a decided gate on resume skips the gate **write**, not the step (it lives only in §3 rule 4 today).

---

## What I am not sure of

- **I ran no store fixtures this pass.** Review-8's fixtures are the measurement of record; mine is code reading. The three findings that would most benefit from execution are N2 (the delivery rule — needs the frame, which does not exist), N5 (the supersede status collapse on a live locker — I read `store.ts:171-173` and `cli.ts:793-796` but did not construct the crash window), and N6 (the `retrospective`-note bypass on a post-cutoff node — I read `gateProblems` end to end and found no `createdAt`, but did not append a fixture event to confirm).
- **Whether N2 is a wording defect or a substantive disagreement.** I read §2:75 literally against §4:134-139 and it selects nothing. It is possible the author means "position" as re-entry phase and considers that obvious. If so it is one clause; if not it is the difference between rework working and rework burning three cycles.
- **Whether the depth question (N7) belongs to this design at all.** `propose-spawn` hands the step an `id`, and the step chooses. That is arguably correct and out of scope — but the design's own `advance` phase promises to propose the frontmost task, and a depth-3 child is never frontmost.
- **Whether edit 6's single branch is too harsh.** A first verify miss ends the task; a gate rejection gets three cycles. Review-8 demanded one branch and v9 picked the fail-closed one. It is bounded, named and store-legal. Whether it is the branch the owner wants is a judgment I do not think a reviewer should make.
- **I did not re-verify the 19 legacy retrospective nodes or the 5 exempt leg roots** cited in §1:46; those were review-8's measurement and I took them as given.
