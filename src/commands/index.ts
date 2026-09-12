import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { Store, JourneyEvent, NodeDir, ResultItem, TaskDetail, CLOSED_TASK_STATUSES } from '../store/store.js';
import { blobSha, stripMarkers } from '../store/sha.js';
import { getVOCAB } from '../store/vocab.js';

/** A producer artifact's LOGICAL NAME from its file — the stem (last extension
 *  stripped): the thin model names an artifact by the file that carries it
 *  (goal.md → goal). Retired surface (D3) — this survives only for lock(). */
const artifactNameOf = (file: string): string => file.replace(/\.[^./]*$/, '');

/**
 * L1 — THE COMMAND SURFACE (core-design §1): the store's interface, and the ONLY
 * path to the store. Everything above (the flow, the validators, the adapters, the
 * CLI binding) reads and writes through here; nothing above ever touches L0.
 *
 * READS are derived views (status · packet · flow · results · look-back · specs ·
 * check · read). WRITES are the mutators — `spawn!` · `submit!` · `gate!` ·
 * `append!` — COMPLETE over the event vocabulary (docs-as-git retired the
 * artifact surface). The composite mutators ENCODE THE INVARIANTS the design
 * assigns to L1:
 *
 *   spawn!      the v14 node.json contract schema + F-AC19 + id naming + the
 *               commit-evidence conclusion gate + the leg gate  (from the CLI)
 *   gate!       the reject bound (3/gate, a CONSTANT) + the two-write sequence
 *   submit!     the other half of that sequence + the gate② content binding
 *   evidence!   the CONCLUSION record (F-AC18): commits[] non-empty, the shape stays
 *               the store's — a validated front, never a second validator
 *   complete!   the DONE terminal: refused without a confirm-gate ACCEPT + commit
 *               evidence (leg 08 task 02: gates decide, commands complete)
 *   append!     refuses the composite-owned kinds, `created`, and the RETIRED
 *               doc-artifact vocab (artifact-locked / superseded — D3)
 *
 * DOCS ARE GIT CONTENT (the refactor): a task's deliverable is a doc STAGED to
 * <root>/docs/ and COMMITTED by the operator; conclusion is `completed` +
 * evidence.commits[]. The goal doc is docs/goal.md too — `goal! seed` writes it
 * there and regenerates the manifest (no goal-root artifact-lock). The doc-artifact
 * machinery is RETIRED from new writes; `lock` and `current()`/superseded reads
 * survive only as LEGACY surface for archived/historical nodes. Nothing forward
 * routes through a lock.
 *
 * MULTI-CLIENT = multiple IN-PROCESS initiators (the flow, the validators, the
 * adapters). The CLI is a BINDING, not an initiator.
 *
 * THE TWO-TIER WRITING MODEL (leg 08 task 02): a dedicated COMMAND exists where a write
 * is a GATE or STRUCTURE transition (spawn! · submit! · gate! · goal! · complete!) or a
 * COMMON GESTURE (evidence! — every task concludes by citing its commit); everything
 * else stays a shaped fact on `append!` (activated · waiting · extended · evidence with
 * refs/answers/trace · transferred · deferred · cancelled · …). A command is never a
 * second VALIDATOR: it adds the gesture's precondition and delegates the event's shape
 * to the single writer.
 *
 * Failure is a VALUE in the locked shape `{ok:false, error:{code, blocker}}` —
 * never an exception-as-flow (core-design §7).
 */

export interface CommandError {
  code: string;
  blocker: string;
}

export type CommandResult<T = undefined> = { ok: true; value: T } | { ok: false; error: CommandError };

const ok = <T>(value: T): CommandResult<T> => ({ ok: true, value });
const fail = (code: string, blocker: string): CommandResult<never> => ({ ok: false, error: { code, blocker } });

/** The reject bound (core-design §4): a CONSTANT owned by `gate!` — never adjustable,
 *  never bypassable, never moved into the general config. L2 reads `{escalated}` only. */
const REJECT_BOUND = 3;

/** The event kinds a COMPOSITE command owns — `append!` refuses them, so the
 *  invariants those composites encode cannot be bypassed by an append (§8:289). */
const COMPOSITE_OWNED: Record<string, string> = {
  created: 'spawn!',
  submitted: 'submit!',
  confirmed: 'gate!',
  rejected: 'gate!',
  'goal-met': 'goal!', // v6 — the sealed-session verdict is owned by goal! met
};

/** The RETIRED doc-artifact kinds (the docs-as-git refactor, D3) — refused on the
 *  general append: a fresh `artifact-locked`/`superseded` through the write surface
 *  would be a NEW write in a retired model. Artifact-locked still EXISTS in the log
 *  as legacy/history only (the goal doc lives at docs/goal.md — no goal-root lock);
 *  it is simply no longer a general write of any kind. */
const RETIRED_KINDS: Record<string, string> = {
  'artifact-locked':
    'retired with the docs-as-git refactor (D3) — a task deliverable is now a doc staged to docs/ and committed; record evidence.commits[] to conclude (the goal doc is docs/goal.md)',
  superseded: 'retired with the docs-as-git refactor (D3) — a rework re-writes the staged docs/<name>.md; there is no lock to supersede',
};

/** The `goal! seed` FALLBACK guard text (goal-session-design §1 + the RE-SEEDABLE
 *  rule): goal! seed runs on an EMPTY journey (fresh seed) OR on a RE-SEEDABLE goal
 *  (goalSeedGate). This constant is the refusal for the remaining case — a non-empty
 *  journey with no reseedable goal leg. L1 owns it; the driver + the CLI pre-check the
 *  SAME gate (goalSeedGate) so the refusal is dogfoodable (fails before any provider
 *  call) and never drifts from the L1 refusal. */
export const GOAL_SEED_GUARD =
  'this journey already has a goal — goal! archive for a new session (a goal seeds the first leg of an EMPTY journey)';

/** Excerpt bound for the read view (context-packet-spec §4 — never unbounded). */
const READ_CHARS = 200_000;

export interface SpawnedNode {
  id: string;
  kind: 'leg' | 'task';
}

export interface LockedArtifact {
  name: string;
  /** The RECORDED path — the producer's own file, project-relative (thin model, leg 07). */
  path: string;
  /** The content file the ref resolves to — the recorded path itself (ann never copies). */
  contentPath: string;
  sha: string;
}

export interface GateOutcome {
  gate: string;
  decision: 'accept' | 'reject';
  /** L2 reads THIS ONLY — the bound itself stays inside `gate!` (core-design §4). */
  escalated: boolean;
}

/** The STRUCTURED CONCLUSION as the log holds it (format v18) — the ONE derivation the
 *  card renders AND the close enforces, so the two can never disagree. */
export interface ConclusionView {
  /** The latest claim per acceptance criterion (a later claim supersedes an earlier one
   *  for the same AC — the rework model), each lined up with the contract AC it speaks
   *  to. Unclaimed ACs are NOT here: they are reported in `unclaimed`. */
  claims: Array<{ ac: string; statement: string; evidence: string[]; acText: string }>;
  /** Every check the log holds, in order (the verification run history). */
  checks: Array<{ command: string; result: 'pass' | 'fail'; detail?: string; sha?: string; at: string }>;
  /** The contract ACs with NO claim — the reviewer's signal, and `complete!`'s refusal. */
  unclaimed: Array<{ ac: string; acText: string }>;
  /** The commits this task's conclusion cites (evidence.commits[].sha). */
  cited: string[];
}

export interface FrontmostReady {
  leg: string;
  task: string;
  status: string;
}

