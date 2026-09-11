import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../../store/store.js';
import { createContext, HANDLERS, CliContext } from '../handlers.js';
import { RENDERS, type NodeCard } from '../command-renderers.js';

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
  // a docs/ manifest so a requiredInput resolves (`ann detail` shows inputs resolved)
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'core-design.md'), '# Core design\n\nthe model\n');
  writeFileSync(join(root, 'docs', 'manifest.json'), JSON.stringify({ 'core-design': 'docs/core-design.md' }, null, 2));
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

describe('the NODE VIEW — the complete task card + the event drill (leg 10 task 04)', () => {
  // A node with a real contract, a resolved input, open questions and a rich event log:
  // the fields the thin gate card used to hide.
  const rich = () => {
    writeFileSync(join(root, 'docs', 'thing.md'), '# Thing\n\nbody\n'); // the live ref the drill probes
    mkdirSync(dir('07-leg'), { recursive: true });
    writeFileSync(
      join(dir('07-leg'), 'node.json'),
      JSON.stringify({ id: '07-leg', contract: { intent: 'the leg', acceptanceCriteria: ['leg done'] }, createdAt: '2026-09-01' }),
    );
    mkdirSync(dir('07-leg/01-implementation-thing'), { recursive: true });
    writeFileSync(
      join(dir('07-leg/01-implementation-thing'), 'node.json'),
      JSON.stringify({
        id: '07-leg/01-implementation-thing',
        contract: {
          intent: 'Build the thing',
          acceptanceCriteria: ['AC-1: it works', 'AC-2: it is reviewed'],
          targetAreas: ['src/thing'],
          requiredInputs: ['core-design', 'ghost-input'],
          expectedOutputs: ['code committed'],
          workType: 'implementation',
          model: 'deepseek-chat',
        },
        openQuestions: [{ id: 'Q1', question: 'which store?', blocking: false }],
        createdAt: '2026-09-01',
      }),
    );
    writeFileSync(
      join(dir('07-leg/01-implementation-thing'), 'events.jsonl'),
      [
        ev('created'),
        ev('submitted', { gate: 'grill' }),
        ev('confirmed', { gate: 'grill' }),
        ev('evidence', { note: 'the work', commits: [{ sha: 'abc1234' }], refs: ['docs/thing.md', 'nope/missing.md'] }),
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
    );
  };
  const ctx = () => createContext(root, ['detail', '07-leg/01-implementation-thing']);
  const value = () => ((HANDLERS.detail(ctx()) as { value: NodeCard }).value);

  it('detail/journey carry the WHOLE node: workType · model · openQuestions · createdAt · resolved+unresolved inputs', () => {
    rich();
    const v = value();
    expect(v.createdAt).toBe('2026-09-01');
    expect(v.openQuestions).toEqual([{ id: 'Q1', question: 'which store?', blocking: false }]);
    expect(v.inputs).toEqual([
      { name: 'core-design', resolved: true, path: 'docs/core-design.md', sha: expect.any(String) },
      { name: 'ghost-input', resolved: false },
    ]);
    const text = RENDERS.detail(v, ctx().renderEnv());
    expect(text).toContain('workType: implementation');
    expect(text).toContain('model: deepseek-chat');
    expect(text).toContain('Q1: which store?');
    expect(text).toContain('core-design → docs/core-design.md @');
    expect(text).toContain('ghost-input  [UNRESOLVED');
    expect(text).toContain('created 2026-09-01');
  });

  it('the event list numbers events EXACTLY as the journey walk numbers them', () => {
    rich();
    const rows = (HANDLERS.events(createContext(root, ['events', '07-leg/01-implementation-thing'])) as { value: { events: Array<{ n: number; type: string }> } }).value.events;
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3, 4]);
    expect(rows.map((r) => r.type)).toEqual(['created', 'submitted', 'confirmed', 'evidence']);
    const walk = RENDERS.journeyOne(value(), ctx().renderEnv());
    for (const r of rows) expect(walk).toContain(`${String(r.n).padStart(2)}. `);
    expect(walk).toContain('EVENTS (4)');
    expect(walk).toContain('ann events 07-leg/01-implementation-thing <n>');
  });

  it('the drill returns the RAW record plus links that resolve — and reports a dead ref', () => {
    rich();
    const drill = (n: string) =>
      (HANDLERS.events(createContext(root, ['events', '07-leg/01-implementation-thing', n])) as { value: { event: Record<string, unknown>; links: Array<{ kind: string; what: string; detail: string; command: string }> } }).value;
    const v = drill('4');
    expect(v.event).toEqual({ at: '2026-09-01', type: 'evidence', note: 'the work', commits: [{ sha: 'abc1234' }], refs: ['docs/thing.md', 'nope/missing.md'] });
    const commit = v.links.find((l) => l.kind === 'commit');
    expect(commit?.what).toBe('abc1234');
    expect(commit?.command).toBe('ann results 07-leg/01-implementation-thing 1'); // the results row for that sha
    const live = v.links.find((l) => l.what === 'docs/thing.md');
    expect(live?.detail).toMatch(/lines/); // exists → its size is reported, not assumed
    const dead = v.links.find((l) => l.what === 'nope/missing.md');
    expect(dead?.detail).toBe('MISSING'); // never silently dropped: the missing ref IS the finding
    expect(v.links.some((l) => l.kind === 'node' && l.command === 'ann journey 07-leg/01-implementation-thing')).toBe(true);
    // a gate event links to the gate card
    const gate = drill('3');
    expect(gate.links.find((l) => l.kind === 'gate')?.command).toBe('ann confirm 07-leg/01-implementation-thing');
    expect(RENDERS.events(v, createContext(root, ['events']).renderEnv())).toContain('links:');
  });

  it('a bad index or an unknown id fails CLOSED, named', () => {
    rich();
    expect(() => HANDLERS.events(createContext(root, ['events', '07-leg/01-implementation-thing', '9']))).toThrow(/no event 9/);
    expect(() => HANDLERS.events(createContext(root, ['events', '07-leg/01-implementation-thing', 'nope']))).toThrow(/no event nope/);
    expect(() => HANDLERS.events(createContext(root, ['events', '99-nope']))).toThrow(/no node/);
  });
});

