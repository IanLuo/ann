# Design Review v12 — THE CONFIG DIMENSION

*Scope as prescribed: the NEW dimension only (general config · conditional chains · verify-fail cycles), the ownership rows, the registry amendment, the 4th migration, what forces a code change, and the lock verdict. v11's mechanisms are settled and I did not re-litigate them — except where the new dimension **re-opens** one, which it does, twice.*

*Evidence base: `core-design-v12.md` read in full and **diffed line-by-line against v11** (the diff is purely additive — 8 hunks, all in the new dimension; all three review-10 blocking edits and all three recommended edits survive intact in v12 at :75, :88-89, :114, :248, :258 — no regression). Code measured, not read-around: `kernel/kernel.ts` (REJECT_BOUND :88, validate :173-203, rejectionCount :207-215, execute entry :220-245, verify :303-322), `kernel/flow.ts` (loader :53-78, resolveFlow :83-108, validateChain :113-146), `engines/context.ts` (:112, :151), `kernel/step.ts` (:64-72), `kernel/interact.ts` (:14-24), `adapters/provider/config.ts` (:16, :19-32, :52), `cli.ts` (:487-492, :810), `store/store.ts` (:172, :207-212, :559-565). Contracts quoted: resource-registry-v2 (:26, :36, :55, :61-63, :81-93, :98), functional-spec (:47, :79), flow-control-v6 (:23, :39, :43-51, :71, :77), requirements-spec-v3 (:63, :65), design-review-v10 (:119, :145). Registry data files read as they sit on disk.*

---

## Headline

**Two of the three new mechanisms do not work as written, and one of them is inert for a reason the document itself makes authoritative.**

- **Verify-fail cycles are a no-op.** A verify failure writes no `rejected` event, so `runId` cannot advance (§2:96) and the step's cycle-1 traces post-date the reference point — so the re-run **REPLAYS from the transcript**, serving the same completions, producing the same output, failing verify identically. §2:88-89 (the review-10 edit that v11 applied) says *"THE DISCRIMINATOR IS AUTHORITATIVE for fresh-vs-replay"* — so the design resolves its own conflict **against** the new feature. `flow.verifyFailCycles: 3` buys three deterministic replays and then `failed`.
- **`when: {inputMissing}` is a dead condition.** `context.ts:112` sets `readiness.ready = false` on any missing `requiredInput`; `kernel.ts:230-237` refuses to run the chain at all in that state, and `kernel.ts:185-187` fails validate. A task with a missing input never reaches the chain, so the condition can never be true at execute time. The flagship use case the owner named — *"research only when inputs missing"* — is unreachable, and it is already owned by a locked mechanism (the resolution ladder, flow-control v6 §4 rungs 2/4).
- **The general config is placed against two locked lines.** `functional-spec:79` scopes F17 to *"provider + ask-vs-assume + defaults (**step-chain templates land in F3**)"* — v12 cites F17 while moving flow behaviour into it. `resource-registry-v2:81-93` is a **frozen** schema with no slot for the knobs v12 overlays onto it, and no amendment for it is recorded.

The owner's three *decisions* are sound. The v12 *text* realizes one of them (conditional chains — with four missing rules). This is not a phrase-edit round.

**Verdict: DO NOT LOCK.** Exact v13 edit list in §VI. v11 remains lock-ready; the dimension is separable (see §VI, option B).

**Records gap, before anything else:** `.agents/artifacts/design-review-v11.md` **does not exist**. Ten review artifacts are on disk (`design-review.md` + v2–v10). The "LOCK AS-IS at v11" verdict is not recorded anywhere in the repo. The settled list I am honouring is `design-review-v10.md:145`. If the v11 review exists outside the repo, file it — the settled list is the thing that keeps these rounds from re-opening.

---

## I. THE GENERAL CONFIG — placement, category, precedence

### 1a. Is the placement sound against the resource-registry pattern?

**Partly. The amendment mechanism is right and precedented; the placement violates the pattern's first rule.**

What v12 gets right: the file header shape (`registry · version · category · kind · definition`) matches the shipped registry files exactly (`.ann/rules/flow/default.json`, `.ann/rules/schema/vocab.json`). And the precedent for the amendment is real — `vocab.json` already carries `"category": "schema"`, which is **not** in the `:36` enum, and v12 §8:266 correctly lists both `schema` and `config` as the same kind of category addition. That is the right instinct, correctly recorded.

