import { AdvanceView, FrontmostReady } from '../commands/index.js';
import { CommandExit, createContext, readOnlyRefuse } from './handlers.js';
import { buildAbilities } from '../abilities/index.js';
import { getAdapter } from '../abilities/llm/index.js';
import { buildStepRegistry } from '../flow/steps/index.js';
import { operatorIntegrityBlockers, runOperatorAction, OperatorActionResult } from '../flow/operator-action.js';
import { InteractAbility, ResearchFinding } from '../flow/types.js';

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
 *      fabricates an answer, and never guesses. With our discipline a gate is always
 *      SUBMITTED first (the frame blocks-and-waits on it), so the normal continue-leg
 *      never reaches a prompt.
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
 *      next` prints, plus the integrity blockers `advance!` would refuse on. The card
 *      never claims the journey can advance when the action would refuse it.
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

/** The operator view — what the WHAT'S NEXT card renders: the derived next action and
 *  its derivation facts, and the integrity blockers the approve would refuse on. */
export interface WhatsNextView {
  /** The derived advance (`ann --json next`'s advance object). */
  advance: AdvanceView;
  /** The frontmost-ready task, when the derivation proposes one. */
  frontmost?: FrontmostReady;
  /** The active leg's gate: MET, or UNMET with its blocker. */
  legGate: { met: boolean; blocker?: string };
  /** Every undecided submission on the active leg (the human's other move). */
  pendingGates: Array<{ task: string; gate: string }>;
  /** The `ann check` + `ann verify` + manifest + git-status blockers the action
   *  re-checks fail-closed BEFORE anything executes. */
  integrity: { clean: boolean; blockers: string[] };
  /** TRUE iff the approve will execute: a clean state, the machine-executable
   *  derivation, and a ready task. FALSE = present the card and stop (the UI offers no
   *  approve) — never a button that cannot work. */
  executable: boolean;
}

export function whatsNext(root: string): WhatsNextView {
  const ctx = createContext(root, [], { json: true });
  const advance = ctx.commands.advance();
  const lb = ctx.commands.lookBack();
  const blockers = operatorIntegrityBlockers(ctx.commands, root);
  return {
    advance,
    ...(lb.frontmostReady ? { frontmost: lb.frontmostReady } : {}),
    legGate: lb.legGate,
    pendingGates: lb.pendingGates,
    integrity: { clean: blockers.length === 0, blockers },
    executable: blockers.length === 0 && advance.action === 'continue-leg' && !!lb.frontmostReady,
  };
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
  async approve(proposal?: ApproveProposal): Promise<ApproveOutcome> {
    // The SAME ctx the CLI builds (`advance!`), so the action reads what the CLI reads;
    // the read-only chokepoint is the CLI's own (ANN_STORE on a non-active journey).
    const ctx = createContext(this.root, ['advance!'], { json: true });
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
        abilities: buildAbilities(getAdapter(undefined, this.root), { interact: channel }),
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
