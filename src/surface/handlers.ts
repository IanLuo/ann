import {
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { Store, resolveStoreLocation, storeJourneyDir } from '../store/store.js';
import type { StoreLocation, JourneyEvent, ResultItem, TaskDetail } from '../store/store.js';
import { scanDocsDir, loadDocsManifest, writeDocsManifest, docsIndexFresh, docSha } from '../store/docs.js';
import { Commands, CommandResult, GOAL_SEED_GUARD, nodeIdOf } from '../commands/index.js';
import { OpLog, newRunId, readOpLog, parseSince, DEFAULT_TAIL, type LogLevel } from '../abilities/obs/log.js';
import { ALLOWLIST_NAMES } from '../commands/capture.js';
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
  listProjects,
  getCurrentProject,
  setProject,
  useProject,
  removeProject,
} from '../abilities/llm/index.js';
import { getVOCAB } from '../store/vocab.js';
import { assemblePacket } from '../flow/materialize.js';
import { runValidators, derivedRegistry } from '../flow/validators/index.js';
import { buildStepRegistry } from '../flow/steps/index.js';
import { loadProjectFlow, resolveChain, validateChain } from '../flow/chain.js';
import { Frame } from '../flow/frame.js';
import { runGoalSeed } from '../flow/goal-seed.js';
import { runSpecSession, docsSpecsTarget, DEFAULT_SPEC_NAME } from '../flow/spec-doc.js';
import { runOperatorAction, OperatorStop } from '../flow/operator-action.js';
import { buildAbilities } from '../abilities/index.js';
import { resolveConfig } from '../flow/config.js';
import { getAdapter } from '../abilities/llm/index.js';
import {
  RENDERS,
  eventRow,
  DIAG,
  renderPacketById,
  type RenderEnv,
  type NodeCard,
  type UsageDoc,
  type CommandRow,
  HELP_DOC,
  HELP_NAMING,
  HELP_ENV,
  HELP_FOOTER,
  CONFIG_KEYS,
} from './command-renderers.js';

/**
 * THE VALUE-CANONICAL CLI (surface) — handlers.ts.
 *
 * Every command is a PURE HANDLER of a `ctx` returning an `Outcome`; a central
 * `runMain()` routes flag-stripping / dispatch / exits / errors. The DEFAULT text is a
 * RENDER (command-renderers.ts) of the SAME value that `--json` emits, so default and
 * `--json` can never diverge — and handlers are in-process testable (the parity test
 * drives a handler on a hermetic ctx and compares its render + value against the REAL
 * spawned binary's stdout).
 *
 *   ctx:      { root, args, store, commands, who, json, target(), renderEnv() } —
 *             handlers read ROOT/WHO and the lazy store/commands OFF ctx, never globals.
 *   Outcome:  { ok:true, value, exitCode? } | { ok:false, error:{code,message,text?}, exitCode? }
 *   Errors:   handlers THROW CommandExit (caught at the dispatch boundary → Outcome),
 *             so the registry reads linearly. Exit codes unchanged: 0 ok · 1 command/
 *             store/validation error · 2 usage.
 *
 * These bodies are a FAITHFUL PORT of the old cli.ts command functions: each returns
 * the value the old `--json` branch emitted (so JSON is byte-identical to before,
 * except the intended results-listing + chain `present` value fixes), and text comes
 * from the renderers. THE ONE carve-out: `goal! seed` is an INTERACTIVE grilling
 * session (drives the terminal; JSON refuses up-front) — it stays non-value-canonical
 * and writes its own stdout, exactly as before. Everything else is a value + renderer.
 */

/* ── the Outcome/exit model ─────────────────────────────────────────────────── */

export type Outcome =
  | { ok: true; value: unknown; exitCode?: number }
  | { ok: false; error: { code: string; message: string; text?: string }; exitCode?: number };

/** A thrown failure — caught at the dispatch boundary and converted to an Outcome. */
export class CommandExit extends Error {
  code: string;
  text?: string;
  exitCode: number;
  constructor(code: string, message: string, opts: { text?: string; exitCode?: number } = {}) {
    super(message);
    this.name = 'CommandExit';
    this.code = code;
    this.text = opts.text;
    this.exitCode = opts.exitCode ?? 1;
  }
}

const boom = (code: string, message: string, opts?: { text?: string; exitCode?: number }): never => {
  throw new CommandExit(code, message, opts);
};

/** A usage failure (exit 2). JSON message = first line; text keeps the full hint. */
const usage = (message: string): never => boom('usage', message.replace(/\n.*/s, ''), { text: message, exitCode: 2 });

/** Convert a CommandResult. The write shape: ok → {ok:true,value} (the serialized
 *  CommandResult); fail → throw (text shows `${code}: ${blocker}`, JSON the blocker —
 *  byte-identical to the old emit/reject split). */
function writeResult<T>(r: CommandResult<T>): Outcome {
  if (!r.ok) return boom(r.error.code, r.error.blocker, { text: `${r.error.code}: ${r.error.blocker}` });
  return { ok: true, value: { ok: true, value: r.value } };
}
/** A CommandResult read as a bare view — success value unwrapped. */
function viewResult<T>(r: CommandResult<T>): Outcome {
  if (!r.ok) return boom(r.error.code, r.error.blocker, { text: `${r.error.code}: ${r.error.blocker}` });
  return { ok: true, value: r.value };
}

/* ── the ctx ────────────────────────────────────────────────────────────────── */

export interface CliContext {
  /** The resolved project root (or cwd for the project-registry commands). */
  root: string;
  /** argv after `--project <path>` / `--json` are stripped — never the flag words. */
  args: string[];
  /** RECORDED_BY — provenance for the commands layer. */
  who: string;
  json: boolean;
  /** THE OPERATIONAL LOG HANDLE (leg 12/05) — one runId per invocation; the command's
   *  own line + every write + every frame phase of this invocation correlate here. */
  log: OpLog;
  /** The LAZY store over the RESOLVED target (env or active) — first use constructs. */
  store: Store;
  /** The LAZY L1 commands over ctx.store + who. */
  commands: Commands;
  /** Session addressing — {loc, readOnly}, resolved once, lazily. */
  target(): { loc: StoreLocation; readOnly: boolean };
  /** Render-time context (args/json/root + the lazy target kind) for RENDERS/DIAG. */
  renderEnv(): RenderEnv;
}

/** Build a ctx over a resolved root — shared by runMain and the parity-test harness.
 *  Does NOT chdir (runMain chdirs before creating the ctx). Lazy store/commands/target
 *  so config!/cred!/project! never touch the store (bad ANN_STORE → still available). */
export function createContext(root: string, args: string[], opts: { json?: boolean; runId?: string; log?: OpLog } = {}): CliContext {
  const who = process.env.RECORDED_BY || 'agent';
  const json = opts.json ?? false;
  // THE CORRELATION ROOT: one runId per invocation (a caller may supply its own — the
  // driver's run, a service boot) and one log handle; children narrow taskId/runId.
  const log = opts.log ?? new OpLog(root, opts.runId ?? newRunId('cmd'), who);
  const envStore = (process.env.ANN_STORE ?? '').trim();
  let _target: { loc: StoreLocation; readOnly: boolean } | undefined;
  const target = (): { loc: StoreLocation; readOnly: boolean } => {
    if (_target) return _target;
    if (envStore) {
      const loc = resolveStoreLocation(envStore);
      let activeJourney: string | undefined;
      try {
        activeJourney = realpathSync(storeJourneyDir(resolveStoreLocation(root)));
      } catch {
        activeJourney = undefined; // no active legs/ baseline — any target is read-only
      }
      return (_target = { loc, readOnly: !activeJourney || realpathSync(storeJourneyDir(loc)) !== activeJourney });
    }
    return (_target = { loc: resolveStoreLocation(root), readOnly: false });
  };
  let _store: Store | undefined;
  const store = new Proxy({} as Store, {
    get(_t, prop) {
      const s = (_store ??= new Store(target().loc, { readOnly: target().readOnly }));
      const v = Reflect.get(s, prop as never);
      return typeof v === 'function' ? (v as () => unknown).bind(s) : v;
    },
  });
  let _commands: Commands | undefined;
  const commands = new Proxy({} as Commands, {
    get(_t, prop) {
      const c = (_commands ??= new Commands(store, who, undefined, log));
      const v = Reflect.get(c, prop as never);
      return typeof v === 'function' ? (v as () => unknown).bind(c) : v;
    },
  });
  const ctx: CliContext = {
    root,
    args,
    who,
    json,
    log,
    store,
    commands,
    target,
    renderEnv() {
      let kind: 'project' | 'journey' | undefined;
      const env: RenderEnv = {
        args: ctx.args,
        json: ctx.json,
        root: ctx.root,
        get kind() {
          return (kind ??= ctx.target().loc.kind);
        },
      };
      return env;
    },
  };
  return ctx;
}

/** The resolved target's docs home — a 'project' target has its OWN docs/ manifest
 *  home (its root); a 'journey' target (an archived session) has NONE. */
const targetDocsHome = (ctx: CliContext): string | undefined => {
  const t = ctx.target();
  return t.loc.kind === 'project' ? t.loc.root : undefined;
};

const hasSuperseded = (ctx: CliContext, id: string) => ctx.store.events(id).some((e) => e.type === 'superseded');
const display = (ctx: CliContext, id: string) => ctx.store.status(id) + (hasSuperseded(ctx, id) ? ' · artifact superseded' : '');

/** Resolve a possibly-partial id: exact → last-segment → unique prefix; fail-closed
 *  with NAMED candidates when ambiguous (never a silent pick). Reads only — writes
 *  stay strict full-id (the `!` mutators take no shortcuts). `undefined` behaves as the
 *  old code did (no-node 'undefined' — callers like `ann flow` pass a missing arg). */
