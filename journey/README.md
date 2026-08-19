# Ann build journey

Ann is built and managed with its own journey-of-legs model (design §21 — dogfooding). Until the engine exists, the journey is hand-maintained structured data, operated through `scripts/`.

## The model — a table of legs (formerly "table of rounds")

- `journey/legs/` is the **TABLE**: a chain of legs — the project's forward progress. One store per project.
- **A leg (formerly round) = one step of work = an epic**, gated: a leg closes only when its goal is met (artifacts locked, ACs verified) → next leg begins. Legs are sequential; done legs never change.
- **Leg status is derived from its tasks** (format v7): all tasks done → leg done; leg roots carry **no events** — existence is structural, activity is task states, and closure-by-transfer is recorded on a closure task, never the leg root.
- **Inside a leg:** the leg root + `00/` = the leg's task group (independent tasks, may run in parallel; order by prefix). Tasks can decompose further (level dirs).
- Full contract: **`journey/legs/06-engine-build/00/01-format-amendment-v7/artifacts/journey-format-spec-v7.md`** (locked @ bee8e89; supersedes v6).

## Layout

```
journey/
  legs/
    <NN>-<leg>/                   a leg = an epic
      node.json                   immutable creation record (leg root = epic contract + gate)
      description.md              searchable card (the AI-facing surface)
      artifacts/                  the leg's gate evidence
      <NN>-<level>/<NN>-<task>/   depth-grouped nodes (00/ = the task group)
```

Leg roots have **no `events.jsonl`** (v7). Tasks carry the process log.

## Format rules (summary — see journey-format-spec v7)

- **State is derived, never asserted.** Agents never read `events.jsonl` directly — state comes from the scripts (`--journey`/`--status`/`--check`/`--specs`/`--branch`). Files are read as *content* (artifacts) only.
- **Nodes immutable.** `node.json` written once, never rewritten. Corrections = new nodes (sibling-correction: same level, higher prefix — never nested children).
- **Process = append-only events** on tasks. `events.jsonl`: `created · activated · evidence · artifact-locked · completed · failed · superseded · submitted · confirmed · rejected · gate-revised · transferred · deferred`. Status = tail of the log; appending is the only write op.
- **Leg gate:** leg N+1 spawns only when all of leg N's tasks are `done` (derived aggregate).
- **Parallel group:** independent siblings in `00/` may run in parallel; the leg completes only when all tasks complete.
- **Artifact gate:** a node may not spawn children until its own output artifact exists.
- **Searchable cards:** `rg <term> journey/legs/**/description.md`.
- **Pruning:** completed/superseded subtrees may be pruned (`rm -r`); git is the archive; nodes referenced by live `requiredInputs` are never pruned.
- **Depth budget:** ≤ 8 levels, ≤ 260 chars full path; segments ≤ 24 chars, kebab-case.
- A node commits = branch checkpoint (git commit); RPO = 0 for committed nodes.

## Current journey

```
journey/legs/
  01-goal          (done — L1 gate met: design v3 locked)
  02-grilling      (done — L2: requirements-spec v3 locked @ 80eeaae)
  03-tree-format   (done — L3: format v2 locked; superseded through v6)
  04-system-design (done — L4: ann-system-design locked)
  05-engine        (done — L5: spec round complete — 9 contracts locked; closure-by-transfer: build gate moved to L6)
  06-engine-build  (active — L6: build per ann-system-design v3 S1–S9; amendment tasks 00/01-02 (format v7 + flow-control v4) spawned)
```

## Pre-engine tooling

- `scripts/resolve.mjs` — the derived logical-name resolver + journey/status/gate CLI (`--journey` · `--status` · `--check` · `--specs` · `--branch` · `confirm` · `append`). Built pre-engine in plain Node; the first engine component (S1 seed), used by the bootstrap itself.
- `scripts/validate.mjs` — the rule registry report (rules/check/rules.json); runs the active rules.

## Migration note (2026-08-19)

The store was renamed `tree/rounds/` → `journey/legs/` (unit: round → leg; logical name: tree-format-spec → journey-format-spec). Compatibility symlinks are committed so historical references resolve: `tree → journey` and `journey/rounds → journey/legs`. They can be dropped once no live mechanism reads old paths.
