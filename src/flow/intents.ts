import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Commands, CommandError, CommandResult, LockedArtifact } from '../commands/index.js';
import { blobSha, stripMarkers } from '../store/sha.js';
import { JourneyEvent } from '../store/store.js';
import { CloseIntent, Intent, LockArtifactIntent, ProposeSpawnIntent, Step, SupersedeIntent } from './types.js';

/**
 * L2 — INTENT TRANSLATION (core-design §3).
 *
 * THE MECHANISM: *files are working state, events are acceptance.*
 *   - `lock-artifact` materializes the WORKING FILE immediately (task-local, in
 *     `artifacts/`); the `artifact-locked` EVENT records only at COMMIT, once the
 *     task's gates are accepted. A rework re-writes the file and never double-locks,
 *     so NO `superseded` is ever written on a live node.
 *   - `propose-spawn` DEFERS TO COMMIT alongside it, so a child's `requiredInputs`
 *     resolve through `current()` — lock-before-spawn holds BY CONSTRUCTION.
 *   - `evidence`, `supersede` and `close` are immediate; each is idempotent on replay.
 *
 * The translator REFUSES an intent the step did not declare in `produces?[]` (its
 * absence means "produces NOTHING") — so the declaration the confirm-bound deadlock
 * check reads cannot drift from what `execute` actually does.
 *
 * DEFERRALS ARE PER-RUN, IN MEMORY. That is the design, not an omission: on resume the
 * chain RE-RUNS from the transcript and re-declares the same intents, so a crash before
 * commit loses nothing that the transcript cannot reproduce.
 */

export interface DeferredLock {
  name: string;
  type: string;
  /** The task-local working file the event will record at commit. */
  workingPath: string;
}

export interface Deferred {
  locks: DeferredLock[];
  spawns: ProposeSpawnIntent[];
}

export interface CommitRecord {
  locked: LockedArtifact[];
  spawned: string[];
}

const ok = <T>(value: T): CommandResult<T> => ({ ok: true, value });
const fail = (code: string, blocker: string): CommandResult<never> => ({ ok: false, error: { code, blocker } });
const today = (): string => new Date().toISOString().slice(0, 10);

export class IntentTranslator {
  readonly deferred: Deferred = { locks: [], spawns: [] };

  constructor(
    private readonly commands: Commands,
    private readonly taskId: string,
  ) {}

  /** Translate one step's declared intents. Fails NAMED on the first refusal. */
  translate(step: Step, intents: Intent[] = []): CommandResult<undefined> {
    const declared = new Set(step.produces ?? []);
    for (const intent of intents) {
      if (!declared.has(intent.kind)) {
        return fail('undeclared-intent', `step '${step.id}' declared intent '${intent.kind}' but does not list it in produces[] (absence means it produces NOTHING — fail closed)`);
      }
      const r = this.one(step, intent);
      if (!r.ok) return r;
    }
    return ok(undefined);
  }

  private one(step: Step, intent: Intent): CommandResult<undefined> {
    switch (intent.kind) {
      case 'evidence':
        return this.evidence(intent);
      case 'lock-artifact':
        return this.lockArtifact(step, intent);
      case 'propose-spawn':
        return this.proposeSpawn(intent);
      case 'supersede':
        return this.supersede(intent);
      case 'close':
        return this.close(intent);
    }
  }

  /* ── evidence — immediate, deduped on answers[].id / refs[] / the note's own text ── */

  private evidence(intent: Extract<Intent, { kind: 'evidence' }>): CommandResult<undefined> {
    const recorded = this.commands.events(this.taskId).filter((e) => e.type === 'evidence');
    const ids = new Set(recorded.flatMap((e) => ((e.answers ?? []) as Array<{ id?: string }>).map((a) => a.id)));
    const refs = new Set(recorded.flatMap((e) => (e.refs ?? []) as string[]));
    if (intent.answers?.length && intent.answers.every((a) => ids.has(a.id))) return ok(undefined);
    if (intent.refs?.length && intent.refs.every((r) => refs.has(r))) return ok(undefined);
    // a bare note's only identity IS its text — dedup on it so replay never duplicates
    if (!intent.answers?.length && !intent.refs?.length && recorded.some((e) => e.note === intent.note)) return ok(undefined);
    const event = { at: today(), type: 'evidence', note: intent.note, ...(intent.refs ? { refs: intent.refs } : {}), ...(intent.answers ? { answers: intent.answers } : {}) };
    return this.commands.append(this.taskId, event as unknown as JourneyEvent);
  }

  /* ── lock-artifact — the FILE now, the EVENT at commit (defer-record) ── */

  private lockArtifact(step: Step, intent: LockArtifactIntent): CommandResult<undefined> {
    const type = intent.type ?? 'record';
    const dir = join(this.commands.store.legs, this.taskId, 'artifacts');
    const file = join(dir, `${intent.name}.md`);
    let content: string;
    if (typeof intent.content === 'string') content = intent.content;
    else if (intent.path) {
      const src = join(this.commands.store.root, intent.path);
      if (!existsSync(src)) return fail('no-source', `step '${step.id}' locked '${intent.name}' from ${intent.path}, which does not exist`);
      content = readFileSync(src, 'utf8');
    } else {
      return fail('empty-lock', `step '${step.id}' declared lock-artifact '${intent.name}' with neither content nor path`);
    }
    mkdirSync(dir, { recursive: true });
    // idempotent by bytes: a replay re-writes the same content, a rework re-writes fresh
    writeFileSync(file, content);
    const already = this.deferred.locks.find((l) => l.name === intent.name);
    if (already) already.type = type;
    else this.deferred.locks.push({ name: intent.name, type, workingPath: file });
    return ok(undefined);
  }

