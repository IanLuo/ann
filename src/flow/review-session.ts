import { execFileSync } from 'node:child_process';
import { GrillProfile, GrillSession } from './grill-session.js';
import { GroundingInput, SourceType } from './steps/shared.js';
import { Abilities } from './types.js';
import { Commands, type CommandError, type ReviewFindingsView } from '../commands/index.js';
import type { ReviewFindingInput, ReviewFindingView } from '../store/store.js';

/**
 * L2 · THE REVIEW AREA of the grilling engine — the session a human runs AT A GATE, whose
 * output is a RECORD rather than a conversation.
 *
 * The problem this exists for is measured, not imagined. `12-operate-loop/08` was rejected
 * with a 3241-char prose DIGEST stored as gate `feedback`; its per-finding list (F1–F11 ·
 * G1–G6) was unreachable through the journey — `ann --json confirm` could not produce it —
 * and survived only in a reviewer's session transcript. So the rework's claim that
 * "everything found was fixed" had nothing to be checked against, and it was FALSE: of the
 * eleven findings routed to one cleanup pass, one was fixed, two were no-action-by-design,
 * and EIGHT were still open. A digest is not a record. A record is per-finding, localized,
 * and re-checkable.
 *
 * THE SESSION is the portable one — the same loop as the goal, specs and design grills
 * (`src/flow/grill-session.ts`: bounded rounds, anti-runaway ceiling, dedupe/never-re-ask,
 * the synthesis turn, `InteractAbort`, provider fail-closed). REVIEW is the FOURTH
 * `GrillProfile` (goal · specs · design · this). It is NOT `reviewRunner`
 * (`src/flow/runner-review.ts`), which is a deterministic "could the runner execute without
 * guessing?" simulation at the same gate — a different question, asked without a model.
 *
 * WHAT MAKES IT A REVIEW, and what it must never become:
 *   - it reviews a DELIVERY — this task's bytes against this task's contract — and never
 *     re-plans the task, re-grills the contract, or decides the gate;
 *   - every finding is LOCALIZED (`file:line`) or explicitly `uncertain`; an unlocalized
 *     assertion is the digest this replaces;
 *   - it LANDS as it asserts (one landing per round), so a session that dies mid-way loses
 *     nothing — AC-4's independence: the session writes NO gate event, so reviewing a task
 *     can never accept, reject or close it.
 *
 * The findings themselves ride the ONE optional area hook on the core
 * ({@link GrillProfile.findings} + {@link GrillOptions.onFindings}): the core parses the
 * strict-JSON turn, hands the RAW items over, and knows nothing about severities, pointers
 * or provenance. The area maps and stamps; the store's single writer validates.
 */

/** THE REVIEW grilling directive — what the shared grilling engine must do to review a
 *  DELIVERY, and the boundary that keeps it off the plan and off the gate. */
export const REVIEW_GRILL_MODE = `You are REVIEWING A DELIVERY: a task was implemented, and its own record says so. Your job is to establish, from the material provided, what is actually TRUE of the delivered bytes — not to re-plan the task, not to re-argue its contract, and not to decide whether the gate should be accepted.

The 'idea' is the CURRENT READING of the delivery under review. Sharpen it as the review proceeds; build on every answer already given.

## The boundary you review within (hard)
- The CONTRACT is fixed: its intent and its acceptance criteria are given. You do not rewrite them, question their wisdom, or propose new ones. A criterion you believe is wrong is at most a finding about the delivery, never a licence to re-scope.
- The PLAN is done. Implementation choices already made are reviewed FOR THE CONTRACT'S SAKE — "does this satisfy AC-3, and does it hold?" — never reopened as design preferences. A finding is a defect against the contract or the material, not a taste.
- The GATE IS NOT YOURS. Whether to accept, reject or rework is the human's decision, made after your record exists. Never recommend a verdict, never phrase a finding as "reject this".

## What you are reviewing, and where to look
Read the material provided and review it in this order — it is the order the evidence is strong in:
1. THE DIFF over the stated range — the bytes under review. This is the primary object: what changed, and what it actually does.
2. THE CONTRACT (intent + the numbered acceptance criteria) — the standard each change is held to. Walk EVERY criterion: for each, what in the diff makes it true?
3. THE CAPTURED CHECKS — a 'captured' check is a FACT (the engine ran it and read the real exit code); a 'reported' check is a CLAIM (someone typed it). Treat them differently, and say which you relied on.
4. THE RESOLVED INPUTS — the defining documents, at their recorded sha. A change that contradicts one is a finding.
5. ANY PRIOR FINDINGS — a review is often a RE-review. For each prior finding, say what the current bytes do about it.
Locate EVERY finding you raise: a file and a line in the reviewed bytes. Cite the range's anchor sha when the line number depends on it.

## Your 'summary' must be
ONE line stating the delivery as it now reads against its contract — the verdict-free reading, e.g. "AC-1 and AC-4 are met by the noted hunks; AC-2's writer half is present but the read half is unverified; two localization gaps remain." Name what is established and what is not. No verdict, no recommendation, no second paragraph.

## Hard rules
- NEVER invent a line number, a sha, a file, or a check result. If the material does not show it, you do not know it — and saying so is a finding, not a failure.
- NEVER re-ask what the material or an earlier answer already settles. Ask ONLY about what you genuinely cannot determine from what you were given, and say what you would need.
- A concern you cannot localize is REAL and must be raised — as severity 'uncertain', with whatever pointer you do have. Never drop it, and never dress it as a located one.`;

