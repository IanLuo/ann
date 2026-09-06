#!/usr/bin/env node
/**
 * ann — the journey CLI (S1 store seed). Read + manage through commands only;
 * never hand-edit node.json/events.jsonl (read discipline, journey-format-spec v8 §6).
 * Replaces scripts/resolve.mjs as the engine CLI surface.
 *
 * Usage:
 *   ann                    → name → current-path map
 *   ann <name>             → path for one doc (manifest) or a current artifact's logical name
 *   ann --journey          → the look-back (where we are + what's ahead)
 *   ann --status [filter]  → every node's derived status
 *   ann --check            → integrity + gates + docs-manifest freshness
 *   ann --specs            → the docs contract stack (docs manifest → docs/<name>.md)
 *   ann --docs [--write]   → the docs→git resolution index (docs/manifest.json; --write regenerates)
 *   ann --providers        → the adapter registry (providers · models · defaults · key state)
 *   ann project / project! add|use|remove <path>  → multi-project by PATH (own journey each)
 *   ann config / config! set <key> <val>  → user config file (masked)
 *   ann cred! set|delete <svc> <acct> [secret]  → OS keychain (dev-only)
 *   ann --branch <id>      → a node + every descendant's events
 *   ann journey <id>       → one node's full event walk
 *   ann confirm <id>       → a node's gate card (intent · ACs · gates · results)
 *   ann detail <id>        → full derived detail (contract · gates · artifacts · blockers)
 *   ann results <id> [n]   → results by kind; drill (commit/ref/evidence/link)
 *   ann append <id> '{"at":..,"type":..}'   → single-writer append (LB-3)
 *   ann spawn <id> '<contract-json>'        → create a node (validated)
 *   ann gate <id> grill|confirm accept|reject [feedback]
 *   ann read <name>        → marker-stripped content + path + sha (docs manifest name, or a legacy current artifact)
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
import { join, dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { Store } from '../store/store.js';
import { scanDocsDir, loadDocsManifest, writeDocsManifest, docsIndexFresh, docSha, MANIFEST_FILE } from '../store/docs.js';
import { Commands, CommandResult, GOAL_SEED_GUARD } from '../commands/index.js';
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
  getCurrentProject,
  setProject,
  useProject,
  removeProject,
} from '../abilities/llm/index.js';
import { getVOCAB } from '../store/vocab.js';
import { assemblePacket } from '../flow/materialize.js';
import { runValidators, RULES, derivedRegistry } from '../flow/validators/index.js';
import { buildStepRegistry } from '../flow/steps/index.js';
import { loadProjectFlow, phaseOf, resolveChain, validateChain } from '../flow/chain.js';
import { Frame } from '../flow/frame.js';
import { runGoalSeed } from '../flow/goal-seed.js';
import { buildAbilities } from '../abilities/index.js';
import { resolveConfig } from '../flow/config.js';
import { getAdapter } from '../abilities/llm/index.js';
import { ProviderAdapter } from '../abilities/llm/index.js';
import { renderStatusTree, renderGateCard, renderPlan, renderDrift, renderLedger, renderGoal, PlanLeg, PlanAhead } from './renderers.js';

// ── PROJECT RESOLUTION (before anything touches the store) ──────────────────────
// ann manages MULTIPLE projects (each with its own journey), identified by PATH only.
// The root is resolved:
//   1. `--project <path>` flag or ANN_PROJECT env → that path (must be an ann project)
//   2. cwd discovery — walk up until a `.ann/` (or legacy `journey/`) dir is found
//   3. config.currentProject (a path)
// `project`/`project!` commands run WITHOUT a project (they manage the registry) —
// they never touch the store, so they work from any directory.
const args = process.argv.slice(2);
// Global --project <path> flag — extracted and STRIPPED so per-command parsing
// (status filter, etc.) never sees it; works before OR after the command.
let projectFlag: string | undefined;
{
  const flagIdx = args.indexOf('--project');
  if (flagIdx >= 0 && args[flagIdx + 1]) {
    projectFlag = args[flagIdx + 1];
    args.splice(flagIdx, 2);
  }
}
// Global --json flag — structured emit on the derived-view commands (core-design
// §8:289). Extracted and STRIPPED so per-command parsing never sees it.
let JSON_OUT = false;
{
  const idx = args.indexOf('--json');
  if (idx >= 0) {
    JSON_OUT = true;
    args.splice(idx, 1);
  }
}
const isProjectCmd = args[0] === 'project' || args[0] === 'project!';

const isProjectRoot = (dir: string): boolean => existsSync(join(dir, '.ann')) || existsSync(join(dir, 'journey'));

function resolveProjectRoot(argv: string[]): string {
  const explicit = projectFlag ? resolve(projectFlag) : process.env.ANN_PROJECT ? resolve(process.env.ANN_PROJECT) : undefined;
  if (explicit) {
    if (isProjectRoot(explicit)) return explicit;
    console.error(`ann: '${explicit}' is not an ann project (no .ann/ or journey/). Run from a project or: ann project! add <path>`);
    process.exit(1);
  }
  // cwd discovery: walk up looking for .ann/ (v12 marker) — legacy journey/ accepted
  let dir = process.cwd();
  for (;;) {
    if (isProjectRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const cur = getCurrentProject();
  if (cur && isProjectRoot(cur)) return cur;
  console.error('ann: no project found — run from a project (a dir containing .ann/), or register one: ann project! add <path>');
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

/** L1 — every write and every derived view the binding renders goes through here. */
const commands = new Proxy({} as Commands, {
  get(_t, prop) {
    const c = (_commands ??= new Commands(store, WHO));
    const v = Reflect.get(c, prop as never);
    return typeof v === 'function' ? (v as () => unknown).bind(c) : v;
  },
});
let _commands: Commands | undefined;

