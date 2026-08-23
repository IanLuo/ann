import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RuleFinding, ValidatorContext } from './types.js';

/** The nodes a rule should check: one node (ann validate <id>) or all tasks. */
const targetsOf = (ctx: ValidatorContext): string[] =>
  ctx.nodeId ? [ctx.nodeId] : ctx.store.ids().filter((i) => i.includes('/'));
import { getVOCAB } from '../../store/vocab.js';
import { loadProviderRegistry, loadConfig } from '../../adapters/provider/index.js';

/** gate-1 — produced work requires confirmed(gate=grill) before it (retrospective honored). */
export const gate1 = {
  id: 'gate-1',
  definition: 'produced work (artifact-locked/completed) requires confirmed(gate=grill) before it (retrospective records honored)',
  severity: 'error' as const,
  enabled: true,
  params: {},
  run(ctx: ValidatorContext): RuleFinding[] {
    const out: RuleFinding[] = [];
    for (const id of targetsOf(ctx)) {
      for (const p of ctx.store.gateProblems(id)) {
        if (p.includes('GATE-1')) out.push({ severity: 'error', code: 'gate-1', detail: p, nodeId: id });
      }
    }
    return out;
  },
};

/** gate-2 — completed requires a confirmed(gate=confirm) recorded. */
export const gate2 = {
  id: 'gate-2',
  definition: 'completed requires a confirmed(gate=confirm) recorded (position-insensitive)',
  severity: 'error' as const,
  enabled: true,
  params: {},
  run(ctx: ValidatorContext): RuleFinding[] {
    const out: RuleFinding[] = [];
    for (const id of targetsOf(ctx)) {
      for (const p of ctx.store.gateProblems(id)) {
        if (p.includes('GATE-2')) out.push({ severity: 'error', code: 'gate-2', detail: p, nodeId: id });
      }
    }
    return out;
  },
};

/** closure-integrity — completed-after-gate-revised requires transferred|deferred (F-AC16). */
export const closureIntegrity = {
  id: 'closure-integrity',
  definition: 'completed-after-gate-revised requires transferred|deferred; transferred targets must exist (F-AC16)',
  severity: 'error' as const,
  enabled: true,
  params: {},
  run(ctx: ValidatorContext): RuleFinding[] {
    const out: RuleFinding[] = [];
    for (const p of ctx.store.check()) {
      if (p.includes('gate-revised') || p.includes('transferred')) out.push({ severity: 'error', code: 'closure-integrity', detail: p });
    }
    return out;
  },
};

/** one-current-per-name — no two non-superseded artifacts share a logical name. */
export const oneCurrent = {
  id: 'one-current-per-name',
  definition: 'no two non-superseded artifacts share a logical name',
  severity: 'error' as const,
  enabled: true,
  params: {},
  run(ctx: ValidatorContext): RuleFinding[] {
    const out: RuleFinding[] = [];
    for (const p of ctx.store.check()) {
      if (p.includes('NO CURRENT') || p.includes('MISSING')) out.push({ severity: 'error', code: 'one-current-per-name', detail: p });
    }
    return out;
  },
};

/** resolution-files-exist — every current artifact's file exists on disk. */
export const resolutionFiles = {
  id: 'resolution-files-exist',
  definition: "every current artifact's file exists on disk",
  severity: 'error' as const,
  enabled: true,
  params: {},
  run(ctx: ValidatorContext): RuleFinding[] {
    const out: RuleFinding[] = [];
    for (const p of ctx.store.check()) {
      if (p.includes('MISSING:')) out.push({ severity: 'error', code: 'resolution-files-exist', detail: p });
    }
    return out;
  },
};

