import { AdvanceView, FrontmostReady } from '../commands/index.js';
import { CliContext, CommandExit, createContext, readOnlyRefuse } from './handlers.js';
import { resolveChain } from '../flow/chain.js';
import { buildAbilities } from '../abilities/index.js';
import { getAdapter } from '../abilities/llm/index.js';
import { buildStepRegistry } from '../flow/steps/index.js';
import { operatorIntegrityBlockers, runOperatorAction, OperatorActionResult } from '../flow/operator-action.js';
import { InteractAbility, ResearchFinding } from '../flow/types.js';
import type { OpLog } from '../abilities/obs/log.js';

/**
 * L3 · THE OPERATE LOOP'S WRITE — the WHAT'S NEXT card's APPROVE.
 *
 * The service already exposed the reads + the gate DECISION (leg 10). This module adds
 * the OTHER human move: approving the derived next step, over the operator action's
 * continue-leg path (`advance!`, leg 07) — the SAME `runOperatorAction` the CLI drives,
 * called in-process with the SAME deps (commands · root · registry · abilities). No rule
 * is re-implemented here and no write path is added: the action re-checks integrity
 * fail-closed, re-derives the advance, and executes through the Frame's own L1 writes
 * (`spawn!`/`submit!`/`gate!`/`run!`). What this module owns is what a terminal got for
 * free and a daemon must supply — three things:
 *
 *   1. THE HUMAN CHANNEL (care a). `advance!` asks its ONE approve question through
 *      `abilities.interact`, and the Frame asks its gate questions the same way. In a
 *      terminal that channel is the console. In a DAEMON there is no console: reading
 *      stdin would read the server's own socket and HANG. So the daemon's channel
 *      answers the ONE question the request already carries (the approve, bound to the
 *      card the human saw) and REFUSES EVERY OTHER PROMPT BY NAME. A gate the frame
 *      wants to decide live (state 'none' / rejected) therefore stops the approve
 *      fail-closed with a named refusal and zero writes — it never blocks, never
 *      fabricates an answer, and never guesses. A frontmost-ready task whose gate is
 *      still `none` (or `rejected`) DOES reach that prompt on an ordinary continue-leg:
 *      the daemon refuses it BY NAME and the operator submits the gate first (the UI's
 *      own write). A gate that is already SUBMITTED is decidable through the UI, so a
 *      continue-leg over submitted gates never prompts.
 *   2. THE SINGLE-FLIGHT (care b). The store append is synchronous, but the Frame
 *      awaits: two overlapping approves could interleave two frames over one journey.
 *      `claim()` is SYNCHRONOUS and is taken BEFORE the first await of a request, so a
 *      concurrent approve is refused with the named `approve-busy` error before it ever
 *      touches the store — one approve at a time, always. NOTE (measured, not assumed):
 *      today's chain steps and abilities resolve their awaits as microtasks, so a frame
 *      can run to completion without ever yielding the loop — the guard is a guard for
 *      the real async abilities (a provider call in a shaping chain), and the channel's
 *      single yield keeps it LIVE rather than theoretical (the e2e proves the refusal).
 *   3. THE CARD'S READ (care c, `whatsNext`): the operator view — the derivation `ann
 *      next` prints, plus the derivation's own executability, and an honest
 *      `integrity: unchecked` (the verdict is the lazy snapshot's, below). The card never
 *      claims the journey can advance — and never claims a verdict it has not received.
 *
 *      THE INTEGRITY PRE-CHECK IS NOT RUN HERE (leg 12/07, MEASURED: it cost ~3.3s of
 *      every page load — 187 per-sha `git cat-file` spawns inside `Store.check()`, which
 *      the pre-check ran twice). The pre-check is the APPROVE's own guard: the approve
 *      below runs it fail-closed BEFORE anything executes (rule 1 of the operator action),
 *      and nothing here weakens that. `POST /api/drive` runs NO such pre-check — its
 *      backstop is the store's own write guard, and this card's verdict speaks for the
 *      approve, never for the drive. The display gets the same answer on demand and on its
 *      own clock — `integritySnapshot()`, the read behind `GET /api/integrity`, which the
 *      page fetches lazily: a page load is never blocked on the check, and the card never
 *      claims a verdict it does not have.
 */

