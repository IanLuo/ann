# ENGINE — build Ann v1

- id: `05-engine` · status: **queued** (R5 — next round; task group planned, spawns on activation)
- round: R5 · input: R4's artifacts (ann-system-design @ ca32421, tree-format-spec-v2 @ 9e37c8f, requirements-spec @ 89ace76)
- intent: build the **engine v1** — the parallel task group (one per component, ann-system-design §1):
  - S1 tree store + planner kernel · S2 grilling engine · S3 context assembler · S4 validators · S5 provider adapter · S6 runner reviewer · S7 GitHub binding · S8 renderers · S9 eval harness
- round gate: engine working (CLI: plan/run/tree/step/resume) + K1–K4 measured on fixtures; K4>5 = stop feature work (failure signal)
- dogfooding gate: ann's own tree managed through the engine (round-trip)
- rounds chain: ← `04-system-design` · → R6+ (bindings expansion, evals growth)
- search terms: engine, slices, components, tree store, planner kernel, grilling, context assembler, validators, reviewer, adapters, renderers, eval harness, K1, K2, K3, K4
