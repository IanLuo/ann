# Ann build journey

Ann is built and managed with its own journey-of-legs model (design §21 — dogfooding). Until the engine exists, the journey is hand-maintained structured data, operated through `scripts/`.

## The model — a table of legs (formerly "table of rounds")

- `journey/legs/` is the **TABLE**: a chain of legs — the project's forward progress. One store per project.
- **A leg (formerly round) = one step of work = an epic**, gated: a leg closes only when its goal is met (artifacts locked, ACs verified) → next leg begins. Legs are sequential; done legs never change.
- **Leg status is derived from its tasks** (format v7): all tasks done → leg done; leg roots carry **no events** — existence is structural, activity is task states, and closure-by-transfer is recorded on a closure task, never the leg root.
- **Inside a leg:** the leg root + the task group — tasks live **directly under the leg dir** (`<NN>-<name>/`), independent, may run in parallel, order by prefix. Sub-steps nest inside a task's own dir (flat shape, v8).
- Full contract: **`journey/legs/06-engine-build/03-format-amendment-v8/artifacts/journey-format-spec-v8.md`** (lock pending; supersedes v7).

## Layout

```
journey/
  legs/
    <NN>-<leg>/                   a leg = an epic
      node.json                   immutable creation record (leg root = epic contract + gate)
      description.md              searchable card (the AI-facing surface)
      artifacts/                  the leg's gate evidence
      <NN>-<task>/               a task = one unit of work (independent, parallel)
```

Leg roots have **no `events.jsonl`** (v7). Tasks carry the process log.

## Format rules (summary — see journey-format-spec v7)

- **State is derived, never asserted.** Agents never read `events.jsonl` directly — state comes from the scripts (`--journey`/`--status`/`--check`/`--specs`/`--branch`). Files are read as *content* (artifacts) only.
- **Nodes immutable.** `node.json` written once, never rewritten. Corrections = new nodes (sibling-correction: same level, higher prefix — never nested children).
- **Process = append-only events** on tasks. `events.jsonl`: `created · activated · evidence · artifact-locked · completed · failed · superseded · submitted · confirmed · rejected · gate-revised · transferred · deferred`. Status = tail of the log; appending is the only write op.
- **Leg gate:** leg N+1 spawns only when all of leg N's tasks are `done` (derived aggregate).
- **Parallel group:** independent task siblings under the leg may run in parallel; the leg completes only when all tasks complete.
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
  06-engine-build  (active — L6: build per ann-system-design v3 S1–S9; amendment tasks 01-format-amendment-v7, 02-flow-control-v4, 03-format-amendment-v8)
```

## Pre-engine tooling

- `src/cli.ts` — the **engine CLI seed** (`npm run ann` / `node dist/cli.js`): the full read+manage surface backed by the Store (`--journey` · `--status` · `--check` · `--specs` · `--branch` · `journey` · `confirm` · `append` · `spawn` · `gate` · `lock` · `supersede` · `card`). Verified for data parity with the pre-engine scripts on the real journey (`--journey`/`--status` byte-identical; `--check`/`--specs`/`locate`/`--branch` same data).
- `scripts/resolve.mjs` — the pre-engine resolver + bookkeeper (superseded by `src/cli.ts` as the engine lands; kept working until the absorption is complete).

- `scripts/resolve.mjs` — the derived logical-name resolver + journey/status/gate CLI + **the bookkeeper** (`--journey` · `--status` · `--check` · `--specs` · `--branch` · `confirm` · `append` · `spawn` · `gate` · `lock` · `supersede` · `card`). Built pre-engine in plain Node; the first engine component (S1 seed), used by the bootstrap itself.
- **Bookkeeper discipline:** every store mutation goes through a command, never a hand edit. `spawn` validates shape (v8 flat), name discipline, artifact gate, leg gate, prefix uniqueness; `gate` records human decisions (3-reject bound); `lock` stamps the marker + hash-verifying `artifact-locked` (one current per name); `supersede` records the forward pointer; `card` regenerates `description.md` (the only rewritable file).
- **Integrity (v8):** `--check` verifies every current artifact against its lock — marker-stripped blob vs the recorded sha (new locks: hard error; legacy commit-style records: drift warnings; working-tree tampering: hard error).
- `scripts/validate.mjs` — the rule registry report (rules/check/rules.json); runs the active rules. Both scripts consume the **vocab registry** (`rules/schema/vocab.json` — event types, statuses, gates, artifact types; resource-registry spec instance #2); no layer hardcodes vocabulary.

## Migration note (2026-08-19)

The store was renamed `tree/rounds/` → `journey/legs/` (unit: round → leg; logical name: tree-format-spec → journey-format-spec). **The compat symlinks (`tree → journey`, `journey/rounds → journey/legs`) were removed the same day** — legacy recorded paths (`tree/rounds/…`, e.g. the design artifact's structured event) normalize to the current layout in the resolver (`legacyPath`), so the store is exactly one folder: `journey/` containing `legs/`. Historical references in locked docs may still cite old paths — they are history, not resolution inputs.
