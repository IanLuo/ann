import { AdvanceView, Commands, CONTRACT_FIELDS, DeferredTask, FrontmostReady, GoalView } from '../commands/index.js';
import type { OpLog } from '../abilities/obs/log.js';
import { loadDocsManifest } from '../store/docs.js';
import { StepLookup, loadProjectFlow } from './chain.js';
import { Frame } from './frame.js';
import { InteractAbility, LlmAbility, ResearchFinding } from './types.js';
import { unquote } from './steps/shared.js';

/**
 * L2 · THE SEMANTIC DRIVER — the LLM loop that reads a COMMAND's value-canonical output,
 * PROPOSES the next call, and has CODE validate the proposal against the CLOSED SET before
 * anything executes.
 *
 *   read (the derived JSON) ─► LLM proposes ─► CODE validates (the closed set) ─► execute
 *   through the EXISTING command layer (in-process — the operator-action precedent) ─► repeat
 *
 * The recorded follow-up to flow-control-spec v7 §5: "auto-DRAFTING a task contract from a
 * leg's epic for the builder to approve is LLM-surface work — deferred with the operator
 * action's implementation, never an L1/engine derivation". This module is that surface work
 * and nothing else (design record: `.agents/plan/semantic-driver-design.md`, the build task
 * `12-operate-loop/02-implementation-semantic-driver`).
 *
 * THE SETTLED CONTRACT (the task's `extended` note — MODE A): the driver AUTO-EXECUTES the
 * calls it proposes, but ONLY after CODE validates the proposal against the closed set. A
 * per-run approve-each mode (C) is the PLANNED EXTENSION, deliberately unbuilt; suggest-only
 * (B) was rejected.
 *
 * THE PRESENT-ONLY REFINEMENT (also from the task's note): the driver may PRESENT
 * (`submit!` opens a gate) and may run a task through the frame (`run!`) — but it must NEVER
 * write a claim of fact (`evidence!`/`claims`/`checks` — the RUNNER's own report), a
 * completion, a gate decision, authored content (`spawn!`), or a scope decision
 * (deferred/transferred/cancelled). Those names are not in the closed set: they are refused
 * BY NAME (`forbidden-call`) with the reason, never silently clamped and never turned into
 * a free-form act. Two consequences hold BY CONSTRUCTION, not by convention:
 *   · the driver's human channel is its OWN and present-only (a caller passes no channel) —
 *     the loop cannot answer a gate even if a caller wanted it to, and a run that reaches a
 *     live gate decision lands there rather than deciding it;
 *   · the authored-work boundary stops the loop and DRAFTS `GENERATED` content for the
 *     human's approval — `spawn!` stays a human/push act, and `none` (the goal consult) is
 *     present-and-stop (design Q3: the session-end moves are human moves).
 *
 * BOUNDED: a max turn count (`maxTurns`, refused if out of range — never an unannounced
 * clamp), a ROUTE REASON on every stop, a CHECKPOINT at every human gate, and resume by
 * RE-DERIVATION: every turn re-reads the journey, and a resumed run compares the checkpoint
 * it was handed against the FRESH derivation — a mismatch is RECORDED, and no turn or call
 * of the stale plan is ever replayed (nothing is stored to replay).
 *
 * NO NEW WRITE PATH (AC-5): the driver composes the SAME L1 writers the CLI composes
 * (`commands.submit!` for the present act, the Frame's own writes for `run!`) through the
 * existing command layer, in process. It adds no command, no new write, no cross-folder
 * writer — so there is nothing to add to the write-confinement invariant (AGENTS.md). It
 * lives in L2; the surface calls it (`POST /api/drive` — no CLI command, no UI wiring).
 */

/** The default turn bound: enough for read → run → land, never an open loop. */
export const DRIVER_MAX_TURNS = 8;
/** The CEILING on `maxTurns` — a runtime bound that cannot be raised into an open loop.
 *  Unlike a proposal, an out-of-range `maxTurns` is REFUSED, never clamped. */
export const DRIVER_MAX_TURNS_CEILING = 24;

/* ── the CLOSED SET ───────────────────────────────────────────────────────── */

export type DriverCallKind = 'read' | 'write';

export interface DriverCallSpec {
  name: string;
  kind: DriverCallKind;
  /** The arg names it takes. NOTHING else is accepted — an extra key is a refusal. */
  args: string[];
  /** The args that may be omitted (a `run!` without an id targets the frontmost-ready). */
  optional?: string[];
  description: string;
}

/**
 * THE CLOSED SET — every call the model may propose, and the whole of it. A proposal
 * outside this table is refused by name (`unknown-call`), a proposal naming a deliberately
 * excluded command is refused by name WITH its reason (`forbidden-call`), and neither is
 * ever turned into something else: no clamping, no repairing, no free-form fallback.
 */
export const DRIVER_CALLS: readonly DriverCallSpec[] = [
  { name: 'next', kind: 'read', args: [], description: 'the derived advance — where the journey goes next (`ann next`)' },
  { name: 'goal', kind: 'read', args: [], description: 'the goal-session consult: presence, structural exhaustion, verdict, the legs (`ann goal`)' },
  { name: 'gates', kind: 'read', args: [], description: 'the gate queue + the active leg gate + the deferred work + the frontmost-ready (`ann journey`)' },
  { name: 'check', kind: 'read', args: [], description: 'the integrity findings — gate gaps and rule findings (`ann check`)' },
  { name: 'verify', kind: 'read', args: [], description: 'the drift findings — the log against filesystem/git reality (`ann verify`)' },
  { name: 'detail', kind: 'read', args: ['id'], description: 'one node\'s detail: derived status, contract, gates, artifacts, events (`ann detail <id>`)' },
  {
    name: 'submit!',
    kind: 'write',
    args: ['id', 'gate'],
    description: 'PRESENT: open a gate on a task (`ann submit! <id> <gate>`, gate ∈ grill|confirm). It hands the decision to the human — it never decides. The run LANDS there.',
  },
  {
    name: 'run!',
    kind: 'write',
    args: ['id'],
    optional: ['id'],
    description:
      'take a task through the frame (`ann run! <id>`): materialize → gates → activate → execute → verify → confirm. It PRESENTS and opens gates; it never answers one — a run that reaches a live gate decision lands there. Without `id` it runs the frontmost-ready task.',
  },
];

/**
 * THE NEVER LIST — real commands the driver must not call, each with the reason it is out.
 * A proposal naming one of these is refused BY NAME (`forbidden-call`), so the refusal
 * teaches the boundary instead of merely rejecting the string.
 */
