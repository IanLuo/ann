# Requirements-Change Protocol (v1)

*Artifact of task `05-engine/00/02-change-protocol`. Type: spec. The one true path for changing requirements — or any locked artifact — without violating immutability. Upstream: `tree/rounds/01-goal/artifacts/design.md` (v3), `02-grilling/01-spec-rework/artifacts/requirements-spec.md`, `05-engine/00/01-flow-control/artifacts/flow-control-spec.md`, `01-format-amendment-v2/artifacts/tree-format-spec-v2.md` (all locked). Referrers: S5 planner kernel (enforcement), validators, implementation slices, review-task.*

## 1. The rule (hard)

- **A locked artifact is byte-identical forever.** Its content never changes, at the same path, for any reason.
- **Requirements change is the normal case**, not an emergency. It is handled by growth, never by editing.
- **Lock rotation (`--force`) is stamp repair only:** fixing a broken marker, or re-pointing an upstream path when an upstream artifact is superseded. It never changes content. Rotating a lock as a content-editing license is a violation.
- **The engine refuses to write any artifact referenced as locked** — enforcement is a validation error, not a workflow option (a validator rule, not a convention).

## 2. The amendment path (the only path for change)

1. **Change arrives** — a gate rejection, a new decision, new information, a defect, a scope shift. It is an *input*: `{artifactRef, changeRequest, reason, source}`.
2. **Spawn an amendment node** — in the active round, or a sibling of the artifact's producer (sibling-correction, higher prefix). `requiredInputs = [old artifact, changeRequest]`; contract = *produce a complete superseding artifact*.
3. **The amendment runs the normal lifecycle** (flow-control §2): materialize → human gates (the change is grilled at entry, confirmed at exit) → execute → verify → commit. Rejection → bounded rework, closed through the same gate.
4. **Output: a complete new artifact at a NEW path** (complete-artifact rule — flow-control §8). Example: `requirements-spec-v2.md`, never an edit to `requirements-spec.md`. Lock it fresh.
5. **Record events (append-only):**
   - `superseded` on the **old artifact's producer node** — note names the new artifact path.
   - `artifact-locked` + `completed` on the **amendment node**.
   - The old artifact stays on disk, byte-identical, readable as history.
6. **Re-point referrers** — the dependent docs' lock contracts list the old path as upstream; updating that pointer is **lock-metadata repair** (stamp-level, content untouched). Cards and pointers update via events, never by editing the old artifact.

## 3. Why this is the only path

- **Replay integrity:** events reference artifacts by path; an edited artifact at the same path breaks replay and audit. Supersession keeps every event true at the time it was written.
- **Append-only economics:** the reader pays nothing — the current artifact is the complete truth in one file; the old one is history.
- **Dogfooding:** Ann's own contracts change the same way Ann changes any project's contracts. This session's violation (locked docs edited + locks rotated @ 257cb79) is the recorded counter-example; the current content stands as truth, the process is on record, and this protocol is the way forward.

## 4. Edge cases

- **Change to a locked artifact with many referrers:** same path — one amendment node, complete new artifact, then metadata re-pointing for each dependent lock.
- **Change that is rejected at a gate:** the amendment node reworks (bounded) or is abandoned (failed event); the old artifact is untouched either way.
- **Change that touches multiple locked artifacts:** one amendment node per artifact (parallel group), each producing its complete successor; or one round of amendments.
- **Trivial change (one typo):** still the amendment path — completeness and immutability do not scale down.

## 5. Non-goals

- No in-place patching of locked artifacts, ever.
- No "emergency edit" fast path. The gates exist because change is where mistakes happen.
