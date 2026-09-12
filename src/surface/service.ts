import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createContext, resolveDispatch, jsonDoc, outcomeOf, type Outcome } from './handlers.js';
import { APPROVE_BUSY, Approver, whatsNext, type ApproveProposal } from './approve.js';
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
 * next · detail · confirm · results · packet`, the whole-journey gate queue (`gates` —
 * the L1 read the UI's WAITING ON YOU view needs, `Commands.pendingGates`), the gate
 * WRITE (`POST /api/gate` → the same L1 `gate!` composite: accept|reject + feedback),
 * the OPERATE LOOP's read + write (`GET /api/whatsnext` — the WHAT'S NEXT card's
 * operator view — and `POST /api/approve` → `runOperatorAction` in-process, leg 11),
 * and the single UI page at `/`. Nothing else is exposed — `run!`/`spawn!`/`submit!`/
 * `goal!`/`spec!`/`archive`/`advance!` are NOT routes: the approve is ONE named route
 * over the operator action (a specific gesture), never a general command runner, and
 * the refusal is a named error doc (`not-exposed`), never a silent pass-through.
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
const READ_ROUTES = new Set(['journey', 'status', 'next', 'detail', 'confirm', 'results', 'packet', 'events']);
/** The reads addressed by a node id (`?id=<node>`). */
const ID_READS = new Set(['detail', 'confirm', 'results', 'packet']);

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
  // THE SINGLE-FLIGHT (care b): ONE approve at a time, per service instance. The slot is
  // claimed SYNCHRONOUSLY in the route, before the request's first await (the body read).
  const approver = new Approver(root);
  const server = createServer((req, res) => {
    route(root, approver, req, res).catch((e: unknown) => {
      // Fail-closed: an unexpected throw is a named error doc, never a stack trace.
      sendJson(res, 500, jsonDoc({ ok: false, error: { code: 'service', message: (e as Error).message } }));
    });
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
function dispatch(root: string, argv: string[]): Outcome {
  const canonical = argv[0];
  const ctx = createContext(root, argv, { json: true });
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
    message: `serve: '${name}' is not exposed — the minimal slice is journey · status · next · detail · confirm · results · packet · gates · whatsnext (GET) and the gate / approve writes (POST /api/gate, POST /api/approve). run!/spawn!/submit!/goal!/spec!/archive/advance! are deliberately absent (scope OUT).`,
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

async function route(root: string, approver: Approver, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
      const out = await approver.approve(proposal);
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
    const out = dispatch(root, argv);
    return sendJson(res, httpStatus(out), jsonDoc(out));
  }

  // ── the READS ──
  if (req.method !== 'GET') return sendJson(res, 405, jsonDoc(usageError(`GET /api/${name}`)));
  if (name !== 'gates' && name !== 'whatsnext' && !READ_ROUTES.has(name)) return sendJson(res, 404, jsonDoc(notExposed(name)));

  // THE WHAT'S NEXT CARD's read (leg 11) — the operator view: the derived advance +
  // frontmost-ready + leg gate + pending gates, AND the integrity blockers the approve
  // re-checks fail-closed. Derived on demand, like the gate queue; never cached.
  if (name === 'whatsnext') {
    try {
      return sendJson(res, 200, JSON.stringify(whatsNext(root), null, 2) + '\n');
    } catch (e) {
      const o = outcomeOf(e);
      return sendJson(res, httpStatus(o), jsonDoc(o));
    }
  }

  let argv: string[];
  if (name === 'status') {
    const filter = url.searchParams.get('filter');
    argv = filter ? ['status', filter] : ['status'];
  } else if (name === 'events') {
    const id = url.searchParams.get('id');
    if (!id) return sendJson(res, 400, jsonDoc(usageError('GET /api/events?id=<node>[&n=<n>]')));
    const n = url.searchParams.get('n');
    argv = n ? ['events', id, n] : ['events', id];
  } else if (ID_READS.has(name)) {
    const id = url.searchParams.get('id');
    if (!id) return sendJson(res, 400, jsonDoc(usageError(`GET /api/${name}?id=<node>`)));
    argv = [name, id];
  } else {
    argv = [name]; // journey · next (no-arg reads; an id would make `journey` a node walk)
  }
  const out = dispatch(root, argv);
  return sendJson(res, httpStatus(out), jsonDoc(out));
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
