<!-- specs:locked:1811804 2026-08-22 type=record -->
# s2-record — S2 Envision + Grilling (implementation record)

- task: `06-engine-build/05-s2-envision-grilling`
- type: record (v9 §14 implementation artifact)
- status: active — steps 1–2 of 5 done

## Refs (target areas)

- `src/adapters/provider/` — provider adapter (types, registry, oplog, http, index)
- `src/engines/grilling.ts` — grilling engine (F4)
- `rules/adapter/provider.json` — provider registry (resource-registry, category adapter)
- `src/cli.ts` — drive-by fixes (status filter; check state-line "grill pending")

## Commit clues

- `8e94c58` — step 1: provider adapter (frozen contract, fail-closed, op-log)
- `d394ef5` — step 2: grilling engine (provenance layer, fake-precision demotion, PRD)
- `8dbd2f9` — provider design review fixes (per-call provider routing, kind/defaults validation)

## Test evidence

- 63 tests green at `8dbd2f9` (13 provider + 10 grilling + 40 store); typecheck clean

## Conclusion

Steps 1–2 complete (provider adapter + grilling engine). Step 3 (dogfood grill) blocked on provider config (`ANN_LLM_*` unset) — fail-closed, no fabricated run. Steps 4–5 (envision engine + tests) pending. This is the first v9-conformant implementation artifact (dogfood).
