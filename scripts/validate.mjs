#!/usr/bin/env node
/**
 * validate.mjs — the configurable event-validation system (S4 validators seed).
 *
 * Rules registry (code) + config (scripts/validation.config.json): enable/disable,
 * severity override, params. Runs the ACTIVE rules against the journey, prints a grouped
 * report, exits by worst severity (error=1, warning=0).
 *
 * Usage:
 *   node scripts/validate.mjs                  → run all enabled rules
 *   node scripts/validate.mjs --rules          → list rules + their config
 *   node scripts/validate.mjs gate-1           → run one rule
 *   SEVERITY=warning node scripts/validate.mjs → tolerate warnings (exit 0)
 */

import { readFileSync, existsSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ROUNDS = join(ROOT, 'journey', 'legs');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'rules', 'check', 'rules.json'), 'utf8'));  // the registry (resource-registry spec)

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (!lstatSync(p).isSymbolicLink() && statSync(p).isDirectory()) walk(p, acc);
    else if (entry === 'events.jsonl' || entry === 'node.json' || entry === 'description.md') acc.push(p);
  }
  return acc;
}
const FILES = walk(ROUNDS);
const eventFiles = FILES.filter((f) => f.endsWith('events.jsonl'));
const nodeFiles = FILES.filter((f) => f.endsWith('node.json'));
const cards = FILES.filter((f) => f.endsWith('description.md'));