/** THE REVIEW reasoning directive — shared by the synthesis turn, the discussion turns and
 *  the research follow-up turn. */
export const REVIEW_DISCUSS_MODE = `You are reasoning about a DELIVERY under review: what the delivered bytes actually establish against the contract, and what remains unestablished. Ground every statement in the provided material labels — the diff, the criteria, the checks, the inputs, the prior findings — and never invent a fact, a line, or a result.

- CONCLUSION-FIRST and SHORT: lead with what is established or what you cannot establish, then the tightest support. Cap the reply at a few short lines.
- Keep the standard fixed: the CONTRACT is the standard. Never drift into re-planning the task, questioning the criteria, or proposing a gate verdict — the human decides, after your record exists.
- Weigh the EVIDENCE and its SOURCE: a captured check is a fact; a reported one is a claim; a hunk you can read is stronger than an assertion about it.
- Whether a criterion is MET is a claim to be shown from the bytes, never conceded because the record says so — the record is exactly what is under review.
- Name the concrete gap: which criterion, which file, which line, what the material fails to show. Never a generic 'needs more verification'.`;

/** THE FINDINGS turn — the strict-JSON instruction the core appends to its own prompt, and
 *  the ONLY profile hook that adds a turn. The shape here is the shape the store validates;
 *  a finding that violates it is refused BY NAME at the writer rather than stored as prose. */
export const REVIEW_FINDINGS_MODE = `Produce the CURRENT FINDINGS of this review — the complete list as it stands at the end of this round, re-stating the findings that still hold, not only the new ones. This list is LANDED: it is the record a rework is checked against, so it must be checkable, not persuasive.

Each finding is an object with EXACTLY these five fields:
- "id": a short stable handle — 'F1', 'F2', … in order. A finding that a PRIOR list already recorded KEEPS ITS PRIOR ID; that is what lets a rework flip it.
- "severity": one of exactly
    "matches"    — the criterion IS met and the bytes show it (state it: that is how a reviewer's silence becomes wrong)
    "gap"        — a contract requirement is not met, or a part of it is absent
    "regression" — something that worked is now broken by these bytes
    "quality"    — it works, but the delivered bytes are defective in a way that will cost someone later
    "uncertain"  — a real concern you CANNOT localize to a file and line. Use this rather than inventing a pointer.
- "where": the location in the reviewed bytes as 'path:line' (e.g. 'src/store/store.ts:1819'). For "uncertain", give the coarsest true pointer you have ('src/store/store.ts' or 'the diff, hunk 3'). NEVER a guess and NEVER blank.
- "text": what was found, in one or two sentences a person can act on WITHOUT reading this conversation. Name the criterion it bears on. Not a restatement of the location.
- "status": "open" or "resolved". "open" for anything you are raising now. "resolved" ONLY for a prior finding the current bytes demonstrably settle — and when you mark one resolved, say in its "text" what evidence settles it.

Rules:
- Report what the material SHOWS. A finding you cannot support from the provided material is not a finding — say in an "uncertain" entry what you would need instead.
- Do NOT include a verdict, a recommendation, or whether the gate should be accepted: the human decides, after this record exists.
- Do NOT editorialize about the process ("more testing recommended"). Every entry is either a located defect or an explicit 'uncertain'.
- An honest short list beats a padded one. If the material shows the delivery meets its criteria, say so with "matches" entries naming what carries each one.`;

/** THE REVIEW AREA — the boundary a review may work within, and what is explicitly out.
 *  Everything the loop needs that is NOT area-specific lives in the core; this profile
 *  supplies only what a review varies, plus the findings hook that makes it a RECORD. */
export const REVIEW_PROFILE: GrillProfile = {
  id: 'review',
  title: 'Review session',
  noun: 'review',
  seedVerb: 'ann review!',
  goAction: 'Land the findings',
  focus:
    "Review a task's DELIVERY against its own contract and the bytes it cites — every finding localized to a file:line, or explicitly 'uncertain'; never a re-plan of the task, never a re-grill of the contract, never a gate decision.",
  grilling: REVIEW_GRILL_MODE,
  reasoning: REVIEW_DISCUSS_MODE,
  decisionWeighIn: {
    exhausted:
      "The round is EXHAUSTED — reviewing raised no new questions, so digging further is not an option: recommend GO if the findings list is a faithful, localized record of what the material shows, otherwise refine. GO here means THE FINDINGS ARE COMPLETE — it records them and decides nothing; the gate is the human's own, later gesture. Never weigh the delivery's quality as a reason to withhold GO: a review that found serious defects and recorded them faithfully is a COMPLETE review.",
    open: "GO only if the findings list is a faithful, localized record of what the material shows — every criterion walked, every finding pointed at a file and line or honestly marked 'uncertain'. Dig more if a criterion is still unexamined or a concern is still unlocalized; refine if the reading of the delivery itself is wrong. GO means THE FINDINGS ARE COMPLETE and records them; it is NEVER a verdict on the delivery and NEVER a gate decision — a review that records eleven open findings is a complete review, and withholding GO over the defects would hide them.",
  },
  refineAsk:
    'What should the review look at differently? Reshape its reading of the delivery in your own words — the next round reviews what you say here.',
  findings: { instruction: REVIEW_FINDINGS_MODE },
  defaultMaxRounds: 12,
  defaultMaxDiscussTurns: 6,
};

