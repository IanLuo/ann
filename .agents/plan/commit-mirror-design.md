# The commit mirror — the git log as the record's reasoning surface

*Design record (pre-spec). Status: DRAFT — feeder for a SPECS session (`spec! --amend`) once the
leg gate opens. Nothing here is in force until it lands as a doc amendment + the code follows.*

## Why (the observed failure, not a theory)

The engine writes the store and **never commits**; the commit is an out-of-band actor duty with no
rule, no check, and no owner. Three human gate accepts, three different fates:

| write | who wrote it | committed by |
|---|---|---|
| 12/01 exit accept (human) | `RECORDED_BY=ianluo` | swept into `48472cc` (next day, the `bookkeeper` session) |
| 12/02 + 12/03 entry accepts (delegated operator proxy, via the service) | `ianluo` | `0759b92` (the operator session, 20 min later) |
| 12/03 exit accept + auto-close (the human, via the service) | `ianluo` | **nobody** — no session followed → left dirty, blocked `advance!` |

`48472cc` bundles **three actors' writes** (the human's accept, the operator's `extended`, the
agent's `spawn`) because the scope is "whatever is dirty". And git attribution is inert: author and
committer are `ian luo <ianluo63@gmail.com>` on **every** commit — an agent's commit, a proxy's
write and a page click are indistinguishable in history. The only actor traces today are commit
prose and the event's own `note`/`feedback`.

Consequence: `git log` cannot be reasoned over. So the record's reasoning surface is the one place
the rules forbid reading (`events.jsonl` is machine-parse-only: "never read it directly").

**Purpose clause:** the mirror makes `git log` the sanctioned, ordered, attributable projection of
the act stream — so a reader (human or agent) can answer "who decided what, where, when, and
against which code" from history alone.

## §1 The rule (the amendment's centerpiece)

> **The act↔commit mirror.** Every mutator, having written its own write set, commits exactly that
> write set — **one act, one commit, nothing else in the diff**. The commit is DERIVED, never
> authored: subject and trailers are computed from the act. The **diff is the truth** (it carries
> the exact event line(s) the act appended); the **trailers are the index** (the query keys) — never
> a second source of truth. Fail-soft: the store write stands regardless of the commit
> (`committed <sha>` | `skipped: <why>`), and a commit that sweeps lines from an earlier skipped
> write SAYS SO.

**Granularity: per act** (the 1:1 reading). Not per event (`gate!` would emit 3 commits for one
gesture), not per session (a frame run would coalesce five decisions into one unattributable blob,
and a crash would lose the attribution of every inner act). Measured cost: ~1 store commit per
event (live journey: 197 events) vs today's ~6:1 batching (124 store commits / 747 events).

## §2 Message grammar (mandatory trailers)

```
journey: <id> <action> — <one-line summary>

Journey-Act: gate confirm accept
Journey-Node: 12-operate-loop/03-implementation-bound-record
Journey-Event: confirmed, completed
Journey-Actor: ianluo                # RECORDED_BY
Journey-Channel: service             # cli | service | frame | advance | session
Journey-Wrote: .ann/journey/legs/…/events.jsonl
Journey-Swept: 2                     # ONLY when earlier uncommitted lines rode along
```

`Journey-Actor` + `Journey-Channel` are mandatory: they are what closes the second gap (today a
page click and a proxy write are both `RECORDED_BY=ianluo`, visible only in prose). The subject
keeps the convention already in history (`journey: …`).

Queries this buys (no store access, no `events.jsonl` read):

```bash
# the decision stream of one task, in order, with actor and channel
git log --format='%h %(trailers:key=Journey-Act,valueonly) %(trailers:key=Journey-Actor,valueonly) %(trailers:key=Journey-Channel,valueonly)' \
        -- .ann/journey/legs/<leg>/<task>/events.jsonl
# every human decision in a leg
git log --grep='Journey-Act: gate' --format='%h %s%n%(trailers:key=Journey-Node,valueonly)'
# the exact bytes an act produced
git show <sha>                        # the diff IS the appended event line
```

## §3 Write sets (per act — derived, not a hand-kept list)

The scope is what write-confinement already confines each mutator to (`node.dir` + fixed relative
names); the cross-folder writers are already named in AGENTS.md.

| act | its write set |
|---|---|
| `append!` · `submit!` · `gate!` · `evidence!` · `capture!` · `complete!` | `<id>/events.jsonl` |
| `spawn!` | `<newId>/node.json` + `<newId>/events.jsonl` |
| `goal! met` | `<goalLeg>/events.jsonl` |
| `goal! seed` / reseed | `<goalLeg>/node.json` + `events.jsonl` + `docs/goal.md` + `docs/manifest.json` |
| `goal! archive` | the move: `.ann/journey/**` → `.ann/archive/sessions/<ts>-<slug>/journey/**` |
| `spec!` · design brief · frame intents | `docs/<name>.md` + `docs/manifest.json` |
| `docs --write` · `rules --write` | `docs/manifest.json` · `.ann/rules/check/rules.json` |
| never | `.ann/journey/.ledger.json`, `logs/**` (gitignored — excluded automatically) |

