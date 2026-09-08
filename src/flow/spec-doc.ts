import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandError } from '../commands/index.js';
import { GroundingInput } from './steps/shared.js';
import { SPECS_PROFILE } from './spec-grill.js';
import { GrillSession, ResolvedQuestion } from './grill-session.js';
import { docSha, loadDocsManifest, scanDocsDir, writeDocsManifest } from '../store/docs.js';
import { Abilities } from './types.js';

/**
 * L2 · THE SPECS MATERIALIZE PATH — the session-scope driver for the SPECS area (leg 05):
 * runs the SPECS grill on the PORTABLE core (src/flow/grill-session.ts with SPECS_PROFILE —
 * refine-in-session, exhaustion-driven, GO is the human's call), then, on a HUMAN `GO`,
 * synthesizes the converged spec doc deterministically (NO second model call — the write
 * lands the moment the human says GO, from what the grill already converged) and LANDS it
 * as git content at docs/<name>.md (the decided spec home) with the manifest regenerated
 * so the repo's own resolution conventions reach it.
 *
 * TWO MODES over the SAME session shape:
 *   - PRODUCE (the default): grills the SEEDED GOAL — grounded on the goal
 *     (docs/goal.md) + the in-force docs (the docs/ manifest set) — into ONE NEW spec doc
 *     at docs/<name>.md (default `requirements`). The produced doc is the in-force doc
 *     served to future work and amended later.
 *   - AMEND: targets an EXISTING in-force spec doc, grounds on its CURRENT content + the
 *     goal + work context, and on GO OVERWRITES docs/<name>.md in place (the old version
 *     stays in git history) + regenerates the manifest. The session states clearly that it
 *     is AMENDING — specs are LIVING, amendable guidance, unlike the immutable goal (the
 *     doc header says so too).
 *
 * NOTHING IS WRITTEN unless the human says GO: skip/reject/abort → nothing · the ceiling
 * stop → nothing, with an honest note. Provider/adapter failures fail CLOSED ({ok:false})
 * — nothing is fabricated, nothing is written. The write is docs-as-git — landing is NOT a
 * journey/store write, so no L1 command is involved; like goal! seed's goal.md, the driver
 * returns {doc, path, sha} and the OPERATOR git-commits + records the evidence (the session
 * itself does not commit).
 *
 * The landing + reads are the {@link SpecsTarget} seam (the SPECS area's analog of the
 * design area's {@link docsDesignTarget} / the goal area's L1 `goalSeed` write): a future
 * surface command constructs the target over the repo it serves (docsSpecsTarget) and calls
 * the driver; the driver itself never knows the repo.
 */

/** The decided default spec doc name (docs/requirements.md). */
export const DEFAULT_SPEC_NAME = 'requirements';

/** A doc's identity — what a SPECS session returns for the operator to commit. */
export interface SpecDocRef {
  name: string;
  path: string;
  sha: string;
}

/** The reads + writes over one repo's docs/ home that a SPECS session needs — a
 *  repo-agnostic seam (the driver never knows the root). The goal gate and the in-force
 *  set both read through the docs manifest (docs → git: in force = the file at HEAD,
 *  manifest-served). */
export interface SpecsTarget {
  /** The seeded goal (docs/goal.md, resolved via the docs manifest) + its content.
   *  ok:false = no seeded goal (no docs/goal.md — the authored truth the seed writes;
   *  there is no goal leg without it) → refuse before any grill. */
  goal(): { ok: true; doc: SpecDocRef; content: string } | { ok: false; error: CommandError };
  /** Resolve one in-force doc by manifest name + its content. undefined when the name is
   *  not in force (not in the manifest / file absent). */
  read(name: string): { doc: SpecDocRef; content: string } | undefined;
  /** EVERY in-force doc + content (the docs manifest set) — the session's grounding. */
  inForce(): Array<{ doc: SpecDocRef; content: string }>;
  /** Write docs/<name>.md + regenerate the manifest. PRODUCE writes a NEW name (refuses
   *  when the name is already in force — specs are amended, never duplicated); AMEND
   *  overwrites an EXISTING in-force spec doc in place (refuses when absent; refuses the
   *  immutable goal doc). */
  write(name: string, content: string, mode: 'produce' | 'amend'): { ok: true; doc: SpecDocRef } | { ok: false; error: CommandError };
}