const hasSuperseded = (id: string) => store.events(id).some((e) => e.type === 'superseded');
const display = (id: string) => store.status(id) + (hasSuperseded(id) ? ' · artifact superseded' : '');

// ---- READ / DERIVE ----
function cmdJourney() {
  // S8 — the F12 full-plan renderer: where we are (legs + tasks) + what is ahead
  // (the look-back — active leg, frontmost-ready, leg gate). Derived, never assumed.
  const legs = store.ids().filter((i) => !i.includes('/')).sort();
  const rows: PlanLeg[] = legs.map((l) => ({
    id: l,
    status: store.status(l),
    superseded: hasSuperseded(l),
    tasks: store.tasksOf(l).map((t) => ({ id: t, status: store.status(t), superseded: hasSuperseded(t) })),
  }));
  const lb = commands.lookBack();
  const ahead: PlanAhead = {
    activeLeg: lb.activeLeg,
    activeLegStatus: lb.activeLegStatus,
    frontmostReady: lb.frontmostReady ? { task: lb.frontmostReady.task, status: lb.frontmostReady.status } : undefined,
    alsoReady: lb.alsoReady.map((a) => ({ task: a.task, status: a.status })),
    legGate: lb.legGate,
  };
  console.log(renderPlan(rows, ahead));
}

function cmdStatus() {
  // filter = the id argument (args[1]...), never the command word itself — bare
  // `ann status` with no filter prints every node (fix: silent-empty status).
  const filter = args.slice(1).find((a) => !a.startsWith('--'));
  const rows = commands.statuses(filter);
  if (JSON_OUT) return console.log(JSON.stringify(rows, null, 2));
  // S8 — the F10 tree renderer (statuses are derived rows; the renderer emits the
  // padded tree view, never scalar progress — AC5).
  console.log(renderStatusTree(rows));
}

