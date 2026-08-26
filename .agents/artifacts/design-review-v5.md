# Design Review v5 — the core re-design (fifth pass)

*Reviewed against the locked contracts (journey-format-spec v13 @ 699615a, flow-control-spec v6 @ 5898f89, requirements-spec v3, functional-spec, context-packet-spec, **architecture v2 @ e6d07ed** (v1 @ fcfa661 superseded), ann-system-design v3 @ 2b0a30f, resource-registry-spec v2 @ 4f95b5a, `vocab.json` v2, `rules/decide/rules.json`, `rules/flow/default.json`) and the current `src/` — **169 tests pass, run and verified** (`npx vitest run`, 10 files). Every claim below is anchored to contract text or code; file:line or §-quote given. Owner priority applied: **is the DESIGN sound so that later FLOW changes are sound.** Flow content is not the subject.*

---

## Q1 — Were review-4 edits 1–14 (+ cosmetics) applied?

**5 applied clean · 6 applied with a real defect · 2 applied in words but broken in mechanism · 1 cosmetic not applied.**

| # | Edit | Verdict |
|---|---|---|
| 1 | producer-based idempotence | **PARTIAL** — right for `lock-artifact`, absent for 3 of 5 intents: **N1** |
| 2 | v13 §2 amendment | **APPLIED, SCOPED SHORT** — wrong field set, amendment procedure incomplete: **N2** |
| 3 | both-ends chain validation | **APPLIED, and it breaks the L0/L1 floor**: **N3** |
| 4 | gate-bound ordering | **APPLIED, verified correct** ✓ |
| 5 | supersede on the old locker | **APPLIED, verified correct** ✓ |
| 6 | verdict map + `params` in ctx | **APPLIED, verified** ✓ (two small holes: N9) |
| 7 | complete the ownership table | **APPLIED — all 8 rows present** ✓; new rows now missing: **N7** |
| 8 | architecture amendment | **APPLIED, HALF THE DIFF** — misses architecture-v2:66: **N4** |
| 9 | retrospective/prose grandfathering | **APPLIED IN WORDS, IMPOSSIBLE AS STATED**: **N5** |
| 10 | ability-emission hook | **APPLIED** ✓ (not idempotent on replay — folded into N1) |
| 11 | type-derived artifact placement | **APPLIED, and more correct than review-4 asked** ✓; the map has no home: **N8** |
| 12 | state the resume rule | **APPLIED, CONFLICTS with flow-control v6:38 and is vacuous for `execute`**: **N6** |
| 13 | execution-order validation | **APPLIED WITH THE ORDER INVERTED** — blocking: **N10** |
| 14 | vocab gate values | **APPLIED, verified** ✓ |
| — | cosmetics | interact 4 verbs ✓ · commit observe-or-record ✓ · **`read` ability/ctx split NOT applied, and it hides a layering hole: N11** |

### The five that landed clean — say so, they are real wins

- **Edit 4 (gate-bound ordering).** Verified: `store.gateProblems` refuses `artifact-locked` unless a `confirmed(gate=grill)` precedes it (`store.ts:571-583`), evaluated on the **prospective** log at every append (`store.ts:462-464`). §3 rule 4 — deferring a gate-bound step's non-gate intents until the gate confirms — is exactly the right shape, and it does unblock `idea-validate` locking its doc. Correct.
- **Edit 5 (supersede).** Verified end-to-end: `supersededLocks` keys the superseded set by the node **carrying** the event (`store.ts:432-446`), `current()` filters lockers by that set (`store.ts:207-212`), `cmdSupersede(id,…)` appends on `id` (`cli.ts:793-796`). The cross-task write is required for resolution to work, and **v13 does not forbid it** — §3/§12 constrain leg roots only (`v13:63,71`; §12:172,182); there is no task-to-task locality rule anywhere in v13. Naming it "the ONLY cross-task write" (§3, §7) is the right call.
- **Edit 11 (placement).** v5's mapping is byte-correct against v13 §15's category table (`v13:227-229` — `docs/specs/`, `docs/system-designs/`, `docs/architecture/`, and `v13:223` *"**No catch-all category.** Everything else is task-local"*). **Review-4's N12 premise was wrong** and v5 correctly rejected it: a `vision` doc has no category in §15, so task-local is the contract-correct answer, and `current()`-based `requiredInputs` resolution works regardless of placement. Good judgment.
- **Edit 14 (vocab gates).** `vocab.json` gates `["grill","confirm"]`, read via `getVOCAB()` (`vocab.ts:28`). §4/§6 now use the real values. Done.
- **Edit 6 (`params` + verdict map).** Both landed where review-4 asked: `params` in `ctx` (§2), `verdict:{decision → {gate, feedback?}}` on the chain entry (§6).

---

## Q2 — NEW soundness holes

### N1 (blocking) — idempotence is defined for ONE of five intents; `propose-spawn` re-run still hard-fails

