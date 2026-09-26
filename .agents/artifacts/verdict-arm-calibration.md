# The verdict's middle row — calibration, and a draft rule change

Status: **draft, not a decision.** Written 2026-09-26 from two real-model runs. Nothing here is
implemented; task 22 is delivered as contracted and this is input to a follow-up.

## What was measured

The review worker (12/22) was driven against the configured provider (`deepseek-chat`) on a
clone of the journey. Both deliveries were ones the floor had already certified closeable —
every AC claimed, every claim's check captured and passing.

| run | task | material | findings | verdict |
|---|---|---|---|---|
| 1 | 12/11 decision-record | diff cut, 30,370 chars dropped | 7 `matches` + 1 `uncertain` | `human` |
| 2 | 12/13 transfer-affordance | diff **complete** | 5 `matches` + 1 `quality` + 2 `uncertain` | `human` |

**Zero accepts.** So `auto accept` — D-1, the operator's premise that the human leaves the exit
gate — is currently **inert**. Safe (nothing wrong is waved through, no rejection is burned) but
without the burden reduction it was chosen for.

## Where the accept arm actually dies

Not where we assumed. Run 2 had a *complete* diff and still declined. The finding that decided
it is F6, in the reviewer's own words:

> "The route's refusal is the real guard, which is what AC-3 requires, so this is a **quality
> note on the comment, not a gap**."

The reviewer called it not-a-defect and it still parked the gate, because `deriveGateVerdict`
sends `quality` down the same arm as `uncertain`.

## Three candidate diagnoses — not yet distinguished

I cannot settle which of these is true from two runs. Each implies a different fix.

**(a) The rule widened the AC.** AC-2's literal wording names only `uncertain` for the human
row: *"open uncertain with no defect → the HUMAN"*. The implementation added `quality` to that
arm by interpretation (`gate-review.ts`, the comment on `quality`). If (a), the fix is to
**remove an over-interpretation**, which is the cheapest possible change.

**(b) The rule's comment contradicts the vocabulary.** The rule says `quality` means "real, not a
defect". `review-session.ts` defines it as *"it works, but the delivered bytes are defective in a
way that will cost someone later"* — a **real defect**, merely not a contract violation. If (b),
the arm assignment is not obviously wrong and the fix belongs in the **prompt** (tighten what
`quality` is for) rather than in the rule.

**(c) The label was simply wrong.** F6's real content is "I cannot determine whether the
comment's claim is enforced elsewhere" — that is an `uncertain`, not a `quality`. If (c), the
rule is correct and the reviewer mislabelled.

**The decisive experiment** (cheap — one call): a delivery whose only open findings are
`uncertain`, with no `quality`, to see whether accept fires at all. If it never does, the
problem is broader than the middle row and (a)–(c) are all secondary.

## Draft rule change — the (a) variant

```diff
  const open = findings.filter((f) => f.status === 'open' && f.severity !== 'matches');
  if (open.some((f) => f.severity === 'gap' || f.severity === 'regression')) return 'rework';
- if (open.length) return 'human';
+ if (open.some((f) => f.severity === 'uncertain')) return 'human';
+ // `quality` rides the record without blocking: see the fork above — this line is (a), not (b).
  return 'accept';
```

Test that must move with it: `src/flow/__tests__/gate-review.test.ts` currently pins
`expect(v([SEV('quality')])).toBe('human')`. Under (a) it becomes `'accept'`.

### What must not be lost in the change

- **F7 is a real finding.** It named an untested path (`transferNotLive` returning `undefined`
  on a failed read, and whether `gate!` refuses it by name first). Whatever separates advice from
  uncertainty must keep those two distinguishable. The bug is that they are *indistinguishable*,
  not that either is wrong.
- **A `quality` finding must still be readable after an accept.** It lands on the record before
  the rule runs, so it survives — but the accept's `why` should name each one, and the card must
  surface them, or an accept will silently absorb a note nobody reads.
- **The audit trail is the safety net.** An accept carries `decider: worker` and `run`, so the
  machine-accepted share is countable after the fact. Read the first several by hand.

## Explicitly NOT part of this change

Two other causes of the 0-for-2 are recorded separately and are the real work:

- **The material is a diff** — unchanged context is absent by construction, so a criterion that
  depends on how the change meets existing code is permanently `uncertain` (F7 is exactly this;
  no diff budget, however large, fixes it).
- **Some criteria want evidence no text carries** — F8 asked for a real-browser check because
  "the tests are jsdom-style". Intrinsic limit of a text reviewer.

See the idea *"THE REVIEW MATERIAL CUTS BY PATH ORDER, NOT RELEVANCE"*.
