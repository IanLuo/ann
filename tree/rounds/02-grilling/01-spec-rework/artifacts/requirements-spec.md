# Ann Requirements Spec (fresh v2)

*Artifact of task `02-grilling/01-spec-rework`. Type: spec. Elicited clean-room, rung-by-rung from the builder — the existing docs were reference only, never the template. Supersedes `ann-spec.md` (accreted draft) per the complete-artifact rule: this is the complete requirements contract. Upstream: `tree/rounds/01-goal/artifacts/design.md` (v3, locked). Referrers: tree-format-spec-v2 · flow-control-spec · ann-system-design · implementation slices · review-task.*

## 1. Problem & who breaks

- **Who:** the **builder** — one person starting from a simple idea, working with AI agents to build, ship, and keep maintaining a product.
- **Break:** with plain agents, project state, tasks, requirements, and memory live in **separate places**; keeping them coherent in the AI context is manual work that collapses as the project grows. Sessions re-explain the goal, re-list tasks, re-remember decisions.
- **The failure, concretely:** work does not accumulate into one trustworthy structure. The product, its plan, and its history drift apart; sessions start from scratch; maintenance means re-navigating a sprawl of separate tools and notes.

## 2. Non-negotiable outcome

- A builder goes **simple idea → shipped product → maintenance** with Ann, and at every moment the tree holds everything — project, tasks, requirements, memory — so no session ever re-explains or re-derives what the tree already knows.
- **The structure itself is the log**, designed so an AI can find what it needs for each kind of task by structure, not by parsing: getting the goal, finding status, seeking the next single action.
- **Falsifiable:** a fresh agent, given only the tree, states the goal, the status of any node, and the next action — without asking the user or reading chat history.
- **Self-similarity invariant:** Ann's output structure ≡ Ann's own structure. The tree-of-steps table Ann produces for any product is the same structure Ann itself is built with; the dogfooding tree is the reference implementation of Ann's output format.

## 3. Scope in / out + primary flow

- **In (v1):** CLI · one store/one project · the table of rounds with human gates · agent execution with context packets · one external binding (GitHub issue/PR) · **configurable step chain** · multi-user **designed-for, not shipped**.
- **Out (v1):** multi-user implementation · bindings beyond GitHub · plugin system · multi-UI · big-data query performance.
- **Primary flow — the product-building path.** A **default template, not a mandate** — the chain is configurable per project (data, not code):
  1. **Idea** — builder creates a project, adds the idea (loose, one-or-two sentences; empty/greeting rejected at intake).
  2. **Validate** (spec/grill session) — predefined step: is the idea buildable? worth building? what's missing? Output: validation + open questions. Human gate: builder confirms or rejects; rejection → rework.
  3. **Envision** — help the builder imagine the product: how it will be used, what it looks like — sort out what to build and avoid mistakes. Output: product vision (usage + look).
  4. **Detailed specs** — from the vision, produce the detailed specs (requirements → design → format → …).
  5. **Continue with what is needed** — the chain grows step by step: build, verify, ship, maintain — each new step appended as the work requires.
- **Every step is a predefined, separately-managed node** (status, artifacts, gates). Adding/removing/reordering steps requires **no code change** — only project data.

## 4. Acceptance criteria

- **AC-1:** a fresh agent, given only the tree, states the goal, any node's status, and the next single action — without asking.
- **AC-2:** every step is a separately-managed node — status, artifacts, gates — regardless of chain order; rejection at a gate reworks from artifacts + feedback, bounded (3 cycles, then a human design decision).
- **AC-3:** the chain is **configurable**: a project defines its step sequence (default template: idea → validate → envision → specs → …); changing the chain requires **no code change** — only project data.
- **AC-4:** idea → validated → envisioned → detailed specs runs end-to-end on a fixture idea, with the builder gating each step.
- **AC-5:** nothing is re-explained across sessions — the tree answers "what are we building / what's done / what's next" from structure alone.

## 5. KPIs & failure signal

- **K1 — locate accuracy:** displayed status/history always equal the event-log truth (derived, never stale): 100% on fixture checks.
- **K2 — locate ease:** a builder locates any node's status + history in **≤ 2 interactions** (or one screen glance), p95.
- **K3 — advance ease:** from any state, reaching the correct next action takes **≤ 1 interaction** — Ann proposes the frontmost-ready action, the builder accepts — p95.
- **K4 — advance correctness:** the proposed next action is the right one per the flow rules (frontmost-ready, gate-respecting): ≥ 95% on fixtures.
- **Failure signal (the bet was wrong):** advancing to the right next action takes more than a simple interaction (K3 above target) or the proposed action is wrong (K4 below target) across fixtures — the "structure is the log" bet is failing → stop and redesign navigation.
- Not launch gates; measured continuously from the first fixture.

