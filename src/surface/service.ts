import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createContext, resolveDispatch, jsonDoc, outcomeOf, type Outcome } from './handlers.js';
import { APPROVE_BUSY, Approver, whatsNext, type ApproveProposal } from './approve.js';
import { DRIVE_BUSY, driveJourney, type DriveOptions } from './drive.js';
import { newRunId, newTrace, type OpLog } from '../abilities/obs/log.js';
import { UI_HTML } from './ui.js';

/**
 * THE MINIMAL SERVICE (L3, architecture rung 3) — a THIN HTTP BINDING OVER THE COMMAND
 * LAYER, not new machinery. Every response body IS the value-canonical JSON the CLI
 * prints with `--json`: this module dispatches the SAME handlers, through the SAME
 * `createContext`/`resolveDispatch` path the CLI's `runMain` uses, and serializes them
 * with the SAME `jsonDoc` — so there is no second state derivation, no direct store or
 * file access here (the store is reached only through the lazy `ctx.commands`/`ctx.store`
 * of a command context), and no way for the two bindings to drift.
 *
 * SCOPE (the goal's AC-1/AC-4, the ONE thin vertical): the reads `journey · status ·
 * next · detail · confirm · results · packet` — with `results`/`events` carrying their
 * optional DRILL INDEX (`?n=`, the item/event number the CLI addresses) — the whole-journey gate queue (`gates` —
 * the L1 read the UI's WAITING ON YOU view needs, `Commands.pendingGates`), the gate
 * WRITE (`POST /api/gate` → the same L1 `gate!` composite: accept|reject + feedback),
 * the OPERATE LOOP's read + writes (`GET /api/whatsnext` — the WHAT'S NEXT card's
 * operator view — `POST /api/approve` → `runOperatorAction` in-process, leg 11 — and
 * `POST /api/drive` → `runSemanticDriver` in-process, leg 12 task 02: the LLM loop whose
 * proposals are validated against a CLOSED SET and executed through the SAME command
 * layer), and the single UI page at `/`. Nothing else is exposed — `run!`/`spawn!`/
 * `submit!`/`goal!`/`spec!`/`archive`/`advance!` are NOT routes: the approve is ONE named
 * route over the operator action (a specific gesture) and the drive is ONE named route
 * over the semantic driver (which composes `submit!`/`run!` itself, so no route becomes a
 * command runner), and the refusal is a named error doc (`not-exposed`), never a silent
 * pass-through.
 *
 * OUT OF SCOPE, NAMED: auth beyond local, multi-user, packaging/distribution. The
 * server binds 127.0.0.1 by default (the general config's `server.*` builtin — the
 * CALLER resolves the bind; this module has no default of its own) and is REMOTE-CAPABLE
 * IN SHAPE — the request path reads only the URL path + query (relative UI fetches; no
 * host/loopback test, nothing in it assumes localhost), so binding elsewhere or proxying
 * it changes no code path. CREDENTIALS ARE SERVER-SIDE (NFR-SEC-1): the LLM apiKey lives
 * in the process env / user config, is reachable only by the L2/L3 abilities that make
 * provider calls, and is NEVER serialized into a response — no route here reads
 * settings, and the e2e proves a configured key appears in no response body.
 */

/** The canonical reads this slice exposes — the CLI's own command names, dispatched
 *  through the CLI's own handlers (an id-less read is a named usage refusal). */
const READ_ROUTES = new Set(['journey', 'status', 'next', 'detail', 'confirm', 'results', 'packet', 'events', 'log']);
/** The reads addressed by a node id (`?id=<node>`). */
const ID_READS = new Set(['detail', 'confirm', 'packet']);

/** A request body is bounded (untrusted input over a socket): a gate decision carries a
 *  feedback STRING, nothing bigger. */
const MAX_BODY = 64 * 1024;

export interface ServiceOptions {
  /** The project root the service answers for (the journey the CLI would read). */
  root: string;
  /** The resolved bind — the caller (`ann serve`) applies the config precedence
   *  (flags > env > general config > builtin); the service holds no default. */
  host: string;
  port: number;
  /** The OPERATIONAL LOG handle (leg 12/05) — the SERVE BOOT's own trace (the caller
   *  passes the `ann serve` invocation's handle); every HTTP REQUEST then opens its OWN
   *  trace under it (`http-…`), so one request and everything it causes is one chain.
   *  Absent means no operational logging. */
  log?: OpLog;
}