function cmdCheck() {
  const problems = store.check();
  const warns: string[] = [];
  // S4 validators: the self-contained rule modules (registry-derived) — run whole-store
  for (const f of runValidators(store)) {
    const line = `[${f.severity}] ${f.code}${f.nodeId ? ` ${f.nodeId}` : ''} — ${f.detail}`;
    if (f.severity === 'error') problems.push(line);
    else warns.push(line);
  }
  for (const p of problems) console.error(p);
  // docs manifest freshness — a doc file with no manifest entry is invisible to
  // resolution; a manifest entry with no file points at nothing. Report when the
  // committed index disagrees with docs/ (docs/ absent → silent). Docs are git
  // content (the doc-artifact integrity era — marker-stripped blob vs lock sha — was
  // retired with the refactor, D3: integrity now = the manifest + git's own record).
  const notes: Array<{ sev: 'error' | 'warn' | 'info'; msg: string }> = [];
  const { fresh, missing, stale } = docsIndexFresh(ROOT);
  const manifest = loadDocsManifest(ROOT);
  const docCount = Object.keys(manifest).length;
  if (!fresh) {
    const parts = [
      ...missing.map((n) => `'${n}' not in the manifest`),
      ...stale.map((n) => `'${n}' has no matching file in docs/`),
    ];
    notes.push({ sev: 'error', msg: `docs manifest out of sync with docs/: ${parts.join(' · ')} — run 'ann docs --write' and commit` });
  }
  for (const w of warns) console.log(`  [rule-warn] ${w}`);
  const errors = problems.length + notes.filter((n) => n.sev === 'error').length;
  for (const n of notes) {
    if (n.sev === 'error') console.error(`  [docs] ${n.msg}`);
    else if (n.sev === 'warn') console.log(`  [docs-warn] ${n.msg}`);
    else console.log(`  [docs] ${n.msg}`);
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
  console.log(errors === 0 ? `OK — ${docCount} docs in the manifest, no gate gaps.` : `${errors} problem(s).`);
  console.log(state);
  if (JSON_OUT) console.log(JSON.stringify({ problems, warnings: warns, notes, docs: docCount, state }, null, 2));
  process.exit(errors === 0 ? 0 : 1);
}

/** `verify` — the DRIFT read: reconcile the log's recorded claims against
 *  filesystem/git reality (D1-D5). Reports, never mutates; exits 1 on any drift. */
function cmdVerify() {
  const drifts = commands.verify();
  for (const d of drifts) console.error(renderDrift(d));
  if (JSON_OUT) console.log(JSON.stringify({ drifts, count: drifts.length }, null, 2));
  console.log(drifts.length === 0 ? 'verify: clean — the log and the filesystem agree (0 drifts).' : `${drifts.length} drift(s).`);
  process.exit(drifts.length === 0 ? 0 : 1);
}

/** `ledger` — the write-rev ledger read: rev + per-node last-write rev/at + hashes
 *  (the store-external integrity guard). Read-only. */
function cmdLedger() {
  const view = commands.ledger();
  if (JSON_OUT) return console.log(JSON.stringify(view, null, 2));
  console.log(renderLedger(view));
}

function cmdSpecs() {
  // THE DOCS CONTRACT STACK — docs are git content: the "locked" set is the docs
  // manifest + the file at HEAD (the doc-artifact lock records are legacy/history).
  // Iterate the manifest (the forward path); upstream/referrers prose still reads
  // from the file head (it is content, not claim); sha = docSha over the file.
  const manifest = loadDocsManifest(ROOT);
  const stack: Array<{ name: string; sha: string; path: string; upstream?: string; referrers?: string }> = [];
  for (const name of Object.keys(manifest).sort()) {
    const rel = manifest[name];
    const full = join(ROOT, rel);
    if (!existsSync(full)) {
      stack.push({ name, sha: '(file missing)', path: rel });
      continue;
    }
    let upstream = '',
      referrers = '';
    try {
      const head = readFileSync(full, 'utf8').split('\n').slice(0, 10);
      for (const line of head) {
        const u = line.match(/\*\*upstream\*\* \(this doc relies on\): (.*)/);
        if (u) upstream = u[1];
        const r = line.match(/\*\*referrers\*\* \(must cite this when they change\): (.*)/);
        if (r) referrers = r[1];
      }
    } catch {}
    stack.push({ name, sha: docSha(readFileSync(full, 'utf8')), path: rel, ...(upstream ? { upstream } : {}), ...(referrers ? { referrers } : {}) });
  }
  if (JSON_OUT) return console.log(JSON.stringify(stack, null, 2));
  const rows: string[] = [];
  for (const s of stack) {
    rows.push(`${s.name}  @ ${s.sha}`);
    rows.push(`  path:      ${s.path}`);
    if (s.upstream) rows.push(`  upstream:  ${s.upstream}`);
    if (s.referrers) rows.push(`  referrers: ${s.referrers}`);
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
  console.log(`CURRENT PROJECT: ${cur && isProjectRoot(cur) ? cur : cur ? `${cur} (missing/stale)` : '(none — config.currentProject unset)'}`);
  console.log(`cwd: ${process.cwd()}`);
  const projects = listProjects();
  if (!projects.length) console.log('  (no projects registered)');
  for (const p of projects) console.log(`  ${p}${isProjectRoot(p) ? '' : '  (missing/stale)'}`);
  console.log('  add:    ann project! add <path>');
  console.log('  use:    ann project! use <path>   (or --project <path> / ANN_PROJECT per-call)');
  console.log('  remove: ann project! remove <path>');
}

function cmdProjectSet(op: string, path: string | undefined) {
  if (op === 'add') {
    if (!path) { console.error('usage: ann project! add <path>'); process.exit(2); }
    const abs = resolve(path);
    if (!isProjectRoot(abs)) {
      console.error(`project! add: ${abs} has no .ann/ — not an ann project (or init it first)`);
      process.exit(1);
    }
    setProject(abs);
    console.log(`project: added ${abs}`);
  } else if (op === 'use') {
    if (!path) { console.error('usage: ann project! use <path>'); process.exit(2); }
    const abs = resolve(path);
    useProject(abs);
    console.log(`project: current = ${abs}`);
  } else if (op === 'remove') {
    if (!path) { console.error('usage: ann project! remove <path>'); process.exit(2); }
    removeProject(resolve(path));
    console.log(`project: removed ${resolve(path)}`);
  } else {
    console.error('usage: ann project! add|use|remove <path>');
    process.exit(2);
  }
}

function cmdPacket(id: string) {
  const p = assemblePacket(store, id);
  if (JSON_OUT) return console.log(JSON.stringify(p, null, 2));
  console.log(`PACKET: ${id} (${p.pathDecisions.isLeg ? 'leg' : 'task'} · depth ${p.pathDecisions.depth})`);
  console.log(`readiness: ${p.readiness.ready ? 'ready' : 'BLOCKED'}` + (p.readiness.blockers.length ? `
  blockers: ${p.readiness.blockers.join('; ')}` : ''));
  console.log('---');
  console.log('dependencies:');
  if (!p.dependencies.length) console.log('  (none declared)');
  for (const d of p.dependencies) console.log(`  ${d.name} [${d.status}]${d.status === 'resolved' ? ` → ${d.path} @ ${d.sha} (${(d.excerpt ?? '').length} chars excerpt)` : ` — blocker: ${d.blocker}`}`);
  console.log('---');
  console.log('siblings:');
  for (const s of p.siblingStatus.siblings) console.log(`  ${s.id}  ${s.status}`);
  for (const c of p.siblingStatus.children) console.log(`  ↳ ${c.id}  ${c.status}`);
  console.log('---');
  console.log('openQuestions:');
  if (!p.openQuestions.length) console.log('  (none)');
  for (const q of p.openQuestions) console.log(`  ${q.id} [${q.impact}] ${q.question}${q.default ? ` (default: ${q.default})` : ''}`);
  console.log('---');
  console.log('bindingState:');
  if (!p.bindingState.links.length) console.log('  (none)');
  for (const l of p.bindingState.links) console.log(`  ${l.url}`);
}

function cmdValidate(id: string | undefined) {
  const nodeId = id ? resolveId(id) : undefined;
  const findings = runValidators(store, nodeId);
  if (!findings.length) { console.log('VALIDATE: clean (0 findings)'); return; }
  for (const f of findings) console.log(`  [${f.severity}] ${f.code}${f.nodeId ? ` ${f.nodeId}` : ''} — ${f.detail}`);
  console.log(`${findings.length} finding(s)`);
}

/** F3 (view side) — the project's step-chain flow config, as data. */
function cmdChain() {
  const project = loadProjectFlow(ROOT);
  console.log('FLOW CONFIG (rules/flow/default.json — DATA, never code)');
  if (!project) {
    console.log('  (no project flow file — the builtin fallback is the EMPTY chain; flow content is DATA, never code)');
    return;
  }
  if (project.template) console.log(`  template: ${project.template}`);
  for (const [workType, chain] of Object.entries(project.chains)) {
    const render = chain.map((e) => `${e.id}${e.at ? `@${e.at}` : ''}${e.when ? '?' : ''}`);
    console.log(`  ${workType.padEnd(16)} ${render.length ? render.join(' → ') : '(lifecycle only — the runner does the work)'}`);
  }
  console.log('  selection: task contract.workType → chains[workType]; contract.flow overrides all');
  console.log('  per-task resolution: ann flow <id> · registered steps: ann steps');
}

/** The step registry — the pluggable surface future steps implement against. */
function cmdSteps() {
  const reg = buildStepRegistry();
  console.log('STEP REGISTRY (§2 contract — add a step to src/flow/steps/ + reference it in flow data)');
  for (const s of reg.all()) {
    const roles = s.roles.map((r) => `${r.name}${r.required ? '' : '?'}`).join(', ');
    console.log(`  ${s.id.padEnd(15)} roles: [${roles}]  produces: [${(s.produces ?? []).join(', ')}]`);
    console.log(`  ${' '.repeat(15)} decisions: [${(s.decisions ?? []).join(', ')}]  rules: [${s.rules.map((r) => r.id).join(', ')}]`);
  }
  console.log(`\n  ${reg.ids().length} steps — chains reference them by id; unregistered ids fail closed (chain validation)`);
}

/** F5 (pull side) — the run-next proposal, derived from events (never assumed). */
function cmdNext() {
  const lb = commands.lookBack();
  const next = commands.advance();
  if (JSON_OUT) return console.log(JSON.stringify(lb, null, 2));
  console.log('NEXT (derived from events — the observer action)');
  if (lb.activeLeg) console.log(`  active leg: ${lb.activeLeg} (${lb.activeLegStatus})`);
  if (lb.frontmostReady) console.log(`  frontmost-ready: ${lb.frontmostReady.task} (${lb.frontmostReady.status})`);
  for (const t of lb.alsoReady) console.log(`  also ready: ${t.task} (${t.status})`);
  if (!lb.frontmostReady && lb.activeLeg && lb.activeLegStatus === 'done') {
    console.log('  LEG GATE REVIEW: all spawned tasks done — verify the epic ACs before advancing');
  }
  for (const p of lb.pendingGates) console.log(`  WAITING ON YOU: ${p.task} — gate ${p.gate} submitted, undecided`);
  const lg = lb.legGate;
  console.log(`  leg gate: ${lg.met ? 'MET' : `UNMET — ${lg.blocker}`}`);
  // the FOUR-STATE GOAL CONSULT (goal-session-design §5): in the terminal the goal
  // holds the next move (no goal → grill & seed · exhausted-unconfirmed → the choice
  // menu · met → archive & start a new goal) — never a blind "no ready action".
  if (next.action === 'none') {
    const g = commands.goal();
    if (g.ok && g.value.present) console.log(`  goal: ${g.value.goalId} [${g.value.goalStatus}] — verdict ${g.value.verdict}`);
  } else if (!lb.frontmostReady && !lb.pendingGates.length) {
    console.log('  no ready action — resolve blocked tasks or close via a gated closure task');
  }
  console.log(`  advance: ${next.action} — ${next.detail}`);
}

/** `goal` — the goal-session read (goal-session-design §9): present · goalId ·
 *  status · the authored goal doc (docs/goal.md) · the generated contract ·
 *  structural state · verdict · legs. Status WORDS only (AC5 — the renderer never
 *  emits counts). */
function cmdGoal() {
  emit(commands.goal(), (v) => {
    if (JSON_OUT) return console.log(JSON.stringify(v, null, 2));
    console.log(renderGoal(v));
  });
}

/** `goal! met [feedback]` / `goal! archive [--override]` / `goal! seed [statement]` —
 *  the goal-session WRITES (goal-session-design §4/§6/§1). `met` is a HUMAN verdict —
 *  the initiator rule lives in L1 (goalVerdict refuses RECORDED_BY=agent); `seed` runs
 *  the interactive grilling session at SESSION scope and materializes goal.md on GO
 *  (flow/goal-seed). Note 'goal' is a READ so it never joins the bare-name WRITES guard
 *  below (only 'goal!' is a write marker). */
async function cmdGoalBang(op: string | undefined, rest: string[]) {
  if (op === 'seed') {
    await cmdGoalSeed(rest.join(' ').trim());
    return;
  }
  if (op === 'met') {
    const feedback = rest.join(' ').trim();
    emit(commands.goalVerdict('met', feedback), (v) => console.log(`goal! met: verdict recorded @ ${v.at}`));
    return;
  }
  if (op === 'archive') {
    emit(commands.goalArchive(rest.includes('--override')), (v) => console.log(`goal! archive: session archived → ${v.dest}`));
    return;
  }
  console.error('usage: ann goal! seed [goal-statement] | ann goal! met [feedback] | ann goal! archive [--override]');
  process.exit(2);
}

/** `goal! seed '<goal>'` — the interactive goal seed. The gate pre-check (empty journey
 *  OR a RE-SEEDABLE sole unconsumed goal) runs here FIRST (before provider wiring) so a
 *  refusal is dogfoodable on this non-empty repo with no provider configured; consumed/
 *  met goals refuse with the WHY — reseeding a replaced goal is never silent. The driver
 *  + L1 re-check the same gate at materialize. On GO the session's converged output
 *  is synthesized to docs/goal.md (git content — commit to publish); the seeded
 *  goal's verdict stays UNCONFIRMED until the human records goal! met. */
async function cmdGoalSeed(idea: string) {
  const gate = commands.goalSeedGate();
  if (!gate.allow) {
    console.error(`not-empty: ${gate.blocker ?? GOAL_SEED_GUARD}`);
    process.exit(1);
  }
  const r = await runGoalSeed(commands, buildAbilities(getAdapter(undefined, ROOT)), { idea });
  if (!r.ok) {
    console.error(`${r.error.code}: ${r.error.blocker}`);
    process.exit(1);
  }
  if (!r.seeded) {
    console.log(`goal! seed: NOT seeded — ${r.note}`);
    return;
  }
  console.log(`goal! seed: goal seeded → ${r.goalId} (${r.contract.intent})`);
  console.log(`  contract: ${r.contract.acceptanceCriteria.length} success criteria`);
  console.log(`  goal.md written to ${r.docPath} @ ${r.sha} — commit to publish`);
  console.log('  verdict: unconfirmed — reach structural exhaustion, then record it: goal! met');
}

/** A task's RESOLVED flow + chain validation — the data the frame will execute. */
function cmdFlow(id: string) {
  const node = resolveId(id);
  const flow = resolveChain(store, node, ROOT);
  const { config, problems: configProblems } = resolveConfig(ROOT);
  const problems = validateChain(buildStepRegistry(), flow.chain, assemblePacket(store, node), config);
  console.log(`FLOW for ${node}`);
  const render = flow.chain.map((e) => `${e.id}${phaseOf(e) === 'execute' ? '' : `@${phaseOf(e)}`}`);
  console.log(`  chain: ${render.length ? render.join(' → ') : '(lifecycle only — no content steps)'}  [${flow.source}]${flow.workType ? ` workType=${flow.workType}` : ''}`);
  if (flow.template) console.log(`  template: ${flow.template}`);
  if (flow.problem) console.log(`  problem: ${flow.problem}`);
  for (const p of configProblems) console.log(`  config-problem: ${p}`);
  if (problems.length) {
    for (const p of problems) console.log(`  chain-problem: ${p.at} — ${p.problem}`);
  } else {
    console.log('  chain validation: clean');
  }
}

/** THE FRAME — run a task through the fixed frame (core-design §4). Resumable: every
 *  rung reads its own tail, so re-running after a stop picks up where it stopped. */
async function cmdRun(id: string) {
  const taskId = resolveId(id);
  const frame = new Frame({ commands, root: ROOT, registry: buildStepRegistry(), abilities: buildAbilities(getAdapter(undefined, ROOT)) });
  const r = await frame.run(taskId);
  if (JSON_OUT) return console.log(JSON.stringify(r, null, 2));
  console.log(`FRAME ${taskId} — ${r.stop.toUpperCase()} (at ${r.phase})`);
  for (const o of r.outcomes) {
    const how = !o.ran ? 'skipped' : o.replayed ? `replayed (run ${o.runId})` : `ran (run ${o.runId})`;
    console.log(`  ${o.step.padEnd(15)} ${o.phase.padEnd(8)} ${how}`);
    for (const f of o.ruleFindings) console.log(`    [${f.severity}] ${f.code} — ${f.detail}`);
  }
  for (const p of r.problems) console.log(`  problem: ${p}`);
  if (r.committed?.spawned.length) console.log(`  spawned: ${r.committed.spawned.join(', ')}`);
  if (r.advance) console.log(`  advance: ${r.advance}`);
  if (r.stop !== 'completed') process.exitCode = 1;
}

function cmdRules(write: boolean) {
  const reg = derivedRegistry();
  if (write) {
    // REVIEW GAP FIX: the registry is DERIVED from the modules — this is the single
    // regen path (no throwaway scripts); rules/check/rules.json is never hand-maintained.
    const out = JSON.stringify(reg, null, 2) + '\n';
    const p = join(ROOT, 'rules', 'check', 'rules.json');
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, out);
    console.log(`rules --write: regenerated ${p} (${reg.rules.length} rules) from the rule modules`);
    return;
  }
  console.log('DERIVED CHECK-RULES REGISTRY (source: self-contained rule modules — never hand-maintained)');
  for (const r of reg.rules) console.log(`  ${r.id.padEnd(24)} [${r.severity.padEnd(7)}] ${r.definition}`);
  console.log(`\n  ${reg.rules.length} rules — 'ann rules --write' regenerates rules/check/rules.json from this`);
}

/** `docs` — the docs→git home (docs/ + the manifest). The MANIFEST (docs/manifest.json)
 *  is the committed resolution index — GENERATED from scanDocsDir, never hand-maintained
 *  (the derived-not-stored rule). Read prints the index; --write regenerates the manifest.
 *  Mirrors `rules`/`rules --write`. */
function cmdDocs(write: boolean) {
  const manifest = loadDocsManifest(ROOT);
  const { fresh, missing, stale } = docsIndexFresh(ROOT);
  if (write) {
    const regen = scanDocsDir(ROOT);
    const p = writeDocsManifest(ROOT, regen);
    console.log(`docs --write: regenerated ${p} (${Object.keys(regen).length} docs) from docs/`);
    return;
  }
  console.log(`DOCS INDEX (${join('docs', MANIFEST_FILE)} — the resolution index; generated — 'ann docs --write' regenerates)`);
  const names = Object.keys(manifest).sort();
  if (!names.length) {
    console.log('  (no docs in the manifest — nothing resolves yet)');
    if (!fresh) console.log(`  note: docs/ has files but the manifest is empty/missing — run 'ann docs --write'`);
  }
  for (const n of names) {
    const rel = manifest[n];
    const full = join(ROOT, rel);
    const sha = existsSync(full) ? docSha(readFileSync(full, 'utf8')) : '(file missing)';
    console.log(`  ${n}  →  ${rel}  @ ${sha}`);
  }
  if (names.length && !fresh) {
    console.log(`  note: manifest out of sync with docs/ (${missing.length} doc(s) not indexed · ${stale.length} stale) — run 'ann docs --write'`);
  }
}

/** ONE CONFIG CLASS, TWO INSTANCES (core-design §6): the personal overlay + the
 *  PROJECT registry — shown together, each leaf tagged with the layer it came from. */
function cmdConfig() {
  const resolution = resolveConfig(ROOT);
  if (JSON_OUT) return console.log(JSON.stringify({ file: configPath(), user: maskedConfig(), ...resolution }, null, 2));
  console.log(`CONFIG FILE: ${configPath()}${configExists() ? '' : ' (not created yet)'}`);
  console.log('  outside the repo · chmod 600 (user-only) · apiKey masked · resolution: env > config > keychain/fallback');
  const entries = Object.entries(maskedConfig());
  if (!entries.length) console.log('  (empty — defaults apply)');
  for (const [k, v] of entries) console.log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  console.log('\nGENERAL CONFIG (rules/config/default.json — the project registry; precedence per leaf: env > user > project > builtin)');
  for (const [key, layer] of Object.entries(resolution.provenance)) {
    const [g, l] = key.split('.');
    const v = (resolution.config[g as 'flow' | 'preferences'] as unknown as Record<string, unknown>)[l];
    console.log(`  ${key.padEnd(26)} ${JSON.stringify(v)} [${layer}]`);
  }
  console.log('  flow.conditionals is PROJECT SEMANTICS — set it in the project registry, never the overlay');
  for (const p of resolution.problems) console.log(`  PROBLEM: ${p}`);
  console.log(`  set: ann config! set <key> <value>  (keys: ${CONFIG_KEYS.join(' · ')})`);
}

/** The overlay's writable keys — provider wiring + the general-config leaves the
 *  overlay may override (core-design §6: preferences.* and flow.verifyFailCycles). */
const CONFIG_KEYS = ['provider', 'model', 'baseUrl', 'apiKey', 'maxTokens', 'flow.verifyFailCycles', 'preferences.askVsAssume'];

function cmdConfigSet(key: string, value: string | undefined) {
  if (!CONFIG_KEYS.includes(key) || value === undefined || value === '') {
    console.error(`usage: ann config! set <key> <value>  (keys: ${CONFIG_KEYS.join(' · ')})`);
    process.exit(2);
  }
  // the general-config leaves nest under their group; validation stays in the resolver
  if (key.includes('.')) {
    const [group, leaf] = key.split('.');
    const cfg = loadConfig() as Record<string, unknown>;
    const existing = (cfg[group] as Record<string, unknown> | undefined) ?? {};
    const v: unknown = leaf === 'verifyFailCycles' ? Number(value) : value;
    if (leaf === 'verifyFailCycles' && !Number.isInteger(v)) { console.error('config!: flow.verifyFailCycles must be an integer'); process.exit(1); }
    setConfig(group as 'flow' | 'preferences', { ...existing, [leaf]: v } as never);
    const after = resolveConfig(ROOT).problems.filter((p) => p.startsWith(`config ${key}`));
    for (const p of after) console.log(`  PROBLEM: ${p}`);
    console.log(`config: saved ${key} → ${configPath()} = ${value}`);
    return;
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
  // S8 — the F11 step-card renderer (detail is the derived card; results are the
  // confirm-target outputs + evidence). The gate card presents the task's RESULTS
  // with the gate — at GATE② (confirm-result) these ARE what the human confirms.
  const d = commands.detail(id);
  if (!d.contract) { console.error(`confirm: no node ${id}`); process.exit(1); }
  if (JSON_OUT) return console.log(JSON.stringify(d, null, 2));
  console.log(renderGateCard({ detail: d, results: store.results(id) }));
  const items = store.results(id);
  if (items.length) console.log('  → drill: ann results <id> <n>');
}

function cmdDetail(id: string) {
  const d = commands.detail(id);
  if (!d.contract) { console.error(`detail: no node ${id}`); process.exit(1); }
  if (JSON_OUT) return console.log(JSON.stringify(d, null, 2));
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
  const items = commands.results(id);
  if (!store.contract(id)) { console.error(`results: no node ${id}`); process.exit(1); }
  const kind = id.includes('/') ? 'TASK' : 'LEG';
  if (JSON_OUT && index === undefined) return console.log(JSON.stringify(items, null, 2));
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

// ---- THE SINGLE WRITE SURFACE: a THIN BINDING over L1 (core-design §8:289) ----
// Every invariant these commands used to re-check by hand now lives in L1's composite
// mutators, so the flow and the CLI get the same enforcement. The binding's whole job
// is argv → command call → render.
const emit = <T>(r: CommandResult<T>, render: (v: T) => void): void => {
  if (!r.ok) {
    console.error(`${r.error.code}: ${r.error.blocker}`);
    process.exit(1);
  }
  render(r.value);
};

function cmdSpawn(id: string, raw: string) {
  let contract: unknown;
  try {
    contract = JSON.parse(raw);
  } catch (e) {
    console.error(`spawn rejected: bad contract JSON (${(e as Error).message})`);
    process.exit(1);
  }
  emit(commands.spawn(id, contract), (v) => console.log(`spawned ${v.id} (${v.kind})`));
}

function cmdGate(id: string, gate: string, decision: string, feedback: string) {
  if (!getVOCAB().gates.includes(gate) || !['accept', 'reject'].includes(decision)) {
    console.error('usage: ann gate! <id> grill|confirm accept|reject [feedback]');
    process.exit(2);
  }
  emit(commands.gate(id, gate, decision, feedback), (v) => {
    console.log(`gate ${v.gate}: ${v.decision} → ${id}`);
    if (v.escalated) console.log('  (reject bound reached — the next rejection escalates to a human design decision)');
  });
}

function cmdSubmit(id: string, gate: string, sha: string | undefined) {
  if (!getVOCAB().gates.includes(gate)) {
    console.error('usage: ann submit! <id> grill|confirm [confirmedSha]');
    process.exit(2);
  }
  emit(commands.submit(id, gate, sha ? { confirmedSha: sha } : {}), (v) =>
    console.log(`submitted ${v.gate} → ${id}${v.confirmedSha ? ` (confirmedSha ${v.confirmedSha})` : ''}`),
  );
}

function cmdRead(name: string) {
  emit(commands.read(name), (v) => {
    if (JSON_OUT) return console.log(JSON.stringify(v, null, 2));
    console.error(`  (${v.path} @ ${v.sha} — provenance ${v.provenance})`);
    console.log(v.content);
  });
}

// ---- DISPATCH ----
// Naming: reads have NO marker; WRITES end in `!` (the mutator convention — Scheme/Ruby/Nix:
// `set!`, `push!`). A bare write name refuses with a hint — the `!` is a guarantee, not advice.
const COMMANDS: Array<{ name: string; args: string; desc: string }> = [
  { name: '<name>', args: '', desc: 'the path for one doc (docs manifest) or a current artifact\'s logical name' },
  { name: 'journey', args: '[id]', desc: 'the look-back (no id) · one node\'s walk (with id) · alias --journey' },
  { name: 'status', args: '[filter]', desc: 'every node\'s derived status (+ superseded marker) · alias --status' },
  { name: 'check', args: '', desc: 'integrity + gates + docs-manifest freshness + the journey state line · alias --check' },
  { name: 'verify', args: '', desc: 'the DRIFT read — reconciles the log\'s recorded claims vs filesystem/git reality (D1-D5 + store-external); exits 1 on any drift · alias --verify' },
  { name: 'ledger', args: '', desc: 'the write-rev ledger — rev + per-node last-write rev/at + hashes (the store-external integrity guard) · alias --ledger' },
  { name: 'specs', args: '', desc: 'the docs contract stack — the manifest → docs/<name>.md @ content-sha (upstream/referrers prose from the file head) · alias --specs' },
  { name: 'providers', args: '', desc: 'the adapter registry: providers, models, defaults (env-resolved, api key masked) · alias --providers' },
  { name: 'config', args: '', desc: 'the user config file (~/.ann/config.json; apiKey masked) · alias --config' },
  { name: 'config!', args: 'set <key> <value>', desc: 'WRITE — save a config value (provider|model|baseUrl|apiKey|maxTokens); chmod 600, outside the repo; apiKey never echoed' },
  { name: 'project', args: '', desc: 'show the current project + known projects · alias --project' },
  { name: 'project!', args: 'add|use|remove <path>', desc: 'WRITE — manage projects by PATH (each has its OWN journey); add <path> registers one' },
  { name: 'cred!', args: 'set|delete <service> <account> [secret]', desc: 'WRITE — OS keychain (macOS, DEV-ONLY local CLI): save/remove a secret via stdin; production = server-side env (12-factor)' },
  { name: 'branch', args: '<id>', desc: 'a node + every descendant\'s events, one walk · alias --branch' },
  { name: 'confirm', args: '<id>', desc: 'a node\'s gate card: intent · ACs · gates · results' },
  { name: 'detail', args: '<id>', desc: 'a node\'s full derived detail: contract · gate states · artifacts (historical only) · blockers · events tail' },
  { name: 'results', args: '<id> [n]', desc: 'a task\'s results by kind (commit/ref/evidence/link); with n, drill into one (commit=git show, ref=file/dir, evidence=event) · alias --results' },
  { name: 'packet', args: '<id>', desc: 'the node\'s deterministic context packet (context-packet-spec; derived on demand, never saved) · alias --packet' },
  { name: 'validate', args: '[id]', desc: 'run the enabled validator rules (all nodes, or one node) — rule-id\'d deterministic findings · alias --validate' },
  { name: 'rules', args: '[--write]', desc: 'the DERIVED check-rules registry (self-contained rule modules are the source) · alias --rules; --write regenerates rules/check/rules.json' },
  { name: 'docs', args: '[--write]', desc: 'the docs→git resolution index (docs/manifest.json — generated from docs/, never hand-maintained) · alias --docs; --write regenerates the manifest' },
  { name: 'chain', args: '', desc: 'the project flow config as data (work-type chains, F3 view) · alias --chain' },
  { name: 'steps', args: '', desc: 'the step registry — the pluggable surface future steps implement against · alias --steps' },
  { name: 'next', args: '', desc: 'the run-next proposal (F5 pull): active leg, frontmost-ready, pending gates, leg gate — derived, never assumed · alias --next' },
  { name: 'goal', args: '', desc: 'the goal-session view (goal-session-design §9): goalId · status · the authored goal doc (docs/goal.md) · the generated contract · structural state · verdict (met/unconfirmed/open) · legs (status words only) · alias --goal' },
  { name: 'flow', args: '<id>', desc: 'a task\'s RESOLVED flow + chain validation (the data the frame will execute) · alias --flow' },
  { name: 'run!', args: '<id>', desc: 'WRITE — run a task through the FRAME (materialize → grill → activate → execute → verify → confirm → commit); resumable, stops at the first block' },
  { name: 'commands', args: '', desc: 'this table as markdown (the derived doc) · alias --commands' },
  { name: 'help', args: '', desc: 'usage · alias --help / -h' },
  { name: 'read', args: '<name>', desc: 'the L1 CONTENT read view — marker-stripped content + path + sha; resolves via the docs manifest (the forward path), with a legacy current-artifact fallback for history · alias --read' },
  { name: 'append!', args: '<id> \'<json>\'', desc: 'WRITE — single-writer append; REFUSES the composite-owned kinds (created/submitted/confirmed/rejected/goal-met) and the RETIRED doc-artifact vocab (artifact-locked/superseded)' },
  { name: 'spawn!', args: '<id> \'<contract-json>\'', desc: 'WRITE — create a node; enforces the v14 contract schema + F-AC19 + id naming + the conclusion (commit-evidence)/leg gates' },
  { name: 'submit!', args: '<id> grill|confirm [confirmedSha]', desc: 'WRITE — the resumable gate write: `submitted` alone, so an interrupted gate stays blocked (confirm records the gate② content binding)' },
  { name: 'gate!', args: '<id> grill|confirm accept|reject [feedback]', desc: 'WRITE — human gate decision (submit + decide; the 3-reject bound is a CONSTANT owned here)' },
  { name: 'goal!', args: 'met [feedback]', desc: 'WRITE — the HUMAN verdict that seals a structurally-exhausted session (goal-met on the goal root); refused for automated (agent) initiators, double-met, and any undecided submission' },
  { name: 'goal!', args: 'archive [--override]', desc: 'WRITE — guarded structural reset: move .ann/journey → .ann/archive/sessions/<ts>-<slug>/ for a fresh goal; refuses without a met verdict (or --override), on store-external verify drifts, and on uncommitted tracked .ann/journey changes' },
  { name: 'goal!', args: 'seed [goal-statement]', desc: 'WRITE — grill a goal at SESSION scope (EMPTY journey seeds new; a RE-SEEDABLE sole unconsumed goal is REPLACED after re-grilling — consumed/met goals refuse): the interactive idea-validation session (grill → batch-ask → research → re-grill → human verdict); on solid, synthesize goal.md (Goal:/Success criteria:) + seed/re-seed the goal leg + write docs/goal.md + regenerate the manifest; revise/reject seeds nothing' },
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
  const WRITES = ['append', 'spawn', 'submit', 'gate', 'cred'];
  if (WRITES.includes(command)) {
    console.error(`ann: writes are marked with '!' — did you mean '${command}!'? (mutator convention: reads have no marker, writes always end in !)`);
    process.exit(1);
  }
  if (command === 'journey' || command === '--journey') {
    if (args[1]) cmdJourneyOne(resolveId(args[1]));
    else cmdJourney();
  } else if (command === 'status' || command === '--status') cmdStatus();
  else if (command === 'check' || command === '--check') cmdCheck();
  else if (command === 'verify' || command === '--verify') cmdVerify();
  else if (command === 'ledger' || command === '--ledger') cmdLedger();
  else if (command === 'specs' || command === '--specs') cmdSpecs();
  else if (command === 'providers' || command === '--providers') cmdProviders();
  else if (command === 'config' || command === '--config') cmdConfig();
  else if (command === 'config!') cmdConfigSet(args[2], args[3]);
  else if (command === 'project') cmdProject();
  else if (command === 'project!') cmdProjectSet(args[1], args[2]);
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
  else if (command === 'packet' || command === '--packet') cmdPacket(resolveId(args[1]));
  else if (command === 'validate' || command === '--validate') cmdValidate(args[1]);
  else if (command === 'rules' || command === '--rules') cmdRules(args[1] === '--write');
  else if (command === 'docs' || command === '--docs') cmdDocs(args[1] === '--write');
  else if (command === 'chain' || command === '--chain') cmdChain();
  else if (command === 'steps' || command === '--steps') cmdSteps();
  else if (command === 'next' || command === '--next') cmdNext();
  else if (command === 'goal' || command === '--goal') cmdGoal();
  else if (command === 'goal!') await cmdGoalBang(args[1], args.slice(2));
  else if (command === 'flow' || command === '--flow') cmdFlow(args[1]);
  else if (command === 'run!') await cmdRun(args[1]);
  else if (command === 'read' || command === '--read') cmdRead(args[1] || '');
  else if (command === 'append!') {
    const raw = args.slice(2).join(' ');
    if (!args[1] || !raw) { console.error('usage: ann append! <id> \'{"at":..,"type":..}\''); process.exit(2); }
    emit(commands.append(args[1], JSON.parse(raw)), () => console.log(`appended → ${args[1]}`));
  } else if (command === 'submit!') cmdSubmit(args[1], args[2], args[3]);
  else if (command === 'spawn!') {
    const raw = args.slice(2).join(' ');
    if (!args[1] || !raw) { console.error('usage: ann spawn! <id> \'<contract-json>\''); process.exit(2); }
    cmdSpawn(args[1], raw);
  } else if (command === 'gate!') cmdGate(args[1], args[2], args[3], args.slice(4).join(' '));
  else {
    // bare-name read: a DOC (via the manifest — the forward path) OR a current
    // artifact's logical name (legacy). Path map for one name; `read <name>` for content.
    const doc = store.resolveDoc(command);
    const cur = doc ? undefined : store.current(command);
    if (doc) {
      console.log(doc.path);
      console.error(`  (docs @ ${doc.sha})`);
    } else if (cur) {
      console.log(cur.path);
      if (cur.sha) console.error(`  (locked @ ${cur.sha}, producer ${cur.producer})`);
    } else {
      console.error(`ann: no doc/artifact for '${command}' (a docs manifest name or a current artifact's logical name)`);
      process.exit(1);
    }
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