The owner asked this directly. §2 states: *"`lock-artifact` is a **no-op when `current(name).producer === taskId`**… `evidence`/`propose-spawn` dedupe on the produced fact."* Verified the predicate is derivable: `current()` returns `producer` (`store.ts:207-212,226`). **That half is right and B1 is finally fixed.** The other four are not:

- **`propose-spawn` — NOT idempotent, and it throws.** `store.spawn` refuses an existing id: `throw new Error('spawn rejected: ${id} already exists (node.json immutable — no re-spawn)')` (`store.ts:543`). "Dedupe on the produced fact" is not a predicate; the produced fact is a node, and the code path **raises**. Re-run `spec` (which declares the build-task spawns, §6 flow 1) after a crash → step fails → task unrecoverable. **This is B1 in a different intent.** The predicate must be stated as the same shape as the lock one: *no-op when the node id already exists* — and explicitly NOT contract-equality, because contracts in flow 1 are LLM-generated and non-deterministic (`spec-step.ts`), which is the exact argument that killed sha-equality.
- **`evidence` — the dedup key is undefined for the case that actually occurs.** `commits[].sha` / `refs[]` / `answers[].id` are stable keys, but a **note-only** evidence event has none — and note-only is precisely what the ability hook emits (`executor.ts:105-108`: `{note: 'llm operation — task fact…'}`, no refs). So every replay re-emits one evidence event per LLM call, unbounded. `store.results()` de-dupes them in the *view* (`store.ts:273-278`) but the log grows. §2's "re-running a step is always safe" is false in the no-duplicate-facts sense.
- **`supersede` — no predicate.** Naturally idempotent in effect (`supersededLocks` is a Set, `store.ts:432-446`) but a second `superseded` event lands in an append-only log every replay. State: no-op when the old locker already carries `superseded` with `successor.name === name`.
- **`close` — no predicate.** Duplicate `transferred`/`deferred` events pass the schema and pass F-AC16 (`closureOk` is a boolean, `store.ts:616`), but `check()` re-reports the target problem per duplicate (`store.ts:622-623`).

**Why this is load-bearing, not pedantry:** see N6 — `execute` is the one frame phase with **no tail marker**, so it is always re-run. Idempotence is not a safety net for `execute`; it is the entire mechanism. Defining it for one intent out of five leaves the phase the owner most wants to change freely (the chain) unprotected.

### N2 (blocking) — the v13 amendment enumerates the wrong field set, and the amendment is not a complete change

Two separate problems.

**(a) The field set.** §2 says the v13 §2 contract is *"`intent · acceptanceCriteria · targetAreas · requiredInputs · expectedOutputs`"*. That is the `contract` sub-object only. The **node.json** schema (`v13:23-39`) also enumerates `id`, `openQuestions[]` (with `id · question · blocking · reason · defaultIfUnanswered · affectedTaskIds`), and `createdAt`, and `v13:41` makes `id` and `createdAt` REQUIRED. §1's table row 4 has `spawn!` enforcing *"the enumerated schema + unknown-fields-rejected"* — implemented literally against §2's five-field list, **`spawn!` rejects every valid node.json in the repo**, including the one it just wrote (`store.spawn` writes `{id, contract, createdAt}`, `store.ts:548-551`). This is the row that most needs to be exactly right, because implementing it is the whole point of the amendment. Also note `openQuestions.blocking:true` gates the node (`v13:41`) and is consumed by packet readiness (`context.ts:113`) — it must survive the amendment.

**(b) The amendment is recorded but not scoped.** `v13:164` (§11): *"Amendments = **new nodes** (tasks) whose artifacts **completely supersede** it — reusing the logical name `journey-format-spec` and preserving section anchors — with a back-reference + `superseded` event."* AC-7 (`requirements-spec-v3:44`) and AGENTS.md:43 add **referrer re-pointing**. §8 item 8 says "amendments recorded before implementation" and names neither the superseding artifact (v13 → v14 under the same logical name) nor the referrers. **This is not hypothetical: the repo already has a broken referrer** — AGENTS.md:46 points at `architecture.md (locked @ fcfa661)`, which is architecture **v1**; the live one is `architecture-v2.md (locked @ e6d07ed)`, self-declared *"Complete superseding version"* (`architecture-v2.md:8`). The last amendment skipped its re-pointing. Don't repeat it.

### N3 (blocking) — spawn-time chain validation puts FLOW knowledge in L1, violating the design's own floor rule

§3 rule 5: *"`contract.flow` is validated AT SPAWN (immutable node) AND every resolved chain … at EXECUTE."* Validating at both ends is right (`flow.ts:91,104` re-reads `chains[workType]` at execute; `contract.flow` freezes into an immutable node, `store.ts:543`). **But who does the spawn-time check?**

