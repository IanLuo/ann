<!-- specs:locked:be67673 2026-08-16 type=spec -->

## Link contract
- **upstream** (this doc relies on): tree/rounds/01-goal/artifacts/design.md,02-grilling/01-spec-rework/artifacts/requirements-spec.md 05-engine/00/01-flow-control/artifacts/flow-control-spec.md,01-format-amendment-v2/artifacts/tree-format-spec-v2.md
- **referrers** (must cite this when they change): S5 planner kernel,validators implementation slices,review-task

# Requirements-Change Protocol (v2)
*Artifact of task `05-engine/00/03-change-protocol-amendment`. Type: spec. Complete superseding version — v1 (locked @ 90e53ad) + **logical-name resolution** (grilled decision). Produced per the protocol itself: amendment node → complete artifact → superseded event. Upstream: `tree/rounds/01-goal/artifacts/design.md` (v3), `02-grilling/01-spec-rework/artifacts/requirements-spec.md`, `05-engine/00/01-flow-control/artifacts/flow-control-spec.md`, `01-format-amendment-v2/artifacts/tree-format-spec-v2.md` (all locked). Referrers: S5 planner kernel (enforcement), validators, implementation slices, review-task.*

## 1. The rule (hard)

- **A locked artifact is byte-identical forever.** Its content never changes, at the same path, for any reason.
- **Requirements change is the normal case**, not an emergency. It is handled by growth, never by editing.
- **Lock rotation (`--force`) is stamp repair only:** fixing a broken marker, or re-pointing an upstream path when an upstream artifact is superseded. It never changes content. Rotating a lock as a content-editing license is a violation.
- **The engine refuses to write any artifact referenced as locked** — enforcement is a validation error, not a workflow option (a validator rule, not a convention).

## 2. Logical names & resolution (v2 — the reference problem)

- **References are by stable logical name + section anchor, never by path.** Example: `requirements-spec §5` — valid forever, whatever version is current.
- **Artifacts = immutable commits; logical names = branch tips (mutable, derived).** A locked body's references are *historical facts* — we do not keep them fresh; we make them **resolvable**.
- **Resolution is derived from events at read time:** `current(name)` = the latest `artifact-locked`, non-`superseded` artifact carrying that name. No index file, no edits — the same derive-don't-store principle as status.
- **Logical names are first-class:** each artifact carries one (`requirements-spec`, `tree-format-spec`, `flow-control-spec`, `change-protocol`, …), globally unique within the store; **a superseding artifact reuses the name**.
- **Stable section anchors:** a superseding artifact preserves the existing section structure verbatim — new sections append, existing ones never renumber. Otherwise `§N` references break across versions. Validator-enforced.
- **Uniqueness of current:** an artifact may lock only if no other non-superseded artifact shares its logical name (validator error otherwise).
- **Forward pointers:** every `superseded` event names its successor; a reader hitting a direct path reference to a superseded artifact (historical body) gets the forward pointer + a warning, never a dead end.

## 3. The amendment path (the only path for change)

1. **Change arrives** — a gate rejection, a new decision, new information, a defect, a scope shift. It is an *input*: `{artifactRef (logical name), changeRequest, reason, source}`.
2. **Spawn an amendment node** — in the active round, or a sibling of the artifact's producer (sibling-correction, higher prefix). `requiredInputs = [old artifact, changeRequest]`; contract = *produce a complete superseding artifact*.
3. **The amendment runs the normal lifecycle** (flow-control §2): materialize → human gates → execute → verify → commit. Rejection → bounded rework, closed through the same gate.
4. **Output: a complete new artifact at a NEW path**, **reusing the logical name and preserving section anchors** (complete-artifact rule — flow-control §8; anchors — §2 above). Example: `requirements-spec-v2.md`, never an edit to `requirements-spec.md`. Lock it fresh.
5. **Record events (append-only):**
   - `superseded` on the **old artifact's producer node** — note names the successor by logical name + path.
   - `artifact-locked` + `completed` on the **amendment node**.
   - The old artifact stays on disk, byte-identical, readable as history.
6. **Re-point referrers** — the dependent docs' lock contracts list the old path as upstream; updating that pointer is **lock-metadata repair** (stamp-level, content untouched). Body references inside locked docs are *not* touched — they resolve by logical name (§2).

## 4. Why this is the only path

- **Replay integrity:** events reference artifacts by identity; an edited artifact at the same path breaks replay and audit. Supersession keeps every event true at the time it was written.
- **Append-only economics:** the reader pays nothing — the current artifact is the complete truth in one file; the old one is history.
- **References survive change:** because they are logical names + frozen anchors, supersession never cascades staleness through the reference DAG.
- **Dogfooding:** Ann's own contracts change the same way Ann changes any project's contracts. The v1→v2 of this very document is the proof: amendment node → complete artifact → superseded event — no edits.

## 5. Edge cases

- **Change to a locked artifact with many referrers:** one amendment node, complete new artifact, logical name preserved → referrers' internal references stay valid by construction; only lock-metadata upstream pointers update.
- **Change rejected at a gate:** the amendment node reworks (bounded) or is abandoned (`failed` event); the old artifact is untouched either way.
- **Change touching multiple locked artifacts:** one amendment node per artifact (parallel group), each producing its complete successor with its own logical name.
- **Trivial change (one typo):** still the amendment path — completeness and immutability do not scale down.
- **Supersession chain (v1 → v2 → v3):** resolution follows events to the latest; every superseded event carries its successor pointer.
- **Direct path reference to a superseded artifact in a historical body:** resolver warns "superseded → current is X" and follows the forward pointer.
- **Section renumbering attempt in a superseding artifact:** validator rejects.
- **Two current artifacts sharing a logical name:** validator rejects (one current per name).
- **`requiredInputs` in node.json:** reference by logical name; materialize resolves and records "referenced B (superseded), resolved to B2".

## 6. Non-goals

- No in-place patching of locked artifacts, ever.
- No "emergency edit" fast path. The gates exist because change is where mistakes happen.
- No live pointer maintenance — references are resolvable, not kept fresh.