export const DRIVER_NEVER: ReadonlyArray<{ name: string; why: string }> = [
  { name: 'gate!', why: 'a gate decision is the HUMAN\'s — the driver may present a gate, never answer one (it lands at the next human decision)' },
  { name: 'evidence!', why: 'a claim of fact (the runner\'s own report, F-AC18) — never the driver\'s (the present-only refinement)' },
  { name: 'capture!', why: 'a captured check is the runner\'s own fact, produced by running the project\'s command — never the driver\'s' },
  { name: 'complete!', why: 'a completion is the human accept + the auto-close; the driver never self-closes' },
  { name: 'spawn!', why: 'authored content: the driver DRAFTS the node contract (GENERATED) and the human approves the bytes — spawn! stays a human/push act' },
  { name: 'spec!', why: 'authored content (a docs-as-git spec doc) — the human authors and the operator commits' },
  { name: 'append!', why: 'a scope decision (deferred/transferred/cancelled) is the human\'s, not the driver\'s' },
  { name: 'goal!', why: 'the goal verdict (met), the archive and the seed are human moves — at `none` the driver presents the consult and stops' },
  { name: 'advance!', why: 'the operator\'s approve→execute gesture: the driver IS the loop (Mode A auto-executes the VALIDATED calls) — a second approve is a human decision' },
  { name: 'lock!', why: 'retired with the docs-as-git refactor (D3)' },
  { name: 'supersede!', why: 'retired with the docs-as-git refactor (D3)' },
  { name: 'docs', why: 'a docs write is a git-content act the operator owns, never the driver\'s' },
];

export interface DriverRefusal {
  code: 'unparseable-proposal' | 'unknown-call' | 'forbidden-call' | 'bad-args';
  /** The proposed call name, when the output named one. */
  call?: string;
  reason: string;
}

/* ── the proposal the model may emit ──────────────────────────────────────── */

export interface DriverProposedCall {
  kind: 'call';
  call: string;
  args: Record<string, string>;
  reason: string;
}

export interface DriverStopProposal {
  kind: 'stop';
  reason: string;
}

export type DriverProposal = DriverProposedCall | DriverStopProposal;

/** Parse + VALIDATE one model output against the closed set. A malformed output, an
 *  unknown name, a forbidden name and a bad argument each return a NAMED refusal — the
 *  four ways a proposal can fail, never a silent repair. */
export function validateProposal(
  text: string,
  ctx: { commands: Commands; advance: AdvanceView },
): { ok: true; proposal: DriverProposal } | { ok: false; refusal: DriverRefusal } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unquote(text));
  } catch {
    return { ok: false, refusal: { code: 'unparseable-proposal', reason: 'the turn returned unparseable output (strict JSON only) — treated as a refusal, never fabricated' } };
  }
  const o = parsed as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    return { ok: false, refusal: { code: 'unparseable-proposal', reason: 'the turn returned JSON that is not an object — expected {"call": …} or {"stop": …}' } };
  }

  if ('stop' in o) {
    if (typeof o.stop !== 'string' || !o.stop.trim()) {
      return { ok: false, refusal: { code: 'unparseable-proposal', reason: 'a stop proposal needs a non-empty "stop" string (why the journey waits)' } };
    }
    return { ok: true, proposal: { kind: 'stop', reason: o.stop.trim() } };
  }

  if (typeof o.call !== 'string' || !o.call.trim()) {
    return { ok: false, refusal: { code: 'unparseable-proposal', reason: 'no "call" (or "stop") in the proposal — expected {"call": "<name>", "args": {…}} or {"stop": "…"}' } };
  }
  const name = o.call.trim();
  const spec = DRIVER_CALLS.find((c) => c.name === name);
  if (!spec) {
    const never = DRIVER_NEVER.find((n) => n.name === name);
    if (never) return { ok: false, refusal: { code: 'forbidden-call', call: name, reason: `'${name}' is deliberately OUT of the closed set: ${never.why}` } };
    return {
      ok: false,
      refusal: { code: 'unknown-call', call: name, reason: `'${name}' is not in the closed set (${DRIVER_CALLS.map((c) => c.name).join(' · ')}) — the driver never makes a free-form call` },
    };
  }

  const rawArgs = o.args ?? {};
  if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
    return { ok: false, refusal: { code: 'bad-args', call: name, reason: `'${name}' args must be an object` } };
  }
  const args: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawArgs as Record<string, unknown>)) {
    if (!spec.args.includes(k)) {
      return { ok: false, refusal: { code: 'bad-args', call: name, reason: `'${name}' takes only ${spec.args.join(', ') || '(no args)'} — '${k}' is not an argument` } };
    }
    if (typeof v !== 'string' || !v.trim()) {
      return { ok: false, refusal: { code: 'bad-args', call: name, reason: `'${name}.${k}' must be a non-empty string` } };
    }
    args[k] = v.trim();
  }
  for (const k of spec.args) {
    if (args[k] === undefined && !(spec.optional ?? []).includes(k)) {
      return { ok: false, refusal: { code: 'bad-args', call: name, reason: `'${name}' needs the argument '${k}'` } };
    }
  }

  // the derivation guards — a call that the CURRENT derivation cannot carry is a refusal
  if (name === 'run!' && args.id === undefined) {
    if (ctx.advance.action !== 'continue-leg') {
      return { ok: false, refusal: { code: 'bad-args', call: name, reason: `no frontmost-ready task: the derivation is '${ctx.advance.action}' (${ctx.advance.detail}) — 'run!' needs an explicit id or a continue-leg derivation` } };
    }
  }
  for (const id of [args.id].filter((x): x is string => !!x)) {
    if (!ctx.commands.ids().includes(id)) return { ok: false, refusal: { code: 'bad-args', call: name, reason: `no node '${id}' in the journey` } };
  }
  if (name === 'run!') {
    const id = args.id;
    if (id && !id.includes('/')) return { ok: false, refusal: { code: 'bad-args', call: name, reason: `'${id}' is a leg — 'run!' runs a TASK (gates live on tasks, flow-control v6 §3)` } };
    if (id && ['done', 'superseded', 'cancelled', 'deferred'].includes(ctx.commands.status(id))) {
      return { ok: false, refusal: { code: 'bad-args', call: name, reason: `'${id}' is closed ('${ctx.commands.status(id)}') — there is nothing to run` } };
    }
  }
  if (name === 'submit!' && !['grill', 'confirm'].includes(args.gate)) {
    return { ok: false, refusal: { code: 'bad-args', call: name, reason: `gate must be 'grill' or 'confirm' (not '${args.gate}')` } };
  }
  return { ok: true, proposal: { kind: 'call', call: name, args, reason: typeof o.reason === 'string' ? o.reason.trim() : '' } };
}

