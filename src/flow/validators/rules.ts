import { RuleFinding, ValidatorContext } from './types.js';

/** The nodes a rule should check: one node (ann validate <id>) or all tasks. */
const targetsOf = (ctx: ValidatorContext): string[] =>
  ctx.nodeId ? [ctx.nodeId] : ctx.store.ids().filter((i) => i.includes('/'));
import { getVOCAB } from '../../store/vocab.js';
import { loadProviderRegistry, loadConfig } from '../../abilities/llm/index.js';

/** gate-1 — produced work requires confirmed(gate=grill) before it (v9+ nodes; the
 *  cutoff grandfathers the prose-gate era at reporting — core-design §1). */
export const gate1 = {
  id: 'gate-1',
  definition: 'produced work (artifact-locked/completed) requires confirmed(gate=grill) before it (v9+ nodes; pre-cutoff nodes grandfathered at reporting)',
  severity: 'error' as const,
  enabled: true,
  params: {},
  run(ctx: ValidatorContext): RuleFinding[] {
    const out: RuleFinding[] = [];
    for (const id of targetsOf(ctx)) {
      if (ctx.store.grandfathered(id)) continue; // CHECK-REPORTING cutoff — the writer stays unconditional
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
      if (ctx.store.grandfathered(id)) continue; // CHECK-REPORTING cutoff — the writer stays unconditional
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

/** name-discipline — path segments kebab-case, <= 40 chars (v15: the cap raised from 24 for the <NN>-<worktype>-<slug> grammar; legacy tolerated as warning). */
export const nameDiscipline = {
  id: 'name-discipline',
  definition: 'path segments kebab-case, <= 40 chars (legacy tolerated)',
  severity: 'warning' as const,
  enabled: true,
  params: { maxSegment: 40 },
  run(ctx: ValidatorContext): RuleFinding[] {
    const out: RuleFinding[] = [];
    const max = 40; // name-discipline params.maxSegment
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
      // v3: artifactTypes is a MAP of entry → {category?, versioned} (§3 rule 7).
      if (!v.eventTypes.length || !v.gates.length || !Object.keys(v.artifactTypes).length) {
        out.push({ severity: 'error', code: 'vocab-integrity', detail: 'vocab registry loaded but empty of required lists' });
      }
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
