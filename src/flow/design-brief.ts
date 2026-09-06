import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CommandError } from '../commands/index.js';
import { GroundingInput } from './steps/shared.js';
import { DESIGN_PROFILE } from './design-grill.js';
import { GrillSession, ResolvedQuestion } from './grill-session.js';
import { DESIGN_HOME, scanDocsDir, writeDocsManifest } from '../store/docs.js';
import { Abilities, InteractAbort } from './types.js';

/**
 * L2 · THE DESIGN-BRIEF MATERIALIZE PATH — the session-scope driver for the DESIGN area
 * (AC-3/AC-4): runs the DESIGN grill on the PORTABLE core (src/flow/grill-session.ts with
 * DESIGN_PROFILE — refine-in-session, exhaustion-driven, GO is the human's call), then,
 * on a HUMAN `GO`, synthesizes the converged design brief deterministically (NO second
 * model call — the seed lands the moment the human says GO, from what the grill already
 * converged) and LANDS it as git content at docs/design/<name>.md (the decided design-brief
 * home) with the manifest regenerated so the repo's own resolution conventions reach it.
 *
 * NOTHING IS LANDED unless the human says GO: skip/reject/abort → nothing · the ceiling
 * stop → nothing, with an honest note. Provider/adapter failures fail CLOSED ({ok:false})
 * — nothing is fabricated, nothing is landed.
 *
 * The landing is the {@link DesignBriefTarget} seam (the design area's analog of the
 * goal area's L1 `goalSeed` write): a future surface command constructs the target over
 * the repo it serves (docsDesignTarget) and calls the driver; the driver itself never
 * knows the repo. docs/design files are GIT content (docs-as-git) — landing is NOT a
 * journey/store write, so no L1 command is involved.
 */

export interface DesignBriefTarget {
  /** Land the converged brief as git content under docs/design/ + make it resolvable
   *  (regenerate the manifest). Returns the repo-root-relative path, or a fail-closed
   *  error — a name that cannot land NEVER lands silently. */
  land(name: string, content: string): { ok: true; path: string } | { ok: false; error: CommandError };
}

/** The real {@link DesignBriefTarget} over one repo's docs/ home: writes
 *  docs/design/<slug>.md, then regenerates the manifest from the docs/ directory
 *  (scanDocsDir indexes docs/design under `design/<stem>`), so the brief is reachable
 *  by resolution and `ann docs --write`/`--check` stay coherent with it. */
export function docsDesignTarget(root: string): DesignBriefTarget {
  return {
    land(name, content) {
      const slug = slugFrom(name);
      if (!slug) return { ok: false, error: { code: 'invalid-name', blocker: `design brief: '${name}' is not a valid brief name (lowercase letters/digits/hyphens, no extension) — nothing was landed` } };
      const dir = join(root, 'docs', DESIGN_HOME);
      const path = `docs/${DESIGN_HOME}/${slug}.md`;
      if (existsSync(join(root, path))) {
        return { ok: false, error: { code: 'name-taken', blocker: `design brief: docs/${DESIGN_HOME}/${slug}.md already exists — briefs accumulate by name; pick a new name or a fresh direction, nothing was overwritten` } };
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(root, path), content);
      writeDocsManifest(root, scanDocsDir(root)); // the manifest regenerates from the dir — never hand-maintained
      return { ok: true, path };
    },
  };
}

/** Deterministic name → brief slug (lowercase, hyphen-joined, no extension/path). Empty
 *  when the name cannot become a safe slug (fail-closed before anything lands). */
export const slugFrom = (name: string): string => {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) ? slug : '';
};

/** ONE LINE — the direction/commitment lines are read as whole lines; any newlines the
 *  model put in collapse into spaces so the brief stays one-line-per-commitment. */
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, ' ').trim();

/**
 * Deterministic synthesis: the grill's converged outcome → the DESIGN BRIEF markdown.
 * NO second model call — the brief lands the moment the human says GO, from what the
 * grill already converged. The commitments are REAL: the refined direction sentence
 * always leads (so the list can never be empty), the claims the final read validated as
 * 'ok' follow as commitments the design must keep true, and every resolved HIGH/MEDIUM
 * answer imposes a design constraint of its own (question → answer). Low-impact answers
 * and open questions are deliberately NOT commitments — they guide the design task's
 * shaping, not the brief's bar.
 */
export const designBriefFrom = (g: { direction: string; okClaims: string[]; resolved: ResolvedQuestion[] }): string => {
  const direction = oneLine(g.direction);
  const commitments = new Set<string>([direction]); // the refined direction ALWAYS lands first
  for (const c of g.okClaims) {
    const line = oneLine(c);
    if (line) commitments.add(line);
  }
  for (const r of g.resolved) {
    if (r.impact === 'low') continue; // only high/medium answers impose brief commitments
    const q = oneLine(r.question);
    const a = oneLine(r.answer);
    if (q && a) commitments.add(`${q} → ${a}`);
  }
  return `# Design Brief

Brief: ${direction}

Design commitments (the design must keep these true):
${[...commitments].map((c) => `- ${c}`).join('\n')}
`;
};