/** A landable spec doc name — lowercase letters/digits/hyphens only (the manifest stems
 *  are exactly that shape; docs/<name>.md is the file). Empty when the name cannot land
 *  (fail-closed before anything is written). */
const docNameOf = (name: string): string => {
  const n = (name ?? '').trim();
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(n) ? n : '';
};

/** The real {@link SpecsTarget} over one repo's docs/ home: reads resolve through the
 *  docs manifest (in force = manifest-served, content = the file at HEAD); writes land
 *  docs/<name>.md then regenerate the manifest from the docs/ directory (scanDocsDir) so
 *  resolution and `ann docs --write`/`--check` stay coherent with it. */
export function docsSpecsTarget(root: string): SpecsTarget {
  const readDoc = (name: string): { doc: SpecDocRef; content: string } | undefined => {
    const rel = loadDocsManifest(root)[name];
    if (!rel) return undefined;
    const full = join(root, rel);
    if (!existsSync(full)) return undefined;
    let content: string;
    try {
      content = readFileSync(full, 'utf8');
    } catch {
      return undefined;
    }
    return { doc: { name, path: rel, sha: docSha(content) }, content };
  };
  return {
    goal() {
      const g = readDoc('goal');
      if (!g) {
        return {
          ok: false,
          error: { code: 'no-goal', blocker: 'no seeded goal — docs/goal.md is absent (the authored truth goal! seed writes); seed a goal first' },
        };
      }
      return { ok: true, doc: g.doc, content: g.content };
    },
    read: readDoc,
    inForce() {
      const out: Array<{ doc: SpecDocRef; content: string }> = [];
      for (const name of Object.keys(loadDocsManifest(root)).sort()) {
        const d = readDoc(name);
        if (d) out.push(d);
      }
      return out;
    },
    write(name, content, mode) {
      const present = !!readDoc(name);
      if (mode === 'produce' && present) {
        return { ok: false, error: { code: 'in-force', blocker: `docs/${name}.md is already in force — specs are amended, never duplicated: run spec! ${name} --amend` } };
      }
      if (mode === 'amend' && !present) {
        return { ok: false, error: { code: 'no-spec-doc', blocker: `no in-force spec doc '${name}' to amend — run spec! ${name} (produce) first` } };
      }
      if (name === 'goal') {
        return { ok: false, error: { code: 'goal-immutable', blocker: 'the goal doc (docs/goal.md) is immutable — specs are amendable, the goal is not (change it via goal! seed / goal! archive)' } };
      }
      const dir = join(root, 'docs');
      const path = `docs/${name}.md`;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(root, path), content);
      writeDocsManifest(root, scanDocsDir(root)); // the manifest regenerates from the dir — never hand-maintained
      return { ok: true, doc: { name, path, sha: docSha(content) } };
    },
  };
}

/** ONE LINE — the Spec:/commitment lines are read as whole lines; any newlines the model
 *  put in collapse into spaces so the doc stays one-line-per-commitment. */
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim();
const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Deterministic synthesis: the grill's converged outcome → the SPEC DOC markdown.
 * NO second model call — the spec writes the moment the human says GO, from what the grill
 * already converged. The header says plainly that the doc is LIVING, AMENDABLE guidance
 * (unlike the immutable goal — specs are revised in place, the old version stays in git).
 * The commitments are REAL: the refined spec reading always leads (so the list can never be
 * empty), the claims the final read validated as 'ok' follow as requirements the realized
 * system must keep true, and every resolved HIGH/MEDIUM answer imposes a spec constraint of
 * its own (question → answer). Low-impact answers and open questions are deliberately NOT
 * commitments — they guide the implementation task's shaping, not the spec's bar.
 */