function resolveId(ctx: CliContext, raw: string | undefined): string {
  const ids = ctx.store.ids();
  if (raw !== undefined && ids.includes(raw)) return raw;
  const last = (i: string) => i.split('/').pop()!;
  const byLast = ids.filter((i) => last(i) === raw);
  if (byLast.length === 1) return byLast[0];
  if (byLast.length > 1) return boom('ambiguous-id', `ann: ambiguous id '${raw}' — matches ${byLast.join(', ')}; use the full id`);
  // partial last segment (e.g. '05-s2' → '05-s2-envision-grilling') — undefined coerces to 'undefined' (legacy)
  const byLastPrefix = ids.filter((i) => last(i).startsWith(raw as string));
  if (byLastPrefix.length === 1) return byLastPrefix[0];
  if (byLastPrefix.length > 1) return boom('ambiguous-id', `ann: ambiguous '${raw}' — matches ${byLastPrefix.join(', ')}; use more of the id`);
  // full-id prefix (e.g. '06-engine-build/05')
  const byPrefix = ids.filter((i) => i.startsWith(raw as string));
  if (byPrefix.length === 1) return byPrefix[0];
  if (byPrefix.length > 1) return boom('ambiguous-id', `ann: ambiguous prefix '${raw}' — matches ${byPrefix.join(', ')}; use more of the id`);
  return boom('no-node', `ann: no node '${raw}'`);
}

/** The config! group leaves that are NUMBERS (everything else is a string). */
const NUMERIC_CONFIG_LEAVES = new Set(['verifyFailCycles', 'port']);

/** The command table (one source — text rows, JSON rows, markdown rows) */

/** The `capture!` command's own recording of the DECISION (leg 12/03 AC-1) — the
 *  mechanism, its guard, and the rejected alternative, in the one place every initiator
 *  reads (`ann --commands`, the README table, the help). */
export const CAPTURE_COMMAND_DESC = `WRITE — THE CAPTURED CHECK (leg 12/03: the record is a consequence, not a claim): the engine RUNS one project command and records what happened as a FACT — {command, result (the REAL exit code: 0 → pass, else fail), exitCode, detail (output digest/summary), sha (the repo bytes the run saw), source:'captured'} — distinguishable in the log from a REPORTED check (--checks on evidence!, which stays available but is LABELLED 'reported' by the writer). MECHANISM: (a) engine-run with a CLOSED ALLOWLIST (${ALLOWLIST_NAMES.join(' · ')}); GUARD: the caller names a command — the name must be one of those literals, each mapped to a fixed argv spawned with shell:false, so no arbitrary string ever reaches an exec and the engine does not become a general shell (the shell ability is contract-declared and UNBUILT); the tree must be clean outside the ann store, and the sha is READ FROM GIT, never typed. REJECTED: (b) runner-supplied capture with engine validation (sha resolves · command allowlisted · result ∈ pass|fail) — it cannot produce the outcome (the result stays typed by the reporter, which is the hole this closes) and its guards are a strict subset of (a). The write is the SAME L1 write (store.appendCaptured; the general writer refuses a captured check by name) and provenance comes from RECORDED_BY. A failing run records result=fail and the close REFUSES (no-captured-pass).`;

const COMMANDS: Array<{ name: string; args: string; desc: string }> = [
  { name: '<name>', args: '', desc: 'the path for one doc (docs manifest) or a current artifact\'s logical name' },
  { name: 'journey', args: '[id]', desc: 'the look-back (no id) · the COMPLETE NODE VIEW (with id): every node.json field (workType · flow · model too) + openQuestions · createdAt · the RESOLVED requiredInputs + status/gates/artifacts/blockers + the full numbered event walk · alias --journey' },
  { name: 'events', args: '<id> [n]', desc: 'the EVENT LIST (numbered exactly as journey <id> numbers it) · with n, the DRILL: that event\'s raw record + LINKS to more data (commit → the results drill · ref → its existence · artifact → ann read <name> · gate event → ann confirm <id>) — the shared drill every node view points at' },
  { name: 'status', args: '[filter]', desc: 'every node\'s derived status (+ superseded marker) · alias --status' },
  { name: 'check', args: '', desc: 'integrity + gates + docs-manifest freshness + the journey state line · alias --check' },
  { name: 'verify', args: '', desc: 'the DRIFT read — reconciles the log\'s recorded claims vs filesystem/git reality (D1-D5 + store-external); exits 1 on any drift · alias --verify' },
  { name: 'ledger', args: '', desc: 'the write-rev ledger — rev + per-node last-write rev/at + hashes (the store-external integrity guard) · alias --ledger' },
  { name: 'log', args: '[--task <id>] [--run <runId>] [--level <level>] [--since <iso|30m>] [--tail <n>]', desc: 'THE OPERATIONAL LOG READ (leg 12/05 — observability for debugging): the scratch JSONL action log (logs/operation.jsonl, GITIGNORED — never the record) as a derived tail — one line per engine action (command · write · frame phase · driver turn · stop) carrying a WALL-CLOCK ts (the journey events are date-only), the actor/provenance, the REDACTED inputs, the outcome, the duration and the CORRELATION ID (runId · taskId · turn); a whole run reconstructs from one --run. Filters: --task <id> · --run <runId> · --level info|warn|error (that level and above) · --since <iso|30m|2h|1d> · --tail <n> (default 50) · alias --log' },
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
  { name: 'sessions', args: '', desc: 'the archived sessions of this project (goal! archive history) — one line each: goal · status · verdict · legs; point at one read-only via ANN_STORE · alias --sessions' },
  { name: 'chain', args: '', desc: 'the project flow config as data (work-type chains, F3 view) · alias --chain' },
  { name: 'steps', args: '', desc: 'the step registry — the pluggable surface future steps implement against · alias --steps' },
  { name: 'next', args: '', desc: 'the run-next proposal (F5 pull): active leg, frontmost-ready, pending gates, leg gate — derived, never assumed · alias --next' },
  { name: 'goal', args: '', desc: 'the goal-session view (goal-session-design §9): goalId · status · the authored goal doc (docs/goal.md) · the generated contract · structural state · verdict (met/unconfirmed/open) · legs (status words only) · alias --goal' },
  { name: 'flow', args: '<id>', desc: 'a task\'s RESOLVED flow + chain validation (the data the frame will execute) · alias --flow' },
  { name: 'run!', args: '<id>', desc: 'WRITE — run a task through the FRAME (materialize → grill → activate → execute → verify → confirm → commit); resumable, stops at the first block' },
  { name: 'advance!', args: '', desc: 'WRITE — the OPERATOR ACTION (F5 approve→execute): integrity re-checked fail-closed → the advance re-derived (a stale proposal executes nothing) → the ADVANCE card + the builder\'s ONE approve → continue-leg runs the frontmost-ready through the frame (run!) and lands at its next human gate; advance-leg / closure-needed / none are NOT machine-executable — the boundary/closure/goal-consult card, then stop' },
  { name: 'commands', args: '', desc: 'this table as markdown (the derived doc) · alias --commands' },
  { name: 'help', args: '', desc: 'usage · alias --help / -h' },
  { name: 'read', args: '<name>', desc: 'the L1 CONTENT read view — marker-stripped content + path + sha; resolves via the docs manifest (the forward path), with a legacy current-artifact fallback for history · alias --read' },
  { name: 'append!', args: '<id> \'<json>\'', desc: 'WRITE — single-writer append; REFUSES the composite-owned kinds (created/submitted/confirmed/rejected/goal-met) and the RETIRED doc-artifact vocab (artifact-locked/superseded). `cancelled` (a task no longer needed — the counterpart of the submit!/gate! close) is recordable here with a REQUIRED reason' },
  { name: 'spawn!', args: '<id> \'<contract-json>\'', desc: 'WRITE — create a node; enforces the v14 contract schema + F-AC19 + id naming + the conclusion (commit-evidence)/leg gates' },
  { name: 'submit!', args: '<id> grill|confirm [confirmedSha]', desc: 'WRITE — submit finished work at a gate for the human decision (the SUCCESS half of the task close; the counterpart is cancel — no longer needed): records `submitted` — the task blocks and waits for `gate! accept|reject`; an interrupted gate stays blocked (resumable), never looks un-started. `[confirmedSha]` (confirm gate only) binds the decision to the exact bytes under review' },
  { name: 'gate!', args: '<id> grill|confirm accept|reject [feedback]', desc: 'WRITE — human gate decision (submit + decide; the 3-reject bound is a CONSTANT owned here); a CONFIRM accept AUTO-CLOSES the task when the conclusion evidence is already present (the same rule the frame runs) — with the evidence missing the task stays `accepted` and the result names the `complete!` still owed' },
  { name: 'evidence!', args: "<id> <sha>[,<sha>…] [--refs a.md,b.md] [--note '<text>'] [--claims '<json>'] [--checks '<json>']", desc: "WRITE — the CONCLUSION record (F-AC18): structured commit evidence naming the committed doc/code that carries the deliverable (commits[] non-empty, a sha per entry) plus the OPTIONAL structured conclusion (format v18, MECHANICAL since leg 12/03): --claims = one {ac, check?, statement?, evidence?} per acceptance criterion — `check` is the ac→CHECK MAPPING (the recorded run that covers the AC; `statement` is optional prose, derived from the mapping when absent) and evidence entries are POINTERS (commit sha · ref path · doc name) resolved at READ time; --checks = {command, result: pass|fail, detail?, sha?, source?} (what was RUN) — a check without a `source` is LABELLED `reported` by the writer, and `source:'captured'` is REFUSED here (engine-produced: run capture!); the shape stays the store's — a validated front over the same L1 write, provenance from RECORDED_BY, and a bad JSON argument writes nothing" },
  { name: 'capture!', args: "<id> '<command>'", desc: CAPTURE_COMMAND_DESC },
  { name: 'complete!', args: '<id> [--note \'<text>\']', desc: 'WRITE — the EXPLICIT DONE terminal (a confirm accept auto-closes on evidence, so this gesture is the accepted-without-evidence exception; an already-completed task gets an idempotent refusal): refuses without the confirm gate\'s LAST decision being an ACCEPT and without the conclusion evidence — the F-AC18 predicate (TIGHTENED, leg 12/03: a REPORTED check is refused by name; leg 12/02: so is a CAPTURED FAILURE recorded on a CITED commit — `cited-check-failed`): evidence.commits[] AND the structured conclusion (a claim per acceptance criterion, each mapped to a check the log holds) AND at least one CAPTURED pass bound to a cited commit AND no captured failure on one' },
  { name: 'goal!', args: 'met [feedback]', desc: 'WRITE — the HUMAN verdict that seals a structurally-exhausted session (goal-met on the goal root); refused for automated (agent) initiators, double-met, and any undecided submission' },
  { name: 'goal!', args: 'archive [--override]', desc: 'WRITE — guarded structural reset: move .ann/journey → .ann/archive/sessions/<ts>-<slug>/ for a fresh goal; refuses without a met verdict (or --override), on store-external verify drifts, and on uncommitted tracked .ann/journey changes' },
  { name: 'goal!', args: 'seed [goal-statement]', desc: 'WRITE — grill a goal at SESSION scope (EMPTY journey seeds new; a RE-SEEDABLE sole unconsumed goal is REPLACED after re-grilling — consumed/met goals refuse): the interactive idea-validation session (grill → batch-ask → research → re-grill → human verdict); on solid, synthesize goal.md (Goal:/Success criteria:) + seed/re-seed the goal leg + write docs/goal.md + regenerate the manifest; revise/reject seeds nothing' },
  { name: 'spec!', args: '[docName] [--amend]', desc: 'WRITE — grill the SEEDED goal at REQUIREMENTS/SYSTEM-DESIGN level into ONE amendable spec doc docs/<docName>.md (default requirements): PRODUCE grills the goal into a NEW name; --amend REWRITES an EXISTING in-force doc in place (specs are LIVING, amendable — the goal is not): the interactive SPECS grilling session; on GO it writes docs/<name>.md + regenerates the manifest — commit to publish (JSON refuses: interactive terminal only)' },
  { name: 'serve', args: '[--host <h>] [--port <n>]', desc: 'RUN — the minimal SERVICE + UI vertical (the goal\'s AC-1): a thin HTTP binding over THIS command layer (same L1 reads/writes, the SAME value-canonical JSON as --json; no second state derivation) — reads journey·status·next·detail·confirm·results·packet·events (the node event list + the one-event drill)·the whole-journey gate queue·the operational log (GET /api/log), the gate write (accept|reject + feedback), and the UI page at /; the BIND comes from --host/--port > ANN_HOST/ANN_PORT > the general config (server.host/server.port — the project registry + the ~/.ann/config.json overlay) > the builtin 127.0.0.1:8787; credentials stay server-side (JSON refuses: a daemon has no one-document answer)' },
];