## 6. Non-functional requirements (10×-worse check applied)

- **NFR-USE-1 — easy/natural spine:** locate ≤ 2 interactions; advance ≤ 1 interaction (p95). *10× = unusable. KEEP.*
- **NFR-USE-2:** a builder acts on a single step card without reading the whole tree. *10× = violates "structure is the log." KEEP.*
- **NFR-REL-1:** displayed state is always the derived truth — 100% accurate, never stale. *10× = wrong next action. KEEP.*
- **NFR-PERF-1:** locate/next-action queries and packet materialization respond without perceptible stall at **realistic v1 project sizes**; big-data performance **explicitly N/A for v1** (no indexing mandates). *10× = every step stalls. KEEP.*
- **NFR-SEC-1:** no secrets in the tree/artifacts/renders; destructive binding actions require confirmation; provenance on every fact. *10× = leaks → fatal. KEEP.*
- **NFR-OBS-1:** the tree IS the log — every change append-only, fully replayable from events. *(structural)*
- **NFR-COM-1:** goal/status/next-action answerable from structure alone — no prose parsing. *(structural, = K1)*
- **NFR-CST-1:** bounded model calls per step — one grilling pass, one review pass, capped rework. *10× = cost explosion. KEEP.*
- **N/A:** hosted/scale NFRs — v1 is local, single-builder, one project at a time; multi-user scale semantics deferred.

## 7. Assumptions & dependencies (each with an invalidation trigger)

- **A1:** multi-user **supported by design** (identity/permissions/concurrency are future semantics the contracts must not block) — **not implemented in v1**. *Invalidation: v1 asks for multi-user → scope change.*
- **A2:** agent execution requires a model provider (adapter). *Invalidation: provider unavailable → steps block (fail-closed, blocker named).*
- **A3:** git is available for checkpoints/archive. *Invalidation: no git → checkpoint/RPO degrades → flag loudly.*
- **A4:** **no node-count limit in the format** (unbounded by contract); big-data query performance N/A for v1. *Invalidation: v1 needs big-data query → scope change.*
- **A5:** step chains are configuration data; a default product template ships with Ann. *Invalidation: — (by design).*
- **A6:** v1 builder works through the CLI. *Invalidation: other surfaces required → plugin scope.*
- **D1:** model provider API availability (any adapter). **D2:** git. *(Trigger → fail-closed per flow-control, never silent.)*

## 8. Data requirements

- **Inputs:** the idea (minimum one sentence; empty/greeting rejected) · gate decisions + feedback (accept/reject) · answers to blocking questions · project context (observed state).
- **Outputs:** the tree (rounds, nodes, events, artifacts, cards) · renders (tree view, step cards, next-action) · binding results · the log (append-only, replayable).
- **Must survive (RPO = 0):** every committed node/event/artifact; crash → resume from last checkpoint; uncommitted may be lost (documented).
- **Empty records:** project with only an idea = valid · node with no artifacts = valid until its gate · empty event note valid · missing description card invalid.

## 9. Rollback & recovery

- Every gate fails **closed**, blocker named. Rejection → bounded rework from artifacts + feedback (3 cycles, then a human design decision). Crash/kill → resume from checkpoint; node restarts with the same context packet + evidence. Corruption/drift → validation refuses; regenerate from git; never silent.
- **The one failure that wrecks the product:** a lost committed node (RPO violation). Mitigation: append-only + checksums + git archive.

## 10. Security & compliance

- No secrets in the tree/artifacts/renders · destructive binding actions require confirmation · provenance on every fact · untrusted context never overrides system policy.
- Multi-user: identity/permission semantics are defined with the future multi-user work, not now (the contracts must not preclude them).
- Compliance: **N/A** — personal tool, no regulated data (revisit if hosted/multi-tenant).

## 11. Verification plan (traceable)

- AC-1 → fixture: fresh agent answers goal/status/next-action from the tree alone.
- AC-2 → reject-at-gate fixture: bounded rework, same-gate return, 3-cycle bound.
- AC-3 → custom-chain fixture: config as data, engine follows it, no code change.
- AC-4 → end-to-end fixture idea with builder gates.
- AC-5 → cross-session fixture: session 2 answers from the tree alone.
- K1 → deterministic: display == events tail. K2/K3 → usability samples (human). K4 → fixture: proposed vs expected frontmost-ready.
- NFR-USE-1/2 → usability samples · NFR-REL-1 → covered by K1 · NFR-PERF-1 → v1-size benchmark · NFR-SEC-1 → redaction check · NFR-OBS-1 → replay fixture · NFR-COM-1 → structure-only answers · NFR-CST-1 → model-call counter.