/** The look-back view (flow-control v6 §2a — the observer action, derived from events). */
export interface LookBack {
  activeLeg?: string;
  activeLegStatus?: string;
  frontmostReady?: FrontmostReady;
  alsoReady: FrontmostReady[];
  legGate: { met: boolean; blocker?: string };
  pendingGates: Array<{ task: string; gate: string }>;
}

/** ONE WAITING GATE, with what a human needs to SEE it (the queue's label): the gate's
 *  ROLE in the step (entry = the contract gate before work, exit = the result gate before
 *  the close), whose step it is (the leg + the contract's own intent), how long it has
 *  waited, and what the log already holds there (the deliverable, as `complete!` reads
 *  it: cited commits · claims · ACs still unclaimed · checks · checks bound to a cited
 *  commit). Structural facts only — each binding words them (the UI says ENTRY/EXIT, the
 *  CLI says grilling (entry)). */
export interface PendingGate {
  task: string;
  gate: string;
  role: 'entry' | 'exit';
  leg: string;
  intent: string;
  since: string;
  delivered: { commits: number; claims: number; unclaimed: number; checks: number; bound: number };
}

/** The advance view (flow-control v6 §2/§5 — the leg gate validated from logs). */
export interface AdvanceView {
  leg: string;
  action: 'continue-leg' | 'advance-leg' | 'closure-needed' | 'none';
  detail: string;
}

export interface ResolvedRead {
  name: string;
  path: string;
  sha: string;
  /** MARKER-STRIPPED content — matching the lock-time hash (core-design §5). */
  content: string;
  provenance: 'derived-from';
}

/** The goal view (goal-session-design §9 — `ann goal`). All status words, no scalar
 *  progress (AC5): `legs` carries statuses only, exhaustion is a WORD, never a count. */
export interface GoalView {
  present: boolean;
  goalId?: string;
  goalStatus?: string;
  /** The authored goal doc — docs/goal.md, resolved through the docs manifest
   *  (present after `goal! seed`; absent across the archive gap). */
  goalDoc?: { name: string; path: string; sha: string };
  /** The GENERATED node contract (intent + ACs derived 1:1 from goal.md). */
  contract?: { intent: string; acceptanceCriteria: string[] };
  structural: { exhausted: boolean; detail: string };
  verdict: 'met' | 'unconfirmed' | 'open';
  metEvent?: JourneyEvent;
  /** RE-SEEDABLE state (goal-session-design §1 + the reseed rule): may goal! seed run
   *  again to REPLACE this goal? YES only while fresh + unconsumed (the sole node, so
   *  nothing spawned under/after it and nothing derived from goal.md); NO — with WHY —
   *  once the goal is consumed by work or sealed (met). Absent when no goal is present. */
  reseed?: { reseedable: boolean; why: string };
  legs: Array<{ id: string; status: string }>;
}

export class Commands {
  constructor(
    readonly store: Store,
    private readonly who = 'agent',
  ) {}

  private get today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Resolve the addressed node's write handle — the id→folder mapping (AC-1). Every
   *  write lands on `node.dir`; the node handle makes an out-of-folder write
   *  unrepresentable (a caller has no path string to hand to a writer). */
  private node(id: string): NodeDir {
    return this.store.resolveNode(id);
  }

  /** Confinement (AC-3/AC-4): the artifacts-relative FILE names lock!/supersede!
   *  accept — a single path segment (the producer file's basename) resolved INSIDE
   *  the node's own artifacts/ dir. Anything else — a separator, `..`, an absolute
   *  path, empty — is refused: a write target outside that folder is unrepresentable.
   *  Returns null (refusal) or the confined full path. */
  private nodeArtifactFile(node: NodeDir, file: string): string | null {
    if (!file || file === '.' || file === '..' || file.includes('/') || file.includes('\\')) return null;
    return join(node.dir, 'artifacts', file);
  }

  /* ══ WRITES — the mutators ══════════════════════════════════════════════════ */

  /**
   * `spawn!` — create a node. THE CONTRACT SCHEMA GATE (core-design §1, §8:289):
   * shape (v14 §2) + F-AC19 (hard reject) + id naming/prefix/sibling + the artifact
   * gate + the leg gate. All of it moved here FROM THE CLI, so every initiator gets
   * the same enforcement. The `description.md` write is RETIRED (v13: a leg dir is
   * `node.json` + `artifacts/`).
   */
  spawn(id: string, contract: unknown): CommandResult<SpawnedNode> {
    // v6 — NO POST-MET SPAWNS (goal-session-design §4): once the goal is sealed with a
    // met verdict, the session is terminal until it archives (a stale verdict is never
    // silently carried forward by more work).
    const metGoal = this.store.goalLegId();
    if (metGoal && this.store.events(metGoal).some((e) => e.type === 'goal-met')) {
      return fail('goal-met', 'the goal is met — this session is sealed; no post-met spawns (goal! archive & start a new goal)');
    }
    const segs = id.split('/');
    const last = segs[segs.length - 1];
    if (segs.includes('00')) {
      return fail('id-naming', 'the 00/ level dir was removed in v8 — tasks live directly under the leg');
    }
    if (!/^\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/.test(last)) {
      return fail('id-naming', `last segment '${last}' must be NN-kebab-case`);
    }
    if (last.length > 40) return fail('id-naming', `segment '${last}' exceeds 40 chars`);
    if (this.store.ids().includes(id)) return fail('exists', `${id} already exists (node.json is immutable — no re-spawn)`);

    if (segs.length > 1) {
      const parent = segs.slice(0, -1).join('/');
      if (!this.store.ids().includes(parent)) return fail('no-parent', `parent ${parent} does not exist`);
      // The CONCLUSION GATE (format v14 §4/§14, docs-as-git): a parent TASK may spawn
      // children only after it has CONCLUDED — structured commit evidence
      // (evidence.commits[]). A leg parent carries no events by design — depth-2
      // spawns are not gated on it (which is what makes deferred `propose-spawn` work).
      if (parent.split('/').length >= 2 && !this.store.parentConcluded(parent)) {
        return fail('conclusion-gate', `parent task ${parent} has no commit evidence (evidence.commits[]) — conclude it (docs are git content; commit the staged doc + record evidence) before spawning children`);
      }
      const sibs = this.store.tasksOf(parent).map((t) => t.split('/').pop()!);
      if (sibs.includes(last)) return fail('sibling-clash', `sibling ${last} already exists`);
      const prefix = last.split('-')[0];
      const clash = sibs.find((s) => s.startsWith(prefix + '-'));
      if (clash) return fail('prefix-clash', `prefix ${prefix} already used by sibling ${clash}`);
    } else {
      const gate = this.store.legGateMet(id);
      if (!gate.met) return fail('leg-gate', gate.blocker ?? 'leg gate unmet');
    }

    const shape = this.contractShapeProblems(contract);
    if (shape.length) return fail('contract-schema', `node.json contract schema (v14 §2):\n  - ${shape.join('\n  - ')}`);

    const c = ((contract as { contract?: unknown })?.contract ?? contract) as Record<string, unknown>;
    const checklist = this.store.contractProblems(c);
    if (checklist.length) {
      return fail('F-AC19', `contract checklist (format v14 §2/§7):\n  - ${checklist.join('\n  - ')}`);
    }

    try {
      this.store.spawn(id, contract, this.who);
    } catch (e) {
      return fail('store-refused', (e as Error).message);
    }
    return ok({ id, kind: segs.length > 1 ? ('task' as const) : ('leg' as const) });
  }

