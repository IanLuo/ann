<!-- synced: d3738e3 -->

# CURSOR — Meta-Assistant (2026-08-16)

**Position:** Contracts + resolver built. Next: activate R5 — spawn S1–S9 (ann-system-design §1: 12 components incl. Flow-config, Envision, Human interface) and build the engine, starting with S1 tree store; the resolver script (scripts/resolve.mjs) is the F-AC13 seed already in use.

**Blockers:** none. (Q1–Q4 resolved: Node.js+TS · adapter-first OpenAI-compatible · file-based, no SQLite v1 · CLI.)

**Open:** multi-user = design constraint (not v1) · big-data query perf N/A v1 · bindings beyond GitHub · UI beyond CLI · joins/DAG · cross-round parallelism · human-gate weakening · storage at scale. (design v3 §10 + requirements-spec §7)

**Health:** 🟢 — no build to break; first engine component (resolver) exists and passes --check.

**Verification:** Stack: design v3 → requirements-spec (89ace76) → tree-format-spec v3 (012ca5f) → flow-control-spec (2522b6c) → change-protocol v2 (be67673) → ann-system-design. `node scripts/resolve.mjs --check` = OK, 5 current artifacts verified. R1–R4 done → R5 queued (tasks: 01 flow-control done, 02 change-protocol done, 03 change-protocol-amendment done, 04 format-amendment-v3 done). Failure signals armed (advance friction; K4).

**Errors-that-changed-plan:** 03440cc PRD extension dropped→reconciled · storage default deviated→flagged · flow-control defaults chat-only→events · R3 status wart→format §3 · accreted spec→clean-room fresh spec · downstream docs consumed wrong foundation→re-derived · **locked docs edited + locks rotated (session violation)→change-protocol created (the fix), violation recorded in events** · format v2→v3 amendment (resolution mechanism).

**Decisions:**
- Product = the tree (living table of rounds); self-similarity invariant; configurable step chain (idea→validate→envision→specs→continue)
- Resolution: durable refs = logical names + frozen anchors; current(name) derived from events, never stored; one current per name; forward pointers; historical records may use paths (format v3 §3–4)
- Change = amendment node → complete superseding artifact → superseded event (change-protocol v2); locked artifacts never edited; --force = stamp repair only
- KPIs K1–K4 (derived-accuracy 100% · locate ≤2 · advance ≤1 · correctness ≥95%); failure signal = advance friction/wrong next-action
- Human gates at each step end; resolution ladder; fail-closed everywhere; 12 invariants (design v3 §4)
- Pre-engine tooling: scripts/resolve.mjs = F-AC13 seed

**Active pointers:** `AGENTS.md`, `tree/README.md`, `tree/rounds/`, `scripts/resolve.mjs`, contracts under `tree/rounds/` (design v3, requirements-spec, tree-format-spec v3, flow-control-spec, change-protocol v2, ann-system-design)
