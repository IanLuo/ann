import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { blobSha } from '../store/sha.js';

/**
 * E2E — ANN_STORE session-addressing through the REAL CLI binary. The unit suite
 * (store/__tests__/session-addressing.test.ts) covers the resolver/remap/guard
 * contract in-process; THIS suite proves the CLI wiring: ANN_STORE is read at process
 * start, a target resolves to the same commands reading ANY journey, a bad/absent
 * target fails CLOSED (named error, exit 1), a NON-ACTIVE target is READ-ONLY (the
 * journey-addressing writes refuse with a named message before dispatch; config!/cred!/
 * project! stay available), the active session stays writable when ANN_STORE names it,
 * and docs-manifest reads are only attempted against a PROJECT root that has one.
 */

const REPO = process.cwd();
const CLI = join(REPO, 'dist', 'surface', 'cli.js');
const HERMETIC = { ANN_LLM_BASE_URL: 'http://127.0.0.1:1/v1' };

interface CliResult { code: number | null; stdout: string; stderr: string; }
function cli(root: string, args: string[], env: Record<string, string> = {}): CliResult {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: { ...process.env, ...HERMETIC, ANN_PROJECT: root, RECORDED_BY: 'e2e', ANN_CONFIG: join(root, '.e2e-config.json'), ...env },
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const out = (r: CliResult) => r.stdout + r.stderr;
const CONTRACT = (intent: string) => JSON.stringify({ intent, acceptanceCriteria: [`${intent} is done`] });

function newProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'ann-e2e-sess-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  // the vocab registry (rules/schema/vocab.json) is a READ of the project's rules home —
  // spawn/append need it, so mirror the real repo's .ann/rules like cli.e2e does.
  cpSync(join(REPO, '.ann', 'rules'), join(root, '.ann', 'rules'), { recursive: true });
  writeFileSync(join(root, '.e2e-config.json'), '{}');
  return root;
}

/** Write one node + its events under a journey legs root; returns the exact bytes. */
function node(legs: string, id: string, contract: unknown, events: Array<Record<string, unknown>> = []) {
  const dir = join(legs, id);
  mkdirSync(dir, { recursive: true });
  const nodeJson = JSON.stringify({ id, contract, createdAt: '2026-08-19' });
  writeFileSync(join(dir, 'node.json'), nodeJson);
  let eventsContent = '';
  if (events.length) {
    eventsContent = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(join(dir, 'events.jsonl'), eventsContent);
  }
  return { nodeJson, eventsContent };
}

/** An archived-session journey inside the temp project (the shape goal! archive
 *  round-trips: bare journey/{legs, .ledger.json}). A MET goal leg + a leg with a
 *  structured lock ('alpha-spec') + a legacy-PROSE lock ('beta-note'). */
function archiveSession(root: string): string {
  const journey = join(root, '.ann', 'archive', 'sessions', 'arch-session', 'journey');
  const legs = join(journey, 'legs');
  const today = '2026-08-19';
  const entries: Record<string, { nodeJson: string; eventsContent: string }> = {};
  entries['01-goal'] = node(legs, '01-goal', {
    intent: 'the archived goal',
    acceptanceCriteria: ['readable through ANN_STORE'],
  }, [
    { at: today, type: 'created', note: 'goal seeded' },
    { at: today, type: 'completed', note: 'goal grilled' },
    { at: today, type: 'goal-met', decision: 'met', note: 'goal met (e2e)' },
  ]);
  entries['02-leg/01-produce'] = node(legs, '02-leg/01-produce', {
    intent: 'produce the alpha spec',
    acceptanceCriteria: ['alpha-spec.md is written'],
  }, [
    { at: today, type: 'created', note: 'spawned' },
    { at: today, type: 'activated', note: 'work started' },
    { at: today, type: 'submitted', gate: 'grill', note: 'grill' },
    { at: today, type: 'confirmed', gate: 'grill', note: 'ok' },
    { at: today, type: 'artifact-locked', artifact: { name: 'alpha-spec', path: 'tree/rounds/02-leg/01-produce/artifacts/alpha-spec.md', lockSha: '1234567' }, note: 'alpha-spec.md specs-locked' },
    { at: today, type: 'evidence', note: 'produced', commits: [{ sha: 'abc1234', note: 'deliverable' }] },
    { at: today, type: 'completed', note: 'done' },
  ]);
  entries['02-leg/02-prose'] = node(legs, '02-leg/02-prose', {
    intent: 'write the beta note',
    acceptanceCriteria: ['beta-note.md is written'],
  }, [
    { at: today, type: 'created', note: 'spawned' },
    { at: today, type: 'artifact-locked', note: 'logical name: beta-note; beta-note.md specs-locked' },
    { at: today, type: 'completed', note: 'done' },
  ]);
  entries['02-leg'] = node(legs, '02-leg', { intent: 'the second leg', acceptanceCriteria: [] });
  for (const a of [['02-leg', '01-produce'], ['02-leg', '02-prose']] as const) {
    mkdirSync(join(legs, ...a, 'artifacts'), { recursive: true });
  }
  writeFileSync(join(legs, '02-leg', '01-produce', 'artifacts', 'alpha-spec.md'), '# Alpha Spec\n\nbody of the alpha spec\n');
  writeFileSync(join(legs, '02-leg', '02-prose', 'artifacts', 'beta-note.md'), '# Beta Note\n\nbody of the beta note\n');
  let rev = 0;
  const leds: Record<string, unknown> = {};
  for (const [id, { nodeJson, eventsContent }] of Object.entries(entries)) {
    rev += 1;
    leds[id] = {
      eventsContent,
      nodeContent: nodeJson,
      eventsSha: blobSha(eventsContent),
      nodeSha: blobSha(nodeJson),
      lastEventAt: eventsContent ? JSON.parse(eventsContent.trim().split('\n').pop() ?? '{}').at ?? '' : '',
      lastRev: rev,
    };
  }
  writeFileSync(join(journey, '.ledger.json'), JSON.stringify({ rev, bootstrappedAt: today, nodes: leds }, null, 2) + '\n');
  return journey;
}

