# e2e proof — the artifact collapse (leg 07, task 07)

Fresh project drive under `/tmp/ann-collapse-e2e.G1MkHM`, real CLI binary
(`node dist/surface/cli.js`), `.js` deliverable.

**Lifecycle driven (all writes via the CLI):**
`spawn! 01-leg` → `spawn! 01-leg/01-a` → evidence (`refs` = an `artifacts/analysis.md` fixture) →
`submit! grill` + `gate! grill accept` → **`lock! 01-leg/01-a meter .ann/journey/legs/01-leg/01-a/artifacts/meter.js`**
→ `submit! confirm` + `gate! confirm accept` → `completed` → git commit → `check` / `verify`.

**Results:**

| Check | Outcome |
|---|---|
| `lock!` of a `.js` deliverable | locked meter @ `3aac62c` — ANY file type locks (F3 gone) |
| AC1 — file untouched after lock | `.js` byte-identical, no marker stamp |
| `check` | **0** — "OK — 1 current artifacts, no gate gaps" |
| `verify` | **0** — "clean — the log and the filesystem agree (0 drifts)" |
| F4 — evidence-cited fixture | `analysis.md` is claimed via `evidence.refs[]` — not an `artifact-orphan` |
| `read meter` / `current meter` / `specs` | resolve from the log to the producer's own `.js` file, content verbatim |
| docs/ layer | **absent** — no `.ann/docs` created (thin model never mirrors) |

**F3/F4 reproductions from the original drive now pass clean.** The thin `lock!` records
`{name, path, lockSha}` over the producer's own file and never writes/copies/stamps/symlinks it.
