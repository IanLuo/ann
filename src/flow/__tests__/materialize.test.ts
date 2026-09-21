import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../store/store.js';
import { assemblePacket } from '../materialize.js';
import { scanDocsDir, writeDocsManifest } from '../../store/docs.js';

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

  it('resolves a dependency through the DOCS MANIFEST (the forward path — a spec in docs/)', () => {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'spec.md'), '# The Spec\n\ncontent\n');
    writeDocsManifest(root, scanDocsDir(root));
    const id = '06-engine-build/10-task';
    writeNode(id, { intent: 'Do it', acceptanceCriteria: ['AC1'], requiredInputs: ['spec'] }, [ev('created')]);
    const p = assemblePacket(new Store(root), id);
    expect(p.dependencies).toEqual([
      expect.objectContaining({
        name: 'spec',
        status: 'resolved',
        path: 'docs/spec.md',
        sha: expect.stringMatching(/^[0-9a-f]{7}$/),
        sourceType: 'derived-from',
      }),
    ]);
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

  it('an OPEN DECLARED dependency is a readiness blocker (12/17) — the frame cannot start the task', () => {
    const id = '06-engine-build/14-dep';
    mkdirSync(nodeDir(id), { recursive: true });
    writeFileSync(join(nodeDir(id), 'node.json'), JSON.stringify({ id, contract: { intent: 'x', acceptanceCriteria: ['AC1'], dependsOn: ['06-engine-build/13-a'] }, createdAt: '2026-09-01' }));
    writeFileSync(join(nodeDir(id), 'events.jsonl'), JSON.stringify(ev('created')) + '\n');
    mkdirSync(nodeDir('06-engine-build/13-a'), { recursive: true }); // the TARGET node must exist
    writeFileSync(join(nodeDir('06-engine-build/13-a'), 'node.json'), JSON.stringify({ id: '06-engine-build/13-a', contract: { intent: 'x', acceptanceCriteria: ['x'] }, createdAt: '2026-09-01' }));
    writeFileSync(join(nodeDir('06-engine-build/13-a'), 'events.jsonl'), JSON.stringify(ev('created')) + '\n');
    const p = assemblePacket(new Store(root), id);
    expect(p.readiness.ready).toBe(false);
    expect(p.readiness.blockers).toContain('dependency open: 06-engine-build/13-a (queued)');
  });

  /* AC-1 (12/18) — ONE SOURCE. The card's executability (`ann detail` / the node card,
   * which is `Store.detail(id).readiness`) and the packet's readiness are ONE derivation
   * (`Store.readiness`), consumed by both. This is the guard against a second one being
   * introduced: it compares the two reads across all four shapes of the clause AND pins the
   * expected verdict per case, so neither side can drift silently. */
  it('ONE SOURCE: the card\'s executability IS the packet\'s readiness — agreed on all four shapes (12/18)', () => {
    writeNode('06-engine-build/05-target', { intent: 'x', acceptanceCriteria: ['x'] }, [ev('created')]);
    const cases: Array<[string, Record<string, unknown>]> = [
      ['06-engine-build/01-ready', { contract: { intent: 'x', acceptanceCriteria: ['AC1'] } }],
      ['06-engine-build/02-input', { contract: { intent: 'x', acceptanceCriteria: ['AC1'], requiredInputs: ['no-such-artifact'] } }],
      ['06-engine-build/03-question', { contract: { intent: 'x', acceptanceCriteria: ['AC1'] }, openQuestions: [{ id: 'Q1', question: 'which way?', blocking: true }] }],
      ['06-engine-build/04-dep', { contract: { intent: 'x', acceptanceCriteria: ['AC1'], dependsOn: ['06-engine-build/05-target'] } }],
    ];
    for (const [id, body] of cases) {
      mkdirSync(nodeDir(id), { recursive: true });
      writeFileSync(join(nodeDir(id), 'node.json'), JSON.stringify({ id, createdAt: '2026-09-21', ...body }));
      writeFileSync(join(nodeDir(id), 'events.jsonl'), JSON.stringify(ev('created')) + '\n');
    }
    const s = new Store(root);
    const card = Object.fromEntries(cases.map(([id]) => [id, s.detail(id).readiness]));
    const packet = Object.fromEntries(cases.map(([id]) => [id, assemblePacket(s, id).readiness]));
    expect(packet).toEqual(card); // the two reads never disagree
    expect(card).toEqual({
      '06-engine-build/01-ready': { ready: true, blockers: [] },
      '06-engine-build/02-input': { ready: false, blockers: ['missing requiredInput: no-such-artifact'] },
      '06-engine-build/03-question': { ready: false, blockers: ['blocking question unanswered: Q1'] },
      '06-engine-build/04-dep': { ready: false, blockers: ['dependency open: 06-engine-build/05-target (queued)'] },
    });
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
