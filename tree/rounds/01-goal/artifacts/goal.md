# Ann — refined goal & success definition

*R1 artifact (goal round). Supersedes nothing; the base step.*

- **Refined goal:** build Ann — a tree-of-steps planning system that converts ambiguous human goals into a table of rounds (epics): sequential, gated rounds; parallel task groups; per-step context packets; tree-as-memory; external bindings as node I/O.
- **Success definition:** a downstream runner completes the user's goal using only tree-derived context (context packets + artifacts + ordinary project access), and any failed subtree re-plans instead of failing upward silently. Measured: requirements-spec K1–K4 on the fixture suite.
- Canonical model: `01-goal/artifacts/design.md` (v3, locked @ fd1125c) · requirements: `02-grilling/01-spec-rework/artifacts/requirements-spec.md` · format: `tree-format-spec-v2` · technique: `ann-system-design`.
