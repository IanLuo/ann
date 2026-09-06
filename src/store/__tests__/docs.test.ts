import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { blobSha, stripMarkers } from '../sha.js';
import { docNameFromFile, scanDocsDir, loadDocsManifest, writeDocsManifest, docsIndexFresh, docSha, MANIFEST_FILE, DESIGN_HOME } from '../docs.js';

// Fixture helpers: a disposable repo (store legs + optional docs/).
let root: string;
function makeRepo() {
  root = mkdtempSync(join(tmpdir(), 'ann-docs-'));
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
/** Write a doc file under docs/ + regenerate the manifest from the dir (makeDocs). */
function makeDocs(files: Record<string, string>) {
  mkdirSync(join(root, 'docs'), { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, 'docs', name), content);
  writeDocsManifest(root, scanDocsDir(root));
}
const GOAL_MD = '# Goal\n\nGoal: build the thing\n\nSuccess criteria:\n- it works\n';

describe('docs.ts — the docs→git home + the manifest (docNameFromFile)', () => {
  it('derives the logical name as the filename stem (any extension)', () => {
    expect(docNameFromFile('goal.md')).toBe('goal');
    expect(docNameFromFile('companion-guide.html')).toBe('companion-guide');
    expect(docNameFromFile('functional-spec.md')).toBe('functional-spec');
  });
});

describe('docs.ts — scanDocsDir (the manifest source of truth)', () => {
  beforeEach(() => { makeRepo(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('maps top-level docs files to {logical name: docs/<file>}, excluding the manifest', () => {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'goal.md'), GOAL_MD);
    writeFileSync(join(root, 'docs', 'companion-guide.html'), '<h1>guide</h1>');
    writeFileSync(join(root, 'docs', MANIFEST_FILE), '{}');
    mkdirSync(join(root, 'docs', 'nested')); // subdirs other than docs/design are not docs
    writeFileSync(join(root, 'docs', 'nested', 'x.md'), 'x');
    expect(scanDocsDir(root)).toEqual({
      goal: 'docs/goal.md',
      'companion-guide': 'docs/companion-guide.html',
    });
  });

  it('indexes the docs/design home (the decided design-brief landing) under design/<stem> — namespaced, never colliding with top-level docs', () => {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'goal.md'), GOAL_MD);
    mkdirSync(join(root, 'docs', DESIGN_HOME), { recursive: true });
    writeFileSync(join(root, 'docs', DESIGN_HOME, 'ann-ui.md'), '# design');
    writeFileSync(join(root, 'docs', DESIGN_HOME, 'moodboard.png'), 'img');
    // a same-stem top-level doc does NOT collide with the design brief: the design
    // brief resolves as design/ann-ui, the top-level doc stays ann-ui
    writeFileSync(join(root, 'docs', 'ann-ui.md'), '# top-level ann-ui');
    mkdirSync(join(root, 'docs', DESIGN_HOME, 'nested')); // deeper than one level → not a doc
    writeFileSync(join(root, 'docs', DESIGN_HOME, 'nested', 'deep.md'), 'x');
    expect(scanDocsDir(root)).toEqual({
      'ann-ui': 'docs/ann-ui.md',
      goal: 'docs/goal.md',
      'design/ann-ui': 'docs/design/ann-ui.md',
      'design/moodboard': 'docs/design/moodboard.png',
    });
  });

  it('a design brief is reachable by the repo resolution conventions: the manifest regenerates from the dir and resolveDoc serves it', () => {
    makeDocs({ 'goal.md': GOAL_MD });
    mkdirSync(join(root, 'docs', DESIGN_HOME), { recursive: true });
    const brief = '# Design Brief\n\nBrief: a portable design grill area.\n';
    writeFileSync(join(root, 'docs', DESIGN_HOME, 'grill-area.md'), brief);
    // a design brief added WITHOUT regen is reported missing (the `ann docs --write` state)
    expect(docsIndexFresh(root)).toMatchObject({ fresh: false, missing: ['design/grill-area'] });
    writeDocsManifest(root, scanDocsDir(root)); // regen (as `ann docs --write` does) → resolvable + fresh
    expect(docsIndexFresh(root).fresh).toBe(true);
    const s = new Store(root);
    expect(s.resolveDoc('design/grill-area')).toMatchObject({ name: 'design/grill-area', path: 'docs/design/grill-area.md' });
    expect(loadDocsManifest(root)['design/grill-area']).toBe('docs/design/grill-area.md');
  });

  it('returns {} when docs/ is absent', () => {
    expect(scanDocsDir(root)).toEqual({});
  });
});