/* ── what the loop reads and what it leaves behind ────────────────────────── */

export interface DriverObservation {
  turn: number;
  /** The FRESH derivation — re-read every turn, never a cached plan. */
  advance: AdvanceView;
  frontmost?: FrontmostReady;
  alsoReady: FrontmostReady[];
  legGate: { met: boolean; blocker?: string };
  pendingGates: Array<{ task: string; gate: string }>;
  deferred: DeferredTask[];
  goal: { present: boolean; goalId?: string; verdict: string; structural: string };
  /** What the earlier calls in THIS run returned — the loop's own memory (nothing else is
   *  stored: the run holds no plan and writes no event of its own). */
  outputs: Array<{ call: string; output: unknown }>;
}

export interface DriverExecuted {
  turn: number;
  call: string;
  args: Record<string, string>;
  output: unknown;
  /** The commands the call landed (for the report); empty for a read. */
  wrote: string[];
}

export interface DriverLanding {
  where: 'gate' | 'awaiting-runner';
  task: string;
  gate?: string;
  frameStop?: string;
}

export interface DriverCheckpoint {
  at: string;
  action: AdvanceView['action'];
  detail: string;
  task?: string;
  gate?: string;
}

/** The GENERATED draft the authored-work boundary leaves for the human: the model, the
 *  provider, the turn and the run are IN the label, so a reader can never mistake authored
 *  content for the human's own (and never wonder which provider produced it). It is NOT a
 *  write: the human approves the BYTES and runs `spawn!` (the `approve` field names it). */
export interface DriverDraft {
  label: 'GENERATED';
  provenance: { model: string; provider: string; turn: number; runId: string; at: string };
  kind: 'task' | 'closure';
  /** The id to spawn (the leg's next free prefix + the v15 task-id grammar). */
  id: string;
  contract: Record<string, unknown>;
  /** What the draft was grounded on — the epic, the goal, the upstream artifacts. */
  groundedOn: string[];
  rationale: string;
  /** The contract check the draft PASSED (the same checklist `spawn!` enforces) — empty
   *  problems. A draft that fails it is never returned: the run stops `draft-invalid`. */
  validated: { fields: string[]; problems: string[] };
  /** THE HUMAN ACT that lands it — approve the bytes, then run this. */
  approve: { act: string; id: string; contract: Record<string, unknown>; then: string };
}

export type DriverStop =
  /** The model proposed `stop` (its reason is the route reason). */
  | 'model-stop'
  /** The turn bound is reached — the loop ends where the journey stands. */
  | 'turn-bound'
  /** The proposal was out of the closed set / malformed / wrongly shaped — NAMED. */
  | 'refused-proposal'
  /** The provider failed: a NAMED stop with ZERO writes (no fabricated advance). */
  | 'provider-failure'
  /** The loop landed at the next human decision (a submittable gate, or the runner's
   *  evidence commit before the confirm gate). */
  | 'human-gate'
  /** The authored-work boundary (advance-leg · closure-needed): a GENERATED draft. */
  | 'boundary-drafted'
  /** The `none` boundary: the goal consult is presented and the loop stops (design Q3). */
  | 'boundary-none'
  /** The drafted contract failed validation — nothing is offered for approval. */
  | 'draft-invalid'
  /** A VALIDATED call the command layer refused (a named blocker), or a frame stop that
   *  is neither a completion nor a human gate. */
  | 'call-refused'
  /** The driver's own config is unusable (e.g. an out-of-range maxTurns). */
  | 'invalid-config';

export interface DriverResult {
  stop: DriverStop;
  /** WHY the loop stopped — on EVERY stop (AC-1: never a silent end). */
  routeReason: string;
  /** LLM turns consumed (one per model call, the draft call included). */
  turns: number;
  runId: string;
  provider: string;
  model?: string;
  /** The FRESH derivation at the stop (never the one the run began with). */
  derivation: AdvanceView;
  observation: DriverObservation;
  /** Every call that executed, in order — the auditable trace of the run. */
  executed: DriverExecuted[];
  /** The refusal, when the loop stopped on one. */
  refusal?: DriverRefusal;
  /** The checkpoint a human gate leaves (AC-1: one at EVERY human gate). */
  checkpoint?: DriverCheckpoint;
  landing?: DriverLanding;
  draft?: DriverDraft;
  consult?: GoalView;
  /** The card(s) presented to the absent human (the driver's present-only channel). */
  presented: string[];
  /** The resume note, when the caller handed back a checkpoint (AC-1: resume is
   *  RE-DERIVATION — a checkpoint that no longer matches is recorded, never replayed). */
  resumed?: { checkpoint: DriverCheckpoint; matched: boolean; note: string };
  /** What the run recorded about itself (Q1: op-log metrics only — the draft is
   *  re-derivable, so there is no turn transcript and no new event kind). */
  metrics: { providerCalls: number; writes: string[] };
}

/* ── the present-only human channel ───────────────────────────────────────── */

/** A gate decision the driver will not make. THROWN (never returned): a fabricated answer
 *  would read as a human decision — the run must land instead. */
export class DriverGateRefused extends Error {
  readonly code = 'driver-gate';
  constructor(readonly question: string, readonly options: string[]) {
    super(`the semantic driver never answers a gate: '${question}' [${options.join(' | ')}] — the run lands at the human decision instead`);
    this.name = 'DriverGateRefused';
  }
}

/**
 * THE DRIVER'S OWN HUMAN CHANNEL: `present` records (the card reaches the caller through
 * the result), and EVERY question refuses by name. The driver's deps carry no interact
 * ability at all, so "the driver never answers a gate" is unrepresentable rather than
 * merely forbidden.
 */
class PresentOnlyInteract implements InteractAbility {
  readonly presented: string[] = [];
  async present(text: string): Promise<void> {
    this.presented.push(text);
  }
  async decide(question: string, options: string[]): Promise<string> {
    throw new DriverGateRefused(question, options);
  }
  async ask(question: string): Promise<string> {
    throw new DriverGateRefused(question, []);
  }
  async research(_topics: string[]): Promise<ResearchFinding[]> {
    throw new DriverGateRefused('research', []);
  }
}

/* ── the driver ───────────────────────────────────────────────────────────── */

