<!-- synced: f7829de -->

# CURSOR — Meta-Assistant (2026-08-16)

**Position:** ALL contracts locked — the pre-build stack is closed. Next: run 08-system-design-validation (conformance of components against the function surface), then spawn S1–S9 and build the engine (S1 tree store first).

**Blockers:** none.

**Open:** multi-user = design constraint (not v1) · big-data query N/A v1 · web UI (target, v2 — CLI v1) · bindings beyond GitHub · joins/DAG · cross-round parallelism · human-gate weakening · storage at scale. (design §10 + requirements §7)

**Health:** 🟢 — no build to break; resolver live (8 current artifacts verified).

**Verification:** Contract stack (8 locked): design v3 → requirements-spec v3 → tree-format-spec v3 → flow-control-spec → change-protocol v2 → ann-system-design → functional-spec (9e60cd8) → architecture (fcfa661). `node scripts/resolve.mjs --check` = OK (8 current, verified). R1–R4 done → R5 queued (tasks 01–07 done; 08 queued; S1–S9 not spawned).

**Errors-that-changed-plan:** 03440cc PRD extension→reconciled · storage default deviated→flagged · flow-control defaults chat-only→events · R3 status wart→format §3 · accreted spec→clean-room fresh spec · downstream docs consumed wrong foundation→re-derived · **locked docs edited + locks rotated (violation)→change-protocol created, recorded** · format v2→v3 · requirements v2→v3 (audit gaps) · functional surface shaped (validate=idea gate, specify task, change folded) · architecture reviewed in HTML (web-UI target, per-task models, two-log trace, single-writer appendEvent).

**Decisions:**
- Product = the tree (living table of rounds); self-similarity invariant; configurable step chain (idea→validate→envision→spec→continue)
- Resolution: durable refs = logical names + frozen anchors; current(name) derived from events; one current per name; forward pointers (format v3 §3–4)
- Change = amendment node → complete superseding artifact → superseded event (change-protocol v2); locked artifacts never edited
- Function surface F1–F17 locked (functional-spec): validate = idea gate; run next (pull) / specify task (push); card = gate①; change folded into specify task
- Architecture locked: Node/TS; file-tree truth (no SQLite v1); single-writer appendEvent + shared readers; one-way layers; web UI = target (CLI v1); per-task model selection; two logs (project events in tree + runtime op log)
- KPIs K1–K5; human gates at each step end; resolution ladder; fail-closed everywhere; 12 invariants (design v3 §4)

**Active pointers:** `AGENTS.md`, `tree/README.md`, `tree/rounds/`, `scripts/resolve.mjs`, 8 locked contracts under `tree/rounds/` (resolve via `--specs`)