  /**
   * The v14 §2 node.json contract SHAPE: `intent` and a non-empty `acceptanceCriteria`
   * are REQUIRED; the rest of the field set is closed (an unknown field is a typo, and
   * a typo that silently survives is a contract that does not say what it means).
   * `openQuestions` is a TOP-LEVEL SIBLING — accepted in either position, lifted by
   * `store.spawn`, and never counted as an unknown contract field.
   */
  private contractShapeProblems(contract: unknown): string[] {
    const problems: string[] = [];
    const raw = (contract ?? {}) as Record<string, unknown>;
    const c = ((raw.contract ?? raw) ?? {}) as Record<string, unknown>;
    if (typeof c !== 'object' || c === null || Array.isArray(c)) return ['contract must be an object'];
    const KNOWN = ['intent', 'acceptanceCriteria', 'targetAreas', 'requiredInputs', 'expectedOutputs', 'workType', 'flow', 'model', 'openQuestions'];
    for (const k of Object.keys(c)) {
      if (!KNOWN.includes(k)) problems.push(`unknown contract field '${k}' (v14 §2 fields: ${KNOWN.join(' · ')})`);
    }
    if (typeof c.intent !== 'string' || !c.intent.trim()) problems.push('intent is REQUIRED (a non-empty string)');
    const acs = c.acceptanceCriteria;
    if (!Array.isArray(acs) || acs.length === 0 || !acs.every((a) => typeof a === 'string' && a.trim())) {
      problems.push('acceptanceCriteria is REQUIRED (a non-empty array of non-empty strings)');
    }
    for (const k of ['targetAreas', 'requiredInputs', 'expectedOutputs', 'flow']) {
      const v = c[k];
      if (v !== undefined && (!Array.isArray(v) || !v.every((x) => typeof x === 'string' || (k === 'flow' && typeof x === 'object')))) {
        problems.push(`${k} must be an array when present`);
      }
    }
    for (const k of ['workType', 'model']) {
      if (c[k] !== undefined && typeof c[k] !== 'string') problems.push(`${k} must be a string when present`);
    }
    const oq = raw.openQuestions ?? c.openQuestions;
    if (oq !== undefined && !Array.isArray(oq)) problems.push('openQuestions must be an array (a TOP-LEVEL sibling of contract)');
    return problems;
  }

  /**
   * `submit!` — the FIRST of the two gate writes (core-design §4). Writing `submitted`
   * on its own is what makes an interrupted gate genuinely resumable: the task derives
   * `blocked` and waits for a decision instead of looking un-started.
   *
   * At the CONFIRM gate it records `confirmedSha` — the marker-stripped blob sha of the
   * working artifact (v14 §3). Commit compares against it and REFUSES on mismatch, so
   * the bytes a human confirmed are the bytes that land.
   */
  submit(id: string, gate: string, opts: { note?: string; confirmedSha?: string } = {}): CommandResult<{ gate: string; confirmedSha?: string }> {
    if (!getVOCAB().gates.includes(gate)) return fail('unknown-gate', `gate must be one of ${getVOCAB().gates.join('|')}`);
    if (!id.includes('/')) return fail('leg-gate-write', 'leg roots carry no gates — gates live on tasks (flow-control v6 §3)');
    if (!this.store.ids().includes(id)) return fail('no-node', `no node ${id}`);
    if (this.undecidedSubmission(id, gate)) {
      return fail('already-submitted', `${id} already has an UNDECIDED submission at gate '${gate}' — decide it before re-submitting`);
    }
    const event: JourneyEvent = {
      at: this.today,
      type: 'submitted',
      gate,
      note: opts.note ?? `submitted for the ${gate} gate (${this.who})`,
      ...(opts.confirmedSha ? { confirmedSha: opts.confirmedSha } : {}),
    };
    try {
      this.store.appendEvent(this.node(id), event);
    } catch (e) {
      return fail('store-refused', (e as Error).message);
    }
    return ok({ gate, ...(opts.confirmedSha ? { confirmedSha: opts.confirmedSha } : {}) });
  }

  /**
   * `gate!` — the human decision, and the OWNER OF THE REJECT BOUND (3/gate, a
   * constant). Composite convenience: it auto-writes `submitted` when no UNDECIDED
   * submission exists — and the predicate checks for a later `confirmed` **OR
   * `rejected`** (the store's own derivation). The v13 predicate looked only for
   * `confirmed`, so after a rejection it saw the old submission as still pending and
   * skipped the write; a rework then never re-entered `blocked`.
   */
  gate(id: string, gate: string, decision: string, feedback = ''): CommandResult<GateOutcome> {
    if (!getVOCAB().gates.includes(gate)) return fail('unknown-gate', `gate must be one of ${getVOCAB().gates.join('|')}`);
    if (decision !== 'accept' && decision !== 'reject') return fail('bad-decision', "decision must be 'accept' or 'reject'");
    if (!this.store.ids().includes(id)) return fail('no-node', `no node ${id}`);
    if (!id.includes('/')) return fail('leg-gate-write', 'leg roots carry no gates — gates live on tasks (flow-control v6 §3)');

    const rejects = this.rejections(id, gate);
    if (decision === 'reject' && rejects >= REJECT_BOUND) {
      return fail(
        'reject-bound',
        `${REJECT_BOUND} rejection cycles exhausted at gate '${gate}' — escalate to a human design decision (force-approve / restructure / block)`,
      );
    }
    try {
      if (!this.undecidedSubmission(id, gate)) {
        this.store.appendEvent(this.node(id), { at: this.today, type: 'submitted', gate, note: `submitted with the decision (${this.who})` });
      }
      this.store.appendEvent(
        this.node(id),
        decision === 'accept'
          ? { at: this.today, type: 'confirmed', gate, ...(feedback ? { feedback } : {}), note: `accepted (${this.who})` }
          : { at: this.today, type: 'rejected', gate, feedback, note: `rejected (${this.who})` },
      );
    } catch (e) {
      return fail('store-refused', (e as Error).message);
    }
    const after = decision === 'reject' ? rejects + 1 : rejects;
    return ok({ gate, decision, escalated: after >= REJECT_BOUND });
  }

