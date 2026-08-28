import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, realpathSync, lstatSync } from 'node:fs';
import { join, basename, relative, dirname } from 'node:path';
import { Store, JourneyEvent, legacyPath, ResultItem, TaskDetail } from '../store/store.js';
import { blobSha, stripMarkers } from '../store/sha.js';
import { getVOCAB, ArtifactTypeEntry } from '../store/vocab.js';

/**
 * L1 — THE COMMAND SURFACE (core-design §1): the store's interface, and the ONLY
 * path to the store. Everything above (the flow, the validators, the adapters, the
 * CLI binding) reads and writes through here; nothing above ever touches L0.
 *
 * READS are derived views (status · packet · flow · results · look-back · specs ·
 * check · read). WRITES are the six mutators — `spawn!` · `submit!` · `gate!` ·
 * `append!` · `lock!` · `supersede!` — COMPLETE over the event vocabulary. The
 * composite mutators ENCODE THE INVARIANTS the design assigns to L1:
 *
 *   spawn!      the v14 node.json contract schema + F-AC19 + id naming + the
 *               artifact gate + the leg gate  (moved here from the CLI)
 *   gate!       the reject bound (3/gate, a CONSTANT) + the two-write sequence
 *   submit!     the other half of that sequence + the gate② content binding
 *   append!     refuses the composite-owned kinds and `created`
 *   lock!       one-current-per-name + type-driven placement/filename/versioning
 *   supersede!  the one cross-task write
 *
 * MULTI-CLIENT = multiple IN-PROCESS initiators (the flow, the validators, the
 * adapters). The CLI is a BINDING, not an initiator.
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
  'artifact-locked': 'lock!',
  superseded: 'supersede!',
};

/** Excerpt bound for the read view (context-packet-spec §4 — never unbounded). */
const READ_CHARS = 200_000;

export interface SpawnedNode {
  id: string;
  kind: 'leg' | 'task';
}

export interface LockedArtifact {
  name: string;
  /** The RECORDED path — the task-local ref (`journey/legs/<id>/artifacts/<name>.md`). */
  path: string;
  /** The content file the ref resolves to (the shared `docs/` file, or the ref itself). */
  contentPath: string;
  sha: string;
}

export interface GateOutcome {
  gate: string;
  decision: 'accept' | 'reject';
  /** L2 reads THIS ONLY — the bound itself stays inside `gate!` (core-design §4). */
  escalated: boolean;
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

export class Commands {
  constructor(
    readonly store: Store,
    private readonly who = 'agent',
  ) {}

  private get today(): string {
    return new Date().toISOString().slice(0, 10);
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
      // The ARTIFACT GATE (format v14 §4/§14): a parent TASK may spawn children only
      // after it has concluded. A leg parent carries no events by design — depth-2
      // spawns are not gated on it (which is what makes deferred `propose-spawn` work).
      if (parent.split('/').length >= 2 && !this.store.parentConcluded(parent)) {
        return fail('artifact-gate', `parent task ${parent} has no artifact-locked or commit evidence (format v14 §4)`);
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
      this.store.appendEvent(id, event);
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
        this.store.appendEvent(id, { at: this.today, type: 'submitted', gate, note: `submitted with the decision (${this.who})` });
      }
      this.store.appendEvent(
        id,
        decision === 'accept'
          ? { at: this.today, type: 'confirmed', gate, note: `accepted (${this.who})` }
          : { at: this.today, type: 'rejected', gate, feedback, note: `rejected (${this.who})` },
      );
    } catch (e) {
      return fail('store-refused', (e as Error).message);
    }
    const after = decision === 'reject' ? rejects + 1 : rejects;
    return ok({ gate, decision, escalated: after >= REJECT_BOUND });
  }

  /**
   * `append!` — the general single-writer append, for the kinds no composite owns
   * (the frame's lifecycle writes, evidence, closure, `waiting`, `extended`). It
   * REFUSES the composite-owned kinds and `created`: those carry invariants, and an
   * append that bypassed them would be a hole in every one of them.
   */
  append(id: string, event: JourneyEvent): CommandResult {
    const owner = COMPOSITE_OWNED[event?.type];
    if (owner) {
      return fail('composite-owned', `'${event.type}' is owned by ${owner} — use it (the composite encodes the invariant; append! would bypass it)`);
    }
    try {
      this.store.appendEvent(id, event);
    } catch (e) {
      return fail('store-refused', (e as Error).message);
    }
    return ok(undefined);
  }