/** Who asserted a finding. Stamped by the AREA, never taken from the model: a model must not
 *  be able to claim a human authored a finding, and an author-less finding is
 *  indistinguishable from one a human raised (the reason `provenance` is required at all). */
export const REVIEW_PROVENANCE = 'review session (model)';

/**
 * The review's OUTPUT budget — the core already accepts one per session
 * (`GrillSession`'s `{ model, maxTokens }`), and this area needs a bigger one than the
 * shared default for a reason that is structural, not tuning: a review's material is the
 * largest of any area BY CONSTRUCTION, because it carries the submission's diff.
 *
 * MEASURED, not guessed (the AC-5b oracle, 2026-09-22): on the first real run over
 * 12/08's own range, the shared 2048-token default cut the grill turn's strict JSON at
 * 8137 chars — mid-string — so the round failed closed at `bad-response` and the review
 * recorded nothing. A budget within which the material can actually be read is part of
 * this area's honesty; failing closed is the RIGHT behaviour when the budget is exceeded,
 * and no budget is right for every material, so the number is stated here rather than
 * left implicit in a default that was never chosen for a diff-carrying prompt.
 */
export const REVIEW_MAX_TOKENS = 4096;

/** How much of the reviewed patch the session may read. A review that cannot see the bytes
 *  cannot produce a `file:line` — the diff IS an input — but an unbounded one buries the
 *  contract under it. The cap follows `brief`'s idiom: cut, and WRITE THE CUT LENGTH INLINE,
 *  so a partial view can never be mistaken for the whole submission.
 *
 *  MEASURED (AC-5b oracle, 2026-09-22). A real delivery's patch is not small: 12/08's own
 *  range is 1,281 insertions / 272 deletions across 26 files — a patch of **137,547 chars**.
 *  The first budget tried here was 12,000, which carried 8.7% of it: the oracle then came
 *  back `uncertain` on EVERY criterion, because the patch was cut before the first source
 *  body, and it reproduced none of the three code-visible findings AC-5 names as its stated
 *  minimum. The number below carries a delivery of that size, which is what "the inputs are
 *  sufficient" has to mean in practice; the oracle at this budget verified seven criteria
 *  from the bytes (see the node's record). A LARGER delivery is still cut — and that is why
 *  the cut length is written inline and why the change map above the patch is complete, so a
 *  file whose hunks were cut is always NAMED rather than invisible. */
const DIFF_CHARS = 60000;

/** The change MAP gets its own (smaller) budget: `--stat` is one line per file, so this is
 *  room for hundreds of them — and it is what makes the cap on the patch above survivable,
 *  because a file whose patch was cut is still NAMED. */
const STAT_CHARS = 4000;

/** The one path the patch leaves out, and why. `.ann/journey` is the RECORD of the work —
 *  the node's own `events.jsonl` churn — not the delivered artifact, and it is already carried
 *  above as structure (the commits and their notes · the checks · the prior findings). It is
 *  excluded because of a MEASURED failure, not tidiness: path order puts `.ann/` first, so on
 *  a real task the log's hunks consumed the entire patch budget (the AC-5b oracle, 2026-09-22,
 *  over 12/08's own range) and the reviewed CODE never reached the session — every finding came
 *  back `uncertain` for want of bytes that were sitting in git. The log still appears in the
 *  change MAP, so its exclusion is disclosed rather than hidden, and only the log is excluded:
 *  `.ann/rules` and the rest of the tree stay, because a delivery may legitimately land there.
 *  The pathspec is `:(top,exclude)` — REPO-ROOT-anchored, not cwd-relative — so the exclusion
 *  names the same path whatever directory the store resolves from, and (a pathspec of pure
 *  exclusions) it also keeps the diff REPO-WIDE rather than scoped to that directory. */
/** THE CRITERION-LEVEL EVIDENCE GETS ITS OWN BUDGET (leg 12/23). A claim maps a criterion to a
 *  RUN, and a run is a suite-level pass — so on the measured task FOUR distinct criteria all
 *  mapped to one `npm test` pass, and the material carried no test content at all (`grep -c
 *  'test('` over the assembled prompt returned 0). The reviewer could therefore see THAT a
 *  suite was green and never whether its assertions covered the criterion, which is why every
 *  `uncertain` it raised was a request for exactly this: "I would need an e2e case for an
 *  unknown id". It has no way to fetch one, so the evidence arrives with the material or not at
 *  all. */