describe('STRUCTURED EVIDENCE — claims/checks at the gate (format v18)', () => {
  const mk = () => {
    mkdirSync(dir('08-leg'), { recursive: true });
    writeFileSync(join(dir('08-leg'), 'node.json'), JSON.stringify({ id: '08-leg', contract: { intent: 'l', acceptanceCriteria: ['l'] }, createdAt: '2026-09-01' }));
    mkdirSync(dir('08-leg/01-implementation-x'), { recursive: true });
    writeFileSync(
      join(dir('08-leg/01-implementation-x'), 'node.json'),
      JSON.stringify({
        id: '08-leg/01-implementation-x',
        contract: { intent: 'Build it', acceptanceCriteria: ['AC-1: the first thing works', 'AC-2: the second thing works'], workType: 'implementation' },
        createdAt: '2026-09-01',
      }),
    );
    writeFileSync(join(dir('08-leg/01-implementation-x'), 'events.jsonl'), JSON.stringify(ev('created')) + '\n');
  };
  const id = '08-leg/01-implementation-x';
  const sha = () => execFileSync('git', ['-C', process.cwd(), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().slice(0, 7);

  it('--claims / --checks land on the evidence event; a bad argument writes NOTHING', () => {
    mk();
    const s = sha();
    const claims = JSON.stringify([{ ac: 'AC-1', statement: 'the thing works', evidence: [s, 'docs/core-design.md', 'ghost'] }]);
    const checks = JSON.stringify([{ command: 'npm test', result: 'pass', detail: '622/622', sha: s }]);
    const out = HANDLERS['evidence!'](createContext(root, ['evidence!', id, s, '--claims', claims, '--checks', checks, '--note', 'concluded'])) as { value: { value: { claims: number; checks: number } } };
    expect(out.value.value).toEqual({ commits: 1, refs: 0, claims: 1, checks: 1 });
    const event = new Store(root).events(id).find((e) => e.type === 'evidence');
    expect(event?.claims).toEqual([{ ac: 'AC-1', statement: 'the thing works', evidence: [s, 'docs/core-design.md', 'ghost'] }]);
    expect(event?.checks).toEqual([{ command: 'npm test', result: 'pass', detail: '622/622', sha: s }]);

    // a non-JSON or non-array argument is a NAMED usage failure — nothing appended
    const before = new Store(root).events(id).length;
    expect(() => HANDLERS['evidence!'](createContext(root, ['evidence!', id, s, '--claims', '{not json']))).toThrow(/must be a JSON array/);
    expect(() => HANDLERS['evidence!'](createContext(root, ['evidence!', id, s, '--checks', '"nope"']))).toThrow(/must be a JSON ARRAY/);
    expect(new Store(root).events(id).length).toBe(before);
    // …and a malformed claim is refused by the single writer, by NAME
    expect(() => HANDLERS['evidence!'](createContext(root, ['evidence!', id, s, '--claims', JSON.stringify([{ ac: 'AC-1', statement: 'x', bogus: 1 }])]))).toThrow(/unknown field/);
  });

  it('the card states how each AC is met, resolves the pointers, and names the gaps', () => {
    mk();
    const s = sha();
    HANDLERS['evidence!'](
      createContext(root, [
        'evidence!',
        id,
        s,
        '--claims',
        JSON.stringify([{ ac: 'AC-1', statement: 'the first thing works — proven by the suite', evidence: [s, 'docs/core-design.md', 'ghost-pointer'] }]),
        '--checks',
        JSON.stringify([{ command: 'npm test', result: 'pass', detail: '622 passed', sha: s }, { command: 'ann check', result: 'fail', detail: '1 problem' }]),
      ]),
    );
    const card = (HANDLERS.confirm(createContext(root, ['confirm', id])) as { value: { detail: NodeCard } }).value.detail;
    expect(card.claims.map((c) => c.ac)).toEqual(['AC-1', 'AC-2']);
    expect(card.claims[0].statement).toContain('proven by the suite');
    expect(card.claims[0].evidence.join(' ')).toContain(`${s} [resolves in git]`);
    expect(card.claims[0].evidence.join(' ')).toContain('docs/core-design.md');
    expect(card.claims[0].evidence.join(' ')).toContain('ghost-pointer [UNRESOLVED');
    const text = RENDERS.confirm({ detail: card, results: [] }, createContext(root, ['confirm']).renderEnv());
    expect(text).toContain('CLAIMS (how each acceptance criterion is met');
    expect(text).toContain('AC-1: the first thing works — proven by the suite');
    expect(text).toContain('AC-2: NO CLAIM RECORDED');
    expect(text).toContain('PASS  npm test @');
    expect(text).toContain('FAIL  ann check — 1 problem');
    expect(text).toContain('CHECKS (what was run');
  });

  it('a LATER claim for the same AC supersedes the earlier one (the rework model)', () => {
    mk();
    const s = sha();
    const claim = (statement: string) => JSON.stringify([{ ac: 'AC-1', statement }]);
    HANDLERS['evidence!'](createContext(root, ['evidence!', id, s, '--claims', claim('first attempt')]));
    HANDLERS['evidence!'](createContext(root, ['evidence!', id, s, '--claims', claim('second attempt, after the rework')]));
    const card = (HANDLERS.confirm(createContext(root, ['confirm', id])) as { value: { detail: NodeCard } }).value.detail;
    expect(card.claims[0].statement).toBe('second attempt, after the rework');
    expect(card.checks).toEqual([]); // no checks recorded — the card says so
    const text = RENDERS.confirm({ detail: card, results: [] }, createContext(root, ['confirm']).renderEnv());
    expect(text).toContain('(none recorded — the verification is not in the log)');
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
