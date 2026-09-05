<!-- specs:locked:fc15295 2026-08-28 type=record -->
# Eval results — engine-build evals (S9)

Run: 2026-08-28

| KPI | measured | target | verdict |
|---|---|---|---|
| K1 — locate accuracy | 100% (4/4) | 100% | PASS |
| K2 — locate ease | 100% (4/4) | ≤ 2 | PASS |
| K3 — advance ease | 100% (4/4) | ≤ 1 | PASS |
| K4 — advance correctness | 100% (4/4) | ≥ 95% | PASS |
| K5 — completion success (first pass) | 100% (2/2) | ≥ 85% | PASS |

## Dogfooding round-trip (F-AC8)

dogfood round-trip over 54 nodes (6 legs)

- K1 — locate accuracy (dogfood): 100% (54/54) — PASS
- K4 — advance correctness (dogfood): proposed next task: 06-engine-build/09-s6-runner-reviewer (queued) — PASS

## Failure signal: **not armed**

A KPI below target arms the signal (requirements-spec v3 §5): K3 above target, K4 below, or K5 below → the "structure is the log" bet is failing → stop and redesign (navigation if K3/K4, the flow itself if K5).

## Details

- [K1] K1 — locate accuracy: 100% (4/4) — derived status == ground truth on nav-frontmost (4 nodes)
- [K1] K1 — locate accuracy: 100% (3/3) — derived status == ground truth on nav-blocked-gate (3 nodes)
- [K1] K1 — locate accuracy: 100% (3/3) — derived status == ground truth on nav-leg-gate (3 nodes)
- [K1] K1 — locate accuracy: 100% (3/3) — derived status == ground truth on nav-mixed-superseded (3 nodes)
- [K2] K2 — locate ease: 2 interactions (status + history) — 01-leg/03-c: status + history located in 2 reads
- [K2] K2 — locate ease: 2 interactions (status + history) — 01-leg/01-a: status + history located in 2 reads
- [K2] K2 — locate ease: 2 interactions (status + history) — 01-leg/02-b: status + history located in 2 reads
- [K2] K2 — locate ease: 2 interactions (status + history) — 01-leg/02-b: status + history located in 2 reads
- [K3] K3 — advance ease: 1 interaction (advance()) — nav-frontmost: the next action came from one advance() call
- [K3] K3 — advance ease: 1 interaction (advance()) — nav-blocked-gate: the next action came from one advance() call
- [K3] K3 — advance ease: 1 interaction (advance()) — nav-leg-gate: the next action came from one advance() call
- [K3] K3 — advance ease: 1 interaction (advance()) — nav-mixed-superseded: the next action came from one advance() call
- [K4] K4 — advance correctness: 100% (this fixture) — nav-frontmost: proposed 'next task: 01-leg/03-c (queued)' — right per the flow rules (frontmost-ready, gate-respecting)
- [K4] K4 — advance correctness: 100% (this fixture) — nav-blocked-gate: proposed 'next task: 01-leg/02-b (queued)' — right per the flow rules (frontmost-ready, gate-respecting)
- [K4] K4 — advance correctness: 100% (this fixture) — nav-leg-gate: proposed 'every leg derived done — journey goal complete (or needs a closure decision)' — right per the flow rules (frontmost-ready, gate-respecting)
- [K4] K4 — advance correctness: 100% (this fixture) — nav-mixed-superseded: proposed 'every leg derived done — journey goal complete (or needs a closure decision)' — right per the flow rules (frontmost-ready, gate-respecting)
- [K5] K5 — completion success (first pass): first-pass ✓ — flow-spec: completed · artifactVerified=true · evidenceCommitted=false · rework=false — ACs met on first pass (verified by work, not words)
- [K5] K5 — completion success (first pass): first-pass ✓ — flow-multi: completed · artifactVerified=true · evidenceCommitted=false · rework=false — ACs met on first pass (verified by work, not words)
- [K5] K5 — completion success (first pass): NOT first-pass — flow-rework: completed · artifactVerified=true · evidenceCommitted=false · rework=true — honestly NOT counted as a pass (no fake success)
- [K5] K5 — completion success (first pass): NOT first-pass — flow-empty-chain: blocked-waiting · artifactVerified=false · evidenceCommitted=false · rework=false — honestly NOT counted as a pass (no fake success)