export interface DesignBriefOptions {
  /** The rough design direction to grill (a rough idea is fine — the grill sharpens it).
   *  Absent/blank → gathered from the human channel. */
  idea?: string;
  /** Pre-existing grounding (e.g. the goal/requirements the direction must work within). */
  context?: GroundingInput[];
  /** Contract constraints: ACs, scope, non-negotiables. */
  constraints?: string[];
  /** The brief's slug/name (docs/design/<name>.md). Absent → derived from the idea. */
  name?: string;
  /** The ANTI-RUNAWAY round ceiling — overrides the profile default so a caller can pin
   *  it (tests exercise the backstop with a small value). Never the UX driver. */
  maxRounds?: number;
  maxDiscussTurns?: number;
}

export type DesignBriefResult =
  | {
      ok: true;
      landed: true;
      name: string;
      path: string;
      direction: string;
      commitments: string[];
      rounds: number;
    }
  | { ok: true; landed: false; verdict: 'revise' | 'reject'; note: string }
  | { ok: false; error: CommandError };

/**
 * The session-scope driver — the whole design-brief session as a VALUE (guarded-write
 * style, no throw-as-flow): the idea gather (argv, else the human channel), the DESIGN
 * grill on the portable core, and the on-GO materialize through the target. Returns the
 * landed brief's identity on GO; on skip/reject/abort it returns landed:false with a
 * human note; on the anti-runaway ceiling stop it returns landed:false (the driver's
 * session already showed the full summary) with an honest note; provider/guard failures
 * return the L1-shaped error the surface already renders.
 */
export const runDesignBrief = async (
  target: DesignBriefTarget,
  abilities: Abilities,
  opts: DesignBriefOptions = {},
): Promise<DesignBriefResult> => {
  // GATHER — from argv when given, else the human channel.
  let idea = (opts.idea ?? '').trim();
  if (!idea) {
    try {
      idea = (await abilities.interact.ask('What is the design direction you want to grill? (a rough idea is fine)')).trim();
    } catch (e) {
      if (e instanceof InteractAbort) {
        return { ok: true, landed: false, verdict: 'reject', note: 'no design direction was given (the session was aborted) — nothing was landed' };
      }
      return { ok: false, error: { code: 'interact-failed', blocker: `design brief: the human channel failed — ${(e as Error).message}` } };
    }
    if (!idea) return { ok: true, landed: false, verdict: 'reject', note: 'no design direction given — nothing was landed' };
  }
  // the brief NAME (slug) — a caller bug (an unlandable name) fails BEFORE any provider
  // call, so a bad name never spends a session that cannot land.
  const name = slugFrom(opts.name ?? idea);
  if (!name) {
    return { ok: false, error: { code: 'invalid-name', blocker: `design brief: no landable brief name (gave '${opts.name ?? idea.slice(0, 40)}…') — pass a name or a slug-able direction` } };
  }

  // GRILL — the dedicated DESIGN grill (the portable core + DESIGN_PROFILE; each round
  // ANSWER → LLM RESPONSE → DISCUSS → DECISION; GO/dig more/refine/skip). Provider/
  // adapter failures fail CLOSED here (same as `ann run!`): the session returns ok:false
  // and nothing is landed.
  const r = await new GrillSession(abilities, DESIGN_PROFILE).run({
    subject: idea,
    ...(opts.context?.length ? { context: opts.context } : {}),
    ...(opts.constraints?.length ? { constraints: opts.constraints } : {}),
    ...(opts.maxRounds !== undefined ? { maxRounds: opts.maxRounds } : {}),
    ...(opts.maxDiscussTurns !== undefined ? { maxDiscussTurns: opts.maxDiscussTurns } : {}),
  });
  if (!r.ok) return { ok: false, error: r.error };
  if (r.verdict !== 'solid') {
    return { ok: true, landed: false, verdict: r.verdict === 'exhausted' ? 'revise' : 'reject', note: r.note };
  }

  // GO — land only on the HUMAN's GO (a round with remaining unknowns that the human
  // accepts still lands; skipping/aborting never does).
  const brief = designBriefFrom({ direction: r.statement, okClaims: r.okClaims, resolved: r.resolved });
  const landed = target.land(name, brief);
  if (!landed.ok) return { ok: false, error: landed.error };
  return {
    ok: true,
    landed: true,
    name,
    path: landed.path,
    direction: oneLine(r.statement),
    commitments: brief.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2)),
    rounds: r.rounds,
  };
};