§1 row 4 puts spawn-time enforcement in **L1 `spawn!`**. `validateChain` needs the **step registry** (`flow.ts:113,119-123`) — an L2 artifact. If `spawn!` validates the chain, L1 imports L2, dependencies point up, and the owner's stated criterion — *"The L0/L1 floor must carry zero flow knowledge"* — is broken by the design's own edit. It also cannot work mechanically: `validateChain(registry, chain, packet)` takes a **packet**, and `assemblePacket` reads `node.json` from disk (`context.ts:88`) — at spawn the node does not exist yet, and after `spawn!` writes it the node is immutable, so a post-write check cannot fail closed.

The clean line, and the exact edit: **L1 validates the contract SHAPE** (v13 §2 + the amendment: `workType` is a string, `flow` is a `string[]`, `model` is a string) — no registry, no chain semantics. **L2 validates the chain's MEANING** (ids registered, execution order, inputs resolvable) against the **prospective contract** *before* calling `spawn!`, and again on the resolved chain at execute. Both fail closed, named. A raw `ann spawn!` with a garbage `contract.flow` then slips past L1 and fails closed at execute — which is correct and already the design's stated behaviour for mutable project data.

### N4 (blocking) — the architecture amendment covers half its own diff

§1 amends architecture @ e6d07ed:24,61. **Citations verified correct** — `e6d07ed` is architecture-**v2**, and lines 24 and 61 are verbatim as quoted, identical in both versions. Two things are missing:

1. **architecture-v2:66 is contradicted and not flagged:** *"**Two enforcement points, non-overlapping:** the store enforces **format invariants** (schema, append-only, immutability, round-gate at data level); the validators (engines) enforce **contract invariants** (ACs declared, inputs resolved, **artifact gate for children**, distance set)."* §1 row 4 moves the **artifact gate, F-AC19 (ACs declared / inputs resolved), and the leg gate** out of the engines and into **L1 `spawn!`**. That is precisely the "non-overlapping split" this line locks. Same doc, same amendment — one more clause.
2. **The amendment resolves a pre-existing contradiction and should say so:** `ann-system-design-v3.md:59` already reads *"Initiators: planner kernel (spawn/expand/commit), **adapters** (binding results as artifacts + evidence events), **validators/reviewer** (evidence events)."* The multi-initiator position is already locked in the system design; architecture v2:24 is the outlier. v5's amendment is a reconciliation, not a novelty — stating that makes it much easier to approve.
3. Name the product: architecture **v2 → v3**, complete superseding artifact, `superseded` event, **and re-point AGENTS.md:46** (which is currently stale at v1 anyway).

### N5 (blocking) — "grandfathered for history only" is not implementable as stated, and it bricks 25 existing nodes

§1 row 1: *"the legacy `retrospective`-note path and prose gate-parse are GRANDFATHERED for history only — the re-implementation removes them from the new write path."*

**There is no "new write path" to remove them from.** `gateProblems` is evaluated over the **whole prospective log** at every append (`store.ts:462-464`), and the two escapes are `store.ts:569` (gate name prose-parsed from `note`) and `store.ts:576` (`retroGrill` — any `confirmed(gate=grill)` whose note contains the substring `"retrospective"` disables the GATE-1 check at `:581`). Remove `retroGrill` and the GATE-1 predicate `firstWork >= 0 && (lastConfirm1 === -1 || lastConfirm1 > firstWork)` fires on every node whose grill confirmation was recorded *after* its work.

**Measured, not hypothetical: 25 nodes in this repo carry `"note":"retrospective: user confirm-all (2026-08-17)"`** — `01-goal`, `02-grilling` (+`01-spec-rework`), `03-tree-format`, `04-system-design` (+2 tasks), and 17 tasks under `05-engine`. After removal, **every append to any of them throws**, and `ann check` reports 25 permanent GATE-1 GAPs. That includes the AC-7 path: `supersede` writes on the **old locker** (N-Q1 edit 5), and the old lockers of `requirements-spec`, `flow-control-spec`, `architecture`, `ann-system-design` are exactly these nodes.

The repo already has the mechanism for this and v5 doesn't use it: F-AC18 and F-AC19 grandfather by **date cutoff** (`V9_CUTOFF = '2026-08-21'`, `store.ts:630,636,648`), not by note-text. State the same shape: **the prose paths are removed; the GATE-1 check applies to nodes with `createdAt >= <cutoff>`** (or: to events appended after the cutoff). Otherwise do not claim the unconditional L0 gate guarantee — it is the design's strongest sentence and as written it takes the repo's own journey offline.

### N6 (blocking) — the resume rule contradicts the locked rework routing, and is vacuous for the one phase that needs it

§1: *"**the resume point is DERIVED from the event tail — never stored**: a phase whose outcome already exists in the log is SKIPPED… a gate whose decision is already in the tail is not re-obtained."*

**(a) It contradicts flow-control v6.** `flow-control-spec-v6:38`: *"**Resume point is decided by the feedback — never `activate`.**"* Two different rules for the same situation, and §1's is stated absolutely. Read literally, §1 breaks rework: after a `rejected(grill)`, a decision **is** in the tail, so the gate "is not re-obtained" — but v6:36 requires re-materialize → re-validate → **back to GATE①**. Review-3 blocked (B3) on exactly this routing; v5 restored it in §4 and then overrode it in §1.

