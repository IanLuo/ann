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
 *   ann --providers        → the adapter registry (providers · models · defaults · key state)
 *   ann project / project! add|use|remove <name> [path]  → multi-project (own journey each)
 *   ann config / config! set <key> <val>  → user config file (masked)
 *   ann cred! set|delete <svc> <acct> [secret]  → OS keychain (dev-only)
 *   ann --branch <id>      → a node + every descendant's events
 *   ann journey <id>       → one node's full event walk
 *   ann confirm <id>       → a node's gate card (intent · ACs · gates · results)
 *   ann detail <id>        → full derived detail (contract · gates · artifacts · blockers)
 *   ann results <id> [n]   → results by kind; drill (doc/commit/ref/evidence/link)
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
import { join, basename, dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Store, legacyPath, logicalNameFromFile } from './store/store.js';
import {
  loadProviderRegistry,
  resolveSetting,
  resolveSecret,
  addKeychainSecret,
  deleteKeychainSecret,
  loadConfig,
  setConfig,
  maskedConfig,
  configPath,
  configExists,
  listProjects,
  findProject,
  getCurrentProject,
  setProject,
  useProject,
  removeProject,
} from './adapters/provider/index.js';
import { getVOCAB } from './store/vocab.js';

// ── PROJECT RESOLUTION (before anything touches the store) ──────────────────────
// ann manages MULTIPLE projects, each with its own journey. The root is resolved:
//   1. `--project <name>` flag or ANN_PROJECT env → config.projects
//   2. cwd discovery — walk up until a `journey/` dir is found (git-like)
//   3. config.currentProject
// `project`/`project!` commands run WITHOUT a project (they manage the registry) —
// they never touch the store, so they work from any directory.
const args = process.argv.slice(2);
const isProjectCmd = args[0] === 'project' || args[0] === 'project!';

function resolveProjectRoot(argv: string[]): string {
  const flagIdx = argv.indexOf('--project');
  const explicit = flagIdx >= 0 && argv[flagIdx + 1] ? argv[flagIdx + 1] : process.env.ANN_PROJECT;
  if (explicit) {
    const p = findProject(explicit);
    if (p) return p.path;
    console.error(`ann: project '${explicit}' not found — ann project (list) / project! add <name> <path>`);
    process.exit(1);
  }
  // cwd discovery: walk up looking for journey/ (git-like)
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'journey'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const cur = getCurrentProject();
  if (cur) return cur.path;
  console.error('ann: no project found — run from a project (a dir containing journey/), or register one: ann project! add <name> <path>');
  process.exit(1);
}

const ROOT = isProjectCmd ? process.cwd() : resolveProjectRoot(args);
if (!isProjectCmd) process.chdir(ROOT);
const TODAY = new Date().toISOString().slice(0, 10);
const WHO = process.env.RECORDED_BY || 'agent';

// Lazy store: constructed on first use, AFTER the project root is resolved and
// chdir'd — so `ann project …` from outside a project never touches it.
let _store: Store | undefined;
const store = new Proxy({} as Store, {
  get(_t, prop) {
    const s = (_store ??= new Store(ROOT));
    const v = Reflect.get(s, prop as never);
    return typeof v === 'function' ? (v as () => unknown).bind(s) : v;
  },
});