export interface ServiceHandle {
  server: Server;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

/** Start the service and resolve once it is LISTENING (a bind failure rejects with the
 *  OS error — the caller names it, fail-closed, never a half-up server). `port: 0` lets
 *  the OS pick a free port; the handle reports the BOUND one. */
export async function startService(opts: ServiceOptions): Promise<ServiceHandle> {
  const host = opts.host;
  const port = opts.port;
  const root = opts.root;
  // THE SERVICE'S TRACE ROOT (AC-4 + its rework): the daemon boot opens a trace; each
  // REQUEST opens its own (`http-…`) so `ann log --trace <id>` is ONE request and all it
  // caused — the page's read, the gate write, the approve's frame phases, the drive's
  // turns, the provider calls (joined by traceId in logs/provider.jsonl).
  const log = opts.log ?? newTrace(root, { actor: 'server', layer: 'L3', component: 'surface/service' });
  // THE SINGLE-FLIGHT (care b): ONE approve at a time, per service instance. The slot is
  // claimed SYNCHRONOUSLY in the route, before the request's first await (the body read).
  const approver = new Approver(root);
  const server = createServer((req, res) => {
    const started = Date.now();
    // ONE TRACE PER REQUEST: the request's line and everything it causes (the gate write,
    // the approve's frame phases, the driver's turns, the provider calls) is ONE chain.
    const reqLog = log.span({ traceId: newRunId('http'), layer: 'L3', component: 'surface/service' });
    route(root, approver, reqLog, req, res)
      .catch((e: unknown) => {
        // Fail-closed: an unexpected throw is a named error doc, never a stack trace.
        sendJson(res, 500, jsonDoc({ ok: false, error: { code: 'service', message: (e as Error).message } }));
      })
      // ONE line per request — the route, the status and the duration. Never throws.
      .finally(() =>
        reqLog.line({
          event: 'command',
          command: `${req.method ?? 'GET'} ${req.url ?? '/'}`,
          outcome: `http-${res.statusCode}`,
          level: res.statusCode >= 400 ? 'warn' : 'info',
          durationMs: Date.now() - started,
        }),
      );
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error): void => reject(e);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    server,
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Dispatch ONE canonical command through the CLI's own path and normalize a thrown
 *  failure exactly as `runMain` does. The whitelist is the SCOPE BOUNDARY: everything
 *  outside the slice is refused by NAME, before any store access. */
function dispatch(root: string, argv: string[], log?: OpLog): Outcome {
  const canonical = argv[0];
  const ctx = createContext(root, argv, { json: true, ...(log ? { log } : {}) });
  if (canonical === 'gates') {
    // The ONE route that is a direct L1 read rather than a CLI command: the
    // whole-journey gate queue (Commands.pendingGates) — derived on demand, no caching.
    try {
      return { ok: true, value: ctx.commands.pendingGates() };
    } catch (e) {
      return outcomeOf(e);
    }
  }
  const { handler } = resolveDispatch(ctx, canonical);
  try {
    if (!handler) return notExposed(canonical);
    const out = handler(ctx);
    // Every exposed route is a SYNCHRONOUS read or the sync gate write; the interactive
    // drivers (run!/advance!) reject JSON and are not exposed at all.
    return out instanceof Promise ? notExposed(canonical) : out;
  } catch (e) {
    return outcomeOf(e);
  }
}

const notExposed = (name: string): Outcome => ({
  ok: false,
  error: {
    code: 'not-exposed',
    message: `serve: '${name}' is not exposed — the minimal slice is journey · status · next · detail · confirm · results · packet · events · log · gates · whatsnext (GET) and the gate / approve / drive writes (POST /api/gate, POST /api/approve, POST /api/drive). run!/spawn!/submit!/goal!/spec!/archive/advance! are deliberately absent as ROUTES (scope OUT): the approve and the drive are named routes over the operator action and the semantic driver, which compose those commands themselves.`,
  },
});

const usageError = (message: string): Outcome => ({ ok: false, error: { code: 'usage', message }, exitCode: 2 });

/** The CLI's exit code → an HTTP status class. The BODY is always the CLI's own error
 *  document (jsonDoc), so a client parses the same shape the CLI prints. */
function httpStatus(o: Outcome): number {
  if (o.ok) return 200;
  if (o.exitCode === 2) return 400;
  if (o.error.code === 'no-node' || o.error.code === 'ambiguous-id' || o.error.code === 'not-exposed') return 404;
  return 500;
}

async function route(root: string, approver: Approver, log: OpLog, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // The base is a PLACEHOLDER: the request path is host-agnostic (nothing here reads the
  // Host header or the peer address — remote-capable in shape).
  const url = new URL(req.url ?? '/', 'http://service.invalid');
  const path = url.pathname;

  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(UI_HTML);
    return;
  }

  const name = path.startsWith('/api/') ? path.slice('/api/'.length) : undefined;
  if (name === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
    return;
  }

  // ── the APPROVE — the operate loop's ONE write (leg 11) ──
  // `runOperatorAction` in-process: the SAME action the CLI's `advance!` runs, with the
  // same deps, over the daemon's own human channel (which refuses to prompt) and ONE
  // slot at a time. The claim happens HERE, synchronously and before the body read: a
  // second approve arriving while a frame is running is refused by NAME, never queued.
  if (name === 'approve') {
    if (req.method !== 'POST') return sendJson(res, 405, jsonDoc(usageError('POST /api/approve {proposal?: {action, detail}}')));
    if (!approver.claim()) {
      req.resume(); // nothing reads this body — drain it, then refuse
      return sendJson(res, 409, jsonDoc({ ok: false, error: { code: 'approve-busy', message: APPROVE_BUSY } }));
    }
    try {
      let proposal: ApproveProposal | undefined;
      try {
        const raw = await readBody(req);
        const parsed = (raw ? JSON.parse(raw) : {}) as { proposal?: unknown };
        const p = parsed.proposal as ApproveProposal | undefined;
        // The proposal is OPTIONAL and, when present, must be the card's own derivation
        // ({action, detail}) — a malformed binding is a usage refusal, never a guess.
        if (p !== undefined && (typeof p !== 'object' || p === null || typeof p.action !== 'string' || typeof p.detail !== 'string')) {
          return sendJson(res, 400, jsonDoc(usageError('POST /api/approve proposal must be {action: string, detail: string} (the card\'s own derivation)')));
        }
        proposal = p;
      } catch {
        return sendJson(res, 400, jsonDoc(usageError('POST /api/approve expects a JSON body: {proposal?: {action, detail}}')));
      }
      const out = await approver.approve(proposal, log);
      return sendJson(res, out.status, JSON.stringify(out.body, null, 2) + '\n');
    } finally {
      approver.release();
    }
  }

  // ── the DRIVE — the semantic driver's LLM loop (leg 12 task 02) ──
  // `runSemanticDriver` in-process: the model proposes a call, CODE validates it against
  // the closed set, and an accepted call executes through the SAME command layer. The
  // provider (and its key) is resolved inside `driveJourney` and never reaches the body.
  // The single-flight slot is SHARED with the approve — one operate-loop action at a time.
  if (name === 'drive') {
    if (req.method !== 'POST') return sendJson(res, 405, jsonDoc(usageError('POST /api/drive {provider?, model?, maxTurns?, resume?}')));
    if (!approver.claim()) {
      req.resume(); // nothing reads this body — drain it, then refuse
      return sendJson(res, 409, jsonDoc({ ok: false, error: { code: 'drive-busy', message: DRIVE_BUSY } }));
    }
    try {
      let opts: DriveOptions = {};
      try {
        const raw = await readBody(req);
        const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
        const bad = driveOptionProblems(parsed);
        if (bad) return sendJson(res, 400, jsonDoc(usageError(bad)));
        opts = parsed as DriveOptions;
      } catch {
        return sendJson(res, 400, jsonDoc(usageError('POST /api/drive expects a JSON body: {provider?, model?, maxTurns?, resume?}')));
      }
      const out = await driveJourney(root, opts, log);
      return sendJson(res, out.status, JSON.stringify(out.body, null, 2) + '\n');
    } finally {
      approver.release();
    }
  }

  // ── the gate WRITE — the same L1 composite the CLI's `gate!` calls ──
  if (name === 'gate') {
    if (req.method !== 'POST') return sendJson(res, 405, jsonDoc(usageError('POST /api/gate {id, gate, decision, feedback}')));
    let payload: { id?: unknown; gate?: unknown; decision?: unknown; feedback?: unknown };
    try {
      payload = JSON.parse((await readBody(req)) || '{}') as typeof payload;
    } catch {
      return sendJson(res, 400, jsonDoc(usageError('POST /api/gate expects a JSON body: {id, gate, decision, feedback}')));
    }
    if (typeof payload.id !== 'string' || typeof payload.gate !== 'string' || typeof payload.decision !== 'string') {
      return sendJson(res, 400, jsonDoc(usageError('POST /api/gate needs {id: string, gate: string, decision: string, feedback?: string}')));
    }
    const feedback = typeof payload.feedback === 'string' ? payload.feedback : '';
    const argv = ['gate!', payload.id, payload.gate, payload.decision, ...(feedback ? [feedback] : [])];
    const out = dispatch(root, argv, log);
    return sendJson(res, httpStatus(out), jsonDoc(out));
  }

  // ── the READS ──
  if (req.method !== 'GET') return sendJson(res, 405, jsonDoc(usageError(`GET /api/${name}`)));
  if (name !== 'gates' && name !== 'whatsnext' && !READ_ROUTES.has(name)) return sendJson(res, 404, jsonDoc(notExposed(name)));

  // THE OPERATIONAL LOG'S READ (leg 12/05, AC-4) — the SAME `ann log` handler the CLI
  // dispatches, over the SAME scratch file (never a second reader): the filters
  // (`?trace=&layer=&task=&run=&level=&since=&tail=`) pass through as the command's own
  // flags, so the page can pull ONE CHAIN (`trace`) or ONE LAYER (`layer`).
  if (name === 'log') {
    const argv = ['log'];
    for (const q of ['trace', 'layer', 'task', 'run', 'level', 'since', 'tail'] as const) {
      const v = url.searchParams.get(q);
      if (v !== null && v !== '') argv.push(`--${q}`, v);
    }
    const out = dispatch(root, argv, log);
    return sendJson(res, httpStatus(out), jsonDoc(out));
  }

  // THE WHAT'S NEXT CARD's read (leg 11) — the operator view: the derived advance +
  // frontmost-ready + leg gate + pending gates, AND the integrity blockers the approve
  // re-checks fail-closed. Derived on demand, like the gate queue; never cached.
  if (name === 'whatsnext') {
    try {
      return sendJson(res, 200, JSON.stringify(whatsNext(root, log), null, 2) + '\n');
    } catch (e) {
      const o = outcomeOf(e);
      return sendJson(res, httpStatus(o), jsonDoc(o));
    }
  }

  let argv: string[];
  if (name === 'status') {
    const filter = url.searchParams.get('filter');
    argv = filter ? ['status', filter] : ['status'];
  } else if (name === 'events' || name === 'results') {
    // The ONE-VIEW DRILLS: both reads take an OPTIONAL index — `events` drills the event
    // record + its links, `results` drills one result item (a commit's `git show`, a ref's
    // file/dir, an evidence event). The index is passed straight to the CLI's own handler;
    // no git/fs logic lives here (the binding stays thin).
    const id = url.searchParams.get('id');
    if (!id) return sendJson(res, 400, jsonDoc(usageError(`GET /api/${name}?id=<node>[&n=<n>]`)));
    const n = url.searchParams.get('n');
    argv = n ? [name, id, n] : [name, id];
  } else if (ID_READS.has(name)) {
    const id = url.searchParams.get('id');
    if (!id) return sendJson(res, 400, jsonDoc(usageError(`GET /api/${name}?id=<node>`)));
    argv = [name, id];
  } else {
    argv = [name]; // journey · next (no-arg reads; an id would make `journey` a node walk)
  }
  const out = dispatch(root, argv, log);
  return sendJson(res, httpStatus(out), jsonDoc(out));
}

/** The drive body's shape, validated BEFORE the loop runs (an untrusted body never picks
 *  a provider/model silently, and an unknown key is a usage refusal, never ignored).
 *  Returns the problem, or undefined when the body is well-formed. */
function driveOptionProblems(p: Record<string, unknown>): string | undefined {
  const known = ['provider', 'model', 'maxTurns', 'resume'];
  const unknown = Object.keys(p).filter((k) => !known.includes(k));
  if (unknown.length) return `POST /api/drive: unknown option(s) ${unknown.join(', ')} — the body is {provider?, model?, maxTurns?, resume?}`;
  for (const k of ['provider', 'model']) {
    if (p[k] !== undefined && (typeof p[k] !== 'string' || !p[k])) return `POST /api/drive: '${k}' must be a non-empty string`;
  }
  if (p.maxTurns !== undefined && (typeof p.maxTurns !== 'number' || !Number.isInteger(p.maxTurns))) {
    return "POST /api/drive: 'maxTurns' must be an integer (the loop refuses an out-of-range bound, never clamps it)";
  }
  if (p.resume !== undefined) {
    const r = p.resume as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return "POST /api/drive: 'resume' must be the checkpoint object a previous run returned";
    for (const k of ['at', 'action', 'detail']) {
      if (typeof r[k] !== 'string' || !(r[k] as string)) return `POST /api/drive: 'resume.${k}' must be a non-empty string`;
    }
  }
  return undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > MAX_BODY) {
        reject(new Error(`request body exceeds ${MAX_BODY} bytes`));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: string): void {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
