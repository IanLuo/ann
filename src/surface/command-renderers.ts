import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskDetail, ResultItem, CheckView } from '../store/store.js';
import type { GoalView } from '../commands/index.js';
import { renderStatusTree, renderGateCard, renderPlan, renderDrift, renderLedger, renderGoal, deferredLines, PlanLeg, PlanAhead } from './renderers.js';
import type { DeferredTask } from '../commands/index.js';
import { MANIFEST_FILE } from '../store/docs.js';

/**
 * THE PER-COMMAND TEXT RENDERERS (value-canonical CLI).
 *
 * A command's handler computes ONE value — the same object `--json` emits — and this
 * module turns that value into the command's DEFAULT (human) stdout and its stderr
 * diagnostics. `RENDERS[name]` renders stdout; `DIAG[name]` emits the stderr lines the
 * OLD text printed on a SUCCESS (check/verify problems, read/bare-name provenance
 * lines, results-drill ref/commit errors). A command's render key is its canonical
 * handler name, so main routes value → text by the same key.
 *
 * CONTRACT: a renderer reproduces the command's stdout byte-for-byte (each returned
 * string is one console.log chunk; `block` joins them exactly as the old `console.log`
 * calls did, with a single trailing newline). Renderers take `(value, env)` where env
 * carries render-time context never serialized into the JSON value: the post-strip
 * args (some write lines need the addressed id), the target store kind (an archived
 * 'journey' target has no docs home — check's OK line and specs' shape differ), and
 * whether --json is on (stderr provenance lines are suppressed in JSON mode).
 */

export interface RenderEnv {
  args: string[];
  json: boolean;
  root: string;
  /** The RESOLVED STORE TARGET's kind — 'project' has a docs/ home; an archived
   *  'journey' target does not (specs shape + check's OK line depend on it). */
  kind: 'project' | 'journey';
}

export type Renderer = (value: unknown, env: RenderEnv) => string;
export type DiagFn = (value: unknown, env: RenderEnv) => string[];

/* ── THE NODE CARD (the complete task view) — the value BOTH `detail <id>` and
 *  `journey <id>` return: the node's OWN data (every contract field, the top-level
 *  openQuestions, createdAt, the RESOLVED requiredInputs) plus the derived state
 *  (status · gates · artifacts · blockers · events). One derivation, two views: the
 *  journey view adds the full numbered walk + the drill links. ─────────────────── */
export interface NodeCard extends TaskDetail {
  createdAt: string;
  openQuestions: Array<{ id?: string; question?: string; blocking?: boolean; defaultIfUnanswered?: string }>;
  inputs: Array<{ name: string; resolved: boolean; path?: string; sha?: string }>;
  /** v18 §3 — the structured conclusion, lined up against the contract's ACs. `check` is
   *  the ac→check MAPPING and `bound` is that mapping resolved against the log (leg 12/03). */
  claims: Array<{
    ac: string;
    statement: string;
    evidence: string[];
    acText?: string;
    check?: string;
    bound?: { command: string; result: 'pass' | 'fail'; source: 'captured' | 'reported'; detail?: string; sha?: string };
  }>;
  /** The verification RUN HISTORY as the log holds it (newest last) — each check marked
   *  `captured` (a FACT: the engine ran it) or `reported` (a CLAIM: the runner typed it). */
  checks: CheckView[];
}

/** One event as a LIST ROW — the numbering `journey <id>` prints and `events <id> <n>`
 *  addresses (1..N in LOG order). */
export interface EventRow {
  n: number;
  at: string;
  type: string;
  gate?: string;
  note?: string;
}

/** A drill link: what an event points at, and the command that shows it. */
export interface EventLink {
  kind: string;
  what: string;
  detail: string;
  command: string;
}

export type JourneyEventValue = Record<string, unknown> & { at?: string; type?: string; gate?: string };

/** ONE event → its LIST ROW — the numbering `journey <id>` prints and `events <id> <n>`
 *  addresses. `note` is the event's own prose (its summary), never re-worded. Exported
 *  so the CLI handler and the renderer cannot derive different numbers for one log. */
export const eventRow = (n: number, e: Record<string, unknown>): EventRow => ({
  n,
  at: String(e.at ?? ''),
  type: String(e.type ?? ''),
  ...(typeof e.gate === 'string' ? { gate: e.gate } : {}),
  ...(typeof e.note === 'string' && e.note ? { note: e.note } : {}),
});

/** The numbered event line — ONE formatter, so `journey <id>`'s numbering and
 *  `events <id>`'s numbering can never drift (a number IS a handle). */
const walkLines = (row: EventRow, indent = 0): string[] => {
  const pad = ' '.repeat(indent);
  const gate = row.gate ? ` (gate=${row.gate})` : '';
  const out = [`${pad}${String(row.n).padStart(2)}. ${row.at}  ${row.type}${gate}`];
  if (row.note) out.push(`${pad}      ${row.note}`);
  return out;
};

/** THE COMPLETE NODE — every field node.json holds, in a stable order, then the derived
 *  state. Fields the renderer does not know about are STILL printed (a contract field a
 *  reader cannot see is the bug this view exists to fix). */