export interface DriverDeps {
  commands: Commands;
  root: string;
  /** The step registry `run!` needs (the same one the CLI's run!/advance! build). */
  registry: StepLookup;
  /** THE ONLY ability the driver is given. No interact channel: the driver owns a
   *  present-only one (see above). The adapter behind `llm` holds the credential —
   *  server-side — and nothing here reads, logs or returns it. */
  llm: LlmAbility;
  /** RECORDED_BY — the provenance stamped on every write the driver itself lands. */
  recordedBy: string;
  /** The provider/model the run is bound to (recorded in the run's own provenance; the
   *  key is NOT — the adapter resolves it server-side). */
  provider?: string;
  model?: string;
  /** The turn bound. Out of range (1 … DRIVER_MAX_TURNS_CEILING) is REFUSED, not clamped. */
  maxTurns?: number;
  /** A checkpoint a previous run left: compared to the FRESH derivation. A mismatch is
   *  recorded (the run re-derived); nothing is ever replayed. */
  resume?: DriverCheckpoint;
  /** The run id (default: generated). */
  runId?: string;
  /** The OPERATIONAL LOG (leg 12/05) — optional: when present, every TURN records its
   *  proposal + the CODE verdict, and every stop records its route reason, all under the
   *  driver's own runId (the frame's phases inside the run inherit it). */
  log?: OpLog;
}

