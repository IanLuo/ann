# Design Review v10 — THE LOCK GATE

*Scope as prescribed: the 13 edits review-9 blocked on, whole-document internal consistency, the three mechanism sections read as one, the amendments list, and the owner's core question (what forces a code change for a future flow change).*

*Evidence base: `core-design-v10.md` read in full and diffed against v9; `design-review-v9.md` and `design-review-v8.md` read in full. Code verified at the cited lines: `store/store.ts` (`gateProblems` 559-593, status collapse 172, `tasksOf` 126-129, `parentConcluded` 321-325, `legGateMet` 671-683, `contractProblems` 242-260, `current` 207-227), `cli.ts` (`cmdSpawn` 694-715, `cmdLock` 777-790, `cmdSupersede` 793-796), `kernel/kernel.ts` (`frontmostReady` 116-125, validate 188-196, `rejectionCount` 207-215, verify 311), `kernel/step.ts` 64-72, `kernel/flow.ts` 55-75, `kernel/interact.ts` 14-24, `kernel/steps/index.ts` 1-15. Contracts quoted line-by-line: journey-format v13 (:33, :43, :57-61, :87, :88, :90, :223, §14@197, §15@221), flow-control v6 (:17, :24, :34, :36-38, §7@75), requirements-spec-v3 (:33, :43, :62), context-packet-spec (:41, :65), architecture-v2 (14 cited lines, all present), ann-system-design-v3 (:7, :59), resource-registry-v2 (:36, :51-57, :63), and the three registry data files. I ran no store fixtures; like review-9 this is code-reading and contract-reading.*

---

## Headline

**Nine of the 13 edits landed clean. Four landed only where review-9 gave a line number.**

v10 was applied by line reference, not by concept. Every edit review-9 anchored with an explicit address (§1:60, §4:144, §3:108, §2:75, §1:46, §3:101, §1:57) is fixed at that address. Three of those same rules appear elsewhere in the document, unaddressed, still stating the falsified version:

- **§8 item 3 (:235)** — the ship list for intent translation still reads *"replay/rework via `ctx.feedback`"*. That is the discriminator review-8 measured broken, sitting in the implementation checklist.
- **§7 (:225)** — *"no gate-skipping — the STORE refuses the writes (post-cutoff) … prose paths grandfathered for legacy nodes only"*. Review-9 edit 9 said in words: *"Adjust §7:213 to match."* It was not adjusted. §1:46 now says the invariant is UNCONDITIONAL and the escapes are cutoff-**independent**; §7 still says the opposite of both halves.
- **§2 (:71)** — `produces?[]` *"makes the confirm-bound deadlock check **and intent-ordering validation** statically decidable"*. Edit 7 removed exactly this claim from §1:57 (it now reads *"intent ordering … not statically checkable"*) and rule 2 now says *"No ordering check needed"*. §2:71 still promises the check.

This is the same failure v9 had, one order of magnitude smaller: the fix and the text it replaces coexist. The mechanisms themselves are sound and I found no new mechanism defect.

**Verdict: LOCK AFTER three phrase-level edits.** Each is a deletion or a two-word replacement in a sentence whose correct form already exists elsewhere in the document. Nothing reopens the architecture.

---

## I. The 13 edits — per-edit verdict

### Blocking set

| # | Edit | Verdict |
|---|---|---|
| 1 | Delete the v8 discriminator from §1:60 and §4:144 | **PARTIAL.** Both named sites fixed, and fixed well — §1:64 now reads *"discriminated by **TRANSCRIPT PRESENCE** (§2 — NEVER `ctx.feedback`, which review-8 measured broken)"*; §4:151-152 the same. **A third instance survives at §8:235.** |
| 2 | Rewrite §3 rule 2 (:108) | **APPLIED, CLEAN.** :115 states lock-before-spawn is satisfied by construction, cites the commit ordering in §4, and explicitly records that the v8 prior-binding parenthetical is DELETED. The prior-binding remedy does not appear anywhere in v10 (grep clean). Matches §4:166-175's actual ordering: materialize → `artifact-locked` → spawns → `completed`. |
| 3 | Fix §2:75's delivery rule | **APPLIED.** :76-82 keys delivery on the phase the rework re-enters — grill → materialize (all fresh with feedback), confirm → execute (execute-phase + confirm-bound fresh with feedback, grill-bound replays). Reconciles with §4:161-163 (*"rejected → RE-EXECUTE from feedback"*) and `flow-control-spec-v6:37`. **One residual — see §III.** |
| 4 | Define "the step's bound gate" for `at:'execute'` | **APPLIED.** :91 — *"the step's bound gate = `confirm` for `at:'execute'` steps, `grill` for grill-bound steps"*. This is the reading review-9 verified against the v6:37 escalation path. Cosmetic only: :89 uses the term two lines before :91 defines it. |
| 5 | Pin the gate② sha | **APPLIED, FULLY — all three holes.** Home: `submitted.confirmedSha`, named in §2:98 (the amendment), §1:62 (a new ownership row) and §4:171-172 — no longer only in §8. Subject: *"MARKER-STRIPPED content"* on both sides plus *"BYTE-VERBATIM from the working file"* at materialization (§4:168-171). Refusal: *"→ the frame writes `failed` (named)"* (§1:62, §4:172-174), which resolves the §4 *"every task concludes"* collision. Verified necessary against `cli.ts:781-783` — the lock strips the marker, hashes the stripped content, then writes a marker back; without both pins the check is vacuous or always-refusing. Nit: the self-citation *"consistent with §4:165"* (:174) is stale — that sentence moved to :176-177. |

