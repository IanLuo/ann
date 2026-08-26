# Design Review v4 — the core re-design (fourth pass)

*Reviewed against the locked contracts (journey-format-spec v13 @ 699615a, flow-control-spec v6 @ 5898f89, requirements-spec v3 @ 80eeaae, functional-spec @ 9e60cd8, context-packet-spec @ ad8b2fd, **architecture @ e6d07ed**, ann-system-design v3 @ 2b0a30f, resource-registry v2 @ 4f95b5a, `vocab.json` v2) and the current `src/` (169 tests pass, verified). Every claim below was checked against contract text or code; file:line or §-quote given. Owner priority applied: **is the DESIGN sound so that later FLOW changes are sound** — flow content is not the subject.*

---

## Q1 — Were review-3 edits 1–14 (+ cosmetics) applied?

**11 applied and verified · 1 applied with a wrong predicate · 1 applied but scoped wrong · 1 cosmetic not applied.**

| # | Edit | Verdict |
|---|---|---|
| 1 | B1 chain re-run semantics | **APPLIED, WRONG PREDICATE** — see N1 |
| 2 | B2 specify the routing data | **APPLIED — and well** (routing IS the chain), with two schema holes: N6 |
| 3 | B3 restore locked rework routing | **APPLIED, verified** |
| 4 | B4 put `activate` back | **APPLIED, verified** |
| 5 | B5 invariant-ownership table | **APPLIED — incomplete and one row overstated**: N7, N8 |
| 6 | M2 read-view provenance | **APPLIED, verified correct** |
| 7 | M4 closure `close` intent | **APPLIED for closure; `superseded` still has no declarer**: N5 |
| 8 | M1 say what a work type is | **APPLIED, verified** |
| 9 | M3 name the resolution ladder | **APPLIED, verified** |
| 10 | M8 bind `read.resolve` to inputs | **APPLIED, verified** |
| 11 | M6 validate chain at spawn | **APPLIED, SCOPED WRONG** — see N3 |
| 12 | ordering rules stated as rules | **APPLIED** (reject, not reorder) — a third instance is missing: N4 |
| 13 | state the frame's driver | **APPLIED**; the actual resume rule is still unstated: N13 |
| 14 | chain entries carry params | **APPLIED in the schema, NOT in the step contract**: N6a |
| — | cosmetics | RESUMABLE ✓ · L0–L3 ✓ · `idea-validate` rename ✓ · AC-3 ✓ · `request` dropped ✓ · BUILTIN seed/fallback ✓ · **gate values NOT applied**: N10 |

Detail on the four that did not land clean:

**Edit 1 (B1) — the predicate does not cover the actual failure.** §2: *"`lock-artifact` whose content sha equals the current lock is a **no-op**, not a refusal."* Verified against the code this replaces: `cmdLock` refuses any already-current name (`cli.ts:773-776`); `current(name).sha` is `artifact.lockSha` (`store.ts:224`). **Sha-equality is true only for byte-identical re-runs.** Every content step in the design is LLM-backed and non-deterministic — `EnvisionStep` (`envision-step.ts:40-48`), `SpecStep`, the idea-validation session. Re-run `envision` after `spec` fails: the LLM returns different prose → different sha → *not* a no-op → refusal → step fails → the task is unrecoverable. B1's exact scenario survives v4 verbatim. The correct predicate is derivable and already in the store: **`current(name).producer === taskId` ⇒ no-op** (`store.ts:212,226`) — "this task already locked this name," which is a fact of the tail, not of the bytes. See N1.

**Edit 5 (B5) — the table is the right artifact and the strongest thing in v4, but it is incomplete and row 1 is overstated.** See N7/N8.

**Edit 11 (M6) — right fix, wrong scope.** §3 rule 4 says chain validity is validated *"AT SPAWN … not at execute."* That is correct for `contract.flow` (written into an immutable `node.json`, `store.ts:543`; v13 §2: *"IMMUTABLE — written once at spawn"*). It is **wrong for the primary flows-as-data path**: `chains[workType]` lives in `.ann/rules/flow/default.json` and is re-read at execute (`flow.ts:91,104`), so it can change after any task is spawned. Validating it at spawn validates nothing. See N3.