const blobSha = (c: string): string => createHash('sha1').update('blob ' + Buffer.byteLength(c) + '\n' + c).digest('hex');
const nodeFile = (id: string) => join(ROOT, 'journey', 'legs', id, 'node.json');
const eventFile = (id: string) => join(ROOT, 'journey', 'legs', id, 'events.jsonl');
const hasSuperseded = (id: string) => store.events(id).some((e) => e.type === 'superseded');
const display = (id: string) => store.status(id) + (hasSuperseded(id) ? ' · artifact superseded' : '');
const nameOf = (e: { artifact?: { name?: string }; note?: string; path?: string }) => {
  const filename = e.path ?? String(e.note ?? '').match(/([\w.-]+\.md)/)?.[1] ?? '';
  return e.artifact?.name ?? String(e.note ?? '').match(/logical name:\s*([\w.-]+)/)?.[1] ?? logicalNameFromFile(filename);
};
const lockShaOf = (id: string): { name: string; path: string; sha: string }[] => {
  const out: Array<{ name: string; path: string; sha: string }> = [];
  for (const e of store.events(id)) {
    if (e.type !== 'artifact-locked') continue;
    const a = e.artifact;
    const filename = a?.path ? basename(a.path) : String(e.note ?? '').match(/([\w.-]+\.md)/)?.[1] ?? '';
    out.push({
      name: nameOf(e),
      // normalize legacy recorded paths (tree/rounds → journey/legs, /00/ → flat)
      path: legacyPath(a?.path ?? `journey/legs/${id}/artifacts/${filename}`),
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
  // filter = the id argument (args[1]...), never the command word itself — bare
  // `ann status` with no filter prints every node (fix: silent-empty status).
  const filter = args.slice(1).find((a) => !a.startsWith('--'));
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
      if (cur?.producer === id && legacyPath(l.path) === cur.path) currents.set(l.name, l);
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
  // Journey state line — the check says WHERE we are, not just that nothing broke.
  const legs = store.ids().filter((i) => !i.includes('/')).sort();
  const states = legs.map((l) => `${l} ${store.status(l)}`).join(' · ');
  const active = legs.find((l) => store.status(l) === 'active') ?? (legs.length && !store.status(legs[legs.length - 1]).startsWith('done') ? legs[legs.length - 1] : undefined);
  let state = `State: ${states}`;
  if (active) {
    const tasks = store.tasksOf(active);
    const doneN = tasks.filter((t) => store.status(t).startsWith('done')).length;
    const ready = tasks.filter((t) => ['queued', 'active'].includes(store.status(t)));
    state += ` · ${active} in progress (${doneN}/${tasks.length} tasks done)`;
    if (ready.length) state += ` — frontmost-ready: ${ready[0]} (${store.status(ready[0])})`;
  }
  console.log(errors === 0 ? `OK — ${currents.size} current artifacts, no gate gaps.` : `${errors} problem(s).`);
  console.log(state);
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

function cmdProviders() {
  // the adapter registry (resource-registry spec, category adapter) — env-resolved,
  // api key MASKED (never printed).
  try {
    const reg = loadProviderRegistry(ROOT);
    console.log('PROVIDER REGISTRY (rules/adapter/provider.json)');
    console.log(`defaultProvider: ${reg.defaultProvider}`);
    console.log('---');
    for (const p of reg.providers) {
      console.log(`provider: ${p.id}  [${p.kind}]`);
      console.log(`  protocol:   ${p.protocol}`);
      const base = resolveSetting(p.baseUrl, 'baseUrl');
      const baseEnv = p.baseUrl.startsWith('env:') ? p.baseUrl.slice(4).split('||')[0].trim() : undefined;
      const baseFromEnv = baseEnv ? !!process.env[baseEnv] : false;
      const baseFromConfig = !baseFromEnv && !!loadConfig().baseUrl;
      console.log(`  baseUrl:    ${base ?? '(unresolved — env unset, no fallback)'}${baseFromEnv ? ' (from env)' : baseFromConfig ? ' (from config file)' : baseEnv ? ' (fallback)' : ''}`);
      const key = p.apiKey ? resolveSecret(p.apiKey) : { source: 'none' as const };
      console.log(`  apiKey:     ${key.source === 'keychain' ? 'SET (keychain, masked)' : key.source === 'env' ? 'SET (env, masked)' : key.source === 'config' ? 'SET (config file, masked)' : key.source === 'literal' ? 'SET (literal, masked — move it to the config file or keychain)' : p.apiKey ? `unset — try: ann config! set apiKey <value>` : '(none configured)'}`);
      const model = resolveSetting(p.defaultModel, 'model');
      const modelEnv = p.defaultModel.startsWith('env:') ? p.defaultModel.slice(4).split('||')[0].trim() : undefined;
      const modelFromEnv = modelEnv ? !!process.env[modelEnv] : false;
      const modelFromConfig = !modelFromEnv && !!loadConfig().model;
      console.log(`  defaultModel: ${model ?? '(unresolved)'}${modelFromEnv ? ' (from env)' : modelFromConfig ? ' (from config file)' : modelEnv ? ' (fallback)' : ''}`);
    }
    console.log('---');
    console.log(`defaults: maxTokens=${reg.defaults.maxTokens} · temperature=${reg.defaults.temperature} · retries=${reg.defaults.retries} · backoff=${reg.defaults.backoffMs}ms→${reg.defaults.backoffMaxMs}ms · timeout=${reg.defaults.timeoutMs}ms`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

function cmdProject() {
  const cur = getCurrentProject();
  console.log(`CURRENT PROJECT: ${cur ? `${cur.name} → ${cur.path}` : '(none — config.currentProject unset)'}`);
  console.log(`cwd: ${process.cwd()}`);
  const projects = listProjects();
  if (!projects.length) console.log('  (no projects registered)');
  for (const p of projects) console.log(`  ${p.name}: ${p.path}`);
  console.log('  add:    ann project! add <name> <path>');
  console.log('  use:    ann project! use <name>   (or --project <name> / ANN_PROJECT per-call)');
  console.log('  remove: ann project! remove <name>');
}

function cmdProjectSet(op: string, name: string | undefined, path: string | undefined) {
  if (op === 'add') {
    if (!name || !path) { console.error('usage: ann project! add <name> <path>'); process.exit(2); }
    const abs = resolve(path);
    if (!existsSync(join(abs, 'journey'))) {
      console.error(`project! add: ${abs} has no journey/ — not an ann project (or init it first)`);
      process.exit(1);
    }
    setProject(name, abs);
    console.log(`project: added ${name} → ${abs}`);
  } else if (op === 'use') {
    if (!name) { console.error('usage: ann project! use <name>'); process.exit(2); }
    useProject(name);
    console.log(`project: current = ${name} → ${findProject(name)?.path}`);
  } else if (op === 'remove') {
    if (!name) { console.error('usage: ann project! remove <name>'); process.exit(2); }
    removeProject(name);
    console.log(`project: removed ${name}`);
  } else {
    console.error('usage: ann project! add|use|remove …');
    process.exit(2);
  }
}

function cmdConfig() {
  console.log(`CONFIG FILE: ${configPath()}${configExists() ? '' : ' (not created yet)'}`);
  console.log('  outside the repo · chmod 600 (user-only) · apiKey masked · resolution: env > config > keychain/fallback');
  const entries = Object.entries(maskedConfig());
  if (!entries.length) console.log('  (empty — defaults apply)');
  for (const [k, v] of entries) console.log(`  ${k}: ${v}`);
  console.log('  set: ann config! set <key> <value>  (keys: provider · model · baseUrl · apiKey · maxTokens)');
}

function cmdConfigSet(key: string, value: string | undefined) {
  const keys = ['provider', 'model', 'baseUrl', 'apiKey', 'maxTokens'];
  if (!keys.includes(key) || value === undefined || value === '') {
    console.error(`usage: ann config! set <key> <value>  (keys: ${keys.join(' · ')})`);
    process.exit(2);
  }
  let v: string | number = value;
  if (key === 'maxTokens') {
    const n = Number(value);
    if (Number.isNaN(n)) { console.error('config!: maxTokens must be a number'); process.exit(1); }
    v = n;
  }
  setConfig(key as 'provider' | 'model' | 'baseUrl' | 'apiKey' | 'maxTokens', v);
  console.log(`config: saved ${key} → ${configPath()}${key === 'apiKey' ? ' (masked, never echoed)' : ` = ${value}`}`);
}

function cmdCred(op: string, service: string, account: string, secret: string | undefined) {
  if ((op !== 'set' && op !== 'delete') || !service || !account) {
    console.error('usage: ann cred! set|delete <service> <account> [secret]');
    console.error('  secret: pass as arg OR pipe via stdin (echo -n "..." | ann cred! set ...) — stdin never hits argv/ps');
    process.exit(2);
  }
  if (op === 'set') {
    let value = secret;
    if (value === undefined) value = readFileSync(0, 'utf8').trim(); // stdin — never argv
    if (!value) { console.error('cred!: empty secret — pass as arg or pipe via stdin'); process.exit(1); }
    addKeychainSecret(service, account, value);
    console.log(`cred!: saved ${service}/${account} to the OS keychain (masked, never logged)`);
  } else {
    deleteKeychainSecret(service, account);
    console.log(`cred!: deleted ${service}/${account} from the OS keychain`);
  }
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
  // defensively unwrap a legacy double-nested contract ({contract:{contract:{…}}})
  const rawContract = (c.contract ?? {}) as Record<string, unknown>;
  const contract = ((rawContract as { contract?: Record<string, unknown> }).contract ?? rawContract) as Record<string, unknown>;
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
  // The gate card presents the task's RESULTS with the gate — at GATE② (confirm-result)
  // these ARE what the human confirms: outputs (docs) + evidence (commits/refs).
  console.log('RESULTS:');
  const items = store.results(id);
  if (!items.length) console.log('  (no results yet)');
  items.forEach((it, i) => console.log(`  ${String(i + 1).padStart(2)}. [${it.kind.padEnd(8)}] ${it.label}`));
  if (items.length) console.log('  → drill: ann results <id> <n>');
  console.log('\n→ verify each AC against the artifact + evidence, then confirm or reject + reason.');
}

function cmdDetail(id: string) {
  const d = store.detail(id);
  if (!d.contract) { console.error(`detail: no node ${id}`); process.exit(1); }
  const kind = d.isLeg ? 'LEG' : 'TASK';
  console.log(`${kind}: ${d.id}`);
  console.log(`status: ${d.status}${d.superseded ? ' · superseded producer' : ''}`);
  console.log('---');
  console.log('CONTRACT');
  console.log(`  intent: ${String(d.contract.intent ?? '(none)')}`);
  const acs = (d.contract.acceptanceCriteria ?? []) as string[];
  acs.forEach((a, i) => console.log(`  AC-${i + 1}: ${a}`));
  for (const k of ['targetAreas', 'requiredInputs', 'expectedOutputs']) {
    const v = (d.contract[k] ?? []) as string[];
    if (v.length) console.log(`  ${k}: ${v.join(' · ')}`);
  }
  const oq = (d.contract.openQuestions ?? []) as Array<{ id?: string; question?: string; blocking?: boolean }>;
  if (oq.length) { console.log('  openQuestions:'); oq.forEach((q) => console.log(`    - ${q.id ?? ''}${q.blocking ? ' [blocking]' : ''}: ${q.question ?? ''}`)); }
  console.log('---');
  console.log('GATES (derived)');
  const gateLine = (g: { state: string; at?: string }) => `GATE ${g.state === 'confirmed' ? '✓' : g.state === 'rejected' ? '✗' : g.state === 'submitted' ? '…' : '·'} ${g.state}${g.at ? ` (${g.at})` : ''}`;
  console.log(`  ${gateLine(d.gates.grill)} — grilling (entry)`);
  console.log(`  ${gateLine(d.gates.confirm)} — confirm-result (exit)`);
  console.log('---');
  console.log('ARTIFACTS');
  if (!d.artifacts.length) console.log('  (none locked)');
  for (const a of d.artifacts) console.log(`  - ${a.name} @ ${a.sha || '(no sha)'} [${a.role}]
      ${a.path}`);
  console.log('---');
  console.log('EVENTS');
  console.log(`  ${d.events.length} event(s) — full walk: ann branch ${d.id}`);
  for (const e of d.events.slice(-5)) {
    const g = typeof e.gate === 'string' ? ` (gate=${e.gate})` : '';
    console.log(`  ${e.at || ''}  ${e.type}${g}`);
  }
  if (d.tasks) {
    console.log('---');
    console.log('TASKS');
    for (const t of d.tasks) console.log(`  ${t.id}  ${t.status}`);
  }
  if (d.blockers.length) {
    console.log('---');
    console.log('BLOCKED — waiting on human:');
    for (const b of d.blockers) console.log(`  ${b}`);
  }
}

function cmdResults(id: string, index: string | undefined) {
  const items = store.results(id);
  if (!store.contract(id)) { console.error(`results: no node ${id}`); process.exit(1); }
  const kind = id.includes('/') ? 'TASK' : 'LEG';
  if (index === undefined) {
    console.log(`RESULTS: ${id} (${kind})`);
    if (!items.length) { console.log('  (no results yet)'); return; }
    items.forEach((it, i) => console.log(`  ${String(i + 1).padStart(2)}. [${it.kind.padEnd(8)}] ${it.label}`));
    console.log(`\n  drill: ann results ${id} <n>`);
    return;
  }
  const n = Number(index);
  const it = items[n - 1];
  if (!it) { console.error(`results: no item ${index} (1..${items.length})`); process.exit(1); }
  console.log(`${String(it.kind).toUpperCase()}: ${it.label}`);
  if (it.at) console.log(`  at: ${it.at}`);
  switch (it.kind) {
    case 'doc': {
      const full = join(ROOT, it.path!);
      if (!existsSync(full)) { console.error(`  (file missing: ${it.path})`); break; }
      console.log(`  path: ${it.path}`);
      console.log('---');
      console.log(readFileSync(full, 'utf8'));
      break;
    }
    case 'commit': {
      try {
        console.log(execSync(`git show -s --format='%H%n%an <%ae> %ad%n%n%s%n%n%b' ${it.sha}`, { encoding: 'utf8' }).trim());
        console.log('---');
        console.log(execSync(`git show --stat --format= ${it.sha}`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim().slice(0, 2000));
      } catch {
        console.error(`  (commit ${it.sha} not resolvable in git)`);
      }
      break;
    }
    case 'ref': {
      const full = join(ROOT, it.path!);
      if (!existsSync(full)) { console.error(`  (ref missing: ${it.path})`); break; }
      const st = statSync(full);
      if (st.isDirectory()) {
        console.log(`  dir: ${it.path}/`);
        for (const f of readdirSync(full).slice(0, 30)) console.log(`    - ${f}`);
      } else {
        console.log(`  file: ${it.path}`);
        console.log('---');
        console.log(readFileSync(full, 'utf8').split('\n').slice(0, 60).join('\n'));
      }
      break;
    }
    case 'evidence': {
      const ev = store.events(id).find((e) => e.type === 'evidence' && e.note === it.note);
      console.log('---');
      console.log(JSON.stringify(ev ?? { note: it.note }, null, 2));
      break;
    }
    case 'link':
      console.log(`  url: ${it.url}`);
      break;
  }
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
    if (parent.split('/').length >= 2 && !store.parentConcluded(parent)) {
      console.error(`spawn rejected: artifact gate — parent task ${parent} has no artifact-locked or commit-evidence (format v10 §4)`);
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
  // F-AC19 (v11) — the task contract checklist: a task must be self-sufficient when
  // a fresh agent reads only its contract + resolvable inputs. Defining a task
  // means following the checklist; a non-compliant contract cannot be spawned.
  const c = ((contract as { contract?: unknown })?.contract ?? contract) as Record<string, unknown>;
  const checklist = store.contractProblems(c);
  if (checklist.length) {
    console.error(`spawn rejected (F-AC19 contract checklist, format v11 §2):`);
    for (const p of checklist) console.error(`  - ${p}`);
    process.exit(1);
  }
  store.spawn(id, contract, WHO);
  const dir = join(ROOT, 'journey', 'legs', id);
  const intent = ((contract as { contract?: { intent?: string } }).contract?.intent) || '';
  const terms = (intent.match(/[A-Za-z][A-Za-z0-9-]{3,}/g) || []).slice(0, 8).join(', ');
  writeFileSync(join(dir, 'description.md'), `# ${last}\n\n- id: \`${id}\` · status: queued · type: ${segs.length > 1 ? 'task' : 'leg'}\n- summary: ${intent.split('\n')[0]}\n- search terms: ${terms}\n`);
  console.log(`spawned ${id} (${segs.length > 1 ? 'task' : 'leg'})`);
}

function cmdGate(id: string, gate: string, decision: string, feedback: string) {
  if (!getVOCAB().gates.includes(gate) || !['accept', 'reject'].includes(decision)) {
    console.error('usage: ann gate <id> grill|confirm accept|reject [feedback]');
    process.exit(2);
  }
  if (!store.contract(id)) { console.error(`gate: no node ${id}`); process.exit(1); }
  if (!id.includes('/')) { console.error(`gate rejected: leg roots carry no gates (flow-control v4 §3 — gates live on tasks)`); process.exit(1); }
  // flow-control v4 §3: gates are SEQUENTIAL — GATE② (confirm) requires GATE① (grill) confirmed first.
  if (gate === 'confirm' && !store.events(id).some((e) => e.type === 'confirmed' && e.gate === 'grill')) {
    console.error(`gate rejected: confirm gate requires a confirmed(gate=grill) first (flow-control v4 §3 — gates are sequential)`);
    process.exit(1);
  }
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
  if (!getVOCAB().artifactTypes.includes(type)) {
    console.error(`lock rejected: type '${type}' not in the vocab registry (${getVOCAB().artifactTypes.join(' | ')})`);
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
// Naming: reads have NO marker; WRITES end in `!` (the mutator convention — Scheme/Ruby/Nix:
// `set!`, `push!`). A bare write name refuses with a hint — the `!` is a guarantee, not advice.
const COMMANDS: Array<{ name: string; args: string; desc: string }> = [
  { name: '<name>', args: '', desc: 'current path for one logical name' },
  { name: 'journey', args: '[id]', desc: 'the look-back (no id) · one node\'s walk (with id) · alias --journey' },
  { name: 'status', args: '[filter]', desc: 'every node\'s derived status (+ superseded marker) · alias --status' },
  { name: 'check', args: '', desc: 'integrity + gates + hashes + the journey state line · alias --check' },
  { name: 'specs', args: '', desc: 'the locked contract stack (name · type · @sha · path) · alias --specs' },
  { name: 'providers', args: '', desc: 'the adapter registry: providers, models, defaults (env-resolved, api key masked) · alias --providers' },
  { name: 'config', args: '', desc: 'the user config file (~/.ann/config.json; apiKey masked) · alias --config' },
  { name: 'config!', args: 'set <key> <value>', desc: 'WRITE — save a config value (provider|model|baseUrl|apiKey|maxTokens); chmod 600, outside the repo; apiKey never echoed' },
  { name: 'project', args: '', desc: 'show the current project + known projects · alias --project' },
  { name: 'project!', args: 'add|use|remove <name> [path]', desc: 'WRITE — manage projects (each has its OWN journey); add <name> <path> registers a project' },
  { name: 'cred!', args: 'set|delete <service> <account> [secret]', desc: 'WRITE — OS keychain (macOS, DEV-ONLY local CLI): save/remove a secret via stdin; production = server-side env (12-factor)' },
  { name: 'branch', args: '<id>', desc: 'a node + every descendant\'s events, one walk · alias --branch' },
  { name: 'confirm', args: '<id>', desc: 'a node\'s gate card: intent · ACs · artifacts · gates' },
  { name: 'detail', args: '<id>', desc: 'a node\'s full derived detail: contract · gate states · artifacts (current/superseded) · blockers · events tail' },
  { name: 'results', args: '<id> [n]', desc: 'a task\'s results by kind (doc/commit/ref/evidence/link); with n, drill into one (doc=content, commit=git show, ref=file/dir, evidence=event) · alias --results' },
  { name: 'commands', args: '', desc: 'this table as markdown (the derived doc) · alias --commands' },
  { name: 'help', args: '', desc: 'usage · alias --help / -h' },
  { name: 'append!', args: '<id> \'<json>\'', desc: 'WRITE — single-writer append (store.appendEvent, LB-3)' },
  { name: 'spawn!', args: '<id> \'<contract-json>\'', desc: 'WRITE — create a node; legs get NO events (v8); gates validated' },
  { name: 'gate!', args: '<id> grill|confirm accept|reject [feedback]', desc: 'WRITE — human gate decision (submit + decide; 3-reject bound)' },
  { name: 'lock!', args: '<id> <name> [type]', desc: 'WRITE — stamp lock marker + artifact-locked (hash-verifying sha)' },
  { name: 'supersede!', args: '<id> <name> <path> [note]', desc: 'WRITE — superseded event with a forward pointer' },
  { name: 'card!', args: '<id>', desc: 'WRITE — regenerate description.md (the only rewritable file)' },
];

const command = args[0];
/** Resolve a possibly-partial id: exact → last-segment → unique prefix; fail-closed
 *  with NAMED candidates when ambiguous (never a silent pick). Reads only — writes
 *  stay strict full-id (the `!` mutators take no shortcuts). */
function resolveId(raw: string): string {
  const ids = store.ids();
  if (ids.includes(raw)) return raw;
  const last = (i: string) => i.split('/').pop()!;
  const byLast = ids.filter((i) => last(i) === raw);
  if (byLast.length === 1) return byLast[0];
  if (byLast.length > 1) {
    console.error(`ann: ambiguous id '${raw}' — matches ${byLast.join(', ')}; use the full id`);
    process.exit(1);
  }
  // partial last segment (e.g. '05-s2' → '05-s2-envision-grilling')
  const byLastPrefix = ids.filter((i) => last(i).startsWith(raw));
  if (byLastPrefix.length === 1) return byLastPrefix[0];
  if (byLastPrefix.length > 1) {
    console.error(`ann: ambiguous '${raw}' — matches ${byLastPrefix.join(', ')}; use more of the id`);
    process.exit(1);
  }
  // full-id prefix (e.g. '06-engine-build/05')
  const byPrefix = ids.filter((i) => i.startsWith(raw));
  if (byPrefix.length === 1) return byPrefix[0];
  if (byPrefix.length > 1) {
    console.error(`ann: ambiguous prefix '${raw}' — matches ${byPrefix.join(', ')}; use more of the id`);
    process.exit(1);
  }
  console.error(`ann: no node '${raw}'`);
  process.exit(1);
}
try {
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log('ann — the journey CLI (read + manage). State via commands only (read discipline).');
    console.log('Naming: reads have NO marker · WRITES end in `!` (the mutator convention — the `!` is a guarantee).');
    for (const c of COMMANDS) console.log(`  ${c.name.padEnd(14)} ${c.args.padEnd(44)} ${c.desc}`);
    console.log('\nenv: RECORDED_BY=<name>  provenance on recorded events (default: agent)');
    console.log('doc: npm run ann -- commands   → the command table as markdown (the derived doc source)');
    process.exit(0);
  }
  if (command === '--commands') {
    // The derived command doc: markdown table from the registry — the source for
    // AGENTS.md/README, never hand-maintained (the tree's derived-not-stored rule).
    console.log('| Command | Args | What it does |');
    console.log('|---|---|---|');
    for (const c of COMMANDS) console.log(`| \`${c.name}\` | \`${c.args}\` | ${c.desc} |`);
    console.log('\nEnv: `RECORDED_BY=<name>` — provenance on recorded events (default: agent).');
    process.exit(0);
  }
  const WRITES = ['append', 'spawn', 'gate', 'lock', 'supersede', 'card', 'cred'];
  if (WRITES.includes(command)) {
    console.error(`ann: writes are marked with '!' — did you mean '${command}!'? (mutator convention: reads have no marker, writes always end in !)`);
    process.exit(1);
  }
  if (command === 'journey' || command === '--journey') {
    if (args[1]) cmdJourneyOne(resolveId(args[1]));
    else cmdJourney();
  } else if (command === 'status' || command === '--status') cmdStatus();
  else if (command === 'check' || command === '--check') cmdCheck();
  else if (command === 'specs' || command === '--specs') cmdSpecs();
  else if (command === 'providers' || command === '--providers') cmdProviders();
  else if (command === 'config' || command === '--config') cmdConfig();
  else if (command === 'config!') cmdConfigSet(args[2], args[3]);
  else if (command === 'project') cmdProject();
  else if (command === 'project!') cmdProjectSet(args[1], args[2], args[3]);
  else if (command === 'cred!') cmdCred(args[1], args[2], args[3], args[4]);
  else if (command === 'branch' || command === '--branch') cmdBranch(resolveId(args[1] || ''));
  else if (command === 'commands' || command === '--commands') {
    console.log('| Command | Args | What it does |');
    console.log('|---|---|---|');
    for (const c of COMMANDS) console.log(`| \`${c.name}\` | \`${c.args}\` | ${c.desc} |`);
    console.log('\nEnv: `RECORDED_BY=<name>` — provenance on recorded events (default: agent).');
  } else if (command === 'confirm') cmdConfirm(resolveId(args[1]));
  else if (command === 'detail' || command === '--detail') cmdDetail(resolveId(args[1]));
  else if (command === 'results' || command === '--results') cmdResults(resolveId(args[1]), args[2]);
  else if (command === 'append!') {
    const raw = args.slice(2).join(' ');
    if (!args[1] || !raw) { console.error('usage: ann append! <id> \'{"at":..,"type":..}\''); process.exit(2); }
    store.appendEvent(args[1], JSON.parse(raw));
    console.log(`appended → ${args[1]}`);
  } else if (command === 'spawn!') {
    const raw = args.slice(2).join(' ');
    if (!args[1] || !raw) { console.error('usage: ann spawn! <id> \'<contract-json>\''); process.exit(2); }
    cmdSpawn(args[1], raw);
  } else if (command === 'gate!') cmdGate(args[1], args[2], args[3], args.slice(4).join(' '));
  else if (command === 'lock!') cmdLock(args[1], args[2], args[3] || 'spec');
  else if (command === 'supersede!') cmdSupersede(args[1], args[2], args[3], args.slice(4).join(' '));
  else if (command === 'card!') cmdCard(args[1]);
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