What it gets wrong — `resource-registry-v2:26`:

> **One registry per class.** Every rule/resource lives in exactly one registry. A layer that needs a rule *reads* it — it never carries its own copy.

v12 creates a config class that holds **flow** rules (`conditionals`, `verifyFailCycles`) while the flow registry holds the chains those rules govern. Two registries, one class. Concretely: `conditionals` decides whether a `when` key **inside `rules/flow/default.json`** is honoured, so the flow loader must read the config registry to validate the flow registry, and the answer can differ per machine (§I.1c). That is precisely the "scattered knowledge" seam the spec was written to kill (`:13`).

It also creates a **third** home for F17's preferences. `resource-registry-v2:55` already declares a `user-config (v2)` instance holding the per-user settings, and `functional-spec:47` points F17 at it. v12 §6:219 puts `preferences: {askVsAssume, defaults}` in the per-project file **and** keeps the user file as an override. `askVsAssume` is a *person's* preference ("ask if … **user prefers questions**" — flow-control v6:53); putting it in shared project data and overriding it per-user is the copy the pattern forbids.

### 1b. Does `:36` need a `config` category, and is the amendment recorded?

**Yes it needs one, yes it is recorded (§8:266) — and the amendment as scoped is incomplete on three counts.**

`resource-registry-v2:36` enumerates `ask | check | decide | adapter | flow | binding | surface`. Missing from v12's amendment scope:

1. **`user-config` is not in the `:36` enum either** — a pre-existing inconsistency between `:36` and the `:55` instance row. v12's v3 amendment adds `config` beside it without saying how `config` (per-project) and `user-config` (per-user) relate. v3 would ship with two configuration categories, overlapping content, and a precedence rule between them. Name the relationship or collapse them: the defensible shape is **one `config` class with two instances** (project file, user overlay), not two classes.
2. **The frozen user-config schema (`:81-93`) is not amended.** v12 overlays `flow.*` and `preferences.*` onto `~/.ann/config.json`. That schema is labelled *"Schema (frozen)"* and contains `provider · model · baseUrl · apiKey · maxTokens · projects · currentProject` — nothing else. The code agrees: `config.ts:19-30` is that exact interface and `setConfig` (`:52`) is typed `key: keyof UserConfig`. **A user cannot express `flow.conditionals` today, and v12 lists no amendment and no code change to let them.**
3. **No management surface for the new registry.** `resource-registry-v2:22-23,61` makes MANAGEMENT the pattern's third leg (*"One surface to list/add/version/enable/tune"*). `ann config` shows only the user file (`cli.ts:487-492`) and `ann config! set` accepts exactly `provider|model|baseUrl|apiKey|maxTokens` (`cli.ts:492`, `:810`). The new registry gets no read view and no writer in the §8 ship list. A registry nobody can list or tune is a JSON file, not a registry instance.

### 1c. Per-project vs per-user for flow behaviour

**Per-project is right for the flow knobs; the *file* is wrong (they belong in the flow registry), and the user-overlay direction is unsound for `conditionals`.**

- `flow-control v6:77` — *"Flows are **configuration data, not code**: a project defines its step chain"*. `functional-spec:79` — *"step-chain templates land in F3"*. Flow behaviour is project-scoped and F3-owned. `rules/flow/default.json` already carries `registry/version/category/kind/definition/template/chains` — adding `conditionals` and `verifyFailCycles` there is a one-line data migration with zero new registry, zero new loader, zero cross-registry validation dependency, and no conflict with F17's locked scope.
- **The user overlay on `conditionals` is a semantic switch on shared data, not a preference.** Precedence "user > project" means a personal file changes whether a project's chain skips steps. Two people run the same journey and get different chains, different artifacts, different events — in a system whose product **is** the journey (§0) and whose store is the single source of truth. `verifyFailCycles` is a cost knob and is defensible as user-overridable; `conditionals` is not.
- The mirror-image failure is worse: a project chain authored **with** `when` entries runs every step unconditionally on a machine whose user config sets `false`. The chain was statically validated under the project's flag (§1:59 claims `when` conditions are statically validated) — validated against a value the runtime can override from another file.

### 1d. Precedence ambiguity