The correct statement distinguishes three tail states, all derivable: **last event at the gate is `confirmed` → skip · a `submitted` with no later decision → block and wait (this is what `store.ts:179-183` already derives as `blocked`) · last is `rejected` → the locked rework rung runs and the gate IS re-obtained.** Crash-resume derives from the tail; rework routes from the feedback. Both, named separately.

**(b) It is vacuous for `execute`.** Walk the phases: `activated` in the tail → skip ✓ (`store.ts:162-164`). `completed` → skip ✓. Gates → per (a). materialize/verify/look-back/advance are pure. **`execute` has no tail marker at all** — an empty chain (flow 2) writes nothing, and a step whose only output is note-only evidence writes nothing stable (N1). So execute is *always* re-run, which is what `requirements-spec-v3:87` already prescribes (*"Crash/kill → resume from checkpoint; **node restarts with the same context packet + evidence**"*). Say it: **execute is never skipped; its safety rests entirely on intent idempotence.** That sentence is what makes N1 blocking rather than cosmetic.

### N7 (blocking) — the ownership table is complete against review-4 and now short on six new rows

Verified row by row against the code — **all 8 of review-4/N7's rows are present**, and each is true: artifact gate (`cli.ts:704-707`), leg gate (`cli.ts:714-716`), F-AC19 (`cli.ts:723-728`), id naming/prefix/sibling (`cli.ts:696-712`), one-current (`cli.ts:773-776`), node.json strict schema (unenforced — `store.ts:542-556` writes whatever it is handed; `contractProblems` checks items 1–3 only, `store.ts:242-260`), F-AC16 (`store.ts:604-625`, `check()` only), F-AC18 (`store.ts:626-642`, `check()` only). Good.

Six invariants that are now load-bearing and have no row:

| Invariant | Where it would live | Note |
|---|---|---|
| artifact **placement** (v13 §14/§15) + which path is recorded | **L2 convention, no enforcer** | `v13:74`: *"**`path` is the task-local ref** — a symlink into `docs/` … or the real file in `artifacts/`"*. v5 §3 rule 7 never says the **recorded** path is the task-local symlink path. Get it wrong and `check()`'s existence test (`store.ts:659`) and `current()` (`store.ts:218-223`) both drift. |
| **cross-task write permission** | stated in §3/§7, **not a table row, not enforced** | L1 commands take an arbitrary id; nothing stops any client writing any kind on any node. It is a convention — say so in the table's convention row. |
| **gate SET vs gate POSITIONS** | vocab data / locked lifecycle | see Q4 — the single most misleading "adjustable" surface in the design. |
| **intent idempotence** (all five) | L2 convention | N1. |
| the **reject-bound threshold** visible to L2 | L1 read, not an L2 constant | see Q3-2. |
| the resolution **ladder rung enablement** | `rules/decide/rules.json` (registry data) vs code | see Q4. |

### N8 (blocking, small) — type-derived placement has no registry home, so a new artifact type is a code change

§3 rule 7 derives placement *"per the vocab artifactTypes"*. **`vocab.json` has no placement data** — `artifactTypes` is a flat string array (`["spec","system-design","architecture","record","vision","validation"]`). The type → `docs/<category>/`-or-task-local mapping therefore lives in code. Adding a project artifact type (vocab is registry data; resource-registry-spec-v2:26 — *"A layer that needs a rule **reads** it — it never carries its own copy"*) forces a code edit to teach the flow where it goes. Fix in one line of data: give each entry a category (`spec → docs/specs/`, …, `vision → task-local`) and have the flow read it. This is the same class of defect review-2 raised and v5 has now fixed everywhere except its own new mechanism.

### N9 (completeness) — the verdict map has two undefined cases

`verdict?: { decision → {gate:'accept'|'reject', feedback?} }`. Undefined: (a) a **gate-bound step that returns no `verdict` at all** — §2 covers "an unmapped decision → fail closed", not a missing one; (b) the entry's static `feedback?` vs `out.verdict.feedback` — **which reaches `rejected.feedback`** (the rework channel, `store.ts:485,496-498`)? Pick: the step's feedback wins, the map's is the fallback. Two sentences.

### N10 (blocking) — §4 states the execution order backwards

§4, execute phase: *"run the chain's at:'execute' steps in EXECUTION ORDER (**phase order: grill-bound, then confirm-bound, then execute entries in list order** — review-4 N14)"*.

**Confirm-bound steps run at GATE·confirm, which §4's own frame places AFTER execute** — and so does `flow-control-spec-v6:16-19` (`… → execute → verify → [GATE② confirm] → commit`). The correct execution order is **grill-bound → execute entries in list order → confirm-bound**. As written, `validateChain`'s "earlier" (`flow.ts:124-131`) would accept an `at:'execute'` step consuming a confirm-bound step's artifact — a forward reference at run time, which is the exact bug N14 existed to close, inverted. This is a one-word fix and it is blocking because it is the rule the validator will be built from.