Verified primitive (scratch repo): `git add -- <paths>` + `git commit -m … -- <paths>` commits only
those paths, **leaves another node's dirty file untouched**, and leaves the human's staged unrelated
work staged. Requires `add` + `commit` (a path-scoped `commit` alone will not take an *untracked*
new file, e.g. `spawn!`'s new node.json).

## §4 Guards + failure semantics (fail-soft, never fail-closed)

Skip the commit — with a named reason on the result — when: not a git work tree · mid-operation
(`MERGE_HEAD` / `rebase-merge` / `rebase-apply` / `CHERRY_PICK_HEAD`) · no resolvable identity ·
the path is not already tracked (except the act's own DECLARED new paths — a project that keeps its
journey out of git must not start tracking it because of an accept) · nothing to commit (a re-run).

Never `-a`, never amend, never a path outside the act's own write set, never another node's file.
The store append is the durable act; a commit failure MUST NOT fail the mutator.

Swept lines: if the act's file still holds earlier uncommitted lines (a prior skip — an index-lock
race, a mid-rebase window), the commit carries them and records `Journey-Swept: <n>` so the log
never silently re-attributes another act's write.

## §5 Companion change (must ride along): the verification sha

`capture!` binds `sha = HEAD`. Once every act commits, HEAD moves on every gate action — so the
captured check would bind a *journey* commit, `evidence!` would cite a journey commit as "the commit
that carries the deliverable", and two runs against the same code would stop sharing a sha.

**Rule:** the captured check's `sha` is the last commit that touched **non-store** paths —
`git log -1 --format=%H -- . ':(exclude).ann'` — i.e. the code state the run saw; journey-only
commits never move it. The clean-tree guard already ignores `.ann/`, so this keeps 12/03's
guarantee ("the bytes the run saw") while making it stable.

## §6 Verification (ACs of the implementation)

1. After any mutator: `git status --porcelain -- <its write set>` is empty, and the new commit's
   diff is exactly that write set (no other path, no deletion elsewhere).
2. N acts on a task → N commits, in order, on that task's `events.jsonl` (`git log --follow`).
3. The trailers answer: the decisions on a task, by whom, via which channel; and the code commit a
   verification ran against.
4. Every skip is named on the result AND in the next commit's `Journey-Swept`.
5. Negative: another node's dirty file and the human's staged work are never touched.
6. The mirror is derived: no hand-written commit message in the write path.
7. `capture!` after a journey-only commit still records the same non-store sha as before it.

## §7 Where the clauses land

| doc | clause |
|---|---|
| `flow-control-spec` (v7 → v8) | the gate/gesture write's POSTCONDITION ("the act's write set is committed") + the mirror rule (§1) + skip/fail-soft + the swept-lines honesty clause |
| `architecture` (v3 → v4) | the engine as a NAMED writer of the index + history (a repo-effect, distinct from LB-3's store writer); the mirror is a projection of the store writes, so "every store write ends at `appendEvent()`" stays true |
| `journey-format-spec` (v17 → v18) | the commit grammar + mandatory trailers (§2), the write-set table (§3), the verification-sha rule (§5) |
| `functional-spec` | one F-AC: the mirror is complete and queryable (the log-as-reasoning-source criterion) |
| `AGENTS.md` | the named cross-folder writer ("named here before it exists") + the state-protocol line: reason over `git log`; never read `events.jsonl` |

## §8 Sequencing + the task split

Leg 12's remaining work closes first (the leg gate is derived: leg 13 cannot spawn until every
12-leg task is done), and the contracts below were **spawn-tested against the real gate** in a
scratch project (shape · F-AC19 · naming · sibling prefixes all pass).

The leg itself is AUTHORED WORK (the operator's): a DRAFT to start from, deliberately thin —
the operator owns the wording and spawns it.

**`13-record-mirror`** (leg — DRAFT)

```json
{
  "intent": "THE RECORD'S MIRROR — the engine commits each act's own write set, so git log is the journey's reasoning surface: one act, one commit, a derived message with the actor and channel in its trailers. Today the commit is an unowned actor duty (three human accepts, three fates: two swept in by whoever ran next, one left dirty and blocking advance!).",
  "acceptanceCriteria": [
    "AC-1: the contract stack is amended first (flow-control-spec v8 · architecture v4 · journey-format-spec v18 · AGENTS.md): the mirror rule, the grammar with mandatory trailers, the per-act write-set table, the skip/fail-soft semantics, the verification-sha rule",
    "AC-2: the mechanism is implemented: every mutator commits exactly its own write set, path-scoped, derived, fail-soft, with Journey-Swept honesty for earlier uncommitted lines",
    "AC-3: git log answers the reasoning questions without touching the store: the decisions on a task (in order, with actor and channel), the exact bytes each act produced, and the non-store commit a verification ran against",
    "AC-4: the close-predicate asymmetry found in the 12/03 review is fixed in the same leg (one close rule for complete! and the confirm-accept auto-close)",
    "AC-5: full suite green; ann check/verify clean; each slice committed with evidence"
  ],
  "targetAreas": [
    "docs",
    ".agents/plan",
    "src/commands",
    "src/store",
    "src/surface",
    "src/e2e"
  ],
  "workType": "implementation"
}
```
**Leg 12 is closed out with the operate loop's own work** (02 semantic driver is the frontmost
ready; 03 is done). The mirror is a NEW EPIC (`13-record-mirror`) — the leg gate opens when leg 12's
tasks close. Tasks, ready to spawn (bind each to `13-record-mirror`, whose own contract must be
authored first — the spawn gate needs the leg):

