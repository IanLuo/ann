import { readdirSync, readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { noteWrite } from './write-journal.js';

/**
 * THE IDEA AREA (leg 12/10) — `.ann/ideas/`, ONE FILE PER IDEA.
 *
 * The gap this closes: ann records COMMITMENTS (a contract, its ACs, its scope) and
 * OUTCOMES (evidence, checks), and it has exactly one slot for pending material — the
 * node-scoped `openQuestions`. Nothing held material that is not decided AT ALL: no
 * question yet, no node, no shape. Such material lived in `.agents/` drafts, outside the
 * store, unowned by the engine, with no life cycle and no bridge — which is how the
 * design drafts rot, and where the 12/08 review findings were nearly lost.
 *
 * AN IDEA IS NOT A JOURNEY EVENT. The journey is append-only, hash-checked, derived and
 * one-writer; an idea is mutable, discardable and shapeless — the opposite on every axis.
 * So this module lives BESIDE the journey, never inside it:
 *
 *   · NOTHING IN THE JOURNEY READS IT. `check()` · `verify()` · `next` · `advance()` ·
 *     the context packet · the gate reads must be provably independent of this directory
 *     — no module on those paths imports this one, and a test writes a MALFORMED ideas
 *     file and asserts every one of those reads is byte-identical. That is the hard rule
 *     of the area: the journey's integrity answers never depend on scratch material.
 *   · NO HASH, NO LOCK, NO GATE, NO SCHEMA beyond the fields below — a file that is
 *     wrong is a file the human rewrites, not a refusal.
 *   · PROJECT-LEVEL, OUTLIVING A GOAL SESSION: `.ann/ideas/` sits at the project root,
 *     not in the journey, so an idea can PREDATE the session that promotes it and
 *     survives `goal! archive`. It is TRACKED (project material, never scratch), and the
 *     engine commits its own writes to it (see surface/commit-journey.ts).
 *
 * Deliberately does NOT import from store.ts (store.ts must never import this — the
 * independence above is structural, not a convention).
 */

/** The area's directory name under the project root. */
export const IDEAS_DIRNAME = 'ideas';

/** THE CONFIGURED AGE (AC-4) — how long an unpromoted idea may sit before `list --stale`
 *  names it. A CONSTANT owned here rather than a config leaf: the config class is
 *  journey semantics + end-user knobs (flow/preferences/server — see flow/config.ts and
 *  the resource registry), and this read is a prompt to the human, never a behaviour the
 *  engine branches on. Nothing ACTS on it — see listIdeas: the read IS the product. */
export const IDEA_STALE_DAYS = 14;

/** ONE IDEA. The field set is closed and deliberately tiny: no hash, no lock, no gate,
 *  no provenance chain beyond who typed it. `by` comes from RECORDED_BY (AC-2) and
 *  `promotedTo` records the bridge ONCE (AC-3) — the node never names the idea back. */
export interface Idea {
  id: string;
  text: string;
  /** ISO-8601 — when the idea was written. The age `--stale` measures. */
  created: string;
  /** RECORDED_BY at `idea! add` — the provenance the record carries. */
  by: string;
  /** Optional pointers (files, docs names) the idea cites — never resolved here. */
  refs?: string[];
  /** `open` until the bridge records where it went; `promoted` is terminal. */
  status: 'open' | 'promoted';
  /** The node id `idea! promote` recorded — a HINT, never a dependency: the journey
   *  holds no idea id, so a node renamed after promotion leaves this field stale and
   *  nothing breaks. */
  promotedTo?: string;
}

/** The area's path for a project root. */
export const ideasDir = (root: string): string => join(root, '.ann', IDEAS_DIRNAME);

/** An idea id is a FILENAME — the only shape this module will read, write or delete.
 *  Enforced at every entry point so `idea! drop ../../x` can never leave the area. */
const IDEA_ID = /^[0-9]{8}-[0-9]{6}-[a-z0-9][a-z0-9-]*$/;

export const isIdeaId = (s: string): boolean => IDEA_ID.test(s);

/** The id's slug: the first few words of the text, kebab-cased — enough to recognize an
 *  idea by its filename, bounded so the id stays typeable. */
function slugOf(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 5)
    .join('-')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'idea';
}