describe('e2e — ANN_STORE session-addressing through the CLI', () => {
  let root: string;
  beforeEach(() => { root = newProject(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('empty/unset ANN_STORE → unchanged ACTIVE behavior (the default project journey)', () => {
    for (const id of ['01-w', '01-w/01-a']) mkdirSync(join(root, '.ann', 'journey', 'legs', id), { recursive: true });
    expect(out(cli(root, ['spawn!', '01-w', CONTRACT('the default journey leg')]))).toContain('spawned 01-w');
    expect(out(cli(root, ['spawn!', '01-w/01-a', CONTRACT('the default journey task')]))).toContain('spawned 01-w/01-a');
    expect(out(cli(root, ['append!', '01-w/01-a', JSON.stringify({ at: '2026-08-19', type: 'activated', note: 'go' })]))).toContain('appended');
    expect(out(cli(root, ['status', '01-w/01-a']))).toContain('active');
  });

  it('reads an ARCHIVED journey when ANN_STORE points at it (status/journey/goal/detail/results/read)', () => {
    const arch = archiveSession(root);
    const base = { ANN_STORE: arch };
    // status — the archive's nodes, not the (empty) active journey
    expect(out(cli(root, ['status'], base))).toContain('02-leg/01-produce');
    expect(out(cli(root, ['journey'], base))).toContain('01-goal done');
    // goal view — met, present
    const goal = out(cli(root, ['goal'], base));
    expect(goal).toContain('verdict: met');
    // detail / results
    expect(out(cli(root, ['detail', '02-leg/01-produce'], base))).toContain('alpha-spec.md');
    expect(out(cli(root, ['results', '02-leg/01-produce'], base))).toContain('abc1234');
    // read <name> — the LEGACY current() path, remapped into the archive's legs/
    const r = cli(root, ['read', 'alpha-spec'], base);
    expect(r.code).toBe(0);
    expect(out(r)).toContain('body of the alpha spec');
    expect(out(r)).toContain('legs/02-leg/01-produce/artifacts/alpha-spec.md');
    // bare-name read gives the same remapped path
    expect(out(cli(root, ['alpha-spec'], base))).toContain('legs/02-leg/01-produce/artifacts/alpha-spec.md');
  });

  it('does NOT attempt docs-manifest reads against an archived journey (only the active project doc would match)', () => {
    const arch = archiveSession(root);
    // the ACTIVE project has a docs/ manifest naming an 'active-only' doc
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'active-only.md'), '# Active Only\n\nlive docs, not in the archive\n');
    writeFileSync(join(root, 'docs', 'manifest.json'), JSON.stringify({ 'active-only': 'docs/active-only.md' }));
    // pointed at the archive, 'active-only' must NOT resolve (no docs/ home there)
    const miss = cli(root, ['read', 'active-only'], { ANN_STORE: arch });
    expect(miss.code).toBe(1);
    expect(out(miss)).toContain("no doc/artifact for 'active-only'");
    // but the archive's own legacy current docs DO resolve, via specs
    const specs = cli(root, ['specs'], { ANN_STORE: arch });
    expect(specs.code).toBe(0);
    expect(out(specs)).toContain('alpha-spec');
    expect(out(specs)).not.toContain('active-only');
  });

  it('reads a NON-ACTIVE PROJECT root through ITS docs manifest (manifest-forward)', () => {
    archiveSession(root); // ensure root has an archive (so roots differ)
    // a second project root — its OWN journey + docs/ manifest
    const other = newProject();
    mkdirSync(join(other, 'docs'), { recursive: true });
    writeFileSync(join(other, 'docs', 'foreign.md'), '# Foreign\n\nbody from the OTHER project\n');
    writeFileSync(join(other, 'docs', 'manifest.json'), JSON.stringify({ foreign: 'docs/foreign.md' }));
    const r = cli(root, ['read', 'foreign'], { ANN_STORE: other });
    expect(r.code).toBe(0);
    expect(out(r)).toContain('body from the OTHER project');
    expect(out(r)).toContain('docs/foreign.md');
    // 'foreign' must NOT resolve from the ACTIVE project (no such doc in its docs/)
    expect(cli(root, ['read', 'foreign']).code).toBe(1);
    rmSync(other, { recursive: true, force: true });
  });

  it('a bad/absent ANN_STORE target fails CLOSED with a named error + exit 1 (never a silent empty tree)', () => {
    const bad = cli(root, ['status'], { ANN_STORE: join(root, 'nope') });
    expect(bad.code).toBe(1);
    expect(out(bad)).toContain('ANN_STORE: bad target');
    // the same named failure hits a journey WRITE (its chokepoint resolves the target)
    const w = cli(root, ['append!', '01-x', '{}'], { ANN_STORE: join(root, 'nope') });
    expect(w.code).toBe(1);
    expect(out(w)).toContain('ANN_STORE: bad target');
  });

  it('a NON-ACTIVE target is READ-ONLY: journey-addressing writes refuse with the named message', () => {
    const arch = archiveSession(root);
    const base = { ANN_STORE: arch };
    const writes: Array<Array<string>> = [
      ['append!', '02-leg/01-produce', '{"at":"2026-08-19","type":"completed"}'],
      ['spawn!', '03-leg', CONTRACT('x')],
      ['submit!', '02-leg/01-produce', 'grill'],
      ['gate!', '02-leg/01-produce', 'confirm', 'accept'],
      ['evidence!', '02-leg/01-produce', 'abc1234'],
      ['complete!', '02-leg/01-produce'],
      ['goal!', 'met'],
      ['run!', '02-leg/01-produce'],
      ['advance!'],
      ['docs', '--write'],
    ];
    for (const args of writes) {
      const r = cli(root, args, base);
      expect(r.code).toBe(1);
      expect(out(r)).toContain('READ-ONLY journey');
      expect(out(r)).toContain('unset ANN_STORE');
    }
  });

  it('config!/cred!/project! stay available even when ANN_STORE is bad or read-only', () => {
    const arch = archiveSession(root);
    // read-only target: config/project still work (they never touch the store)
    expect(cli(root, ['config'], { ANN_STORE: arch }).code).toBe(0);
    expect(cli(root, ['project'], { ANN_STORE: arch }).code).toBe(0);
    // BAD target: config/project also still work — resolution is deferred to store use
    expect(cli(root, ['config'], { ANN_STORE: join(root, 'nope') }).code).toBe(0);
    expect(cli(root, ['project'], { ANN_STORE: join(root, 'nope') }).code).toBe(0);
    expect(cli(root, ['project!', 'use', root], { ANN_STORE: join(root, 'nope') }).code).toBe(0);
  });

  it('the ACTIVE session stays writable when ANN_STORE names it (path-normalized identity)', () => {
    // (a) ANN_STORE = the active project root (kind project — the .ann/journey/legs shape)
    const p1 = newProject();
    mkdirSync(join(p1, '.ann', 'journey', 'legs', '01-live'), { recursive: true });
    const r1 = cli(p1, ['spawn!', '01-live', CONTRACT('live one')], { ANN_STORE: p1 });
    expect(r1.code).toBe(0);
    expect(out(r1)).toContain('spawned 01-live');
    expect(out(cli(p1, ['status', '01-live']))).not.toContain('READ-ONLY');
    rmSync(p1, { recursive: true, force: true });
    // (b) ANN_STORE = the active journey DIR itself (kind journey — the legs/ shape) →
    // same journey-dir identity, still writable
    const p2 = newProject();
    mkdirSync(join(p2, '.ann', 'journey', 'legs', '01-live'), { recursive: true });
    const jd = join(p2, '.ann', 'journey');
    const r2 = cli(p2, ['spawn!', '01-live', CONTRACT('live two')], { ANN_STORE: jd });
    expect(r2.code).toBe(0);
    expect(out(r2)).toContain('spawned 01-live');
    // (c) an ARCHIVE in the same project is still read-only (identity is not "same project")
    archiveSession(p2);
    const arch = join(p2, '.ann', 'archive', 'sessions', 'arch-session', 'journey');
    const ref = cli(p2, ['spawn!', '02-live', CONTRACT('x')], { ANN_STORE: arch });
    expect(ref.code).toBe(1);
    expect(out(ref)).toContain('READ-ONLY journey');
    rmSync(p2, { recursive: true, force: true });
  });

  it('the help/env tail documents ANN_STORE', () => {
    const h = out(cli(root, ['--help']));
    expect(h).toContain('ANN_STORE=<path>');
  });
});