  /**
   * `evidence!` — the CONCLUSION record (F-AC18, docs-as-git; leg 08 task 02 AC-1): a
   * task's deliverable is concluded by STRUCTURED COMMIT EVIDENCE — `evidence.commits[]`
   * naming the committed doc/code that carries it (optional `refs[]` paths).
   *
   * A thin VALIDATED FRONT over the general append, never a second validator and never a
   * new write path: the SHAPE stays the single writer's (`appendEvent` re-validates the
   * event — commits[] non-empty, a sha per entry), and this command adds only the
   * GESTURE's precondition (a conclusion cites at least one commit) plus the initiator's
   * provenance. Every other fact that rides `evidence` (refs-only notes, `answers`,
   * `trace`) stays a shaped fact on `append!` — the two-tier writing model.
   */
  evidence(
    id: string,
    commits: Array<{ sha: string; note?: string }>,
    opts: { refs?: string[]; note?: string; claims?: unknown[]; checks?: unknown[] } = {},
  ): CommandResult<{ commits: number; refs: number; claims: number; checks: number }> {
    if (!id.includes('/')) return fail('leg-gate-write', 'leg roots carry no conclusion — evidence belongs to tasks');
    if (!this.store.ids().includes(id)) return fail('no-node', `no node ${id}`);
    if (!Array.isArray(commits) || !commits.length) {
      return fail(
        'no-commits',
        'evidence! requires at least one commit — a conclusion cites the commit that carries the deliverable (commits[] non-empty, a sha per entry); a task with nothing committed has not concluded',
      );
    }
    const badCommit = commits.findIndex((c) => !c || typeof c.sha !== 'string' || !c.sha.trim());
    if (badCommit >= 0) return fail('bad-commit', `evidence! commits[${badCommit}] needs a sha — every cited commit names the commit that carries the deliverable`);
    const refs = opts.refs ?? [];
    const badRef = refs.findIndex((r) => typeof r !== 'string' || !r.trim());
    if (badRef >= 0) return fail('bad-ref', `evidence! refs[${badRef}] must be a non-blank path`);
    // v18 §3 — the structured conclusion rides the SAME event (one conclusion record):
    // `claims[]` (how each AC is met) and `checks[]` (what was run, against which bytes).
    // Thin front only: the SHAPE is the single writer's (claimShapeProblem/
    // checkShapeProblem in the store), so a malformed claim is refused by name there.
    const claims = opts.claims ?? [];
    const checks = opts.checks ?? [];
    try {
      this.store.appendEvent(this.node(id), {
        at: this.today,
        type: 'evidence',
        note: opts.note?.trim() ? opts.note : `concluded with commit evidence (${this.who})`,
        commits: commits.map((c) => (c.note?.trim() ? { sha: c.sha.trim(), note: c.note } : { sha: c.sha.trim() })),
        ...(refs.length ? { refs } : {}),
        ...(claims.length ? { claims } : {}),
        ...(checks.length ? { checks } : {}),
      });
    } catch (e) {
      return fail('store-refused', (e as Error).message);
    }
    return ok({ commits: commits.length, refs: refs.length, claims: claims.length, checks: checks.length });
  }

  /**
   * `complete!` — the DONE terminal (leg 08 task 02 AC-2, RESOLVED: gates decide,
   * commands complete — `gate! confirm accept` does NOT auto-complete; the rationale is
   * recorded on that task). `completed` therefore always cites a REAL gate decision and
   * REAL committed work: refused unless the confirm gate's LAST decision is an accept and
   * the task carries conclusion evidence (`evidence.commits[]` — the SAME F-AC18
   * predicate the store's spawn gate and check() read). GATE-2 and F-AC18 then hold by
   * construction, and the honest `accepted` status (leg 08 task 01) names the missing
   * gesture instead of hiding it behind an auto-complete.
   */
  complete(id: string, opts: { note?: string } = {}): CommandResult<{ at: string }> {
    if (!id.includes('/')) return fail('leg-gate-write', 'leg roots carry no lifecycle — gates and completion live on tasks (flow-control v6 §3)');
    if (!this.store.ids().includes(id)) return fail('no-node', `no node ${id}`);
    if (this.store.events(id).some((e) => e.type === 'completed')) {
      return fail(
        'already-completed',
        `${id} is already completed — the done terminal is recorded once (rework is a superseding sibling task, never a second completed on this one)`,
      );
    }
    const gateState = this.confirmGateState(id);
    if (gateState !== 'confirmed') {
      return fail(
        'not-accepted',
        `${id}: the confirm-result gate is not accepted (last decision: ${gateState}) — complete! records a delivery the HUMAN accepted: submit! ${id} confirm, then gate! ${id} confirm accept`,
      );
    }
    if (!this.store.parentConcluded(id)) {
      return fail(
        'no-evidence',
        `${id}: no conclusion evidence — F-AC18: a task completes only on structured commit evidence (evidence.commits[]); run evidence! ${id} <sha> with the commit that carries the deliverable`,
      );
    }
    // v18 (the conclusion GATE): a close is a REVIEW — the log must be able to say how
    // every AC is met and what was actually run. The SAME `conclusion()` the card renders
    // decides it here, so "the card shows NO CLAIM RECORDED" and "the close succeeded"
    // cannot both be true for one state.
    const conclusion = this.conclusion(id);
    if (conclusion.unclaimed.length) {
      return fail(
        'no-structured-conclusion',
        `${id}: ${conclusion.unclaimed.length} acceptance criterion(s) carry no claim — ${conclusion.unclaimed.map((u) => `'${u.ac}' (${u.acText})`).join(' · ')}. Record how each is met: ann evidence! ${id} <sha> --claims '[{"ac":"AC-1","statement":"…","evidence":["<sha|path|doc>"]}]'`,
      );
    }
    const passing = conclusion.checks.find((c) => c.result === 'pass' && c.sha && conclusion.cited.includes(c.sha));
    if (!passing) {
      const checks = conclusion.checks.length ? `${conclusion.checks.length} check(s), none PASSING against a cited commit` : 'no checks';
      return fail(
        'no-structured-conclusion',
        `${id}: the conclusion has ${checks} — a close must cite at least one PASSING check bound to the bytes under review (checks[].sha in evidence.commits[] ${conclusion.cited.length ? conclusion.cited.join(', ') : '(none cited)'}). Record it: ann evidence! ${id} <sha> --checks '[{"command":"npm test","result":"pass","sha":"<cited sha>"}]'`,
      );
    }
    try {
      this.store.appendEvent(this.node(id), {
        at: this.today,
        type: 'completed',
        note: opts.note?.trim() ? opts.note : `completed (${this.who})`,
      });
    } catch (e) {
      return fail('store-refused', (e as Error).message);
    }
    return ok({ at: this.today });
  }

  /**
   * `append!` — the general single-writer append, for the kinds no composite owns
   * (the frame's lifecycle writes, evidence, closure, `waiting`, `extended`). It
   * REFUSES the composite-owned kinds, `created`, and the RETIRED doc-artifact
   * vocab (artifact-locked / superseded): those carry invariants — or, for the
   * retired kinds, a retired model — and an append that bypassed them would be a
   * hole in every one of them.
   */
  append(id: string, event: JourneyEvent): CommandResult {
    const retired = RETIRED_KINDS[event?.type];
    if (retired) {
      return fail('retired-kind', `'${event.type}' ${retired}`);
    }
    const owner = COMPOSITE_OWNED[event?.type];
    if (owner) {
      return fail('composite-owned', `'${event.type}' is owned by ${owner} — use it (the composite encodes the invariant; append! would bypass it)`);
    }
    try {
      // leg 08 task 01: `cancelled` is append-style BOOKKEEPING, not a gate decision — any
      // initiator may record it, and the record carries the initiator's provenance
      // (RECORDED_BY) exactly as the composites' own notes do. A caller's own note wins.
      const record = event.type === 'cancelled' && !event.note ? { ...event, note: `cancelled (${this.who})` } : event;
      this.store.appendEvent(this.node(id), record);
    } catch (e) {
      return fail('store-refused', (e as Error).message);
    }
    return ok(undefined);
  }

