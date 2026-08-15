# SYSTEM-DESIGN — Ann technique layer

- id: `01-goal/01-grilling/02-system-design` · status: **queued** (waiting on Q1-Q4)
- intent: produce the **system-design doc** — components & ownership, data model, interfaces, failure modes, scale — the technique layer between the locked spec and the implementation slices
- blocking questions carried from `01-grilling`: Q1 runtime (default Node.js+TS) · Q2 provider (default adapter-first, local OpenAI-compatible) · Q3 storage (default SQLite better-sqlite3 + JSON artifacts) · Q4 UI (default CLI + tree artifacts)
- required inputs: `../artifacts/ann-spec.md` (locked @ 2664511), design §15/§16/§21
- deliverable when run: `artifacts/ann-system-design.md` (then lock it)
- children: implementation slices (after this artifact exists — artifact gate)
- search terms: system design, components, data model, interfaces, schema, failure modes, scale, storage, runtime, provider, UI, Q1, Q2, Q3, Q4
