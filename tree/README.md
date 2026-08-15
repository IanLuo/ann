# Ann build tree

Ann is built and managed with its own tree-of-steps model (design §21 — dogfooding). Until the engine exists, the tree is hand-maintained structured data.

## Layout

```
tree/
  README.md            this file
  nodes/               the tree — each node is a DIRECTORY
    <NN>-<name>/node.json         immutable creation record (contract, ACs, open questions)
    <NN>-<name>/events.jsonl      append-only event log (the process; status is derived from its tail)
    <NN>-<name>/description.md    searchable card for agents/humans (grep target)
    <NN>-<name>/artifacts/        this node's output artifacts
    <NN>-<name>/<NN>-<child>/...  children = subdirectories
```

## Format rules (v0, pre-engine — formalized by n03-system-design)

- **The directory tree IS the tree.** Parent = dirname · children = subdirectories · id = path (`01-goal/01-grilling`). No `parentId`/`children` fields — they would be second copies of a fact and drift.
- **Nodes are immutable.** `node.json` is written once at creation and never rewritten. You cannot travel in time: you can't re-parent, re-contract, or delete history. Corrections = new nodes (repair branch, amendment node whose artifact supersedes).
- **The process is append-only events.** `events.jsonl`: one JSON object per line, `{at, type, note}` — `created · activated · extended · evidence · artifact-locked · completed · failed · superseded`. Status = tail of the log. Appending is the only write operation.
- **Sibling order = sort prefix** (`01-goal/`, `01-grilling/`, `02-system-design/`). "Frontmost ready node" (v1 sequential execution) = lowest prefix among ready siblings.
- **Artifact gate:** a node may not spawn children until its own output artifact exists (in `artifacts/`).
- **description.md is the searchable memory** (design §21.9): `rg "KPI" tree/nodes/` finds the card without parsing JSON or merging logs. It is written at creation; live state always comes from `events.jsonl`.
- A node commits = branch checkpoint (git commit containing that node's files + artifacts). RPO = 0 for committed nodes.

## Current tree

```
01-goal (done)
└── 01-grilling (done → artifact: artifacts/ann-spec.md, locked @ 2664511)
    └── 02-system-design (queued → needs Q1–Q4 answers)
        └── (children = implementation slices, spawn after system-design artifact)
```