export async function runSemanticDriver(deps: DriverDeps): Promise<DriverResult> {
  const commands = deps.commands;
  const provider = deps.provider ?? 'default';
  const runId = deps.runId ?? `drive-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  /** THE CORRELATION (AC-1): the driver's own run — every turn, every stop, and every
   *  frame phase of a `run!` inside it shares this runId, so `ann log --run <runId>` is
   *  the whole run: what ran, in what order, and why it stopped. */
  const log = deps.log?.child({ runId });
  const channel = new PresentOnlyInteract();
  const executed: DriverExecuted[] = [];
  const writes: string[] = [];
  let turns = 0;
  const base = (stop: DriverStop, routeReason: string): DriverResult => {
    const now = derive(commands);
    // THE STOP LINE — every stop carries its route reason (AC-1: never a silent end).
    log?.line({
      event: 'stop',
      command: 'drive',
      outcome: stop,
      level: stop === 'provider-failure' || stop === 'call-refused' ? 'warn' : 'info',
      inputs: { routeReason },
      ...(stop === 'provider-failure' ? { error: { code: 'provider-failure', message: routeReason } } : {}),
    });
    return {
      stop,
      routeReason,
      turns,
      runId,
      provider,
      ...(deps.model ? { model: deps.model } : {}),
      derivation: now.advance,
      observation: observationOf(now, turns, executed),
      executed,
      presented: channel.presented,
      metrics: { providerCalls: turns, writes },
    };
  };

  /* ── config first: an out-of-range bound is refused, never clamped ───────── */
  const maxTurns = deps.maxTurns ?? DRIVER_MAX_TURNS;
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > DRIVER_MAX_TURNS_CEILING) {
    return base('invalid-config', `maxTurns must be an integer in 1…${DRIVER_MAX_TURNS_CEILING} (got ${String(deps.maxTurns)}) — refused, never silently clamped`);
  }

  /* ── turn 0: the FRESH derivation (never a plan carried in from anywhere) ── */
  const first = derive(commands);
  let resumed: DriverResult['resumed'];
  if (deps.resume) {
    const matched = deps.resume.action === first.advance.action && deps.resume.detail === first.advance.detail;
    resumed = {
      checkpoint: deps.resume,
      matched,
      note: matched
        ? 'the checkpoint still matches the derivation — the run continues from the FRESH read (no turn or call is ever replayed)'
        : `the checkpoint no longer matches: it recorded '${deps.resume.action} — ${deps.resume.detail}', the journey derives '${first.advance.action} — ${first.advance.detail}' — the run RE-DERIVED from the logs and replayed nothing`,
    };
  }

  /* ── the AUTHORED-WORK BOUNDARY (AC-3) — deterministic, and a stop in every arm ── */
  if (first.advance.action !== 'continue-leg') {
    if (first.advance.action === 'none') {
      const goal = okGoal(commands);
      await channel.present(consultCard(observationOf(first, 0, []), goal));
      return {
        ...base('boundary-none', `the derivation is 'none' — the goal consult is presented and the loop stops (design Q3: goal! met · archive · a new leg are HUMAN moves; the driver drafts nothing here and writes nothing)`),
        ...(goal ? { consult: goal } : {}),
        ...(resumed ? { resumed } : {}),
      };
    }
    // advance-leg (an empty front leg) · closure-needed — DRAFT for the human's approval
    const boundary = first.advance.action;
    turns = 1;
    const draftStarted = Date.now();
    let raw: string;
    try {
      raw = await deps.llm.complete({ prompt: draftPrompt(deps.root, commands, observationOf(first, 0, []), boundary), system: DRIVER_SYSTEM, ...(deps.model ? { model: deps.model } : {}) });
    } catch (e) {
      log?.line({
        event: 'turn',
        turn: turns,
        command: 'draft',
        outcome: 'provider-failure',
        level: 'error',
        durationMs: Date.now() - draftStarted,
        inputs: { boundary },
        error: { code: 'provider-failure', message: (e as Error).message },
      });
      return { ...base('provider-failure', `provider failure on the boundary draft: ${(e as Error).message} — the run stopped with ZERO writes (no fabricated contract, no advance)`), ...(resumed ? { resumed } : {}) };
    }
    const drafted = buildDraft(raw, { root: deps.root, commands, leg: first.advance.leg, boundary, runId, provider, model: deps.model, turn: turns });
    // THE BOUNDARY TURN — the draft attempt and its verdict (a draft that fails the
    // contract check is never offered for approval: nothing is written).
    log?.line({
      event: 'turn',
      turn: turns,
      command: 'draft',
      outcome: drafted.ok ? 'drafted' : 'draft-invalid',
      level: drafted.ok ? 'info' : 'warn',
      durationMs: Date.now() - draftStarted,
      inputs: { boundary, ...(drafted.ok ? { draft: drafted.draft.id } : {}) },
      ...(drafted.ok ? {} : { error: { code: 'draft-invalid', message: drafted.problems.join('; ') } }),
    });
    if (!drafted.ok) {
      return { ...base('draft-invalid', `the boundary draft was REFUSED: ${drafted.problems.join('; ')} — nothing is offered for approval and nothing was written`), ...(resumed ? { resumed } : {}) };
    }
    await channel.present(draftCard(drafted.draft));
    return {
      ...base('boundary-drafted', `the authored-work boundary ('${boundary}'): a GENERATED ${drafted.draft.kind} draft is ready for the human — approve the BYTES, then run '${drafted.draft.approve.act}' and '${drafted.draft.approve.then}'; the driver writes nothing (spawn! stays a human/push act)`),
      draft: drafted.draft,
      ...(resumed ? { resumed } : {}),
    };
  }

  /* ── THE LOOP (Mode A: validated calls execute; nothing else does) ────────── */
  for (;;) {
    if (turns >= maxTurns) {
      return {
        ...base('turn-bound', `the turn bound (${maxTurns}) is reached — the loop stops with the journey where it stands (every executed call was a complete command; nothing is half-written)`),
        ...(resumed ? { resumed } : {}),
      };
    }
    turns++;
    const obs = observationOf(derive(commands), turns, executed);
    const turnStarted = Date.now();

    let text: string;
    try {
      text = await deps.llm.complete({ prompt: loopPrompt(obs, maxTurns), system: DRIVER_SYSTEM, ...(deps.model ? { model: deps.model } : {}) });
    } catch (e) {
      log?.line({
        event: 'turn',
        turn: turns,
        outcome: 'provider-failure',
        level: 'error',
        durationMs: Date.now() - turnStarted,
        error: { code: 'provider-failure', message: (e as Error).message },
      });
      return { ...base('provider-failure', `provider failure: ${(e as Error).message} — the run stopped with ZERO writes (no fabricated call, no advance)`), ...(resumed ? { resumed } : {}) };
    }

    const valid = validateProposal(text, { commands, advance: obs.advance });
    if (!valid.ok) {
      // THE CODE VERDICT — REFUSED, by name (unknown-call · forbidden-call · bad-args ·
      // unparseable): recorded with the code and the reason, never clamped.
      log?.line({
        event: 'turn',
        turn: turns,
        outcome: `refused:${valid.refusal.code}`,
        level: 'warn',
        ...(valid.refusal.call ? { command: valid.refusal.call } : {}),
        durationMs: Date.now() - turnStarted,
        inputs: { proposal: unquote(text) },
        error: { code: valid.refusal.code, message: valid.refusal.reason },
      });
      return {
        ...base('refused-proposal', `REFUSED the proposal${valid.refusal.call ? ` '${valid.refusal.call}'` : ''} (${valid.refusal.code}): ${valid.refusal.reason}`),
        refusal: valid.refusal,
        ...(resumed ? { resumed } : {}),
      };
    }
    if (valid.proposal.kind === 'stop') {
      log?.line({
        event: 'turn',
        turn: turns,
        outcome: 'model-stop',
        durationMs: Date.now() - turnStarted,
        inputs: { reason: valid.proposal.reason },
      });
      return { ...base('model-stop', `the model stopped the loop: ${valid.proposal.reason}`), ...(resumed ? { resumed } : {}) };
    }

    const call = valid.proposal;
    const outcome = call.call === 'run!'
      ? await execRun(deps, channel, call.args.id ?? obs.frontmost?.task, turns, log)
      : execReadOrPresent(commands, deps.recordedBy, call, turns);
    executed.push(outcome.executed);
    writes.push(...outcome.executed.wrote);
    // THE TURN LINE — the proposal, the CODE verdict (accepted → executed / refused by
    // the command layer) and what it wrote, in one line.
    log?.line({
      event: 'turn',
      turn: turns,
      command: call.call,
      ...(outcome.executed.args.id ? { taskId: outcome.executed.args.id } : {}),
      outcome: outcome.kind === 'refused' ? 'call-refused' : outcome.kind === 'landed' ? 'landed' : 'executed',
      level: outcome.kind === 'refused' ? 'warn' : 'info',
      durationMs: Date.now() - turnStarted,
      inputs: { args: call.args, reason: call.reason, output: outcome.executed.output },
      ...(outcome.kind === 'refused' ? { error: { code: call.call, message: outcome.reason } } : {}),
    });
    if (outcome.kind === 'refused') {
      return {
        ...base('call-refused', `the call '${call.call}' was refused by the command layer: ${outcome.reason}`),
        ...(resumed ? { resumed } : {}),
      };
    }
    if (outcome.kind === 'landed') {
      return {
        ...base('human-gate', `landed at the next human decision — ${outcome.reason}`),
        landing: outcome.landing,
        checkpoint: checkpointOf(derive(commands), outcome.landing),
        ...(resumed ? { resumed } : {}),
      };
    }
    // a read (or a completed run) — the next turn re-derives and asks again
  }
}

/* ── executing a validated call ───────────────────────────────────────────── */
type CallOutcome =
  | { kind: 'continued'; executed: DriverExecuted }
  | { kind: 'landed'; executed: DriverExecuted; landing: DriverLanding; reason: string }
  | { kind: 'refused'; executed: DriverExecuted; reason: string };

/** The reads, and the present act (`submit!`) — the writes that do not run the frame. */
function execReadOrPresent(commands: Commands, recordedBy: string, call: DriverProposedCall, turn: number): CallOutcome {
  const record = (output: unknown): DriverExecuted => ({ turn, call: call.call, args: call.args, output, wrote: [] });
  switch (call.call) {
    case 'next':
      return { kind: 'continued', executed: record(commands.advance()) };
    case 'goal': {
      const g = okGoal(commands);
      return { kind: 'continued', executed: record(g ?? { present: false, note: 'the goal read refused' }) };
    }
    case 'gates':
      return { kind: 'continued', executed: record(commands.lookBack()) };
    case 'check':
      return { kind: 'continued', executed: record(commands.check()) };
    case 'verify':
      return { kind: 'continued', executed: record(commands.verify()) };
    case 'detail':
      return { kind: 'continued', executed: record(commands.detail(call.args.id)) };
    case 'submit!': {
      // THE PRESENT ACT: open the gate and land there. The driver's own write, so it
      // carries the driver's provenance (RECORDED_BY + the run) in the event's note.
      const note = `submitted for the ${call.args.gate} gate at the semantic driver's request (RECORDED_BY=${recordedBy})`;
      const r = commands.submit(call.args.id, call.args.gate, { note });
      const executed: DriverExecuted = { turn, call: call.call, args: call.args, output: r.ok ? r.value : r.error, wrote: r.ok ? [`${call.args.id}: submitted@${call.args.gate}`] : [] };
      if (!r.ok) return { kind: 'refused', executed, reason: `${r.error.code}: ${r.error.blocker}` };
      return {
        kind: 'landed',
        executed,
        landing: { where: 'gate', task: call.args.id, gate: call.args.gate },
        reason: `'submit!' opened the ${call.args.gate} gate on ${call.args.id} — the decision is the human's (ann gate! / the UI)`,
      };
    }
    default:
      // unreachable: validateProposal admitted only the closed set
      return { kind: 'refused', executed: record({ error: `'${call.call}' has no executor` }), reason: `'${call.call}' has no executor (closed-set drift)` };
  }
}

