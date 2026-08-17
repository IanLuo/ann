#!/usr/bin/env node
/**
 * validate.mjs — the configurable event-validation system (S4 validators seed).
 *
 * Rules registry (code) + config (scripts/validation.config.json): enable/disable,
 * severity override, params. Runs the ACTIVE rules against the tree, prints a grouped
 * report, exits by worst severity (error=1, warning=0).
 *
 * Usage:
 *   node scripts/validate.mjs                  → run all enabled rules
 *   node scripts/validate.mjs --rules          → list rules + their config
 *   node scripts/validate.mjs gate-1           → run one rule
 *   SEVERITY=warning node scripts/validate.mjs → tolerate warnings (exit 0)
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ROUNDS = join(ROOT, 'tree', 'rounds');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'scripts', 'validation.config.json'), 'utf8'));

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
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
        const evs = parseEvents(f);
        let lastComplete = -1, lastConfirm = -1;
        evs.forEach((ev, i) => {
          if (ev.type === 'completed') lastComplete = i;
          if (ev.type === 'confirmed' && (eventGate(ev) === 'confirm' || eventGate(ev) === '')) lastConfirm = i;
        });
        if (lastComplete >= 0 && (lastConfirm === -1 || lastConfirm < lastComplete))
          out.push({ message: `${nodeId(f)}: completed but no confirmed(gate=confirm) after it` });
      }
      return out;
    },
  },
  'event-schema': {
    check: () => {
      const TYPES = ['created','activated','extended','evidence','artifact-locked','completed','failed','superseded','submitted','confirmed','rejected'];
      const out = [];
      for (const f of eventFiles) {
        readFileSync(f, 'utf8').split('\n').forEach((raw, i) => {
          const l = raw.trim();
          if (!l) return;
          let ev;
          try { ev = JSON.parse(l); } catch { out.push({ message: `${nodeId(f)}:${i + 1}: invalid JSON` }); return; }
          if (!ev.at || !ev.type || !TYPES.includes(ev.type))
            out.push({ message: `${nodeId(f)}:${i + 1}: bad schema (at + known type required, got type=${ev.type})` });
          if (ev.type === 'artifact-locked' && !ev.artifact) out.push({ message: `${nodeId(f)}:${i + 1}: artifact-locked missing structured artifact` });
          if (ev.type === 'superseded' && !ev.successor) out.push({ message: `${nodeId(f)}:${i + 1}: superseded missing structured successor` });
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
        if (full.length + 'tree/rounds/'.length > maxChars) out.push({ message: `${rel}: path length over ${maxChars}` });
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
  'round-gate': {
    check: () => {
      const out = [];
      const rounds = new Map();
      for (const nf of nodeFiles) {
        const rel = nodeId(nf);
        const roundId = rel.split('/')[0];
        if (!rounds.has(roundId)) rounds.set(roundId, { root: rel === roundId ? null : null, done: false });
        if (rel === roundId) rounds.get(roundId).root = rel;
      }
      for (const [roundId, info] of rounds) {
        const evs = parseEvents(join(ROUNDS, roundId, 'events.jsonl'));
        const done = evs.some((e) => e.type === 'completed');
        const next = roundId.replace(/^\d+/, (m) => String(Number(m) + 1).padStart(m.length, '0'));
        if (!done && rounds.has(next)) out.push({ message: `${next}: round spawned before ${roundId} completed` });
      }
      return out;
    },
  },
};

// ---- Run ----
const args = process.argv.slice(2);
const rulesCfg = CONFIG.rules;
const cfgById = Object.fromEntries(rulesCfg.map((r) => [r.id, r]));

if (args.includes('--rules')) {
  for (const r of rulesCfg) console.log(`${r.enabled ? 'on ' : 'off'} ${r.id.padEnd(22)} [${r.severity}] ${r.description}`);
  process.exit(0);
}

const target = args.find((a) => !a.startsWith('--'));
const allowWarnings = process.env.SEVERITY === 'warning';
const findings = [];

for (const r of rulesCfg) {
  if (!r.enabled || (target && r.id !== target)) continue;
  const rule = RULES[r.id];
  if (!rule) { findings.push({ id: r.id, severity: 'error', message: `rule '${r.id}' has no implementation` }); continue; }
  for (const f of rule.check(r.params || {})) findings.push({ id: r.id, severity: r.severity, message: f.message });
}

const bySev = { error: [], warning: [], info: [] };
for (const f of findings) (bySev[f.severity] || bySev.warning).push(f);

if (bySev.error.length) { console.error(`ERROR (${bySev.error.length}):`); bySev.error.forEach((f) => console.error(`  [${f.id}] ${f.message}`)); }
if (bySev.warning.length) { console.log(`WARNING (${bySev.warning.length}):`); bySev.warning.forEach((f) => console.log(`  [${f.id}] ${f.message}`)); }
console.log(bySev.error.length === 0 && bySev.warning.length === 0 ? 'OK — no findings.' : `${bySev.error.length} error(s), ${bySev.warning.length} warning(s).`);
process.exit(bySev.error.length === 0 ? (allowWarnings ? 0 : 0) : 1);