/* ── the NODE CARD — the complete task view (shared by `journey <id>` and `detail`) ──
 *
 * The correction to a thin gate card: the node's OWN data first — every contract field
 * present in node.json (workType · flow · model included), the top-level openQuestions
 * (v14: a SIBLING of contract, never a contract field), createdAt, and the RESOLVED
 * requiredInputs (a bare logical name is not reviewable; name → path @ sha, resolved or
 * not) — then the derived state (status · gates · artifacts · blockers · leg tasks).
 * Derived on demand from the log; never cached, never asserted. */
function nodeCard(ctx: CliContext, id: string): NodeCard {
  const d = ctx.commands.detail(id);
  if (!d.contract) boom('no-contract', `no node ${id} — nothing to show`);
  const raw = (ctx.store.contract(id) ?? {}) as { openQuestions?: unknown; createdAt?: unknown };
  const nested = (d.contract as { openQuestions?: unknown } | undefined)?.openQuestions;
  // v18: the card renders the SAME L1 conclusion the close enforces (ctx.commands
  // .conclusion) — the binding only RESOLVES the pointers for display, so a card that
  // says NO CLAIM RECORDED and a close that succeeds cannot both be true.
  const conclusion = ctx.commands.conclusion(id);
  return {
    ...d,
    status: display(ctx, id),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : ctx.store.createdAt(id),
    openQuestions: (raw.openQuestions ?? nested ?? []) as NodeCard['openQuestions'],
    inputs: resolveInputs(ctx, d.contract),
    claims: [
      ...conclusion.claims.map((c) => ({ ...c, evidence: c.evidence.map((p) => `${p} [${resolvePointer(ctx, p)}]`) })),
      ...conclusion.unclaimed.map((u) => ({ ac: u.ac, statement: '', evidence: [] as string[], acText: u.acText })),
    ],
    checks: conclusion.checks,
  };
}

/** A claim's evidence POINTER, resolved at READ time: a commit sha · a ref path · a doc
 *  name — and an explicit UNRESOLVED when none of those hold (the pointer that stopped
 *  resolving is the finding; it is never dropped). */
function resolvePointer(ctx: CliContext, pointer: string): string {
  const p = pointer.trim();
  if (/^[0-9a-f]{7,40}$/.test(p)) {
    try {
      execFileSync('git', ['cat-file', '-t', p], { stdio: 'ignore' });
      return 'resolves in git';
    } catch {
      return 'UNRESOLVED — no such commit';
    }
  }
  const full = join(ctx.root, p);
  if (existsSync(full)) {
    const st = statSync(full);
    return st.isDirectory() ? 'directory' : `${readFileSync(full, 'utf8').split('\n').length} lines`;
  }
  const doc = ctx.store.resolveDoc(p);
  if (doc) return `${doc.path} @ ${doc.sha}`;
  const cur = ctx.store.current(p);
  if (cur) return `${cur.path} @ ${cur.sha ?? '(no sha)'}`;
  return 'UNRESOLVED — no commit, path or doc';
}

/** A requiredInput's resolution (the SAME rule the context packet uses): the docs
 *  manifest first — the forward path — then a legacy current artifact. A name that
 *  resolves to nothing is REPORTED as unresolved, never dropped: an unreviewable input
 *  is the thing the reader must see. */
function resolveInputs(ctx: CliContext, contract: Record<string, unknown> | undefined): Array<{ name: string; resolved: boolean; path?: string; sha?: string }> {
  const names = ((contract?.requiredInputs as string[] | undefined) ?? []).filter((n) => typeof n === 'string' && n.trim());
  return names.map((name) => {
    const doc = ctx.store.resolveDoc(name);
    const cur = doc ? undefined : ctx.store.current(name);
    const hit = doc ?? cur;
    return hit ? { name, resolved: true, path: hit.path, sha: hit.sha ?? '' } : { name, resolved: false };
  });
}

/** The DRILL'S LINKS: what this event points at, and the command that shows it. A link
 *  that cannot be followed is still listed (the missing ref IS the finding). */
function eventLinks(ctx: CliContext, id: string, e: JourneyEvent): Array<{ kind: string; what: string; detail: string; command: string }> {
  const links: Array<{ kind: string; what: string; detail: string; command: string }> = [];
  const results = ctx.commands.results(id);
  const rowOf = (match: (r: ResultItem) => boolean): number | undefined => {
    const i = results.findIndex(match);
    return i < 0 ? undefined : i + 1;
  };
  const drill = (n: number | undefined): string => (n === undefined ? `ann results ${id}` : `ann results ${id} ${n}`);

  for (const c of Array.isArray(e.commits) ? e.commits : []) {
    const sha = String((c as { sha?: unknown })?.sha ?? '');
    let exists = false;
    try {
      execFileSync('git', ['cat-file', '-t', sha], { stdio: 'ignore' });
      exists = true;
    } catch {
      exists = false;
    }
    const note = (c as { note?: unknown })?.note;
    links.push({
      kind: 'commit',
      what: sha,
      detail: `${exists ? 'resolves in git' : 'DOES NOT resolve in git'}${typeof note === 'string' && note ? ` — ${note}` : ''}`,
      command: drill(rowOf((r) => r.kind === 'commit' && r.sha === sha)),
    });
  }
  for (const ref of Array.isArray(e.refs) ? e.refs : []) {
    const p = String(ref);
    const full = join(ctx.root, p);
    let detail = 'MISSING';
    if (existsSync(full)) {
      const st = statSync(full);
      detail = st.isDirectory() ? 'directory' : `${readFileSync(full, 'utf8').split('\n').length} lines`;
    }
    links.push({ kind: 'ref', what: p, detail, command: drill(rowOf((r) => r.kind === 'ref' && r.path === p)) });
  }
  const artifact = (e.artifact ?? undefined) as { name?: unknown; path?: unknown } | undefined;
  if (artifact?.name) {
    const name = String(artifact.name);
    const cur = ctx.store.current(name);
    links.push({
      kind: 'artifact',
      what: name,
      detail: cur ? `${cur.sha || '(no sha)'}${cur.sha === '' ? '' : ' '}— ${cur.path}` : `no current artifact for '${name}' (recorded: ${String(artifact.path ?? '(no path)')})`,
      command: `ann read ${name}`,
    });
  }
  if (typeof e.gate === 'string') {
    const state = e.type === 'confirmed' ? 'confirmed' : e.type === 'rejected' ? 'rejected' : 'submitted (undecided)';
    links.push({ kind: 'gate', what: `${e.gate} — ${state}`, detail: 'the gate card (contract · gate states · results)', command: `ann confirm ${id}` });
  }
  for (const [field, kind] of [['successor', 'node'], ['target', 'node']] as const) {
    const v = (e as Record<string, unknown>)[field];
    const target = typeof v === 'string' ? v : typeof v === 'object' && v !== null ? String((v as { id?: unknown }).id ?? '') : '';
    if (target && ctx.store.ids().includes(target)) {
      links.push({ kind, what: target, detail: `${ctx.store.status(target)} — this event points at it`, command: `ann journey ${target}` });
    }
  }
  links.push({ kind: 'node', what: id, detail: 'the whole node: contract · inputs · gates · the full event walk', command: `ann journey ${id}` });
  return links;
}

const commandRows = (): CommandRow[] => COMMANDS.map((c) => ({ name: c.name, args: c.args, desc: c.desc, json: true }));

const usageDoc = (): UsageDoc => ({
  doc: HELP_DOC,
  naming: HELP_NAMING,
  env: HELP_ENV,
  commands: commandRows(),
  footer: HELP_FOOTER,
});

/* ── HANDLERS — canonical command → (ctx) => Outcome ────────────────────────── */

export type Handler = (ctx: CliContext) => Outcome | Promise<Outcome>;