### Completeness set

| # | Edit | Verdict |
|---|---|---|
| 6 | Absent `produces?[]` = fail-closed; translator refuses undeclared intents | **APPLIED, CLEAN.** :121 — *"its absence means 'produces NOTHING' — fail-closed; the translator REFUSES an intent the step did not declare, so the declaration cannot drift from `execute`"*. Both halves, one sentence. |
| 7 | Downgrade "intent ordering" in §1:57 | **PARTIAL.** §1:57 fixed correctly — moved into RUNTIME/CONVENTION-ONLY with the reason (*"satisfied BY CONSTRUCTION via deferral, not statically checkable"*). **§2:71 still makes the claim.** |
| 8 | Correct §3:101 — node-level supersession IS reachable | **APPLIED, AND IMPROVED.** :108 states the reachability, cites `store.ts:171-173`, and adds a remedy review-9 only offered as an option: *"the frame REFUSES to supersede a locker that is not `done`"*. Verified against `store.ts:172` (`if (status !== 'done' && status !== 'failed') status = 'superseded'`) — the refusal closes the commit-window exposure exactly. "TWO meanings" retained; no "third meaning" text anywhere (grep clean). |
| 9 | Correct §1:46's grandfathering; adjust §7 | **PARTIAL.** §1:46 rewritten and now describes the code: *"UNCONDITIONAL — `gateProblems` reads no `createdAt`"*, plus a decision review-9 did not ask for and should have — the re-implementation **removes** both prose escapes. Verified: `gateProblems` (559-593) reads no `createdAt`; the empty-gate fallback is at :574, the `retrospective`-note suppression at :576, both unconditional. **§7:225 not adjusted.** |
| 10 | Four missing ownership rows | **APPLIED, ALL FOUR.** :59 `params`/`paramsSchema` · :60 the `at:` mixed namespace · :61 the two-write gate convention · :62 the gate②-to-commit content binding. |
| 11 | Finish the trace record's shape | **APPLIED, EXACT.** :88 — `research?: [{topic, findings, sources?[]}]` matches `interact.ts:21` (`Array<{topic, findings, sources?}>`) field for field; `options?[]` added for `decide`, matching `collectDecision({prompt, options})` at `interact.ts:23`. Nit: `collectDecision` returns `{choice}` and the trace field is `answer?` — the mapping is unnamed but unambiguous. |
| 12 | State `propose-spawn`'s three consequences | **APPLIED — and the depth answer breaks the row's own justification.** All three stated at :107: no spawn-and-consume, deferred spawns die with a `failed` task, depth 2. The depth call is right: `tasksOf` (`store.ts:126-129`) filters `split('/').length === 2` and `frontmostReady` (`kernel.ts:116-125`) iterates `tasksOf`, so a depth-3 child is unschedulable. **But at depth 2 the parent is the LEG, and `cmdSpawn` (`cli.ts:702-705`) checks the artifact gate only when `parent.split('/').length >= 2` — `kernel.ts:192-196` says the same in comments.** So the row's justification *"F-AC19 + the artifact gate resolve then"* is half stale: the artifact gate never applies to these children at all. F-AC19 via `current()` (`contractProblems:257`) is the only load-bearing reason the ordering matters. Non-blocking, but it is a sentence asserting a gate is satisfied by ordering when the gate is not consulted. |
| 13 | Decided gate skips the write, not the step | **APPLIED, VERBATIM.** :64 — *"skip the gate WRITE (the step still re-runs from the transcript — a decided gate skips the write, never the step)"*. |