**Three, all real.**

1. **`env` is dropped.** `resource-registry-v2:98` (locked) — *"**Resolution order per setting:** `env` (deployment override) > `user config` > `keychain` (secrets only) > `registry fallback`"*. The code implements it (`config.ts:16`) and the CLI prints it (`cli.ts:488`: *"resolution: env > config > keychain/fallback"*). v12:7/§6:220 states *"user config > project config > builtin defaults"* — no `env`, and "project config" inserted at a rung the locked order does not name. Either state `env > user > project > builtin` or say env does not apply to this registry. As written, two precedence chains sit in two locked-or-locking documents.
2. **Merge granularity is unstated.** The locked spec says *"per setting"* (per-key). v12 says "precedence" over a file with nested objects. Does a user file containing `flow: {verifyFailCycles: 2}` leave `flow.conditionals` at the project value, or replace the `flow` object and reset `conditionals` to the builtin? Both are defensible; the document must pick. This is the classic nested-config bug and it will be written both ways by two implementers.
3. **No stated validation or out-of-range behaviour.** The ceiling 3 is named as a constant (§1:61) but nothing says what a config carrying `verifyFailCycles: 99` does — clamp to 3, or fail closed and named? The design's own standard is fail-closed-and-named (`flow.ts:76`: *"fail-closed: never silently fall back"*). Also unstated: what a **non-numeric** value does, and where the builtin defaults live (a code literal duplicating the registry — by the document's own precedent at §1:54 that is a "knowing duplicate" needing a reconciliation note).

---

## II. CONDITIONAL CHAINS — the four holes

The mechanism is the right answer to review-10:119 (*"conditional flow is the change most likely to be wanted next, and it is the one the data model cannot absorb"*). Skip-shaped conditionals are the cheapest sound form. But four rules are missing, and the ownership row already over-claims.

### 2a. Does a skip break `prior` role binding for a later step? — **Runtime gap. It should be a validation error.**

Measured. `validateChain` (`flow.ts:113-146`) resolves an input by **chain position**:

```
flow.ts:124-127   const earlier = new Set(chain.slice(0, i));
                  for (const input of step.inputs) {
                    if (earlier.has(input) || resolvable.has(input)) continue;
```

`earlier.has(input)` is a static set of ids preceding position *i*. It cannot see `when`. So `[{id:'research', when:{…}}, {id:'spec', inputs:{vision:'research'}}]` **passes static validation** and, when the condition is false, arrives at `spec` with a REQUIRED role unbound — a runtime failure on a chain the document says was validated. §6:212's *"references statically validated against the packet + prior"* validates the **condition's** references; it says nothing about downstream consumers of a skipped step, and §1:59's addition of *"`when` conditions"* to the STATICALLY VALIDATED column therefore over-claims — the same over-claim reviews 8 and 9 spent two rounds removing from that exact cell.

The sound rule (state it, do not leave it to the implementer): **a REQUIRED role may not bind to a conditional step, unless the consuming entry is itself conditional on `hasOutput: <that step>`.** `hasOutput` exists for precisely this and nothing requires its use. Optional roles skip harmlessly.

### 2b. Does a skipped gate-bound step deadlock the gate? — **Yes, as written, and silently.**

§4:140-141 gives the gate ONE source: *"the frame's present-via-interact (default) **or** a chain step bound to `at:'grill'`"*. If that step carries `when` and the condition is false, the document says nothing. Two readings, both buildable: fall back to the frame's present (probably intended), or no decision is produced. Under the second reading the task blocks with no submission — and because the reject bound counts `rejected` events (`kernel.ts:207-208`), a gate that is never submitted never counts, never escalates. The design's only anti-deadlock guarantee at gates is static (rule 6, one step per gate; rule 8, the `produces?[]` deadlock check) and `when` makes both unsound at runtime:

- **rule 6** — *"at most one step per gate (statically validated)"* forbids the natural conditional idiom (two mutually-exclusive gate-bound steps). So conditionals cannot express alternative gate sources anyway.
- **rule 8** (§3:128) — *"a chain whose ONLY artifact-producing step is confirm-bound fails static validation"*. Make the only artifact-producing step **conditional** and the static check passes while the runtime chain produces nothing → verify finds no outputs → (with v12's new retry) burns the cycle budget → `failed`.

Simplest sound rule, and the one I would write: **a gate-bound entry (`at:'grill'|'confirm'`) may not carry `when`.** One clause, closes both holes, costs nothing the owner asked for.

### 2c. Does `verdict:` reference the step's own verdict or a prior one? — **Unresolvable as spelled.**

§6:208: `when?: {… | verdict?: decision}` — a bare decision string. Three ways it fails to resolve:

1. **Whose?** Its own step's verdict cannot exist before the step runs, so it must mean a prior step's — the document never says so.
2. **Which prior step?** `decisions[]` is per-step (§2:74-77). Two steps declaring `revise` make `verdict: 'revise'` ambiguous. There is no stepId qualifier.
3. **Which verdict — the step's or the gate's?** The chain entry's own `verdict:` field maps a step decision to a **gate** decision (§6:207). In `when?`, `verdict:` could mean either. Only the grill gate is decided before execute, so only one reading is even coherent, and the document does not name it.

Must be `verdict?: {step: stepId, decision}` with static validation that `step` precedes this entry in **execution order** (§4:148-153's ordering, not list order) and declares that decision in its `decisions[]`.

### 2d. Are the three kinds complete for "research only when inputs missing"? — **No: that kind is dead, and the case is already owned elsewhere.**

Measured:

```
context.ts:112   for (const d of dependencies) if (d.status === 'missing')
                   blockers.push(`missing requiredInput: ${d.blocker}`);
context.ts:151   readiness: { ready: blockers.length === 0, blockers }
kernel.ts:230    if (!packet.readiness.ready) { return { … outcomes: [], ok: false } }   // chain never runs
kernel.ts:185    for (const b of packet.readiness.blockers) findings.push({ code:'readiness', … })
```

`flow-control v6:23` locks the same thing at the spec level: *"**validate:** deterministic — schema, artifact gate, leg gate, ACs declared, **inputs resolved**"*. A task with an unresolved `requiredInput` is blocked before execute. **`when: {inputMissing: name}` can never evaluate true for a `requiredInput`** — the only thing the packet exposes by name (`context.ts:93-98`).

And the case it was invented for already has a locked owner: the resolution ladder, `flow-control v6:43-51` — rung 2 `probe` (*"read project state / external systems"*) and rung 4 `ask`. v12 §4:136-139 defers those rungs to registry enablement and ships `block` only. So v12 answers "research when inputs are missing" by adding a **second** mechanism in a **different** registry for a concern a locked spec already assigns — while the first mechanism sits deferred. That is the resource-registry seam again, this time between two specs.

**Drop `inputMissing`.** Keep `hasOutput` and a qualified `verdict`; route missing-input research through the ladder rung, which is already registry-data-enabled (§1:63). If the owner wants `inputMissing` anyway, it must be redefined against something that is *legal at execute time* (an OPTIONAL role, or a non-blocking `openQuestion`) and the document must say which — redefining readiness itself re-opens a locked mechanism.

### 2e. Additional, not asked

- **`conditionals: false` + a chain containing `when` is undefined.** Ignore the key and run the step, or fail closed and named? Fail-closed-and-named is the house standard (`flow.ts:76`); say it.
- **A skip is unauditable.** *"no trace, no events"* means the tail cannot distinguish *skipped* from *crashed before this step* from *added to the chain after this task ran* — chain data is mutable project data while `node.json` is immutable (v13:43), so the chain that ran a task is not recoverable from the store. `requirements-spec-v3:63` (NFR-OBS-1) — *"the tree IS the log — every change append-only, fully replayable from events"*. A branch decision that leaves no record is the one thing this design has refused everywhere else (§7: *"no prose as truth — machine-truth events"*). Since §III forces a `trace` kind amendment anyway, carry `kind:'skip'` in the same amendment and record `{stepId, condition, evaluated:false}`. One record, and the journey stays the log.

---

## III. VERIFY-FAIL CYCLES — the mechanism does not run

### 3a. The transcript collision — **hard, and the document rules against itself**

The owner asked whether a fresh re-run collides with the transcript. It does not merely collide; the transcript wins.

§2:96 (settled, review-10:145):

> an attempt is NEW when no `trace` record post-dates the latest `rejected` event at the step's bound gate; otherwise it REPLAYS … **`runId` = 1 + the number of `rejected` events at the step's bound gate in the tail**

A verify failure writes **no `rejected` event** — verify sits before GATE·confirm (§4:162-168) and no gate is involved. Therefore, on verify cycle 2:

- `runId` is unchanged (rejection count unchanged) — so fresh records could not be distinguished from cycle 1's even if they were written;
- the step's cycle-1 traces post-date the reference point (or there is no `rejected` event at all — review-10:82 already reasoned exactly this way for the grill-bound step: *"its run-1 traces post-date the (nonexistent) reference point → REPLAY"*);
- → **the step REPLAYS.** §4:160: *"REPLAY SERVES LLM + INTERACT FROM THE TRANSCRIPT (zero model calls)"*.

So the retry re-runs with the same completions, the same answers, the same artifact, and fails verify identically — except where the miss policy (§2:96) leaks a live call, which yields a *partially* fresh artifact, which is worse than either. And §2:88-89 — the clause v11 added on review-10's recommendation — closes the escape:

> **THE DISCRIMINATOR IS AUTHORITATIVE for fresh-vs-replay**; this delivery rule governs FEEDBACK ROUTING ONLY

§1:61/§3:128/§4:163-166 all say *"re-runs execute FRESH with the finding as feedback"*. The authoritative rule says replay. **As written, `verifyFailCycles > 1` buys N deterministic replays and then `failed`.**

This is review-10 §III's residual — two rules deciding one thing — except that review-10 could write *"no shipped path reaches the divergence"*. Here the divergence **is** the default path for the feature.

Fixing it means re-opening `runId` derivation, which review-10:145 lists as settled. The minimal sound edit: an **attempt counter** anchored on both boundaries — `runId = 1 + (rejections at the bound gate) + (verify cycles since the current attempt's start)` — and the discriminator's reference point becomes *the latest attempt boundary* = the later of (latest `rejected` at the bound gate, latest verify-cycle record). Say it in §2, where the derivation lives — not only in §1/§3/§4.

### 3b. Is the count derivation well-defined? — **No. It is not defined at all.**

The document never says what the cycle count is counted from. The two candidates give opposite behaviour:

- **Anchored at `activated`:** a confirm rejection's rework re-enters at execute (§2:79-82) → verify runs again → with the budget already spent, the first post-rework verify failure fails the task. The knob silently shrinks rework.
- **Anchored at the latest gate decision at confirm:** each rework pass gets a fresh budget → multiplication (§3c).

Precedent exists and does not extend: `rejectionCount` (`kernel.ts:207-208`) counts over the whole tail *per gate* — it works because gates are named. Verify has no gate to key on. Pick the anchor and name it in §1:61 and §3:128.

### 3c. Does NFR-CST-1 hold? — **The premise of the question is wrong, and the real answer is "unstated, and it triples".**

`requirements-spec-v3:65` in full:

> **NFR-CST-1:** bounded model calls per step — one grilling pass, one review pass, capped rework. *10× = cost explosion. KEEP.*

**There is no "10× cap."** The `*10× = …*` clause is the requirements-spec's stress annotation on every NFR (see `:62` — *"10× = leaks → fatal. KEEP."*), i.e. "what breaks at ten times the scale". It is not a budget, and "ceiling 3 is within the 10× cap" is not an argument. NFR-CST-1's actual content is *bounded* + *capped rework*.

Measured ceiling today (`kernel.ts:88`, `:207-215`, `:220-228`): `REJECT_BOUND = 3`, escalation checked at execute entry, so the confirm loop yields at most **3 chain executions** per task before escalation. With `verifyFailCycles: 3` each of those becomes up to 3 → **≤ 9 chain executions**, each running every step's model calls. Formally still bounded, so NFR-CST-1 holds in the letter; the ceiling **triples** and v12 states neither the old number nor the new one.

The irony worth stating plainly: because of §3a, the retries as written cost **zero** model calls. The feature is either free and useless (as specified) or 3× (as intended). It cannot be both, and the document currently claims the second while specifying the first.

### 3d. Interaction with the 3-reject bound — **coherent in the sense of "bounded", incoherent in the sense of "stated"**

Total is bounded because both bounds are finite and the reject bound remains a constant owned by `gate!` (§4:193). But the product ≤ 3 × 3 is nowhere written, and the failure ordering is not either: verify exhaustion writes `failed` **without a gate decision** (§3:128), while gate exhaustion **escalates to a human** (`kernel.ts:224`, flow-control v6:39 — *"escalate to a human design decision (force-approve / restructure / block)"*). So the new knob adds a path that concludes a task terminally with no human in the loop, sitting beside a locked path that insists on one. That asymmetry may be intended; it is not argued.

### 3e. Verify-fail on an empty chain (flow 2) — **a live regression**

Measured. `kernel.ts:310-313`: verify passes on `evidence.commits[]` or an `artifact-locked` event. For flow 2 (`chains.implementation: []`, `.ann/rules/flow/default.json`) the chain is empty and the work is the runner's, arriving as observed `append!` writes (§4:156-157). A verify failure there means **"the runner has not committed yet"** — a wait condition, not a defect. v12's response is to *"re-run execute FRESH with the finding as feedback"*:

- execute is empty — re-running it does nothing;
- the feedback has **no recipient** — there are no steps to deliver it to (§2:79-82 delivers feedback to steps);
- the cycles burn deterministically and the frame writes `failed` — terminal (`store.ts:172` collapses status; recovery is a sibling retry, flow-control v6:71).

So on the implementation work type — the one flow that will run most often — the knob converts "wait for the runner" into "fail the task". `verifyFailCycles` must be defined as **inert for an empty chain** (forced to 1), or verify-fail on an empty chain must block rather than fail. Say which.

### 3f. `kind: 'verify'` is not schema-legal — **against v12's own amendment**

§1:61 and §3:128 record cycles as a trace record `kind: 'verify'`. §2:95 defines the record as `kind: 'llm'|'ask'|'research'|'decide'` and says *"shape-policed for **ALL FOUR** kinds"*; §8:264 repeats *"shape-policed for all four kinds"*. **The v14 §3 amendment as scoped does not legalize a fifth kind**, so *"schema-legal"* (§1:61) is false against the document's own amendment list.

Worse, the record's key does not fit: it is `{stepId, runId, seq, kind, …}` and a verify cycle belongs to the **frame's verify phase**, not to a step — there is no `stepId` to carry, and `runId` is the thing that cannot advance (§3a). A frame-phase cycle counter does not belong in a step-keyed record. Either give it a key shape of its own in the amendment, or count cycles from a distinct event and say so.

---

## IV. THE OWNERSHIP ROWS · THE CATEGORY AMENDMENT · THE 4th MIGRATION

**Rows.** Putting `configurable` / `data, adjustable` in the Layer column is precedented (`:57`, `vocab.artifactTypes`) — fine. Three problems:

- **`:59` over-claims.** Adding *"`when` conditions"* to STATICALLY VALIDATED asserts more than any stated rule delivers (§II.2a/2b). Downgrade to what is true — *the condition's own references are statically validated; skip-safety of downstream bindings requires the two rules in §6* — or add those rules and keep the claim.
- **`:61` contains a false claim** (`kind:'verify'` is not schema-legal, §III.3f) and an incomplete one (*"this knob is the verify rung only"* — it multiplies chain executions inside every rework pass, §III.3c).
- **Two rows are missing.** (i) Who validates the config and what an out-of-range/ill-typed value does (§I.1d.3). (ii) Where the **builtin defaults** live — a code literal duplicating the registry, which by the table's own precedent at `:54` needs a stated reconciliation.

**Category amendment.** Recorded at §8:266, correctly patterned on the `schema` precedent. Incomplete on the three counts in §I.1b: the `user-config`↔`config` relationship, the frozen `:81-93` schema, and the management surface. Add them to the amendment scope or the amendment ships a category nothing can legally hold.

**4th migration.** *"`rules/config/default.json` (NEW — the general config registry)"*:

- **Path.** The real registry root is `.ann/rules/` with a repo-root `rules` symlink; `flow.ts:54-56` handles both (`.ann/rules/…` preferred, bare `rules/…` accepted). The new loader must do the same — the migration list is the implementation contract, so say it once.
- **It is not a migration.** The other three transform existing data; this creates a file. Cosmetic, but the list is read as a checklist.
- **Two real migrations are missing from it:** `~/.ann/config.json`'s schema (`resource-registry-v2:81-93` + `config.ts:19-30`), and `ann config!`'s key list (`cli.ts:492`, `:810`) — without which the user overlay the design leans on cannot be written by a user.

---

## V. WHAT THE NEW DIMENSION FORCES — AND WHAT IT RE-OPENS

**Re-opened settled mechanisms — the owner's tripwire, and it trips twice:**

1. **Transcript replay + `runId` derivation** (review-10:145, settled). Verify cycles cannot work without changing it (§III.3a). Not a phrase edit — it is the mechanism the last three reviews measured.
2. **The `produces?[]` deadlock check + rule 6** (settled). `when` makes both statically sound and runtime-unsound (§II.2b).
3. **Adjacent:** `when.inputMissing` duplicates the locked resolution ladder's probe/ask rungs (flow-control v6:43-51) while those rungs sit deferred (§II.2d).

**Does the dimension force code changes for future flow changes?** It genuinely lifts review-10:119's limit — a skip-shaped branch becomes data. But §6:225's *"a runtime branch is then DATA, not code"* over-claims, and the honest boundary should be in the document:

- **skip-shaped only** — no else-branch, no alternative step, no join;
- **three fixed predicates** — a fourth condition kind is a **code change** (new to v12, and unstated);
- **no conditional gate sources** — rule 6 forbids two steps per gate, so alternative gate sources remain a code change;
- **project-wide blast radius** — `conditionals` is one boolean for every chain in the project; enabling it for one chain changes validation semantics for all of them;
- **cross-registry coupling** — a flow-data feature gated by a value in another registry, overridable per-user (§I.1c).

Net: the config dimension trades one named limit (review-10:119) for a smaller named limit plus a new seam. Worth doing — the smaller limit is the right trade — but the document must state the new boundary as plainly as v11 stated the old one.

---

## VI. LOCK VERDICT

# DO NOT LOCK

Not because the owner's decisions are wrong — they are reasonable and they answer a limit review-10 named. Because **v12 specifies two of the three mechanisms in a form that does not run**: verify cycles are inert under the document's own authoritative discriminator (§III.3a), and `when.inputMissing` is dead against the shipped readiness gate (§II.2d). Those are not contradictions-with-a-correct-statement-elsewhere (review-10's phrase-edit standard); the correct statement does not exist in the document, and producing it re-opens a settled mechanism. Lock v13.

### Blocking edits for v13

1. **§2:96 — the attempt boundary.** Re-derive: `runId = 1 + (rejections at the bound gate) + (verify cycles in the current attempt)`; the discriminator's reference point becomes **the latest attempt boundary** = the later of (latest `rejected` at the bound gate, latest verify-cycle record). State it in §2, where the derivation lives, and note in §8 that this amends a review-10-settled rule. Without this, §1:61/§3:128/§4:163's "FRESH" is contradicted by §2:88-89's authoritative-discriminator clause and the feature is N replays.
2. **§1:61 + §3:128 — the cycle anchor.** Name what the count is counted from (recommend: since the latest gate decision at `confirm`, resetting per rework pass) and state the resulting ceiling: **≤ 3 chain executions today (`kernel.ts:88`, `:220-228`) × up to 3 cycles = ≤ 9**, with the NFR-CST-1 consequence stated in the same clause. Delete any implication of a "10× cap" — `requirements-spec-v3:65` has none.
3. **§2:95 + §8:264 — legalize the record.** Either add `'verify'` (and, per §II.2e, `'skip'`) to the v14 §3 `trace` kinds **with a key shape that does not require `stepId`/`runId`**, or count cycles from a different record and stop calling the trace its home. As written, §1:61's *"schema-legal"* is false against §8's own amendment.
4. **§3:128 + §4:162-167 — the empty chain.** State that `verifyFailCycles` is inert for an empty chain (forced to 1), or that verify-fail on an empty chain blocks rather than fails. Today's text fails implementation tasks whose runner simply has not committed yet (`kernel.ts:310-313`, flow 2).
5. **§6:208 — qualify `verdict`.** `verdict?: {step: stepId, decision}`, statically validated: `step` precedes this entry in **execution order** and declares `decision` in its `decisions[]`. A bare decision string is unresolvable.
6. **§6:208 — drop `inputMissing`,** or redefine it against something legal at execute time (optional role / non-blocking openQuestion) and say which. Measured dead: `context.ts:112` + `kernel.ts:230-237` + `kernel.ts:185-187`; owned already by flow-control v6:43-51 rungs 2/4.
7. **§6 — two skip-safety rules, stated as validation:** (a) a REQUIRED role may not bind to a conditional step unless the consumer is itself conditional on `hasOutput` of that step (`flow.ts:124-127` cannot see `when`); (b) a gate-bound entry (`at:'grill'|'confirm'`) may not carry `when` (closes the gate deadlock and the rule-8 runtime hole in one clause).
8. **§6:225 + §1:59 — `conditionals: false` with `when` present** → fail closed, named (`flow.ts:76`'s standard). And downgrade §1:59's *"`when` conditions"* claim to what edits 5–7 actually deliver.
9. **§6:214-220 + §8:266 — the config placement.** Pick one and write it:
   - **(recommended)** `flow.conditionals` and `flow.verifyFailCycles` move into **`rules/flow/default.json`** (F3's registry, beside the chains they govern — `functional-spec:79`, `flow-control v6:77`), and `preferences.{askVsAssume,defaults}` stay in the **user config** (`resource-registry-v2:55`, `functional-spec:47`). No new registry, no new category, no cross-registry validation, no user override of project flow semantics. The 4th migration collapses to a one-line addition to an existing file, and §8's resource-registry amendment drops back to `schema` + `vocab` + the `:63` reconciliation.
   - **(if the owner keeps the new registry)** then the amendment must additionally: declare `config` and `user-config` **one class, two instances** (not two classes); amend the frozen `:81-93` user-config schema; add the management surface (`ann config` project view + `ann config! set` keys, `cli.ts:492`/`:810`); state precedence as **`env > user > project > builtin`, per leaf key** (`resource-registry-v2:98`, `config.ts:16`); and forbid a user override of `conditionals` (semantics, not preference).
10. **§1 — two ownership rows:** config validation (out-of-range/ill-typed → named problem, not silent clamp) and the builtin-defaults code literal (a knowing duplicate, per the `:54` precedent).

### Non-blocking, same pass

11. **Record the skip** as a trace/`evidence` record (`{stepId, condition, evaluated:false}`) — NFR-OBS-1 (`requirements-spec-v3:63`); otherwise the branch a journey took is not derivable from its own log, and skipped is indistinguishable from crashed-before.
12. **State the new boundary honestly in §6:225** — skip-only, three fixed predicates (a fourth = code), no conditional gate sources, project-wide flag. v11 stated its limit plainly; v12 should state the smaller one just as plainly rather than claiming "a runtime branch is DATA".
13. **File `design-review-v11.md`.** The LOCK AS-IS verdict this round was told to build on is not in the repo.

### Option B — if the owner wants to start building now

The dimension is **purely additive**: the v11→v12 diff is 8 hunks, all confined to it, and every review-10 edit survives. **Lock v11 as-is and ship it**, then land the config dimension as a v13 amendment once edits 1–10 are written. v11's `verifyFailCycles: 1` and unconditional chains are exactly today's behaviour, so nothing built against v11 is invalidated by adding the knobs later — the chain-entry schema already grew `at`/`inputs`/`params`/`verdict` in the same migration, and `when` is one more optional key on the same entry. That sequencing costs nothing and gets the measured, settled 90% of the design under construction while the new 10% is made correct.

---

## What I am not sure of

- **I ran no fixtures.** Fourth review in a row on code-reading and contract-reading. The two claims I would most want executed before v13 locks: the verify-cycle replay path (§III.3a) against a real transcript fixture — it is the finding this verdict rests on, and it is mechanical enough that a fixture would settle it in an hour — and the empty-chain verify-fail path (§III.3e) on `chains.implementation`.
- **Whether the owner intends `conditionals` to be user-overridable at all.** I read "precedence: user > project" literally. If the intent was only that *preferences* are user-overridable, most of §I.1c dissolves and edit 9 gets smaller.
- **Whether `inputMissing` was meant for `requiredInputs`.** I measured it against the only name-addressable thing in the packet. If it meant optional roles, it is not dead — but the document does not say, and neither reading is written down.
- **The `user-config`/`:36` enum gap** is pre-existing in the locked v2 spec, not v12's doing. I have treated it as in-scope only because v12's amendment touches the same line.