export const HANDLERS: Record<string, Handler> = {
  /* bare ann + help + commands — the doc forms */
  help: () => ({ ok: true, value: usageDoc() }),
  commands: () => ({ ok: true, value: commandRows() }),

  /* status — the derived status tree */
  status: (ctx) => {
    const filter = ctx.args.slice(1).find((a) => !a.startsWith('--'));
    return { ok: true, value: ctx.commands.statuses(filter) };
  },

  /* journey (no id) / journeyOne (with id) */
  journey: (ctx) => {
    const legs = ctx.store
      .ids()
      .filter((i) => !i.includes('/'))
      .sort();
    const rows = legs.map((l) => ({
      id: l,
      status: ctx.store.status(l),
      superseded: hasSuperseded(ctx, l),
      tasks: ctx.store
        .tasksOf(l)
        .map((t) => ({ id: t, status: ctx.store.status(t), superseded: hasSuperseded(ctx, t) })),
    }));
    const lb = ctx.commands.lookBack();
    const ahead = {
      activeLeg: lb.activeLeg,
      activeLegStatus: lb.activeLegStatus,
      frontmostReady: lb.frontmostReady ? { task: lb.frontmostReady.task, status: lb.frontmostReady.status } : undefined,
      alsoReady: lb.alsoReady.map((a) => ({ task: a.task, status: a.status })),
      legGate: lb.legGate,
      // the outstanding deferred work rides the journey view (leg 12 task 01) — the
      // same derivation `next` reads, never a second one
      deferred: lb.deferred,
    };
    return { ok: true, value: { legs: rows, ahead } };
  },
  journeyOne: (ctx) => {
    const id = resolveId(ctx, ctx.args[1]);
    return { ok: true, value: nodeCard(ctx, id) };
  },

  /* events — the EVENT LIST + the ONE-EVENT DRILL (the shared drill every node view
   *  links to). The list carries the SAME numbering `journey <id>` prints (1..N in LOG
   *  order), so a number is a stable handle: `ann events <id> 4` is the 4th event of
   *  that walk. The drill returns the RAW record plus LINKS — per-commit, per-ref, per-
   *  artifact, per-gate — each naming the follow-up command that shows more (the results
   *  drill, the confirm card, the node walk). Value-canonical like every read; the
   *  fs/git probing of a link's existence is the SAME shape `results`' drill uses. */
  events: (ctx) => {
    const id = resolveId(ctx, ctx.args[1]);
    const events = ctx.store.events(id);
    const kind = id.includes('/') ? 'TASK' : 'LEG';
    const list = events.map((e, i) => eventRow(i + 1, e as unknown as Record<string, unknown>));
    const index = ctx.args[2];
    if (index === undefined) return { ok: true, value: { id, kind, events: list } };
    const n = Number(index);
    const event = Number.isInteger(n) ? events[n - 1] : undefined;
    if (!event) return boom('events', `events: no event ${index} on ${id} (1..${events.length})`);
    return { ok: true, value: { id, kind, n, total: events.length, event, links: eventLinks(ctx, id, event) } };
  },

  /* branch — a node + every descendant's events */
  branch: (ctx) => {
    const rootId = resolveId(ctx, ctx.args[1] || '');
    const ids = ctx.store
      .ids()
      .filter((i) => i.startsWith(rootId))
      .sort((a, b) => (a + '/events.jsonl').localeCompare(b + '/events.jsonl'));
    return { ok: true, value: ids.map((id) => ({ id, status: display(ctx, id), events: ctx.store.events(id) })) };
  },

  /* check — problems/warnings/notes/docs/state; exit 1 on any error (DIAG → stderr) */
  check: (ctx) => {
    const problems = ctx.store.check();
    const warns: string[] = [];
    for (const f of runValidators(ctx.store)) {
      const line = `[${f.severity}] ${f.code}${f.nodeId ? ` ${f.nodeId}` : ''} — ${f.detail}`;
      if (f.severity === 'error') problems.push(line);
      else warns.push(line);
    }
    const notes: Array<{ sev: 'error' | 'warn' | 'info'; msg: string }> = [];
    const dh = targetDocsHome(ctx);
    const manifest = dh ? loadDocsManifest(dh) : {};
    const docCount = Object.keys(manifest).length;
    if (dh) {
      const { fresh, missing, stale } = docsIndexFresh(dh);
      if (!fresh) {
        const parts = [...missing.map((n) => `'${n}' not in the manifest`), ...stale.map((n) => `'${n}' has no matching file in docs/`)];
        notes.push({ sev: 'error', msg: `docs manifest out of sync with docs/: ${parts.join(' · ')} — run 'ann docs --write' and commit` });
      }
    }
    const errors = problems.length + notes.filter((n) => n.sev === 'error').length;
    const legs = ctx.store
      .ids()
      .filter((i) => !i.includes('/'))
      .sort();
    const states = legs.map((l) => `${l} ${ctx.store.status(l)}`).join(' · ');
    const active =
      legs.find((l) => ctx.store.status(l) === 'active') ??
      (legs.length && !ctx.store.status(legs[legs.length - 1]).startsWith('done') ? legs[legs.length - 1] : undefined);
    let state = `State: ${states}`;
    if (active) {
      const tasks = ctx.store.tasksOf(active);
      const doneN = tasks.filter((t) => ctx.store.status(t).startsWith('done')).length;
      const ready = tasks.filter((t) => ['queued', 'active'].includes(ctx.store.status(t)));
      state += ` · ${active} in progress (${doneN}/${tasks.length} tasks done)`;
      if (ready.length) state += ` — frontmost-ready: ${ready[0]} (${ctx.store.status(ready[0])})`;
    }
    return { ok: true, value: { problems, warnings: warns, notes, docs: docCount, state }, ...(errors === 0 ? {} : { exitCode: 1 }) };
  },

  /* verify — the drift read; exit 1 on any drift (DIAG → stderr) */
  verify: (ctx) => {
    const drifts = ctx.commands.verify();
    return { ok: true, value: { drifts, count: drifts.length }, ...(drifts.length === 0 ? {} : { exitCode: 1 }) };
  },

  ledger: (ctx) => ({ ok: true, value: ctx.commands.ledger() }),

  /* specs — archived (the legacy current-artifact set) vs project (the docs contract stack) */
  specs: (ctx) => {
    if (targetDocsHome(ctx) === undefined) return { ok: true, value: ctx.store.currentDocs() };
    const dh = targetDocsHome(ctx)!;
    const manifest = loadDocsManifest(dh);
    const stack: Array<{ name: string; sha: string; path: string; upstream?: string; referrers?: string }> = [];
    for (const name of Object.keys(manifest).sort()) {
      const rel = manifest[name];
      const full = join(dh, rel);
      if (!existsSync(full)) {
        stack.push({ name, sha: '(file missing)', path: rel });
        continue;
      }
      let upstream = '',
        referrers = '';
      try {
        const head = readFileSync(full, 'utf8')
          .split('\n')
          .slice(0, 10);
        for (const line of head) {
          const u = line.match(/\*\*upstream\*\* \(this doc relies on\): (.*)/);
          if (u) upstream = u[1];
          const r = line.match(/\*\*referrers\*\* \(must cite this when they change\): (.*)/);
          if (r) referrers = r[1];
        }
      } catch {}
      stack.push({ name, sha: docSha(readFileSync(full, 'utf8')), path: rel, ...(upstream ? { upstream } : {}), ...(referrers ? { referrers } : {}) });
    }
    return { ok: true, value: stack };
  },

  providers: (ctx) => {
    let reg: ReturnType<typeof loadProviderRegistry>;
    try {
      reg = loadProviderRegistry(ctx.root);
    } catch (e) {
      return boom('providers', (e as Error).message);
    }
    return {
      ok: true,
      value: {
        defaultProvider: reg.defaultProvider,
        defaults: reg.defaults,
        providers: reg.providers.map((p) => {
          const base = resolveSetting(p.baseUrl, 'baseUrl');
          const baseEnv = p.baseUrl.startsWith('env:') ? p.baseUrl.slice(4).split('||')[0].trim() : undefined;
          const baseFromEnv = baseEnv ? !!process.env[baseEnv] : false;
          const baseFromConfig = !baseFromEnv && !!loadConfig().baseUrl;
          const key = p.apiKey ? resolveSecret(p.apiKey) : { source: 'none' as const };
          const model = resolveSetting(p.defaultModel, 'model');
          const modelEnv = p.defaultModel.startsWith('env:') ? p.defaultModel.slice(4).split('||')[0].trim() : undefined;
          const modelFromEnv = modelEnv ? !!process.env[modelEnv] : false;
          const modelFromConfig = !modelFromEnv && !!loadConfig().model;
          return {
            id: p.id,
            kind: p.kind,
            protocol: p.protocol,
            baseUrl: base ?? null,
            baseUrlSource: baseFromEnv ? 'env' : baseFromConfig ? 'config' : baseEnv ? 'fallback' : 'unresolved',
            apiKey: key.source === 'none' ? (p.apiKey ? 'unset' : 'none') : key.source,
            defaultModel: model ?? null,
            defaultModelSource: modelFromEnv ? 'env' : modelFromConfig ? 'config' : modelEnv ? 'fallback' : 'unresolved',
          };
        }),
      },
    };
  },

  config: (ctx) => {
    const resolution = resolveConfig(ctx.root);
    return { ok: true, value: { file: configPath(), user: maskedConfig(), ...resolution } };
  },

  'config!': (ctx) => {
    const key = ctx.args[2];
    const value = ctx.args[3];
    if (!CONFIG_KEYS.includes(key) || value === undefined || value === '') {
      return usage(`usage: ann config! set <key> <value>  (keys: ${CONFIG_KEYS.join(' · ')})`);
    }
    if (key.includes('.')) {
      const [group, leaf] = key.split('.');
      const cfg = loadConfig() as Record<string, unknown>;
      const existing = (cfg[group] as Record<string, unknown> | undefined) ?? {};
      const v: unknown = NUMERIC_CONFIG_LEAVES.has(leaf) ? Number(value) : value;
      if (NUMERIC_CONFIG_LEAVES.has(leaf) && !Number.isInteger(v)) return boom('config-value', `config!: ${key} must be an integer`);
      setConfig(group as 'flow' | 'preferences' | 'server', { ...existing, [leaf]: v } as never);
      const after = resolveConfig(ctx.root).problems.filter((p) => p.startsWith(`config ${key}`));
      return { ok: true, value: { ok: true, value: { key, file: configPath(), leaf, value: v, problems: after } } };
    }
    let v: string | number = value;
    if (key === 'maxTokens') {
      const n = Number(value);
      if (Number.isNaN(n)) return boom('config-value', 'config!: maxTokens must be a number');
      v = n;
    }
    setConfig(key as 'provider' | 'model' | 'baseUrl' | 'apiKey' | 'maxTokens', v);
    return {
      ok: true,
      value: { ok: true, value: { key, file: configPath(), ...(key === 'apiKey' ? { masked: true } : { value: v }) } },
    };
  },

  project: (ctx) => {
    const cur = getCurrentProject();
    return {
      ok: true,
      value: {
        current: cur ?? null,
        currentStale: !!cur && !isProjectRoot(cur),
        cwd: ctx.root,
        projects: listProjects().map((p) => ({ path: p, stale: !isProjectRoot(p) })),
      },
    };
  },

  'project!': (ctx) => {
    const op = ctx.args[1];
    const path = ctx.args[2];
    if (op === 'add') {
      if (!path) return usage('usage: ann project! add <path>');
      const abs = resolve(path);
      if (!isProjectRoot(abs)) return boom('project-add', `project! add: ${abs} has no .ann/ — not an ann project (or init it first)`);
      setProject(abs);
      return { ok: true, value: { ok: true, value: { op: 'add', path: abs } } };
    }
    if (op === 'use') {
      if (!path) return usage('usage: ann project! use <path>');
      const abs = resolve(path);
      useProject(abs);
      return { ok: true, value: { ok: true, value: { op: 'use', path: abs } } };
    }
    if (op === 'remove') {
      if (!path) return usage('usage: ann project! remove <path>');
      removeProject(resolve(path));
      return { ok: true, value: { ok: true, value: { op: 'remove', path: resolve(path) } } };
    }
    return usage('usage: ann project! add|use|remove <path>');
  },

  'cred!': (ctx) => {
    const op = ctx.args[1];
    const service = ctx.args[2];
    const account = ctx.args[3];
    const secret = ctx.args[4];
    if ((op !== 'set' && op !== 'delete') || !service || !account) {
      return usage('usage: ann cred! set|delete <service> <account> [secret]\n  secret: pass as arg OR pipe via stdin (echo -n "..." | ann cred! set ...) — stdin never hits argv/ps');
    }
    if (op === 'set') {
      let value = secret;
      if (value === undefined) value = readFileSync(0, 'utf8').trim();
      if (!value) return boom('cred-empty', 'cred!: empty secret — pass as arg or pipe via stdin');
      addKeychainSecret(service, account, value);
      return { ok: true, value: { ok: true, value: { op: 'set', service, account } } };
    }
    deleteKeychainSecret(service, account);
    return { ok: true, value: { ok: true, value: { op: 'delete', service, account } } };
  },

  packet: (ctx) => ({ ok: true, value: assemblePacket(ctx.store, resolveId(ctx, ctx.args[1])) }),

  validate: (ctx) => {
    const id = ctx.args[1];
    const nodeId = id ? resolveId(ctx, id) : undefined;
    return { ok: true, value: runValidators(ctx.store, nodeId) };
  },

  rules: (ctx) => {
    const reg = derivedRegistry();
    if (ctx.args[1] === '--write') {
      const out = JSON.stringify(reg, null, 2) + '\n';
      const p = join(ctx.root, 'rules', 'check', 'rules.json');
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, out);
      return { ok: true, value: { ok: true, value: { path: p, rules: reg.rules.length } } };
    }
    return { ok: true, value: reg };
  },

  docs: (ctx) => {
    const dh = targetDocsHome(ctx);
    if (dh === undefined) {
      const msg =
        'ann: docs refused — ANN_STORE points at an archived journey (no docs/ home; an archived session has no manifest to index). Reads work via the legacy current-artifact path (`ann read <name>` / `ann <name>`).';
      return boom('docs-home', msg);
    }
    const manifest = loadDocsManifest(dh);
    const { fresh, missing, stale } = docsIndexFresh(dh);
    if (ctx.args[1] === '--write') {
      const regen = scanDocsDir(dh);
      const p = writeDocsManifest(dh, regen);
      return { ok: true, value: { ok: true, value: { path: p, docs: Object.keys(regen).length } } };
    }
    const docs = Object.keys(manifest)
      .sort()
      .map((n) => {
        const rel = manifest[n];
        const full = join(dh, rel);
        return { name: n, path: rel, sha: existsSync(full) ? docSha(readFileSync(full, 'utf8')) : '(file missing)' };
      });
    return { ok: true, value: { fresh, missing, stale, docs } };
  },

  sessions: (ctx) => {
    const sessionsDir = join(ctx.root, '.ann', 'archive', 'sessions');
    const rows: Array<Record<string, string | number>> = [];
    if (existsSync(sessionsDir)) {
      for (const d of readdirSync(sessionsDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const p = join(sessionsDir, d.name);
        try {
          const st = new Store(p, { readOnly: true }); // the session dir has journey/legs → journey-kind
          const legs = st
            .ids()
            .filter((i) => !i.includes('/'))
            .sort();
          const goal = legs[0];
          const status = goal ? st.status(goal) : '-';
          const met = goal ? st.events(goal).some((e) => e.type === 'goal-met') : false;
          rows.push({ session: d.name, store: p, goal: goal ?? '(none)', status, verdict: met ? 'met' : status === 'done' ? 'done (unconfirmed)' : status, legs: legs.length });
        } catch {
          rows.push({ session: d.name, store: p, goal: '(unreadable store)', status: '-', verdict: '-', legs: 0 });
        }
      }
    }
    return { ok: true, value: { sessionsDir, sessions: rows } };
  },

  chain: (ctx) => {
    const project = loadProjectFlow(ctx.root);
    const chains: Record<string, unknown> = {};
    if (project) {
      for (const [workType, chain] of Object.entries(project.chains)) {
        chains[workType] = chain.map((e) => ({ id: e.id, ...(e.at ? { at: e.at } : {}), ...(e.when ? { when: e.when } : {}) }));
      }
    }
    // `present` is data the TEXT renderer reads (no-flow-file vs an empty project chain) —
    // the value carries it so text and --json can never disagree.
    return { ok: true, value: { present: !!project, ...(project?.template ? { template: project.template } : {}), chains } };
  },

  steps: (ctx) => ({
    ok: true,
    value: buildStepRegistry()
      .all()
      .map((s) => ({
        id: s.id,
        roles: s.roles.map((r) => ({ name: r.name, required: !!r.required })),
        produces: s.produces ?? [],
        decisions: s.decisions ?? [],
        rules: s.rules.map((r) => r.id),
      })),
  }),

  /* log — the OPERATIONAL LOG read (leg 12/05): the derived tail over the scratch JSONL
   *  action log. A READ: it never writes, never touches the store, and never throws on a
   *  torn line (the log module counts those). */
  log: (ctx) => {
    const take = (args: string[], flag: string) => takeFlag(args, flag);
    const task = take(ctx.args.slice(1), '--task');
    const run = take(task.rest, '--run');
    const level = take(run.rest, '--level');
    const since = take(level.rest, '--since');
    const tail = take(since.rest, '--tail');
    const USAGE =
      'usage: ann log [--task <id>] [--run <runId>] [--level info|warn|error] [--since <iso|30m>] [--tail <n>]';
    const stray = strayFlag(tail.rest);
    if (stray) return usage(`${USAGE} — unknown flag ${stray}`);
    if (level.value !== undefined && !['info', 'warn', 'error'].includes(level.value)) {
      return usage(`${USAGE} — --level must be info|warn|error (got '${level.value}')`);
    }
    if (since.value !== undefined && parseSince(since.value) === undefined) {
      return usage(`${USAGE} — --since must be an ISO instant or a window like 30m|2h|1d (got '${since.value}')`);
    }
    let n: number | undefined;
    if (tail.value !== undefined) {
      n = Number(tail.value);
      if (!Number.isInteger(n) || n < 1) return usage(`${USAGE} — --tail must be a positive integer (got '${tail.value}')`);
    } else {
      n = DEFAULT_TAIL;
    }
    return {
      ok: true,
      value: readOpLog(ctx.root, {
        ...(task.value ? { task: task.value } : {}),
        ...(run.value ? { run: run.value } : {}),
        ...(level.value ? { level: level.value as LogLevel } : {}),
        ...(since.value ? { since: since.value } : {}),
        tail: n,
      }),
    };
  },

  /* next — the FOUR-STATE GOAL CONSULT computed once, carried in the value */
  next: (ctx) => {
    const lb = ctx.commands.lookBack();
    const advance = ctx.commands.advance();
    const goalView = advance.action === 'none' ? ctx.commands.goal() : undefined;
    return {
      ok: true,
      value: {
        lookBack: lb,
        advance,
        ...(goalView?.ok && goalView.value.present ? { goal: goalView.value } : {}),
      },
    };
  },

  goal: (ctx) => viewResult(ctx.commands.goal()),

  /* goal! met/archive — the value-canonical goal writes (seed is the interactive carve-out) */
  'goal!': (ctx) => {
    const op = ctx.args[1];
    const rest = ctx.args.slice(2);
    if (op === 'met') return writeResult(ctx.commands.goalVerdict('met', rest.join(' ').trim()));
    if (op === 'archive') return writeResult(ctx.commands.goalArchive(rest.includes('--override')));
    return usage('usage: ann goal! seed [goal-statement] | ann goal! met [feedback] | ann goal! archive [--override]');
  },

  flow: (ctx) => {
    const node = resolveId(ctx, ctx.args[1]);
    const flow = resolveChain(ctx.store, node, ctx.root);
    const { config, problems: configProblems } = resolveConfig(ctx.root);
    const problems = validateChain(buildStepRegistry(), flow.chain, assemblePacket(ctx.store, node), config);
    const chain = flow.chain.map((e) => {
      const dto: Record<string, unknown> = { id: e.id };
      if (e.inputs) dto.inputs = e.inputs;
      if (e.params) dto.params = e.params;
      if (e.at) dto.at = e.at;
      if (e.verdict) dto.verdict = e.verdict;
      if (e.when) dto.when = e.when;
      return dto;
    });
    return {
      ok: true,
      value: {
        node,
        chain,
        source: flow.source,
        workType: flow.workType ?? null,
        template: flow.template ?? null,
        problem: flow.problem ?? null,
        configProblems,
        chainProblems: problems.map((p) => ({ at: p.at, problem: p.problem })),
        valid: problems.length === 0,
      },
    };
  },

  /* run! — the frame result IS the value; a non-completed stop is a non-zero exit.
   * NOT value-canonical in JSON: it drives an interactive terminal session (materialize
   * → gates → execute → verify → confirm via the human channel) — JSON cannot drive it,
   * so it refuses up-front with a loud error doc (never silent non-JSON stdout). */
  'run!': async (ctx) => {
    if (ctx.json) {
      return boom(
        'run-interactive',
        "run! drives an INTERACTIVE terminal session (the frame's gates) — JSON mode cannot drive it (run it in a terminal, or read state with ann --json goal|journey|next)",
      );
    }
    const taskId = resolveId(ctx, ctx.args[1]);
    const frame = new Frame({
      commands: ctx.commands,
      root: ctx.root,
      registry: buildStepRegistry(),
      abilities: buildAbilities(getAdapter(undefined, ctx.root, ctx.log.runId)),
      log: ctx.log,
    });
    const r = await frame.run(taskId);
    return { ok: true, value: r, ...(r.stop === 'completed' ? {} : { exitCode: 1 }) };
  },

  /* advance! — the OPERATOR ACTION (F5 approve→execute). NOT value-canonical in JSON:
   * it drives an interactive terminal session (the ADVANCE card + the builder's ONE
   * approve, then the frame's gates) — JSON cannot drive it, so it refuses up-front with
   * a loud error doc (AC-6: the approve is a HUMAN decision; the carve-out precedents —
   * run! · goal! seed · spec! — all refuse JSON; an automated product holds the
   * sanctioned writers directly and never needs advance!'s human approve). */
  'advance!': async (ctx) => {
    if (ctx.json) {
      return boom(
        'advance-interactive',
        "advance! is the OPERATOR ACTION (F5 approve→execute) — it drives an INTERACTIVE terminal session (the ADVANCE card + the builder's ONE approve, then the frame's gates); JSON mode cannot drive it (run it in a terminal, or read the derived state with ann --json next|goal|journey)",
      );
    }
    const r = await runOperatorAction({
      commands: ctx.commands,
      root: ctx.root,
      registry: buildStepRegistry(),
      abilities: buildAbilities(getAdapter(undefined, ctx.root, ctx.log.runId)),
      log: ctx.log,
    });
    // the exit mirrors run!: only a COMPLETED continue-leg run exits 0; the refusals and
    // every stopped-short landing exit 1, declined/boundary (designed stops) exit 0.
    const exitCode = advanceExit(r.stop, r.frame?.stop === 'completed');
    return { ok: true, value: r, ...(exitCode === 0 ? {} : { exitCode }) };
  },

  read: (ctx) => viewResult(ctx.commands.read(ctx.args[1] || '')),

  /* serve — the MINIMAL SERVICE + UI vertical (the goal's AC-1): an HTTP binding over
   * THIS command layer (L3, architecture rung 3) — the same L1 reads and the same gate
   * write, answering the SAME value-canonical JSON `--json` prints (surface/service.ts
   * reuses jsonDoc/resolveDispatch/the handlers, never a second derivation).
   *
   * It is NOT a store write and NOT a read value: it starts a LONG-RUNNING server and
   * returns its STARTUP DESCRIPTOR (host · port · url · journey) — the process then
   * stays alive on the listening socket until Ctrl-C. JSON refuses up-front, like
   * run!/advance!: a daemon has no one-document answer (a `--json serve` would print a
   * doc and then hang the caller's pipeline). The module is loaded LAZILY so the
   * surface module graph stays acyclic (handlers ← service, never both). */
  serve: async (ctx) => {
    const { startService } = await import('./service.js');
    if (ctx.json) {
      return boom(
        'serve-daemon',
        'serve starts a LONG-RUNNING HTTP service (the minimal service + UI vertical) — JSON mode cannot represent a daemon (start it in a terminal: ann serve; read state with ann --json next|journey)',
      );
    }
    const hostFlag = takeFlag(ctx.args.slice(1), '--host');
    const portFlag = takeFlag(hostFlag.rest, '--port');
    const stray = strayFlag(portFlag.rest);
    if (stray) return usage(`usage: ann serve [--host <host>] [--port <port>] — unknown flag ${stray}`);
    // The bind comes from the GENERAL CONFIG CLASS (the one place the precedence is
    // written down): --host/--port (this invocation) > env ANN_HOST/ANN_PORT > the user
    // overlay > the project registry > the builtin literal. A config problem on a
    // server.* leaf FAILS CLOSED (a bad bind setting is never silently ignored).
    const cfg = resolveConfig(ctx.root);
    const badBind = cfg.problems.find((p) => p.startsWith('config server.'));
    if (badBind) return boom('serve-config', `serve refuses: ${badBind}`);
    const host = hostFlag.value ?? cfg.config.server.host;
    const portRaw = portFlag.value ?? String(cfg.config.server.port);
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      return usage(`ann serve: --port/ANN_PORT must be an integer 0..65535 (0 = the OS picks a free port), got '${portRaw}'`);
    }
    let handle: Awaited<ReturnType<typeof startService>>;
    try {
      handle = await startService({ root: ctx.root, host, port, log: ctx.log.child({ actor: 'server' }) });
    } catch (e) {
      return boom('serve-bind', `serve could not bind ${host}:${port} — ${(e as Error).message}`);
    }
    return { ok: true, value: { host: handle.host, port: handle.port, url: handle.url, journey: ctx.root } };
  },

  /* confirm / detail / results — detail-derived cards + results */
  confirm: (ctx) => {
    const id = resolveId(ctx, ctx.args[1]);
    return { ok: true, value: { detail: nodeCard(ctx, id), results: ctx.store.results(id) } };
  },
  detail: (ctx) => {
    const id = resolveId(ctx, ctx.args[1]);
    return { ok: true, value: nodeCard(ctx, id) };
  },
  results: (ctx) => {
    const id = resolveId(ctx, ctx.args[1]);
    const index = ctx.args[2];
    const items = ctx.commands.results(id);
    if (!ctx.store.contract(id)) return boom('results', `results: no node ${id}`);
    const kind = id.includes('/') ? 'TASK' : 'LEG';
    if (index === undefined) {
      // THE RESULTS-LISTING FIX: the value carries the SAME rows text shows ({id, kind,
      // items}) — previously JSON emitted only the bare items array, dropping the header.
      return { ok: true, value: { id, kind, items } };
    }
    const n = Number(index);
    const it = items[n - 1];
    if (!it) return boom('results', `results: no item ${index} (1..${items.length})`);
    const body: Record<string, unknown> = { item: it };
    switch (it.kind) {
      case 'commit': {
        try {
          body.sha = execSync(`git show -s --format='%H%n%an <%ae> %ad%n%n%s%n%n%b' ${it.sha}`, { encoding: 'utf8' }).trim();
          body.stat = execSync(`git show --stat --format= ${it.sha}`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
            .trim()
            .slice(0, 2000);
        } catch {
          body.commitError = `commit ${it.sha} not resolvable in git`;
        }
        break;
      }
      case 'ref': {
        const full = join(ctx.root, it.path!);
        if (!existsSync(full)) {
          body.refError = `ref missing: ${it.path}`;
          break;
        }
        const st = statSync(full);
        if (st.isDirectory()) {
          body.dir = `${it.path}/`;
          body.entries = readdirSync(full).slice(0, 30);
        } else {
          body.file = it.path;
          body.head = readFileSync(full, 'utf8')
            .split('\n')
            .slice(0, 60);
        }
        break;
      }
      case 'evidence': {
        const ev = ctx.store.events(id).find((e) => e.type === 'evidence' && e.note === it.note);
        body.event = ev ?? { note: it.note };
        break;
      }
      case 'link':
        body.url = it.url;
        break;
    }
    return { ok: true, value: body };
  },

  /* the gate writes */
  'append!': (ctx) => {
    const raw = ctx.args.slice(2).join(' ');
    if (!ctx.args[1] || !raw) return usage('usage: ann append! <id> \'{"at":..,"type":..}\'');
    return writeResult(ctx.commands.append(ctx.args[1], JSON.parse(raw)));
  },
  'spawn!': (ctx) => {
    const raw = ctx.args.slice(2).join(' ');
    if (!ctx.args[1] || !raw) return usage('usage: ann spawn! <id> \'<contract-json>\'');
    let contract: unknown;
    try {
      contract = JSON.parse(raw);
    } catch (e) {
      return boom('spawn-bad-json', `spawn rejected: bad contract JSON (${(e as Error).message})`);
    }
    return writeResult(ctx.commands.spawn(ctx.args[1], contract));
  },
  'submit!': (ctx) => {
    if (!getVOCAB().gates.includes(ctx.args[2])) return usage('usage: ann submit! <id> grill|confirm [confirmedSha]');
    return writeResult(ctx.commands.submit(ctx.args[1], ctx.args[2], ctx.args[3] ? { confirmedSha: ctx.args[3] } : {}));
  },
  'gate!': (ctx) => {
    if (!getVOCAB().gates.includes(ctx.args[2]) || !['accept', 'reject'].includes(ctx.args[3] ?? '')) {
      return usage('usage: ann gate! <id> grill|confirm accept|reject [feedback]');
    }
    return writeResult(ctx.commands.gate(ctx.args[1], ctx.args[2], ctx.args[3], ctx.args.slice(4).join(' ')));
  },
  'evidence!': (ctx) => {
    const refs = takeFlag(ctx.args.slice(1), '--refs');
    const note = takeFlag(refs.rest, '--note');
    const claims = takeFlag(note.rest, '--claims');
    const checks = takeFlag(claims.rest, '--checks');
    const stray = strayFlag(checks.rest);
    if (stray) return usage(`usage: ann evidence! <id> <sha>[,<sha>…] [--refs a.md,b.md] [--note '<text>'] [--claims '<json>'] [--checks '<json>'] — unknown flag ${stray}`);
    const [id, ...shaGroups] = checks.rest;
    const shas = shaGroups
      .flatMap((g) => g.split(','))
      .map((s) => s.trim())
      .filter(Boolean);
    if (!id || !shas.length) {
      return usage("usage: ann evidence! <id> <sha>[,<sha>…] [--refs a.md,b.md] [--note '<text>'] [--claims '<json>'] [--checks '<json>']");
    }
    const refPaths = refs.value
      ? refs.value
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
      : undefined;
    // v18 §3 — the structured conclusion. A bad argument FAILS CLOSED here (named) and
    // writes nothing; the field SHAPES are the single writer's business (the store).
    const jsonList = (raw: string | undefined, flag: string): unknown[] | undefined => {
      if (raw === undefined) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return boom('evidence-json', `evidence! ${flag} must be a JSON array — ${(e as Error).message}`);
      }
      if (!Array.isArray(parsed)) return boom('evidence-json', `evidence! ${flag} must be a JSON ARRAY of objects`);
      return parsed;
    };
    const claimRows = jsonList(claims.value, '--claims');
    const checkRows = jsonList(checks.value, '--checks');
    return writeResult(
      ctx.commands.evidence(id, shas.map((sha) => ({ sha })), {
        ...(refPaths ? { refs: refPaths } : {}),
        ...(note.value ? { note: note.value } : {}),
        ...(claimRows ? { claims: claimRows } : {}),
        ...(checkRows ? { checks: checkRows } : {}),
      }),
    );
  },
  'capture!': (ctx) => {
    const note = takeFlag(ctx.args.slice(1), '--note');
    const stray = strayFlag(note.rest);
    if (stray) return usage(`usage: ann capture! <id> '<command>' [--note '<text>'] — unknown flag ${stray}`);
    const [id, command] = note.rest;
    if (!id || !command) return usage(`usage: ann capture! <id> '<command>' [--note '<text>'] — the command is one of the ALLOWLIST: ${ALLOWLIST_NAMES.join(' · ')}`);
    return writeResult(ctx.commands.capture(id, command, { ...(note.value ? { note: note.value } : {}) }));
  },
  'complete!': (ctx) => {
    const note = takeFlag(ctx.args.slice(1), '--note');
    const stray = strayFlag(note.rest);
    if (stray) return usage(`usage: ann complete! <id> [--note '<text>'] — unknown flag ${stray}`);
    const id = note.rest[0];
    if (!id) return usage("usage: ann complete! <id> [--note '<text>']");
    return writeResult(ctx.commands.complete(id, { ...(note.value ? { note: note.value } : {}) }));
  },
};

