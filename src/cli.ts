#!/usr/bin/env node
/**
 * ann — the journey CLI (S1 store seed). Read + manage through commands only;
 * never hand-edit node.json/events.jsonl (read discipline, journey-format-spec v8 §6).
 * Replaces scripts/resolve.mjs as the engine CLI surface.
 *
 * Usage:
 *   ann                    → name → current-path map
 *   ann <name>             → current path for one logical name
 *   ann --journey          → the look-back (where we are + what's ahead)
 *   ann --status [filter]  → every node's derived status
 *   ann --check            → integrity + gates + artifact hashes
 *   ann --specs            → the locked contract stack
 *   ann --branch <id>      → a node + every descendant's events
 *   ann journey <id>       → one node's full event walk
 *   ann confirm <id>       → a node's gate card
 *   ann append <id> '{"at":..,"type":..}'   → single-writer append (LB-3)
 *   ann spawn <id> '<contract-json>'        → create a node (validated)
 *   ann gate <id> grill|confirm accept|reject [feedback]
 *   ann lock <id> <name> [type]             → stamp marker + artifact-locked
 *   ann supersede <id> <name> <path> [note]
 *   ann card <id>                           → regenerate description.md
 */
import {
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  lstatSync,
  statSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Store } from './store/store.js';
import { VOCAB } from './store/vocab.js';

const ROOT = process.cwd();
const TODAY = new Date().toISOString().slice(0, 10);
const WHO = process.env.RECORDED_BY || 'agent';
const args = process.argv.slice(2);
const store = new Store(ROOT);

const blobSha = (c: string): string => createHash('sha1').update('blob ' + Buffer.byteLength(c) + '\n' + c).digest('hex');
const nodeFile = (id: string) => join(ROOT, 'journey', 'legs', id, 'node.json');
const eventFile = (id: string) => join(ROOT, 'journey', 'legs', id, 'events.jsonl');
const hasSuperseded = (id: string) => store.events(id).some((e) => e.type === 'superseded');
const display = (id: string) => store.status(id) + (hasSuperseded(id) ? ' · artifact superseded' : '');
const nameOf = (e: { artifact?: { name?: string }; note?: string }) =>
  e.artifact?.name ?? String(e.note ?? '').match(/logical name:\s*([\w.-]+)/)?.[1] ?? '';
const lockShaOf = (id: string): { name: string; path: string; sha: string }[] => {
  const out: Array<{ name: string; path: string; sha: string }> = [];
  for (const e of store.events(id)) {
    if (e.type !== 'artifact-locked') continue;
    const a = e.artifact;
    const filename = a?.path ? basename(a.path) : String(e.note ?? '').match(/([\w.-]+\.md)/)?.[1] ?? '';
    out.push({
      name: nameOf(e),
      path: a?.path ?? `${id}/artifacts/${filename}`,
      sha: a?.lockSha ?? String(e.note ?? '').match(/@\s*([0-9a-f]{7,})/)?.[1] ?? '',
    });
  }
  return out;
};

// ---- READ / DERIVE ----
function cmdJourney() {
  const legs = store.ids().filter((i) => !i.includes('/')).sort();
  console.log('=== WHERE WE ARE ===');
  for (const leg of legs) {
    const tasks = store.tasksOf(leg);
    const suffix = tasks.length
      ? ' — tasks: ' + tasks.map((t) => t.replace(leg + '/', '') + ':' + display(t)).join(', ')
      : '';
    console.log(`${leg.padEnd(6)} ${display(leg)}${suffix}`);
  }
  console.log('\n=== WHAT IS AHEAD ===');
  const activeLeg =
    legs.find((l) => store.status(l) === 'active') ?? (legs.length && store.status(legs[legs.length - 1]) === 'queued' ? legs[legs.length - 1] : undefined);
  if (activeLeg) {
    console.log(`active leg: ${activeLeg} (${store.status(activeLeg)})`);
    const ready = store.tasksOf(activeLeg).filter((t) => ['queued', 'active'].includes(store.status(t)));
    if (ready.length) {
      console.log(`frontmost-ready: ${ready[0]} (${store.status(ready[0])})`);
      ready.slice(1).forEach((t) => console.log(`  also ready: ${t}`));
    } else if (store.status(activeLeg).startsWith('done')) {
      console.log('LEG GATE REVIEW: all spawned tasks done — verify the epic ACs (node.json contract) before advancing or spawning remaining tasks');
    } else {
      console.log('no ready tasks in leg — leg gate may need review');
    }
  } else {
    const done = legs.filter((l) => store.status(l).startsWith('done'));
    console.log(done.length ? `no active leg — previous leg (${done[done.length - 1]}) derived done; LEG GATE REVIEW before spawning the next leg` : 'no active round — next leg to spawn after gate review');
  }
  console.log('\n(grounded in: statuses + gates + validation — run --check / validate.mjs for the proof)');
}

