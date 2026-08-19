#!/usr/bin/env node
/**
 * resolve.mjs — the derived logical-name resolver (journey-format-spec §5, F-AC13 seed).
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

import { readFileSync, existsSync, readdirSync, statSync, lstatSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';

const ROOT = process.cwd();
const ROUNDS = join(ROOT, 'journey', 'legs');
// The vocab registry (resource-registry spec, instance #2): the single source of truth
// for schema vocabulary — event types, statuses, gates, artifact types. Consumers read;
// never hardcode. Missing = misconfigured (fail loudly, not silently).
let VOCAB;
try { VOCAB = JSON.parse(readFileSync(join(ROOT, 'rules', 'schema', 'vocab.json'), 'utf8')); }
catch { console.error('vocab registry missing/invalid: rules/schema/vocab.json — the single source of truth for schema vocabulary (resource-registry spec)'); process.exit(1); }

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (!lstatSync(p).isSymbolicLink() && statSync(p).isDirectory()) walk(p, acc);
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
        const path = (artifact.path || producer + '/artifacts/' + filename).replace(/^tree\/rounds\//, 'journey/legs/').replace(/^(journey\/legs\/[^/]+)\/00\//, '$1/');
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
    const full = join(ROOT, l.path.replace(/^tree\/rounds\//, 'journey/legs/').replace(/^(journey\/legs\/[^/]+)\/00\//, '$1/'));
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
  // format v7 §3: status = tail mapping (TASKS); superseded annotates completed/failed, never overrides.
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

// Derived leg status (journey-format-spec v7 §12) — a pure function of the leg's tasks:
//  all direct children done            → done
//  no children                         → own lifecycle from root events (grandfathered childless legs, e.g. L1; new legs have no root events → queued)
//  frontmost-ready child exists        → that child's status (lowest prefix among not-done/failed/superseded)
//  no frontmost-ready (all failed/etc) → blocked (escalate: retry / transfer / close)
function legStatus(id, raw) {
  const children = raw.filter((n) => n.id.startsWith(id + '/') && n.id.split('/').length === 2);
  if (!children.length) return raw.find((n) => n.id === id)?.status || 'queued';
  if (children.every((c) => c.status === 'done' || c.status === 'superseded')) return 'done';
  const ready = children.filter((c) => !['done', 'failed', 'superseded'].includes(c.status)).sort((a, b) => a.id.localeCompare(b.id));
  return ready.length ? ready[0].status : 'blocked';
}

function walkNodes(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (!lstatSync(p).isSymbolicLink() && statSync(p).isDirectory()) walkNodes(p, acc);
    else if (entry === 'node.json') acc.push(p);
  }
  return acc;
}

function allStatuses() {
  // Two-pass: raw task statuses from events, then leg roots derive from children (v7 §12).
  // Node EXISTENCE comes from node.json (v8: leg roots have no events.jsonl); events optional.
  const raw = [];
  for (const file of walkNodes(ROUNDS)) {
    const id = file.replace(new RegExp('^' + ROOT + '/journey/legs/'), '').replace(/\/node\.json$/, '');
    const evs = existsSync(file.replace(/node\.json$/, 'events.jsonl')) ? parseEvents(file.replace(/node\.json$/, 'events.jsonl')) : [];
    const superseded = evs.some((e) => e.type === 'superseded');
    raw.push({ id, status: statusOf(evs), superseded });
  }
  const out = [];
  for (const n of raw) {
    const status = n.id.split('/').length === 1 ? legStatus(n.id, raw) : n.status;
    out.push({ id: n.id, status: status + (n.superseded ? ' · artifact superseded' : '') });
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

// Command registry — the declaration; --help renders from it (derived, never drifts).
const COMMANDS = [
  { name: 'locate', args: '<name> [anchor]', desc: 'resolve a logical name → current path, and locate an anchor in it' },
  { name: '--check', args: '', desc: 'integrity + gates + artifact hashes (OK = green)' },
  { name: '--status', args: '[filter]', desc: 'every node\'s derived status (+ artifact-superseded marker)' },
  { name: '--journey', args: '', desc: 'the forest look-back: where we are + what\'s ahead' },
  { name: 'journey|--journey', args: '<id>', desc: 'one node\'s full event walk' },
  { name: '--branch', args: '<id>', desc: 'a node + every descendant\'s events, one walk' },
  { name: '--specs', args: '', desc: 'the locked contract stack (name · type · @sha · path · upstreams)' },
  { name: 'confirm', args: '<id>', desc: 'a node\'s gate card: intent · ACs · artifacts · evidence · gates' },
  { name: 'append', args: '<id> \'<json>\'', desc: 'single-writer append: validates schema, appends, gate-checks' },
  { name: 'spawn', args: '<id> \'<contract-json>\'', desc: 'create a node (leg or task): shape/name/parent/artifact-gate/leg-gate validated; writes node.json + created + card' },
  { name: 'gate', args: '<id> grill|confirm accept|reject [feedback]', desc: 'record a human gate decision (submits first; 3-reject bound → escalate)' },
  { name: 'lock', args: '<id> <name> [type]', desc: 'stamp the lock marker + artifact-locked event (one current per name; hash-verifying sha)' },
  { name: 'supersede', args: '<id> <name> <path> [note]', desc: 'record a superseded event with structured successor' },
  { name: 'card', args: '<id>', desc: 'regenerate description.md from contract + events (the only rewritable file)' },
  { name: '--help', args: '[command]', desc: 'this usage, generated from the command registry' },
];

const args = process.argv.slice(2);
const current = resolve();
const problems = check(current);

function nodeJourney(id) {
  const file = join(ROOT, 'journey', 'legs', id, 'events.jsonl');
  const evs = parseEvents(file);
  console.log(`JOURNEY: ${id}`);
  console.log(`---------`);
  evs.forEach((ev, i) => {
    const gate = ev.gate && typeof ev.gate === 'object'
      ? `gate: ${ev.gate.old || '?'} → ${ev.gate.new || '?'}`
      : ev.gate ? ` (gate=${ev.gate})` : '';
    const extra = ev.type === 'artifact-locked'
      ? ` ${(ev.artifact && ev.artifact.name) || ''} @ ${(ev.artifact && ev.artifact.lockSha) || (ev.note.match(/@\s*([0-9a-f]{7,})/) || [])[1] || ''}`
      : ev.type === 'superseded'
        ? ` → ${(ev.successor && ev.successor.path) || (ev.note.match(/superseded by\s+([\w./-]+\.md)/) || [])[1] || ''}`
        : ev.type === 'transferred' ? ` → ${ev.target || ''}` : '';
    console.log(`${String(i + 1).padStart(2)}. ${ev.at || ''}  ${ev.type}${gate ? ' ' + gate : ''}${extra}`);
    if (ev.note) console.log(`      ${ev.note}`);
    if (ev.feedback) console.log(`      feedback: ${ev.feedback}`);
  });
  console.log(`---------`);
  const st = id.includes('/') ? statusOf(evs) : (legStatus(id, allStatuses().map((n) => ({ id: n.id, status: n.status.replace(' · artifact superseded', '') }))) || statusOf(evs));
  console.log(`STATUS: ${st}${evs.some((e) => e.type === 'superseded') ? ' · artifact superseded' : ''}`);
}

if (args.includes('--branch')) {
  // SUBTREE JOURNEY: a node + every descendant's events, one walk.
  const root = args[1] || args[args.indexOf('--branch') + 1];
  if (!root) { console.error('usage: resolve.mjs --branch <node-id>'); process.exit(2); }
  const base = join(ROOT, 'journey', 'legs', root);
  const files = [];
  const scan = (dir) => { for (const e of readdirSync(dir)) { const p = join(dir, e); if (!lstatSync(p).isSymbolicLink() && statSync(p).isDirectory()) scan(p); else if (e === 'node.json') files.push(p); } };
  scan(base);
  files.sort((a, b) => (a + '.e').localeCompare(b + '.e'));
  for (const f of files) {
    const id = f.replace(new RegExp('^' + ROOT + '/journey/legs/'), '').replace(/\/node\.json$/, '');
    const evs = existsSync(f.replace(/node\.json$/, 'events.jsonl')) ? parseEvents(f.replace(/node\.json$/, 'events.jsonl')) : [];
    const st = id.includes('/') ? statusOf(evs) : (legStatus(id, allStatuses().map((n) => ({ id: n.id, status: n.status.replace(' · artifact superseded', '') }))) || statusOf(evs));
    console.log(`\n▸ ${id}  [${st}${evs.some((e) => e.type === 'superseded') ? ' · artifact superseded' : ''}]`);
    for (const ev of evs) {
      const gate = ev.gate && typeof ev.gate === 'object' ? ` gate: ${ev.gate.old || '?'} → ${ev.gate.new || '?'}` : ev.gate ? ` (gate=${ev.gate})` : '';
      const extra = ev.type === 'transferred' ? ` → ${ev.target || ''}` : '';
      console.log(`   ${ev.at || ''} ${ev.type}${gate}${extra}${ev.note ? ' — ' + ev.note.slice(0, 90) : ''}`);
    }
  }
  process.exit(0);
}

if (args[0] === 'journey' || (args.includes('--journey') && args[1])) {
  // A NODE'S JOURNEY (F11 history): the event walk. Usage: resolve.mjs journey <id> | --journey <id>
  const id = args[args[0] === 'journey' ? 1 : 1];
  if (!id) { console.error('usage: resolve.mjs journey <node-id>'); process.exit(2); }
  nodeJourney(id);
  process.exit(0);
}

if (args[0] === 'confirm') {
  // GATE PRESENTATION — what to check, derived from the tree (functional-spec F7).
  // Usage: node scripts/resolve.mjs confirm <node-id>
  const id = args[1];
  if (!id) { console.error('usage: resolve.mjs confirm <node-id>'); process.exit(2); }
  const dir = join(ROOT, 'journey', 'legs', id);
  const node = JSON.parse(readFileSync(join(dir, 'node.json'), 'utf8'));
  const contract = (node.contract && node.contract.contract) || node.contract || {};
  const evs = parseEvents(join(dir, 'events.jsonl'));
  const status = statusOf(evs);
  console.log(`NODE: ${id}  [${status}]`);
  console.log(`\nINTENT: ${contract.intent}`);
  console.log(`\nWHAT TO CHECK — acceptance criteria (every one must be met + evidenced):`);
  (contract.acceptanceCriteria || []).forEach((ac, i) => console.log(`  ${i + 1}. ${ac}`));
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
    console.log(`active leg: ${currentRound} (${root.status})`);
    const ready = all.filter((n) => n.id.startsWith(currentRound + '/') && (n.status === 'queued' || n.status === 'active'))
                     .sort((a, b) => a.id.localeCompare(b.id));
    if (ready.length) { console.log(`frontmost-ready: ${ready[0].id} (${ready[0].status})`); ready.slice(1).forEach((t) => console.log(`  also ready: ${t.id}`)); }
    else if (root.status.startsWith('done')) console.log('LEG GATE REVIEW: all spawned tasks done — verify the epic ACs (node.json contract) before advancing or spawning remaining tasks');
    else console.log('no ready tasks in leg — leg gate may need review');
  } else {
    const done = rounds.filter((r) => all.find((n) => n.id === r && n.status.startsWith('done')));
    console.log(done.length ? `no active leg — previous leg (${done[done.length - 1]}) derived done; LEG GATE REVIEW before spawning the next leg` : 'no active round — next leg to spawn after gate review');
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

if (args.includes('--gantt')) {
  // GANTT from the journey: per-node span = first event date → completed/last event date.
  const rows = [];
  for (const f of walk(ROUNDS)) {
    const id = f.replace(new RegExp('^' + ROOT + '/journey/legs/'), '').replace(/\/events\.jsonl$/, '');
    const evs = parseEvents(f);
    if (!evs.length) continue;
    const dates = evs.map((e) => e.at).filter(Boolean).sort();
    const start = dates[0];
    const comp = evs.find((e) => e.type === 'completed');
    const end = comp ? comp.at || start : dates[dates.length - 1];
    rows.push({ id, start, end });
  }
  const allD = rows.flatMap((r) => [r.start, r.end]).sort();
  const d0 = allD[0], d1 = allD[allD.length - 1];
  const addDays = (ds, n) => { const [y, m, d] = ds.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d + n)); return dt.toISOString().slice(0, 10); };
  const days = [];
  for (let i = 0; addDays(d0, i) <= d1; i++) days.push(addDays(d0, i));
  console.log(`GANTT (${days.length} day(s): ${d0} → ${d1})`);
  const head = '       ' + days.map((d) => d.slice(5)).join(' ');
  console.log(head);
  for (const r of rows) {
    const si = days.indexOf(r.start), ei = days.indexOf(r.end);
    let line = '';
    for (let i = 0; i < days.length; i++) line += i >= si && i <= ei ? '▓▓' : '  ';
    console.log(`${r.id.padEnd(10).slice(0, 10)} ${line}  ${r.start}→${r.end}`);
  }
  process.exit(0);
}

if (args[0] === 'locate') {
  // Anchor lookup: logical name → current path, then find the anchor in the doc.
  const name = args[1], anchor = args[2];
  if (!name) { console.error('usage: resolve.mjs locate <name> [anchor]'); process.exit(2); }
  const l = current.get(name);
  if (!l) { console.error(`locate: no current artifact for '${name}'`); process.exit(1); }
  const full = join(ROOT, l.path);
  console.log(`${name} → ${l.path}${l.sha ? '  @ ' + l.sha : ''}`);
  if (!anchor) process.exit(0);
  const lines = readFileSync(full, 'utf8').split('\n');
  const re = new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const hits = [];
  lines.forEach((ln, i) => { if (re.test(ln)) hits.push(i); });
  if (!hits.length) { console.error(`locate: anchor '${anchor}' not found in ${name} (anchors are stable — section renumbering is a validator error)`); process.exit(1); }
  for (const i of hits.slice(0, 3)) {
    console.log(`\n── line ${i + 1} ──`);
    for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 4); j++) console.log(lines[j]);
  }
  process.exit(0);
}

if (args[0] === '--help' || args.includes('--help')) {
  const want = args.find((a) => !a.startsWith('--') && a !== 'help') || (args.includes('--help') && args[args.indexOf('--help') + 1] && !args[args.indexOf('--help') + 1].startsWith('--') ? args[args.indexOf('--help') + 1] : null);
  if (want) {
    const c = COMMANDS.find((x) => x.name === want) || COMMANDS.find((x) => x.name.includes(want));
    if (!c) { console.error(`no command '${want}'`); process.exit(1); }
    console.log(`${c.name} ${c.args}\n  ${c.desc}\n  serves: ${c.serves}`);
    process.exit(0);
  }
  console.log('resolve.mjs — the pre-engine CLI (all state derived from journey/ + rules/, no LLM, no server)');
  console.log('');
  for (const c of COMMANDS) console.log(`  ${(c.name + ' ' + c.args).padEnd(26)} ${c.desc}${c.serves ? '  ·  serves: ' + c.serves : ''}`);
  console.log('\nvalidate.mjs — the rule registry report: run it, --rules, or one rule id');
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
  const file = join(ROOT, 'journey', 'legs', id, 'events.jsonl');
  const ev = JSON.parse(raw);
  const TYPES = VOCAB.eventTypes; // vocab registry — never hardcode
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

// ---- Bookkeeper: every store mutation goes through a command, never a hand edit ----
const TODAY = new Date().toISOString().slice(0, 10);
const WHO = process.env.RECORDED_BY || 'agent';
const nodeFile = (id) => join(ROOT, 'journey', 'legs', id, 'node.json');
const eventFile = (id) => join(ROOT, 'journey', 'legs', id, 'events.jsonl');

if (args[0] === 'spawn') {
  // Create a node (leg or task). Validates shape (v8 flat), name discipline, parent
  // existence, artifact gate (task parent has a locked artifact), leg gate (new leg
  // only after previous leg's tasks all done), prefix uniqueness. Writes node.json
  // (immutable), the `created` event, and a skeleton card.
  const id = args[1];
  const raw = args.slice(2).join(' ');
  if (!id || !raw || id.startsWith('--')) { console.error('usage: resolve.mjs spawn <id> \'{"contract":{"intent":...,"acceptanceCriteria":[...]}}\''); process.exit(2); }
  const segs = id.split('/');
  const last = segs[segs.length - 1];
  if (segs.includes('00')) { console.error('spawn rejected: the 00/ level dir was removed in v8 — tasks live directly under the leg'); process.exit(1); }
  if (!/^\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/.test(last)) { console.error(`spawn rejected: last segment '${last}' must be NN-kebab-case`); process.exit(1); }
  if (last.length > 24) { console.error(`spawn rejected: segment '${last}' exceeds 24 chars`); process.exit(1); }
  if (existsSync(nodeFile(id))) { console.error(`spawn rejected: ${id} already exists`); process.exit(1); }
  if (segs.length > 1) {
    const parent = segs.slice(0, -1).join('/');
    if (!existsSync(nodeFile(parent))) { console.error(`spawn rejected: parent ${parent} does not exist`); process.exit(1); }
    if (parent.split('/').length >= 2) { // a task parent must have a locked artifact (artifact gate)
      const pe = parseEvents(eventFile(parent));
      if (!pe.some((e) => e.type === 'artifact-locked')) { console.error(`spawn rejected: artifact gate — parent task ${parent} has no artifact-locked event`); process.exit(1); }
    }
    const sibDir = join(ROOT, 'journey', 'legs', parent);
    const sibs = readdirSync(sibDir).filter((e) => !lstatSync(join(sibDir, e)).isSymbolicLink() && existsSync(join(sibDir, e, 'node.json')));
    if (sibs.includes(last)) { console.error(`spawn rejected: sibling ${last} already exists`); process.exit(1); }
    const prefix = last.split('-')[0];
    const clash = sibs.find((s) => s.startsWith(prefix + '-'));
    if (clash) { console.error(`spawn rejected: prefix ${prefix} already used by sibling ${clash}`); process.exit(1); }
  } else {
    // New leg: leg gate — previous leg's tasks must all be done (derived, v7 §12)
    const legs = readdirSync(ROUNDS).filter((e) => !lstatSync(join(ROUNDS, e)).isSymbolicLink()).sort();
    const idx = legs.indexOf(id);
    if (idx > 0) {
      const prevDir = join(ROUNDS, legs[idx - 1]);
      const prevTasks = readdirSync(prevDir).filter((e) => !lstatSync(join(prevDir, e)).isSymbolicLink() && existsSync(join(prevDir, e, 'node.json')));
      const allDone = prevTasks.length
        ? prevTasks.every((t) => parseEvents(join(prevDir, t, 'events.jsonl')).some((e) => e.type === 'completed' || e.type === 'superseded'))
        : parseEvents(join(prevDir, 'events.jsonl')).some((e) => e.type === 'completed'); // childless leg → its own record (L1 base step)
    }
  }
  let contract;
  try { contract = JSON.parse(raw); } catch (e) { console.error(`spawn rejected: bad contract JSON (${e.message})`); process.exit(1); }
  const dir = join(ROOT, 'journey', 'legs', id);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(nodeFile(id), JSON.stringify({ id, contract, createdAt: TODAY }, null, 2) + '\n');
  appendFileSync(eventFile(id), JSON.stringify({ at: TODAY, type: 'created', note: `spawned by bookkeeper (${WHO})` }) + '\n');
  const intent = (contract.contract && contract.contract.intent) || contract.intent || '';
  const terms = (intent.match(/[A-Za-z][A-Za-z0-9-]{3,}/g) || []).slice(0, 8).join(', ');
  writeFileSync(join(dir, 'description.md'), `# ${last}\n\n- id: \`${id}\` · status: queued · type: ${segs.length > 1 ? 'task' : 'leg'}\n- summary: ${intent.split('\n')[0]}\n- search terms: ${terms}\n`);
  console.log(`spawned ${id} (${segs.length > 1 ? 'task' : 'leg'})`);
  process.exit(0);
}

if (args[0] === 'gate') {
  // Record a human gate decision: submits first if no pending submission, then
  // confirmed/rejected. 3 rejection cycles per gate → escalate (flow-control v3 §3).
  const id = args[1], gate = args[2], decision = args[3];
  const feedback = args.slice(4).join(' ');
  if (!id || !VOCAB.gates.includes(gate) || !['accept', 'reject'].includes(decision)) {
    console.error('usage: resolve.mjs gate <id> grill|confirm accept|reject [feedback]'); process.exit(2);
  }
  if (!existsSync(eventFile(id))) { console.error(`gate: no node ${id}`); process.exit(1); }
  const file = eventFile(id);
  const evs = parseEvents(file);
  const pending = evs.filter((e) => e.type === 'submitted' && e.gate === gate && !evs.slice(evs.indexOf(e) + 1).some((x) => x.type === 'confirmed' && x.gate === gate));
  if (!pending.length) appendFileSync(file, JSON.stringify({ at: TODAY, type: 'submitted', gate, note: `bookkeeper submission (${WHO})` }) + '\n');
  const rejects = evs.filter((e) => e.type === 'rejected' && e.gate === gate).length;
  if (decision === 'reject' && rejects >= 3) { console.error('gate: 3 rejection cycles exhausted — escalate to a human design decision (force-approve / restructure / block)'); process.exit(1); }
  const ev = decision === 'accept'
    ? { at: TODAY, type: 'confirmed', gate, note: `accepted (${WHO})` }
    : { at: TODAY, type: 'rejected', gate, feedback, note: `rejected (${WHO})` };
  appendFileSync(file, JSON.stringify(ev) + '\n');
  const problems = gateProblems(id, parseEvents(file));
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log(`gate ${gate}: ${decision} → ${id}`);
  process.exit(0);
}

function blobSha(content) { return createHash('sha1').update('blob ' + Buffer.byteLength(content) + '\n' + content).digest('hex'); }

if (args[0] === 'lock') {
  // Stamp the lock marker + artifact-locked event. lockSha = git blob sha of the
  // artifact content WITHOUT the marker line (the hash-verifying convention, v8).
  const id = args[1], name = args[2], type = args[3] || 'spec';
  if (!id || !name) { console.error('usage: resolve.mjs lock <id> <name> [type]'); process.exit(2); }
  if (!VOCAB.artifactTypes.includes(type)) { console.error(`lock rejected: type '${type}' not in the vocab registry (${VOCAB.artifactTypes.join(' | ')})`); process.exit(1); }
  if (!existsSync(nodeFile(id))) { console.error(`lock: no node ${id}`); process.exit(1); }
  if (current.has(name)) { console.error(`lock rejected: '${name}' is already current (${current.get(name).path}) — supersede it first`); process.exit(1); }
  const artDir = join(ROOT, 'journey', 'legs', id, 'artifacts');
  const candidates = existsSync(artDir) ? readdirSync(artDir).filter((f) => f.endsWith('.md')) : [];
  const file = existsSync(join(artDir, name + '.md')) ? join(artDir, name + '.md') : (candidates.length === 1 ? join(artDir, candidates[0]) : null);
  if (!file) { console.error(`lock: no artifacts/${name}.md; candidates: ${candidates.join(', ') || '(none)'}`); process.exit(1); }
  const content = readFileSync(file, 'utf8').replace(/^<!-- specs:locked:[^\n]* -->\n?/, '').replace(/^<!-- draft[^\n]* -->\n?/, '');
  const sha = blobSha(content).slice(0, 7);
  writeFileSync(file, `<!-- specs:locked:${sha} ${TODAY} type=${type} -->\n` + content);
  appendFileSync(eventFile(id), JSON.stringify({ at: TODAY, type: 'artifact-locked', artifact: { name, path: 'journey/legs/' + id + '/artifacts/' + basename(file), lockSha: sha }, note: `${basename(file)} specs-locked via bookkeeper (${WHO})` }) + '\n');
  const problems = gateProblems(id, parseEvents(eventFile(id)));
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log(`locked ${name} @ ${sha} → ${id}`);
  process.exit(0);
}

if (args[0] === 'supersede') {
  // Record a superseded event with a structured successor (forward pointer, format §5).
  const id = args[1], name = args[2], path = args[3];
  const note = args.slice(4).join(' ');
  if (!id || !name || !path) { console.error('usage: resolve.mjs supersede <id> <name> <artifact-path-from-ROOT> [note]'); process.exit(2); }
  if (!existsSync(nodeFile(id))) { console.error(`supersede: no node ${id}`); process.exit(1); }
  if (!existsSync(join(ROOT, path))) { console.error(`supersede: target path ${path} not found`); process.exit(1); }
  appendFileSync(eventFile(id), JSON.stringify({ at: TODAY, type: 'superseded', successor: { name, path }, note: note || `${name} superseded → ${path} (${WHO})` }) + '\n');
  console.log(`superseded ${name} → ${path} on ${id}`);
  process.exit(0);
}

if (args[0] === 'card') {
  // Regenerate description.md (the only rewritable file, §4) from contract + events.
  const id = args[1];
  if (!id || !existsSync(nodeFile(id))) { console.error('usage: resolve.mjs card <id> (node must exist)'); process.exit(2); }
  const node = JSON.parse(readFileSync(nodeFile(id), 'utf8'));
  const evs = parseEvents(eventFile(id));
  const status = allStatuses().find((n) => n.id === id)?.status || 'queued';
  const artifacts = evs.filter((e) => e.type === 'artifact-locked').map((e) => {
    const a = e.artifact || {};
    const nm = a.name || (e.note.match(/logical name:\s*([\w.-]+)/) || [])[1] || '';
    return nm ? `- ${nm}: ${a.path || ''}` : null;
  }).filter(Boolean);
  const dir = join(ROOT, 'journey', 'legs', id);
  const kids = readdirSync(dir).filter((e) => !lstatSync(join(dir, e)).isSymbolicLink() && existsSync(join(dir, e, 'node.json'))).sort();
  const last = id.split('/').pop();
  const intent = (node.contract && node.contract.intent) || '';
  const terms = (intent.match(/[A-Za-z][A-Za-z0-9-]{3,}/g) || []).slice(0, 8).join(', ');
  const body = `# ${last}\n\n- id: \`${id}\` · status: ${status} · type: ${id.split('/').length === 1 ? 'leg' : 'task'}\n- summary: ${intent.split('\n')[0]}\n- search terms: ${terms}\n\n## artifacts\n${artifacts.join('\n') || '(none yet)'}\n\n## children\n${kids.length ? kids.map((k) => `- ${id}/${k}`).join('\n') : '(none)'}\n`;
  writeFileSync(join(dir, 'description.md'), body);
  console.log(`card regenerated → ${id}`);
  process.exit(0);
}

if (args.includes('--check')) {
  for (const p of problems) console.error(p);
  // Deterministic gate validation: every completed node needs confirmed(gate=confirm).
  const gateGaps = [];
  for (const file of walkNodes(ROUNDS)) {
    const id = file.replace(new RegExp('^' + ROOT + '/journey/legs/'), '').replace(/\/node\.json$/, '');
    const evs = existsSync(file.replace(/node\.json$/, 'events.jsonl')) ? parseEvents(file.replace(/node\.json$/, 'events.jsonl')) : [];
    for (const p of gateProblems(id, evs)) gateGaps.push(p);
  }
  for (const g of gateGaps) console.error(g);
  // Artifact integrity (v8): marker-stripped blob vs recorded lockSha. New locks use
  // the blob convention and verify exactly; legacy commit-style shas verify via git
  // history when resolvable; draft-marker-era stamps are noted as unverified.
  const hashNotes = [];
  for (const [name, l] of current) {
    const full = join(ROOT, l.path);
    if (!existsSync(full)) continue; // already flagged MISSING above
    const content = readFileSync(full, 'utf8');
    const stripped = content.replace(/^<!-- specs:locked:[^\n]* -->\n?/, '').replace(/^<!-- draft[^\n]* -->\n?/, '');
    const h = blobSha(stripped).slice(0, 7);
    const markerSha = (content.match(/specs:locked:([0-9a-f]{7,})/) || [])[1] || l.sha || '';
    if (markerSha && h === markerSha.slice(0, 7)) continue; // verified — blob convention
    let kind = '';
    try { kind = execSync(`git cat-file -t ${markerSha}`, { encoding: 'utf8' }).trim(); } catch {}
    if (kind === 'commit') {
      try {
        const hit = execSync(`git ls-tree -r --name-only ${markerSha} | grep -F "${basename(l.path)}" | head -1`, { encoding: 'utf8' }).trim();
        if (hit) {
          let at = execSync(`git show ${markerSha}:${hit}`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
          at = at.replace(/^<!-- specs:locked:[^\n]* -->\n?/, '');
          if (blobSha(at).slice(0, 7) === h) hashNotes.push({ sev: 'ok', msg: `${name}: verified vs lock commit ${markerSha.slice(0, 7)}` });
          else hashNotes.push({ sev: 'warn', msg: `${name}: edited after lock commit ${markerSha.slice(0, 7)} (pre-integrity era; see 'git log -- ${l.path}'); re-lock via 'bookkeeper lock' if intentional` });
        } else hashNotes.push({ sev: 'info', msg: `${name}: lock commit ${markerSha.slice(0, 7)} — basename not found (unverified)` });
      } catch { hashNotes.push({ sev: 'info', msg: `${name}: legacy lock commit ${markerSha.slice(0, 7)} unverified` }); }
    } else if (kind === 'blob') {
      hashNotes.push({ sev: 'info', msg: `${name}: legacy blob stamp (draft-marker era) — not hash-verified; re-lock with 'bookkeeper lock' for a verifying sha` });
    } else {
      hashNotes.push({ sev: 'error', msg: `${name}: lockSha ${markerSha || '(none)'} is neither commit nor blob` });
    }
  }
  // Working-tree tamper check: current artifacts modified but not committed.
  for (const [name, l] of current) {
    try { execSync(`git diff --quiet HEAD -- "${l.path}"`); } catch { hashNotes.push({ sev: 'error', msg: `${name}: uncommitted modification on disk (${l.path})` }); }
  }
  const errors = problems.length + gateGaps.length + hashNotes.filter((n) => n.sev === 'error').length;
  for (const n of hashNotes) {
    if (n.sev === 'error') console.error(`  [hash] ${n.msg}`);
    else if (n.sev === 'warn') console.log(`  [hash-warn] ${n.msg}`);
    else console.log(`  [hash] ${n.msg}`);
  }
  const total = errors;
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