/** Resolve the handler + render key for a canonical command — SHARED by runMain and
 *  the parity test, so the in-process path always mirrors the binary's dispatch. A
 *  `handler` of undefined means the command falls to the bare-name path map. */
export function resolveDispatch(ctx: CliContext, canonical: string): { handler?: Handler; renderKey: string } {
  if (canonical === 'journey' && ctx.args[1] !== undefined) {
    // journey-with-id is a DIFFERENT command (journeyOne) than the no-id look-back
    return { handler: HANDLERS.journeyOne, renderKey: 'journeyOne' };
  }
  return { handler: HANDLERS[canonical], renderKey: canonical === 'run!' ? 'run' : canonical === 'advance!' ? 'advance' : canonical };
}

/** advance!'s exit-code mapping (the handler keeps the Outcome value-shaped). */
function advanceExit(stop: OperatorStop, runCompleted: boolean): number {
  if (stop === 'refused-integrity' || stop === 'stale-proposal') return 1; // fail-closed refusals
  if (stop === 'advanced') return runCompleted ? 0 : 1; // mirror run!: a stopped-short run exits 1
  return 0; // declined / boundary — designed stops, nothing executed
}

/** The bare-name read: a DOC (via the manifest) or a current artifact's logical name. */
export function bareNameHandler(ctx: CliContext): Outcome {
  const name = ctx.args[0];
  const doc = ctx.store.resolveDoc(name);
  const cur = doc ? undefined : ctx.store.current(name);
  if (doc) return { ok: true, value: { name, kind: 'doc', path: doc.path, sha: doc.sha } };
  if (cur) {
    return {
      ok: true,
      value: { name, kind: 'artifact', path: cur.path, ...(cur.sha ? { sha: cur.sha } : {}), ...(cur.producer ? { producer: cur.producer } : {}) },
    };
  }
  return boom('no-doc', `ann: no doc/artifact for '${name}' (a docs manifest name or a current artifact's logical name)`);
}