### N11 (blocking, small) — `read.resolve` reads artifact files without going through L1

§1: L1 is *"THE STORE'S INTERFACE — the **ONLY** path to the store"*, and L0 STORE holds *"artifacts (locked files)"*. §1 lists the read view as an **L3 ability**; §2 puts `read` beside `abilities`; §5 has `read.resolve(name) → {content, path, sha}` returning **full file content**. So artifact content — L0 data — is read by an L3 servant that never touches L1. Either the "only path" claim is false for artifact content, or `read.resolve` is an **L1 derived read** (it is exactly `current()` + a bounded file read; `current()` is already L0, `store.ts:207`) that L2 injects into ctx. Take the second: it also gives the input-binding rule (§5) one enforcement site instead of trusting a servant.

Review-4 raised the ability/ctx split as cosmetic; it is not — it is the seam where the layering claim is decided.

### N12 (blocking, small) — `abilities.command` collides with L1 COMMANDS by name

§2: `abilities { llm · interact · tool · command }`; §8 item 7: *"tool/command protocol-declared, unbuilt"*. L1 is literally named **COMMANDS** and §1 says the flow *"binds them to its logic"*. An implementer reading §2 will wire `abilities.command` to the L1 command surface — and then **a step can write to the store**, silently defeating §7's *"steps never write files or events directly"* and *"steps never see the store"*. Today the collision is inert (`executor.ts:113-117` returns an `unbuilt` guard), so this is free to fix now and expensive to fix later. Rename the ability (`shell` / `exec` / `process`) or state in one clause that `abilities.command` is an OS-process ability and is **never** the L1 command surface.

### N13 (completeness) — `prior` is unbound while `read.resolve` is bound

§5 binds `read.resolve` to `inputs[] ∪ requiredInputs`, justified as *"the packet stays the honest picture of what the task consumed"*. §2's `prior` — *"earlier steps' artifacts — a locked artifact is automatically **available downstream**"* — carries no such bound. Two content channels, one honest, one not: a step can consume `prior['envision']` without declaring `envision` in `inputs[]`, and chain validation (`flow.ts:125-137`) never sees the dependency. Bind `prior` to `inputs[]` too — then §5's "ONE content mechanism" claim becomes true, and the F-AC19 grounding argument covers both.

Also unstated (one clause): on a no-op'd lock, the flow resolves `prior` from the **name declared in that step's own `lock-artifact` intent** — that is the only mapping from step id to locked artifact.

### N14 (completeness) — `append!`'s refusal list omits `created`

§1: *"`append!` REFUSES event kinds owned by composite commands (`submitted`/`confirmed`/`rejected`/`artifact-locked`/`superseded`)"*. `created` is owned by `spawn!` (`store.ts:553-555`) and is not in the list, so a second creation record can be appended to an existing node. Add it. (`extended` is genuinely generic — v13:78 *"`extended` / `evidence` annotate only"* — and is correctly reachable via `append!` only; worth one clause saying so, since no intent declares it.)

### N15 (completeness) — the builtin fallback chain is code-side step ids that can silently break

`BUILTIN_CHAIN = ['validate','envision','spec']` (`flow.ts:24`) applies when there is no project file, and `chains.default` applies when a task declares no `workType` (`flow.ts:98,104`). v5 §6's sample data drops the `default` key and **renames `validate` → `idea-validate`** (§8 item 5). A `workType`-less task then falls to `BUILTIN_CHAIN`, which names a step id that no longer exists → named chain problem at execute → the task cannot run. The design issue behind the flow content: **a code constant holds step ids that must stay in sync with the registry and the data.** Make the builtin fallback the **empty chain** (lifecycle only) — always valid, never referencing a code-side id, and it is already the design's stated "general case" (§4, flow 2). One less coupling, zero loss.

---

## Q3 — Simplicity: is this the smallest sound core?

**Structurally, yes — and v5 is the best version so far.** Three layers plus servants, five intents, one write path, chains as data, the gate source *is* the chain, `inputs[]` + `read.resolve` collapsed, no second routing schema. I would defend this shape unchanged. The remaining weight is small and specific:

1. **Two constants for one bound (unfixed).** §1 gives `gate!` (L1) the 3-reject bound and says *"L2 observes the count only to route escalation (one owner, one reader)"*. To **route** on a count, L2 must compare it to a threshold — so L2 gets its own `3`. That is today's state exactly: `cli.ts:755` (`rejects >= 3`) and `kernel.ts:88` (`REJECT_BOUND = 3`), two constants, verified. The fix is one word: L1 exposes an **escalation-derived read** (`{grillRejects, confirmRejects, escalated}` — `kernel.ts:211-215` already computes it, it just lives on the wrong side); **L2 reads a boolean, never the threshold.**
2. **Two gate-sequence enforcers.** `store.gateProblems` (L0, prospective log, `store.ts:584-591`) and `cmdGate`'s own check (`cli.ts:747-750`). The table assigns gate sequence to L0; the re-implementation should drop the L1 copy. One line in §8.
3. **The ladder is registry data the design treats as code.** `rules/decide/rules.json` holds all five rungs as data. §4 hardcodes *"v1 ships ONLY the block rung"*. Enabling `ask` is therefore a code change. See Q4.
4. **`type?` on `lock-artifact` is finally load-bearing** (§3 rule 7) — good, that was three revisions of dead weight. Now give it data to read (N8).

**Can a step still reach the store?** Two live reach-throughs, both nameable in one line each: **`abilities.command`** (N12) and **`read.resolve`** (N11). `ctx.store` and `recordEvidence` are correctly gone (`step.ts:43,49` today; deleted in §2).

---

## Q4 — The line between adjustable and protected

The table plus §4's "the reject bound is a CONSTANT" plus §6's closing line is a coherent line, and it correctly attributes the strongest guarantees to L0. Row-by-row it is **true** against the code, with N5's exception. What is wrong is on the edges:

**Wrongly adjustable-looking (the worst one, and new):** **`vocab.json.gates`**. It is registry data, read via `getVOCAB()`, and `validateEventShape` accepts any value in it (`store.ts:493-494`). So adding `"design-review"` to the array looks like a supported data change. It is not: `gateProblems` hardcodes the grill/confirm sequence (`store.ts:574-591`), `detail()` hardcodes `gates: {grill, confirm}` (`store.ts:370`, typed at `:42`), `reworkStatus` hardcodes both names (`kernel.ts:211-214`), and §4's frame has exactly two gate phases. **A new gate value produces a gate no phase obtains and no rule covers — silently.** This is correct-as-protected (flow-control v6:34 locks both gates HARD on every node in v1, and §2's lifecycle is locked), but the design must say it: **the gate SET and the gate POSITIONS are protected by the locked lifecycle; only the gate SOURCE is data.** One row.

**Wrongly hardcoded:**
- **The resolution ladder.** `rules/decide/rules.json` holds all five rungs with no enablement flags; §4 ships only `block` by code decision (`kernel.ts:162-167`). resource-registry-spec-v2:63: *"Registry integrity is itself a check: **every consumed rule exists in a registry; no hardcoded rule outside it**"*, and :26 *"A layer that needs a rule reads it — it never carries its own copy."* Either put `enabled` flags in the decide registry and read them, or record the deferral explicitly against §4 and the registry. Right now the registry says five and the engine does one, with nothing reconciling them.
- **Artifact placement** (N8).

**Wrongly unprotected:** node.json strict schema — still true (`store.ts:542-556`), and v5's fix is the right one, modulo N2(a).

**Correctly protected:** 3-reject bound (flow-control v6:39 — *"3 rejection cycles per gate"*, verified), rework rungs (v6:36-37), gate existence (v6:34), gate sequence, single writer, lifecycle phase order.

**Correctly adjustable:** chains, work types, gate source, verdict maps, params, `contract.flow`. Verified sound today: unknown `workType` is a **named** problem the kernel refuses (`flow.ts:97-102` → `kernel.ts:239-241`), chains cannot encode a loop (`flow.ts:113-146`), `store.ts` carries zero flow/work-type/step knowledge, leg roots refuse events at the writer (`store.ts:453-455`).

---

## Q5 — Are the two recorded amendments the COMPLETE set?

**No. Two more contract changes are required and unflagged, and one recorded amendment is half-scoped (N4).**

**(3) resource-registry-spec v2 — the `schema` registry category does not exist.** `resource-registry-spec-v2:36` enumerates the categories: *"`ask | check | decide | adapter | flow | binding | surface`"*, and the §4 instance table (`:51-57`) adds `user-config` only. **`vocab.json` declares `"category": "schema"`** and `vocab.ts:6` calls itself *"instance #2"*. v5 builds **two** mechanisms on this registry — gate naming (§4, edit 14) and artifact-type placement (§3 rule 7, edit 11) — i.e. the two edits review-4 was most right about now stand on a registry that the locked registry spec does not admit. Amendment: add `schema` to the category enumeration and the instance table. Cheap, and it must be recorded before the two edits are legitimate.

**(4) flow-control v6 §7 — v5 describes the locked table incorrectly and drops four of its five columns.** §6: *"v1 collapses flow-control v6 §7's work-type table to its **CHAIN column** (which steps run)."* **There is no chain column.** The columns are `Work type | Materialize | Missing input | Verify | Chain effect` (`flow-control-spec-v6:80`), and *"Chain effect"* means what spawns next (`specs spawn after`, `commit → next frontmost`), not which steps run. v6:78 states the table's purpose: *"Work types parameterize the common skeleton (materialize / missing-input / verify / chain effect)"* — only the *artifact* guidance was downgraded in v6, not the parameterization. So v5 is not collapsing to a column; it is **implementing none of the four and inventing a fifth**. The design decision may well be right (chain-effect → `propose-spawn` intents; the rest → the runner, S6), but state it accurately as a **recorded deferral against v6 §7**, not as a collapse. As written it will be read as conformance.