/**
 * `run!` — the frame, with the driver's present-only channel. THE PRE-FLIGHT: a task whose
 * ENTRY gate is not yet decided cannot be run by a machine (the frame would have to ask
 * for a decision), so the driver PRESENTS — it submits the gate (when nothing is submitted
 * yet) and lands there. A run that still reaches a live gate decision lands the same way:
 * the channel's refusal is caught, and the journey is left exactly as the frame wrote it.
 */
async function execRun(deps: DriverDeps, channel: PresentOnlyInteract, taskId: string | undefined, turn: number, log?: OpLog): Promise<CallOutcome> {
  const commands = deps.commands;
  if (!taskId) {
    return { kind: 'refused', executed: { turn, call: 'run!', args: {}, output: null, wrote: [] }, reason: 'no frontmost-ready task to run' };
  }
  const args = { id: taskId };
  const before = commands.events(taskId).length;
  const wroteNow = (): string[] => commands.events(taskId).slice(before).map((e) => `${taskId}: ${e.type}${typeof e.gate === 'string' ? `@${e.gate}` : ''}`);

  const grill = commands.gateState(taskId, 'grill');
  if (grill !== 'confirmed') {
    if (grill === 'submitted' || grill === 'rejected') {
      return {
        kind: 'landed',
        executed: { turn, call: 'run!', args, output: { preflight: `the grill gate is '${grill}'` }, wrote: [] },
        landing: { where: 'gate', task: taskId, gate: 'grill' },
        reason: `'run!' did not run ${taskId}: its grill gate is '${grill}' — an undecided/rejected entry gate is the human's next decision (nothing was written)`,
      };
    }
    // nothing submitted yet — PRESENT the gate (the driver's allowed act), then land
    const note = `submitted for the grill gate at the semantic driver's request (RECORDED_BY=${deps.recordedBy})`;
    const s = commands.submit(taskId, 'grill', { note });
    const wrote = s.ok ? wroteNow() : [];
    const executed: DriverExecuted = { turn, call: 'run!', args, output: { preflight: s.ok ? s.value : s.error }, wrote };
    if (!s.ok) return { kind: 'refused', executed, reason: `${s.error.code}: ${s.error.blocker}` };
    return {
      kind: 'landed',
      executed,
      landing: { where: 'gate', task: taskId, gate: 'grill' },
      reason: `'run!' PRESENTED ${taskId}'s entry gate (submit! — the driver never decides it) and landed there`,
    };
  }

  try {
    const frame = new Frame({ commands, root: deps.root, registry: deps.registry, abilities: { llm: deps.llm, interact: channel }, ...(log ? { log: log.child({ taskId }) } : {}) });
    const r = await frame.run(taskId);
    const wrote = wroteNow();
    const executed: DriverExecuted = { turn, call: 'run!', args, output: { stop: r.stop, phase: r.phase, problems: r.problems, advance: r.advance }, wrote };
    if (r.stop === 'completed') {
      return { kind: 'continued', executed };
    }
    if (r.stop === 'blocked-at-gate') {
      return {
        kind: 'landed',
        executed,
        landing: { where: 'gate', task: taskId, gate: commands.gateState(taskId, 'grill') === 'submitted' ? 'grill' : 'confirm', frameStop: r.stop },
        reason: `'run!' stopped at an undecided gate on ${taskId} — the human decides it (the run wrote only its own lifecycle events)`,
      };
    }
    if (r.stop === 'blocked-waiting') {
      return {
        kind: 'landed',
        executed,
        landing: { where: 'awaiting-runner', task: taskId, gate: 'confirm', frameStop: r.stop },
        reason: `'run!' stopped awaiting the runner on ${taskId}: the runner's evidence commit precedes the task's confirm gate (a human gate)`,
      };
    }
    return { kind: 'refused', executed, reason: `the frame stopped '${r.stop}' (${r.phase}): ${r.problems.join('; ') || 'no problems reported'}` };
  } catch (e) {
    if (e instanceof DriverGateRefused) {
      return {
        kind: 'landed',
        executed: { turn, call: 'run!', args, output: { gateRefused: e.question }, wrote: wroteNow() },
        landing: { where: 'gate', task: taskId, gate: commands.gateState(taskId, 'grill') === 'confirmed' ? 'confirm' : 'grill' },
        reason: `'run!' reached a live gate decision on ${taskId} — the driver refused to answer it ('${e.question}') and landed there`,
      };
    }
    return { kind: 'refused', executed: { turn, call: 'run!', args, output: { error: (e as Error).message }, wrote: wroteNow() }, reason: `the frame crashed: ${(e as Error).message}` };
  }
}

/* ── the boundary draft (AC-3) ────────────────────────────────────────────── */

interface DraftOutcome {
  ok: boolean;
  problems: string[];
  draft: DriverDraft;
}

/** Validate the drafted contract against the SAME rules `spawn!` enforces (the field set
 *  is the exported CONTRACT_FIELDS; the checklist is the store's own) plus the v15 task-id
 *  grammar and the leg's next free prefix. A draft that fails is NEVER offered. */