**Score: 9 clean, 4 partial (1, 7, 9, 12). Three of the four partials are the consistency failures below; the fourth (12) is a stale justification, not a contradiction.**

---

## II. The consistency grep — the critical check

Grepped the whole document for every falsified rule review-9 named.

| Falsified rule | Instances in v10 | Result |
|---|---|---|
| `ctx.feedback` as the discriminator | **1** — §8:235 *"replay/rework via `ctx.feedback`"* | **FAIL.** Four other passages (:5, :64, :89, :151-152) state transcript presence, three of them explicitly negating `ctx.feedback`. §8:235 states the opposite, in the ship list. `ctx.feedback` appears legitimately at :89 (*"marks the attempt kind"*) and :76 (the channel) — those are correct and are not hits. |
| the prior-binding spawn remedy | **0** | **PASS.** `grep -i "bind them through\|not-yet-committed\|must bind"` → empty. Rule 2 records the deletion explicitly. |
| feedback delivery by execution-order position | **0** | **PASS.** `grep -i "at or after\|position in execution order"` → empty. |
| "THREE meanings" of `superseded` | **0** | **PASS.** Only *"TWO meanings, stated"* at :108, with *"rework is NOT a third"*. |
| bound-gate undefined | **0** | **PASS.** Defined at :91. |
| **(extra) intent ordering as statically validated** | **1** — §2:71 | **FAIL.** Contradicts §1:57 and rule 2 (:115). |
| **(extra) cutoff-conditional gate enforcement** | **1** — §7:225 | **FAIL.** Contradicts the rewritten §1:46 on both halves — the invariant's conditionality and the escapes' scope. Review-9 edit 9 asked for this line by name. |

**Three hits. A locked document must state one rule per concept; on three concepts it states two.**

Each is one phrase, and in each case the document already contains the correct statement in a more prominent place — which is precisely why an implementer reading only §7 or only §8 would build the wrong thing without ever seeing a conflict.

---

## III. The three mechanism sections as a whole

**They cohere.** Walked one complete rework cycle end to end against the shipped Flow 1 (`[idea-validate@grill, envision, spec]`) and the real store:

1. **materialize** → packet. **GATE·grill**: `idea-validate` runs at the grill phase (§4:142-145), its verdict maps to accept (§6:197 verdict map), `lock-artifact` writes the **working file only**; the event is deferred. `submit!` → `gate! accept` → `confirmed(gate=grill)`.
2. **validate → activate** (`activated`, idempotent). **execute**: `envision`, `spec` run; both `at:'execute'`, bound gate `confirm`, no rejections yet, no traces → NEW → live calls, records at `runId 1`.
3. **verify** checks OUTPUTS, not events (§4:155-158) — correct and necessary, since `kernel.ts:311` today tests for `artifact-locked` events that under defer-record do not exist at verify time. §8 item 2 owns the rebuild.
4. **GATE·confirm**: `submit!(confirm)` records `confirmedSha` over the marker-stripped working file. Human rejects with feedback → `rejected(gate=confirm)`.
5. **Rework re-enters at execute** (§2:79-82). `envision`/`spec`: bound gate `confirm`, `runId = 1 + 1 = 2`, run-1 traces pre-date the rejection → **NEW** → fresh calls **with `ctx.feedback`**. `idea-validate`: bound gate `grill`, zero grill rejections, its run-1 traces post-date the (nonexistent) reference point → **REPLAY** → human not re-interviewed. Lock file re-writes; no event; no `superseded` on a live node.
6. **Re-verify → GATE② → accept.** **commit**: docs file materialized byte-verbatim → sha over marker-stripped content compared against `submitted.confirmedSha` → match → `artifact-locked` recorded → deferred `propose-spawn`s run (F-AC19 resolves via `current()` because locks recorded first) → `completed`.

Gate sequence holds at every write: `gateProblems`' GATE-1 needs `confirmed(grill)` before first work (satisfied at step 1); GATE-2 needs `confirmed(confirm)` before `completed` (satisfied at step 6). The 3-reject bound (`kernel.ts:207-215`, counting `rejected` per gate) is no longer bypassable by a crash loop, because a crash mid-rework leaves traces that post-date the rejection → replay, not a fresh burn.