**Not amendments, but owed:** referrer re-pointing for both recorded amendments, and AGENTS.md:46's stale architecture pointer (N2b/N4).

**Verified NOT violated** (so the design can claim these): context-packet-spec — §3:65 *"`sourceType` is always `derived-from` (resolution via current()). No inference, no probing in v1"* and §4:75 *"`observation` — probed from git/files, **unused in v1**"* make §5's provenance claim exactly right, and §4:73-74's bounds are unaffected because the packet never carries content. v13 §14/§15 — placement is correct (Q1 edit 11). v13 on cross-task appends — silent, therefore permitted (Q1 edit 5). requirements-spec AC-3/AC-7 — served.

---

## Q6 — Lock verdict

# LOCK AFTER the edits below.

The architecture is right and I would defend it as-is: L0–L3, one write path, steps as pure units, intents translated by the flow, chains as data, gates as observed L1 writes, the gate source *is* the chain, and — new in v5 and correct — gate-bound intent deferral, producer-based lock idempotence, supersede on the old locker, and type-derived placement that reads v13 §15 better than review-4 did. Five of fourteen edits landed clean and the ownership table is now complete against review-4. This document is close.

What stops the lock is that **three of the edits changed the design's shape and the new shape has holes**, and one edit is stated backwards:

- **The order in §4 is inverted** (N10) — the validator would be built from a wrong rule.
- **Spawn-time chain validation breaks the floor rule the owner set** (N3) — L1 would import L2, and it cannot work mechanically anyway.
- **"Grandfathered for history" cannot be implemented as written and takes 25 of this repo's own nodes offline** (N5) — measured, not predicted.
- **Idempotence covers one intent of five, and `execute` is the phase that can never be skipped** (N1 + N6) — these two are one defect: the safety net is the only net, and it has four holes.

Everything else is a sentence or a field. None of this is a re-architecture.

### Blocking (12)

1. **Fix the execution order.** §4: grill-bound → **execute entries in list order** → confirm-bound. `validateChain`'s "earlier" means that order. Confirm-bound steps run at GATE·confirm, after execute (§4's own frame; `flow-control-spec-v6:16-19`). *(N10)*
2. **Split spawn-time validation across the layer line.** L1 `spawn!` validates the contract **shape** only (v13 §2 + the amendment). L2 validates the chain's **meaning** against the prospective contract before calling `spawn!`, and again on the resolved chain at execute. Say the floor carries no step-registry dependency. *(N3)*
3. **Define idempotence for all five intents, by predicate:** `lock-artifact` → `current(name).producer === taskId` ✓ (keep); **`propose-spawn` → the node id already exists** (NOT contract equality — `store.ts:543` throws today); `supersede` → the old locker already carries `superseded{successor.name}`; `close` → the same closure event is already in the tail; `evidence` → keyed on `commits[].sha` / `refs[]` / `answers[].id`, and **say what happens to note-only evidence from the ability hook on replay** (`executor.ts:105-108`). *(N1)*
4. **State that `execute` is never skipped**, and that intent idempotence — not tail-derivation — is what makes replay safe there. Cite `requirements-spec-v3:87` (*"node restarts with the same context packet + evidence"*). *(N6b)*
5. **Restate the resume rule in three tail states** and stop overriding the locked rework routing: last-at-gate `confirmed` → skip; `submitted` undecided → block and wait (`store.ts:179-183`); last `rejected` → the locked rung runs and the gate IS re-obtained (`flow-control-spec-v6:36-38`). *(N6a)*
6. **Give the prose-path removal a cutoff.** Use the mechanism the repo already has (`V9_CUTOFF`, `store.ts:630,636,648`), not note-text. Without it, removing `retroGrill` (`store.ts:576,581`) makes **25 measured nodes unwritable** and `ann check` permanently red — including every old locker the AC-7 supersede path must write to. Then the unconditional L0 gate claim is safe to keep. *(N5)*
7. **Fix the v13 amendment's field set:** the node.json schema `spawn!` enforces is `id · contract{intent, acceptanceCriteria, targetAreas, requiredInputs, expectedOutputs, + workType, flow, model} · openQuestions[] · createdAt` (`v13:23-41`), not the five contract fields. `openQuestions.blocking` must survive (`v13:41`, consumed at `context.ts:113`). *(N2a)*
8. **Scope both amendments as complete changes:** journey-format v13 → v14 and architecture v2 → v3, each a complete superseding artifact under the same logical name + `superseded` event + **referrer re-pointing** (`v13:164`, AC-7, AGENTS.md:43) — and fix AGENTS.md:46, which still points at architecture v1 @ fcfa661. *(N2b, N4.3)*
9. **Extend the architecture amendment to architecture-v2:66** — the "two enforcement points, non-overlapping" split assigns the artifact gate and contract invariants to the **validators**; §1 row 4 moves them to L1. And note the amendment *reconciles* `ann-system-design-v3:59`, which already lists multiple initiators. *(N4.1, N4.2)*
10. **Record the two missing amendments:** resource-registry-spec v2 — add `schema` to the category enumeration (`:36`, §4 table) or the vocab registry that edits 11 and 14 stand on is out of contract; and flow-control v6 §7 — state accurately that v1 implements **none** of the table's four parameterization columns (there is no "chain column", `:80`) and record it as a deferral. *(Q5)*
11. **Disambiguate `abilities.command`** — rename it (`shell`/`exec`) or state it is an OS-process ability and never the L1 command surface. Otherwise a step gets a write path by naming accident. *(N12)*
12. **Make `read.resolve` an L1 derived read** injected by L2, not an L3 servant reading L0 files — or drop the "L1 is the ONLY path to the store" claim. Pick one; §1/§2/§5 currently say all three things. *(N11)*