**`13-record-mirror/01-spec-commit-mirror`**

```json
{
  "intent": "Amend the contract stack for THE COMMIT MIRROR — every act commits exactly its own write set, so git log is the record's reasoning surface (design record: .agents/plan/commit-mirror-design.md).",
  "acceptanceCriteria": [
    "AC-1: flow-control-spec v8 carries the write's postcondition (the act's write set is committed), the mirror rule, the skip/fail-soft semantics and the swept-lines honesty clause",
    "AC-2: architecture v4 names the engine as a writer of the index + history (a repo-effect, distinct from LB-3's store writer) and keeps the store's single-writer claim true (the mirror is a projection of the store writes)",
    "AC-3: journey-format-spec v18 carries the commit grammar, the MANDATORY trailers (Journey-Act/-Node/-Event/-Actor/-Channel/-Wrote) and the per-act write-set table",
    "AC-4: the verification-sha rule lands (the captured check binds the last NON-STORE commit — journey-only commits never move it)",
    "AC-5: AGENTS.md names the new cross-folder writer before it exists and states the read rule (reason over git log; never read events.jsonl)",
    "AC-6: the two open dials are DECIDED in the doc, never left implicit: granularity (per act vs per session) and whether the trailers are mandatory or advisory",
    "AC-7: every amended doc is committed with evidence (ann check/verify clean; the operator git-commits the docs)"
  ],
  "targetAreas": [
    "docs",
    ".agents/plan"
  ],
  "workType": "spec"
}
```

**`13-record-mirror/02-implementation-commit-mirror`**

```json
{
  "intent": "Implement THE COMMIT MIRROR: every mutator commits exactly its own write set — a derived message with mandatory trailers, fail-soft, never another act's file, so git log is a complete ordered attributable projection of the act stream.",
  "acceptanceCriteria": [
    "AC-1: the write set is DERIVED per act (write-confined to the addressed node, plus the named cross-folder writers) — no hand-kept path list",
    "AC-2: the commit is PATH-SCOPED (add + commit on those paths only): another node's dirty file and the human's staged unrelated work are never touched",
    "AC-3: guards fail SOFT and are named on the result — not a git work tree, mid-rebase/merge/cherry-pick, no resolvable identity, an untracked path (except the act's own declared new paths), nothing to commit; a commit failure NEVER fails the mutator",
    "AC-4: the message is DERIVED, never authored: subject 'journey: <id> <action>' + mandatory trailers Journey-Act/-Node/-Event/-Actor/-Channel/-Wrote, plus Journey-Swept when earlier uncommitted lines rode along",
    "AC-5: capture! binds the last NON-STORE commit (git log -1 -- . ':(exclude).ann'), so journey-only commits never move the verification sha and two runs on the same code share it",
    "AC-6: granularity is per act, one commit per act (no session coalescing); the frame's inner writes each commit",
    "AC-7: tests: N acts produce N commits in order; the diff IS the write set exactly; the negative cases (another node's file, the human's staged work); a skipped commit is named on the result AND in the next commit's Journey-Swept; the trailer queries answer the decision stream; full suite green; ann check/verify clean"
  ],
  "targetAreas": [
    "src/commands",
    "src/store",
    "src/surface",
    "src/e2e"
  ],
  "workType": "implementation"
}
```

**`13-record-mirror/03-implementation-close-predicate`**

```json
{
  "intent": "Unify the CLOSE PREDICATE: the confirm-accept AUTO-CLOSE enforces the same claim-level rules complete! does (unclaimed ACs, claim-unsubstantiated, claim-failed), so one state has one verdict. Found during the 12/03 review: a claim mapped to an act the log does not hold is refused by complete! (claim-unsubstantiated) while gate! confirm accept still closes.",
  "acceptanceCriteria": [
    "AC-1: ONE close predicate in ONE place, read by complete! AND the confirm-accept auto-close (the leg 08/02 'one rule everywhere' rule)",
    "AC-2: all four refusal codes are reachable on both paths: no-structured-conclusion (an unclaimed AC), claim-unsubstantiated, claim-failed, no-captured-pass",
    "AC-3: tests: a state refused by complete! is NOT auto-closed by an accept; a compliant state still auto-closes in ONE gesture; full suite green; ann check/verify clean"
  ],
  "targetAreas": [
    "src/commands",
    "src/e2e"
  ],
  "workType": "implementation"
}
```

**Open dials** (to settle in the spec session, not by precedent): (1) granularity — per act (this
record's recommendation) vs per session; (2) mandatory vs advisory trailers. A third, not worth a
dial: the swept-lines trailer is mandatory (honesty, not style).