function nodeId(file) {
  return file.replace(new RegExp('^' + ROUNDS + '/'), '').replace(/\/[^/]+$/, '');
}
function parseEvents(file) {
  return readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function eventGate(ev) {
  return ev.gate || (ev.note && (ev.note.match(/gate=(\w+)/) || [])[1]) || '';
}

// ---- Rules registry: {id, defaultSeverity, check(tree) -> [{id, severity, message}]} ----
const RULES = {
  'gate-1': {
    check: () => {
      const out = [];
      for (const f of eventFiles) {
        if (!nodeId(f).includes('/')) continue; // v7: gate rules apply to tasks only — leg roots carry no events
        const evs = parseEvents(f);
        let firstWork = -1, lastGrill = -1, retroGrill = false;
        evs.forEach((ev, i) => {
          if (ev.type === 'artifact-locked' || ev.type === 'completed') firstWork = firstWork === -1 ? i : firstWork;
          if (ev.type === 'confirmed' && eventGate(ev) === 'grill') lastGrill = i;
          if (ev.type === 'confirmed' && eventGate(ev) === 'grill' && ev.note && ev.note.includes('retrospective')) retroGrill = true;
        });
        if (firstWork >= 0 && !retroGrill && (lastGrill === -1 || lastGrill > firstWork))
          out.push({ message: `${nodeId(f)}: produced work but no confirmed(gate=grill) before it` });
      }
      return out;
    },
  },
  'gate-2': {
    check: () => {
      const out = [];
      for (const f of eventFiles) {
        if (!nodeId(f).includes('/')) continue; // v7: gate rules apply to tasks only
        const evs = parseEvents(f);
        let lastComplete = -1, lastConfirm = -1;
        evs.forEach((ev, i) => {
          if (ev.type === 'completed') lastComplete = i;
          if (ev.type === 'confirmed' && (eventGate(ev) === 'confirm' || eventGate(ev) === '')) lastConfirm = i;
        });
        if (lastComplete >= 0 && lastConfirm === -1)
          out.push({ message: `${nodeId(f)}: completed but no confirmed(gate=confirm) recorded` });
      }
      return out;
    },
  },
  'event-schema': {
    check: (params) => {
      const TYPES = ['created','activated','extended','evidence','artifact-locked','completed','failed','superseded','submitted','confirmed','rejected','gate-revised','transferred','deferred'];
      const out = [];
      const legacy = params.legacyProse === true;
      for (const f of eventFiles) {
        readFileSync(f, 'utf8').split('\n').forEach((raw, i) => {
          const l = raw.trim();
          if (!l) return;
          let ev;
          try { ev = JSON.parse(l); } catch { out.push({ message: `${nodeId(f)}:${i + 1}: invalid JSON` }); return; }
          if (!ev.at || !ev.type || !TYPES.includes(ev.type))
            out.push({ message: `${nodeId(f)}:${i + 1}: bad schema (at + known type required, got type=${ev.type})` });
          if (ev.type === 'artifact-locked' && !ev.artifact)
            out.push({ message: `${nodeId(f)}:${i + 1}: artifact-locked missing structured artifact${legacy ? ' (legacy prose)' : ''}`, info: legacy });
          if (ev.type === 'superseded' && !ev.successor)
            out.push({ message: `${nodeId(f)}:${i + 1}: superseded missing structured successor${legacy ? ' (legacy prose)' : ''}`, info: legacy });
        });
      }
      return out;
    },
  },
  'one-current-per-name': {
    check: () => {
      const out = [];
      const locked = [];
      for (const f of eventFiles) {
        for (const ev of parseEvents(f)) {
          if (ev.type === 'artifact-locked' && ev.artifact && ev.artifact.name)
            locked.push({ name: ev.artifact.name, producer: nodeId(f), path: ev.artifact.path });
        }
      }
      const byName = new Map();
      for (const l of locked) {
        const superseded = nodeFiles.some(() => false) && false; // superseded detection: check producer events below
        const isSuperseded = (producer) => parseEvents(eventFiles.find((ef) => nodeId(ef) === producer) || f).some((e) => e.type === 'superseded');
        if (!isSuperseded(l.producer)) {
          if (byName.has(l.name)) out.push({ message: `one-current-per-name violated: ${l.name} (${byName.get(l.name)} vs ${l.producer})` });
          else byName.set(l.name, l.producer);
        }
      }
      return out;
    },
  },
  'resolution-files-exist': {
    check: () => {
      const out = [];
      for (const f of eventFiles) {
        for (const ev of parseEvents(f)) {
          if (ev.type === 'artifact-locked' && ev.artifact && ev.artifact.path) {
            const full = join(ROOT, ev.artifact.path);
            if (!existsSync(full)) out.push({ message: `missing artifact file: ${ev.artifact.path}` });
          }
        }
      }
      return out;
    },
  },
  'card-present': {
    check: () => {
      const out = [];
      for (const nf of nodeFiles) {
        if (!cards.some((c) => nodeId(c) === nodeId(nf)))
          out.push({ message: `${nodeId(nf)}: no description.md card` });
      }
      return out;
    },
  },
  'depth-budget': {
    check: (params) => {
      const out = [];
      const maxDepth = params.maxDepth, maxChars = params.maxPathChars;
      for (const nf of nodeFiles) {
        const rel = nodeId(nf);
        if (rel.split('/').length > maxDepth) out.push({ message: `${rel}: depth ${rel.split('/').length} > ${maxDepth}` });
        const full = rel.replace(/\//g, '/');
        if (full.length + 'journey/legs/'.length > maxChars) out.push({ message: `${rel}: path length over ${maxChars}` });
      }
      return out;
    },
  },
  'name-discipline': {
    check: (params) => {
      const out = [];
      for (const nf of nodeFiles) {
        for (const seg of nodeId(nf).split('/')) {
          if (seg.length > params.maxSegment) out.push({ message: `${nodeId(nf)}: segment '${seg}' ${seg.length} > ${params.maxSegment} chars` });
          if (!/^[a-z0-9-]+$/.test(seg)) out.push({ message: `${nodeId(nf)}: segment '${seg}' not kebab-case` });
        }
      }
      return out;
    },
  },
  'high-impact-defaulted': {
    check: () => {
      const out = [];
      for (const nf of nodeFiles) {
        let node;
        try { node = JSON.parse(readFileSync(nf, 'utf8')); } catch { continue; }
        const blocking = (node.openQuestions || []).filter((q) => q.blocking);
        if (!blocking.length) continue;
        const evs = parseEvents(nf.replace(/node\.json$/, 'events.jsonl'));
        const done = evs.some((e) => e.type === 'artifact-locked' || e.type === 'completed');
        const prov = evs.some((e) => e.note && /discussed|defaulted|inferred/.test(e.note));
        if (done && !prov)
          out.push({ message: `${nodeId(nf)}: ${blocking.length} blocking question(s) resolved without resolution-provenance record (how=discussed|defaulted|inferred)` });
      }
      return out;
    },
  },
  'closure-integrity': {
    check: () => {
      const out = [];
      const allIds = new Set();
      for (const nf of nodeFiles) allIds.add(nodeId(nf));
      for (const f of eventFiles) {
        if (!nodeId(f).includes('/')) continue; // v7: closure rules apply to tasks only
        const evs = parseEvents(f);
        const id = nodeId(f);
        let revised = -1, completed = -1, closureOk = false, transferredTargets = [];
        evs.forEach((ev, i) => {
          if (ev.type === 'gate-revised') revised = i;
          if (ev.type === 'completed') completed = i;
          if (ev.type === 'transferred' || ev.type === 'deferred') closureOk = true;
          if (ev.type === 'transferred' && ev.target) transferredTargets.push(ev.target);
        });
        if (revised >= 0 && completed > revised && !closureOk)
          out.push({ message: `${id}: gate-revised but closed without transferred/deferred (F-AC16)` });
        for (const t of transferredTargets) if (!allIds.has(t) && !allIds.has('journey/legs/' + t))
          out.push({ message: `${id}: transferred target '${t}' does not exist (F-AC16)` });
      }
      return out;
    },
  },
  'registry-integrity': {
    check: () => {
      const out = [];
      const registryIds = new Set((CONFIG.rules || []).map((r) => r.id));
      for (const id of registryIds) if (!RULES[id]) out.push({ message: `registry rule '${id}' has no implementation` });
      for (const id of Object.keys(RULES)) if (!registryIds.has(id)) out.push({ message: `implemented rule '${id}' is not in the registry` });
      return out;
    },
  },
  'round-gate': {
    // v7: the leg gate is the DERIVED AGGREGATE — leg N+1 spawns only when all of leg N's tasks are done.
    check: () => {
      const out = [];
      const legs = [...new Set(nodeFiles.map((nf) => nodeId(nf).split('/')[0]))].sort();
      const taskDone = (id) => parseEvents(join(ROUNDS, id, 'events.jsonl')).some((e) => e.type === 'completed' || e.type === 'superseded'); // superseded = closed (absorbed), e.g. 01-depth-policy
      const legTasksDone = (leg) => {
        const tasks = nodeFiles.map((nf) => nodeId(nf)).filter((id) => id.startsWith(leg + '/') && id.split('/').length === 2);
        if (!tasks.length) return taskDone(leg); // childless leg → its own record (L1 base step; new legs have none → not done)
        return tasks.every(taskDone);
      };
      for (let i = 1; i < legs.length; i++) {
        const prev = legs[i - 1], cur = legs[i];
        if (!legTasksDone(prev)) out.push({ message: `${cur}: leg spawned before all of ${prev}'s tasks done (derived leg gate, v7 §12)` });
      }
      return out;
    },
  },
  'leg-root-discipline': {
    // v7 §3/§12: leg roots carry no events — a leg's existence is its directory, its activity is its tasks.
    // Grandfathered: L1-L6 (recorded pre-v7; inert — never read for state).
    check: () => {
      const out = [];
      const GRANDFATHERED = new Set(['01-goal', '02-grilling', '03-tree-format', '04-system-design', '05-engine', '06-engine-build']);
      for (const nf of nodeFiles) {
        const id = nodeId(nf);
        if (id.includes('/') || GRANDFATHERED.has(id)) continue;
        const evs = parseEvents(join(ROUNDS, id, 'events.jsonl'));
        if (evs.length) out.push({ message: `${id}: leg root carries events (v7 §3) — leg roots have no log; record process facts on tasks` });
      }
      return out;
    },
  },
};

// ---- Run ----
const args = process.argv.slice(2);
const rulesCfg = CONFIG.rules;
const cfgById = Object.fromEntries(rulesCfg.map((r) => [r.id, r]));

if (args.includes('--help')) {
  console.log('validate.mjs — the rule registry report (rules/check/rules.json, resource-registry spec)');
  console.log('  (no args)   run all enabled rules · grouped report · exit by worst severity');
  console.log('  --rules     list every rule + its config');
  console.log('  <rule-id>   run one rule (e.g. gate-2, closure-integrity)');
  console.log('  SEVERITY=warning  tolerate warnings (exit 0)');
  process.exit(0);
}

if (args.includes('--rules')) {
  for (const r of rulesCfg) console.log(`${r.enabled ? 'on ' : 'off'} ${r.id.padEnd(22)} [${r.severity}] ${r.definition || r.description}`);
  process.exit(0);
}

const target = args.find((a) => !a.startsWith('--'));
const allowWarnings = process.env.SEVERITY === 'warning';
const findings = [];

for (const r of rulesCfg) {
  if (!r.enabled || (target && r.id !== target)) continue;
  const rule = RULES[r.id];
  if (!rule) { findings.push({ id: r.id, severity: 'error', message: `rule '${r.id}' has no implementation` }); continue; }
  for (const f of rule.check(r.params || {})) findings.push({ id: r.id, severity: f.info ? 'info' : r.severity, message: f.message });
}

const bySev = { error: [], warning: [], info: [] };
for (const f of findings) (bySev[f.severity] || bySev.warning).push(f);

if (bySev.error.length) { console.error(`ERROR (${bySev.error.length}):`); bySev.error.forEach((f) => console.error(`  [${f.id}] ${f.message}`)); }
if (bySev.warning.length) { console.log(`WARNING (${bySev.warning.length}):`); bySev.warning.forEach((f) => console.log(`  [${f.id}] ${f.message}`)); }
if (bySev.info.length) { console.log(`INFO (${bySev.info.length}):`); bySev.info.slice(0, 5).forEach((f) => console.log(`  [${f.id}] ${f.message}`)); if (bySev.info.length > 5) console.log(`  … ${bySev.info.length - 5} more`); }
console.log(bySev.error.length === 0 && bySev.warning.length === 0 ? 'OK — no findings.' : `${bySev.error.length} error(s), ${bySev.warning.length} warning(s).`);
process.exit(bySev.error.length === 0 ? (allowWarnings ? 0 : 0) : 1);
