---
name: engine-build
type: round
round: 06-engine-build
status: queued
summary: "Build the engine v1 — 13 components (S1-S9 group), the transferred R5 gate"
find-me-when:
  - "the build / engine / S1-S9"
  - "first code / tree store"
  - "K1-K5 measurement"
---
# ENGINE BUILD — R6

- id: `06-engine-build` · status: **queued** (spawned via closure-by-transfer)
- round: R6 · input: R5's artifacts (9 locked contracts — by logical name)
- intent: build **engine v1** — the 13 components as a parallel task group (S1-S9), per ann-system-design v3
- gate (transferred verbatim from R5): engine v1 works (CLI per F1-F17) + K1-K5 measured on fixtures
- rounds chain: ← `05-engine` (closed, specification) · → R7+ (bindings expansion, web UI)
- search terms: engine, build, S1, S9, tree store, K1, K5, components, src