const TEST_CHARS = 40000;

const DIFF_EXCLUDES = ['.ann/journey'];

const SHA = /^[0-9a-f]{7,40}$/;

/** One git read, fail-closed to undefined (never a throw, never a fabricated result) — the
 *  `capture.ts` helper's shape, and like it an argv array with no shell. */
const git = (cwd: string, args: string[]): string | undefined => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
};

const cut = (s: string, n: number): string =>
  n > 0 && s.length > n ? `${s.slice(0, n)}… (+${(s.length - n).toLocaleString()} chars cut — the full range is in git)` : s;

const bullets = (xs: readonly string[]): string => xs.map((x) => `- ${x}`).join('\n');

/** THE MATERIAL a review is run over (AC-5): the contract and its criteria, the submission's
 *  commits AND the range they were made over, the captured checks at their sha, the resolved
 *  defining docs, and any PRIOR findings — every one of them derived from the log, none of
 *  them typed. */
export interface ReviewMaterial {
  /** The delivery as it reads — the seed the grill sharpens into its summary. */
  subject: string;
  context: GroundingInput[];
  /** The numbered criteria — the standard, in the session's own constraints channel. */
  constraints: string[];
  /** The sha the citations are ANCHORED to (the reviewed head), or '' when the log records
   *  no commit to anchor to. */
  anchor: string;
  /** `<base>..<head>` — the range the reviewed bytes were made over, or '' when it could not
   *  be derived. The log records the commits but NEVER the base they were made over, so this
   *  is derived, and the derivation is stated in the material rather than assumed. */
  range: string;
}

/**
 * Assemble the material for node `id` — pure, never writes.
 *
 * ONE ASSEMBLY (leg 12/22 AC-6). Everything the RECORD can say — the contract and its
 * criteria, the submission's commits and the note each was recorded under, the checks, the
 * resolved inputs at their sha, any prior findings — comes from `commands.brief(id)`, which
 * is the same read the card and the human take. Before this, a review assembled its own from
 * `assemblePacket` plus four scans of the log, so the worker and the card could disagree
 * about one task's facts. Only the RANGE and the PATCH are derived here, and legitimately
 * so: they are GIT's facts, and `brief` runs no subprocess by design.
 *
 * `brief` is read `full`: a card cuts a criterion for display, but a reviewer is held to
 * every word of it, and a criterion cut at 300 chars is not the criterion.
 */
