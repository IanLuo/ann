# Tree Format Depth Policy (v1)

*Node `01-goal/02-tree-format/01-depth-policy`. Amends `tree-format-spec.md` (locked @ ba528d1) per its §10 evolution rule: this artifact supersedes the base spec where noted; the base stays authoritative elsewhere. Type: spec (amendment). Upstream: tree-format-spec.md.*

## Problem

Directory-as-tree means id = path. Two forces grow depth without bound in a long-lived project:

1. The immutability rule (corrections = new nodes) chains repairs/amendments as **nested children** of the failed/superseded node.
2. Every level adds a prefix + name to every descendant's path.

Result: deep, unreadable paths; portability limits (Windows 260-char path default); ids that stop being usable addresses.

## Policy

1. **Depth expectation.** Trees stay shallow. Typical 3–6 levels; engineering budget **≤ 8 levels and ≤ 260 chars full path** (Windows-compatible). A branch approaching the budget is a signal to rebalance — never the norm.
2. **Sibling-correction (the main control).** Repairs, retries, and amendments are created as **siblings at the same level** as what they correct — with a higher sort prefix — **never nested children**. A failed node keeps its status and any existing subtree (archived by the `failed` event); the retry re-decomposes fresh at the same level. Failure and recovery never add depth.
3. **Pruning.** Completed or superseded subtrees may be removed from the working tree (`rm -r`); **git is the archive and the source of truth for history**. The active tree = live frontier + recent/adjacent nodes. Long-lived projects stay shallow by pruning, not by never growing.
4. **Name discipline.** Path segments ≤ 24 chars, kebab-case, no dates/versions inside segment names (versions = sibling prefix order).
5. **Pure decomposition still nests.** A node whose contract genuinely decomposes into sub-steps nests — that is honest depth, bounded by the work itself, never by failure.

## Engine ACs (supersedes/augments tree-format-spec §7)

- F-AC9 — the engine supports creating a node as a **sibling of a failed/superseded node** at the same level (retry semantics). Frontmost-ready skips failed/superseded siblings regardless of prefix.
- F-AC10 — the engine supports **pruning** a completed/superseded subtree from the working tree; the tree remains valid after pruning. A node whose artifacts any live node's `requiredInputs` references must not be pruned (validation refuses).

## Edge cases

- Retry ordering: `01-attempt` (failed) + `02-retry` (active) → frontmost-ready = `02-retry` (`01` is failed, skipped despite lower prefix). Correct.
- Prune attempt on a node referenced by a live node's `requiredInputs` → validation refuses, with the referencing node named. The contract nodes (goal, spec, format) are typically never pruned while work references them.
- A pruned subtree can always be re-hydrated from git (old commit checkout); pruning is not deletion.