**Edit 14 — `params?` is in the chain schema and has no channel to the step.** §6 chain entry is `{id, params?, at?}`; §2 `ctx = {taskId, packet, read, abilities, prior, feedback?}`. There is no `params` in `ctx`. The parameterization added to satisfy review-3 cannot reach a step. See N6a.

**Cosmetic not applied.** Review-3: *"Name the gate values concretely (`grill`, `confirm` — vocab data, `vocab.json:31-34`)."* v4 instead invented `at: 'gate1' | 'gate2' | 'execute'` (§6). `vocab.json` gates are `["grill","confirm"]` and the vocab is a **registry** (`vocab.ts:8-11`; resource-registry-spec v2 line 20: *"CONSUMERS (read the registry; never duplicate, never hardcode)"*). The chain data now names gates in a second, code-side vocabulary. See N10.

---

## Q2 — NEW soundness holes: what still forces a code change, or breaks, when flows change as data?

**First, what is genuinely sound and should be claimed.** Chains keyed by work type, per-task `contract.flow` override, empty chain = lifecycle only, unknown work type = named problem and the kernel refuses (`flow.ts:83-107`, `kernel.ts:239-241`); chains cannot encode a loop (`validateChain` rejects unregistered ids, forward references, duplicates — `flow.ts:113-146`); `store.ts` carries zero flow/work-type/step knowledge; leg roots refuse events at the writer (`store.ts:453-455`). All verified, all covered by the 169 passing tests. **v4's gate-source-as-chain-binding is a genuine design win** — it answers B2 by *deleting* a mechanism rather than adding one: there is no second routing schema, the chain IS the routing. That is the right instinct and the right shape.

Now the holes.

### N1 (blocking) — the idempotence predicate is wrong; B1 is not fixed

Covered above. Consequence for the owner priority: the failure probability scales with chain length, and chain length is the thing meant to change freely. **Also unstated:** what a no-op'd lock does to `prior`. If `envision` re-runs, no-ops its lock, and returns *fresh* content, downstream `spec` grounds on content that differs from the locked artifact — a silent divergence between what the task consumed and what the journey records. The producer-based predicate plus "on a no-op, `prior` resolves from the locked artifact" closes both.

### N2 (blocking) — the design's primary data seam is not in the locked node.json schema

`contract.workType` selects the chain (`flow.ts:93`), `contract.flow` overrides it (`flow.ts:86`), `contract.model` wires the model (`kernel.ts:376`). journey-format-spec v13 §2 **enumerates** the contract — `intent · acceptanceCriteria · targetAreas · requiredInputs · expectedOutputs` — and then states: *"**IMMUTABLE** — written once at spawn; **strict schema; unknown fields rejected.**"* (v13:43). `workType`, `flow` and `model` are unknown fields under that schema.

Worse for the design target, v13 §2 item 7 says work type *"**SHOULD be determinable from intent** (validate / envision / spec / implementation / binding / closure — flow-control §7)"* — i.e. the locked format deliberately carries **no** workType field.

This works today only because the node.json strictness is **unimplemented**: `store.spawn` writes whatever JSON it is handed (`store.ts:542-556`); `contractProblems` checks items 1–3 only (`store.ts:242-260`). So the invariant exists in the contract, has no enforcing layer, and the moment someone implements it — the obvious "make the design true" move — every task carrying `workType`/`flow` becomes unspawnable. v4 does not flag this anywhere. This is the single biggest unflagged risk to *flows-as-data*, because it sits on the field that selects the flow.

### N3 (blocking) — spawn-only chain validation drops the check that matters