  /**
   * `lock!` — record an artifact. Owner of ONE-CURRENT-PER-NAME and of TYPE-DRIVEN
   * PLACEMENT (core-design §3 rule 7): the artifact TYPE names the `docs/` category
   * and whether the file is versioned, via the vocab registry.
   *
   * Shared document types are materialized at `docs/<category>/<name>-v<N>.md`
   * BYTE-VERBATIM from the working file, with the task-local `artifacts/<name>.md`
   * becoming a symlink to it — the placement, the symlink and `N` all happen HERE,
   * because this is where the event records (defer-record: the frame calls `lock!`
   * from the commit phase). Task-local types stay real files where they are.
   */
  lock(id: string, name: string, opts: { type: string; note?: string } = { type: 'spec' }): CommandResult<LockedArtifact> {
    const entry = getVOCAB().artifactTypes[opts.type] as ArtifactTypeEntry | undefined;
    if (!entry) {
      return fail('unknown-type', `type '${opts.type}' is not in the vocab registry (${Object.keys(getVOCAB().artifactTypes).join(' | ')})`);
    }
    const current = this.store.current(name);
    if (current) return fail('already-current', `'${name}' is already current (${current.path}) — supersede it first (one current per name)`);

    const workingFile = this.workingFile(id, name);
    if (!workingFile.ok) return workingFile;
    const file = workingFile.value;
    const content = stripMarkers(readFileSync(file, 'utf8'));
    const sha = blobSha(content).slice(0, 7);
    const stamped = `<!-- specs:locked:${sha} ${this.today} type=${opts.type} -->\n` + content;

    let contentPath = file;
    if (entry.category) {
      const placed = this.place(name, entry, stamped, file);
      if (!placed.ok) return placed;
      contentPath = placed.value;
    } else {
      writeFileSync(file, stamped);
    }
    const recorded = 'journey/legs/' + id + '/artifacts/' + basename(file);
    try {
      this.store.appendEvent(id, {
        at: this.today,
        type: 'artifact-locked',
        artifact: { name, path: recorded, lockSha: sha },
        note: opts.note ?? `${basename(file)} locked @ ${sha} (${this.who})`,
      });
    } catch (e) {
      return fail('store-refused', (e as Error).message);
    }
    return ok({ name, path: recorded, contentPath: relative(this.store.root, contentPath), sha });
  }

  /** The WORKING FILE for a lock: `artifacts/<name>.md`, or the single .md candidate. */
  private workingFile(id: string, name: string): CommandResult<string> {
    const dir = join(this.store.legs, id, 'artifacts');
    const exact = join(dir, name + '.md');
    if (existsSync(exact)) return ok(exact);
    const candidates = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
    if (candidates.length === 1) return ok(join(dir, candidates[0]));
    return fail('no-working-file', `no artifacts/${name}.md under ${id}; candidates: ${candidates.join(', ') || '(none)'}`);
  }

  /**
   * SHARED PLACEMENT (format v14 §14/§15): write `docs/<category>/<name>-v<N>.md`
   * byte-verbatim, then replace the task-local working file with a symlink to it.
   * `N` is derived from THE LOG — the recorded `artifact-locked` paths of this logical
   * name, resolved to the files they point at — never from a counter, never from a
   * filesystem scan alone.
   */
  private place(name: string, entry: ArtifactTypeEntry, stamped: string, workingFile: string): CommandResult<string> {
    const n = entry.versioned ? this.nextVersion(name) : undefined;
    const dir = join(this.store.root, '.ann', 'docs', entry.category!);
    const target = join(dir, `${name}${n === undefined ? '' : `-v${n}`}.md`);
    if (existsSync(target)) {
      return fail('placement-collision', `${relative(this.store.root, target)} already exists — the version derivation would overwrite a locked file`);
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, stamped);
    if (existsSync(workingFile) || lstatSync(workingFile, { throwIfNoEntry: false })) unlinkSync(workingFile);
    symlinkSync(relative(dirname(workingFile), target), workingFile);
    return ok(target);
  }

