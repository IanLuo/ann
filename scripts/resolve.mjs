#!/usr/bin/env node
/**
 * resolve.mjs — the derived logical-name resolver (tree-format-spec v3 §4, F-AC13 seed).
 *
 * The FIRST engine component, built pre-engine as a plain Node script (no deps),
 * used by the bootstrap itself. Implements:
 *   current(name) = artifact of the latest `artifact-locked` event with that name
 *                   whose producer is not `superseded`.
 *
 * Usage:
 *   node scripts/resolve.mjs                → print the name → current-path map
 *   node scripts/resolve.mjs <name>         → print the current path for one name
 *   node scripts/resolve.mjs --check        → verify: files exist, one current per name
 *
 * Logical name extraction: structured `artifact.name` field (v3 §3) if present,
 * else derive from the artifact filename minus a version suffix (-vN).
 */

import { readFileSync, existsSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

const ROOT = process.cwd();
const ROUNDS = join(ROOT, 'tree', 'rounds');

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (entry === 'events.jsonl') acc.push(p);
  }
  return acc;
}

function logicalNameFromFile(path) {
  const base = basename(path).replace(/\.md$/, '');
  return base.replace(/-v\d+$/, ''); // strip version suffix
}

function parseEvents(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

function collect() {
  const locked = [];   // {name, path, sha, producer}
  const superseded = []; // {name, producer}
  for (const file of walk(ROUNDS)) {
    for (const ev of parseEvents(file)) {
      const producer = file.replace(new RegExp('^' + ROOT + '/'), '').replace(/\/events\.jsonl$/, '');
      
      if (ev.type === 'artifact-locked') {
        const artifact = ev.artifact || {};
        const filename = artifact.path
          ? basename(artifact.path)
          : (ev.note.match(/([\w.-]+\.md)/) || [])[1] || '';
        const name = artifact.name
          || (ev.note.match(/logical name:\s*([\w.-]+)/) || [])[1]
          || logicalNameFromFile(filename);
        const path = artifact.path || producer + '/artifacts/' + filename;
        const sha = artifact.lockSha || (ev.note.match(/@\s*([0-9a-f]{7,})/) || [])[1] || '';
        locked.push({ name, path, sha, producer });
      } else if (ev.type === 'superseded') {
        const succ = ev.successor || {};
        const oldName = (ev.note.match(/([\w.-]+\.md)/) || [])[1] || '';
        const name = succ.name
          || (ev.note.match(/logical name:\s*([\w.-]+)/) || [])[1]
          || logicalNameFromFile(oldName);
        superseded.push({ name, producer });
      }
    }
  }
  return { locked, superseded };
}

function resolve() {
  const { locked, superseded } = collect();
  const supersededProducers = new Set(superseded.map((s) => s.producer));
  // current(name) = latest artifact-locked with name, producer not superseded
  const current = new Map();
  for (const l of locked) {
    if (supersededProducers.has(l.producer)) continue;
    const prev = current.get(l.name);
    if (!prev || prev.sha <= l.sha || prev.producer < l.producer) current.set(l.name, l);
  }
  return current;
}

function check(current) {
  const problems = [];
  for (const [name, l] of current) {
    const full = join(ROOT, l.path);
    if (!existsSync(full)) problems.push(`MISSING: ${name} → ${l.path}`);
  }
  const { locked, superseded } = collect();
  const supersededProducers = new Set(superseded.map((s) => s.producer));
  const namesWithLock = new Set(locked.map((l) => l.name));
  for (const name of namesWithLock) {
    if (current.has(name)) continue;
    const allSuperseded = locked.filter((l) => l.name === name).every((l) => supersededProducers.has(l.producer));
    if (!allSuperseded) problems.push(`NO CURRENT: ${name} (locked but never superseded and not current — orphan)`);
  }
  return problems;
}

function statusOf(events) {
  // format v3 §3: status = tail mapping; superseded annotates completed/failed, never overrides.
  let status = 'queued';
  for (const ev of events) {
    switch (ev.type) {
      case 'created': status = 'queued'; break;
      case 'activated': status = 'active'; break;
      case 'completed': status = 'done'; break;
      case 'failed': status = 'failed'; break;
      case 'superseded': if (status !== 'done' && status !== 'failed') status = 'superseded'; break;
      // extended / evidence / artifact-locked annotate only
    }
  }
  return status;
}

function allStatuses() {
  const out = [];
  for (const file of walk(ROUNDS)) {
    const id = file.replace(new RegExp('^' + ROOT + '/tree/rounds/'), '').replace(/\/events\.jsonl$/, '');
    const evs = parseEvents(file);
    // artifact currency: superseded annotates completed (format v3) — show BOTH facts
    const superseded = evs.some((e) => e.type === 'superseded');
    out.push({ id, status: statusOf(evs) + (superseded ? ' · artifact superseded' : '') });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// Deterministic gate validation (no LLM) — F-AC15, both gates:
//  gate1: work (artifact-locked/completed) requires a `confirmed (gate=grill)` before it
//  gate2: every `completed` needs a `confirmed (gate=confirm)` after it
function gateProblems(id, events) {
  const problems = [];
  let lastComplete = -1, lastConfirm2 = -1, firstWork = -1, lastConfirm1 = -1, retroGrill = false;
  events.forEach((ev, i) => {
    const gate = ev.gate || (ev.note && (ev.note.match(/gate=(\w+)/) || [])[1]) || '';
    if (ev.type === 'completed') lastComplete = i;
    if (ev.type === 'artifact-locked' || ev.type === 'completed') {
      if (firstWork === -1) firstWork = i;
    }
    if (ev.type === 'confirmed' && (gate === 'confirm' || gate === '')) lastConfirm2 = i;
    if (ev.type === 'confirmed' && gate === 'grill') lastConfirm1 = i;
    if (ev.type === 'confirmed' && gate === 'grill' && ev.note && ev.note.includes('retrospective')) retroGrill = true;
  });
  if (lastComplete >= 0 && lastConfirm2 === -1) {
    problems.push(`GATE-2 GAP: ${id} — completed but no confirmed(gate=confirm) recorded`);
  }
  if (firstWork >= 0 && !retroGrill && (lastConfirm1 === -1 || lastConfirm1 > firstWork)) {
    problems.push(`GATE-1 GAP: ${id} — produced work (artifact-locked/completed) but no confirmed(gate=grill) before it`);
  }
  return problems;
}

const args = process.argv.slice(2);
const current = resolve();
const problems = check(current);

if (args[0] === 'confirm') {
  // GATE PRESENTATION — what to check, derived from the tree (functional-spec F7).
  // Usage: node scripts/resolve.mjs confirm <node-id>
  const id = args[1];
  if (!id) { console.error('usage: resolve.mjs confirm <node-id>'); process.exit(2); }
  const dir = join(ROOT, 'tree', 'rounds', id);
  const node = JSON.parse(readFileSync(join(dir, 'node.json'), 'utf8'));
  const evs = parseEvents(join(dir, 'events.jsonl'));
  const status = statusOf(evs);
  console.log(`NODE: ${id}  [${status}]`);
  console.log(`\nINTENT: ${node.contract && node.contract.intent}`);
  console.log(`\nWHAT TO CHECK — acceptance criteria (every one must be met + evidenced):`);
  (node.contract && node.contract.acceptanceCriteria || []).forEach((ac, i) => console.log(`  ${i + 1}. ${ac}`));
  // FIXED TEMPLATE — every section always renders; empty is an explicit state, never hidden.
  console.log(`\nARTIFACT(S):`);
  const lockedEvs = evs.filter((e) => e.type === 'artifact-locked');
  if (lockedEvs.length) for (const ev of lockedEvs) {
    const a = ev.artifact || {};
    console.log(`  - ${a.name || '?'} @ ${a.lockSha || '?'} → ${a.path || 'see note'}`);
  } else console.log(`  - (none — no artifact-locked event recorded)`);
  const evidence = evs.filter((e) => e.type === 'evidence').map((e) => e.note);
  console.log(`\nEVIDENCE:`);
  if (evidence.length) evidence.forEach((e) => console.log(`  - ${e}`));
  else console.log(`  - (none — no evidence events recorded)`);
  const gates = evs.filter((e) => ['submitted','confirmed','rejected'].includes(e.type)).map((e) => `${e.type}(${e.gate || '?'})${e.feedback ? ' fb:' + e.feedback : ''}`);
  console.log(`\nGATES:`);
  if (gates.length) gates.forEach((g) => console.log(`  - ${g}`));
  else console.log(`  - (none — no gate events recorded)`);
  const oqs = (node.openQuestions || []);
  console.log(`\nOPEN QUESTIONS:`);
  if (oqs.length) oqs.forEach((q) => console.log(`  - ${q.id}: ${q.question}${q.blocking ? ' [blocking]' : ''}`));
  else console.log(`  - (none)`);
  console.log(`\n→ verify each AC against the artifact + evidence, then confirm or reject + reason.`);
  process.exit(0);
}

if (args.includes('--journey')) {
  // LOOK-BACK (the observer action): where we are + what's ahead, derived from the log.
  // Not an assumption — every line below is read from events/gates/statuses.
  const all = allStatuses();
  const rounds = [...new Set(all.map((n) => n.id.split('/')[0]))].sort();
  console.log('=== WHERE WE ARE ===');
  for (const r of rounds) {
    const nodes = all.filter((n) => n.id === r || n.id.startsWith(r + '/'));
    const root = nodes.find((n) => n.id === r);
    const tasks = nodes.filter((n) => n.id !== r);
    console.log(`${r.padEnd(6)} ${root ? root.status : '?'}${tasks.length ? ' — tasks: ' + tasks.map((t) => t.id.replace(r + '/', '') + ':' + t.status).join(', ') : ''}`);
  }
  console.log('\n=== WHAT IS AHEAD ===');
  const active = all.find((n) => n.id.split('/').length === 1 && n.status === 'queued' || all.filter((n) => n.id.split('/').length === 1).find((n) => n.status === 'active'));
  const currentRound = rounds.find((r) => { const root = all.find((n) => n.id === r); return root && (root.status === 'active' || (root.status === 'queued' && r === rounds[rounds.length - 1])); });
  if (currentRound) {
    const root = all.find((n) => n.id === currentRound);
    console.log(`active round: ${currentRound} (${root.status})`);
    const ready = all.filter((n) => n.id.startsWith(currentRound + '/') && (n.status === 'queued' || n.status === 'active'))
                     .sort((a, b) => a.id.localeCompare(b.id));
    if (ready.length) { console.log(`frontmost-ready: ${ready[0].id} (${ready[0].status})`); ready.slice(1).forEach((t) => console.log(`  also ready: ${t.id}`)); }
    else console.log('no ready tasks in round — round gate may need review');
  } else {
    console.log('no active round — next round to spawn after gate review');
  }
  console.log('\n(grounded in: statuses + gates + validation — run --check / validate.mjs for the proof)');
  process.exit(0);
}

if (args.includes('--status')) {
  const filter = args.find((a) => !a.startsWith('--'));
  const all = allStatuses();
  for (const n of all) {
    if (filter && !n.id.includes(filter)) continue;
    console.log(`${n.id.padEnd(58)} ${n.status}`);
  }
  process.exit(0);
}

if (args.includes('--specs')) {
  // Full specs index: read each current artifact's lock marker + link contract.
  const rows = [];
  for (const [name, l] of [...current.entries()].sort()) {
    const full = join(ROOT, l.path);
    let type = '', sha = l.sha || '', upstream = '', referrers = '';
    try {
      const head = readFileSync(full, 'utf8').split('\n').slice(0, 10);
      for (const line of head) {
        const m = line.match(/specs:locked:([0-9a-f]+) [0-9-]+ type=(\S+)/);
        if (m) { sha = m[1]; type = m[2]; }
        const u = line.match(/\*\*upstream\*\* \(this doc relies on\): (.*)/);
        if (u) upstream = u[1];
        const r = line.match(/\*\*referrers\*\* \(must cite this when they change\): (.*)/);
        if (r) referrers = r[1];
      }
    } catch { /* unreadable artifact — row still shows */ }
    rows.push({ name, type, sha, upstream, referrers, path: l.path });
  }
  for (const r of rows) {
    console.log(`\n${r.name}  [${r.type || '?'}]  @ ${r.sha || '?'}`);
    console.log(`  path:      ${r.path}`);
    if (r.upstream) console.log(`  upstream:  ${r.upstream}`);
    if (r.referrers) console.log(`  referrers: ${r.referrers}`);
  }
  if (problems.length) { console.error('\nPROBLEMS:'); for (const p of problems) console.error('  ' + p); process.exit(1); }
  process.exit(0);
}

if (args[0] === 'append') {
  // Single-writer append (architecture LB-3), scripted: validate schema, append,
  // then gate-check the node. Usage: node scripts/resolve.mjs append <node-id> '<json>'
  const id = args[1];
  const raw = args.slice(2).join(' ');
  if (!id || !raw) { console.error('usage: resolve.mjs append <node-id> \'{"at":...,"type":...,...}\''); process.exit(2); }
  const file = join(ROOT, 'tree', 'rounds', id, 'events.jsonl');
  const ev = JSON.parse(raw);
  const TYPES = ['created','activated','extended','evidence','artifact-locked','completed','failed','superseded','submitted','confirmed','rejected','gate-revised','transferred','deferred'];
  if (!ev.at || !ev.type || !TYPES.includes(ev.type)) {
    console.error(`append rejected: bad schema (at + known type required, got ${ev.type})`); process.exit(1);
  }
  const line = JSON.stringify(ev) + '\n';
  appendFileSync(file, line);
  const problems = gateProblems(id, parseEvents(file));
  console.log(`appended ${ev.type}${ev.gate ? ' (gate=' + ev.gate + ')' : ''} → ${id}`);
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  process.exit(0);
}

if (args.includes('--check')) {
  for (const p of problems) console.error(p);
  // Deterministic gate validation: every completed node needs confirmed(gate=confirm).
  const gateGaps = [];
  for (const file of walk(ROUNDS)) {
    const id = file.replace(new RegExp('^' + ROOT + '/tree/rounds/'), '').replace(/\/events\.jsonl$/, '');
    for (const p of gateProblems(id, parseEvents(file))) gateGaps.push(p);
  }
  for (const g of gateGaps) console.error(g);
  const total = problems.length + gateGaps.length;
  console.log(total === 0 ? `OK — ${current.size} current artifacts, all gates confirmed.` : `${total} problem(s).`);
  process.exit(total === 0 ? 0 : 1);
}

if (args[0] && !args[0].startsWith('--')) {
  const l = current.get(args[0]);
  if (!l) { console.error(`resolve: no current artifact for '${args[0]}'`); process.exit(1); }
  console.log(l.path);
  if (l.sha) console.error(`  (locked @ ${l.sha}, producer ${l.producer})`);
} else {
  for (const [name, l] of [...current.entries()].sort()) {
    console.log(`${name.padEnd(28)} ${l.path}${l.sha ? '  @ ' + l.sha : ''}`);
  }
}
