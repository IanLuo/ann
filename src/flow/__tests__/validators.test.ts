import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store/store.js';
import { runValidators, RULES, derivedRegistry } from '../validators/index.js';
import { setConfig, resetConfigCache } from '../../abilities/llm/config.js';

let root: string;
function makeStore() {
  root = mkdtempSync(join(tmpdir(), 'ann-val-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  return root;
}
function nodeDir(id: string) { return join(root, '.ann', 'journey', 'legs', id); }
function writeNode(id: string, contract: unknown, events: Array<Record<string, unknown>>) {
  mkdirSync(nodeDir(id), { recursive: true });
  writeFileSync(join(nodeDir(id), 'node.json'), JSON.stringify({ id, contract, createdAt: '2026-08-23' }));
  writeFileSync(join(nodeDir(id), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-08-23', type, ...extra });

const findingsBy = (findings: ReturnType<typeof runValidators>, code: string) => findings.filter((f) => f.code === code);

describe('Validators (S4) — self-contained rule modules + derived registry', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('RULES are self-contained and unique (registry-integrity: no dupes)', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(RULES.every((r) => r.definition.length > 10 && typeof r.run === 'function')).toBe(true);
    expect(derivedRegistry().rules.length).toBe(ids.length);
  });

  it('gate-2 flags a completed task without confirmed(gate=confirm)', () => {
    writeNode('06-engine-build/01-a', {}, [ev('created'), ev('completed')]);
    const f = findingsBy(runValidators(new Store(root)), 'gate-2');
    expect(f.length).toBe(1);
    expect(f[0].nodeId).toBe('06-engine-build/01-a');
  });

  it('round-gate flags work in leg N+1 before leg N is done', () => {
    writeNode('01-goal', {}, []);
    writeNode('01-goal/01-a', {}, [ev('created')]); // not done
    writeNode('02-next', {}, []);
    writeNode('02-next/01-b', {}, [ev('created')]);
    const f = findingsBy(runValidators(new Store(root)), 'round-gate');
    expect(f.length).toBe(1);
    expect(f[0].detail).toContain('01-goal');
  });

  it('distance-to-goal returns the SET of not-done nodes, never a scalar', () => {
    writeNode('01-goal', {}, []);
    writeNode('01-goal/01-a', {}, [ev('created'), ev('completed')]);
    writeNode('01-goal/02-b', {}, [ev('created')]);
    const f = findingsBy(runValidators(new Store(root)), 'distance-to-goal');
    expect(f.length).toBe(1);
    expect(f[0].detail).toContain('01-goal → 01-goal/02-b'); // the remaining set
    expect(f[0].detail).not.toContain('01-goal/01-a'); // done nodes excluded
  });

  it('redaction flags evidence content containing the configured apiKey', () => {
    // a TEMP user config (never the real ~/.ann) — ANN_CONFIG override
    const { writeFileSync, mkdirSync } = require('node:fs');
    const { join } = require('node:path');
    const tmpCfg = join(root, 'cfg.json');
    mkdirSync(join(root, '.ann'), { recursive: true });
    process.env.ANN_CONFIG = tmpCfg;
    resetConfigCache();
    setConfig('apiKey', 'sk-very-secret-key-123');
    writeNode('06-engine-build/01-a', {}, [ev('evidence', { note: 'the key is sk-very-secret-key-123 here' })]);
    const f = findingsBy(runValidators(new Store(root)), 'redaction');
    expect(f.length).toBe(1);
    resetConfigCache();
    delete process.env.ANN_CONFIG;
  });

  it('high-impact-defaulted flags a completed node with blocking questions and no answer record', () => {
    writeNode(
      '06-engine-build/01-a',
      { intent: 'x', acceptanceCriteria: ['AC1'], openQuestions: [{ id: 'Q1', question: 'which way?', blocking: true }] },
      [ev('created'), ev('confirmed', { gate: 'grill' }), ev('confirmed', { gate: 'confirm' }), ev('completed')],
    );
    const f = findingsBy(runValidators(new Store(root)), 'high-impact-defaulted');
    expect(f.length).toBe(1);
    expect(f[0].detail).toContain('Q1');
  });

  describe('high-impact-defaulted — the FIELD PATH + the PER-QUESTION match (leg 12 task 11)', () => {
    /** The v14 shape: openQuestions a TOP-LEVEL SIBLING of the contract (format §2).
     *  The rule used to read `contract.openQuestions` — a path no v14 node populates —
     *  which is why it never fired on a real node; its old test hand-wrote the pre-v14
     *  nested shape, so the suite could not catch it. */
    const writeV14 = (id: string, openQuestions: unknown[], events: Array<Record<string, unknown>>) => {
      mkdirSync(nodeDir(id), { recursive: true });
      writeFileSync(
        join(nodeDir(id), 'node.json'),
        JSON.stringify({ id, contract: { intent: 'x', acceptanceCriteria: ['AC1'] }, openQuestions, createdAt: '2026-08-23' }),
      );
      writeFileSync(join(nodeDir(id), 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    };
    const DONE = [ev('created'), ev('confirmed', { gate: 'grill' }), ev('confirmed', { gate: 'confirm' }), ev('completed')];

    it('flags a blocking question declared TOP-LEVEL (the live shape) with no answer', () => {
      writeV14('06-engine-build/02-a', [{ id: 'Q1', question: 'which way?', blocking: true }], DONE);
      const f = findingsBy(runValidators(new Store(root)), 'high-impact-defaulted');
      expect(f.length).toBe(1);
      expect(f[0].detail).toContain('Q1 carries no answer record');
    });

    it('still reads the legacy NESTED shape (the fallback, never the written shape)', () => {
      writeNode('06-engine-build/03-a', { intent: 'x', acceptanceCriteria: ['AC1'], openQuestions: [{ id: 'Q9', question: 'legacy', blocking: true }] }, DONE);
      const f = findingsBy(runValidators(new Store(root)), 'high-impact-defaulted');
      expect(f.length).toBe(1);
      expect(f[0].detail).toContain('Q9');
    });

    it('is SILENT when the question is answered with provenance discussed', () => {
      writeV14('06-engine-build/04-a', [{ id: 'Q1', question: 'which way?', blocking: true }], [
        ...DONE,
        ev('evidence', { commits: [{ sha: 'abc1234' }], answers: [{ id: 'Q1', answer: 'this way', provenance: 'discussed' }] }),
      ]);
      expect(findingsBy(runValidators(new Store(root)), 'high-impact-defaulted')).toHaveLength(0);
    });

    it('flags an answer resolved as inferred/defaulted (the tech-stack lesson)', () => {
      writeV14('06-engine-build/05-a', [{ id: 'Q1', question: 'which way?', blocking: true }], [
        ...DONE,
        ev('evidence', { commits: [{ sha: 'abc1234' }], answers: [{ id: 'Q1', answer: 'guessed', provenance: 'inferred' }] }),
      ]);
      const f = findingsBy(runValidators(new Store(root)), 'high-impact-defaulted');
      expect(f.length).toBe(1);
      expect(f[0].detail).toContain("resolved as 'inferred'");
    });

    it('matches PER QUESTION — one answered, the other not', () => {
      writeV14('06-engine-build/06-a', [
        { id: 'Q1', question: 'which way?', blocking: true },
        { id: 'Q2', question: 'and this?', blocking: true },
      ], [
        ...DONE,
        ev('evidence', { commits: [{ sha: 'abc1234' }], answers: [{ id: 'Q1', answer: 'this way', provenance: 'discussed' }] }),
      ]);
      const f = findingsBy(runValidators(new Store(root)), 'high-impact-defaulted');
      expect(f.length).toBe(1);
      expect(f[0].detail).toContain('Q2 carries no answer record');
      expect(f[0].detail).not.toContain('Q1 carries no answer record');
    });
  });

  it('runs one rule against ONE node only (ann validate <id>)', () => {
    writeNode('06-engine-build/01-a', {}, [ev('created'), ev('completed')]); // gate-2 violation
    writeNode('06-engine-build/02-b', {}, [ev('created'), ev('completed')]); // gate-2 violation
    const f = runValidators(new Store(root), '06-engine-build/02-b');
    expect(findingsBy(f, 'gate-2').length).toBe(1);
    expect(findingsBy(f, 'gate-2')[0].nodeId).toBe('06-engine-build/02-b');
  });
});