  /** Highest `-v<N>` among THIS name's recorded locks (resolved through their refs), + 1. */
  private nextVersion(name: string): number {
    let max = 0;
    for (const id of this.store.ids()) {
      for (const e of this.store.events(id)) {
        if (e.type !== 'artifact-locked' || e.artifact?.name !== name) continue;
        const recorded = join(this.store.root, legacyPath(e.artifact.path));
        let file = recorded;
        try {
          file = realpathSync(recorded);
        } catch {
          /* an unresolvable recorded path contributes nothing — the log still names it */
        }
        const m = basename(file).match(/-v(\d+)\.md$/);
        if (m) max = Math.max(max, Number(m[1]));
      }
    }
    return max + 1;
  }

  /**
   * `supersede!` — the ONLY cross-task write: `superseded` on the OLD LOCKER's node.
   * The frame REFUSES to supersede a locker that is not `done` (core-design §3): the
   * status collapse applies to any non-done/failed node carrying `superseded`, so
   * superseding a live locker in its commit window would silently kill it.
   */
  supersede(id: string, name: string, path: string, note = ''): CommandResult {
    if (!this.store.ids().includes(id)) return fail('no-node', `no node ${id}`);
    if (!existsSync(join(this.store.root, path))) return fail('no-successor', `successor path ${path} not found`);
    const status = this.store.status(id);
    if (!['done', 'failed', 'superseded'].includes(status)) {
      return fail(
        'live-locker',
        `refusing to supersede ${id}: it is '${status}', not done — a 'superseded' event collapses a live node's status (core-design §3)`,
      );
    }
    try {
      this.store.appendEvent(id, {
        at: this.today,
        type: 'superseded',
        successor: { name, path },
        note: note || `${name} superseded → ${path} (${this.who})`,
      });
    } catch (e) {
      return fail('store-refused', (e as Error).message);
    }
    return ok(undefined);
  }

  /* ══ READS — the derived views ══════════════════════════════════════════════ */

  /**
   * `read` — THE CONTENT READ VIEW (core-design §5): an L1 derived read, `current()`
   * plus a bounded file read, serving MARKER-STRIPPED content so what a caller reads
   * hashes to what was locked. L2 injects it into steps; it is NOT an L3 servant.
   *
   * The BOUND (`requiredInputs` only) is applied by L2 at injection — same-task chain
   * sources resolve through `prior`, never through here.
   */
  read(name: string): CommandResult<ResolvedRead> {
    const cur = this.store.current(name);
    if (!cur) return fail('unresolved', `no current artifact for '${name}' (use the artifact's logical name)`);
    const full = join(this.store.root, cur.path);
    if (!existsSync(full)) return fail('missing-file', `current '${name}' recorded at ${cur.path}, but the file is missing`);
    const content = stripMarkers(readFileSync(full, 'utf8'));
    return ok({
      name,
      path: cur.path,
      sha: cur.sha ?? '',
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

  /** The active leg: the frontmost leg not derived done/superseded. */
  private activeLeg(): string | undefined {
    const legs = this.store.ids().filter((i) => !i.includes('/')).sort();
    return legs.find((l) => !['done', 'superseded'].includes(this.store.status(l)));
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
      const done = tasks.filter((t) => ['done', 'superseded'].includes(this.store.status(t))).length;
      const blocked = tasks.filter((t) => this.store.status(t) === 'blocked').length;
      return {
        leg: working,
        action: 'closure-needed',
        detail: `leg gate UNMET: ${done} done, ${blocked} blocked, remaining not done — close via a gated closure task (transfer/defer, F-AC16) or resolve the blocked tasks`,
      };
    }
    // every spawned leg derives done → the frontmost not-done leg is where the review points
    const front = legs.find((l) => this.store.status(l) !== 'done');
    if (!front) return { leg: '', action: 'none', detail: 'every leg derived done — journey goal complete (or needs a closure decision)' };
    const gate = this.store.legGateMet(front);
    if (!gate.met) return { leg: front, action: 'closure-needed', detail: `leg gate UNMET: ${gate.blocker} — close via a gated closure task (transfer/defer, F-AC16)` };
    return { leg: front, action: 'advance-leg', detail: `leg gate MET: all previous-leg tasks done — spawn tasks into ${front} carrying the epic goal` };
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

  /** Rejections recorded at a gate — the bound's counter (and L2's rework signal). */
  rejections(id: string, gate: string): number {
    return this.store.events(id).filter((e) => e.type === 'rejected' && e.gate === gate).length;
  }
}
