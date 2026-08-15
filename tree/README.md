# Ann build tree

Ann is built and managed with its own tree-of-steps model (design §21 — dogfooding). Until the engine exists, the tree is hand-maintained structured data.

## Layout

```
tree/
  README.md            this file
  nodes/<id>.json      one StepNode per file (schema: design §21.3)
  artifacts/           node output artifacts (PRD, specs, evals...)
```

## Rules (mirror of §21)

- **Artifact gate:** a node may not spawn children until its own output artifact exists.
- **Status:** `queued | active | blocked | done | failed | skipped`.
- **Blocked** means the node produced what it could and is waiting on input — never fake it done.
- **distanceToGoal** is a set (unverified ACs + frontier leaves + open questions), never a scalar.
- A node commits = branch checkpoint (git commit containing that node's file + artifacts).

## Current tree

```
n01-goal (done)
└── n02-requirement-grilling (done → artifact: tree/artifacts/ann-spec.md, locked @ 2664511)
    └── n03-system-design (queued → needs Q1–Q4 answers)
        └── (children = implementation slices, spawn after system-design artifact)
```
