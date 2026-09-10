import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, HANDLERS, CliContext } from '../handlers.js';
import { RENDERS } from '../command-renderers.js';

/**
 * The CLI HANDLERS (surface) — two regressions:
 *   1. `ann journey` must never conclude "all spawned tasks done" from the ABSENCE of a
 *      ready task (the derived-state lie: leg 08 corrective) — end to end, store
 *      fixture → the journey handler's value → the text renderer.
 *   2. `evidence!` parses its flags CLOSED: an unknown `--flag` is refused, never
 *      written as a commit sha (a typo must not land junk in a conclusion record).
 */

let root: string;
const dir = (id: string) => join(root, '.ann', 'journey', 'legs', id);
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-09-01', type, ...extra });

function writeNode(id: string, events: Array<Record<string, unknown>>) {
  mkdirSync(dir(id), { recursive: true });
  writeFileSync(join(dir(id), 'node.json'), JSON.stringify({ id, contract: { intent: 'Build the thing', acceptanceCriteria: ['AC-1'] }, createdAt: '2026-09-01' }));
  writeFileSync(join(dir(id), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

/** `ann journey`'s text, through the SAME handler + renderer the binary uses. */
function journeyText(): string {
  const ctx = createContext(root, ['journey']);
  const out = HANDLERS.journey(ctx);
  return RENDERS.journey((out as { value: unknown }).value, ctx.renderEnv());
}

let savedStore: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ann-surface-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  savedStore = process.env.ANN_STORE;
  delete process.env.ANN_STORE; // the fixture is the ACTIVE journey, never an env target
});
afterEach(() => {
  if (savedStore === undefined) delete process.env.ANN_STORE;
  else process.env.ANN_STORE = savedStore;
  rmSync(root, { recursive: true, force: true });
});

describe('ann journey — the derived-state lie (leg 08 corrective)', () => {
  // The live shape: 08/01 done, 08/02 left unfinished while nothing is ready.
  const blockedByGrill = [ev('created'), ev('submitted', { gate: 'grill' })];
  const acceptedByConfirm = [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' }), ev('submitted', { gate: 'confirm' }), ev('confirmed', { gate: 'confirm' })];

  it.each([
    ['blocked', blockedByGrill],
    ['accepted', acceptedByConfirm],
  ])('a leg whose only remaining task is %s never prints "all spawned tasks done"', (status, events) => {
    writeNode('08-task-close', [ev('created')]);
    writeNode('08-task-close/01-implementation-close-vocab', [ev('created'), ev('completed')]);
    writeNode('08-task-close/02-implementation-close-commands', events);

    const text = journeyText();
    expect(text).not.toContain('all spawned tasks done');
    expect(text).not.toContain('LEG GATE REVIEW');
    expect(text).toContain(`no ready tasks in leg — unfinished: 08-task-close/02-implementation-close-commands (${status})`);
  });

  it('a genuinely DONE leg does print the leg-gate review line', () => {
    writeNode('01-leg', [ev('created')]);
    writeNode('01-leg/01-a', [ev('created'), ev('completed')]);

    const text = journeyText();
    expect(text).toContain('01-leg done');
    expect(text).toContain('no active leg — previous leg derived done; LEG GATE REVIEW before spawning the next leg');
  });
});

describe('evidence! — the gesture flags parse CLOSED', () => {
  /** A ctx stub: the refusal must happen BEFORE any command is reached. */
  const stubCtx = (args: string[], evidence: (...a: unknown[]) => unknown = () => ({ ok: true, value: {} })) =>
    ({ args, commands: { evidence } } as unknown as CliContext);

  it('refuses an unknown --flag with a named usage error — nothing is written', () => {
    const calls: unknown[][] = [];
    const ctx = stubCtx(['evidence!', '08-task-close/02', 'abc1234', '--bogus', 'xx'], (...a) => {
      calls.push(a);
      return { ok: true, value: {} };
    });
    let thrown: { code?: string; message?: string; exitCode?: number } | undefined;
    try {
      HANDLERS['evidence!'](ctx);
    } catch (e) {
      thrown = e as { code?: string; message?: string; exitCode?: number };
    }
    expect(thrown?.code).toBe('usage');
    expect(thrown?.message).toContain('unknown flag --bogus');
    expect(thrown?.exitCode).toBe(2);
    expect(calls).toEqual([]); // the junk sha never reached the store write
  });

  it('refuses a repeated known flag instead of writing it as a sha', () => {
    const ctx = stubCtx(['evidence!', '08-task-close/02', 'abc1234', '--note', 'first', '--note', 'second']);
    expect(() => HANDLERS['evidence!'](ctx)).toThrow(/unknown flag --note/);
  });

  it('the happy path still lands the shas + the optional refs/note', () => {
    const calls: unknown[][] = [];
    const ctx = stubCtx(['evidence!', '08-task-close/02', 'abc1234,def5678', '--refs', 'docs/a.md,docs/b.md', '--note', 'the fix'], (...a) => {
      calls.push(a);
      return { ok: true, value: { recorded: true } };
    });
    const out = HANDLERS['evidence!'](ctx) as { ok: true };
    expect(out.ok).toBe(true);
    expect(calls).toEqual([['08-task-close/02', [{ sha: 'abc1234' }, { sha: 'def5678' }], { refs: ['docs/a.md', 'docs/b.md'], note: 'the fix' }]]);
  });

  it('a bare <id> <sha> still works (no flags)', () => {
    const calls: unknown[][] = [];
    const ctx = stubCtx(['evidence!', '08-task-close/02', 'abc1234'], (...a) => {
      calls.push(a);
      return { ok: true, value: {} };
    });
    HANDLERS['evidence!'](ctx);
    expect(calls).toEqual([['08-task-close/02', [{ sha: 'abc1234' }], {}]]);
  });
});

describe('README command table — the copy stays aligned with `ann commands`', () => {
  it('is row-for-row identical to the rendered table (the derived doc is the source)', () => {
    const ctx = createContext(root, ['commands']);
    const out = HANDLERS.commands(ctx);
    const table = RENDERS.commands((out as { value: unknown }).value, ctx.renderEnv())
      .split('\n')
      .filter((l) => l.startsWith('|'));
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8').split('\n');
    const start = readme.findIndex((l) => l.startsWith('| Command | Args |'));
    const rows: string[] = [];
    for (const l of readme.slice(start)) {
      if (!l.startsWith('|')) break;
      rows.push(l);
    }
    expect(rows).toEqual(table);
  });
});