/* ── care a · the daemon's human channel ──────────────────────────────────── */

/** The refusal every prompt gets: there is no human at this end. */
const NO_HUMAN = 'this gate has no submission — the UI must submit first; the daemon never prompts';

/** A prompt the daemon cannot carry: no human, no answer. THROWN (not returned) so the
 *  frame/step boundary fails closed — a fabricated blank answer would read as a decision. */
export class DaemonPromptRefused extends Error {
  readonly code = 'daemon-prompt';
  constructor(what: string) {
    super(NO_HUMAN + (what ? ` (${what})` : ''));
    this.name = 'DaemonPromptRefused';
  }
}

/** The approved proposal no longer matches the derivation (the tab-left-open hazard):
 *  the human approved a card the logs no longer derive — nothing executes. */
export class StaleProposalRefused extends Error {
  readonly code = 'stale-proposal';
  constructor(readonly derivation: ApproveProposal, readonly reDerivation: AdvanceView) {
    super(`the proposal you approved is stale — the logs no longer derive it (approved: ${derivation.action} — ${derivation.detail} · now: ${reDerivation.action} — ${reDerivation.detail}); nothing executed`);
    this.name = 'StaleProposalRefused';
  }
}

/** What the human approved: the derivation the card displayed (`GET /api/whatsnext`). */
export interface ApproveProposal {
  action: string;
  detail: string;
}

/**
 * The daemon's `InteractAbility`: `present` records (the card the action would print to
 * a terminal is echoed in the response), `decide` answers the ONE decision the request
 * carries — the operator action's approve, the only question whose option set offers
 * `approve` — and EVERYTHING ELSE refuses by name.
 */
export class DaemonInteract implements InteractAbility {
  /** The texts presented to the absent human, in order (the ADVANCE card). */
  readonly presented: string[] = [];
  private answered = false;
  constructor(private readonly proposal: ApproveProposal | undefined, private readonly derive: () => AdvanceView) {}

  async present(text: string): Promise<void> {
    this.presented.push(text);
  }

  async decide(question: string, options: string[]): Promise<string> {
    // The approve is the ONLY decision a request can carry. Anything else (the frame's
    // own gate card: accept|reject) has no human on this side — refuse, never guess.
    if (!options.includes('approve')) throw new DaemonPromptRefused(`the frame asked a decision the daemon cannot carry: ${question}`);
    if (this.answered) throw new DaemonPromptRefused(`the frame asked a second decision: ${question}`);
    this.answered = true;
    // THE ONE YIELD: the human this channel stands in for is not synchronous, and the
    // request's single-flight slot is already claimed (`Approver.claim`), so nothing can
    // interleave a second frame — but the daemon must not hold the event loop for the
    // whole run either. Other clients (a gate decision, the next card read) get their
    // turn HERE; the action's own re-derivation right after this is what keeps that safe.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The human approved THIS card: re-derive at the approve (the same instant the
    // action's own rule 2 re-derives) and refuse when the logs no longer match it —
    // a stale approve executes nothing.
    if (this.proposal) {
      const now = this.derive();
      if (this.proposal.action !== now.action || this.proposal.detail !== now.detail) throw new StaleProposalRefused(this.proposal, now);
    }
    return 'approve';
  }

  async ask(question: string): Promise<string> {
    throw new DaemonPromptRefused(`a step asked: ${question}`);
  }

  async research(_topics: string[]): Promise<ResearchFinding[]> {
    throw new DaemonPromptRefused('a step asked for research');
  }
}

/* ── the card's read (care c) ─────────────────────────────────────────────── */

/** The card's integrity line as the READ reports it — NO verdict. The full pre-check is
 *  the write's guard (and the lazy snapshot's job, below); running it on the page's read
 *  path is what made every load take ~3.3s (leg 12/07, measured). */
export interface IntegrityUnchecked {
  state: 'unchecked';
  /** What is NOT being claimed, and when the real answer arrives. */
  note: string;
}

/** The lazy integrity snapshot (`GET /api/integrity`) — the verdict the card displays once
 *  it has been asked for: the SAME fail-closed pre-check the approve runs. */
export interface IntegritySnapshot {
  clean: boolean;
  blockers: string[];
}