  /**
   * `lock` — LEGACY ONLY (docs-as-git D3): an artifact-locked record
   * `{name, path, lockSha, type?, version?}` for a node's OWN artifacts/ producer file.
   * The goal doc moved to docs/goal.md and `goal! seed` no longer locks, so this method
   * has NO forward caller — it survives mechanically (its unit tests exercise the
   * retired record→lock model + the legacy current() reader); nothing routes forward
   * through a lock. Caller names the file (a single artifacts-relative segment, AC-3);
   * ann resolves it INSIDE the node's own artifacts/ dir (never a free path), VERIFIES
   * it exists, hashes the raw bytes (marker-tolerant), derives the version from THE LOG,
   * and records the event. It NEVER writes, copies, or stamps the file — the bytes on
   * disk are untouched (AC1).
   */
  lock(id: string, artifactFile: string, opts: { type?: string; note?: string } = {}): CommandResult<LockedArtifact> {
    if (!this.store.ids().includes(id)) return fail('no-node', `no node ${id}`);
    const node = this.store.resolveNode(id);
    const full = this.nodeArtifactFile(node, artifactFile);
    if (!full) {
      return fail('outside-artifacts', `'${artifactFile}' is not a file inside ${id}/artifacts/ — lock! records the node's OWN producer file (write confinement); an out-of-folder write is unrepresentable`);
    }
    if (!existsSync(full)) return fail('no-file', `no file at ${id}/artifacts/${artifactFile} — lock! records a file that exists (the producer's own file)`);
    const name = artifactNameOf(artifactFile);
    const current = this.store.current(name);
    if (current) return fail('already-current', `'${name}' is already current (${current.path}) — supersede it first (one current per name)`);
    const sha = blobSha(stripMarkers(readFileSync(full, 'utf8'))).slice(0, 7);
    const n = this.nextVersion(name);
    const path = relative(this.store.root, full); // .ann/journey/legs/<id>/artifacts/<file> (project-relative record)
    try {
      this.store.appendEvent(node, {
        at: this.today,
        type: 'artifact-locked',
        artifact: { name, path, lockSha: sha, ...(opts.type ? { type: opts.type } : {}), version: n },
        note: opts.note ?? `${artifactFile} locked @ ${sha} (${this.who})`,
      });
    } catch (e) {
      return fail('store-refused', (e as Error).message);
    }
    return ok({ name, path, contentPath: path, sha });
  }

  /**
   * Highest version among THIS name's recorded locks, + 1 — derived from THE LOG, never
   * from filename resolution (the thin model has no docs/ filename to resolve: the log
   * is the only source). Recorded on each lock as `artifact.version`.
   */
  private nextVersion(name: string): number {
    let max = 0;
    for (const id of this.store.ids()) {
      for (const e of this.store.events(id)) {
        if (e.type !== 'artifact-locked' || e.artifact?.name !== name) continue;
        const v = (e.artifact as { version?: unknown } | undefined)?.version;
        if (typeof v === 'number' && v > max) max = v;
      }
    }
    return max + 1;
  }

  /* ══ v6 goal session — `goal` (read) · `goal! met` · `goal! archive` ════════ */

  /** The goal view (goal-session-design §9): present · goalId · goalStatus ·
   *  goalDoc (the LOCKED goal.md) · contract (the generated intent+ACs) · structural
   *  state · verdict. `met` is exhaustion AND a recorded human verdict — structural
   *  alone is never met. */
  goal(): CommandResult<GoalView> {
    const legs = this.legRows();
    const goalId = this.store.goalLegId();
    if (!goalId) {
      return ok({
        present: false,
        structural: {
          exhausted: false,
          detail: legs.length
            ? 'no goal leg — work legs without a seeded goal (a legacy journey): archive & reseed for the goal-session shape'
            : 'no goal — the journey is empty: grill & seed a goal (goal.md + the generated contract)',
        },
        verdict: 'open',
        legs,
      });
    }
    const goalStatus = this.store.status(goalId);
    const raw = this.store.contractOf(goalId) as { intent?: unknown; acceptanceCriteria?: unknown };
    const contract =
      raw && (raw.intent || Array.isArray(raw.acceptanceCriteria))
        ? { intent: String(raw.intent ?? ''), acceptanceCriteria: (raw.acceptanceCriteria ?? []) as string[] }
        : undefined;
    const goalDoc = this.goalDocOf();
    const metEvent = this.store.events(goalId).find((e) => e.type === 'goal-met');
    const undone = legs.filter((l) => !CLOSED_TASK_STATUSES.includes(l.status)).map((l) => l.id);
    const pending = this.pendingGates();
    const exhausted = this.goalExhausted();
    const structural = {
      exhausted,
      detail: exhausted
        ? 'every leg derived done — the session is structurally complete; a HUMAN verdict seals it (goal! met)'
        : `not exhausted — ${undone.length ? `undone: ${undone.join(', ')}` : 'no work spawned yet'}${pending.length ? ` · ${pending.map((p) => `${p.task}@${p.gate}`).join(', ')} undecided` : ''}`,
    };
    const verdict = exhausted && metEvent ? 'met' : exhausted ? 'unconfirmed' : 'open';
    return ok({
      present: true,
      goalId,
      goalStatus,
      ...(goalDoc ? { goalDoc } : {}),
      ...(contract ? { contract } : {}),
      structural,
      verdict,
      reseed: this.reseedableOf(goalId), // the surface why: fresh & unconsumed vs consumed/sealed
      ...(metEvent ? { metEvent } : {}),
      legs,
    });
  }

  /** RE-SEEDABLE (goal-session-design §1 + the reseed rule) — is this goal still safe to
   *  REPLACE by re-running goal! seed? Precise against the store: YES only while freshly
   *  created AND UNCONSUMED — the goal leg is the journey's SOLE node (ids() === [goalId]:
   *  no task children, no leg spawned after it) and it carries no goal-met verdict.
   *  Sole-node IS the no-referrer condition: with the goal as the only node, nothing else
   *  exists to read/derive goal.md, so the doc has no consumer. Spawn the first work leg
   *  (or a spec that derives from goal.md) and the goal is consumed → sealed → the change
   *  path becomes goal! archive → a new goal, never a silent re-seed. */
  reseedableOf(goalId: string): { reseedable: boolean; why: string } {
    const ids = this.store.ids();
    if (this.store.events(goalId).some((e) => e.type === 'goal-met')) {
      return { reseedable: false, why: 'goal sealed (met) — the session is terminal; change the goal via goal! archive → a new goal' };
    }
    if (ids.length === 1 && ids[0] === goalId) {
      return { reseedable: true, why: "fresh & unconsumed — the goal leg is the journey's only node: nothing spawned under or after it, nothing derived from goal.md yet" };
    }
    const consumer = ids.filter((i) => i !== goalId).sort()[0];
    return {
      reseedable: false,
      why: `consumed by ${consumer} — work spawned under/after the goal derives from goal.md; change the goal via goal! archive → a new goal`,
    };
  }

  /** The goal! seed gate — EMPTY journey (fresh seed) OR a RE-SEEDABLE goal (sole,
   *  unconsumed → re-grill + replace). Anything else refuses with the WHY. Shared by the
   *  L1 composite, the flow driver, and the CLI pre-check so the guard never drifts. */
  goalSeedGate(): { allow: boolean; reseed: boolean; goalId?: string; blocker?: string } {
    const ids = this.store.ids();
    if (ids.length === 0) return { allow: true, reseed: false };
    const goalId = this.store.goalLegId();
    if (goalId) {
      const r = this.reseedableOf(goalId);
      if (r.reseedable) return { allow: true, reseed: true, goalId };
      return { allow: false, reseed: false, goalId, blocker: r.why };
    }
    return { allow: false, reseed: false, blocker: GOAL_SEED_GUARD };
  }

