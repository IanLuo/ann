# The verdict's middle row — what actually blocks an auto accept

Status: **draft, not a decision.** Written 2026-09-26 from two real-model runs, then **corrected
in the same session** — an earlier version of this file blamed the `quality` arm. That was wrong;
see "The correction" below. Nothing here is implemented. Task 22 is delivered as contracted.

## What was measured

The review worker (12/22) was driven against the configured provider (`deepseek-chat`) on a
clone of the journey. Both deliveries were ones the floor had already certified closeable —
every AC claimed, every claim's check captured and passing.

| run | task | material | findings | verdict |
|---|---|---|---|---|
| 1 | 12/11 decision-record | diff cut, 30,370 chars dropped | 7 `matches` + 1 `uncertain` | `human` |
| 2 | 12/13 transfer-affordance | diff **complete** | 5 `matches` + 1 `quality` + 2 `uncertain` | `human` |

**Zero accepts.** So `auto accept` — D-1, the operator's premise that the human leaves the exit
gate — is currently **inert**: safe (nothing wrong is waved through, no rejection is burned) but
delivering none of the burden reduction it was chosen for. The auto review alone makes every gate
*more* to read, not less.

## The correction

An earlier version of this file said the `quality` arm decides the question, citing F6 ("a
quality note on the comment, **not a gap**") as the finding that parked run 2. **That is false,
and the recorded findings disprove it.** Applying the proposed variant to the actual numbers:

```
run 1 · 12/11    current rule → human  · variant (a) → human
run 2 · 12/13    current rule → human  · variant (a) → human
```

Variant (a) changes **nothing**. Both runs are blocked by `uncertain`, not by `quality`. F6 was
listed in the same output line as F7/F8 and I singled it out on the strength of its own prose
instead of computing what the rule does with the set.

## The actual cause: `uncertain`, and it is structural

The accept arm requires a *flawless* review — every finding `matches` or resolved, nothing else
raised. Both runs failed that on `uncertain`, for two reasons that no rule change can reach:

- **The material is a diff.** Only changed lines are carried, so a criterion that depends on how
  the change meets *unchanged* code cannot be verified at any budget. This is run 2's F7:
  `transferNotLive` returning `undefined` on a failed read, and whether `gate!` refuses it by
  name first — the answer lives in code the diff never shows.
- **Some criteria want evidence no text carries.** Run 2's F8 asked for a real-browser check
  because "the tests are jsdom-style". Intrinsic to a text reviewer.

Run 1's `uncertain` is the same class, via the path-ordered cut (30,370 chars dropped, taking
`src/surface/` with it).

**So the rule is not miscalibrated — it is refusing to auto-accept a criterion it could not
verify, which is exactly its job.** F7 is a real finding. Tuning the middle row to reach an
accept here would be tuning it to swallow a real one.

## The `quality` row is a latent issue, not this one

Worth fixing on its own merits, and it does **not** explain the 0-for-2:

- AC-2's literal wording names only `uncertain` for the human row — *"open uncertain with no
  defect → the HUMAN"*. The implementation added `quality` to that arm by interpretation.
- The rule's comment calls `quality` "real, not a defect"; the vocabulary in `review-session.ts`
  defines it as *"it works, but the delivered bytes are defective in a way that will cost someone
  later"* — a **real defect**, merely not a contract violation. The comment contradicts the
  vocabulary, and on the vocabulary's reading the current arm is defensible.

Do not change this row to chase an accept. If it changes, it should be because the AC's own
wording is being honoured — not because it unblocks a measurement.

## What follows

1. **The auto review stands.** Two runs, both produced substantive, correctly-localized findings
   with real `file:line` citations. It is a genuine improvement and it is already live.
2. **Auto accept cannot be made to work by tuning the rule.** It needs material that can support
   certainty — changed lines *plus the unchanged context the criteria name*, and an honest
   statement of what no material can settle.
3. **A cheaper intermediate worth considering:** let the accept arm fire when the only open
   findings are `uncertain` **whose own text names what it needed** — i.e. hand those to the
   human as *material requests* rather than as gate blockers, so a submission can still close
   while the request is recorded. This is a shape change, not a threshold change, and it keeps
   F7-class findings visible. Not drafted here; it needs its own grill.

See also the ideas *"THE REVIEW MATERIAL CUTS BY PATH ORDER, NOT RELEVANCE"* and *"AUTO ACCEPT IS
INERT — MEASURED 0 FOR 2"*.