/** A `--flag <value>` reader for the gesture commands (evidence!/complete! are the only
 *  flag-carrying writes): returns the flag's value (undefined when absent) and the args
 *  with the flag + its value removed. `--note 'a b'` must be ONE argv element; `--refs
 *  a.md,b.md` is comma-separated. */
function takeFlag(args: string[], flag: string): { value?: string; rest: string[] } {
  const i = args.indexOf(flag);
  if (i < 0) return { rest: args };
  return { value: args[i + 1], rest: [...args.slice(0, i), ...args.slice(i + 2)] };
}

/** The first `--`-prefixed token left over after the KNOWN flags are taken — an unknown
 *  flag must FAIL CLOSED (a named usage error), never land as a sha/note value: a typo
 *  (`--bogus xx`) would otherwise write junk commits into a conclusion record. */
function strayFlag(rest: string[]): string | undefined {
  return rest.find((a) => a.startsWith('--'));
}

/* ── the interactive carve-out: goal! seed (NOT value-canonical — it drives a
 *  terminal grilling session; JSON refuses up-front). ───────────────────────── */
async function goalSeedInteractive(ctx: CliContext): Promise<Outcome> {
  if (ctx.json) {
    return boom(
      'goal-seed-interactive',
      'goal! seed is an INTERACTIVE grilling session — it needs a terminal; JSON mode cannot drive it (run it in a terminal, or read the goal session: ann --json goal|journey|next)',
    );
  }
  const idea = ctx.args.slice(2).join(' ').trim();
  const gate = ctx.commands.goalSeedGate();
  if (!gate.allow) return boom('goal-seed-gate', `not-empty: ${gate.blocker ?? GOAL_SEED_GUARD}`);
  const r = await runGoalSeed(ctx.commands, buildAbilities(getAdapter(undefined, ctx.root, ctx.log.runId)), { idea });
  if (!r.ok) {
    // emit() prints the error once (stderr in text, the error doc in JSON) — never twice
    return { ok: false, error: { code: r.error.code, message: r.error.blocker, text: `${r.error.code}: ${r.error.blocker}` }, exitCode: 1 };
  }
  if (!r.seeded) {
    console.log(`goal! seed: NOT seeded — ${r.note}`);
    return { ok: true, value: { seeded: false, note: r.note } };
  }
  console.log(`goal! seed: goal seeded → ${r.goalId} (${r.contract.intent})`);
  console.log(`  contract: ${r.contract.acceptanceCriteria.length} success criteria`);
  console.log(`  goal.md written to ${r.docPath} @ ${r.sha} — commit to publish`);
  console.log('  verdict: unconfirmed — reach structural exhaustion, then record it: goal! met');
  return { ok: true, value: { seeded: true, goalId: r.goalId } };
}