  /** `goal! met` — the HUMAN verdict that seals the session. Guarded
   *  (goal-session-design §4): goal present · HUMAN initiator only (an automated
   *  `agent` is refused — the verdict is a human call) · no double-met · no undecided
   *  submission anywhere (a done task can still hide one) · structural exhaustion
   *  reached. Appends `goal-met` to the goal root (status-inert). */
  goalVerdict(decision: 'met', feedback = ''): CommandResult<{ verdict: 'met'; at: string }> {
    if (decision !== 'met') return fail('bad-verdict', "goal! verdict must be 'met'");
    const goalId = this.store.goalLegId();
    if (!goalId) return fail('no-goal', 'no goal leg — seed a goal before recording a verdict');
    if (this.who === 'agent') {
      return fail('human-only', 'goal! met is a HUMAN verdict — refused for an automated (agent) initiator; record it as the human: RECORDED_BY=<your name> ann goal! met');
    }
    if (this.store.events(goalId).some((e) => e.type === 'goal-met')) {
      return fail('already-met', 'the goal is already met — verdicts are immutable per session (a wrong met is recoverable only via the goal! archive --override path)');
    }
    const pending = this.pendingGates();
    if (pending.length) {
      return fail('undecided-submission', `cannot seal the goal while a submission is undecided: ${pending.map((p) => `${p.task}@${p.gate}`).join(', ')} — decide it first`);
    }
    if (!this.goalExhausted()) {
      return fail('not-exhausted', 'the goal is not structurally exhausted — a met verdict records criteria met; finish the work (or archive) first');
    }
    try {
      this.store.appendEvent(this.store.resolveNode(goalId), {
        at: this.today,
        type: 'goal-met',
        decision: 'met',
        ...(feedback ? { feedback } : {}),
        note: `goal met (${this.who})`,
      });
    } catch (e) {
      return fail('store-refused', (e as Error).message);
    }
    return ok({ verdict: 'met', at: this.today });
  }

  /** `goal! archive` — the guarded structural reset (goal-session-design §6). Refuses
   *  unless the session is met (or the journey is empty) or --override; refuses on
   *  store-external drifts (ann never archives a state it does not recognize) and on
   *  uncommitted TRACKED changes under the moving tree (.ann/journey — never untracked
   *  scratch). Content-level check/verify problems (this repo's known 15/4 baseline)
   *  are NOT re-litigated here — they travel into the archive with the session. */
  goalArchive(override = false): CommandResult<{ at: string; dest: string; slug: string }> {
    const goalId = this.store.goalLegId();
    const emptyJourney = this.store.ids().length === 0;
    const met = !!goalId && this.store.events(goalId).some((e) => e.type === 'goal-met');
    if (!override && !emptyJourney && !met) {
      return fail('not-met', 'goal! archive refuses: no met verdict on the session (and the journey is not empty) — record goal! met first, or pass --override for a structural reset');
    }
    if (!override) {
      const external = this.store.verify().filter((d) => d.startsWith('store-external'));
      if (external.length) {
        return fail('verify', `goal! archive refuses: ${external.length} store-external drift(s) — the store changed outside the CLI. Run 'ann verify'; pass --override to force.`);
      }
      const dirty = this.uncommittedJourneyChanges();
      if (dirty.length) {
        return fail('uncommitted', `goal! archive refuses: uncommitted tracked change(s) under .ann/journey (${dirty.map((l) => l.slice(0, 60)).join(' · ')}) — commit first, or pass --override.`);
      }
    }
    const slug = goalId ? this.slugFor(goalId) : 'session';
    try {
      const r = this.store.archiveJourney(slug);
      return ok({ at: r.at, dest: r.dest, slug });
    } catch (e) {
      return fail('store-refused', (e as Error).message);
    }
  }

  /**
   * `goal! seed` — the L1 MATERIALIZE half of the goal seed (the interactive grill
   *  that AUTHORS the doc runs at SESSION scope — flow/goal-seed — on top of this
   *  composite; L1 owns the write + its invariants). Empty journey → seedGoal (a goal
   *  seeds the first leg of a fresh session); a RE-SEEDABLE goal → reseedGoal REPLACES
   *  the sole unconsumed goal in place (re-grill + overwrite the doc + regenerate the
   *  contract/events). Consumed/met → refused (goalSeedGate) — a changed goal is a NEW
   *  session, goal! archive first (goal-session-design §1/§2 + the reseed rule). The
   *  seed writes docs/goal.md (authored truth, git content) + regenerates the manifest,
   *  the generated node contract, and the created/completed seed events — there is NO
   *  goal-root artifact-lock (docs-as-git D7). Both paths parse the doc BEFORE any
   *  write, so a malformed doc is refused with no partial state; the gate runs inside
   *  this composite.
   */
  goalSeed(doc: string): CommandResult<{
    id: string;
    contract: { intent: string; acceptanceCriteria: string[] };
    doc: { name: string; path: string; sha: string };
  }> {
    const gate = this.goalSeedGate();
    if (!gate.allow) return fail('not-empty', gate.blocker ?? GOAL_SEED_GUARD);
    let id: string;
    let contract: { intent: string; acceptanceCriteria: string[] };
    try {
      ({ id, contract } = gate.reseed ? this.store.reseedGoal(doc) : this.store.seedGoal(doc));
    } catch (e) {
      return fail('store-refused', (e as Error).message);
    }
    const docRef = this.goalDocOf();
    if (!docRef) return fail('no-goal-doc', 'goal seeded but docs/goal.md did not resolve — run ann docs --write');
    return ok({ id, contract, doc: docRef });
  }

  /* ══ goal derivations (shared by goal()/goalVerdict()/advance()) ═════════════ */

  /** Every leg's status WORD (AC5 — the goal surface shows statuses, never counts). */
  private legRows(): Array<{ id: string; status: string }> {
    return this.store
      .ids()
      .filter((i) => !i.includes('/'))
      .sort()
      .map((id) => ({ id, status: this.store.status(id) }));
  }

  /** The goal leg's doc — docs/goal.md, resolved through the docs manifest (the
   *  forward doc path; D7). Tolerates its absence (an archived gap: the goal leg can
   *  outlive docs/goal.md between archive and a re-seed) — the caller treats
   *  undefined as "no authored doc right now". */
  private goalDocOf(): { name: string; path: string; sha: string } | undefined {
    const doc = this.store.resolveDoc('goal');
    if (doc) return doc;
    // An ARCHIVED session store ('journey' kind) has no docs/ home — the docs manifest
    // is the live project's index (session-addressing). Resolve the goal doc through the
    // legacy current() reader when the archive locked one. The ACTIVE store never takes
    // this path (resolveDoc serves docs/goal.md there).
    if (this.store.kind === 'journey') {
      const cur = this.store.current('goal');
      if (cur) return { name: cur.name, path: cur.path, sha: cur.sha ?? '' };
    }
    return undefined;
  }

  /** Exhaustion (goal-session-design §5): WORK exists (≥1 task), every leg derives
   *  closed, and no undecided submission hides anywhere. A seeded goal with
   *  no work spawned is NOT exhausted — it is the open state. */
  private goalExhausted(): boolean {
    const undone = this.legRows().filter((l) => !CLOSED_TASK_STATUSES.includes(l.status));
    const hasWork = this.store.ids().some((i) => i.includes('/'));
    return hasWork && undone.length === 0 && this.pendingGates().length === 0;
  }

