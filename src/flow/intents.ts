import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Commands, CommandError, CommandResult } from '../commands/index.js';
import { JourneyEvent } from '../store/store.js';
import { CloseIntent, Intent, ProposeSpawnIntent, StageDocIntent, Step } from './types.js';

/**
 * L2 — INTENT TRANSLATION (core-design §3).
 *
 * THE MECHANISM: *docs are git content, events are acceptance.*
 *   - `stage-doc` writes the doc IMMEDIATELY at `<root>/docs/<name>.md` — the working
 *     file IS the deliverable; no task-local `artifacts/` file and no defer record. A
 *     rework re-writes the file; there is no `artifact-locked` to supersede. Conclusion
 *     is the operator's: `git commit` the staged doc + record `evidence.commits[]`
 *     (F-AC18) — the two-phase the frame enforces.
 *   - `propose-spawn` DEFERS TO COMMIT, so a child's `requiredInputs` resolve through
 *     the docs manifest / current() — doc-before-spawn holds BY CONSTRUCTION.
 *   - `evidence` and `close` are immediate; each is idempotent on replay.
 *
 * The translator REFUSES an intent the step did not declare in `produces?[]` (its
 * absence means "produces NOTHING") — so the declaration the confirm-bound deadlock
 * check reads cannot drift from what `execute` actually does.
 *
 * THE STAGED-DOC SET IS PER-RUN, IN MEMORY. That is the design, not an omission: on
 * resume the chain RE-RUNS from the transcript and re-declares the same intents, so a
 * crash before commit loses nothing that the transcript cannot reproduce.
 */

export interface StagedDoc {
  name: string;
  /** The git-home file (root-relative) the doc was written to. */
  path: string;
}

export interface Deferred {
  /** Docs staged this run — already on disk at docs/<name>.md (git content). */
  docs: StagedDoc[];
  spawns: ProposeSpawnIntent[];
}

export interface CommitRecord {
  spawned: string[];
}

const ok = <T>(value: T): CommandResult<T> => ({ ok: true, value });
const fail = (code: string, blocker: string): CommandResult<never> => ({ ok: false, error: { code, blocker } });
const today = (): string => new Date().toISOString().slice(0, 10);
/** A doc name becomes a file stem under docs/ — refuse anything that would escape it. */
const DOC_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class IntentTranslator {
  readonly deferred: Deferred = { docs: [], spawns: [] };

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
      case 'stage-doc':
        return this.stageDoc(step, intent);
      case 'propose-spawn':
        return this.proposeSpawn(intent);
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

  /* ── stage-doc — the doc file NOW, at the repo's git docs/ home ── */

  private stageDoc(step: Step, intent: StageDocIntent): CommandResult<undefined> {
    if (!DOC_NAME.test(intent.name)) {
      return fail('stage-doc-name', `step '${step.id}' staged a doc named '${intent.name}' — docs live at top level of docs/ as <name>.md, and that name would not make a safe file stem`);
    }
    // Write confinement (AC-2): the doc derives from the repo's canonical docs/ folder
    // (root/docs) — never a caller-supplied path. It is git content, not a task artifact.
    const dir = join(this.commands.store.root, 'docs');
    const file = join(dir, `${intent.name}.md`);
    mkdirSync(dir, { recursive: true });
    // idempotent by bytes: a replay re-writes the same content, a rework re-writes fresh
    writeFileSync(file, intent.content);
    const already = this.deferred.docs.find((d) => d.name === intent.name);
    if (!already) this.deferred.docs.push({ name: intent.name, path: `docs/${intent.name}.md` });
    return ok(undefined);
  }

  /* ── propose-spawn — deferred to commit ── */

  private proposeSpawn(intent: ProposeSpawnIntent): CommandResult<undefined> {
    if (intent.id.split('/').length !== 2) {
      return fail('spawn-depth', `propose-spawn '${intent.id}' must be a leg SIBLING (depth 2) — a depth-3 child is invisible to frontmostReady/tasksOf`);
    }
    if (this.commands.ids().includes(intent.id)) return ok(undefined); // no-op if the id exists
    if (!this.deferred.spawns.some((s) => s.id === intent.id)) this.deferred.spawns.push(intent);
    return ok(undefined);
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

  /* ── the commit phase's record: spawns only (docs were staged immediately) ── */

  /**
   * Record the deferred intents at the commit boundary. Only `propose-spawn` defers:
   * a child's `requiredInputs` resolve through the docs manifest / current() because
   * the parent's staged doc is already on disk.
   */
  commit(): CommandResult<CommitRecord> {
    const spawned: string[] = [];
    for (const s of this.deferred.spawns) {
      if (this.commands.ids().includes(s.id)) continue; // no-op if the id exists
      const r = this.commands.spawn(s.id, s.contract);
      if (!r.ok) return r;
      spawned.push(s.id);
    }
    return ok({ spawned });
  }
}

export type { CommandError };