function buildDraft(
  text: string,
  ctx: { root: string; commands: Commands; leg: string; boundary: 'advance-leg' | 'closure-needed'; runId: string; provider: string; model?: string; turn: number },
): DraftOutcome {
  const problems: string[] = [];
  const leg = ctx.leg;
  const kind: DriverDraft['kind'] = ctx.boundary === 'closure-needed' ? 'closure' : 'task';
  const empty: DriverDraft = {
    label: 'GENERATED',
    provenance: { model: ctx.model ?? 'default', provider: ctx.provider, turn: ctx.turn, runId: ctx.runId, at: new Date().toISOString() },
    kind,
    id: '',
    contract: {},
    groundedOn: [],
    rationale: '',
    validated: { fields: [], problems: [] },
    approve: { act: 'spawn!', id: '', contract: {}, then: '' },
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(unquote(text));
  } catch {
    return { ok: false, problems: ['the draft turn returned unparseable output (strict JSON only)'], draft: empty };
  }
  const o = (parsed ?? {}) as Record<string, unknown>;
  const contract: Record<string, unknown> = {};
  for (const f of CONTRACT_FIELDS) if (o[f] !== undefined) contract[f] = o[f];
  const unknown = Object.keys(o).filter((k) => !(CONTRACT_FIELDS as readonly string[]).includes(k) && !['id', 'rationale'].includes(k));
  if (unknown.length) problems.push(`unknown draft field(s): ${unknown.join(', ')} — the contract field set is ${CONTRACT_FIELDS.join(' · ')}`);

  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const segs = id.split('/');
  const last = segs[segs.length - 1] ?? '';
  const next = nextPrefix(ctx.commands, leg);
  if (!id) problems.push('no id — the draft must name the node to spawn');
  else if (segs.length !== 2 || segs[0] !== leg) problems.push(`the id must be '<leg>/<NN>-<worktype>-<slug>' under ${leg} (got '${id}')`);
  else if (!/^\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/.test(last)) problems.push(`the last segment '${last}' must be NN-kebab-case (v15 §16 task-id grammar)`);
  else if (last.length > 40) problems.push(`the segment '${last}' exceeds 40 chars`);
  else if (!last.startsWith(`${next}-`)) problems.push(`the next free prefix in ${leg} is ${next} — the drafted id starts with '${last.slice(0, 2)}'`);
  else if (ctx.commands.ids().includes(id)) problems.push(`${id} already exists`);
  if (kind === 'closure' && !last.includes('-closure-') && !last.endsWith('-closure')) {
    problems.push(`a closure draft's id must name the closure worktype (v15 §16: <NN>-closure-<slug>) — got '${last}'`);
  }
  problems.push(...ctx.commands.store.contractProblems(contract));
  const workTypes = Object.keys(loadProjectFlow(ctx.root)?.chains ?? {});
  if (contract.workType === undefined) problems.push('no workType — the chain is selected by contract.workType (an absent one is a named problem)');
  else if (workTypes.length && !workTypes.includes(String(contract.workType))) problems.push(`unknown workType '${String(contract.workType)}' (project chains: ${workTypes.join(', ')})`);

  const draft: DriverDraft = {
    ...empty,
    id,
    contract,
    groundedOn: groundingLabels(ctx.root, ctx.commands, leg),
    rationale: typeof o.rationale === 'string' ? o.rationale.trim() : '',
    validated: { fields: Object.keys(contract), problems },
    approve: { act: 'spawn!', id, contract, then: `submit! ${id} grill` },
  };
  return { ok: problems.length === 0, problems, draft };
}