/** An idea's id — `<YYYYMMDD>-<HHMMSS>-<slug>`. Sortable, readable, and stable once
 *  written: the id IS the filename, so a rename would be a different idea. */
export function newIdeaId(text: string, now: string): string {
  const t = now.replace(/[^0-9]/g, '');
  return `${t.slice(0, 8)}-${t.slice(8, 14)}-${slugOf(text)}`;
}

const okIdea = (v: unknown): v is Idea => {
  const o = v as Idea;
  return (
    !!o &&
    typeof o === 'object' &&
    typeof o.id === 'string' &&
    typeof o.text === 'string' &&
    typeof o.created === 'string' &&
    typeof o.by === 'string' &&
    (o.status === 'open' || o.status === 'promoted') &&
    (o.refs === undefined || (Array.isArray(o.refs) && o.refs.every((r) => typeof r === 'string'))) &&
    (o.promotedTo === undefined || typeof o.promotedTo === 'string')
  );
};

/** Every idea in the area, ordered by id (which is chronological by construction), plus
 *  the NAMED problems reading found. A malformed file is REPORTED, never silently
 *  dropped: a file the human wrote by hand and got wrong is the one case where an
 *  invisible skip would lose material, so `idea` surfaces it as a problem and keeps
 *  reading the rest. An absent area is empty, not an error. */
export function listIdeas(root: string): { ideas: Idea[]; problems: string[] } {
  const dir = ideasDir(root);
  if (!existsSync(dir)) return { ideas: [], problems: [] };
  const ideas: Idea[] = [];
  const problems: string[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    const id = f.slice(0, -'.json'.length);
    const full = join(dir, f);
    if (!statSync(full).isFile()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(full, 'utf8'));
    } catch (e) {
      problems.push(`idea ${id}: unreadable JSON — ${(e as Error).message}`);
      continue;
    }
    if (!okIdea(parsed)) {
      problems.push(`idea ${id}: not an idea record (id · text · created · by · status)`);
      continue;
    }
    // the FILENAME is the identity: a file whose contents disagree with its name is a
    // hand-edit, and the name wins (it is what a gesture addresses)
    ideas.push(parsed.id === id ? parsed : { ...parsed, id });
  }
  return { ideas, problems };
}

/** ONE idea by id, or undefined. A malformed record reads as absent here — the
 *  gestures that need a well-formed idea refuse BY NAME at the command layer. */
export function readIdea(root: string, id: string): Idea | undefined {
  if (!isIdeaId(id)) return undefined;
  return listIdeas(root).ideas.find((i) => i.id === id);
}

/** Write one idea (atomic: tmp + rename, so a reader never sees a half-written file).
 *  Journals the path so the engine's commit step owns it — an edit commits itself, and
 *  the VERB is the gesture's, so the commit subject says what actually happened. */
export function writeIdea(root: string, idea: Idea, verb: 'added' | 'promoted'): string {
  const dir = ideasDir(root);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${idea.id}.json`);
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(idea, null, 2) + '\n');
  renameSync(tmp, p);
  noteWrite(root, { path: p, node: idea.id, type: `idea-${verb}`, scope: 'ideas' });
  return p;
}

/** Delete one idea's file. Git is the history — this module keeps none. Journals the
 *  DELETION, so the commit step stages the removal like any other change. */
export function deleteIdea(root: string, id: string): void {
  const p = join(ideasDir(root), `${id}.json`);
  rmSync(p);
  noteWrite(root, { path: p, node: id, type: 'idea-dropped', scope: 'ideas' });
}
