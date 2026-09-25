import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDEAS_DIRNAME, IDEA_STALE_DAYS, ideasDir, isIdeaId, newIdeaId, listIdeas, readIdea, writeIdea, deleteIdea, type Idea } from '../ideas.js';
import { takeWritten, clearWritten } from '../write-journal.js';

/**
 * THE IDEA AREA (leg 12/10) — the L0 half. The area is a directory BESIDE the journey:
 * one file per idea, no hash, no lock, no schema beyond the fields. These tests pin the
 * file shape, the id/filename confinement, the named problems a malformed file produces,
 * and the journal note that makes an idea write commit itself.
 */

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ann-ideas-'));
  clearWritten(root);
});
afterEach(() => {
  clearWritten(root);
  rmSync(root, { recursive: true, force: true });
});

const idea = (over: Partial<Idea> = {}): Idea => ({
  id: '20260925-120000-test-idea',
  text: 'a test idea',
  created: '2026-09-25T12:00:00.000Z',
  by: 'tester',
  status: 'open',
  ...over,
});

describe('the area', () => {
  it('lives at <root>/.ann/ideas — beside the journey, never inside it', () => {
    expect(ideasDir('/x')).toBe(join('/x', '.ann', IDEAS_DIRNAME));
    expect(ideasDir('/x')).not.toContain('journey');
  });

  it('an absent area reads as EMPTY, not as an error', () => {
    expect(listIdeas(root)).toEqual({ ideas: [], problems: [] });
    expect(readIdea(root, '20260925-120000-nope')).toBeUndefined();
  });

  it('one file per idea, named by the id, holding exactly the declared fields', () => {
    writeIdea(root, idea(), 'added');
    expect(readdirSync(ideasDir(root))).toEqual(['20260925-120000-test-idea.json']);
    const onDisk = JSON.parse(readFileSync(join(ideasDir(root), '20260925-120000-test-idea.json'), 'utf8'));
    expect(Object.keys(onDisk).sort()).toEqual(['by', 'created', 'id', 'status', 'text']);
    expect(readIdea(root, '20260925-120000-test-idea')).toEqual(idea());
  });

  it('listIdeas orders by id (which is chronological by construction)', () => {
    writeIdea(root, idea({ id: '20260925-120000-b' }), 'added');
    writeIdea(root, idea({ id: '20260924-120000-a' }), 'added');
    expect(listIdeas(root).ideas.map((i) => i.id)).toEqual(['20260924-120000-a', '20260925-120000-b']);
  });

  it('a MALFORMED file is a NAMED problem and the rest still read', () => {
    writeIdea(root, idea(), 'added');
    writeFileSync(join(ideasDir(root), '20260925-130000-bad.json'), '{ not json');
    writeFileSync(join(ideasDir(root), '20260925-140000-wrong.json'), JSON.stringify({ id: 'x' }));
    const r = listIdeas(root);
    expect(r.ideas.map((i) => i.id)).toEqual(['20260925-120000-test-idea']);
    expect(r.problems).toHaveLength(2);
    expect(r.problems[0]).toContain('unreadable JSON');
    expect(r.problems[1]).toContain('not an idea record');
  });

  it('the FILENAME is the identity — contents that disagree lose to the name', () => {
    mkdirSync(ideasDir(root), { recursive: true });
    writeFileSync(
      join(ideasDir(root), '20260925-120000-named.json'),
      JSON.stringify(idea({ id: 'something-else' })),
    );
    expect(readIdea(root, '20260925-120000-named')?.id).toBe('20260925-120000-named');
  });

  it('an idea id is a FILENAME — only the id shape resolves, so nothing escapes the area', () => {
    writeIdea(root, idea(), 'added');
    for (const bad of ['../../etc/passwd', 'a/b', '', '.', '..', 'not-an-id', '20260925-120000-']) {
      expect(isIdeaId(bad)).toBe(false);
      expect(readIdea(root, bad)).toBeUndefined();
    }
    expect(isIdeaId('20260925-120000-a')).toBe(true);
  });

  it('newIdeaId is <date>-<time>-<slug>, bounded and kebab-cased', () => {
    const id = newIdeaId('The Idea Area: ideas, materials & not-yet-decided material!', '2026-09-25T12:34:56.000Z');
    expect(id).toBe('20260925-123456-the-idea-area-ideas-materials');
    expect(isIdeaId(id)).toBe(true);
    expect(newIdeaId('!!!', '2026-09-25T12:34:56.000Z')).toBe('20260925-123456-idea'); // never an empty slug
  });

  it('delete removes the file and leaves the others', () => {
    writeIdea(root, idea({ id: '20260925-120000-a' }), 'added');
    writeIdea(root, idea({ id: '20260925-120000-b' }), 'added');
    deleteIdea(root, '20260925-120000-a');
    expect(existsSync(join(ideasDir(root), '20260925-120000-a.json'))).toBe(false);
    expect(readIdea(root, '20260925-120000-b')).toBeDefined();
  });

  it('the stale age here is only the BUILTIN floor — the configured leaf outranks it (AC-4)', () => {
    expect(IDEA_STALE_DAYS).toBe(14);
  });
});

describe('the write journal', () => {
  it('notes the write with the ideas SCOPE and the gesture verb, so it commits itself', () => {
    writeIdea(root, idea(), 'added');
    expect(takeWritten(root)).toEqual([
      { path: join(ideasDir(root), '20260925-120000-test-idea.json'), node: '20260925-120000-test-idea', type: 'idea-added', scope: 'ideas' },
    ]);
  });

  it('notes a promotion and a DELETION too — a removal is a change like any other', () => {
    writeIdea(root, idea(), 'added');
    takeWritten(root);
    writeIdea(root, idea({ status: 'promoted', promotedTo: '12-operate-loop/10-x' }), 'promoted');
    expect(takeWritten(root)[0].type).toBe('idea-promoted');

    deleteIdea(root, '20260925-120000-test-idea');
    const gone = takeWritten(root);
    expect(gone[0].type).toBe('idea-dropped');
    expect(gone[0].path).toBe(join(ideasDir(root), '20260925-120000-test-idea.json'));
  });
});
