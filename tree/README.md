# Ann build tree

Ann is built and managed with its own tree-of-steps model (design §21 — dogfooding). Until the engine exists, the tree is hand-maintained structured data.

## The model — a table of rounds

- `tree/rounds/` is the **TABLE**: a chain of rounds — the project's forward progress. One store per project.
- **A round = one step of work = an epic**, gated: a round closes only when its goal is met (artifacts locked, ACs verified) → next round begins. Rounds are sequential; done rounds never change.
- **Inside a round:** the epic root + `00/` = the round's task group (independent tasks, may run in parallel; order by prefix). Tasks can decompose further (level dirs).
- **Round dependency:** each round's root consumes the previous round's artifact. R1 (goal) is the base step.
- Full contract: **`05-engine/00/04-format-amendment-v3/artifacts/tree-format-spec-v3.md`** (supersedes v1 + depth policy).

## Layout

```
tree/
  rounds/
    <NN>-<round>/                 a round = an epic
      node.json                   immutable creation record (round root = epic contract + gate)
      events.jsonl                append-only log (status derived from tail)
      description.md              searchable card
      artifacts/                  round's gate evidence
      <NN>-<level>/<NN>-<task>/   depth-grouped nodes (00/ = the task group)
```

## Format rules (summary — see tree-format-spec-v3)

- **Directory tree IS the tree.** Parent = dirname · children = subdirectories · id = path from `tree/rounds/`. No `parentId`/`children` fields.
- **Nodes immutable.** `node.json` written once, never rewritten. Corrections = new nodes (sibling-correction: same level, higher prefix — never nested children).
- **Process = append-only events.** `events.jsonl`: `{at, type, note}` — `created · activated · extended · evidence · artifact-locked · completed · failed · superseded` (+ `spawned`). Status = tail of the log. Appending is the only write op.
- **Round gate:** no node of round N+1 before round N's root has a `completed` event.
- **Parallel group:** independent siblings in `00/` may run in parallel; the round completes only when all tasks complete.
- **Artifact gate:** a node may not spawn children until its own output artifact exists.
- **Searchable cards:** `rg <term> tree/rounds/**/description.md`.
- **Pruning:** completed/superseded subtrees may be pruned (`rm -r`); git is the archive; nodes referenced by live `requiredInputs` are never pruned.
- **Depth budget:** ≤ 8 levels, ≤ 260 chars full path; segments ≤ 24 chars, kebab-case.
- A node commits = branch checkpoint (git commit); RPO = 0 for committed nodes.

## Current tree

```
tree/rounds/
  01-goal          (done — R1 gate met: design §21 locked)
  02-grilling      (done — R2: requirements-spec locked @ 89ace76; ann-spec superseded)
  03-tree-format   (done — R3: format v1 locked @ ba528d1; superseded by v2)
    └── 01-depth-policy  (superseded — absorbed into v2)
  04-system-design (active — R4: tasks spawned, gate pending)
    └── 00/
        ├── 01-format-amendment-v2   (active — v2 draft, lock pending)
        └── 02-system-design-doc     (queued — blocked on v2 lock + Q1–Q4)
  05-engine        (future — R5, parallel task group)
```