export const specDocFrom = (g: { name: string; statement: string; okClaims: string[]; resolved: ResolvedQuestion[] }): string => {
  const statement = oneLine(g.statement);
  const commitments = new Set<string>([statement]); // the refined spec reading ALWAYS leads
  for (const c of g.okClaims) {
    const line = oneLine(c);
    if (line) commitments.add(line);
  }
  for (const r of g.resolved) {
    if (r.impact === 'low') continue; // only high/medium answers impose spec commitments
    const q = oneLine(r.question);
    const a = oneLine(r.answer);
    if (q && a) commitments.add(`${q} → ${a}`);
  }
  return `# ${cap(g.name)}

> LIVING SPEC — this doc is IN-FORCE guidance and it is AMENDABLE. Unlike the immutable
> goal (docs/goal.md), a spec doc is revised in place by a later SPECS session
> (\`spec! ${g.name} --amend\`); the old version stays in git history.

Spec: ${statement}

Spec commitments (the realized system must keep these true):
${[...commitments].map((c) => `- ${c}`).join('\n')}
`;
};

export interface SpecSessionOptions {
  /** produce (default) grills the seeded goal into a NEW docs/<name>.md; amend revises an
   *  EXISTING in-force spec doc in place. */
  mode?: 'produce' | 'amend';
  /** The spec doc name (docs/<name>.md). Default 'requirements'. */
  name?: string;
  /** Extra grounding the caller holds (e.g. relevant work context) — appended to the
   *  goal + in-force docs the driver assembles. */
  context?: GroundingInput[];
  /** Contract constraints: ACs, scope, non-negotiables. */
  constraints?: string[];
  /** The ANTI-RUNAWAY round ceiling — overrides the profile default so a caller can pin
   *  it (tests exercise the backstop with a small value). Never the UX driver. */
  maxRounds?: number;
  maxDiscussTurns?: number;
}

export type SpecSessionResult =
  | {
      ok: true;
      written: true;
      mode: 'produce' | 'amend';
      name: string;
      path: string;
      sha: string;
      statement: string;
      commitments: string[];
      rounds: number;
    }
  | { ok: true; written: false; verdict: 'revise' | 'reject'; note: string }
  | { ok: false; error: CommandError };

/**
 * The session-scope driver — the whole SPECS session as a VALUE (guarded-write style, no
 * throw-as-flow): the mode/name guards + the seeded-goal gate run BEFORE any provider call
 * (a mismatched run never spends a session that cannot land); then the SPECS grill on the
 * portable core over the goal/in-force grounding; on the human's GO the converged spec is
 * materialized through the target. Returns the written doc's identity on GO; on
 * skip/reject/abort it returns written:false with a human note; on the anti-runaway ceiling
 * stop it returns written:false (the driver's session already showed the full summary) with
 * an honest note; provider/guard failures return the L1-shaped error the surface renders.
 */
