# 04-s1-tree-store

- id: `06-engine-build/04-s1-tree-store` · status: queued · type: task
- summary: Tree store (S1) — reads/writes legs, nodes, events, artifacts per journey-format-spec v8; builds the in-memory tree; enforces schema, append-only, immutability, leg gate; owns the single appendEvent() write function (architecture LB-3 — the only writer); exposes derived views (status/resolution/branch) for shared readers. Absorbs scripts/resolve.mjs + validate.mjs as the store seed.
- search terms: Tree, store, reads, writes, legs, nodes, events, artifacts
