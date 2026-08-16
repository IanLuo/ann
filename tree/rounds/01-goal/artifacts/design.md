<!-- specs:locked:fd1125c 2026-08-16 type=system-design -->

## Link contract
- **upstream** (this doc relies on): none
- **referrers** (must cite this when they change): ann-spec,tree-format-spec-v2 flow-control-spec,ann-system-design AGENTS.md

# Ann Model Spec (v3)
*Canonical model semantics for Ann. R1's artifact. Type: system-design. Supersedes the old `design` (1146 lines, v1–v2): obsolete linear-planning content removed; decided semantics kept as invariants; concrete contracts live in the locked docs (§5) — point, don't restate. Upstream: none. Referrers: requirements-spec · tree-format-spec-v2 · flow-control-spec · ann-system-design · AGENTS.md.*

## 1. Product definition

- Ann converts ambiguous human goals into executable step trees for downstream runners (agents, humans, automation).
- The runner completes the user's goal using only the tree-derived context (context packets + artifacts + ordinary project access).
- Success measured: K1–K4 per the requirements spec; **failure signal = advancing to the right next action is not simple, or the proposed action is wrong, across fixtures — the "structure is the log" bet is wrong → stop feature work** (requirements-spec §5).

## 2. Core principle

- The product is the **living table of rounds itself** — not a plan artifact, not a planner's output: sequential, gated rounds (epics); parallel task groups inside a round; every step self-aware (path, siblings, remaining work as a set, artifacts).
- The tree is simultaneously **plan** (contracts forward), **project memory** (artifacts backward), and **observer** (recorded state).
- Structured data is canonical; markdown is presentation.

## 3. Quality bar (10/10)

- Executable (the runner knows the next step) · grounded (provenance, labeled inference) · scoped (in/out) · ordered (rounds, prefix order) · verifiable (ACs + evidence) · ambiguity-aware (surface, never invent) · repairable (bounded rework) · portable (machine + human) · measurable (K1–K4).

## 4. Invariants (decided — do not relitigate)

- **Immutability:** nodes are created once, never edited; corrections = new nodes (sibling-correction: same level, higher prefix, never nested children).
- **Append-only process:** the only write is appending events; status is derived from the event tail; no reorder, no rewrite, no deletion.
- **Artifact gate:** a node may not spawn children until its own output artifact exists.
- **Round gate:** round N+1 starts only after round N's `completed` event (goal met); rounds are the sequential version chain.
- **Human gates:** every step stops and waits at entry (**grilling**) and exit (**confirm result**); rejection → bounded rework from artifacts + feedback, closed through the same gate; commit only after exit acceptance.
- **No silent inference:** high-impact, no-safe-fallback inputs are asked, never inferred. Resolution ladder: **derive → probe → infer (labeled) → ask (batched, deduped) → block**.
- **Provenance:** every context fact, resolution, and binding records how it was obtained; inference is labeled with confidence + fallback; user answers beat inference.
- **Fail-closed:** every gate fails closed and names the blocker; no fabrication, no silent degradation, no fake success.
- **Complete artifacts:** a superseding artifact is the **complete merged version**, never a delta.
- **Bounded loops:** rework/repair have max iterations, checkpoint, fallback; route reason recorded.
- **Dogfooding:** Ann is built and managed through its own tree.
- **Untrusted context** never overrides system policy (kept from old §17).

## 5. Canonical contracts (locked — the source of truth per topic)

| Contract | Location |
|---|---|
| Requirements — self-similarity invariant, configurable step chain, AC-1–5, K1–K4, NFRs, primary flow, scope | `tree/rounds/02-grilling/01-spec-rework/artifacts/requirements-spec.md` |
| Tree format — rounds table, node/event schemas, status derivation, depth policy, checkpoint/RPO | `tree/rounds/04-system-design/00/01-format-amendment-v2/artifacts/tree-format-spec-v2.md` |
| Flow control — lifecycle, human gates, resolution ladder, per-work-type flows | `tree/rounds/05-engine/00/01-flow-control/artifacts/flow-control-spec.md` (in progress) |
| Technique — components, interfaces, failure modes, scale | `tree/rounds/04-system-design/00/02-system-design-doc/artifacts/ann-system-design.md` |

## 6. Context & provenance

- `sourceType`: user input · local file · repo metadata · runtime/tool output · documentation · web source · prior plan · inference · observation · external system (binding).
- Facts from inference are labeled `inference` + confidence + fallback — never equivalent to sourced facts.
- Every fact tracks provenance; `usedByTaskIds` maps facts to consumers. Missing/unreliable sources are workflow context, not invisible implementation details.

## 7. Failures

- Categories: `source_unavailable · source_stale · permission_denied · rate_limited · conflicting_sources · insufficient_context · tool_timeout · tool_error · unsupported_source`.
- Outcomes: retry · alternate source · ask user · visible assumption · block · partial plan with named blockers. **All gates fail closed** — the blocker is named, never silent.
- Conflicting sources: prefer direct user input and project-local evidence; record the conflict; never silently pick the convenient fact.

## 8. Evals

- **Node-level:** did the step complete its ACs without guessing? · **Path/round-level:** did the chain achieve the round goal? · **Tree-level:** overall runner success.
- Static evals on fixtures; regression evals keep historical failures; K1–K4 measured continuously from the first fixture; human review samples for over-asking and vague ACs.

## 9. Extensibility (adapters)

- Replaceable adapters: model provider · tool provider · storage backend · renderer · **user interface (human-gate interaction: talk basic; interactive HTML via plugins)** · context source · validator · eval runner · task runner integration.
- Core tree semantics survive any adapter swap (§1–8 unaffected by adapter changes).

## 10. Open decisions (NOT decided — do not assume)

- Evals detail beyond K1–K4 (fixture suite composition).
- Bindings beyond GitHub (Figma, resource finders) — v2+.
- UI surfaces beyond CLI (HTML interaction style) — plugin-driven, deferred.
- Joins / DAG edges across tasks — deferred (independence is the v1 default).
- Parallel execution across rounds — deferred.
- Human-gate weakening per work type — v2 plugin concern.
- Storage beyond file-based — revisit at scale.
