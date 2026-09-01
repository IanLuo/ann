# Known issues

## check() F-AC18: legacy refs into the retired docs layer

**Accepted 2026-08-30.** After the artifact-collapse (leg 07), `check` on this repo reports
15 problems (13 F-AC18 + 2 F-AC19) — an accepted baseline, up from 7 pre-collapse.

8 of the F-AC18 failures are legacy `evidence.refs[]` from legs 01–06 (format-v10 era) that
point at `docs/…` / `.ann/docs/…` paths. Those paths resolved only through the `.ann/docs/`
symlink layer, which the approved artifact-collapse plan deliberately retired (task 06 AC3).
The refs are historical evidence referencing a deleted layer; `verify` is unaffected
(4 pre-existing drifts, 0 new). New evidence refs use real producer paths and resolve cleanly.

Disposition: **accepted and documented** — not migrated, not restored, no check() code change.
The root `docs -> .ann/docs` compat symlink was removed with the layer.
