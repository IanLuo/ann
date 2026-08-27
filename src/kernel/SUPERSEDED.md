# Superseded

The planner-kernel layer that lived here (kernel.ts, executor.ts, flow.ts,
interact.ts, step.ts, registry.ts, and the validate/envision/spec steps) is
**superseded** by the core re-implementation (task `06-engine-build/24-core-reimpl`,
core-design @ f7fb400).

Where it went:

- the L1 command surface, the derived views (`frontmostReady` / `lookBack` /
  `advance`), and the single writer → `src/commands/`, `src/store/`
- the resumable coordinator + intent translation + chain schema + general config
  → `src/flow/`
- the steps (`idea-validate`, `envision`, `spec`) on the §2 contract
  → `src/flow/steps/`
- the ability wiring (recording/replaying wrapper, provider llm, console
  interact) → `src/abilities/`

This directory remains only so that the journey's own traceability record — task
`06-engine-build/08-s5-planner-kernel`, whose evidence refs `src/kernel/` — keeps
a resolvable target. The ref resolves to the archive, not to a live layer.