/* spec! — the SPECS interactive carve-out (PRODUCE/AMEND). NOT value-canonical: it
 * drives the interactive SPECS grilling session in a terminal; JSON refuses up-front
 * (before any provider/goal read — a JSON doc would only ever catch an early failure). */
async function specInteractive(ctx: CliContext): Promise<Outcome> {
  if (ctx.json) {
    return boom(
      'spec-interactive',
      'spec! is an INTERACTIVE grilling session (a SPECS produce/amend terminal session) — JSON mode cannot drive it (run it in a terminal, or read the spec doc: ann --json read <name>|docs)',
    );
  }
  const rest = ctx.args.slice(1);
  const amend = rest.includes('--amend');
  const positional = rest.filter((a) => a !== '--amend');
  if (positional.length > 1) {
    return usage("usage: ann spec! [docName] [--amend]\n\nGrill the seeded goal at REQUIREMENTS/SYSTEM-DESIGN level into one amendable spec doc docs/<docName>.md.\n  docName   the spec doc name (default 'requirements') — PRODUCE needs a NEW name\n  --amend   REWRITE an EXISTING in-force spec doc in place (specs are LIVING, amendable)\nSpecs land on the human's GO; commit the docs/<docName>.md it writes to publish.");
  }
  const mode: 'produce' | 'amend' = amend ? 'amend' : 'produce';
  const name = positional[0] ?? DEFAULT_SPEC_NAME;
  const r = await runSpecSession(docsSpecsTarget(ctx.root), buildAbilities(getAdapter(undefined, ctx.root, ctx.log.runId)), { mode, name });
  if (!r.ok) {
    // emit() prints the error once (stderr in text, the error doc in JSON) — never twice
    return { ok: false, error: { code: r.error.code, message: r.error.blocker, text: `${r.error.code}: ${r.error.blocker}` }, exitCode: 1 };
  }
  if (!r.written) {
    console.log(`spec! ${mode} ${name}: NOT ${mode === 'amend' ? 'rewritten' : 'written'} — ${r.note}`);
    return { ok: true, value: { written: false, note: r.note } };
  }
  console.log(`spec! ${mode} ${name}: ${mode === 'amend' ? 'REWRITTEN' : 'written'} → ${r.path} @ ${r.sha} — commit to publish`);
  console.log(`  docs/${name}.md is a LIVING, AMENDABLE spec — revise it later: ann spec! ${name} --amend`);
  return { ok: true, value: { written: true, mode, name, path: r.path, sha: r.sha } };
}

/* ── the alias map (the `--x` command forms — NOT the stripped --project/--json) ── */
const ALIAS: Record<string, string> = {
  '--journey': 'journey',
  '--status': 'status',
  '--check': 'check',
  '--verify': 'verify',
  '--ledger': 'ledger',
  '--log': 'log',
  '--specs': 'specs',
  '--providers': 'providers',
  '--config': 'config',
  '--branch': 'branch',
  '--detail': 'detail',
  '--results': 'results',
  '--packet': 'packet',
  '--validate': 'validate',
  '--rules': 'rules',
  '--docs': 'docs',
  '--sessions': 'sessions',
  '--chain': 'chain',
  '--steps': 'steps',
  '--next': 'next',
  '--goal': 'goal',
  '--flow': 'flow',
  '--read': 'read',
  '--help': 'help',
  '-h': 'help',
  '--commands': 'commands',
};