describe('docs.ts — loadDocsManifest / writeDocsManifest / docsIndexFresh', () => {
  beforeEach(() => { makeRepo(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('round-trips a manifest (atomic write, sorted read)', () => {
    makeDocs({ 'goal.md': GOAL_MD, 'spec.md': '# Spec' });
    const manifest = loadDocsManifest(root);
    expect(manifest).toEqual({ goal: 'docs/goal.md', spec: 'docs/spec.md' });
    expect(existsSync(join(root, 'docs', MANIFEST_FILE))).toBe(true);
  });

  it('returns {} for an absent or corrupt manifest (never throws)', () => {
    expect(loadDocsManifest(root)).toEqual({});
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', MANIFEST_FILE), 'not json{');
    expect(loadDocsManifest(root)).toEqual({});
  });

  it('freshness: synced index is fresh; a new doc file (no regen) is missing; a stale entry points at nothing', () => {
    makeDocs({ 'goal.md': GOAL_MD });
    expect(docsIndexFresh(root)).toEqual({ fresh: true, missing: [], stale: [] });
    writeFileSync(join(root, 'docs', 'spec.md'), '# Spec'); // added without regen
    expect(docsIndexFresh(root)).toMatchObject({ fresh: false, missing: ['spec'] });
    writeDocsManifest(root, scanDocsDir(root)); // regen → fresh again
    expect(docsIndexFresh(root).fresh).toBe(true);
    // hand-edit: an entry with no file on disk
    writeDocsManifest(root, { ...scanDocsDir(root), ghost: 'docs/ghost.md' });
    expect(docsIndexFresh(root)).toMatchObject({ fresh: false, stale: ['ghost'] });
  });
});

describe('Store.resolveDoc — the doc resolution (manifest → disk → content sha)', () => {
  beforeEach(() => { makeRepo(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('resolves a manifest name to the on-disk file + its marker-stripped content sha', () => {
    makeDocs({ 'spec.md': '<!-- specs:locked:abc1234 -->\n# The Spec\n\nbody' });
    const s = new Store(root);
    expect(s.resolveDoc('spec')).toEqual({
      name: 'spec',
      path: 'docs/spec.md',
      sha: blobSha(stripMarkers('# The Spec\n\nbody')).slice(0, 7),
    });
  });

  it('returns undefined for an unindexed name, a missing file, and a doc-less repo (the legacy fallback stays current())', () => {
    const s = new Store(root);
    expect(s.resolveDoc('spec')).toBeUndefined(); // no docs/ at all
    // legacy current() still resolves an artifact-locked doc (the reader kept for history)
    writeNode('01-goal/01-a', {}, [ev('artifact-locked', { artifact: { name: 'spec', path: 'journey/legs/01-goal/01-a/artifacts/spec.md', lockSha: 'abc1234' } })]);
    mkdirSync(join(nodeDir('01-goal/01-a'), 'artifacts'), { recursive: true });
    writeFileSync(join(nodeDir('01-goal/01-a'), 'artifacts', 'spec.md'), '# Spec');
    const s2 = new Store(root);
    expect(s2.resolveDoc('spec')).toBeUndefined();
    expect(s2.current('spec')).toMatchObject({ producer: '01-goal/01-a', sha: 'abc1234' });
  });

  it('contractProblems resolves a requiredInput through the manifest (F-AC19 forward path)', () => {
    makeDocs({ 'spec.md': '# The Spec' });
    const s = new Store(root);
    expect(s.contractProblems({ intent: 'x', acceptanceCriteria: ['AC1'], requiredInputs: ['spec'] })).toEqual([]);
    expect(s.contractProblems({ intent: 'x', acceptanceCriteria: ['AC1'], requiredInputs: ['no-such-doc'] })).toEqual([
      "requiredInput 'no-such-doc' does not resolve (a docs manifest name or a current artifact's logical name)",
    ]);
  });

  it('docSha reports the 7-hex content sha over marker-stripped content', () => {
    expect(docSha('# body')).toBe(blobSha('# body').slice(0, 7));
    expect(docSha('<!-- specs:locked:abc1234 -->\n# body')).toBe(blobSha('# body').slice(0, 7));
  });
});