export function buildReviewMaterial(commands: Commands, id: string): ReviewMaterial {
  const store = commands.store;
  const b = commands.brief(id, { full: true });
  const intent = b.intent.trim();
  const acs = b.acceptanceCriteria.filter((a) => !!a.trim());

  // THE SUBMISSION. `cited` is the UNION in first-cited order (brief's `conclusion.cited`)
  // and it is what the RANGE is derived from; the latest citation set tells us whether a
  // re-recorded conclusion superseded part of it. The head is the last cited commit — the
  // newest bytes under review.
  const cited = b.conclusion.cited;
  const current = store.currentCitedCommits(id);
  const head = cited.length ? cited[cited.length - 1] : '';

  // THE RANGE — derived, and named as derived. The base is the parent of the FIRST cited
  // commit: the commit that INTRODUCED the work under review is part of the work, so
  // `previousHead..head` would omit it. Measured on 12/08's own review, which read
  // `a59bf00..b54b67a` while the naive rule yields `1dc9b92..b54b67a` — one commit short,
  // and exactly the commit that introduced the changes being reviewed. When the parent
  // cannot be resolved (the cited shas are not in this repo) the range is EMPTY and said to
  // be underivable — never a fabricated expression.
  const base = cited.length && SHA.test(cited[0]) ? git(store.root, ['rev-parse', `${cited[0]}^`]) : undefined;
  const range = base && head ? `${base}..${head}` : '';

  const context: GroundingInput[] = [];
  const add = (label: string, text: string, sourceType: SourceType): void => {
    if (text.trim()) context.push({ label, text, sourceType });
  };

  // 1 · THE SUBMISSION'S COMMITS, with the note each was recorded under.
  add(
    'submission.commits',
    bullets(b.commits.map((c) => (c.note ? `${c.sha} — ${c.note}` : c.sha))),
    'repo metadata',
  );

  // 2 · THE RANGE, and the fact that the citations hang off it.
  add(
    'submission.range',
    range
      ? [
          `The reviewed bytes are ${range} (${cited.length} cited commit${cited.length === 1 ? '' : 's'}). The log records only the commits, so the base is DERIVED as the parent of the first cited commit.`,
          `Every line number you cite is anchored to ${head} — a later re-read at a different sha may MOVE it, so say which sha a pointer belongs to.`,
          current.length && current[current.length - 1] !== head
            ? `NOTE: the latest recorded citation set is ${current.join(', ')} — a re-record may have superseded part of the range above.`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : 'The range could not be derived from the log (no cited commit resolves in this repo) — review only what the other inputs establish, and raise the missing bytes as a finding.',
    'repo metadata',
  );

  // 3 · THE DIFF — the bytes under review, the primary object. The MAP first (complete, one
  //     line per file), then the patch (bounded, and never able to hide a file's existence).
  if (range) {
    const stat = git(store.root, ['diff', '--no-color', '--stat', range]);
    if (stat) add('submission.changedFiles', cut(stat, STAT_CHARS), 'repo metadata');
    const patch = git(store.root, ['diff', '--no-color', '--unified=3', range, '--', ...DIFF_EXCLUDES.map((p) => `:(top,exclude)${p}`)]);
    add(
      'submission.diff',
      patch === undefined
        ? `git could not produce a diff for ${range} — review only what the other inputs establish, and raise the unread bytes as a finding.`
        : patch === ''
          ? `The diff over ${range} is EMPTY — the cited commits changed nothing against their base.`
          : `${cut(patch, DIFF_CHARS)}\n(The change map above is complete; this patch omits ${DIFF_EXCLUDES.join(', ')} — the record's own churn, not the artifact — and is otherwise cut only as its length states.)`,
      'repo metadata',
    );
  }

  // 4 · THE CLAIMS, EACH BESIDE THE RUN THE RECORD RESOLVES FOR IT (leg 12/23 AC-1). This is
  //     the gap that made the accept arm inert, and it was a PURE OMISSION: `brief` already
  //     exposed `conclusion.claims` — the author's mapping, with the engine's resolution of it
  //     — and the material carried only the `checks` list below. So a reviewer read an
  //     UNORDERED list of runs and could not tell which one the author stood behind for which
  //     criterion: four criteria mapped to one `npm test` pass were indistinguishable from four
  //     separately-verified criteria. The mapping is the AUTHOR's; the resolution (result,
  //     source, sha, detail) is the RECORD's, and the two are labelled as such so a reviewer
  //     knows which half is a claim.
  const claims = b.conclusion.claims;
  const unclaimed = b.conclusion.unclaimed;
  if (claims.length || unclaimed.length) {
    const boundCheck = (c: (typeof claims)[number]): string => {
      if (!c.check) return 'NO CHECK MAPPED — claimed with no recorded run behind it';
      if (!c.bound) return `${c.check} — UNBOUND: the record names this run but the log holds NO run of it`;
      const k = c.bound;
      return `${k.command} — ${k.result} (${k.source === 'captured' ? 'CAPTURED FACT (the engine ran it)' : 'REPORTED CLAIM (someone typed it)'}${k.sha ? ` at ${k.sha}` : ', no sha recorded'})${k.detail ? ` · ${k.detail}` : ''}`;
    };
    add(
      'submission.claims',
      [
        'HOW EACH CRITERION IS CLAIMED MET. The criterion text is the CONTRACT\'s own `acceptanceCriteria` entry, verbatim, and the statement and the mapping are as the RECORD holds them; every VALUE below is read from the record, and only the labels around them ("claimed:", "requires:", this paragraph) are the assembly\'s. The MAPPING is the author\'s and the resolution beside it is the RECORD\'s — a suite-level run mapped to a criterion is the author asserting that the whole run covers it, so check whether the evidence below actually does.',
        ...claims.map((c) => `${c.ac} — ${c.acText}\n  claimed: ${c.statement || '(no statement recorded — the mapping stands alone)'}\n  requires: ${boundCheck(c)}`),
        ...unclaimed.map((u) => `${u.ac} — ${u.acText}\n  UNCLAIMED — neither claimed nor transferred. Say so rather than passing over it.`),
      ].join('\n'),
      'repo metadata',
    );
  }

  // 5 · THE CRITERION-LEVEL EVIDENCE (leg 12/23 AC-2): the TEST bodies behind the claims, at
  //     the anchor sha. A claim's `requires` above resolves to a RUN, and a run's content is
  //     the only thing that can answer whether it covers the criterion — a `npm test` pass
  //     says 55 files were green, never WHICH assertion meets AC-3.
  //
  //     THE SELECTION IS DERIVED FROM TWO READS, and both are named in the material:
  //       · the test files the REVIEWED RANGE touches (`git diff --name-only <range>`), and
  //       · the test files THE CLAIMS THEMSELVES name as evidence pointers.
  //     The second is not decoration. Measured: the first version selected from the range
  //     alone, and the reviewer's F1 named the hole exactly — a claim whose tests live in a
  //     file the range does not touch was not carried at all, which is the ordinary shape of
  //     a change that adds one assertion to a suite it never rewrote. A claim's own evidence
  //     pointer is the author saying "this is where I stand behind it", and it is a `brief`
  //     field, so it is derived like everything else here.
  //
  //     THE CUT IS PER FILE (reviewer's F8). Slicing the JOINED bodies at a budget truncated
  //     whichever file straddled it, with no marker saying so — a file that reads as complete
  //     and is not. Each file now either arrives whole or stops with a marker inside its own
  //     block saying how much is missing and where the rest is; nothing is silently partial.
  // THE SECTION IS EMITTED WHENEVER THERE IS A MATERIAL TO REVIEW — not only when a range
  // could be derived (the reviewer's F14). Guarding on `range` meant that a delivery whose
  // range derivation had itself failed produced NO section and therefore NO stated limit: the
  // one case where the reviewer most needs to be told what is missing was the one case that
  // said nothing. A missing range is a fact about the material, so the material states it.
  {
    const isTest = (p: string): boolean => !p.includes(' ') && (p.includes('__tests__/') || p.endsWith('.test.ts'));
    const touched = !range
      ? []
      : (git(store.root, ['diff', '--name-only', range]) ?? '')
          .split('\n')
          .map((p) => p.trim())
          .filter((p) => !!p && isTest(p));
    // ALL THREE CLAIM-SIDE FACTS ARE INPUTS HERE. AC-2 names three, and an evidence pointer
    // is the obvious one because it IS a path. The other two are prose and a command name,
    // and they are read the same way rather than waved at: a test path the author wrote into
    // their own statement, or into the command/detail the claim maps to, is a DERIVED signal
    // — the extraction is a path pattern over text the record already holds, not a judgement
    // about what matters. A token that names nothing at the anchor is not dropped in silence:
    // it lands in the "selected but unreadable" count below, the same bucket an evidence
    // pointer to a missing path lands in.
    const TEST_PATH = /[A-Za-z0-9_./-]*(?:__tests__\/[A-Za-z0-9_./-]+|[A-Za-z0-9_-]+\.(?:test|spec))\.(?:ts|tsx|mjs|js)/g;
    const pathsIn = (text: string): string[] => [...new Set(text.match(TEST_PATH) ?? [])].filter(isTest);
    const namedBy = new Map<string, string[]>();
    let namingClaims = 0;
    for (const c of claims) {
      const head = `${c.ac}${c.check ? ` → ${c.check}` : ''}`;
      let named = false;
      const name = (path: string, via: string): void => {
        named = true;
        namedBy.set(path, [...(namedBy.get(path) ?? []), `${head}${via}`]);
      };
      for (const p of c.evidence) {
        const path = p.trim();
        if (path && isTest(path)) name(path, '');
      }
      for (const path of pathsIn(c.statement ?? '')) name(path, ' (named in its statement)');
      for (const path of pathsIn(`${c.check ?? ''} ${c.bound?.detail ?? ''}`)) name(path, ' (named by its check)');
      if (named) namingClaims += 1;
    }
    // CLAIM-NAMED FIRST, and this is not cosmetic: `selected` is consumed in order under a
    // budget, so whichever source goes last is the first thing dropped. Ordering the range
    // first would mean a file a claim names and the range never touched lands at the END and
    // is the first casualty of the cut — SELECTED and still NOT CARRIED, which is F1's actual
    // harm surviving the fix. What the author pointed at as their evidence outranks the
    // sweep of everything the range happened to touch.
    const selected = [...namedBy.keys(), ...touched.filter((p) => !namedBy.has(p))];

    const parts: string[] = [];
    const carried: string[] = [];
    const cutShort: string[] = [];
    const dropped: string[] = [];
    const unreadable: string[] = [];
    let used = 0;
    for (const p of selected) {
      const named = namedBy.get(p);
      const caption = `--- ${p}${named ? `  [named as evidence by: ${named.join(' · ')}]` : ''}`;
      const body = head ? git(store.root, ['show', `${head}:${p}`]) : undefined;
      if (body === undefined) {
        // SELECTED BUT UNREADABLE IS STATED, NOT SKIPPED QUIETLY — the same rule as the cut.
        parts.push(`${caption}\n(NOT readable at ${head || 'the anchor'} — the file is selected but its bytes could not be read, so it is NOT below.)`);
        unreadable.push(p);
        continue;
      }
      const room = TEST_CHARS - used;
      if (body.length <= room) {
        parts.push(`${caption}\n${body}`);
        used += body.length;
        carried.push(p);
        continue;
      }
      // THE FILE SAYS WHAT IS MISSING (F8). Partial is fine; partial that reads as whole is
      // not — the old code sliced the JOINED text, so whichever file straddled the budget was
      // carried truncated and silent about it.
      if (room > 0) {
        // THE HOUSE FORM for a cut, per file: what is missing, out of how much, and WHERE THE
        // REST IS — the same shape the patch above uses ("the full range is in git"), pointed
        // at this file at the anchor instead of at a range.
        parts.push(
          `${caption}\n${body.slice(0, room)}\n[THIS FILE IS CUT: the last ${(body.length - room).toLocaleString()} of its ${body.length.toLocaleString()} chars are NOT below — the full file is at ${head}:${p} in git. What is missing is the END OF THE FILE, not a summary of it.]`,
        );
        carried.push(p);
        cutShort.push(p);
        used = TEST_CHARS;
      } else {
        dropped.push(p);
      }
    }
    const note = (paths: string[], label: string): string => (paths.length ? `${paths.length} ${label} — ${paths.join(', ')}` : `none ${label}`);

    // THE SECTION IS EMITTED WHENEVER THERE IS A RANGE, even with nothing selected (F2): the
    // boundary is the point. A range that changes no test file used to produce NO section at
    // all, so the reviewer had to DISCOVER that the evidence it wanted was never coming — and
    // AC-4 asks the material to name what falls outside the selection WHERE IT APPLIES.
    add(
      'submission.tests',
      [
        parts.join('\n\n'),
        `(THE SELECTION — derived, never hand-picked: the test files the reviewed range changes (${range ? touched.length : 'NO RANGE COULD BE DERIVED from the conclusion\'s citations, so this half is empty'}) and the test files the claims name (${namedBy.size} distinct path(s) named by ${namingClaims} of ${claims.length} claim(s) — a count of FILES, never of claims, so a claim naming three and a claim naming none are not the same number here), ${selected.length} distinct, read at the anchor sha ${head || 'UNRESOLVED'}. OF THOSE, ${carried.length} carried below: ${note(cutShort, 'CUT with its own length stated')} · ${note(unreadable, 'selected but unreadable')} · ${note(dropped, 'NOT carried — the budget ended first')}.`,
        `ON THE THREE CLAIM-SIDE FACTS — ALL THREE SELECT, each by its own route and each named in the caption of every file it chose: an EVIDENCE POINTER directly (a pointer is a path), and the claim's own STATEMENT or the mapped CHECK'S COMMAND/DETAIL by the test paths written into them (extracted by pattern, so it is derived from what the record already holds rather than from anyone's judgement about what matters). A token that names nothing at the anchor shows up below as selected-but-unreadable. Claim-named files are ordered before the range's sweep, so a file an author pointed at is CARRIED, not merely counted.`,
        `WHAT IS NOT HERE, so that an uncertain about it is a KNOWN boundary rather than an unseen one: any test file neither the range nor a claim names${selected.length ? '' : ' — and this range selects NONE, so no test text is carried at all'} · runtime behaviour no test text carries (a real browser, a real network) · whatever the cut above states it dropped. Raise any of them as \`uncertain\` and say what you would need.)`,
      ].join('\n'),
      'repo metadata',
    );
  }

  // 6 · THE CAPTURED CHECKS — each at the sha its run saw, and marked FACT vs CLAIM.
  add(
    'checks',
    bullets(
      b.conclusion.checks.map(
        (k) =>
          `${k.command}: ${k.result} — ${k.source === 'captured' ? 'CAPTURED FACT (the engine ran it)' : 'REPORTED CLAIM (someone typed it)'}${k.sha ? ` at ${k.sha}` : ' (no sha recorded)'}${k.detail ? ` — ${k.detail}` : ''}`,
      ),
    ),
    'runtime/tool output',
  );

  // 7 · THE RESOLVED DEFINING INPUTS — at their recorded sha, with the doc's own head. The
  //     excerpt rides the brief (12/22 AC-6), so the reviewer reads the same excerpt the
  //     card would and neither can be reading a different revision of it.
  for (const d of b.inputs) {
    add(
      `input.${d.name}`,
      d.status === 'resolved' ? `${d.detail}\n${d.excerpt ?? ''}` : `MISSING — '${d.name}' is a declared requiredInput with no resolved artifact.`,
      'documentation',
    );
  }

  // 8 · ANY PRIOR FINDINGS — a review is usually a RE-review, and this is the list it flips.
  const prior = b.findings;
  if (prior.findings.length) {
    add(
      'prior.findings',
      [
        `Pass ${prior.reviews} (${prior.at}) recorded the findings below${prior.anchor ? `, cited at ${prior.anchor}` : ''}. Re-state each one at its status in the current bytes — keep its id.`,
        bullets(
          prior.findings.map(
            (f) =>
              `${f.id} [${f.severity}] ${f.where} — ${f.text} (${f.status}${f.stale ? '; NOT re-assessed by the latest pass' : ''})`,
          ),
        ),
      ].join('\n'),
      'repo metadata',
    );
  }

  return {
    subject: `${id} — ${intent || '(no intent declared)'}`,
    context,
    constraints: acs.map((a, i) => `AC-${i + 1}: ${a}`),
    anchor: head,
    range,
  };
}

/**
 * Map the core's RAW items into the record the writer validates. It PICKS the five fields
 * and stamps `provenance` — it never spreads the item — so an unknown field the model
 * invented cannot reach the log, and an author cannot be forged.
 *
 * The VOCABULARY is deliberately NOT re-checked here: the single writer is the one validator
 * (`store.findingShapeProblem`), and its refusal names the offending field. A second check
 * would be a second validator — the thing the two-tier write model exists to prevent.
 */
export const shapeFindings = (items: unknown[], provenance: string): ReviewFindingInput[] =>
  items
    .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object' && !Array.isArray(i))
    .map((r) => ({
      id: String(r.id ?? '').trim(),
      severity: r.severity as ReviewFindingInput['severity'],
      where: String(r.where ?? '').trim(),
      text: String(r.text ?? '').trim(),
      // an unreadable status reads as OPEN — the conservative reading: a finding is resolved
      // only when the word says so, and a later pass re-checks whatever claims it.
      status: (r.status === 'resolved' ? 'resolved' : 'open') as ReviewFindingInput['status'],
      provenance,
    }));

/**
 * RENDER the assembled material as the one text block a SINGLE-PASS review is run over
 * (12/22 AC-6). The interactive session hands the core its material as structured channels;
 * the headless worker has one turn and one prompt, so it needs the same facts as text —
 * and it renders them from the SAME assembly, which is what keeps the two reviews from
 * ever reading different material.
 */
export const renderReviewMaterial = (m: ReviewMaterial): string =>
  [
    `SUBJECT\n${m.subject}`,
    m.constraints.length ? `THE CONTRACT'S ACCEPTANCE CRITERIA (the standard)\n${bullets(m.constraints)}` : '',
    m.anchor ? `ANCHOR — every line number you cite belongs to ${m.anchor}${m.range ? `, over ${m.range}` : ''}` : '',
    ...m.context.map((c) => `${c.label.toUpperCase()} (${c.sourceType})\n${c.text}`),
  ]
    .filter(Boolean)
    .join('\n\n');

export interface ReviewSessionOptions {
  /** The anti-runaway round ceiling — overrides the profile default so a caller (a test)
   *  can pin it. Never the UX driver. */
  maxRounds?: number;
  maxDiscussTurns?: number;
  /** The stamped author. Defaults to {@link REVIEW_PROVENANCE}. */
  provenance?: string;
}

export type ReviewSessionResult =
  | {
      ok: true;
      /** The human said GO: the findings list is as complete as this session will make it.
       *  NOT a verdict — the session never decides the gate. */
      outcome: 'recorded';
      rounds: number;
      /** The passes that actually LANDED (a pass that landed nothing is not one). */
      passes: number;
      /** The record AS READ BACK by the one derivation — each finding at its latest status,
       *  with the pass that recorded it (`stale` marks one the latest pass did not re-state). */
      findings: ReviewFindingsView['findings'];
      anchor: string;
    }
  | {
      ok: true;
      outcome: 'aborted' | 'exhausted';
      note: string;
      rounds: number;
      passes: number;
      findings: ReviewFindingsView['findings'];
      anchor: string;
    }
  | { ok: false; error: CommandError };

/**
 * The thin caller — the whole review session as a VALUE (guarded-write style, no
 * throw-as-flow): assemble the material, run the portable session over `REVIEW_PROFILE`, and
 * land each round's findings through `commands.landFindings` AS THEY ARE ASSERTED.
 *
 * That per-round landing is what makes AC-4 literal: an abort in round 4 loses nothing found
 * in rounds 1–3. A landing that FAILS is the session's failure (the core awaits the hook),
 * and a provider failure fails CLOSED with nothing fabricated.
 *
 * The session writes NO gate event — `landFindings` appends `evidence` and nothing else, and
 * the gate kinds are composite-owned by `gate!` — so what a review can never do is accept,
 * reject or close the task it reviewed.
 */
export const runReviewSession = async (
  commands: Commands,
  abilities: Abilities,
  id: string,
  opts: ReviewSessionOptions = {},
): Promise<ReviewSessionResult> => {
  const material = buildReviewMaterial(commands, id);
  const provenance = opts.provenance ?? REVIEW_PROVENANCE;
  const r = await new GrillSession(abilities, REVIEW_PROFILE, { maxTokens: REVIEW_MAX_TOKENS }).run({
    subject: material.subject,
    ...(material.context.length ? { context: material.context } : {}),
    ...(material.constraints.length ? { constraints: material.constraints } : {}),
    ...(opts.maxRounds !== undefined ? { maxRounds: opts.maxRounds } : {}),
    ...(opts.maxDiscussTurns !== undefined ? { maxDiscussTurns: opts.maxDiscussTurns } : {}),
    onFindings: (items) => {
      const findings = shapeFindings(items, provenance);
      // A pass that found NOTHING lands nothing: the writer refuses an empty landing (a
      // review that found nothing is not a record), and the prior list stands with its own
      // date rather than being silently re-stamped as current.
      if (!findings.length) return;
      const w = commands.landFindings(id, findings, { ...(material.anchor ? { anchorSha: material.anchor } : {}) });
      if (!w.ok) throw new Error(`the findings could not be recorded: ${w.error.blocker}`);
    },
  });
  if (!r.ok) return { ok: false, error: r.error };

  const view = commands.reviewFindings(id);
  const tail = { rounds: r.rounds, passes: view.reviews, findings: view.findings, anchor: material.anchor };
  if (r.verdict === 'solid') return { ok: true, outcome: 'recorded', ...tail };
  return { ok: true, outcome: r.verdict === 'reject' ? 'aborted' : 'exhausted', note: r.note, ...tail };
};