/** The journey-addressing WRITES a read-only target refuses (config!/cred!/project!
 *  never touch the store, so they stay available). docs/rules --write refuse too. */
const JOURNEY_REFUSED_WRITES = new Set(['append!', 'spawn!', 'submit!', 'gate!', 'evidence!', 'capture!', 'complete!', 'goal!', 'run!', 'spec!', 'advance!']);
/** Bare write names (no `!`) — a named hint, never silent. */
const WRITES = ['append', 'spawn', 'submit', 'gate', 'evidence', 'capture', 'complete', 'cred'];

const isProjectRoot = (dir: string): boolean => existsSync(join(dir, '.ann')) || existsSync(join(dir, 'journey'));

/* ── runMain — flag strip → root resolve → ctx → dispatch → the ONE emit ────── */

export async function runMain(rawArgv: string[] = process.argv.slice(2)): Promise<void> {
  const startedAt = Date.now();
  const args = rawArgv.slice();
  // Global --project <path> / --json — extracted and STRIPPED (per-command parsing
  // never sees them); --project works before OR after the command.
  let projectFlag: string | undefined;
  {
    const flagIdx = args.indexOf('--project');
    if (flagIdx >= 0 && args[flagIdx + 1]) {
      projectFlag = args[flagIdx + 1];
      args.splice(flagIdx, 2);
    }
  }
  let json = false;
  {
    const idx = args.indexOf('--json');
    if (idx >= 0) {
      json = true;
      args.splice(idx, 1);
    }
  }

  const command = args[0];
  const isProjectCmd = command === 'project' || command === 'project!';

  // ── resolve the root BEFORE anything touches the store; chdir so relative reads
  //  (results-ref, docs sha) resolve against the project root ──
  let root: string;
  try {
    root = isProjectCmd ? process.cwd() : resolveProjectRoot(projectFlag);
  } catch (e) {
    emit(outcomeOf(e), json);
    process.exitCode = 1;
    return;
  }
  if (!isProjectCmd) process.chdir(root);

  const ctx = createContext(root, args, { json });
  const canonical = command === undefined ? 'help' : ALIAS[command] ?? command;
  const env = ctx.renderEnv();
  // THE COMMAND-LAYER CHOKEPOINT (AC-2): every invocation's outcome is recorded ONCE,
  // at the single emission point, with the runId this invocation's writes/phases share.
  const cmdlog = {
    log: ctx.log,
    command: command ?? 'help',
    startedAt,
    argv: args.slice(1),
    ...(nodeIdOf(args[1]) ? { taskId: nodeIdOf(args[1]) } : {}),
  };
  const emitCmd = (o: Outcome, renderKey?: string): void => emit(o, json, env, renderKey, cmdlog);

  try {
    // bare ann / help / commands are doc forms (canonical 'help' set above for bare).
    if (canonical === 'help') {
      emitCmd(await HANDLERS.help(ctx), 'help');
      return;
    }
    if (canonical === 'commands') {
      emitCmd(await HANDLERS.commands(ctx), 'commands');
      return;
    }
    // a bare WRITE name refuses with a hint — the `!` is a guarantee, not advice.
    if (WRITES.includes(command)) {
      throw new CommandExit(
        'write-marker',
        `ann: writes are marked with '!' — did you mean '${command}!'? (mutator convention: reads have no marker, writes always end in !)`,
      );
    }
    readOnlyRefuse(ctx, canonical);
    // the interactive carve-outs (never value-canonical): goal! seed + spec! both drive
    // an interactive terminal grilling session — JSON refuses up-front inside each.
    if (canonical === 'goal!' && (args[1] ?? '') === 'seed') {
      const out = await goalSeedInteractive(ctx);
      logCommand(cmdlog, out, json);
      if (!out.ok) throw new CommandExit(out.error.code, out.error.message, { text: out.error.text, exitCode: out.exitCode });
      return;
    }
    if (canonical === 'spec!') {
      const out = await specInteractive(ctx);
      logCommand(cmdlog, out, json);
      if (!out.ok) throw new CommandExit(out.error.code, out.error.message, { text: out.error.text, exitCode: out.exitCode });
      return;
    }
    // Resolve handler + render key through the shared dispatcher (journey-with-id is a
    // DIFFERENT command, journeyOne, than the no-id look-back — both must follow the
    // branch; `run!` renders under `run`). A missing handler falls to the bare-name read.
    const { handler, renderKey } = resolveDispatch(ctx, canonical);
    if (!handler) {
      emitCmd(bareNameHandler(ctx), 'bare');
      return;
    }
    emitCmd(await handler(ctx), renderKey);
  } catch (e) {
    emitCmd(outcomeOf(e));
  }
}

/** The JSON DOCUMENT of an Outcome — the ONE serializer behind `--json` stdout AND the
 *  service's response bodies (surface/service.ts): a read's view value, a write's
 *  `{ok:true,value}`, or the `{error:{code,message}}` failure doc. Both bindings are
 *  byte-identical BY CONSTRUCTION (they call this), never by convention. */
export function jsonDoc(outcome: Outcome): string {
  if (!outcome.ok) return JSON.stringify({ error: { code: outcome.error.code, message: outcome.error.message } }, null, 2) + '\n';
  return JSON.stringify(outcome.value, null, 2) + '\n';
}

/** The command-invocation line's context — the ONE emit that records it. */
interface CommandLogCtx {
  log: OpLog;
  command: string;
  startedAt: number;
  argv: string[];
  taskId?: string;
}

/** The ONE command line — the invocation's outcome, duration and REDACTED argv. Called at
 *  the single emission point AND by the interactive carve-outs (which write their own
 *  stdout), so every invocation is recorded exactly once. */
function logCommand(cmd: CommandLogCtx, outcome: Outcome, json: boolean): void {
  cmd.log.line({
    event: 'command',
    command: cmd.command,
    ...(cmd.taskId ? { taskId: cmd.taskId } : {}),
    inputs: { argv: cmd.argv, json },
    outcome: outcome.ok ? (outcome.exitCode ? `exit-${outcome.exitCode}` : 'ok') : `refused:${outcome.error.code}`,
    level: outcome.ok ? (outcome.exitCode ? 'warn' : 'info') : outcome.error.code === 'error' ? 'error' : 'warn',
    durationMs: Date.now() - cmd.startedAt,
    ...(outcome.ok ? {} : { error: { code: outcome.error.code, message: outcome.error.message } }),
  });
}

/** The single emission point: an Outcome → stderr diagnostics (DIAG) → stdout
 *  (JSON doc, or the RENDER of the SAME value) → the exit code. THE OPERATIONAL LOG's
 *  command chokepoint when `cmd` is given: ONE line per invocation with its outcome
 *  (ok / exit-N / refused:<code>), duration and REDACTED argv — fail-open, never fatal. */
function emit(outcome: Outcome, json: boolean, env?: RenderEnv, renderKey?: string, cmd?: CommandLogCtx): void {
  if (cmd) logCommand(cmd, outcome, json);
  if (!outcome.ok) {
    const text = outcome.error.text ?? outcome.error.message;
    if (json) process.stdout.write(jsonDoc(outcome));
    else console.error(text);
    process.exitCode = outcome.exitCode ?? 1;
    return;
  }
  const e = env ?? ({ args: [], json, root: process.cwd(), kind: 'project' } as RenderEnv);
  const rk = renderKey ?? '';
  if (rk && DIAG[rk]) for (const line of DIAG[rk](outcome.value, e)) console.error(line);
  if (json) {
    process.stdout.write(JSON.stringify(outcome.value, null, 2) + '\n');
  } else {
    let text = '';
    if (rk === 'packet') text = renderPacketById(outcome.value, e);
    else if (rk) text = RENDERS[rk]?.(outcome.value, e) ?? '';
    process.stdout.write(text);
  }
  if (outcome.exitCode !== undefined) process.exitCode = outcome.exitCode;
}

/** Normalize a thrown failure into an error Outcome (CommandExit → its shape; any
 *  other error → the generic `error` doc, text = the message — byte-identical to the
 *  old outer try/catch). Exported for the service binding, which catches the SAME
 *  thrown failures around the SAME handlers (never a second error mapper). */
export function outcomeOf(e: unknown): Outcome {
  if (e instanceof CommandExit) {
    return { ok: false, error: { code: e.code, message: e.message, ...(e.text ? { text: e.text } : {}) }, exitCode: e.exitCode };
  }
  const msg = (e as Error).message;
  return { ok: false, error: { code: 'error', message: msg }, exitCode: 1 };
}

/** The read-only chokepoint — BEFORE dispatch. When ANN_STORE resolves to a NON-ACTIVE
 *  journey, the journey-addressing writes refuse with a named message; config!/cred!/
 *  project! and plain reads never trip here (resolution is deferred to the lazy proxy).
 *  Exported for the service binding: its approve IS the journey write the CLI's
 *  `advance!` performs, so it passes the SAME chokepoint (never a second rule). */
export function readOnlyRefuse(ctx: CliContext, canonical: string): void {
  const isJourneyWrite = JOURNEY_REFUSED_WRITES.has(canonical);
  const isDocsOrRulesWrite = (canonical === 'docs' || canonical === 'rules') && ctx.args.includes('--write');
  if (!isJourneyWrite && !isDocsOrRulesWrite) return;
  const t = ctx.target();
  if (!t.readOnly) return;
  throw new CommandExit(
    'read-only',
    `ann: ${ctx.args[0]} refused: ANN_STORE points at a READ-ONLY journey (${t.loc.kind === 'project' ? join(t.loc.root, '.ann', 'journey') : t.loc.root}) — not the active session. Reads work; unset ANN_STORE to write the active session.`,
  );
}

function resolveProjectRoot(projectFlag: string | undefined): string {
  const explicit = projectFlag ? resolve(projectFlag) : process.env.ANN_PROJECT ? resolve(process.env.ANN_PROJECT) : undefined;
  if (explicit) {
    if (isProjectRoot(explicit)) return explicit;
    throw new CommandExit(
      'not-project',
      `ann: '${explicit}' is not an ann project (no .ann/ or journey/). Run from a project or: ann project! add <path>`,
    );
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
  throw new CommandExit('no-project', 'ann: no project found — run from a project (a dir containing .ann/), or register one: ann project! add <path>');
}