/** Why the card's read carries no verdict — the SAME words the card shows (one source for
 *  the read and the page, so they cannot drift). */
export const INTEGRITY_UNCHECKED =
  'not read by the page load — the full check (ann check · the S4 validators · ann verify · the docs manifest · uncommitted tracked journey/docs) is the APPROVE\u2019s own guard, re-run fail-closed before anything executes; the page asks for this snapshot on its own (GET /api/integrity) so a load is never blocked on it';

/** The operator view — what the WHAT'S NEXT card renders: the derived next action and
 *  its derivation facts. The integrity verdict is NOT part of this read (see above) — the
 *  card's `integrity` field says so, and `integritySnapshot()` answers it on demand. */
export interface WhatsNextView {
  /** The derived advance (`ann --json next`'s advance object). */
  advance: AdvanceView;
  /** The frontmost-ready task, when the derivation proposes one. */
  frontmost?: FrontmostReady;
  /** The active leg's gate: MET, or UNMET with its blocker. */
  legGate: { met: boolean; blocker?: string };
  /** Every undecided submission on the active leg (the human's other move). */
  pendingGates: Array<{ task: string; gate: string }>;
  /** The READ's honest half of the integrity display: unchecked, and why. The verdict
   *  arrived with everything else before leg 12/07 — at 3.3s per page load. */
  integrity: IntegrityUnchecked;
  /** The frontmost-ready task's RESOLVED chain — how many CONTENT steps the frame would
   *  run (`ann flow <id>`: contract.flow → workType chain → project default). 0 = there is
   *  NOTHING to execute: an `implementation` task's chain is deliberately empty, so the run
   *  only activates the task and waits for the runner. The card needs this fact to promise
   *  execution only where there is something to execute (a chain that resolves WITH a
   *  problem counts 0 — the frame fails closed at config, so nothing executes either). */
  chainSteps: number;
  /** TRUE iff the DERIVATION side allows the approve: the machine-executable derivation
   *  and a ready task. This is HALF the old answer — the integrity half is the write's own
   *  re-check (and the lazy snapshot), so a true here is "the approve may be offered", never
   *  "the journey can advance"; a dirty state still refuses the write with its named
   *  blockers, which the card displays. FALSE = present the card and stop (no approve
   *  button) — never a button that cannot work. */
  executable: boolean;
}

/** The frontmost-ready task's resolved chain LENGTH — the derived fact behind
 *  `chainSteps` (the SAME `resolveChain` the CLI's `ann flow <id>` and the Frame use). */
function frontmostChainSteps(ctx: CliContext, root: string, frontmost: FrontmostReady | undefined): number {
  if (!frontmost) return 0;
  const flow = resolveChain(ctx.store, frontmost.task, root);
  return flow.problem ? 0 : flow.chain.length;
}

export function whatsNext(root: string, log?: OpLog): WhatsNextView {
  const ctx = createContext(root, [], { json: true, ...(log ? { log } : {}) });
  const advance = ctx.commands.advance();
  const lb = ctx.commands.lookBack();
  return {
    advance,
    ...(lb.frontmostReady ? { frontmost: lb.frontmostReady } : {}),
    legGate: lb.legGate,
    pendingGates: lb.pendingGates,
    // NO pre-check here (leg 12/07): the same call at this spot cost ~3.3s per page load.
    // The approve and the drive run it fail-closed themselves; the card fetches the
    // verdict lazily through `integritySnapshot`. The read says exactly that, and no more.
    integrity: { state: 'unchecked', note: INTEGRITY_UNCHECKED },
    chainSteps: frontmostChainSteps(ctx, root, lb.frontmostReady),
    executable: advance.action === 'continue-leg' && !!lb.frontmostReady,
  };
}

/** THE LAZY INTEGRITY SNAPSHOT (`GET /api/integrity`) — the full fail-closed pre-check the
 *  approve runs, asked for on demand instead of on every page load. NOTHING is re-implemented
 *  here and no guard moves: `operatorIntegrityBlockers` is the action's own function, so the
 *  card's verdict and the write's refusal are the SAME answer. The page shows a pending state
 *  until this lands, then the real result — never a stale or blank claim (AC-2/AC-3). */