function cmdStatus() {
  const filter = args.find((a) => !a.startsWith('--'));
  for (const id of store.ids().sort()) {
    if (!filter || id.includes(filter)) console.log(`${id.padEnd(58)} ${display(id)}`);
  }
}

function cmdCheck() {
  const problems = store.check();
  for (const p of problems) console.error(p);
  // Artifact integrity: marker-stripped blob vs recorded lock sha.
  const notes: Array<{ sev: 'error' | 'warn' | 'ok' | 'info'; msg: string }> = [];
  const currents = new Map<string, { path: string; sha: string }>();
  for (const id of store.ids()) {
    for (const l of lockShaOf(id)) {
      const cur = store.current(l.name);
      if (cur?.producer === id && cur.path === l.path) currents.set(l.name, l);
    }
  }
  for (const [name, l] of currents) {
    const full = join(ROOT, l.path);
    if (!existsSync(full)) continue;
    const content = readFileSync(full, 'utf8');
    const stripped = content.replace(/^<!-- specs:locked:[^\n]* -->\n?/, '').replace(/^<!-- draft[^\n]* -->\n?/, '');
    const h = blobSha(stripped).slice(0, 7);
    const markerSha = (content.match(/specs:locked:([0-9a-f]{7,})/) || [])[1] || l.sha || '';
    if (markerSha && h === markerSha.slice(0, 7)) continue;
    let kind = '';
    try { kind = execSync(`git cat-file -t ${markerSha}`, { encoding: 'utf8' }).trim(); } catch {}
    if (kind === 'commit') {
      try {
        const hit = execSync(`git ls-tree -r --name-only ${markerSha} | grep -F "${basename(l.path)}" | head -1`, { encoding: 'utf8' }).trim();
        if (hit) {
          let at = execSync(`git show ${markerSha}:${hit}`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
          at = at.replace(/^<!-- specs:locked:[^\n]* -->\n?/, '');
          if (blobSha(at).slice(0, 7) === h) notes.push({ sev: 'ok', msg: `${name}: verified vs lock commit ${markerSha.slice(0, 7)}` });
          else notes.push({ sev: 'warn', msg: `${name}: edited after lock commit ${markerSha.slice(0, 7)} (pre-integrity era; see 'git log -- ${l.path}'); re-lock via 'ann lock' if intentional` });
        } else notes.push({ sev: 'info', msg: `${name}: lock commit ${markerSha.slice(0, 7)} — basename not found (unverified)` });
      } catch {
        notes.push({ sev: 'info', msg: `${name}: legacy lock commit ${markerSha.slice(0, 7)} unverified` });
      }
    } else if (kind === 'blob') {
      notes.push({ sev: 'info', msg: `${name}: legacy blob stamp (draft-marker era) — not hash-verified; re-lock via 'ann lock' for a verifying sha` });
    } else {
      notes.push({ sev: 'error', msg: `${name}: lockSha ${markerSha || '(none)'} is neither commit nor blob` });
    }
  }
  for (const [name, l] of currents) {
    try { execSync(`git diff --quiet HEAD -- "${l.path}"`); } catch {
      notes.push({ sev: 'error', msg: `${name}: uncommitted modification on disk (${l.path})` });
    }
  }
  const errors = problems.length + notes.filter((n) => n.sev === 'error').length;
  for (const n of notes) {
    if (n.sev === 'error') console.error(`  [hash] ${n.msg}`);
    else if (n.sev === 'warn') console.log(`  [hash-warn] ${n.msg}`);
    else console.log(`  [hash] ${n.msg}`);
  }
  console.log(errors === 0 ? `OK — ${currents.size} current artifacts, all gates confirmed.` : `${errors} problem(s).`);
  process.exit(errors === 0 ? 0 : 1);
}

function cmdSpecs() {
  const rows: string[] = [];
  for (const id of store.ids().sort()) {
    for (const l of lockShaOf(id)) {
      if (store.current(l.name)?.producer !== id) continue;
      let type = '',
        sha = l.sha,
        upstream = '',
        referrers = '';
      try {
        const head = readFileSync(join(ROOT, l.path), 'utf8').split('\n').slice(0, 10);
        for (const line of head) {
          const m = line.match(/specs:locked:([0-9a-f]+) [0-9-]+ type=(\S+)/);
          if (m) { sha = m[1]; type = m[2]; }
          const u = line.match(/\*\*upstream\*\* \(this doc relies on\): (.*)/);
          if (u) upstream = u[1];
          const r = line.match(/\*\*referrers\*\* \(must cite this when they change\): (.*)/);
          if (r) referrers = r[1];
        }
      } catch {}
      rows.push(`${l.name}  [${type || '?'}]  @ ${sha}`);
      rows.push(`  path:      ${l.path}`);
      if (upstream) rows.push(`  upstream:  ${upstream}`);
      if (referrers) rows.push(`  referrers: ${referrers}`);
    }
  }
  console.log(rows.join('\n'));
}

function cmdBranch(rootId: string) {
  const ids = store.ids().filter((i) => i.startsWith(rootId)).sort((a, b) => (a + '/events.jsonl').localeCompare(b + '/events.jsonl'));
  for (const id of ids) {
    console.log(`\n▸ ${id}  [${display(id)}]`);
    store.events(id).forEach((e, i) => {
      const gate = typeof e.gate === 'string' ? ` (gate=${e.gate})` : '';
      const extra = e.type === 'transferred' ? ` → ${e.target || ''}` : '';
      console.log(`${String(i + 1).padStart(2)}. ${e.at || ''}  ${e.type}${gate}${extra}`);
      if (e.note) console.log(`      ${e.note}`);
    });
  }
}

function cmdJourneyOne(id: string) {
  const evs = store.events(id);
  console.log(`JOURNEY: ${id}`);
  console.log('---------');
  evs.forEach((e, i) => {
    const gate = typeof e.gate === 'string' ? ` (gate=${e.gate})` : '';
    console.log(`${String(i + 1).padStart(2)}. ${e.at || ''}  ${e.type}${gate}`);
    if (e.note) console.log(`      ${e.note}`);
    if (e.feedback) console.log(`      feedback: ${e.feedback}`);
  });
  console.log('---------');
  console.log(`STATUS: ${display(id)}`);
}

function cmdConfirm(id: string) {
  const c = store.contract(id);
  if (!c) { console.error(`confirm: no node ${id}`); process.exit(1); }
  const contract = (c.contract ?? {}) as Record<string, unknown>;
  console.log(`GATE CARD: ${id}`);
  console.log(`intent: ${contract.intent ?? '(none)'}`);
  const acs = (contract.acceptanceCriteria ?? []) as string[];
  acs.forEach((a, i) => console.log(`AC-${i + 1}: ${a}`));
  console.log(`status: ${display(id)}`);
  console.log('ARTIFACT(S):');
  for (const l of lockShaOf(id)) console.log(`  - ${l.name}: ${l.path} @ ${l.sha || '(no sha)'}`);
  console.log('GATES:');
  for (const e of store.events(id)) {
    if (['submitted', 'confirmed', 'rejected'].includes(e.type)) {
      const g = typeof e.gate === 'string' ? e.gate : '';
      console.log(`  ${e.type} (gate=${g}) ${e.at}`);
    }
  }
  console.log('\n→ verify each AC against the artifact + evidence, then confirm or reject + reason.');
}

// ---- THE SINGLE WRITE SURFACE (bookkeeper) ----
function cmdSpawn(id: string, raw: string) {
  const segs = id.split('/');
  const last = segs[segs.length - 1];
  if (segs.includes('00')) { console.error('spawn rejected: the 00/ level dir was removed in v8 — tasks live directly under the leg'); process.exit(1); }
  if (!/^\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/.test(last)) { console.error(`spawn rejected: last segment '${last}' must be NN-kebab-case`); process.exit(1); }
  if (last.length > 24) { console.error(`spawn rejected: segment '${last}' exceeds 24 chars`); process.exit(1); }
  if (existsSync(nodeFile(id))) { console.error(`spawn rejected: ${id} already exists`); process.exit(1); }
  if (segs.length > 1) {
    const parent = segs.slice(0, -1).join('/');
    if (!existsSync(nodeFile(parent))) { console.error(`spawn rejected: parent ${parent} does not exist`); process.exit(1); }
    if (parent.split('/').length >= 2 && !store.events(parent).some((e) => e.type === 'artifact-locked')) {
      console.error(`spawn rejected: artifact gate — parent task ${parent} has no artifact-locked event`);
      process.exit(1);
    }
    const sibs = store.tasksOf(parent).map((t) => t.split('/').pop()!);
    if (sibs.includes(last)) { console.error(`spawn rejected: sibling ${last} already exists`); process.exit(1); }
    const prefix = last.split('-')[0];
    const clash = sibs.find((s) => s.startsWith(prefix + '-'));
    if (clash) { console.error(`spawn rejected: prefix ${prefix} already used by sibling ${clash}`); process.exit(1); }
  } else {
    const gate = store.legGateMet(id);
    if (!gate.met) { console.error(`spawn rejected: leg gate — ${gate.blocker}`); process.exit(1); }
  }
  let contract: unknown;
  try { contract = JSON.parse(raw); } catch (e) { console.error(`spawn rejected: bad contract JSON (${(e as Error).message})`); process.exit(1); }
  const dir = join(ROOT, 'journey', 'legs', id);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(nodeFile(id), JSON.stringify({ id, contract, createdAt: TODAY }, null, 2) + '\n');
  appendFileSync(eventFile(id), JSON.stringify({ at: TODAY, type: 'created', note: `spawned by bookkeeper (${WHO})` }) + '\n');
  const intent = ((contract as { contract?: { intent?: string } }).contract?.intent) || '';
  const terms = (intent.match(/[A-Za-z][A-Za-z0-9-]{3,}/g) || []).slice(0, 8).join(', ');
  writeFileSync(join(dir, 'description.md'), `# ${last}\n\n- id: \`${id}\` · status: queued · type: ${segs.length > 1 ? 'task' : 'leg'}\n- summary: ${intent.split('\n')[0]}\n- search terms: ${terms}\n`);
  console.log(`spawned ${id} (${segs.length > 1 ? 'task' : 'leg'})`);
}

function cmdGate(id: string, gate: string, decision: string, feedback: string) {
  if (!VOCAB.gates.includes(gate) || !['accept', 'reject'].includes(decision)) {
    console.error('usage: ann gate <id> grill|confirm accept|reject [feedback]');
    process.exit(2);
  }
  if (!store.events(id).length) { console.error(`gate: no node ${id}`); process.exit(1); }
  const evs = store.events(id);
  const pending = evs.filter((e) => e.type === 'submitted' && e.gate === gate && !evs.slice(evs.indexOf(e) + 1).some((x) => x.type === 'confirmed' && x.gate === gate));
  if (!pending.length) store.appendEvent(id, { at: TODAY, type: 'submitted', gate, note: `bookkeeper submission (${WHO})` });
  const rejects = evs.filter((e) => e.type === 'rejected' && e.gate === gate).length;
  if (decision === 'reject' && rejects >= 3) {
    console.error('gate: 3 rejection cycles exhausted — escalate to a human design decision (force-approve / restructure / block)');
    process.exit(1);
  }
  store.appendEvent(
    id,
    decision === 'accept'
      ? { at: TODAY, type: 'confirmed', gate, note: `accepted (${WHO})` }
      : { at: TODAY, type: 'rejected', gate, feedback, note: `rejected (${WHO})` },
  );
  console.log(`gate ${gate}: ${decision} → ${id}`);
}

function cmdLock(id: string, name: string, type: string) {
  if (!VOCAB.artifactTypes.includes(type)) {
    console.error(`lock rejected: type '${type}' not in the vocab registry (${VOCAB.artifactTypes.join(' | ')})`);
    process.exit(1);
  }
  if (store.current(name)) {
    console.error(`lock rejected: '${name}' is already current (${store.current(name)!.path}) — supersede it first`);
    process.exit(1);
  }
  const artDir = join(ROOT, 'journey', 'legs', id, 'artifacts');
  const candidates = existsSync(artDir) ? readdirSync(artDir).filter((f) => f.endsWith('.md')) : [];
  const file = existsSync(join(artDir, name + '.md')) ? join(artDir, name + '.md') : candidates.length === 1 ? join(artDir, candidates[0]) : null;
  if (!file) { console.error(`lock: no artifacts/${name}.md; candidates: ${candidates.join(', ') || '(none)'}`); process.exit(1); }
  const content = readFileSync(file, 'utf8').replace(/^<!-- specs:locked:[^\n]* -->\n?/, '').replace(/^<!-- draft[^\n]* -->\n?/, '');
  const sha = blobSha(content).slice(0, 7);
  writeFileSync(file, `<!-- specs:locked:${sha} ${TODAY} type=${type} -->\n` + content);
  store.appendEvent(id, {
    at: TODAY,
    type: 'artifact-locked',
    artifact: { name, path: 'journey/legs/' + id + '/artifacts/' + basename(file), lockSha: sha },
    note: `${basename(file)} specs-locked via bookkeeper (${WHO})`,
  });
  console.log(`locked ${name} @ ${sha} → ${id}`);
}

function cmdSupersede(id: string, name: string, path: string, note: string) {
  if (!existsSync(join(ROOT, path))) { console.error(`supersede: target path ${path} not found`); process.exit(1); }
  store.appendEvent(id, { at: TODAY, type: 'superseded', successor: { name, path }, note: note || `${name} superseded → ${path} (${WHO})` });
  console.log(`superseded ${name} → ${path} on ${id}`);
}

function cmdCard(id: string) {
  const c = store.contract(id);
  if (!c) { console.error(`card: no node ${id}`); process.exit(2); }
  const last = id.split('/').pop()!;
  const intent = ((c.contract ?? {}) as { intent?: string }).intent || '';
  const terms = (intent.match(/[A-Za-z][A-Za-z0-9-]{3,}/g) || []).slice(0, 8).join(', ');
  const artifacts = lockShaOf(id).map((l) => `- ${l.name}: ${l.path}`).join('\n') || '(none yet)';
  const kids = store.tasksOf(id).length ? store.tasksOf(id).map((k) => `- ${k}`).join('\n') : '(none)';
  const body = `# ${last}\n\n- id: \`${id}\` · status: ${display(id)} · type: ${id.split('/').length === 1 ? 'leg' : 'task'}\n- summary: ${intent.split('\n')[0]}\n- search terms: ${terms}\n\n## artifacts\n${artifacts}\n\n## children\n${kids}\n`;
  writeFileSync(join(ROOT, 'journey', 'legs', id, 'description.md'), body);
  console.log(`card regenerated → ${id}`);
}

// ---- DISPATCH ----
const command = args[0];
try {
  if (!command || command.startsWith('--')) {
    if (command === '--journey') cmdJourney();
    else if (command === '--status') cmdStatus();
    else if (command === '--check') cmdCheck();
    else if (command === '--specs') cmdSpecs();
    else if (command === '--branch') cmdBranch(args[1] || '');
    else if (command === '--help') console.log('ann — the journey CLI (read + manage). See the header comment for usage.');
    else {
      // no-arg map / <name> locate
      if (!command) {
        for (const id of store.ids().sort()) {
          for (const l of lockShaOf(id)) {
            if (store.current(l.name)?.producer === id) console.log(`${l.name.padEnd(28)} ${l.path}${l.sha ? '  @ ' + l.sha : ''}`);
          }
        }
      } else {
        const cur = store.current(command.replace(/^--/, ''));
        if (!cur) { console.error(`ann: no current artifact for '${command}'`); process.exit(1); }
        console.log(cur.path);
        if (cur.sha) console.error(`  (locked @ ${cur.sha}, producer ${cur.producer})`);
      }
    }
  } else if (command === 'journey') cmdJourneyOne(args[1]);
  else if (command === 'confirm') cmdConfirm(args[1]);
  else if (command === 'append') {
    const raw = args.slice(2).join(' ');
    if (!args[1] || !raw) { console.error('usage: ann append <id> \'{"at":..,"type":..}\''); process.exit(2); }
    store.appendEvent(args[1], JSON.parse(raw));
    console.log(`appended → ${args[1]}`);
  } else if (command === 'spawn') {
    const raw = args.slice(2).join(' ');
    if (!args[1] || !raw) { console.error('usage: ann spawn <id> \'<contract-json>\''); process.exit(2); }
    cmdSpawn(args[1], raw);
  } else if (command === 'gate') cmdGate(args[1], args[2], args[3], args.slice(4).join(' '));
  else if (command === 'lock') cmdLock(args[1], args[2], args[3] || 'spec');
  else if (command === 'supersede') cmdSupersede(args[1], args[2], args[3], args.slice(4).join(' '));
  else if (command === 'card') cmdCard(args[1]);
  else {
    const cur = store.current(command);
    if (!cur) { console.error(`ann: no current artifact for '${command}'`); process.exit(1); }
    console.log(cur.path);
    if (cur.sha) console.error(`  (locked @ ${cur.sha}, producer ${cur.producer})`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