**One residual, non-blocking: two rules decide the same thing.** §2:76-82 (delivery) asserts *freshness* — *"everything runs fresh"*, *"REPLAY — their gate is still confirmed"* — and §2:89/91 (the discriminator) independently computes fresh-vs-replay from transcript presence. They agree on every path the shipped routing can produce, but only because a grill rejection is always immediately preceded by a confirm rejection (the v6:37 escalation) or precedes any execute-phase trace at all. That property is real but **unstated**, and the delivery rule offers a third justification for replay (*"their gate is still confirmed"*) that is not the discriminator. If a future routing change lets the grill loop re-enter without a fresh confirm rejection, the two rules diverge silently: delivery says fresh, the discriminator says replay, and stale completions get served against a re-materialized packet. One sentence fixes it — *the discriminator is authoritative; §2:76-82 governs feedback routing only* — and it is the kind of sentence a locked document should carry. I do not treat it as blocking because no shipped path reaches the divergence.

**Also noted, not blocking:** §4:141's *"run the chain in EXECUTION ORDER: grill-bound first…"* read literally re-runs the grill-bound step at the execute phase, while §4:142-145 places it at the grill phase. The two readings converge in behaviour (the re-run replays from the transcript, zero model calls, no re-interview), so the slack is harmless — but it is slack.

---

## IV. The amendments list (§8)

**Complete, and every cited line is real.** I checked all of them.

| Amendment | Citations verified |
|---|---|
| journey-format v13 → v14 | §2 node.json — `v13:33` is `"openQuestions": [` at top level ✓, `v13:43` *"IMMUTABLE — written once at spawn"* ✓. §3 event schema (trace + `confirmedSha`) — `validateEventShape` genuinely has no legal slot ✓. §4 — `v13:90` contains *"`artifact-locked` is written the moment the artifact locks"* verbatim ✓; `:87`/`:88` are the write-timing rows ✓. §14/§15 exist (197/221) and contain **no** `-v<N>` filename rule ✓ — the "ADDED, not amended" caveat is accurate. The `context.ts` + `store.spawn` changes are owned in the ship list, and item 9 repeats the ownership ✓. |
| architecture v2 → v3 | All 14 cited lines exist in a 122-line file. `:27` LB-4 layering ✓, `:60` dependency direction ✓, `:62` *"Reads: any layer via the store's derived views"* ✓, `:63` ends *"The kernel routes each step to its engine"* — genuinely falsified by the fold ✓, `:64` surface ✓, `:65` *"GitHub + human-interface follow the same adapter pattern"* ✓, `:66` two enforcement points ✓, `:24`/`:61` single-initiator ✓, `:97` error shape ✓, `:71-80`/`:84` the tree ✓, `:38-58` the diagram block (both fences) ✓. |
| resource-registry v2 → v3 | `:36` the category enum ✓, `:51-57` the category rows ✓, `:63` *"every consumed rule exists in a registry; no hardcoded rule outside it"* ✓ — the right home for the code-literal reconciliation. **All three data migrations verified still unmigrated:** `vocab.json` `artifactTypes` is a flat string array `["spec","system-design","architecture","record","vision","validation"]` ✓; `decide/rules.json` ladder entries are `{step, note}` with no `enabled` ✓; `flow/default.json` holds `"default": ["validate","envision","spec"]` flat strings, `flow.ts:64` asserts `seq.every(s => typeof s === 'string')`, and the `validate → idea-validate` rename is real (`steps/index.ts` imports `ValidateStep`) ✓. |
| flow-control v6 deferrals | §7 exists at `:75` with exactly four parameterization columns (Materialize · Missing input · Verify · Chain effect) ✓; §4's ladder rungs ✓; the `activate` redefinition against `:24` ✓. |
| doc sweep (cosmetics) | All three still wrong, as listed: `ann-system-design-v3.md:7` = `# Ann System Design (v2)` ✓; `functional-spec.md:44` cites `AC-8/RPO` ✓; `requirements-spec-v3.md:43` cites `F-AC8` ✓. Scoping them to the re-implementation is a legitimate answer. |

Also verified: `requirements-spec-v3:33` supports §6:203's journey-step claim verbatim; `ann-system-design-v3:59`'s initiator list is *"planner kernel …, adapters …, validators/reviewer"* with the CLI absent, matching §1:30-34; `context-packet-spec:41,65` support §5's bounded-excerpt claim; `vocab.json:23-30` is the `statuses` array and v13 has no status list, as §1:53 says.

**One defect in the list**: §8 item 3's *"replay/rework via `ctx.feedback`"* (§II above). The amendments themselves are clean; the ship-list line above them is not.

---

## V. What forces a code change for a future flow change

The owner's core question. The design answers it honestly — §6:203 and the ownership table name every edge. Tested against the flow changes most likely to come:

**Data — no code:** add/remove/reorder chain steps (from the existing inventory) · move which step is gate-bound (`at:`) · add a work type with its own chain · rewire what a step consumes (role bindings, unspawned tasks only) · change a step's `params` · a new artifact type in an existing `docs/` category · enable a ladder rung **once it is built**.

**Code — and the design says so:**
- **A new chain step.** Implement + register (`steps/index.ts:8-12`). This is the honest cost of "flows are data": the data is expressive only over the existing step inventory. §6:203 states it and separates it from the journey-step sense that `requirements-spec-v3:33` protects.
- **A branch.** §6:202 — chains are linear and unconditional; the escape is *"a new work type or a step's internal decision"*. **This is the sharpest limit and it is understated.** A work type is selected from the contract at spawn, so it cannot express a *runtime* branch ("if the idea is thin, research before envision"). The remaining escape puts the branch inside a step's code, at which point the chain data no longer describes the flow. Every conditional flow change is a code change, forever, until chains gain conditionals. The design names the limit in one clause and does not weigh it.
- **A new gate, or a second human decision inside one gate.** `vocab.gates` set and positions are protected (§1:54, `flow-control v6:17,34`); rule 6 statically forbids two steps per gate. Deliberate.
- **A new intent kind.** L2 translation + likely an L0 schema amendment.
- **Changing the 3-reject bound.** A constant owned by `gate!`, *"never adjustable, never bypassable"* (§4:183). Deliberate.
- **The frame's phase order.** Protected.

Nothing hidden. The one thing I would want the owner to have said out loud, and the design does not: **conditional flow is the change most likely to be wanted next, and it is the one the data model cannot absorb.**

---

## VI. LOCK VERDICT

# LOCK AFTER these three edits

All three are phrase-level. All three replace text that contradicts a correct statement already present elsewhere in the document. None reopens the architecture, none touches a mechanism, none needs measurement.

1. **§8:235** — delete *"replay/rework via `ctx.feedback`"*; replace with *"replay/rework via transcript presence (§2)"*. The ship list currently prescribes the measured-broken discriminator.
2. **§7:225** — rewrite to match §1:46: the store refuses the writes **unconditionally**; the two prose escapes are **removed** in the re-implementation, not grandfathered by cutoff. Both halves of the current sentence are wrong against `gateProblems`.
3. **§2:71** — strike *"and intent-ordering validation"*. `produces?[]` makes the **confirm-bound deadlock check** statically decidable; §1:57 and rule 2 both now say ordering is satisfied by construction and is not statically checkable.

**Recommended in the same pass (not blocking):**

4. **§2:76-82** — one clause: the transcript-presence discriminator is authoritative for fresh-vs-replay; the delivery rule governs *feedback routing*. Today two rules decide one thing and agree only by an unstated property of the routing (§III).
5. **§3:107** — drop *"+ the artifact gate"* from the deferral justification. At depth 2 the parent is the leg and the gate is not consulted (`cli.ts:702-705`, `kernel.ts:192-196`); F-AC19 via `current()` is the whole reason the ordering matters.
6. **§4:174** — the self-citation *"§4:165"* now points at the commit-phase header; the sentence it means is at :176-177. Consider dropping internal line citations from a document that gets re-numbered every revision.

**What is now settled and should not be re-litigated:** defer-record (locks and spawns both deferred to commit, ordered locks-first), transcript replay with `runId = 1 + rejections at the bound gate` and the miss policy, the gate②-to-commit sha binding over marker-stripped bytes with a `failed` outcome on mismatch, the fail-closed `produces?[]`, the depth-2 spawn, the supersede refusal on a non-`done` locker, and the corrected gate-sequence ownership. Review-8 measured them; review-9 confirmed them; I found no new defect in any of them.

---

## What I am not sure of

- **I ran no fixtures.** Third pass in a row on code-reading alone. The claims I would most want executed before the first line of the re-implementation: the depth-2 spawn actually clearing `cmdSpawn`'s sibling-prefix check at commit time (a step choosing `05-foo` when `05-bar` exists fails closed, named, at commit — reachable, unaddressed, low risk under a single writer), and the supersede refusal on a live locker.
- **Whether the conditional-chain limit is acceptable to the owner.** I flagged it as understated, not wrong. The design states it; whether shipping v1 without it is right is the owner's call, not a reviewer's.
- **Whether §III's residual is worth an edit.** No shipped path reaches the divergence. I would still write the clause, because the document's own standard is one rule per concept and this is two.
- **The 19 legacy `retrospective` nodes and 5 exempt leg roots** cited in §1:46 are review-8's measurement, inherited through review-9 and taken as given here.