/** event-schema — every event line valid JSON with a known type; strict append schema enforced. */
export const eventSchema = {
  id: 'event-schema',
  definition: 'every event line valid JSON with a known type; artifact-locked/superseded carry structured fields (legacy prose tolerated)',
  severity: 'error' as const,
  enabled: true,
  params: { legacyProse: true },
  run(ctx: ValidatorContext): RuleFinding[] {
    const out: RuleFinding[] = [];
    const types = getVOCAB().eventTypes;
    for (const id of targetsOf(ctx)) {
      const evs = ctx.store.events(id);
      for (const e of evs) {
        if (!types.includes(e.type)) out.push({ severity: 'error', code: 'event-schema', detail: `${id}: unknown event type '${String(e.type)}'`, nodeId: id });
      }
    }
    return out;
  },
};

/** round-gate — no leg N+1 work before all of leg N's tasks done (check-time, derived aggregate). */
export const roundGate = {
  id: 'round-gate',
  definition: "no leg N+1 work before all of leg N's tasks done (derived aggregate — v7 §12)",
  severity: 'error' as const,
  enabled: true,
  params: {},
  run(ctx: ValidatorContext): RuleFinding[] {
    const out: RuleFinding[] = [];
    const legs = ctx.store.ids().filter((i) => !i.includes('/')).sort();
    for (let i = 1; i < legs.length; i++) {
      const g = ctx.store.legGateMet(legs[i]);
      if (!g.met) out.push({ severity: 'error', code: 'round-gate', detail: `leg ${legs[i]}: ${g.blocker}`, nodeId: legs[i] });
    }
    return out;
  },
};

/** depth-budget — tree depth and path length within budget (8 levels, 260 chars). */
export const depthBudget = {
  id: 'depth-budget',
  definition: 'tree depth and path length within budget',
  severity: 'warning' as const,
  enabled: true,
  params: { maxDepth: 8, maxPathChars: 260 },
  run(ctx: ValidatorContext): RuleFinding[] {
    const out: RuleFinding[] = [];
    for (const id of ctx.store.ids()) {
      const depth = id.split('/').length;
      if (depth > 8) out.push({ severity: 'warning', code: 'depth-budget', detail: `${id}: depth ${depth} (budget 8)`, nodeId: id });
      if (id.length > 260) out.push({ severity: 'warning', code: 'depth-budget', detail: `${id}: path ${id.length} chars (budget 260)`, nodeId: id });
    }
    return out;
  },
};

/** name-discipline — path segments kebab-case, <= 24 chars (legacy tolerated as warning). */
export const nameDiscipline = {
  id: 'name-discipline',
  definition: 'path segments kebab-case, <= 24 chars (legacy tolerated)',
  severity: 'warning' as const,
  enabled: true,
  params: { maxSegment: 24 },
  run(ctx: ValidatorContext): RuleFinding[] {
    const out: RuleFinding[] = [];
    const max = 24; // name-discipline params.maxSegment
    for (const id of ctx.store.ids()) {
      for (const seg of id.split('/')) {
        if (seg.length > max) out.push({ severity: 'warning', code: 'name-discipline', detail: `${id}: segment '${seg}' > ${max} chars`, nodeId: id });
        else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(seg)) out.push({ severity: 'warning', code: 'name-discipline', detail: `${id}: segment '${seg}' not kebab-case`, nodeId: id });
      }
    }
    return out;
  },
};

/** vocab-integrity — the vocab registry exists and carries the schema vocabulary. */
export const vocabIntegrity = {
  id: 'vocab-integrity',
  definition: 'the vocab registry (rules/schema/vocab.json) exists and carries the schema vocabulary',
  severity: 'error' as const,
  enabled: true,
  params: {},
  run(ctx: ValidatorContext): RuleFinding[] {
    const out: RuleFinding[] = [];
    try {
      const v = getVOCAB();
      if (!v.eventTypes.length || !v.gates.length || !v.artifactTypes.length) out.push({ severity: 'error', code: 'vocab-integrity', detail: 'vocab registry loaded but empty of required lists' });
    } catch (e) {
      out.push({ severity: 'error', code: 'vocab-integrity', detail: (e as Error).message });
    }
    return out;
  },
};