const nodeCardLines = (c: NodeCard): string[] => {
  const contract = (c.contract ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  lines.push(`${c.isLeg ? 'LEG' : 'TASK'}: ${c.id}`);
  lines.push(`status: ${c.status}${c.superseded ? ' · superseded producer' : ''} · created ${c.createdAt || '(unknown)'}`);
  lines.push('---', 'NODE (node.json — immutable, written once at spawn)');
  lines.push(`  intent: ${String(contract.intent ?? '(none)')}`);
  const acs = (contract.acceptanceCriteria as string[] | undefined) ?? [];
  acs.forEach((a, i) => lines.push(`  AC-${i + 1}: ${a}`));
  const areas = (contract.targetAreas as string[] | undefined) ?? [];
  if (areas.length) lines.push(`  targetAreas: ${areas.join(' · ')}`);
  lines.push(`  requiredInputs:${c.inputs.length ? '' : ' (none)'}`);
  for (const i of c.inputs) {
    lines.push(
      i.resolved
        ? `    - ${i.name} → ${i.path} @ ${i.sha || '(no sha)'}`
        : `    - ${i.name}  [UNRESOLVED — no doc in the manifest and no current artifact resolves it]`,
    );
  }
  const outs = (contract.expectedOutputs as string[] | undefined) ?? [];
  lines.push(`  expectedOutputs: ${outs.length ? outs.join(' · ') : '(none)'}`);
  lines.push(`  workType: ${String(contract.workType ?? '(none — the chain falls back to the default)')}`);
  lines.push(`  flow: ${contract.flow === undefined ? '(none — workType selects the chain)' : JSON.stringify(contract.flow)}`);
  lines.push(`  model: ${String(contract.model ?? '(none — the provider default)')}`);
  if (!c.openQuestions.length) lines.push('  openQuestions: (none)');
  else {
    lines.push('  openQuestions:');
    for (const q of c.openQuestions) lines.push(`    - ${q.id ?? ''}${q.blocking ? ' [BLOCKING]' : ''}: ${q.question ?? ''}`);
  }
  // every OTHER field the contract carries — a future field is never silently hidden
  const known = ['intent', 'acceptanceCriteria', 'targetAreas', 'requiredInputs', 'expectedOutputs', 'workType', 'flow', 'model', 'openQuestions'];
  for (const k of Object.keys(contract).sort()) {
    if (known.includes(k)) continue;
    lines.push(`  ${k}: ${JSON.stringify(contract[k])}`);
  }
  lines.push('---', 'CLAIMS (how each acceptance criterion is met — from the evidence log, v18)');
  if (!c.claims.length) lines.push('  (no claims recorded — the conclusion carries prose, not a per-AC mapping)');
  for (const claim of c.claims) {
    if (!claim.statement) {
      lines.push(`  ${claim.ac}: NO CLAIM RECORDED — ${claim.acText ?? ''}`);
      continue;
    }
    lines.push(`  ${claim.ac}: ${claim.statement}`);
    // the MECHANICAL mapping (leg 12/03): which act covers the AC, and whether that act
    // is in the log (a mapping that names nothing is the finding, never dropped)
    if (claim.check) {
      const b = claim.bound;
      const resolution = b ? `[${b.source} ${b.result}${b.sha ? ` @ ${b.sha}` : ''}]` : '[NO SUCH RUN IN THE LOG]';
      lines.push(`        check: ${claim.check} ${resolution}`);
    }
    if (claim.evidence.length) lines.push(`        evidence: ${claim.evidence.join(' · ')}`);
  }
  lines.push('---', 'CHECKS (what was run — result · command · against which bytes; [captured] = the engine ran it, [reported] = a claim)');
  if (!c.checks.length) lines.push('  (none recorded — the verification is not in the log)');
  for (const k of c.checks) {
    const sha = k.sha ? ` @ ${k.sha}` : '';
    const detail = k.detail ? ` — ${k.detail}` : '';
    lines.push(`  ${k.result === 'pass' ? 'PASS' : 'FAIL'}  ${k.command} [${k.source}]${sha}${detail}`);
  }
  lines.push('---', 'GATES (derived)');
  const gateLine = (g: { state: string; at?: string }) =>
    `GATE ${g.state === 'confirmed' ? '✓' : g.state === 'rejected' ? '✗' : g.state === 'submitted' ? '…' : '·'} ${g.state}${g.at ? ` (${g.at})` : ''}`;
  lines.push(`  ${gateLine(c.gates.grill)} — grilling (entry)`, `  ${gateLine(c.gates.confirm)} — confirm-result (exit)`);
  lines.push('---', 'ARTIFACTS');
  if (!c.artifacts.length) lines.push('  (none locked)');
  for (const a of c.artifacts) lines.push(`  - ${a.name} @ ${a.sha || '(no sha)'} [${a.role}]`, `      ${a.path}`);
  if (c.tasks) {
    lines.push('---', 'TASKS');
    for (const t of c.tasks) lines.push(`  ${t.id}  ${t.status}`);
  }
  if (c.blockers.length) {
    lines.push('---', 'BLOCKED — waiting on human:');
    for (const b of c.blockers) lines.push(`  ${b}`);
  }
  return lines;
};

/** One string per console.log call — joined with '\n' plus the single trailing
 *  newline console.log always appends. Byte-identical to the old text stdout. */
export const block = (lines: string[]): string => lines.join('\n') + '\n';

/* ── help/commands static text — SHARED constants so the JSON usage doc (built in
 *  handlers) and the text renderer here can never drift. ─────────────────────── */
export const HELP_DOC = 'ann — the journey CLI (read + manage). State via commands only (read discipline).';
export const HELP_NAMING = 'reads have NO marker · WRITES end in `!` (the mutator convention — the `!` is a guarantee).';
export const HELP_ENV = [
  'RECORDED_BY=<name>  provenance on recorded events (default: agent)',
  'ANN_STORE=<path>  read a NON-ACTIVE journey READ-ONLY (an archived session / another project); empty/unset = the active session',
  'value: a project root (has .ann/journey/legs) or a journey root (has journey/legs, or legs/ directly)',
];
export const HELP_FOOTER = [
  'doc: npm run ann -- commands   → the command table as markdown (the derived doc source)',
  'json: --json on ANY command → ONE structured JSON document on stdout (error doc: {"error":{code,message}}, exit non-zero)',
];
export const COMMANDS_ENV = [
  'Env: `RECORDED_BY=<name>` — provenance on recorded events (default: agent).',
  'Env: `ANN_STORE=<path>` — read a NON-ACTIVE journey READ-ONLY (an archived session / another project); empty/unset = the active session. Value: a project root (`<root>/.ann/journey/legs`) or a journey root (`journey/legs`, or `legs/` directly).',
];

export interface CommandRow {
  name: string;
  args: string;
  desc: string;
  json: boolean;
}
export interface UsageDoc {
  doc: string;
  naming: string;
  env: string[];
  commands: CommandRow[];
  footer: string[];
}

/* ── RENDERS — canonical-name → the stdout text for that command's value ────── */

export const RENDERS: Record<string, Renderer> = {
  /* help / commands / bare — the doc forms */
  help: (value) => {
    const u = value as UsageDoc;
    const lines = [u.doc, `Naming: ${u.naming}`];
    for (const c of u.commands) lines.push(`  ${c.name.padEnd(14)} ${c.args.padEnd(44)} ${c.desc}`);
    lines.push('', `env: ${u.env[0]}`, `env: ${u.env[1]}`, `     ${u.env[2]}`, ...u.footer);
    return block(lines);
  },
  commands: (value) => {
    const rows = value as CommandRow[];
    const lines = ['| Command | Args | What it does | --json |', '|---|---|---|---|'];
    for (const c of rows) lines.push(`| \`${c.name}\` | \`${c.args}\` | ${c.desc} | \`yes\` |`);
    lines.push('', COMMANDS_ENV[0], COMMANDS_ENV[1]);
    return block(lines);
  },
  bare: (value) => `${(value as { path: string }).path}\n`,

  /* the pure-renderer reads */
  status: (value) => renderStatusTree(value as Parameters<typeof renderStatusTree>[0]) + '\n',
  journey: (value) => {
    const v = value as { legs: PlanLeg[]; ahead: PlanAhead };
    return renderPlan(v.legs, v.ahead) + '\n';
  },
  ledger: (value) => renderLedger(value as Parameters<typeof renderLedger>[0]) + '\n',
  goal: (value) => renderGoal(value as GoalView) + '\n',

  /* goal! met/archive — the wrapped CommandResult render */
  'goal!': (value) => {
    const v = (value as { ok: true; value: { verdict?: string; at: string; dest?: string } }).value;
    return (v.verdict === 'met' ? `goal! met: verdict recorded @ ${v.at}` : `goal! archive: session archived → ${v.dest}`) + '\n';
  },

  /* journeyOne / branch — the event-walk reads */
  journeyOne: (value) => {
    const v = value as NodeCard;
    const lines = nodeCardLines(v);
    lines.push('---', `EVENTS (${v.events.length}) — the full walk; drill one: ann events ${v.id} <n>`);
    v.events.forEach((e, i) => lines.push(...walkLines(eventRow(i + 1, e), 2)));
    lines.push('---', 'LINKS');
    lines.push(`  ann events ${v.id} <n>   one event's raw record + what it points at`);
    lines.push(`  ann packet ${v.id}       the materialized context (inputs resolved, siblings, open questions)`);
    lines.push(`  ann confirm ${v.id}      the gate card (contract · gate states · results)`);
    lines.push(`  ann results ${v.id}      the results, unchanged: commits · refs · evidence`);
    return block(lines);
  },

  /* events — the LIST (numbered as `journey <id>` numbers: 1..N in log order) and the
   * DRILL (the raw record + the links that lead on). */
  events: (value) => {
    const v = value as { id: string; kind: string; events: EventRow[] } | { id: string; kind: string; n: number; total: number; event: JourneyEventValue; links: EventLink[] };
    if (!('event' in v)) {
      const lines = [`EVENTS — ${v.id} (${v.kind} · ${v.events.length})`];
      if (!v.events.length) lines.push('  (no events)');
      for (const row of v.events) lines.push(...walkLines(row, 0));
      if (v.events.length) lines.push('', `  → drill one: ann events ${v.id} <n>  (also: ann journey ${v.id})`);
      return block(lines);
    }
    const lines = [`EVENT ${v.n}/${v.total} — ${v.id}  [${v.event.type}${v.event.gate ? ` gate=${v.event.gate}` : ''}]`];
    lines.push(...JSON.stringify(v.event, null, 2).split('\n'));
    lines.push('', 'links:');
    if (!v.links.length) lines.push('  (none — the record stands alone)');
    for (const l of v.links) lines.push(`  ${l.kind.padEnd(8)} ${l.what.padEnd(34)} ${l.detail}`, `           → ${l.command}`);
    return block(lines);
  },
  branch: (value) => {
    const nodes = value as Array<{ id: string; status: string; events: Array<Record<string, unknown>> }>;
    if (!nodes.length) return '';
    const lines: string[] = [];
    for (const n of nodes) {
      lines.push('', `▸ ${n.id}  [${n.status}]`);
      n.events.forEach((e, i) => {
        const gate = typeof e.gate === 'string' ? ` (gate=${e.gate})` : '';
        const extra = e.type === 'transferred' ? ` → ${e.target ?? ''}` : '';
        lines.push(`${String(i + 1).padStart(2)}. ${e.at ?? ''}  ${e.type}${gate}${extra}`);
        if (e.note) lines.push(`      ${e.note}`);
      });
    }
    return block(lines);
  },

  /* next — the composed offender, now value-shaped */
  next: (value) => {
    const v = value as {
      lookBack: {
        activeLeg?: string;
        activeLegStatus?: string;
        frontmostReady?: { task: string; status: string };
        alsoReady: Array<{ task: string; status: string }>;
        legGate: { met: boolean; blocker?: string };
        pendingGates: Array<{ task: string; gate: string }>;
        deferred?: DeferredTask[];
      };
      advance: { action: string; detail: string };
      goal?: { goalId: string; goalStatus: string; verdict: string };
    };
    const lb = v.lookBack;
    const lines = ['NEXT (derived from events — the observer action)'];
    if (lb.activeLeg) lines.push(`  active leg: ${lb.activeLeg} (${lb.activeLegStatus})`);
    if (lb.frontmostReady) lines.push(`  frontmost-ready: ${lb.frontmostReady.task} (${lb.frontmostReady.status})`);
    for (const t of lb.alsoReady) lines.push(`  also ready: ${t.task} (${t.status})`);
    if (!lb.frontmostReady && lb.activeLeg && lb.activeLegStatus === 'done') {
      lines.push('  LEG GATE REVIEW: all spawned tasks done — verify the epic ACs before advancing');
    }
    for (const p of lb.pendingGates) lines.push(`  WAITING ON YOU: ${p.task} — gate ${p.gate} submitted, undecided`);
    lines.push(`  leg gate: ${lb.legGate.met ? 'MET' : `UNMET — ${lb.legGate.blocker}`}`);
    if (v.advance.action === 'none') {
      if (v.goal) lines.push(`  goal: ${v.goal.goalId} [${v.goal.goalStatus}] — verdict ${v.goal.verdict}`);
    } else if (!lb.frontmostReady && !lb.pendingGates.length) {
      lines.push('  no ready action — resolve blocked tasks or close via a gated closure task');
    }
    lines.push(`  advance: ${v.advance.action} — ${v.advance.detail}`);
    // The outstanding DEFERRED work, APPENDED as its own section (leg 12 task 01): the
    // state line above is never replaced — the exhausted consult and the deferred
    // obligation are both shown.
    if (lb.deferred?.length) lines.push(...deferredLines(lb.deferred));
    return block(lines);
  },

  /* confirm — the GATE CARD (the reviewer's screen): the SAME complete node card
   *  `detail <id>` shows (every node.json field · resolved inputs · open questions ·
   *  gates · artifacts · blockers), then the results and the drill links. The frame's
   *  live gate prompt keeps its own compact form (renderers.ts renderGateCard — talk.ts):
   *  a different surface — what the runner pauses on, not what a human reviews. */
  confirm: (value) => {
    const v = value as { detail: NodeCard; results: ResultItem[] };
    const lines = nodeCardLines(v.detail);
    lines.push('---', `RESULTS (${v.results.length})`);
    if (!v.results.length) lines.push('  (none — no commits, refs, evidence or links recorded yet)');
    v.results.forEach((r, i) => lines.push(`  ${String(i + 1).padStart(2)}. [${r.kind.padEnd(8)}] ${r.label}`));
    if (v.results.length) lines.push(`  → drill: ann results ${v.detail.id} <n>`);
    lines.push(
      '---',
      'LINKS',
      `  ann events ${v.detail.id} [n]   the event list · one event's raw record + what it points at`,
      `  ann journey ${v.detail.id}      the node + the full numbered walk`,
      `  ann packet ${v.detail.id}       the materialized context (inputs · siblings · open questions)`,
    );
    return block(lines);
  },

  detail: (value) => {
    const c = value as NodeCard;
    const lines = nodeCardLines(c);
    lines.push('---', `EVENTS (${c.events.length}) — drill: ann events ${c.id} [n] · full walk: ann branch ${c.id}`);
    for (const row of c.events.slice(-5)) {
      const gate = typeof row.gate === 'string' ? ` (gate=${row.gate})` : '';
      lines.push(`  ${String(row.at ?? '')}  ${String(row.type)}${gate}`);
    }
    return block(lines);
  },

  /* results — the LISTING value is now {id, kind, items} (exposes the same rows text
   *  shows — the uniform-json partial-value fix); the DRILL value is {item, body…}. */
  results: (value) => {
    if ('items' in (value as object)) {
      const v = value as { id: string; kind: string; items: ResultItem[] };
      const lines = [`RESULTS: ${v.id} (${v.kind})`];
      if (!v.items.length) return block(lines.concat(['  (no results yet)']));
      v.items.forEach((it, i) => lines.push(`  ${String(i + 1).padStart(2)}. [${it.kind.padEnd(8)}] ${it.label}`));
      lines.push('', `  drill: ann results ${v.id} <n>`);
      return block(lines);
    }
    // the DRILL — value = { item, …resolved body } (the same body --json emits)
    const v = value as { item: ResultItem } & Record<string, unknown>;
    const it = v.item;
    const lines = [`${String(it.kind).toUpperCase()}: ${it.label}`];
    if (it.at) lines.push(`  at: ${it.at}`);
    switch (it.kind) {
      case 'commit':
        if (v.sha !== undefined) {
          lines.push(v.sha as string, '---', (v.stat as string) ?? '');
        }
        break;
      case 'ref':
        if (v.dir !== undefined) {
          lines.push(`  dir: ${v.dir}`);
          for (const f of (v.entries as string[]) ?? []) lines.push(`    - ${f}`);
        } else if (v.file !== undefined) {
          lines.push(`  file: ${v.file}`, '---', ((v.head as string[]) ?? []).join('\n'));
        }
        break;
      case 'evidence':
        lines.push('---', JSON.stringify(v.event, null, 2));
        break;
      case 'link':
        lines.push(`  url: ${it.url}`);
        break;
    }
    return block(lines);
  },

  validate: (value) => {
    const findings = value as Array<{ severity: string; code: string; nodeId?: string; detail: string }>;
    if (!findings.length) return 'VALIDATE: clean (0 findings)\n';
    const lines = findings.map((f) => `  [${f.severity}] ${f.code}${f.nodeId ? ` ${f.nodeId}` : ''} — ${f.detail}`);
    lines.push(`${findings.length} finding(s)`);
    return block(lines);
  },

  rules: (value) => {
    if ('ok' in (value as object)) {
      const w = (value as { ok: true; value: { path: string; rules: number } }).value;
      return `rules --write: regenerated ${w.path} (${w.rules} rules) from the rule modules\n`;
    }
    const reg = value as { rules: Array<{ id: string; severity: string; definition: string }> };
    const lines = ['DERIVED CHECK-RULES REGISTRY (source: self-contained rule modules — never hand-maintained)'];
    for (const r of reg.rules) lines.push(`  ${r.id.padEnd(24)} [${r.severity.padEnd(7)}] ${r.definition}`);
    lines.push('', `  ${reg.rules.length} rules — 'ann rules --write' regenerates rules/check/rules.json from this`);
    return block(lines);
  },

  docs: (value) => {
    if ('ok' in (value as object)) {
      const w = (value as { ok: true; value: { path: string; docs: number } }).value;
      return `docs --write: regenerated ${w.path} (${w.docs} docs) from docs/\n`;
    }
    const v = value as { fresh: boolean; missing: string[]; stale: string[]; docs: Array<{ name: string; path: string; sha: string }> };
    const lines = [`DOCS INDEX (${join('docs', MANIFEST_FILE)} — the resolution index; generated — 'ann docs --write' regenerates)`];
    const names = v.docs;
    if (!names.length) {
      lines.push('  (no docs in the manifest — nothing resolves yet)');
      if (!v.fresh) lines.push(`  note: docs/ has files but the manifest is empty/missing — run 'ann docs --write'`);
    }
    for (const n of names) lines.push(`  ${n.name}  →  ${n.path}  @ ${n.sha}`);
    if (names.length && !v.fresh) {
      lines.push(`  note: manifest out of sync with docs/ (${v.missing.length} doc(s) not indexed · ${v.stale.length} stale) — run 'ann docs --write'`);
    }
    return block(lines);
  },

  specs: (value, env) => {
    if (env.kind === 'journey') {
      // archived — the legacy current-artifact set (producer prose, no stack framing)
      const docs = value as Array<{ name: string; sha: string; path: string; producer: string }>;
      const lines: string[] = [];
      for (const d of docs) {
        lines.push(`${d.name}  @ ${d.sha}`, `  path:      ${d.path}`, `  producer:  ${d.producer}`);
      }
      return block(lines.length ? lines : ['(no current docs in this archived journey — no docs/ home; legacy artifact locks only)']);
    }
    // project — the docs contract stack (manifest → docs/<name>.md @ content-sha)
    const stack = value as Array<{ name: string; sha: string; path: string; upstream?: string; referrers?: string }>;
    const lines: string[] = [];
    for (const s of stack) {
      lines.push(`${s.name}  @ ${s.sha}`, `  path:      ${s.path}`);
      if (s.upstream) lines.push(`  upstream:  ${s.upstream}`);
      if (s.referrers) lines.push(`  referrers: ${s.referrers}`);
    }
    return block(lines);
  },

  sessions: (value) => {
    const v = value as { sessionsDir: string; sessions: Array<Record<string, string | number>> };
    const lines = [`ARCHIVED SESSIONS (${v.sessionsDir})`];
    if (!v.sessions.length) return block(lines.concat(['  none yet — goal! archive moves a finished journey here']));
    for (const r of v.sessions) lines.push(`  ${r.session} · goal ${r.goal} (${r.status}) · ${r.verdict} · ${r.legs} leg(s)`);
    const first = v.sessions[0];
    if (typeof first.store === 'string') lines.push(`  load one read-only: ANN_STORE="${first.store}" ann journey|status|specs|goal|…`);
    return block(lines);
  },

  chain: (value) => {
    const v = value as { present: boolean; template?: string; chains: Record<string, Array<{ id: string; at?: string; when?: unknown }>> };
    const lines = ['FLOW CONFIG (rules/flow/default.json — DATA, never code)'];
    if (!v.present) return block(lines.concat(['  (no project flow file — the builtin fallback is the EMPTY chain; flow content is DATA, never code)']));
    if (v.template) lines.push(`  template: ${v.template}`);
    for (const [workType, chain] of Object.entries(v.chains)) {
      const render = chain.map((e) => `${e.id}${e.at ? `@${e.at}` : ''}${e.when ? '?' : ''}`);
      lines.push(`  ${workType.padEnd(16)} ${render.length ? render.join(' → ') : '(lifecycle only — the runner does the work)'}`);
    }
    lines.push('  selection: task contract.workType → chains[workType]; contract.flow overrides all');
    lines.push('  per-task resolution: ann flow <id> · registered steps: ann steps');
    return block(lines);
  },

  steps: (value) => {
    const reg = value as Array<{ id: string; roles: Array<{ name: string; required: boolean }>; produces?: string[]; decisions?: string[]; rules: string[] }>;
    const lines = ['STEP REGISTRY (§2 contract — add a step to src/flow/steps/ + reference it in flow data)'];
    for (const s of reg) {
      const roles = s.roles.map((r) => `${r.name}${r.required ? '' : '?'}`).join(', ');
      lines.push(`  ${s.id.padEnd(15)} roles: [${roles}]  produces: [${(s.produces ?? []).join(', ')}]`);
      lines.push(`  ${' '.repeat(15)} decisions: [${(s.decisions ?? []).join(', ')}]  rules: [${s.rules.join(', ')}]`);
    }
    lines.push('', `  ${reg.length} steps — chains reference them by id; unregistered ids fail closed (chain validation)`);
    return block(lines);
  },

  flow: (value) => {
    const v = value as {
      node: string;
      chain: Array<Record<string, unknown> & { at?: string }>;
      source: string;
      workType?: string | null;
      template?: string | null;
      problem?: string | null;
      configProblems: string[];
      chainProblems: Array<{ at: string; problem: string }>;
    };
    const lines = [`FLOW for ${v.node}`];
    const render = v.chain.map((e) => {
      // phase is derivable from the serialized `at` (phaseOf: e.at ?? 'execute')
      const phase = e.at ?? 'execute';
      return `${e.id}${phase === 'execute' ? '' : `@${phase}`}`;
    });
    lines.push(`  chain: ${render.length ? render.join(' → ') : '(lifecycle only — no content steps)'}  [${v.source}]${v.workType ? ` workType=${v.workType}` : ''}`);
    if (v.template) lines.push(`  template: ${v.template}`);
    if (v.problem) lines.push(`  problem: ${v.problem}`);
    for (const p of v.configProblems) lines.push(`  config-problem: ${p}`);
    if (v.chainProblems.length) {
      for (const p of v.chainProblems) lines.push(`  chain-problem: ${p.at} — ${p.problem}`);
    } else {
      lines.push('  chain validation: clean');
    }
    return block(lines);
  },

  /* check/verify/run — ok values carry the exit code; DIAG emits their stderr */
  check: (value, env) => {
    const v = value as {
      problems: string[];
      warnings: string[];
      notes: Array<{ sev: 'error' | 'warn' | 'info'; msg: string }>;
      docs: number;
      state: string;
    };
    const errors = v.problems.length + v.notes.filter((n) => n.sev === 'error').length;
    const lines: string[] = [];
    for (const w of v.warnings) lines.push(`  [rule-warn] ${w}`);
    for (const n of v.notes) {
      if (n.sev === 'error') continue; // stderr — DIAG.check
      lines.push(n.sev === 'warn' ? `  [docs-warn] ${n.msg}` : `  [docs] ${n.msg}`);
    }
    lines.push(
      errors === 0
        ? env.kind === 'project'
          ? `OK — ${v.docs} docs in the manifest, no gate gaps.`
          : 'OK — no gate gaps (archived journey — no docs/ home to index).'
        : `${errors} problem(s).`,
      v.state,
    );
    return block(lines);
  },
  verify: (value) => {
    const v = value as { drifts: unknown[]; count: number };
    return block([v.count === 0 ? 'verify: clean — the log and the filesystem agree (0 drifts).' : `${v.count} drift(s).`]);
  },
  run: (value) => {
    const r = value as RunValue;
    const lines = [`FRAME ${r.taskId} — ${r.stop.toUpperCase()} (at ${r.phase})`];
    for (const o of r.outcomes) {
      const how = !o.ran ? 'skipped' : o.replayed ? `replayed (run ${o.runId})` : `ran (run ${o.runId})`;
      lines.push(`  ${o.step.padEnd(15)} ${o.phase.padEnd(8)} ${how}`);
      for (const f of o.ruleFindings) lines.push(`    [${f.severity}] ${f.code} — ${f.detail}`);
    }
    for (const p of r.problems) lines.push(`  problem: ${p}`);
    if (r.committed?.spawned.length) lines.push(`  spawned: ${r.committed.spawned.join(', ')}`);
    if (r.advance) lines.push(`  advance: ${r.advance}`);
    return block(lines);
  },

  /* serve — the startup descriptor of the minimal service binding (the value IS the
   * bound endpoint; the process stays alive on the socket after this prints). */
  serve: (value) => {
    const v = value as { host: string; port: number; url: string; journey: string };
    return block([
      `ann serve: listening on ${v.url}`,
      `journey: ${v.journey}`,
      '',
      `  UI:     ${v.url}/`,
      `  reads:  GET  ${v.url}/api/journey · /api/status · /api/next · /api/gates`,
      `          GET  ${v.url}/api/detail?id=<id> · /api/confirm?id=<id> · /api/results?id=<id> · /api/packet?id=<id>`,
      `  write:  POST ${v.url}/api/gate  {"id":…,"gate":"grill|confirm","decision":"accept|reject","feedback":…}`,
      '  Ctrl-C to stop.',
    ]);
  },

  /* advance! — the OPERATOR ACTION value renderer: one block per stop. The ADVANCE /
   * boundary cards themselves are PRESENTED live by the session channel (stdout before
   * this render); this block is the value's own summary (the same object --json would
   * refuse, so it never diverges from what a text terminal prints). */
  advance: (value) => {
    const v = value as AdvanceValue;
    const d = v.derivation;
    switch (v.stop) {
      case 'refused-integrity':
        return block([
          `advance! REFUSED — fail-closed integrity re-check (nothing executes on a state the engine does not recognize)`,
          `  derivation at refusal: ${d.action} — ${d.detail}`,
          ...v.blockers.map((b) => `  blocker: ${b}`),
        ]);
      case 'stale-proposal':
        return block([
          'advance! REFUSED — the re-derived advance no longer matches the approved proposal (a stale proposal executes nothing)',
          `  approved: ${d.action} — ${d.detail}`,
          `  now:      ${v.reDerivation ? `${v.reDerivation.action} — ${v.reDerivation.detail}` : '(no derivation)'}`,
        ]);
      case 'declined':
        return block(['advance! declined — nothing executed (the approve is your ONE decision; run advance! again to re-present the current derivation)']);
      case 'boundary':
        return block(boundaryLines(v));
      case 'advanced':
        return block(advancedLines(v));
    }
  },

  /* the provider registry — value carries the env-resolved, masked view */
  providers: (value) => {
    const v = value as ProvidersValue;
    const lines = ['PROVIDER REGISTRY (rules/adapter/provider.json)', `defaultProvider: ${v.defaultProvider}`, '---'];
    for (const p of v.providers) {
      lines.push(`provider: ${p.id}  [${p.kind}]`, `  protocol:   ${p.protocol}`, `  baseUrl:    ${baseUrlText(p)}`, `  apiKey:     ${apiKeyText(p.apiKey)}`, `  defaultModel: ${modelText(p)}`);
    }
    lines.push('---');
    const d = v.defaults as { maxTokens: number; temperature: number; retries: number; backoffMs: number; backoffMaxMs: number; timeoutMs: number };
    lines.push(`defaults: maxTokens=${d.maxTokens} · temperature=${d.temperature} · retries=${d.retries} · backoff=${d.backoffMs}ms→${d.backoffMaxMs}ms · timeout=${d.timeoutMs}ms`);
    return block(lines);
  },

  config: (value) => {
    const v = value as ConfigValue;
    const lines = [`CONFIG FILE: ${v.file}${existsSync(v.file) ? '' : ' (not created yet)'}`];
    lines.push('  outside the repo · chmod 600 (user-only) · apiKey masked · resolution: env > config > keychain/fallback');
    const entries = Object.entries(v.user);
    if (!entries.length) lines.push('  (empty — defaults apply)');
    for (const [k, val] of entries) lines.push(`  ${k}: ${typeof val === 'object' ? JSON.stringify(val) : val}`);
    lines.push('', 'GENERAL CONFIG (rules/config/default.json — the project registry; precedence per leaf: env > user > project > builtin)');
    for (const [key, layer] of Object.entries(v.provenance)) {
      const [g, l] = key.split('.');
      const val = (v.config[g as 'flow' | 'preferences' | 'server'] as unknown as Record<string, unknown>)[l];
      lines.push(`  ${key.padEnd(26)} ${JSON.stringify(val)} [${layer}]`);
    }
    lines.push('  flow.conditionals is PROJECT SEMANTICS — set it in the project registry, never the overlay');
    for (const p of v.problems) lines.push(`  PROBLEM: ${p}`);
    lines.push(`  set: ann config! set <key> <value>  (keys: ${CONFIG_KEYS.join(' · ')})`);
    return block(lines);
  },

  project: (value) => {
    const v = value as ProjectValue;
    const lines = [
      `CURRENT PROJECT: ${v.current && !v.currentStale ? v.current : v.current ? `${v.current} (missing/stale)` : '(none — config.currentProject unset)'}`,
      `cwd: ${v.cwd}`,
    ];
    if (!v.projects.length) lines.push('  (no projects registered)');
    for (const p of v.projects) lines.push(`  ${p.path}${p.stale ? '  (missing/stale)' : ''}`);
    lines.push(
      '  add:    ann project! add <path>',
      '  use:    ann project! use <path>   (or --project <path> / ANN_PROJECT per-call)',
      '  remove: ann project! remove <path>',
    );
    return block(lines);
  },

  read: (value) => `${(value as { content: string }).content}\n`,

  /* the writes — value = the serialized CommandResult ({ok:true,value}) */
  'spawn!': (value) => {
    const v = (value as { ok: true; value: { id: string; kind: string } }).value;
    return `spawned ${v.id} (${v.kind})\n`;
  },
  'append!': (_value, env) => `appended → ${env.args[1]}\n`,
  'submit!': (value, env) => {
    const v = (value as { ok: true; value: { gate: string; confirmedSha?: string } }).value;
    return `submitted ${v.gate} → ${env.args[1]}${v.confirmedSha ? ` (confirmedSha ${v.confirmedSha})` : ''}\n`;
  },
  'gate!': (value, env) => {
    const v = (value as { ok: true; value: { gate: string; decision: string; escalated: boolean; completed?: boolean; pending?: string } }).value;
    const lines = [`gate ${v.gate}: ${v.decision} → ${env.args[1]}`];
    if (v.completed) lines.push('  (completed with the accept — the conclusion evidence was already present)');
    if (v.pending) lines.push(`  ${v.pending}`);
    if (v.escalated) lines.push('  (reject bound reached — the next rejection escalates to a human design decision)');
    return block(lines);
  },
  'evidence!': (value, env) => {
    const v = (value as { ok: true; value: { commits: number; refs: number; claims: number; checks: number } }).value;
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
    const extra = [v.refs ? plural(v.refs, 'ref') : '', v.claims ? plural(v.claims, 'claim') : '', v.checks ? plural(v.checks, 'check') : ''].filter(Boolean);
    return `evidence recorded → ${env.args[1]} (${plural(v.commits, 'commit')}${extra.length ? ` · ${extra.join(' · ')}` : ''})\n`;
  },
  'capture!': (value, env) => {
    const v = (value as { ok: true; value: CapturedCheckValue }).value;
    return block([
      `captured ${v.command} → ${v.result.toUpperCase()} (exit ${v.exitCode}) → ${env.args[1]}`,
      `  fact: source=captured · sha ${v.sha} (the bytes the run saw) · ${v.detail}`,
    ]);
  },
  'complete!': (_value, env) => `completed → ${env.args[1]}\n`,
  'config!': (value, env) => {
    const v = (value as { ok: true; value: { key: string; file: string; problems?: string[]; masked?: boolean } }).value;
    const lines: string[] = [];
    for (const p of v.problems ?? []) lines.push(`  PROBLEM: ${p}`);
    lines.push(`config: saved ${v.key} → ${v.file}${v.masked ? ' (masked, never echoed)' : ` = ${env.args[3]}`}`);
    return block(lines);
  },
  'project!': (value) => {
    const v = (value as { ok: true; value: { op: string; path: string } }).value;
    const prefix = v.op === 'add' ? 'project: added ' : v.op === 'use' ? 'project: current = ' : 'project: removed ';
    return `${prefix}${v.path}\n`;
  },
  'cred!': (value) => {
    const v = (value as { ok: true; value: { op: string; service: string; account: string } }).value;
    return block([
      v.op === 'set' ? `cred!: saved ${v.service}/${v.account} to the OS keychain (masked, never logged)` : `cred!: deleted ${v.service}/${v.account} from the OS keychain`,
    ]);
  },
};

/**
 * packet's text header carries the ADDRESSED id (env.args[1]), which the assembled
 * packet value never includes — so packet routes through this env-aware wrapper.
 */
export function renderPacketById(value: unknown, env: RenderEnv): string {
  const p = value as PacketValue;
  const id = env.args[1];
  const lines: string[] = [`PACKET: ${id} (${p.pathDecisions.isLeg ? 'leg' : 'task'} · depth ${p.pathDecisions.depth})`];
  lines.push(`readiness: ${p.readiness.ready ? 'ready' : 'BLOCKED'}${p.readiness.blockers.length ? `\n  blockers: ${p.readiness.blockers.join('; ')}` : ''}`);
  lines.push('---', 'dependencies:');
  if (!p.dependencies.length) lines.push('  (none declared)');
  for (const d of p.dependencies) {
    lines.push(`  ${d.name} [${d.status}]${d.status === 'resolved' ? ` → ${d.path} @ ${d.sha} (${(d.excerpt ?? '').length} chars excerpt)` : ` — blocker: ${d.blocker}`}`);
  }
  lines.push('---', 'siblings:');
  for (const s of p.siblingStatus.siblings) lines.push(`  ${s.id}  ${s.status}`);
  for (const c of p.siblingStatus.children) lines.push(`  ↳ ${c.id}  ${c.status}`);
  lines.push('---', 'openQuestions:');
  if (!p.openQuestions.length) lines.push('  (none)');
  for (const q of p.openQuestions) lines.push(`  ${q.id} [${q.impact}] ${q.question}${q.default ? ` (default: ${q.default})` : ''}`);
  lines.push('---', 'bindingState:');
  if (!p.bindingState.links.length) lines.push('  (none)');
  for (const l of p.bindingState.links) lines.push(`  ${l.url}`);
  return block(lines);
}

/* ── DIAG — the stderr a command's SUCCESS used to print (bytes preserved) ──── */

export const DIAG: Record<string, DiagFn> = {
  check: (value) => {
    const v = value as { problems: string[]; notes: Array<{ sev: string; msg: string }> };
    const lines = [...v.problems];
    for (const n of v.notes) if (n.sev === 'error') lines.push(`  [docs] ${n.msg}`);
    return lines;
  },
  verify: (value) => (value as { drifts: string[] }).drifts.map((d) => renderDrift(d)),
  read: (value, env) => (env.json ? [] : [`  (${(value as { path: string }).path} @ ${(value as { sha: string }).sha} — provenance ${(value as { provenance: string }).provenance})`]),
  bare: (value, env) => {
    if (env.json) return [];
    const v = value as { kind: 'doc' | 'artifact'; sha?: string; producer?: string };
    if (v.kind === 'doc') return [`  (docs @ ${v.sha})`];
    // old text printed the locked line only when the artifact had a sha
    return v.sha ? [`  (locked @ ${v.sha}, producer ${v.producer})`] : [];
  },
  results: (value, env) => {
    if (env.json) return [];
    const v = value as Record<string, unknown>;
    const errs: string[] = [];
    if (v.commitError) errs.push(`  (${v.commitError})`);
    if (v.refError) errs.push(`  (${v.refError})`);
    return errs;
  },
};

/* ── shared words/helpers ───────────────────────────────────────────────────── */

export const CONFIG_KEYS = ['provider', 'model', 'baseUrl', 'apiKey', 'maxTokens', 'flow.verifyFailCycles', 'preferences.askVsAssume', 'server.host', 'server.port'];

function baseUrlText(p: { baseUrl: string | null; baseUrlSource: string }): string {
  if (p.baseUrl === null) return '(unresolved — env unset, no fallback)';
  const suffix =
    p.baseUrlSource === 'env' ? ' (from env)' : p.baseUrlSource === 'config' ? ' (from config file)' : p.baseUrlSource === 'fallback' ? ' (fallback)' : '';
  return `${p.baseUrl}${suffix}`;
}
function modelText(p: { defaultModel: string | null; defaultModelSource: string }): string {
  if (p.defaultModel === null) return '(unresolved)';
  const suffix =
    p.defaultModelSource === 'env' ? ' (from env)' : p.defaultModelSource === 'config' ? ' (from config file)' : p.defaultModelSource === 'fallback' ? ' (fallback)' : '';
  return `${p.defaultModel}${suffix}`;
}
function apiKeyText(source: string): string {
  switch (source) {
    case 'keychain':
      return 'SET (keychain, masked)';
    case 'env':
      return 'SET (env, masked)';
    case 'config':
      return 'SET (config file, masked)';
    case 'literal':
      return 'SET (literal, masked — move it to the config file or keychain)';
    case 'unset':
      return 'unset — try: ann config! set apiKey <value>';
    default:
      return '(none configured)';
  }
}

/* ── the value shapes the renderers read (the SAME objects handlers produce) ── */

interface PacketValue {
  pathDecisions: { isLeg: boolean; depth: number };
  readiness: { ready: boolean; blockers: string[] };
  dependencies: Array<{ name: string; status: string; path?: string; sha?: string; excerpt?: string; blocker?: string }>;
  siblingStatus: { siblings: Array<{ id: string; status: string }>; children: Array<{ id: string; status: string }> };
  openQuestions: Array<{ id?: string; impact?: string; question?: string; default?: string }>;
  bindingState: { links: Array<{ url: string }> };
}
interface RunValue {
  taskId: string;
  stop: string;
  phase: string;
  outcomes: Array<{ step: string; phase: string; ran: boolean; replayed?: boolean; runId?: number; ruleFindings: Array<{ severity: string; code: string; detail: string }> }>;
  problems: string[];
  committed?: { spawned: string[] };
  advance?: string;
}

/* the advance! value shape — structural (the operator-action module is L2; the render
 * reads the same object the handler's text mode emits). */
interface AdvanceValue {
  stop: 'refused-integrity' | 'declined' | 'stale-proposal' | 'boundary' | 'advanced';
  phase: string;
  derivation: { leg: string; action: 'continue-leg' | 'advance-leg' | 'closure-needed' | 'none'; detail: string };
  reDerivation?: { leg: string; action: 'continue-leg' | 'advance-leg' | 'closure-needed' | 'none'; detail: string };
  blockers: string[];
  frontmost?: { leg: string; task: string; status: string };
  goal?: { goalId?: string; goalStatus?: string; verdict: string; structural: { exhausted: boolean; detail: string } };
  frame?: RunValue;
  landing?: {
    task: string;
    frameStop: string;
    where: 'completed' | 'gate' | 'awaiting-runner' | 'stopped';
    gate?: string;
    advance?: string;
    problems?: string[];
  };
}

/** The NOT-machine-executable card (AC-4) — present + stop, per derivation. */
function boundaryLines(v: AdvanceValue): string[] {
  const d = v.derivation;
  const head = `advance! STOPPED — ${d.action} is NOT machine-executable (present + stop)`;
  if (d.action === 'advance-leg') {
    return [
      head,
      `  derivation: ${d.detail}`,
      '  the AUTHORED-WORK boundary (flow-control v7 §5): an advance selects among ALREADY-AUTHORED tasks —',
      '  the engine derives order/readiness/gates, never content. This front leg has no authored task and',
      '  there is no deterministic engine source for its next contract — never a machine spawn.',
      '  The next task is authored the way every leg was — grounded on the leg epic + the look-back + the',
      '  completed predecessor\'s artifacts — and landed as a push:',
      '      ann spawn! <leg>/<NN>-<worktype>-<slug> \'<contract-json>\'   (F6 push — or run! its grill gate)',
      '  advance! then re-derives continue-leg and runs it.',
    ];
  }
  if (d.action === 'closure-needed') {
    return [
      head,
      `  derivation: ${d.detail}`,
      '  the closure decision is a GATED HUMAN decision (flow-control v7 §5, F-AC16) — a leg/task never',
      '  re-scopes itself silently. Resolve the blocked tasks, or author a gated closure task (a sibling)',
      '  that records gate-revised / transferred / deferred on the task and concludes through its own',
      '  gate①/gate② — the look-back then derives the next advance.',
    ];
  }
  // action 'none' — the four-state goal consult (goal-session-design §5)
  const g = v.goal;
  const consult = g
    ? `  goal: ${g.goalId ?? '(none)'}${g.goalId ? ` [${g.goalStatus}]` : ''} — verdict ${g.verdict}${g.structural.exhausted ? ' (structurally exhausted)' : ''}`
    : '  (no goal view)'; // unreachable — advance() derives the consult from the goal view
  return [
    head,
    `  derivation: ${d.detail}`,
    consult,
    '  NOT machine-executable: goal! met / goal! archive stay HUMAN moves (never a machine seal, never a',
    '  machine archive). The four-state consult: goal! met (seal an exhausted session) · author a subtle',
    '  task (F6 push) · goal! archive & start a new goal.',
  ];
}

/** The continue-leg execution summary + the landing (rule 4 — the next human decision). */
function advancedLines(v: AdvanceValue): string[] {
  const d = v.derivation;
  const f = v.frame;
  const fm = v.frontmost;
  const lines = [`advance! EXECUTED ${d.action} — ${d.detail}`];
  if (fm) lines.push(`  ran through the frame: ${fm.task} (${fm.status})`);
  if (f) {
    lines.push(`  FRAME ${f.taskId} — ${f.stop.toUpperCase()} (at ${f.phase})`);
    for (const p of f.problems) lines.push(`  problem: ${p}`);
    if (f.advance) lines.push(`  advance: ${f.advance}`);
  }
  const l = v.landing;
  if (l) {
    if (l.where === 'gate') {
      lines.push(`  landing: the journey is AT ${l.task} gate ${l.gate} — a submission awaiting the HUMAN decision:`);
      lines.push(`           ann gate! ${l.task} ${l.gate} accept|reject (advance! never answers a gate)`);
    } else if (l.where === 'awaiting-runner') {
      lines.push(`  landing: ${l.task} awaits the RUNNER (${l.frameStop}) — do the work, git commit, and record`);
      lines.push(`           evidence (ann evidence! ${l.task} <sha>); the confirm-result gate then decides`);
      lines.push(`           — a human gate, never passed silently (accepting it closes the task when the conclusion`);
      lines.push(`           evidence is recorded; without the evidence it awaits ann complete! ${l.task}).`);
    } else if (l.where === 'completed') {
      lines.push(`  landing: ${l.task} completed — its gates were decided by the human channel`);
      if (l.advance) lines.push(`  next: ${l.advance}`);
    } else {
      lines.push(`  landing: ${l.task} — the frame stopped (${l.frameStop}):`);
      for (const p of l.problems ?? []) lines.push(`    ${p}`);
    }
  }
  return lines;
}
/** The `capture!` write's value — the fact the engine recorded (leg 12/03). */
interface CapturedCheckValue {
  command: string;
  result: 'pass' | 'fail';
  exitCode: number;
  detail: string;
  sha: string;
  at: string;
}
interface ProvidersValue {
  defaultProvider: string;
  defaults: Record<string, unknown>;
  providers: Array<{
    id: string;
    kind: string;
    protocol: string;
    baseUrl: string | null;
    baseUrlSource: string;
    apiKey: string;
    defaultModel: string | null;
    defaultModelSource: string;
  }>;
}
interface ConfigValue {
  file: string;
  user: Record<string, unknown>;
  config: { flow: Record<string, unknown>; preferences: Record<string, unknown>; server: Record<string, unknown> };
  provenance: Record<string, string>;
  problems: string[];
}
interface ProjectValue {
  current: string | null;
  currentStale: boolean;
  cwd: string;
  projects: Array<{ path: string; stale: boolean }>;
}