Covered in Q1/edit 11. Two chain sources, two lifetimes: `contract.flow` is frozen at spawn; `chains[workType]` is mutable project data read at execute. v4 validates the frozen one and drops the check on the mutable one. Removing the execute-time check is a regression against `kernel.ts:242-245` — and it fails *unnamed*: `this.registry.get(id)` sits **outside** the try/catch in the chain loop (`kernel.ts:264-270`), so a typo'd step id in edited project data throws out of `execute()` instead of producing a named blocker. The rule must be **both**: `contract.flow` at spawn (immutable, fail closed) **and** every resolved chain at execute (project data is mutable, fail closed).

### N4 (blocking) — a gate①-bound step cannot lock its own artifact, and flow 1's does

`store.gateProblems` refuses `artifact-locked` when no `confirmed(gate=grill)` precedes it (`store.ts:571-583`), enforced on the prospective log at every append (`store.ts:462-464`). A step bound to `at:'gate1'` runs *to produce* the grill decision, so its intents are translated *before* the gate is written. If that step declares `lock-artifact`, the store refuses and the step fails — correctly, unrecoverably, and for a reason no rule in v4 states.

This is not hypothetical: v4 §6's flagship flow binds `idea-validate` to gate①, and that step's whole product is the idea-validation **doc** that "guides envision/spec" (`validate-step.ts:20-35` — its co-located rule *requires* a doc with verdict + guidance). v4 §3 states two ordering rules (lock-before-spawn, supersede-before-lock) and misses the third one its own new mechanism creates: **a gate-bound step's non-gate intents are translated only after the gate decision is written** (or: a gate-bound step may declare no `lock-artifact`). Same class as review-3 edit 12; same "inconsistent rigor" failure.

### N5 (blocking) — `superseded` has no declarer, and AC-7 needs a cross-node write

§3's intent table has four intents; §3's "not step-declarable" list is lifecycle + gates. `superseded` is in **neither**. §1 lists `supersede!` as a command and §3 rule 3 says the flow does supersede-before-lock — but nothing says who *decides* a supersession or how a step asks for one.

It gets sharper: the `superseded` event must be appended to the **old locker's** node, not the running task — `supersededLocks` keys the superseded set by the id carrying the event (`store.ts:432-446`), and `current()` filters lockers by that set (`store.ts:207-212`); `cmdSupersede(id, …)` appends on `id` (`cli.ts:793-796`). So AC-7 requires the frame, while executing task B, to write an event on task A's log. Nothing in v4 says the frame may write outside the current task.

v4 §6 claims *"AC-7 amendments … are served by the command surface + flow data — stated, reachable."* Against AC-7 as locked (requirements-spec-v3:44 — *"amendment node → complete superseding artifact under the same logical name; the old artifact stays byte-identical with a `superseded` event; referrers resolve to the new current"*), it is **not reachable** through the stated intent vocabulary. This is review-3's M4 half-closed: `close` landed, `supersede` did not.

### N6 (blocking) — the chain schema is incomplete for its own claims

Two slots the design relies on and does not define:

- **(a) `params?` has no channel.** §6 puts `params?` on chain entries; §2's `ctx` has no `params`. A step cannot read them.
- **(b) The verdict→gate decision map has no home.** §2: *"the flow routes it per the gate-source data — never reads step internals"*; *"A verdict decision value the routing data doesn't map → fail closed, named."* §3 rule 5: *"Verdict → `gate!` mapping is validated statically."* But §6's chain entry is `{id, params?, at?}` — **there is no mapping field**. The decision vocabulary is open (`solid|revise|reject` today, `validate-step.ts:32`) and `gate!` takes `accept|reject` (`cli.ts:740`). Where the map lives is exactly what review-3 B2 said must not be left to implementation, and it has been left to implementation.

### N9 (blocking, one line) — an unflagged amendment to the locked architecture

architecture @ e6d07ed, line 24: *"**Who writes:** ONE function owns the write — the store's single `appendEvent()` API is the only writer …; **the kernel is the only *initiator* (planner-only); nobody else touches event files.**"* Line 61: *"only the kernel appends …; engines/adapters/surface *propose*, the kernel materializes."*

