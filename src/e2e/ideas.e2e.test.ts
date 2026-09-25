import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

/**
 * E2E — THE IDEA AREA (leg 12/10), driven through the REAL binary.
 *
 * PROVEN HERE (AC-1..AC-4):
 *   · the AREA: `.ann/ideas/`, one file per idea, project-level and TRACKED — and the
 *     engine commits its own write to it (an edit commits itself);
 *   · THE HARD RULE, tested the way the AC states it: a MALFORMED ideas file changes
 *     NOTHING in the journey — `check` · `verify` · `next` · `advance!` · `packet` ·
 *     `confirm` · `status` · `journey` are BYTE-IDENTICAL with and without it, because
 *     the journey never reads the area at all;
 *   · THE GESTURES: `idea! add` · `idea list` (default · --all · --stale) · `idea! promote`
 *     · `idea! drop`, with the NAMED failures and ZERO writes on each;
 *   · THE BRIDGE, RECORDED ONCE: promotion marks the idea `promoted → <node id>` and the
 *     drafted contract's intent names the idea id — while the JOURNEY NEVER NAMES THE IDEA
 *     BACK (asserted by grepping the whole journey tree for the id), and `promote` never
 *     spawns;
 *   · NOTHING ROTS: `--stale` names an old unpromoted idea and nothing deletes it.
 *
 * `npm run build` first — we spawn dist.
 */

const REPO = process.cwd();
const CLI = join(REPO, 'dist', 'surface', 'cli.js');
const HERMETIC = { ANN_LLM_BASE_URL: 'http://127.0.0.1:1/v1' };

const LEG = '01-alpha';
const FIRST = `${LEG}/01-first`;
const CONTRACT = (intent: string) =>
  JSON.stringify({ intent, acceptanceCriteria: [`${intent} is done`], workType: 'implementation' });