  /** THE WHOLE-JOURNEY GATE QUEUE (the WAITING ON YOU view): every UNDECIDED submission
   *  across EVERY task that is not CANCELLED/DEFERRED (including done ones — a done task
   *  can still hide a stray submission; the goal verdict must not seal over it).
   *  `lookBack().pendingGates` is the ACTIVE-LEG observer view; THIS read is the whole
   *  journey (the service/UI gate queue), so a gate waiting in a leg that is already
   *  done is surfaced rather than scoped away. Derived on demand from the logs — never
   *  cached, never asserted. Consumers: the goal verdict/exhaustion sweep, the service.
   *
   *  Leg 08 task 01: a cancelled task is closed work — its undecided submission is
   *  exactly what the cancellation was recorded to escape, so the sweep skips it; a
   *  deferred task (the same escape hatch, the work postponed) is skipped the same way. */
  pendingGates(): PendingGate[] {
    const out: PendingGate[] = [];
    for (const id of this.store.ids()) {
      if (!id.includes('/')) continue;
      if (['cancelled', 'deferred'].includes(this.store.status(id))) continue;
      for (const e of this.store.events(id)) {
        if (e.type !== 'submitted' || typeof e.gate !== 'string') continue;
        if (!this.undecidedSubmission(id, e.gate)) continue;
        if (out.some((p) => p.task === id && p.gate === e.gate)) continue;
        const c = this.conclusion(id);
        out.push({
          task: id,
          gate: e.gate,
          role: e.gate === 'grill' ? 'entry' : 'exit',
          leg: id.split('/')[0],
          intent: String(this.store.contractOf(id)?.intent ?? ''),
          since: String(e.at ?? ''),
          delivered: {
            commits: c.cited.length,
            claims: c.claims.length,
            unclaimed: c.unclaimed.length,
            checks: c.checks.length,
            bound: c.checks.filter((k) => k.result === 'pass' && k.sha && c.cited.includes(k.sha)).length,
          },
        });
      }
    }
    return out;
  }