export function integritySnapshot(root: string, log?: OpLog): IntegritySnapshot {
  const ctx = createContext(root, [], { json: true, ...(log ? { log } : {}) });
  const blockers = operatorIntegrityBlockers(ctx.commands, root);
  return { clean: blockers.length === 0, blockers };
}

/* ── the approve ──────────────────────────────────────────────────────────── */

/** One approve: the HTTP status class + the response document. The body carries the
 *  NAMED blockers / the re-derivation through to the caller — a refusal is never a
 *  bare "no" (AC-2). */
export interface ApproveOutcome {
  status: number;
  body: Record<string, unknown>;
}

/** An approve is already running: nothing queued, nothing interleaved (care b). */
export const APPROVE_BUSY =
  'an approve is already running — the daemon runs ONE at a time (this request was refused; nothing was queued or interleaved) — re-read the card and try again';

export class Approver {
  private inFlight = false;

  constructor(private readonly root: string) {}

  /** The SYNCHRONOUS single-flight claim — call it BEFORE the request's first await (the
   *  body read) so two overlapping approves can never both start a frame. */
  claim(): boolean {
    if (this.inFlight) return false;
    this.inFlight = true;
    return true;
  }

  /** Release the slot — always, on every path (the route's `finally`). */
  release(): void {
    this.inFlight = false;
  }

  /** The approve: the operator action, in-process, with the CLI's own deps + the daemon
   *  channel. Every refusal the action produces is carried through by name. */
  async approve(proposal?: ApproveProposal, log?: OpLog): Promise<ApproveOutcome> {
    // The SAME ctx the CLI builds (`advance!`), so the action reads what the CLI reads;
    // the read-only chokepoint is the CLI's own (ANN_STORE on a non-active journey). The
    // request's operational-log handle rides in (leg 12/05), so the frame's phases and
    // the approve's writes correlate with the request's own line.
    const ctx = createContext(this.root, ['advance!'], { json: true, ...(log ? { log } : {}) });
    try {
      readOnlyRefuse(ctx, 'advance!');
    } catch (e) {
      return { status: 409, body: { ok: false, error: { code: e instanceof CommandExit ? e.code : 'error', message: (e as Error).message } } };
    }

    const channel = new DaemonInteract(proposal, () => ctx.commands.advance());
    let result: OperatorActionResult;
    try {
      result = await runOperatorAction({
        commands: ctx.commands,
        root: this.root,
        registry: buildStepRegistry(),
        abilities: buildAbilities(getAdapter(undefined, this.root, { runId: ctx.log.runId, traceId: ctx.log.traceId }), { interact: channel }),
        log: ctx.log,
      });
    } catch (e) {
      // The daemon channel's two named refusals — the action stopped fail-closed and
      // nothing executed. Anything else is a genuine fault: rethrow to the route.
      if (e instanceof StaleProposalRefused) {
        return { status: 409, body: { ok: false, error: { code: e.code, message: e.message }, derivation: e.derivation, reDerivation: e.reDerivation } };
      }
      if (e instanceof DaemonPromptRefused) {
        return { status: 409, body: { ok: false, error: { code: e.code, message: e.message }, presented: channel.presented } };
      }
      throw e;
    }

    // AC-1: a dirty state refuses FIRST, with the named blockers, and nothing executes.
    if (result.stop === 'refused-integrity') {
      return {
        status: 409,
        body: {
          ok: false,
          error: {
            code: 'refused-integrity',
            message: `the approve refused — the integrity re-check failed CLOSED on a dirty state (nothing executed): ${result.blockers.length} named blocker${result.blockers.length === 1 ? '' : 's'}`,
          },
          blockers: result.blockers,
          derivation: result.derivation,
        },
      };
    }
    // AC-2: the action's own re-derivation contradicted the approved proposal.
    if (result.stop === 'stale-proposal') {
      return {
        status: 409,
        body: {
          ok: false,
          error: { code: 'stale-proposal', message: 'the approve refused — the re-derived advance no longer matches the approved proposal (nothing executed)' },
          derivation: result.derivation,
          reDerivation: result.reDerivation,
        },
      };
    }
    // advanced (the frame ran) · boundary (not machine-executable — present + stop) ·
    // declined (the human said no): value stops, nothing refused, nothing silent.
    return { status: 200, body: { ok: true, value: result, presented: channel.presented } };
  }
}
