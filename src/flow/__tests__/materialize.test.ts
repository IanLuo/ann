import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store/store.js';
import { assemblePacket } from '../materialize.js';

let root: string;
function makeStore() {
  root = mkdtempSync(join(tmpdir(), 'ann-pkt-'));
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

describe('Context assembler (S3) — deterministic packet (context-packet-spec)', () => {
  beforeEach(() => { makeStore(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  // a current artifact 'x-spec' with a file on disk (for the excerpt)
  const currentArtifact = () => {
    const id = '01-goal/00-spec';
    mkdirSync(join(nodeDir(id), 'artifacts'), { recursive: true });
    writeFileSync(join(nodeDir(id), 'artifacts', 'x.md'), '# x-spec\n\ncontent line\n'.repeat(50)); // > excerpt cap
    writeNode(id, {}, [ev('artifact-locked', { artifact: { name: 'x-spec', path: 'journey/legs/01-goal/00-spec/artifacts/x.md', lockSha: 'aaa111' } })]);
  };

  it('resolves dependencies via current() with path/sha/excerpt and derived-from provenance', () => {
    currentArtifact();
    const id = '06-engine-build/10-task';
    writeNode(id, { intent: 'Do it', acceptanceCriteria: ['AC1'], requiredInputs: ['x-spec'] }, [ev('created')]);
    const p = assemblePacket(new Store(root), id);
    expect(p.pathDecisions).toEqual({ nodeId: id, isLeg: false, leg: '06-engine-build', route: ['06-engine-build', '10-task'], depth: 2 });
    expect(p.dependencies).toEqual([
      expect.objectContaining({
        name: 'x-spec',
        status: 'resolved',
        path: '.ann/journey/legs/01-goal/00-spec/artifacts/x.md',
        sha: 'aaa111',
        sourceType: 'derived-from',
      }),
    ]);
    expect(p.dependencies[0].excerpt!.length).toBeLessThanOrEqual(2001); // capped
    expect(p.readiness).toEqual({ ready: true, blockers: [] });
  });

  it('marks a missing input as blocked with the name as blocker (readiness false)', () => {
    const id = '06-engine-build/11-task';
    writeNode(id, { intent: 'x', acceptanceCriteria: ['AC1'], requiredInputs: ['no-such-artifact'] }, [ev('created')]);
    const p = assemblePacket(new Store(root), id);
    expect(p.dependencies[0]).toMatchObject({ name: 'no-such-artifact', status: 'missing', blocker: 'no-such-artifact' });
    expect(p.readiness).toEqual({ ready: false, blockers: ['missing requiredInput: no-such-artifact'] });
  });

  it('readiness is blocked by an unanswered blocking open question', () => {
    const id = '06-engine-build/12-task';
    writeNode(
      id,
      { intent: 'x', acceptanceCriteria: ['AC1'], openQuestions: [{ id: 'Q1', question: 'which way?', blocking: true, defaultIfUnanswered: 'a' }] },
      [ev('created')],
    );
    const p = assemblePacket(new Store(root), id);
    expect(p.readiness.ready).toBe(false);
    expect(p.readiness.blockers).toContain('blocking question unanswered: Q1');
    expect(p.openQuestions[0]).toMatchObject({ id: 'Q1', impact: 'high', provenance: 'declared at spawn', status: 'open', default: 'a' });
  });

  it('reads openQuestions as a TOP-LEVEL sibling of contract (format v14 §2)', () => {
    const id = '06-engine-build/13-task';
    mkdirSync(nodeDir(id), { recursive: true });
    writeFileSync(
      join(nodeDir(id), 'node.json'),
      JSON.stringify({
        id,
        contract: { intent: 'x', acceptanceCriteria: ['AC1'] },
        openQuestions: [{ id: 'Q1', question: 'which way?', blocking: true, defaultIfUnanswered: 'a' }],
        createdAt: '2026-08-27',
      }),
    );
    writeFileSync(join(nodeDir(id), 'events.jsonl'), JSON.stringify(ev('created')) + '\n');
    const p = assemblePacket(new Store(root), id);
    expect(p.openQuestions[0]).toMatchObject({ id: 'Q1', impact: 'high', status: 'open', default: 'a' });
    expect(p.readiness.blockers).toContain('blocking question unanswered: Q1');
  });

  it('collects sibling statuses and children — statuses only, no content', () => {
    writeNode('06-engine-build', {}, []);
    writeNode('06-engine-build/01-a', {}, [ev('created'), ev('completed')]);
    writeNode('06-engine-build/02-b', {}, [ev('created')]);
    writeNode('06-engine-build/02-b/01-child', {}, [ev('created')]);
    const p = assemblePacket(new Store(root), '06-engine-build/02-b');
    expect(p.siblingStatus.siblings).toEqual([
      { id: '06-engine-build/01-a', status: 'done' },
      { id: '06-engine-build/02-b', status: 'queued' },
    ]);
    expect(p.siblingStatus.children).toEqual([{ id: '06-engine-build/02-b/01-child', status: 'queued' }]);
  });

  it('assembles a leg packet (isLeg, no siblings) and binding links from evidence refs', () => {
    writeNode('06-engine-build', {}, []);
    const id = '06-engine-build/13-task';
    writeNode(id, { intent: 'x', acceptanceCriteria: ['AC1'] }, [ev('evidence', { refs: ['https://example.com/ext'] }), ev('evidence', { refs: ['src/local.ts'] })]);
    const p = assemblePacket(new Store(root), id);
    expect(p.bindingState.links).toEqual([{ url: 'https://example.com/ext', note: '', at: '2026-08-23' }]); // only http(s), not local refs

    const leg = assemblePacket(new Store(root), '06-engine-build');
    expect(leg.pathDecisions.isLeg).toBe(true);
    expect(leg.pathDecisions.depth).toBe(1);
    expect(leg.siblingStatus.siblings).toEqual([]);
  });
});