  /** Uncommitted TRACKED changes under the moving tree (.ann/journey) — `??` lines
   *  are untracked scratch and never a refusal basis. Non-git roots read clean (the
   *  guard is about not losing tracked work, not about git being present). */
  private uncommittedJourneyChanges(): string[] {
    try {
      const out = execFileSync('git', ['-C', this.store.root, 'status', '--porcelain', '--', '.ann/journey'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out.split('\n').filter((l) => l && !l.startsWith('??'));
    } catch {
      return [];
    }
  }

  /** The archive slug: the goal.md `Goal:` line, slugified (dir-safe, ≤ 40 chars);
   *  fallback to the goal leg id minus its NN- prefix. */
  private slugFor(goalId: string): string {
    const doc = this.goalDocOf();
    if (doc) {
      try {
        const md = readFileSync(join(this.store.root, doc.path), 'utf8');
        const g = md.match(/^#{0,6}\s*[#*]*\s*Goal\s*[#*]*:\s*(.+)$/m);
        if (g) {
          const s = g[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
          if (s) return s;
        }
      } catch {
        /* unreadable doc → fall through to the id slug */
      }
    }
    return goalId.replace(/^\d+-/, '').replace(/[^a-z0-9-]/g, '') || 'goal';
  }

  /* ══ READS — the derived views ══════════════════════════════════════════════ */

  /**
   * `read` — THE CONTENT READ VIEW (core-design §5): an L1 derived read serving
   * MARKER-STRIPPED content so what a caller reads hashes to what is current. A name
   * resolves through the DOCS MANIFEST first (the forward path — a spec in docs/),
   * falling back to `current()` over artifact locks (a legacy reader for archived/
   * historical nodes). L2 injects it into steps; it is NOT an L3 servant.
   *
   * The BOUND (`requiredInputs` only) is applied by L2 at injection — same-task chain
   * sources resolve through `prior`, never through here.
   */
  read(name: string): CommandResult<ResolvedRead> {
    const doc = this.store.resolveDoc(name);
    const cur = doc ? undefined : this.store.current(name);
    const target = doc ?? cur;
    if (!target) return fail('unresolved', `no doc/artifact for '${name}' (a docs manifest name or a current artifact's logical name)`);
    const full = join(this.store.root, target.path);
    if (!existsSync(full)) return fail('missing-file', `'${name}' resolved to ${target.path}, but the file is missing`);
    const content = stripMarkers(readFileSync(full, 'utf8'));
    return ok({
      name,
      path: target.path,
      sha: target.sha ?? '',
      content: content.length > READ_CHARS ? content.slice(0, READ_CHARS) : content,
      provenance: 'derived-from',
    });
  }

  status(id: string): string {
    return this.store.status(id);
  }

  statuses(filter?: string): Array<{ id: string; status: string; superseded: boolean }> {
    return this.store
      .ids()
      .sort()
      .filter((id) => !filter || id.includes(filter))
      .map((id) => ({ id, status: this.store.status(id), superseded: this.store.events(id).some((e) => e.type === 'superseded') }));
  }

  detail(id: string): TaskDetail {
    return this.store.detail(id);
  }

  results(id: string): ResultItem[] {
    return this.store.results(id);
  }

  check(): string[] {
    return this.store.check();
  }

  /** `verify` — the DRIFT read (the mirror direction): reconcile the log's claims
   *  against filesystem/git reality (D1-D5). Read-only, like check(). */
  verify(): string[] {
    return this.store.verify();
  }

  /** `ledger` — the write-rev ledger read: rev + per-node last-write rev/at + hashes
   *  (the store-external integrity guard — what ann recorded on its own writes). */
  ledger(): { rev: number; bootstrappedAt: string; nodes: Record<string, { eventsSha: string; nodeSha: string; lastEventAt: string; lastRev: number }> } {
    return this.store.ledgerView();
  }

  events(id: string): JourneyEvent[] {
    return this.store.events(id);
  }

  ids(): string[] {
    return this.store.ids();
  }

  contractOf(id: string): Record<string, unknown> {
    return this.store.contractOf(id);
  }

  /* ══ look-back — a DERIVED view (core-design §1: an L1 read) ════════════════ */

  /** The active leg: the frontmost leg not derived closed (done/superseded/cancelled —
   *  leg 08 task 01 put the closed set in one place). */
  private activeLeg(): string | undefined {
    const legs = this.store.ids().filter((i) => !i.includes('/')).sort();
    return legs.find((l) => !CLOSED_TASK_STATUSES.includes(this.store.status(l)));
  }

  /** Frontmost-ready: prefix order; queued/active only; failed/superseded/blocked
   *  siblings skipped (a blocked task is waiting on a human, not ready to run). */
  frontmostReady(): FrontmostReady | undefined {
    const legs = this.store.ids().filter((i) => !i.includes('/')).sort();
    for (const leg of legs) {
      const ready = this.store.tasksOf(leg).filter((t) => ['queued', 'active'].includes(this.store.status(t)));
      if (ready.length) return { leg, task: ready[0], status: this.store.status(ready[0]) };
    }
    return undefined;
  }

  /** Where we are + what's ahead — derived from the tail, never assumed. */
  lookBack(): LookBack {
    const activeLeg = this.activeLeg();
    const ready = activeLeg ? this.store.tasksOf(activeLeg).filter((t) => ['queued', 'active'].includes(this.store.status(t))) : [];
    const alsoReady = (ready.length ? ready.slice(1) : []).map((t) => ({ leg: activeLeg!, task: t, status: this.store.status(t) }));
    const legGate = activeLeg ? this.store.legGateMet(activeLeg) : { met: true };
    const pendingGates: LookBack['pendingGates'] = [];
    for (const t of this.store.tasksOf(activeLeg ?? '')) {
      const evs = this.store.events(t);
      for (const e of evs) {
        if (e.type !== 'submitted' || typeof e.gate !== 'string') continue;
        if (!this.undecidedSubmission(t, e.gate)) continue;
        if (!pendingGates.some((p) => p.task === t && p.gate === e.gate)) pendingGates.push({ task: t, gate: e.gate });
      }
    }
    return {
      ...(activeLeg ? { activeLeg, activeLegStatus: this.store.status(activeLeg) } : {}),
      frontmostReady: ready.length ? { leg: activeLeg!, task: ready[0], status: this.store.status(ready[0]) } : undefined,
      alsoReady,
      legGate,
      pendingGates,
    };
  }

  /** The ADVANCE view — where the journey goes next, derived from the logs and never
   *  assumed. Closure-by-transfer is a GATED HUMAN decision (v6 §5, F-AC16): this
   *  reports that the gate is unmet and stops. It never closes a leg on its own. */
  advance(): AdvanceView {
    const legs = this.store.ids().filter((i) => !i.includes('/')).sort();
    const working = legs.find((l) => this.store.tasksOf(l).length > 0 && this.store.status(l) !== 'done');
    if (working) {
      const tasks = this.store.tasksOf(working);
      const ready = tasks.filter((t) => ['queued', 'active'].includes(this.store.status(t)));
      if (ready.length) return { leg: working, action: 'continue-leg', detail: `next task: ${ready[0]} (${this.store.status(ready[0])})` };
      const done = tasks.filter((t) => CLOSED_TASK_STATUSES.includes(this.store.status(t))).length;
      const blocked = tasks.filter((t) => this.store.status(t) === 'blocked').length;
      return {
        leg: working,
        action: 'closure-needed',
        detail: `leg gate UNMET: ${done} done, ${blocked} blocked, remaining not done — close via a gated closure task (transfer/defer, F-AC16) or resolve the blocked tasks`,
      };
    }
    // every spawned leg derives done → the frontmost not-done leg is where the review
    // points; NONE not-done → the FOUR-STATE GOAL CONSULT (goal-session-design §5),
    // never the blind "journey goal complete". action stays 'none' (nothing to run);
    // the detail is `next task:`-free (a completed journey proposes no task).
    const front = legs.find((l) => this.store.status(l) !== 'done');
    if (!front) {
      const g = this.goal(); // the consult never fails (reads only) — narrow for the type
      if (!g.ok) return { leg: '', action: 'none', detail: g.error.blocker };
      if (!g.value.present) return { leg: '', action: 'none', detail: g.value.structural.detail };
      if (g.value.verdict === 'met') {
        return { leg: '', action: 'none', detail: 'session complete — goal met: archive & grill a new goal (goal! archive)' };
      }
      if (g.value.verdict === 'unconfirmed') {
        return {
          leg: '',
          action: 'none',
          detail:
            'journey exhausted — verdict UNCONFIRMED: the human chooses — (1) goal! met (criteria met) · (2) a subtle task (e.g. a quality gate) · (3) goal! archive & start a new goal',
        };
      }
      return { leg: '', action: 'none', detail: 'session open — goal seeded, no work spawned yet: the first work leg opens the session' };
    }
    const gate = this.store.legGateMet(front);
    if (!gate.met) return { leg: front, action: 'closure-needed', detail: `leg gate UNMET: ${gate.blocker} — close via a gated closure task (transfer/defer, F-AC16)` };
    return { leg: front, action: 'advance-leg', detail: `leg gate MET: all previous-leg tasks done — spawn tasks into ${front} carrying the epic goal` };
  }

  /** THE STRUCTURED CONCLUSION, derived from the log (format v18) — the ONE place the
   *  claims/checks structure is read: the card renders it, `complete!` enforces it, and
   *  `unclaimed` is the AC list neither may ignore. Pointer RESOLUTION (git/fs probing)
   *  is a render-time concern and stays in the binding. */
  conclusion(id: string): ConclusionView {
    const latest = new Map<string, { ac: string; statement: string; evidence: string[] }>();
    const checks: ConclusionView['checks'] = [];
    const cited: string[] = [];
    for (const e of this.store.events(id)) {
      if (e.type !== 'evidence') continue;
      for (const c of Array.isArray(e.commits) ? e.commits : []) {
        const sha = (c as { sha?: unknown })?.sha;
        if (typeof sha === 'string' && sha.trim() && !cited.includes(sha.trim())) cited.push(sha.trim());
      }
      for (const c of Array.isArray(e.claims) ? e.claims : []) {
        const r = c as { ac?: unknown; statement?: unknown; evidence?: unknown };
        const ac = String(r.ac ?? '');
        if (!ac) continue;
        latest.set(this.acKey(ac), {
          ac,
          statement: String(r.statement ?? ''),
          evidence: (Array.isArray(r.evidence) ? r.evidence : []).map((x) => String(x)),
        });
      }
      for (const k of Array.isArray(e.checks) ? e.checks : []) {
        const r = k as { command?: unknown; result?: unknown; detail?: unknown; sha?: unknown };
        checks.push({
          command: String(r.command ?? ''),
          result: r.result === 'fail' ? 'fail' : 'pass',
          ...(typeof r.detail === 'string' && r.detail ? { detail: r.detail } : {}),
          ...(typeof r.sha === 'string' && r.sha ? { sha: r.sha } : {}),
          at: String(e.at ?? ''),
        });
      }
    }
    const acs = ((this.store.contractOf(id)?.acceptanceCriteria as string[] | undefined) ?? []).filter((a) => typeof a === 'string');
    const used = new Set<string>();
    const claims: ConclusionView['claims'] = [];
    const unclaimed: ConclusionView['unclaimed'] = [];
    acs.forEach((ac, i) => {
      const key = this.acKey(ac);
      const match = [...latest.entries()].find(([k, c]) => !used.has(k) && (k === `ac-${i + 1}` || key.startsWith(k)));
      if (!match) {
        unclaimed.push({ ac: `AC-${i + 1}`, acText: ac });
        return;
      }
      used.add(match[0]);
      claims.push({ ...match[1], ac: `AC-${i + 1}`, acText: ac });
    });
    // a claim that matched no AC is KEPT (an author's extra claim is data, never dropped)
    for (const [k, c] of latest.entries()) if (!used.has(k)) claims.push({ ...c, acText: '' });
    return { claims, checks, unclaimed, cited };
  }

  /** The comparison key for an AC (and a claim's `ac`): case/whitespace-insensitive, so
   *  "AC-2" and "ac-2 " and the criterion's own text prefixes all line up. */
  private acKey(s: string): string {
    return s.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /* ══ shared derivations ════════════════════════════════════════════════════ */

  /** An `undecided` submission at this gate — the predicate BOTH gate writes share.
   *  A submission is decided by a later `confirmed` OR `rejected` at the same gate. */
  private undecidedSubmission(id: string, gate: string): boolean {
    const evs = this.store.events(id);
    return evs.some((e, i) => {
      if (e.type !== 'submitted' || e.gate !== gate) return false;
      return !evs.slice(i + 1).some((x) => (x.type === 'confirmed' || x.type === 'rejected') && x.gate === gate);
    });
  }

  /** A gate's LAST decision — the same reading the frame's own gate state uses: the last
   *  submitted/confirmed/rejected event at that gate. `complete!` requires `confirmed`
   *  here, so a confirm gate re-submitted after an accept (an undecided submission) can
   *  never be completed over. */
  private confirmGateState(id: string): 'confirmed' | 'rejected' | 'submitted' | 'none' {
    const decisions = this.store
      .events(id)
      .filter((e) => (e.type === 'submitted' || e.type === 'confirmed' || e.type === 'rejected') && e.gate === 'confirm');
    return (decisions[decisions.length - 1]?.type as 'confirmed' | 'rejected' | 'submitted' | undefined) ?? 'none';
  }

  /** Rejections recorded at a gate — the bound's counter (and L2's rework signal). */
  rejections(id: string, gate: string): number {
    return this.store.events(id).filter((e) => e.type === 'rejected' && e.gate === gate).length;
  }
}