/** The next free NN prefix in a leg (the v15 §16 grammar: the id's first segment). */
function nextPrefix(commands: Commands, leg: string): string {
  let max = 0;
  for (const t of commands.store.tasksOf(leg)) {
    const n = Number(t.split('/').pop()!.split('-')[0]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1).padStart(2, '0');
}

/** What a draft is grounded on — the epic (the leg's contract), the goal (the generated
 *  contract + the goal doc), and the upstream artifacts (the leg's tasks + the docs
 *  registry). Labels only: the CONTENT goes in the prompt. */
function groundingLabels(root: string, commands: Commands, leg: string): string[] {
  const out = [`epic:${leg}`];
  const g = okGoal(commands);
  if (g?.contract) out.push('goal:contract');
  if (g?.goalDoc) out.push(`goal:doc(${g.goalDoc.path})`);
  for (const t of commands.store.tasksOf(leg)) out.push(`leg-task:${t}(${commands.status(t)})`);
  for (const name of Object.keys(loadDocsManifest(root))) out.push(`doc:${name}`);
  return out;
}

/* ── the prompts ──────────────────────────────────────────────────────────── */

export const DRIVER_SYSTEM =
  'You are the SEMANTIC DRIVER of a journey-of-legs engine (ann). You read the DERIVED state of a journey and propose exactly ONE next call ' +
  'from a CLOSED SET, or STOP. You PROPOSE; CODE validates the proposal against the closed set before anything runs — a call outside it is ' +
  'refused BY NAME and the run stops. You never answer a gate, never close a task, never write a claim of fact, never author content. ' +
  'Reply with ONE strict-JSON object and nothing else (no prose, no code fences).';

/** The loop turn prompt — the derived state, the closed set, the never list, the shape. */
function loopPrompt(obs: DriverObservation, maxTurns: number): string {
  const lines: string[] = [];
  lines.push(`ANN SEMANTIC DRIVER — turn ${obs.turn} of at most ${maxTurns}`);
  lines.push('');
  lines.push('WHAT THE JOURNEY DERIVES NOW (a FRESH read this turn — nothing is replayed from an earlier turn):');
  lines.push(JSON.stringify(obs, null, 2));
  lines.push('');
  lines.push('THE CLOSED SET — the ONLY calls you may propose (case-sensitive, the ! included):');
  for (const c of DRIVER_CALLS) {
    const args = c.args.length ? ` args: {${c.args.map((a) => `${a}: string${(c.optional ?? []).includes(a) ? ' (optional)' : ''}`).join(', ')}}` : ' args: {}';
    lines.push(`- ${c.name} [${c.kind}]${args} — ${c.description}`);
  }
  lines.push('');
  lines.push('YOU MAY NOT (each is refused by name and the run stops): ' + DRIVER_NEVER.map((n) => `${n.name} (${n.why})`).join(' · '));
  lines.push('Answer shape — one of exactly these two, strict JSON:');
  lines.push('  {"call": "<name from the closed set>", "args": {…}, "reason": "<one line: why this call, now>"}');
  lines.push('  {"stop": "<one line: what the journey waits for>", "reason": "<why you are not calling anything>"}');
  lines.push('');
  lines.push('Prefer the SMALLEST next step that moves the journey: a read when you lack a fact, one write when the derivation supports it, and STOP when the next move belongs to a human (a gate decision, a result to review, the runner\'s evidence commit) or when there is nothing left to do. Do not invent calls, do not batch calls, do not ask questions — propose or stop.');
  return lines.join('\n');
}

/** The authored-work boundary prompt — the drafted contract, grounded and constrained. */
function draftPrompt(root: string, commands: Commands, obs: DriverObservation, boundary: 'advance-leg' | 'closure-needed'): string {
  const leg = obs.advance.leg;
  const epic = commands.contractOf(leg) ?? {};
  const goal = okGoal(commands);
  const goalDoc = commands.read('goal');
  const docs = Object.keys(loadDocsManifest(root));
  const workTypes = Object.keys(loadProjectFlow(root)?.chains ?? {});
  const lines: string[] = [];
  lines.push(`ANN SEMANTIC DRIVER — THE AUTHORED-WORK BOUNDARY (${boundary})`);
  lines.push('');
  lines.push(`${obs.advance.detail}`);
  lines.push(
    boundary === 'advance-leg'
      ? `The front leg ${leg} is EMPTY (its epic gate is MET and no task carries its work). DRAFT the next TASK contract for it.`
      : `The leg ${leg} cannot continue. DRAFT the CLOSURE task contract that closes it (flow-control v6 §5: a closure task transfers or defers the remaining scope — the driver authors the CONTRACT only; the closure itself is a gated human decision).`,
  );
  lines.push('You DRAFT: a human approves the BYTES and runs `spawn!`. You never spawn, submit, decide or close anything.');
  lines.push('');
  lines.push('GROUNDING — the epic (the leg\'s contract):');
  lines.push(JSON.stringify(epic, null, 2));
  lines.push(`THE GOAL: verdict=${goal?.verdict ?? 'unknown'}${goal?.contract ? ` intent=${JSON.stringify(goal.contract.intent)}` : ''}`);
  if (goal?.contract?.acceptanceCriteria) lines.push(`GOAL ACs: ${goal.contract.acceptanceCriteria.join(' · ')}`);
  if (goalDoc.ok) lines.push(`goal.md (${goalDoc.value.path}):\n${goalDoc.value.content.slice(0, 4000)}`);
  const tasks = commands.store.tasksOf(leg).map((t) => `${t}(${commands.status(t)})`);
  lines.push(`THIS LEG'S TASKS: ${tasks.join(' · ') || '(none)'}`);
  lines.push(`UPSTREAM DOCS (docs manifest): ${docs.join(' · ') || '(none)'}`);
  lines.push('');
  lines.push(`TASK-ID GRAMMAR (journey-format v15 §16): <leg>/<NN>-<worktype>-<slug>, one cohesive deliverable per task, rework is a sibling (never an edit). The next free NN in ${leg} is ${nextPrefix(commands, leg)}. workTypes available here: ${workTypes.join(' · ') || '(none)'}`);
  lines.push('Reply with ONE strict-JSON object: {"id": "<leg>/<NN>-<worktype>-<slug>", "workType": "<one of the available workTypes>", "intent": "<what the task does>", "acceptanceCriteria": ["…"], "targetAreas": ["…"], "rationale": "<why this task, grounded on the epic and the goal>"}');
  lines.push(`An ${boundary === 'closure-needed' ? 'closure' : 'implementation | specification'} draft is validated against the SAME contract checklist spawn! enforces — a draft that fails is never offered.`);
  return lines.join('\n');
}

function consultCard(obs: DriverObservation, goal: GoalView | undefined): string {
  return [
    `GOAL CONSULT — the journey derives 'none' (${obs.advance.detail})`,
    goal ? `  goal: ${goal.goalId ?? '(none)'} · structural: ${goal.structural.detail} · verdict: ${goal.verdict}` : '  goal: (absent)',
    '  the session-end moves are HUMAN moves: (1) goal! met · (2) a new work leg (spawn! + a task) · (3) goal! archive & a new goal.',
    '  the driver drafts nothing here and writes nothing (design Q3).',
  ].join('\n');
}

function draftCard(draft: DriverDraft): string {
  return [
    `AUTHORED-WORK DRAFT — ${draft.label} (model ${draft.provenance.model} · provider ${draft.provenance.provider} · turn ${draft.provenance.turn} · run ${draft.provenance.runId})`,
    `  kind: ${draft.kind} · id: ${draft.id}`,
    `  grounded on: ${draft.groundedOn.join(' · ')}`,
    `  contract: ${JSON.stringify(draft.contract)}`,
    draft.rationale ? `  rationale: ${draft.rationale}` : '  rationale: (none)',
    `  APPROVE THE BYTES, then: ann ${draft.approve.act} ${draft.approve.id} '<contract json>' && ann ${draft.approve.then}`,
  ].join('\n');
}

/* ── the derived reads (the observation) ──────────────────────────────────── */

function derive(commands: Commands): { advance: AdvanceView; lookBack: ReturnType<Commands['lookBack']>; goal?: GoalView } {
  const advance = commands.advance();
  return { advance, lookBack: commands.lookBack(), ...(okGoal(commands) ? { goal: okGoal(commands) } : {}) };
}

const lookBackOf = (commands: Commands): ReturnType<Commands['lookBack']> => commands.lookBack();

/** The read view's bound, applied to the OBSERVATION: a node with a long history must not
 *  blow the prompt up (the run record keeps the full output — `executed`). */
const OBSERVATION_CHARS = 6_000;
function boundedOutput(o: unknown): unknown {
  try {
    const s = JSON.stringify(o);
    if (s && s.length > OBSERVATION_CHARS) return `${s.slice(0, OBSERVATION_CHARS)}…[truncated — the full output is in the run record]`;
  } catch {
    return '(unserializable output — the run record holds it)';
  }
  return o;
}

function observationOf(derived: ReturnType<typeof derive>, turn: number, executed: DriverExecuted[]): DriverObservation {
  const { advance, lookBack, goal } = derived;
  return {
    turn,
    advance,
    ...(lookBack.frontmostReady ? { frontmost: lookBack.frontmostReady } : {}),
    alsoReady: lookBack.alsoReady,
    legGate: lookBack.legGate,
    pendingGates: lookBack.pendingGates,
    deferred: lookBack.deferred,
    goal: goal
      ? { present: goal.present, ...(goal.goalId ? { goalId: goal.goalId } : {}), verdict: goal.verdict, structural: goal.structural.detail }
      : { present: false, verdict: 'open', structural: 'no goal read' },
    outputs: executed.map((e) => ({ call: e.call, output: boundedOutput(e.output) })),
  };
}

function checkpointOf(derived: ReturnType<typeof derive>, landing?: DriverLanding): DriverCheckpoint {
  return {
    at: new Date().toISOString(),
    action: derived.advance.action,
    detail: derived.advance.detail,
    ...(landing ? { task: landing.task, ...(landing.gate ? { gate: landing.gate } : {}) } : {}),
  };
}

/** The goal read, narrowed — the consult never fails (reads only). */
function okGoal(commands: Commands): GoalView | undefined {
  const g = commands.goal();
  return g.ok ? g.value : undefined;
}