### Required for completeness (7)

13. **Give the artifact type → placement mapping a registry home** (a category field per `vocab.json.artifactTypes` entry). Today a new artifact type is a code change. *(N8)*
14. **Say which path is recorded in `artifact-locked`** — the task-local ref (the symlink for shared types), per `v13:74`. `check()` and `current()` both depend on it (`store.ts:659,218-223`). *(N7)*
15. **Add six rows to the ownership table:** artifact placement + recorded path (L2 convention, no enforcer) · cross-task write permission (convention) · **gate SET and POSITIONS protected, gate SOURCE adjustable** · intent idempotence (L2 convention) · reject-bound threshold as an **L1 read**, not an L2 constant · ladder rung enablement. *(N7, Q3-1, Q4)*
16. **Bind `prior` to `inputs[]`** like `read.resolve`, and say the flow resolves it from the name in the step's own `lock-artifact` intent. *(N13)*
17. **Close the verdict map:** a gate-bound step returning no verdict → fail closed, named; step feedback wins over the map's static `feedback?`. *(N9)*
18. **Add `created` to `append!`'s refusal list**; say `extended` is reachable via `append!` only (no intent declares it). *(N14)*
19. **Make the builtin fallback the empty chain**, so no code constant holds step ids. *(N15)*

### Cosmetic

- §1 lists the read view under L3 abilities; §2 puts `read` beside `abilities`; §5 describes it as a view. Pick one (edit 12 decides it anyway).
- §8 item 1: say the re-implementation **drops** `cmdGate`'s duplicate gate-sequence check (`cli.ts:747-750`) — L0 owns it.
- Sweep the dangling AC citations when re-implementing: no `AC-4` in `src/` resolves to `requirements-spec-v3:41` (`flow.ts:18` labels AC-3's content as AC-4), and `functional-spec.md:44` cites **AC-8**, which does not exist (ACs stop at AC-7).
- `ann-system-design-v3.md` is titled "Ann System Design (v2)" internally (`:7`). Not this design's problem; worth one issue.

---

## What I am not sure of

- **Whether N5's cutoff should be by `createdAt` or by event position.** `createdAt` matches the existing F-AC18/19 precedent and is trivially derivable; event-position ("events appended after date X") is more honest but needs an `at`-ordering assumption that `F-AC14` explicitly rejects (*"events are ordered by append order, never by `at`"*, `v13:117`). I lean `createdAt`; the owner should pick.
- **Whether `propose-spawn` re-run is actually reachable in flow 1.** It requires `spec` to re-run after having spawned. I did not trace a concrete crash-and-resume path through `spec-step.ts` — the failure is derived from `store.ts:543` throwing, which is certain, and from execute being always re-run (N6b), which follows from the design's own text rather than from an observed run.
- **Whether the `decide` registry's ladder was ever intended to be consumed.** `rules/decide/rules.json` has no `enabled` flags and no consumer in `src/`; it may be documentation-shaped registry data rather than config. If so, Q4's ladder point shrinks to a wording fix. Nothing in resource-registry-spec-v2 distinguishes the two, and `:67` (*"the registry holds definitions + config, not implementations"*) reads both ways.
- **Whether the gate-bound step locking its artifact before `activated` matters.** Under §3 rule 4 + §4, `idea-validate`'s doc locks during the GATE·grill phase, so the task carries `artifact-locked` while its derived status is still `queued` (no `activated` yet — `store.ts:162-164`). Legal under every check I read, and `frontmostReady` accepts `queued` (`kernel.ts:121`). It looks odd and may be fine.
- **I did not run the flow end-to-end** — no provider is configured in this repo (`spec-step.ts` defers the live run). Everything above is contract-and-code reading plus the 169-test suite, which I ran and which passes.