export const runSpecSession = async (
  target: SpecsTarget,
  abilities: Abilities,
  opts: SpecSessionOptions = {},
): Promise<SpecSessionResult> => {
  const mode: 'produce' | 'amend' = opts.mode === 'amend' ? 'amend' : 'produce';
  const name = docNameOf(opts.name ?? DEFAULT_SPEC_NAME);
  if (!name) {
    return { ok: false, error: { code: 'invalid-name', blocker: `no landable spec doc name (gave '${opts.name ?? ''}') — use lowercase letters/digits/hyphens, no extension (e.g. ${DEFAULT_SPEC_NAME})` } };
  }
  if (name === 'goal') {
    return { ok: false, error: { code: 'goal-immutable', blocker: 'the goal doc (docs/goal.md) is immutable — specs are amendable, the goal is not (change it via goal! seed / goal! archive)' } };
  }

  // GUARD — a SPECS session grills the SEEDED goal; no docs/goal.md → refuse with the WHY,
  // before any provider call (dogfoodable: the refusal needs no provider wiring).
  const goal = target.goal();
  if (!goal.ok) return { ok: false, error: goal.error };

  // The addressed doc must fit the mode — produce needs a NEW name, amend an EXISTING
  // in-force doc. Both pre-checked here so a wasted session is never spent on a mismatch.
  const current = target.read(name);
  if (mode === 'amend' && !current) {
    return { ok: false, error: { code: 'no-spec-doc', blocker: `no in-force spec doc '${name}' to amend — run spec! ${name} (produce) first` } };
  }
  if (mode === 'produce' && current) {
    return { ok: false, error: { code: 'in-force', blocker: `docs/${name}.md is already in force — specs are amended, never duplicated: run spec! ${name} --amend` } };
  }

  // The draft — produce starts from the SEEDED GOAL (the grill reshapes it into spec
  // language at the SPECS boundary); amend starts from the CURRENT in-force doc content.
  const subject = mode === 'amend' && current ? current.content : goal.content;

  // Grounding — the goal + every OTHER in-force doc the spec must stay consistent with
  // (the addressed doc is the draft, never its own context; on a produce the goal IS the
  // draft, so it is not double-listed). Caller-held work context appends.
  const grounding: GroundingInput[] = [
    ...(mode === 'amend' ? [{ label: 'goal', text: goal.content, sourceType: 'documentation' as const }] : []),
    ...target
      .inForce()
      .filter((d) => d.doc.name !== name && d.doc.name !== 'goal')
      .map((d) => ({ label: d.doc.name, text: d.content, sourceType: 'documentation' as const })),
    ...(opts.context ?? []),
  ];

  // SESSION preamble — the human sees, before round 1, what this run is. An AMEND states
  // clearly that it is revising an existing in-force doc (specs are living — the goal is not).
  await abilities.interact.present(
    mode === 'amend'
      ? `── SPECS session · AMEND ──\nAmending the existing in-force spec docs/${name}.md — its current content grounds this session, and a GO REWRITES it in place (the old version stays in git history). Specs are LIVING, amendable guidance — unlike the immutable goal.`
      : `── SPECS session · produce ──\nGrilling the seeded goal into the NEW in-force spec docs/${name}.md. Specs are LIVING, amendable guidance — a later run (spec! ${name} --amend) revises this doc in place; git keeps every old version.`,
  );

  // GRILL — the dedicated SPECS grill (the portable core + SPECS_PROFILE; each round
  // ANSWER → LLM RESPONSE → DISCUSS → DECISION; GO/dig more/refine/skip). Provider/
  // adapter failures fail CLOSED here (same as `ann run!`): the session returns ok:false
  // and nothing is written.
  const r = await new GrillSession(abilities, SPECS_PROFILE).run({
    subject,
    context: grounding,
    ...(opts.constraints?.length ? { constraints: opts.constraints } : {}),
    ...(opts.maxRounds !== undefined ? { maxRounds: opts.maxRounds } : {}),
    ...(opts.maxDiscussTurns !== undefined ? { maxDiscussTurns: opts.maxDiscussTurns } : {}),
  });
  if (!r.ok) return { ok: false, error: r.error };
  if (r.verdict !== 'solid') {
    return { ok: true, written: false, verdict: r.verdict === 'exhausted' ? 'revise' : 'reject', note: r.note };
  }

  // GO — write only on the HUMAN's GO (a round with remaining unknowns that the human
  // accepts still writes; skipping/aborting never does).
  const doc = specDocFrom({ name, statement: r.statement, okClaims: r.okClaims, resolved: r.resolved });
  const written = target.write(name, doc, mode);
  if (!written.ok) return { ok: false, error: written.error };
  return {
    ok: true,
    written: true,
    mode,
    name,
    path: written.doc.path,
    sha: written.doc.sha,
    statement: oneLine(r.statement),
    commitments: doc
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2)),
    rounds: r.rounds,
  };
};