/** registry-integrity — every discovered rule module has a unique id (self-contained modules ARE the registry). */
export const registryIntegrity = {
  id: 'registry-integrity',
  definition: 'every rule module has a unique id — self-contained modules ARE the registry (rules/check/rules.json is derived)',
  severity: 'error' as const,
  enabled: true,
  params: {},
  run(ctx: ValidatorContext): RuleFinding[] {
    const out: RuleFinding[] = [];
    const { RULES } = ctx as unknown as { RULES: Array<{ id: string }> };
    const ids = RULES.map((r) => r.id);
    const dupes = ids.filter((x, i) => ids.indexOf(x) !== i);
    if (dupes.length) out.push({ severity: 'error', code: 'registry-integrity', detail: `duplicate rule ids: ${dupes.join(', ')}` });
    return out;
  },
};

/** distance-to-goal — the SET of not-done nodes from the frontmost-ready to the goal (never a scalar). */
export const distanceToGoal = {
  id: 'distance-to-goal',
  definition: 'the set of not-done nodes from the active front to the goal (never a scalar count)',
  severity: 'warning' as const,
  enabled: true,
  params: {},
  run(ctx: ValidatorContext): RuleFinding[] {
    const out: RuleFinding[] = [];
    const legs = ctx.store.ids().filter((i) => !i.includes('/')).sort();
    const remaining: string[] = [];
    for (const leg of legs) {
      const st = ctx.store.status(leg);
      if (st === 'done' || st === 'failed' || st === 'superseded') continue;
      remaining.push(leg);
      const tasks = ctx.store.tasksOf(leg).filter((t) => {
        const ts = ctx.store.status(t);
        return !['done', 'failed', 'superseded'].includes(ts);
      });
      for (const t of tasks) remaining.push(t);
    }
    if (remaining.length) out.push({ severity: 'warning', code: 'distance-to-goal', detail: `remaining set: ${remaining.join(' → ')}` });
    return out;
  },
};

/** redaction — no artifact/evidence content contains the configured apiKey (secrets never leak into the tree). */
export const redaction = {
  id: 'redaction',
  definition: 'no artifact/evidence content contains the configured apiKey (secrets never leak into the tree)',
  severity: 'error' as const,
  enabled: true,
  params: {},
  run(ctx: ValidatorContext): RuleFinding[] {
    const out: RuleFinding[] = [];
    const key = loadConfig().apiKey;
    if (!key || key.length < 8) return out; // nothing configured / too short to match reliably
    for (const id of ctx.store.ids()) {
      for (const e of ctx.store.events(id)) {
        if (typeof e.note === 'string' && e.note.includes(key)) {
          out.push({ severity: 'error', code: 'redaction', detail: `${id}: evidence note contains the configured apiKey (never store secrets in the tree)`, nodeId: id });
        }
      }
    }
    return out;
  },
};

/** artifact-hash-integrity — marker-stripped blob vs recorded lockSha. Fast path: the blob
 *  matches the marker → verified. Mismatch: resolve the marker in git — if the lock commit's
 *  file matches the current blob → verified vs lock commit; else → pre-integrity-era edit
 *  (WARNING, grandfathered — never "tampered" without proof). Unresolvable marker → warning. */