v4 §1 makes L1 a multi-client surface — *"The CLI binds commands to argv; the flow binds them to its logic; a future web server binds them to HTTP"* — and §4 makes the runner's own `append! evidence.commits[]` **"the general case, not an exception."** The single-**writer** invariant survives (commands still end at `appendEvent`). The single-**initiator** statement does not. The current code already drifted this way (`cli.ts:916-927`), which is precisely why the re-implementation contract must say so. Review-3 blocked (B3) on an unflagged amendment to flow-control §3; the same standard applies here.

### N7 / N8 — see Q4.

### Completeness-level (not blocking, but they get invented if unwritten)

- **N10 — two gate vocabularies.** `at:'gate1'|'gate2'` vs `vocab.json` `grill|confirm`. Use the vocab values; they are registry data and the routing data should reference real values (review-3 asked for exactly this).
- **N11 — ability-emitted evidence was deleted with no replacement.** §2: *"No `ctx.store`, no imperative write hook."* Today the llm executor emits an evidence event *per call* (`executor.ts:103-109` → `kernel.ts:388-395`) — the architecture's two-log trace, and the only durable trace a bounded multi-round session leaves before it returns. Under v4 a 3-round idea-validation session that crashes on round 3 records nothing. Review-1 flagged this (Q1-1) and recommended keeping both; reviews 2–3 dropped it; v4 states the strict version and never addresses it. Decide: abilities emit evidence through an L2-owned hook that ends at `append!` (and say so in §3), or the per-call trace is deferred (and say that).
- **N12 — `lock-artifact`'s `type?` is inert, and the stated placement contradicts v13 §15.** §3 rule 6: *"product docs are task-local real files (no symlink — only the shared contract-stack symlinks)."* v13 §14: *"**SHARED document artifacts** (specs, system-designs, architecture — the contract stack) live in `docs/` … realized in the task's `artifacts/` as a **symlink**. **TASK-LOCAL artifacts** (a goal, a report, a grandfathered record) are **real files**."* Flow 1 produces a **vision** and **detailed specs** that later tasks reference by logical name in `requiredInputs` — v13 §15's own test for "shared." So v4's flat rule is wrong for its own flagship flow. Worse for the design target, the rule is *hardcoded*: the placement should be **derived from the artifact type** (`vocab.json artifactTypes`: `spec|system-design|architecture` → `docs/<category>/` + symlink; `record|vision|validation` → task-local real file). That is what the `type?` field is for and it still drives nothing — review-2's finding 2, unfixed in three revisions.
- **N13 — the real resume rule is unstated.** §1 says the resume point is derived from the tail. The mechanism that actually makes that true for gates is: *a gate whose decision is already in the tail is not re-obtained* (otherwise a replay double-presents gate①, which is review-2's Q5-1 defect returning). §3 rule 5 asserts "the frame never double-presents" without the derivation. One sentence.
- **N14 — chain-order vs execution-order under phase binding.** `validateChain`'s input rule is "produced by an *earlier* step in the chain" (`flow.ts:124-131`). With `at:` bindings, list order is no longer execution order (a gate①-bound step listed last runs first). The validator's "earlier" must be restated as execution order, or the schema must require gate-bound entries to appear in phase order.
- **N15 — the AC citations in code are wrong and the design inherits the confusion.** No `AC-4` citation in `src/` resolves to requirements-spec-v3 AC-4 (*"idea → validated → envisioned → detailed specs runs end-to-end on a fixture idea"*); `flow.ts:18` labels AC-3's content as AC-4. v4 itself cites AC-3 correctly (§7). Worth a sweep when the code is re-implemented, not a design edit.

---

## Q3 — Simplicity: is this the smallest sound core?

**Yes, and v4 is meaningfully smaller than v3.** Four real simplifications landed: routing data collapsed into the chain (no second schema); `inputs[]` and `read.resolve` collapsed into one content mechanism (§5); double-carried content killed (§2); `request` dropped. Three layers, four intents, one write path, chains as data. I would defend this shape.

Remaining weight, in order:

1. **Two gate vocabularies** (N10) — pure redundancy, one-word fix.
2. **`params?` in the schema with no consumer** (N6a) — right now it is dead weight; wiring it into `ctx` makes it load-bearing. Either wire it or drop it; do not lock a field nothing can read.
3. **Reject bound: one owner, but two readers.** v4 correctly names `gate!` (L1) as the owner and blocks the `append!` bypass. But the frame must still *read* the count to escalate (`kernel.ts:207-215`). The design should say **L1 refuses the write; L2 observes the count to route to escalation** — otherwise review-3's "two enforcers" reappears in the implementation as two constants.
4. **`prior` vs `read.resolve` overlap.** §2 says a locked artifact is "automatically available downstream" as `prior`. In-run in-memory artifact and locked-artifact content are then the same slot. Fine, but say which wins on a replay (this is the same sentence as N1's `prior` clause).

**Can a step still reach the store?** In the design, no — `ctx.store` and `recordEvidence` are both explicitly gone (§2), and the three current steps only need `packet` + prior results (`validate-step.ts:56-67`, `envision-step.ts:38-48`, `spec-step.ts`). Verified: nothing in those steps requires a store read that `packet` + `read.resolve` cannot serve. The one live reach-through the design does **not** close is the ability-side evidence emission (N11).

---

## Q4 — The line between adjustable and protected

**The line is drawn now — that is the biggest single improvement over v3 — and the table is the right artifact.** §1's ownership table plus §4's "the reject bound is a CONSTANT" plus §6's "the 3-reject bound, gate sequence, and single-writer are NOT adjustable" is a coherent, defensible line, and it correctly attributes the strongest guarantees to **L0** rather than to the frame. Row-by-row:

| Row | True? |
|---|---|
| gate sequence at L0 | **True but overstated** — see N8 |
| reject bound at L1 `gate!` + `append!` composite refusal | True as a *design intent*; today `cmdGate` enforces (`cli.ts:755-758`) and `append!` bypasses (`cli.ts:916-920`). Correctly forward-looking. |
| single writer L1+L0 | True (`store.ts:452-467`) |
| chain validity / intent ordering / gate routing = L2 **conventions** | True, and calling them conventions is exactly right |
| leg status derived at L0 | True and verified (`store.ts:453-455`, `188-196`) |

### N7 (blocking) — the table is missing half the invariants that bound flows-as-data

Everything below is load-bearing when flows change, and none of it has a row:

| Invariant | Where it actually is | Note |
|---|---|---|
| artifact gate (children only after the parent concluded) | **`cli.ts:704-707`** | in the CLI, i.e. L3 today — must move to L1 `spawn!` |
| leg gate (next leg only after all previous tasks done) | **`cli.ts:714-716`** | same |
| F-AC19 contract self-sufficiency at spawn | **`cli.ts:723-728`** | same; v13 §7 says "enforced at spawn (hard reject)" |
| id naming / prefix / sibling clash | `cli.ts:696-712` | same |
| one-current-per-name | `cli.ts:773-776` | L1 `lock!` — and the row v4 changes (N1) |
| node.json strict schema, unknown fields rejected (v13 §2) | **nowhere** | the N2 landmine |
| F-AC16 closure integrity | `store.ts:604-625` — **`check()` only**, not the write path | v4 §3 says the flow validates F-AC16 → an L2 convention; say so |
| F-AC18 conclusion + commit traceability | `store.ts:626-642` — `check()` only | post-hoc, not an invariant |

v4 says "the CLI = a thin binding" (§8), which implies moving the first four rows into L1. It never says it, and the table — the artifact whose whole purpose is "per invariant, the enforcing layer" — omits them. **Complete the table or it does not do its job.**

### N8 (blocking, one line) — the L0 gate guarantee has a prose escape hatch

v4's strongest claim is §1's *"No flow data can skip a gate because the store won't take the write."* Verified with one exception the design does not record: `gateProblems` disables the GATE-1 check entirely when a `confirmed(gate=grill)` event's **note text contains the substring "retrospective"** (`store.ts:576`, used at `:581`). The gate name itself is also prose-parsed from the note as a fallback (`store.ts:569`). Both contradict the repo's own "machine-truth, never prose-parsed" rule (cited at `store.ts:641`, NFR-COM-1).

Today it is unreachable from the CLI (`cmdGate` writes a fixed note, `cli.ts:762`), but `note` is free text on every event and v4 explicitly plans additional L1 clients (N9). Either state the exception in the table, or note that the re-implementation drops the prose paths — but do not lock the unconditional claim.

### Anything adjustable that should be protected, or vice versa?

- **Correctly protected:** the 3-reject bound (flow-control v6 §3 fixes it at 3 — a constant is contract-correct, not over-rigid), the rework rungs (v6 §3), gate existence (v6 §3 "HARD on every node in v1"), gate sequence, single writer.
- **Correctly adjustable:** chains, work types, gate *source*, step params (once wired), `contract.flow`.
- **Wrongly hardcoded:** artifact placement (N12 — should derive from `type`), gate names (N10 — should read `vocab.json`).
- **Wrongly unprotected:** node.json contract schema (N2 — an invariant in the contract with no enforcer, sitting under the field that selects the flow).

---

## Q5 — Lock verdict

# LOCK AFTER the edits below.

The architecture is right and I would defend it unchanged: L0–L3, single write path, steps as pure units, intents translated by the flow, chains as data, gates as observed L1 writes, and — new in v4 and genuinely good — **the gate source *is* the chain**, which answered review-3's hardest blocker by deleting a mechanism instead of adding one. The invariant-ownership table is the right instrument and mostly true. v4 applied 11 of 14 edits cleanly. This is a good document.

But three of the four things that decide whether *later flow changes are sound* are still wrong, and none of them is a writing-down exercise:

- **B1 came back with a predicate that does not hold for LLM steps** (N1). Three reviews have now asked what happens when a chain re-runs, and the answer still leaves an unrecoverable task.
- **The field that selects the flow is not in the locked contract schema, which declares unknown fields rejected** (N2). Nobody has looked at this in four passes.
- **The chain validation moved to the one place it cannot help** (N3), and the mutable chain — the actual flows-as-data path — is now unvalidated at run time.

These are decisions, not prose. Make them.

### Blocking (8)

1. **Fix the idempotence predicate.** `lock-artifact` is a no-op when **`current(name).producer === taskId`** (`store.ts:212,226`) — not when the sha matches; content steps are non-deterministic by construction. State what `prior` resolves to on a no-op (the locked artifact). *(N1 — the surviving B1)*
2. **Reconcile `contract.workType` / `contract.flow` / `contract.model` with journey-format v13 §2.** The schema is enumerated and declares *"strict schema; unknown fields rejected"* (v13:43), and item 7 says work type SHOULD be *determinable from intent*. Either record a v13 §2 amendment enumerating the three fields, or derive the work type from intent. Note that node.json strictness is currently unenforced — that is why this has been invisible. *(N2)*
3. **Validate the chain at BOTH ends.** `contract.flow` at spawn (immutable node) **and** every resolved chain at execute (`chains[workType]` is mutable project data re-read at `flow.ts:91`). Restore the execute-time check and name its failure (`registry.get` currently throws outside the try, `kernel.ts:264-270`). *(N3)*
4. **State the third ordering rule.** A gate-bound step's non-gate intents are translated only **after** the gate decision is written — or a gate-bound step may declare no `lock-artifact`. Otherwise flow 1's `idea-validate` cannot lock the doc it exists to produce (`store.ts:571-583`). *(N4)*
5. **Give `superseded` a declarer**, and state that the frame writes it on the **old locker's** node (`store.ts:432-446`, `cli.ts:793-796`) — a cross-task write nothing in v4 permits. Or remove the "AC-7 is reachable" claim from §6. *(N5)*
6. **Close the chain schema.** (a) Put `params` in `ctx` (§2) or drop it from the entry. (b) Give the **verdict→gate decision mapping** a field, a default, and a named fail-closed — it is the one piece of B2's mechanism that still exists only as prose. *(N6)*
7. **Complete the invariant-ownership table** with the eight rows in Q4/N7 — in particular: the spawn-time gates (artifact gate, leg gate, F-AC19, id naming) live in `cli.ts` today and must be stated as **L1**; one-current-per-name is L1; node.json strict schema has **no enforcer**; F-AC16/F-AC18 are `check()`-time only, not invariants. *(N7)*
8. **Record the architecture amendment.** architecture @ e6d07ed:24,61 says *"the kernel is the only initiator … engines/adapters/surface propose."* v4's multi-client L1 and runner-writes-evidence contradict it. Single-writer survives; single-initiator does not. One line, same standard v4 applied to flow-control §3. *(N9)*

### Required for completeness (6)

9. **Qualify the L0 gate claim** — the `retrospective`-note bypass and the prose gate parse (`store.ts:569,576,581`), or state that the re-implementation removes both. *(N8)*
10. **Decide ability-emitted evidence** — an L2-owned hook ending at `append!`, or the per-call two-log trace is deferred. Today it is `executor.ts:103-109` → `kernel.ts:388-395` and §2 deletes it silently. *(N11)*
11. **Derive artifact placement from `type`**, per v13 §14/§15 (`spec|system-design|architecture` → `docs/<category>/` + symlink; `record|vision|validation` → task-local real file). §3 rule 6's flat "task-local" is wrong for flow 1's own spec/vision. *(N12)*
12. **State the resume rule**: a gate whose decision is already in the tail is not re-obtained. That is what makes "the frame never double-presents" true. *(N13)*
13. **Restate `validateChain`'s ordering rule as execution order**, not list order, now that `at:` exists. *(N14)*
14. **Use the vocab gate values** (`grill`, `confirm` — `vocab.json`, read via `getVOCAB()`) in the chain binding instead of `gate1`/`gate2`. *(N10)*

### Cosmetic

- §1 L3 lists the read view as an ability; §2 puts `read` beside `abilities`. Pick one.
- §2's `abilities {llm · interact · tool · command}` — the `interact` protocol has four verbs (`present · askQuestion · collectResearch · collectDecision`, `interact.ts:15-24`); §1's "present·ask·decide" drops `collectResearch`, which the idea-validation session depends on.
- §4's commit phase both "OBSERVES" the runner's evidence (execute) and "records the resulting `evidence.commits[]`" (commit). Say observe-or-record, not both.
- Sweep the `AC-4` citations when re-implementing — none in `src/` resolves to requirements-spec-v3 AC-4; `flow.ts:18` labels AC-3's content as AC-4. *(N15)*

---

## What I am not sure of

- **Whether N2 is deliberate.** `workType` may have been sanctioned as a contract extension in a decision record I did not read (I read the locked specs, `architecture.md`, and `src/`, not the S1–S9 slice contracts or the full node event logs). If there is a recorded amendment, edit 2 collapses to a cross-reference. But nothing in v13, flow-control v6, or the packet spec mentions the field, and v13 §2 item 7 argues the other way.
- **Whether "product docs" in §3 rule 6 means what I read it to mean.** If the term is meant narrowly (goal/report artifacts only), N12 shrinks to a wording fix. The flagship flow produces a vision and detailed specs, so I read it as covering those.
- **How much of N11 the owner considers settled.** The two-log trace is named in AGENTS.md's architecture pointer, but I did not find the phrase in either architecture artifact — the per-call emission may be a code-level convention (R3-D2) rather than a locked invariant, in which case deleting it is a free choice that only needs stating.
- **N4's severity depends on whether `idea-validate` is meant to lock its doc at all.** If the validation doc is intended to stay in-memory and only `envision`/`spec` lock, N4 shrinks — but then the doc has no durable trace, no `read.resolve` path, and is lost on every replay, which is its own problem.
- **I did not run the flow end-to-end** (no provider configured in this repo — `spec-step.ts` says the live run is deferred). Everything above is contract-and-code reading plus the 169-test suite, which passes.