interface CliResult { code: number | null; stdout: string; stderr: string }
function cli(root: string, args: string[], env: Record<string, string> = {}): CliResult {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: { ...process.env, ...HERMETIC, ANN_PROJECT: root, RECORDED_BY: 'e2e', ANN_CONFIG: join(root, '.e2e-config.json'), ...env },
    encoding: 'utf8',
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const git = (root: string, args: string[]): string =>
  execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
/** `git grep` — exit 1 means NO MATCH, which is a result here, not a failure. */
const gitGrep = (root: string, needle: string): string => {
  const r = spawnSync('git', ['-C', root, 'grep', '-l', needle, '--', '.ann/journey'], { encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git grep failed: ${r.stderr}`);
  return r.stdout ?? '';
};
const commit = (root: string, message: string): void => {
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', message]);
};
const ideasDir = (root: string): string => join(root, '.ann', 'ideas');
const ideaFiles = (root: string): string[] => (existsSync(ideasDir(root)) ? readdirSync(ideasDir(root)).sort() : []);
/** The id a gesture just printed (`added <id>`), or the only idea on disk. */
const onlyIdeaId = (root: string): string => {
  const files = ideaFiles(root);
  expect(files).toHaveLength(1);
  return files[0].replace(/\.json$/, '');
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ann-e2e-ideas-'));
  mkdirSync(join(root, '.ann', 'journey', 'legs'), { recursive: true });
  cpSync(join(REPO, '.ann', 'rules'), join(root, '.ann', 'rules'), { recursive: true });
  symlinkSync('.ann/journey', join(root, 'journey'));
  symlinkSync('.ann/rules', join(root, 'rules'));
  writeFileSync(join(root, '.e2e-config.json'), '{}');
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'e2e']);
  git(root, ['config', 'user.email', 'e2e@ann.test']);
  // a journey with one leg + one task, GRILLED — so the reads have real content, and the
  // task is not yet submitted at confirm (the boundary `advance!` lands on)
  cli(root, ['spawn!', LEG, CONTRACT('the alpha leg')]);
  cli(root, ['spawn!', FIRST, CONTRACT('do the thing')]);
  cli(root, ['submit!', FIRST, 'grill']);
  cli(root, ['gate!', FIRST, 'grill', 'accept', 'the contract is right']);
  commit(root, 'the fixture journey');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the area', () => {
  it('holds one file per idea, and the engine COMMITS its own write', () => {
    const r = cli(root, ['idea!', 'add', 'the idea area should exist']);
    expect(r.code).toBe(0);
    const id = onlyIdeaId(root);
    expect(r.stdout).toContain(`added ${id}`);

    const rec = JSON.parse(readFileSync(join(ideasDir(root), `${id}.json`), 'utf8'));
    expect(rec).toMatchObject({ id, text: 'the idea area should exist', by: 'e2e', status: 'open' });
    expect(Object.keys(rec).sort()).toEqual(['by', 'created', 'id', 'status', 'text']);

    // committed, by the engine, with the ideas noun — an edit commits itself
    expect(git(root, ['status', '--porcelain']).trim()).toBe('');
    expect(git(root, ['log', '-1', '--format=%s']).trim()).toBe(`ideas: ${id} added (e2e)`);
  });

  it('is PROJECT-LEVEL — outside the journey, and never read by it', () => {
    cli(root, ['idea!', 'add', 'somewhere else']);
    expect(existsSync(ideasDir(root))).toBe(true);
    expect(existsSync(join(root, '.ann', 'journey', 'ideas'))).toBe(false);
  });

  it('add records --refs, and an empty text is a NAMED failure with ZERO writes', () => {
    cli(root, ['idea!', 'add', 'cite the spec', '--refs', 'core-design,gate-cadence']);
    const rec = JSON.parse(readFileSync(join(ideasDir(root), `${onlyIdeaId(root)}.json`), 'utf8'));
    expect(rec.refs).toEqual(['core-design', 'gate-cadence']);

    const before = ideaFiles(root);
    const bad = cli(root, ['idea!', 'add', '   ']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('idea-empty-text');
    expect(ideaFiles(root)).toEqual(before);
  });
});

describe('the reads — list · --all · --stale', () => {
  it('default lists the OPEN ideas with their age; --all adds the promoted ones', () => {
    cli(root, ['idea!', 'add', 'an open one']);
    const open = onlyIdeaId(root);
    cli(root, ['idea!', 'promote', open, '12-operate-loop/99-implementation-x']);
    cli(root, ['idea!', 'add', 'another open one']);

    const plain = cli(root, ['idea', 'list']).stdout;
    expect(plain).not.toContain(open);
    expect(plain).toContain('another-open-one');
    expect(cli(root, ['idea']).stdout).toBe(plain); // the bare form is the same read

    const all = cli(root, ['idea', 'list', '--all']).stdout;
    expect(all).toContain(open);
    expect(all).toContain('promoted → 12-operate-loop/99-implementation-x');
  });

  it('--stale names the OLD unpromoted ideas — and nothing deletes them', () => {
    cli(root, ['idea!', 'add', 'a recent idea']);
    const old = '20260801-120000-a-stale-idea';
    writeFileSync(
      join(ideasDir(root), `${old}.json`),
      JSON.stringify({ id: old, text: 'a stale idea', created: '2026-08-01T12:00:00.000Z', by: 'human', status: 'open' }) + '\n',
    );
    commit(root, 'a hand-written old idea');

    const stale = cli(root, ['idea', 'list', '--stale']).stdout;
    expect(stale).toContain(old);
    expect(stale).not.toContain('a recent idea');

    // the read IS the product: the file is still there afterwards
    expect(existsSync(join(ideasDir(root), `${old}.json`))).toBe(true);
    expect(cli(root, ['idea!', 'drop', old]).code).toBe(0);
  });
});

describe('the bridge — promote drafts, records once, and never spawns', () => {
  it('records `promoted → <node id>`, names the idea in the draft, and writes NO journey',
    () => {
      cli(root, ['idea!', 'add', 'give ideas a home with a life cycle', '--refs', 'core-design']);
      const id = onlyIdeaId(root);
      const nodesBefore = cli(root, ['status']).stdout;

      const target = '12-operate-loop/99-implementation-idea-area';
      const r = cli(root, ['idea!', 'promote', id, target]);
      expect(r.code).toBe(0);
      const draft = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'), r.stdout.lastIndexOf('}') + 1));
      expect(draft.id).toBe(target);
      expect(draft.contract.intent).toContain(id); // the contract names the idea…
      expect(draft.contract.acceptanceCriteria.length).toBeGreaterThan(0);

      const rec = JSON.parse(readFileSync(join(ideasDir(root), `${id}.json`), 'utf8'));
      expect(rec).toMatchObject({ status: 'promoted', promotedTo: target });

      // …and the JOURNEY NEVER NAMES THE IDEA BACK: promote spawned nothing
      expect(cli(root, ['status']).stdout).toBe(nodesBefore);
      expect(gitGrep(root, id).trim()).toBe('');
    });

  it('refuses a SECOND promotion and a drop of a promoted idea — the bridge is recorded once', () => {
    cli(root, ['idea!', 'add', 'promote me once']);
    const id = onlyIdeaId(root);
    cli(root, ['idea!', 'promote', id, '12-operate-loop/99-implementation-x']);

    const again = cli(root, ['idea!', 'promote', id, '12-operate-loop/98-implementation-y']);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('idea-already-promoted');

    const drop = cli(root, ['idea!', 'drop', id]);
    expect(drop.code).toBe(1);
    expect(drop.stderr).toContain('idea-promoted');
    expect(existsSync(join(ideasDir(root), `${id}.json`))).toBe(true);
  });
});

describe('drop', () => {
  it('deletes the file, commits the deletion, and an unknown id writes nothing', () => {
    cli(root, ['idea!', 'add', 'throw me away']);
    const id = onlyIdeaId(root);

    const r = cli(root, ['idea!', 'drop', id]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`dropped ${id}`);
    expect(ideaFiles(root)).toEqual([]);
    expect(git(root, ['status', '--porcelain']).trim()).toBe('');
    expect(git(root, ['log', '-1', '--format=%s']).trim()).toBe(`ideas: ${id} dropped (e2e)`);
  });

  it('refuses an unknown id and a non-id, with zero writes', () => {
    for (const bad of ['20260101-000000-nope', 'not-an-id', '../../etc/passwd']) {
      const r = cli(root, ['idea!', 'drop', bad]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/idea-(not-found|no-id)/);
    }
    const p = cli(root, ['idea!', 'promote', '20260101-000000-nope', 'x/01-y']);
    expect(p.code).toBe(1);
    expect(p.stderr).toContain('idea-not-found');
    expect(existsSync(ideasDir(root))).toBe(false);
  });

  it('an unknown gesture and a stray flag are usage errors, never writes', () => {
    expect(cli(root, ['idea!', 'frobnicate']).code).toBe(2);
    expect(cli(root, ['idea', 'list', '--bogus']).code).toBe(2);
    expect(existsSync(ideasDir(root))).toBe(false);
  });
});

describe('AC-4 — the CONFIGURED age comes from the config class', () => {
  /** Re-date the only idea N days back, and commit the edit like a human's own change. */
  const ageIdea = (days: number): string => {
    const id = onlyIdeaId(root);
    const p = join(ideasDir(root), `${id}.json`);
    const rec = JSON.parse(readFileSync(p, 'utf8'));
    writeFileSync(p, JSON.stringify({ ...rec, created: new Date(Date.now() - days * 86_400_000).toISOString() }) + '\n');
    commit(root, 're-date the idea');
    return p;
  };
  const registry = (ideas: unknown): void => {
    mkdirSync(join(root, '.ann', 'rules', 'config'), { recursive: true });
    writeFileSync(join(root, '.ann', 'rules', 'config', 'default.json'), JSON.stringify({ registry: 'config', ideas }));
  };

  it('the project registry sets the threshold --stale reads — and nothing is deleted either way', () => {
    cli(root, ['idea!', 'add', 'two days old']);
    const p = ageIdea(2);

    // builtin floor (14) → not stale
    expect(cli(root, ['idea', 'list', '--stale']).stdout).not.toContain('two-days-old');

    registry({ staleDays: 1 });
    expect(cli(root, ['idea', 'list', '--stale']).stdout).toContain('two-days-old');
    expect(existsSync(p)).toBe(true); // the read IS the product — still on disk
  });

  it('a broken threshold is NAMED in the read, which still answers (fail-closed, never silent)', () => {
    cli(root, ['idea!', 'add', 'anything']);
    registry({ staleDays: 'soon' });

    const r = cli(root, ['idea', 'list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('config ideas.staleDays');
    expect(r.stdout).toContain('expected an integer');
  });
});

describe('the CROSS-FOLDER rule — the area is refused under a non-active store', () => {
  it('idea! refuses rather than writing the ACTIVE project while reading an archive', () => {
    const other = mkdtempSync(join(tmpdir(), 'ann-e2e-other-'));
    try {
      mkdirSync(join(other, '.ann', 'journey', 'legs'), { recursive: true });
      cpSync(join(REPO, '.ann', 'rules'), join(other, '.ann', 'rules'), { recursive: true });
      writeFileSync(join(other, '.e2e-config.json'), '{}');
      cli(other, ['spawn!', LEG, CONTRACT('the other leg')]);

      const r = cli(root, ['idea!', 'add', 'must not land'], { ANN_STORE: other });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('ANN_STORE points at a READ-ONLY journey');
      expect(r.stderr).toContain('idea!');
      expect(existsSync(ideasDir(root))).toBe(false);
      expect(existsSync(join(other, '.ann', 'ideas'))).toBe(false);

      // the READ is unaffected — it names the active project's ideas, as it always did
      expect(cli(root, ['idea', 'list'], { ANN_STORE: other }).code).toBe(0);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('THE HARD RULE — nothing in the journey reads the area', () => {
  it('a MALFORMED ideas file leaves every journey read BYTE-IDENTICAL', () => {
    const reads: string[][] = [
      ['check'],
      ['verify'],
      ['next'],
      ['advance!'],
      ['status'],
      ['packet', FIRST],
      ['confirm', FIRST],
      ['journey', FIRST],
      ['brief', FIRST],
    ];
    const before = reads.map((a) => {
      const r = cli(root, a, { ANN_NO_COMMIT: '1' });
      return `${r.code}\n${r.stdout}\n${r.stderr}`;
    });

    // garbage where the area should be — unparseable JSON, plus a file that is not an idea
    mkdirSync(ideasDir(root), { recursive: true });
    writeFileSync(join(ideasDir(root), '20260925-120000-malformed.json'), ' { this is not json at all');
    writeFileSync(join(ideasDir(root), '20260925-130000-wrong.json'), JSON.stringify({ totally: 'wrong' }));

    const after = reads.map((a) => {
      const r = cli(root, a, { ANN_NO_COMMIT: '1' });
      return `${r.code}\n${r.stdout}\n${r.stderr}`;
    });
    for (let i = 0; i < reads.length; i++) {
      expect(after[i], `ann ${reads[i].join(' ')} must not read .ann/ideas/`).toBe(before[i]);
    }

    // …while the IDEA READ itself does see them, NAMED — the corruption is not silent
    const listed = cli(root, ['idea', 'list']);
    expect(listed.stdout).toContain('unreadable JSON');
    expect(listed.stdout).toContain('not an idea record');
  });
});