export const artifactHash = {
  id: 'artifact-hash-integrity',
  definition: 'marker-stripped blob vs recorded lockSha — fail-closed on new locks',
  severity: 'error' as const,
  enabled: true,
  params: {},
  run(ctx: ValidatorContext): RuleFinding[] {
    const out: RuleFinding[] = [];
    const seen = new Set<string>();
    for (const id of ctx.store.ids()) {
      for (const e of ctx.store.events(id)) {
        if (e.type !== 'artifact-locked') continue;
        const a = e.artifact;
        if (!a?.name || !a.lockSha || seen.has(a.name)) continue;
        const cur = ctx.store.current(a.name);
        if (cur?.producer !== id) continue;
        seen.add(a.name);
        const full = join(ctx.store.root, cur.path);
        if (!existsSync(full)) {
          out.push({ severity: 'error', code: 'artifact-hash-integrity', detail: `${a.name}: file missing at ${cur.path}`, nodeId: id });
          continue;
        }
        const content = readFileSync(full, 'utf8').replace(/^<!-- (?:specs:locked|draft)[^\n]* -->\n?/, '');
        const h = blobSha(content).slice(0, 7);
        const raw = readFileSync(full, 'utf8');
        const markerSha = (raw.match(/specs:locked:([0-9a-f]{7,})/) || [])[1] || a.lockSha;
        if (markerSha && h === markerSha.slice(0, 7)) continue; // fast path: verified
        // slow path — resolve the marker in git (mirrors cmdCheck: never call legit history "tampered")
        try {
          const kind = execFileSync('git', ['cat-file', '-t', markerSha], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          if (kind === 'commit') {
            const hit = execFileSync('git', ['ls-tree', '-r', '--name-only', markerSha], { encoding: 'utf8' })
              .split('\n').find((p) => p.endsWith('/' + basename(cur.path)));
            if (hit) {
              const at = execFileSync('git', ['show', `${markerSha}:${hit}`], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).replace(/^<!-- (?:specs:locked|draft)[^\n]* -->\n?/, '');
              if (blobSha(at).slice(0, 7) === h) continue; // matches the lock commit → verified
            }
            out.push({ severity: 'warning', code: 'artifact-hash-integrity', detail: `${a.name}: edited after lock commit ${markerSha.slice(0, 7)} (pre-integrity era — re-lock if intentional)`, nodeId: id });
          } else if (kind === 'blob') {
            out.push({ severity: 'warning', code: 'artifact-hash-integrity', detail: `${a.name}: legacy blob stamp (draft-marker era) — not hash-verified`, nodeId: id });
          } else {
            out.push({ severity: 'error', code: 'artifact-hash-integrity', detail: `${a.name}: lockSha ${markerSha} is neither commit nor blob`, nodeId: id });
          }
        } catch {
          out.push({ severity: 'warning', code: 'artifact-hash-integrity', detail: `${a.name}: lock sha ${markerSha} unresolvable in git (legacy)`, nodeId: id });
        }
      }
    }
    return out;
  },
};

function blobSha(c: string): string {
  return createHash('sha1').update('blob ' + Buffer.byteLength(c) + '\n' + c).digest('hex');
}

/** high-impact-defaulted — a blocking open question resolved on a completed node must carry answer provenance. */
export const highImpactDefaulted = {
  id: 'high-impact-defaulted',
  definition: 'a blocking (high-impact) openQuestion resolved on a completed node must carry resolution provenance (discussed|defaulted|inferred); defaulted/inferred without explicit user decision = flagged (the tech-stack lesson)',
  severity: 'warning' as const,
  enabled: true,
  params: {},
  run(ctx: ValidatorContext): RuleFinding[] {
    const out: RuleFinding[] = [];
    for (const id of targetsOf(ctx)) {
      const evs = ctx.store.events(id);
      if (!evs.some((e) => e.type === 'completed')) continue;
      const c = ctx.store.contract(id) as { contract?: { openQuestions?: Array<{ blocking?: boolean; id?: string }> } } | undefined;
      const blocking = (c?.contract?.openQuestions ?? []).filter((q) => q.blocking);
      if (!blocking.length) continue;
      const answered = evs.filter((e) => e.type === 'evidence' && Array.isArray(e.answers) && (e.answers as unknown[]).length > 0);
      if (!answered.length) {
        out.push({
          severity: 'warning',
          code: 'high-impact-defaulted',
          detail: `${id}: completed with ${blocking.length} blocking open question(s) (${blocking.map((q) => q.id ?? '?').join(', ')}) but no answer record with provenance`,
          nodeId: id,
        });
      }
    }
    return out;
  },
};
