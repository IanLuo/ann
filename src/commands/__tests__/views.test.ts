import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store/store.js';
import { Commands } from '../index.js';

/**
 * THE L1 DERIVED VIEWS (core-design §1) — frontmostReady · lookBack · advance.
 *
 * They live at L1 because they are DERIVATIONS OVER THE LOG, not coordination: the
 * frame reads them, it does not compute them, and nothing may assume them. Ported here
 * from the superseded planner kernel, which is where they used to live.
 */

let root: string;
const dir = (id: string) => join(root, '.ann', 'journey', 'legs', id);
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-08-27', type, ...extra });

function writeNode(id: string, events: Array<Record<string, unknown>>, contract: unknown = { intent: 'Build the thing', acceptanceCriteria: ['AC-1'] }) {
  mkdirSync(dir(id), { recursive: true });
  writeFileSync(join(dir(id), 'node.json'), JSON.stringify({ id, contract, createdAt: '2026-08-27' }));
  writeFileSync(join(dir(id), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const commands = () => new Commands(new Store(root), 'test');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ann-views-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('frontmostReady — prefix order over the log', () => {
  it('takes the first queued/active task in prefix order', () => {
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created')]);
    writeNode('01-leg/02-b', [ev('created')]);
    expect(commands().frontmostReady()).toEqual({ leg: '01-leg', task: '01-leg/01-a', status: 'queued' });
  });

  it('skips failed, superseded, and blocked siblings — a pending human gate is NOT ready', () => {
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created'), ev('failed')]);
    writeNode('01-leg/02-b', [ev('created'), ev('superseded')]);
    writeNode('01-leg/03-c', [ev('created')]);
    writeNode('01-leg/04-d', [ev('created'), ev('submitted', { gate: 'grill' })]);
    expect(commands().frontmostReady()).toEqual({ leg: '01-leg', task: '01-leg/03-c', status: 'queued' });
  });
});

describe('lookBack — the observer view', () => {
  it('reports the active leg, the frontmost-ready task, and the UNDECIDED human gates', () => {
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created'), ev('activated'), ev('completed')]);
    writeNode('01-leg/02-b', [ev('created')]);
    writeNode('01-leg/03-c', [ev('created'), ev('submitted', { gate: 'grill' })]);
    const lb = commands().lookBack();
    expect(lb.activeLeg).toBe('01-leg');
    expect(lb.frontmostReady).toEqual({ leg: '01-leg', task: '01-leg/02-b', status: 'queued' });
    expect(lb.pendingGates).toEqual([{ task: '01-leg/03-c', gate: 'grill' }]);
  });

  it('a DECIDED submission is not a pending gate', () => {
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created'), ev('submitted', { gate: 'grill' }), ev('confirmed', { gate: 'grill' })]);
    expect(commands().lookBack().pendingGates).toEqual([]);
  });
});

describe('advance — the leg gate validated from the logs, never assumed', () => {
  it('tasks remaining → continue-leg, naming the frontmost', () => {
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created')]);
    writeNode('02-leg', []);
    const a = commands().advance();
    expect(a.action).toBe('continue-leg');
    expect(a.detail).toContain('01-leg/01-a');
  });

  it('leg gate met → advance-leg, naming the next leg', () => {
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created'), ev('completed')]);
    writeNode('02-leg', []);
    const a = commands().advance();
    expect(a.action).toBe('advance-leg');
    expect(a.detail).toContain('02-leg');
  });

  it('gate unmet with remaining work → closure-needed; closure stays a GATED human decision', () => {
    writeNode('01-leg', []);
    writeNode('01-leg/01-a', [ev('created'), ev('completed')]);
    writeNode('01-leg/02-b', [ev('created'), ev('submitted', { gate: 'grill' })]);
    const a = commands().advance();
    expect(a.action).toBe('closure-needed');
    expect(a.detail).toContain('closure');
  });
});