  /* ── propose-spawn — deferred to commit, beside the locks ── */

  private proposeSpawn(intent: ProposeSpawnIntent): CommandResult<undefined> {
    if (intent.id.split('/').length !== 2) {
      return fail('spawn-depth', `propose-spawn '${intent.id}' must be a leg SIBLING (depth 2) — a depth-3 child is invisible to frontmostReady/tasksOf`);
    }
    if (this.commands.ids().includes(intent.id)) return ok(undefined); // no-op if the id exists
    if (!this.deferred.spawns.some((s) => s.id === intent.id)) this.deferred.spawns.push(intent);
    return ok(undefined);
  }

  /* ── supersede — the ONE cross-task write; refuses a live locker ── */

  private supersede(intent: SupersedeIntent): CommandResult<undefined> {
    const current = this.commands.store.current(intent.name);
    if (!current) return fail('no-current', `nothing current for '${intent.name}' — there is nothing to supersede`);
    const locker = current.producer;
    const identical = this.commands
      .events(locker)
      .some((e) => e.type === 'superseded' && e.successor?.name === intent.name && e.successor?.path === intent.path);
    if (identical) return ok(undefined); // no-op on the identical event
    return this.commands.supersede(locker, intent.name, intent.path, intent.note ?? `superseded by ${this.taskId}`);
  }

  /* ── close — F-AC16 validated, then appended (deduped on the identical event) ── */

  private close(intent: CloseIntent): CommandResult<undefined> {
    const kinds = (['transferred', 'deferred', 'gate-revised'] as const).filter((k) => intent[k] !== undefined);
    if (kinds.length !== 1) {
      return fail('close-shape', `close takes exactly one of transferred | deferred | gate-revised, got ${kinds.join(', ') || '(none)'}`);
    }
    const recorded = this.commands.events(this.taskId);
    if (intent.transferred) {
      const { target, scope } = intent.transferred;
      if (!this.commands.ids().includes(target)) return fail('no-target', `close.transferred target '${target}' does not exist (F-AC16: a transfer must land somewhere)`);
      if (recorded.some((e) => e.type === 'transferred' && e.target === target && e.scope === scope)) return ok(undefined);
      return this.commands.append(this.taskId, { at: today(), type: 'transferred', target, scope, note: `transferred to ${target}` } as unknown as JourneyEvent);
    }
    if (intent.deferred) {
      const { reason } = intent.deferred;
      if (recorded.some((e) => e.type === 'deferred' && e.reason === reason)) return ok(undefined);
      return this.commands.append(this.taskId, { at: today(), type: 'deferred', reason, note: 'deferred' } as unknown as JourneyEvent);
    }
    const revised = intent['gate-revised']!;
    const note = `gate revised: ${revised.old} → ${revised.new}`;
    if (recorded.some((e) => e.type === 'gate-revised' && e.note === note)) return ok(undefined);
    return this.commands.append(this.taskId, { at: today(), type: 'gate-revised', gate: 'confirm', note } as unknown as JourneyEvent);
  }

  /* ── the commit phase's record: LOCKS FIRST, THEN SPAWNS ── */

  /**
   * Record the deferred intents. Ordering is locks-before-spawns, which is what makes
   * lock-before-spawn hold BY CONSTRUCTION (§3 rule 2) — a child's `requiredInputs`
   * resolve through `current()` because the parent's artifacts are already current.
   *
   * THE GATE②-TO-COMMIT CONTENT BINDING: when `submit!(confirm)` recorded a sha, one of
   * the deferred working files must still hash to it (marker-stripped). A mismatch is
   * REFUSED, named — the frame turns that into `failed`.
   */
  commit(opts: { confirmedSha?: string } = {}): CommandResult<CommitRecord> {
    if (opts.confirmedSha && this.deferred.locks.length) {
      const shas = this.deferred.locks.map((l) => blobSha(stripMarkers(readFileSync(l.workingPath, 'utf8'))).slice(0, 7));
      if (!shas.includes(opts.confirmedSha.slice(0, 7))) {
        return fail(
          'content-drift',
          `the confirm gate decided on ${opts.confirmedSha.slice(0, 7)} but the working file(s) now hash to ${shas.join(', ')} — the artifact changed after the gate (commit refuses)`,
        );
      }
    }
    const locked: LockedArtifact[] = [];
    for (const l of this.deferred.locks) {
      const already = this.commands.store.current(l.name);
      if (already?.producer === this.taskId) continue; // idempotent on replay — already recorded
      const r = this.commands.lock(this.taskId, l.name, { path: relative(this.commands.store.root, l.workingPath), type: l.type });
      if (!r.ok) return r;
      locked.push(r.value);
    }
    const spawned: string[] = [];
    for (const s of this.deferred.spawns) {
      if (this.commands.ids().includes(s.id)) continue; // no-op if the id exists
      const r = this.commands.spawn(s.id, s.contract);
      if (!r.ok) return r;
      spawned.push(s.id);
    }
    return ok({ locked, spawned });
  }
}

export type { CommandError };
