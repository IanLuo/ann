import { readdirSync, readFileSync, appendFileSync, existsSync, statSync, lstatSync, mkdirSync, writeFileSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename, resolve, sep } from 'node:path';
import { getVOCAB } from './vocab.js';
import { blobSha, stripMarkers } from './sha.js';
import { loadDocsManifest, scanDocsDir, writeDocsManifest } from './docs.js';

export interface JourneyEvent {
  at: string;
  type: string;
  note?: string;
  gate?: string | { old: string; new: string };
  artifact?: { name: string; path: string; lockSha: string; type?: string; version?: number };
  successor?: { name: string; path: string };
  target?: string;
  feedback?: string;
  /** The required WHY on a `cancelled` record (leg 08 task 01) — also used by `deferred`. */
  reason?: string;
  [key: string]: unknown;
}

/** Write-confinement handle (AC-1): the canonical folder for ONE node id — the only
 *  id→folder mapping. Opaque: external code can read `.id`/`.dir` but cannot construct
 *  a NodeDir from an arbitrary path string, so a write path can only ever derive from
 *  the node a command addresses (never from a caller-supplied path). Only
 *  `Store.resolveNode` (and `spawn`, for its own new node) mints handles. */
export interface NodeDir {
  readonly id: string;
  /** The canonical folder — `<store root>/.ann/journey/legs/<id>`. */
  readonly dir: string;
}

/** Module-private implementation — NOT exported, which is what makes the handle
 *  opaque. A caller that wants a NodeDir has to ask the store for one. */
class NodeDirImpl implements NodeDir {
  constructor(readonly id: string, readonly dir: string) {}
}

interface NodeEntry {
  id: string;
  events: JourneyEvent[];
}

/** The CLOSED task statuses — a task in one of these is no longer OPEN WORK (leg 08
 *  task 01 added `cancelled` to the done/superseded pair; `deferred` — the work is
 *  postponed, not delivered — completes the set the same way). Wherever the journey asks
 *  "is this task still open?" — the leg-done aggregate, the leg gate, the goal's
 *  structural exhaustion, the distance-to-goal set — this is the answer, so a cancelled
 *  OR deferred task never keeps its leg or the session from deriving finished. `failed`
 *  is deliberately NOT closed: a leg whose remaining tasks all failed derives blocked
 *  (escalate), and a failed task is not finished work. */
export const CLOSED_TASK_STATUSES = ['done', 'superseded', 'cancelled', 'deferred'];

/** NOT OPEN TO RUN: the statuses that are neither open work nor work a leg can point at
 *  as its frontmost child — the closed set plus `failed` (exhausted → escalate). An
 *  `accepted` task (the confirm gate accepted, no `completed` yet) is deliberately NOT
 *  here: it is unclosed work, so it stays the leg's frontmost child and its status is
 *  what the leg reports — it is simply not RUNNABLE (every ready derivation filters on
 *  `queued`/`active` explicitly, so an accepted task is never proposed to next/advance!). */
const NOT_OPEN_TO_RUN = [...CLOSED_TASK_STATUSES, 'failed'];

/** The store write-rev ledger (`.ann/journey/.ledger.json`) — ann's last-known state
 *  per node, recorded after every CLI write. `verify` diffs the current store against
 *  it to detect changes made OUTSIDE the CLI (a human editor, another process), and
 *  to reason about them (class + the rev/time ann last wrote). Purely additive: this
 *  is the ONLY writer of the ledger — events.jsonl/node.json are never modified. */
export interface LedgerNodeEntry {
  eventsContent: string; // exact bytes ann last wrote to events.jsonl
  nodeContent: string;   // exact bytes ann last wrote to node.json
  eventsSha: string;     // blobSha(eventsContent)
  nodeSha: string;       // blobSha(nodeContent)
  lastEventAt: string;   // tail event .at at the last ann write ('' for a leg)
  lastRev: number;       // global ledger rev at this node's last ann write
}

export interface Ledger {
  rev: number;           // global write counter (monotonic across all nodes)
  bootstrappedAt: string;
  nodes: Record<string, LedgerNodeEntry>;
}

/** Named error for the fail-closed write guard: a store write was rejected because
 *  the on-disk node diverged from the ledger — i.e. the store was changed outside the
 *  CLI. The message carries the `ann verify` hint (ann never builds on a state it
 *  does not recognize, and never advances the ledger past an external edit). */
export class StoreExternalEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreExternalEditError';
  }
}

/** Ledger-write refusal: the integrity record is unreadable (or unwritable), so ann
 *  refuses to write — writing without a readable ledger would reopen the masking hole. */
export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

/** ══ SESSION ADDRESSING (ANN_STORE) — the same commands read ANY journey: the ACTIVE
 *   session by default, an ARCHIVED session when ANN_STORE names one. The store shape is
 *   identical across locations — a dir holding `legs/` (+ `.ledger.json`) — only the
 *   folder differs. A PROJECT ROOT keeps its journey at `<root>/.ann/journey` (and its
 *   docs/ home at `<root>/docs`); a JOURNEY ROOT is the journey dir itself (legs/ +
 *   .ledger.json directly — the shape `goal! archive` round-trips, and the shape a
 *   legacy pre-v12 project has at `<root>/journey`). A journey root has NO docs/ home:
 *   docs are the LIVE project's git content, so doc resolution falls to the legacy
 *   current() locks. */

/** A resolved store target. `kind` decides the resolution rule: a 'project' target has
 *  a docs/ manifest home (manifest-forward reads); a 'journey' target resolves docs
 *  through the legacy current() locks and remaps recorded artifact paths into its own
 *  legs/ root. */
export interface StoreLocation {
  kind: 'project' | 'journey';
  /** 'project': the PROJECT ROOT (journey at <root>/.ann/journey, docs home at
   *  <root>/docs). 'journey': the JOURNEY DIR itself (legs/ + .ledger.json directly —
   *  an archived session, or a legacy pre-v12 project's journey root). */
  root: string;
}

export const STORE_LOCATION_HINT =
  "unset ANN_STORE for the active session, or point it at a project root (a dir with .ann/journey/legs) or a journey root (a dir with journey/legs or legs/ directly — an archived session)";

/** Bad/absent ANN_STORE target — NAMED, so the CLI fails CLOSED at startup (exit 1,
 *  never a silent empty tree). Thrown by resolveStoreLocation (a string that does not
 *  normalize) and by the Store constructor (a resolved location with no legs/). */
export class StoreLocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreLocationError';
  }
}

/** Read-only store write refusal (layer b of the read-only enforcement): when a Store
 *  is constructed read-only — because ANN_STORE points at a NON-ACTIVE journey (an
 *  archived session, or another project) — every write method refuses with this named
 *  error. The CLI chokepoint refuses BEFORE dispatch for the journey-addressing writes;
 *  this guard is the store-level backstop any caller hits. */
export class StoreReadonlyError extends Error {
  constructor(what: string) {
    super(`${what} refused: this journey is READ-ONLY (ANN_STORE points at a non-active session) — reads only; unset ANN_STORE to write the active session`);
    this.name = 'StoreReadonlyError';
  }
}

/** The journey dir for a resolved location — where legs/ + .ledger.json live (project →
 *  <root>/.ann/journey; journey → the root itself). One derivation, used by the store
 *  (legs/ledger paths) and by the CLI's read-only identity comparison. */
export const storeJourneyDir = (loc: StoreLocation): string =>
  loc.kind === 'project' ? join(loc.root, '.ann', 'journey') : loc.root;

/** Normalize an ANN_STORE value to a StoreLocation. Accepts (in order): a PROJECT ROOT
 *  (has `.ann/journey/legs` — the canonical live layout; checked first so pointing
 *  ANN_STORE at the ACTIVE repo — where `journey` may be a symlink to `.ann/journey` —
 *  resolves as a project, never as a legacy root), a SESSION/GROUP root (has
 *  `journey/legs` — the archived-session shape, incl. a legacy pre-v12 project), or a
 *  JOURNEY DIR itself (has `legs/` directly — e.g. the `<session>/journey` path
 *  `goal! archive` prints). Anything else throws the NAMED StoreLocationError. */
export function resolveStoreLocation(raw: string): StoreLocation {
  const p = resolve(raw);
  if (existsSync(join(p, '.ann', 'journey', 'legs'))) return { kind: 'project', root: p };
  if (existsSync(join(p, 'journey', 'legs'))) return { kind: 'journey', root: join(p, 'journey') };
  if (existsSync(join(p, 'legs'))) return { kind: 'journey', root: p };
  throw new StoreLocationError(`ANN_STORE: bad target '${raw}' — ${STORE_LOCATION_HINT} (no legs/ journey store found)`);
}

/** Detail card types — `Store.detail()` derives; the CLI renders (ann detail <id>). */
export interface DetailGate {
  state: 'none' | 'submitted' | 'confirmed' | 'rejected';
  at?: string;
}

export interface ArtifactRef {
  name: string;
  path: string;
  sha: string;
  role: 'current' | 'superseded' | 'historical';
}

export interface TaskDetail {
  id: string;
  isLeg: boolean;
  status: string;
  superseded: boolean;
  contract: Record<string, unknown> | undefined;
  gates: { grill: DetailGate; confirm: DetailGate };
  artifacts: ArtifactRef[];
  events: JourneyEvent[];
  blockers: string[];
  tasks?: Array<{ id: string; status: string }>;
}

export interface ResultItem {
  kind: 'commit' | 'ref' | 'evidence' | 'link';
  label: string;
  path?: string;
  sha?: string;
  note?: string;
  url?: string;
  at?: string;
}


/** Legacy path normalization: recorded paths from the pre-journey era resolve to
 *  the current layout. Two cases: the store rename (`tree/rounds/…` →
 *  `journey/legs/…`) and the flatten (`journey/legs/<leg>/00/<task>/…` →
 *  `journey/legs/<leg>/<task>/…`). The symlink compat layers were removed in
 *  favor of this single code normalizer. */
export const legacyPath = (p: string): string =>
  p
    .replace(/^tree\/rounds\//, 'journey/legs/')
    .replace(/^(journey\/legs\/[^/]+)\/00\//, '$1/')
    .replace(/^journey\//, '.ann/journey/'); // v12: the canonical on-disk root is .ann/journey/

/** The v9 migration cutoff — the ONE grandfathering date. Tasks spawned before it are
 *  exempt from the checks that arrived with v9+ (F-AC18 conclusion, F-AC19 contract
 *  self-sufficiency, and the gate gaps whose prose escapes the v14 writer removed).
 *  A CHECK-REPORTING rule only: no write path reads it. */
const V9_CUTOFF = '2026-08-21';

/** Logical name from a filename: strip .md and any -vN version suffix
 *  (functional-spec-v3.md → functional-spec). The third fallback of the
 *  resolver's collect() — notes may omit the explicit logical-name marker. */
export const logicalNameFromFile = (f: string): string => f.replace(/\.md$/, '').replace(/-v\d+$/, '');

/**
 * The tree store (S1) — reads/writes legs, nodes, events, artifacts per
 * journey-format-spec v8. Builds the in-memory tree; owns the single
 * appendEvent() write function (architecture LB-3); exposes derived views
 * (status / resolution / integrity) for shared readers.
 */
export class Store {
  readonly root: string;
  readonly legs: string;
  readonly kind: 'project' | 'journey';   // session-addressing: does this store have a docs/ home?
  readonly readOnly: boolean;             // constructed read-only → write methods throw StoreReadonlyError
  /** The journey dir this store reads/writes — legs/ + .ledger.json live here (project →
   *  <root>/.ann/journey; journey → <root>). Shared by the CLI's read-only identity. */
  readonly journeyDir: string;
  private nodes = new Map<string, NodeEntry>();
  private ledger?: Ledger;              // the write-rev ledger (absent = no baseline yet)
  private ledgerCorrupt = false;        // ledger file exists but is unparseable → fail-closed
  private unparseableNodes = new Set<string>(); // events.jsonl that failed load-parsing

  /** Construct over a session target. `location` is a raw path (normalized by
   *  resolveStoreLocation — the ANN_STORE surface) or an already-resolved StoreLocation.
   *  Existing call sites pass a path as before (the ACTIVE project root) → project-kind,
   *  read-write, unchanged behavior. `readOnly` marks a NON-ACTIVE target so its write
   *  methods refuse (layer b). A location with no legs/ throws the NAMED StoreLocationError
   *  — a bad/absent store fails closed, never a silent empty tree. */
  constructor(location: string | StoreLocation, opts: { readOnly?: boolean } = {}) {
    const loc: StoreLocation = typeof location === 'string' ? resolveStoreLocation(location) : location;
    this.kind = loc.kind;
    this.readOnly = opts.readOnly ?? false;
    this.root = loc.root;
    this.journeyDir = storeJourneyDir(loc);
    this.legs = join(this.journeyDir, 'legs'); // v12 layout: all ann files under the journey dir
    if (!existsSync(this.legs)) {
      throw new StoreLocationError(`no journey store at '${this.journeyDir}' — missing legs/ (${STORE_LOCATION_HINT})`);
    }
    this.load();
  }

  /** Layer b of the read-only enforcement — every WRITE method starts here. */
  private assertWritable(what: string): void {
    if (this.readOnly) throw new StoreReadonlyError(what);
  }

  /** Write confinement (AC-1): resolve a node id to its canonical folder under the
   *  legs root — THE id→folder mapping. Writers take the returned handle and derive
   *  their file paths as `join(node.dir, <fixed relative>)`; they never re-derive a
   *  path from an id, and a caller never passes a path string at all. Refuses (throws)
   *  anything that is not an existing node under the store's legs root. */
  resolveNode(id: string): NodeDir {
    const dir = this.nodeFolder(id);
    if (!this.nodes.has(id)) throw new Error(`resolveNode rejected: no node ${id}`);
    return new NodeDirImpl(id, dir);
  }

  /** Normalize an id to its folder under the legs root, refusing (throw) anything
   *  that does not stay under it — a `.`/`..`/separator smuggling an id outside the
   *  store's own tree is caught here, not at the write. Shared by resolveNode (an
   *  existing node) and spawn (a NEW node not yet in the map). */
  private nodeFolder(id: string): string {
    const legsRoot = resolve(this.legs);
    const dir = resolve(legsRoot, id);
    if (dir === legsRoot || !dir.startsWith(legsRoot + sep)) {
      throw new Error(`resolveNode rejected: '${id}' is not a node under the store's legs root (${this.legs})`);
    }
    return dir;
  }

  private walk(dir: string, acc: string[] = [], file: string): string[] {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (!lstatSync(p).isSymbolicLink() && statSync(p).isDirectory()) this.walk(p, acc, file);
      else if (entry === file) acc.push(p);
    }
    return acc;
  }

  private load(): void {
    this.loadLedger();
    // Node EXISTENCE comes from node.json (v8: leg roots have no events.jsonl);
    // events are optional (tasks have them, leg roots don't).
    for (const file of this.walk(this.legs, [], 'node.json')) {
      const id = file.replace(new RegExp('^' + this.legs + '/'), '').replace(/\/node\.json$/, '');
      const evFile = file.replace(/node\.json$/, 'events.jsonl');
      let events: JourneyEvent[] = [];
      if (existsSync(evFile)) {
        try {
          events = this.parse(evFile);
        } catch {
          // unparseable events — never let a corrupt log kill every command; the node
          // loads empty and `verify` reports it (unparseable-events / class=unparseable).
          this.unparseableNodes.add(id);
        }
      }
      this.nodes.set(id, { id, events });
    }
  }

  /** Read the write-rev ledger (if present). Corrupt → flagged: every write is refused
   *  and verify reports it — ann never reasons about an unreadable integrity record. */
  private loadLedger(): void {
    const p = join(this.journeyDir, '.ledger.json');
    if (!existsSync(p)) return;
    try {
      this.ledger = JSON.parse(readFileSync(p, 'utf8')) as Ledger;
    } catch {
      this.ledgerCorrupt = true;
    }
  }

  private parse(file: string): JourneyEvent[] {
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as JourneyEvent);
  }

  ids(): string[] {
    return [...this.nodes.keys()];
  }

  /** A leg's tasks = direct children (flat shape, v8 §13). */
  tasksOf(legId: string): string[] {
    return [...this.nodes.keys()]
      .filter((n) => n.startsWith(legId + '/') && n.split('/').length === 2)
      .sort();
  }

  contract(id: string): Record<string, unknown> | undefined {
    try {
      return JSON.parse(readFileSync(join(this.legs, id, 'node.json'), 'utf8')) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  events(id: string): JourneyEvent[] {
    return this.nodes.get(id)?.events ?? [];
  }

  /** The read view for `ann ledger` — rev + per-node last-write rev/at + hashes.
   *  Content snapshots stay private (the read surface needs no bytes). */
  ledgerView(): { rev: number; bootstrappedAt: string; nodes: Record<string, { eventsSha: string; nodeSha: string; lastEventAt: string; lastRev: number }> } {
    if (!this.ledger) return { rev: 0, bootstrappedAt: '', nodes: {} };
    const nodes: Record<string, { eventsSha: string; nodeSha: string; lastEventAt: string; lastRev: number }> = {};
    for (const [id, n] of Object.entries(this.ledger.nodes)) {
      nodes[id] = { eventsSha: n.eventsSha, nodeSha: n.nodeSha, lastEventAt: n.lastEventAt, lastRev: n.lastRev };
    }
    return { rev: this.ledger.rev, bootstrappedAt: this.ledger.bootstrappedAt, nodes };
  }

  /** A node's immutable creation date (node.json §2) — '' when absent. The cutoff reads it. */
  createdAt(id: string): string {
    return (this.contract(id) as { createdAt?: string } | undefined)?.createdAt ?? '';
  }

  /** THE CUTOFF, as one predicate (core-design §1): a node spawned before the v9
   *  migration is not re-litigated by CHECK-REPORTING — F-AC18 conclusion, F-AC19
   *  contract self-sufficiency, and the gate gaps the v14 writer no longer excuses in
   *  prose. Every reporting consumer (check(), the S4 gate rules) asks HERE, so there
   *  is one grandfathering rule instead of a copy per reader. No WRITE path reads it. */
  grandfathered(id: string): boolean {
    return this.createdAt(id) < V9_CUTOFF;
  }

  /**
   * Derived status (v8 §3/§12). Tasks: tail mapping. Legs: pure function of the
   * leg's tasks — all closed → done; frontmost-ready child → its status; childless
   * → own lifecycle (L1 base step); all remaining failed → blocked (escalate).
   */
  status(id: string): string {
    if (id.includes('/')) return this.taskStatus(id);
    return this.legStatus(id);
  }

  private taskStatus(id: string): string {
    let status = 'queued';
    const evs = this.events(id);
    for (const e of evs) {
      switch (e.type) {
        case 'created':
          status = 'queued';
          break;
        case 'activated':
          status = 'active';
          break;
        case 'completed':
          status = 'done';
          break;
        case 'failed':
          status = 'failed';
          break;
        case 'superseded':
          if (status !== 'done' && status !== 'failed') status = 'superseded';
          break;
        // leg 08 task 01 (the task-close vocabulary): the confirm-result gate was
        // ACCEPTED but no `completed` follows — the deliverable is approved, the delivery
        // is not recorded. Never `queued` (the created default would make it look
        // re-runnable to next/advance!/run!) and never `done` (nothing was delivered).
        // The GRILL gate's confirmation is NOT this state: a grilled-but-unstarted task
        // is ordinary queued/active work.
        case 'confirmed':
          if (e.gate === 'confirm' && status !== 'done' && status !== 'failed') status = 'accepted';
          break;
        // leg 08 task 01 — the CANCELLED terminal: the task is no longer needed, an
        // append-style bookkeeping record (NOT a gate decision — any initiator may
        // record it, with a required reason). Like `superseded` it never un-closes
        // delivered (done) or exhausted (failed) work; unlike it the blocked
        // re-derivations below never override it — cancellation is the escape hatch for
        // a task stuck at an undecided submission.
        case 'cancelled':
          if (status !== 'done' && status !== 'failed') status = 'cancelled';
          break;
        // leg 08 task 01's `cancelled` counterpart, wired as a real terminal: `deferred`
        // is the task POSTPONED (not delivered, not abandoned) — an append-style
        // bookkeeping record with a required reason, same escape-hatch semantics as
        // `cancelled`. Terminal in BOTH directions: it never un-closes delivered (done) /
        // exhausted (failed) / abandoned (cancelled) work, and the blocked re-derivations
        // below never override it — so deferring a task stuck at an undecided submission
        // STICKS and its leg can derive done.
        case 'deferred':
          if (status !== 'done' && status !== 'failed' && status !== 'cancelled') status = 'deferred';
          break;
        // v6 goal session: `goal-met` is deliberately NOT here — a goal verdict is
        // STATUS-INERT (goal-session-design §2). Only the seed (created+completed)
        // makes the goal leg done; the verdict never moves legStatus.
      }
    }
    // v8 §3: a submitted without a confirmed/rejected at that gate = blocked
    // (waiting on human) — a gate cannot be skipped silently. Never overrides done/failed
    // — nor `cancelled` (leg 08 task 01) and `deferred`: a cancelled OR deferred task
    // STAYS so, whatever undecided submission or undischarged `waiting` record it carries.
    if (status !== 'done' && status !== 'failed' && status !== 'cancelled' && status !== 'deferred') {
      const pendingGate = evs.some((e) => {
        if (e.type !== 'submitted' || typeof e.gate !== 'string') return false;
        return !evs.slice(evs.indexOf(e) + 1).some((x) => (x.type === 'confirmed' || x.type === 'rejected') && x.gate === e.gate);
      });
      if (pendingGate) status = 'blocked';
      // v14 §3 (core-design §3 rule 8, resume tail-state 4): a `waiting` record with no
      // SUBSEQUENT commit evidence = the empty-chain verify-wait — the runner has not
      // committed yet. `waiting` maps to blocked; the commit evidence releases it.
      // A stated code-literal change beside the eventTypes/statuses reconciliations.
      const lastWaiting = evs.map((e) => e.type).lastIndexOf('waiting');
      if (lastWaiting >= 0 && !evs.slice(lastWaiting + 1).some((e) => e.type === 'evidence' && Array.isArray(e.commits) && e.commits.length > 0)) {
        status = 'blocked';
      }
    }
    return status;
  }

  private legStatus(id: string): string {
    const children = [...this.nodes.keys()].filter((n) => n.startsWith(id + '/') && n.split('/').length === 2);
    if (!children.length) return this.taskStatus(id);
    if (children.every((c) => CLOSED_TASK_STATUSES.includes(this.taskStatus(c)))) return 'done';
    const ready = children
      .filter((c) => !NOT_OPEN_TO_RUN.includes(this.taskStatus(c)))
      .sort();
    return ready.length ? this.taskStatus(ready[0]) : 'blocked';
  }

  /**
   * Resolution (format §5): current(name) = the artifact-locked producer with that
   * name whose lock of THIS artifact is not superseded — supersession is PER-NAME:
   * a superseded event's successor.name is the artifact it supersedes (format §3),
   * so a multi-artifact producer keeps its other locks current. Legacy prose
   * superseded events (no successor.name) fall back to producer-level — every such
   * producer locked exactly one artifact. Structured events preferred; legacy prose
   * notes are parsed as a fallback.
   */
  /** The store-relative artifact path a READER can join onto this.root — a recorded
   *  artifact path remapped for THIS store's shape. 'project': legacyPath (the canonical
   *  project-relative `.ann/journey/legs/…`). 'journey' (an archived session): the
   *  recorded paths read `.ann/journey/legs/…` but the files live under the journey
   *  root's OWN `legs/…` — strip the `.ann/journey/` anchor (the reverse of legacyPath's
   *  prefixing). */
  private artifactPath(p: string): string {
    const canon = legacyPath(p);
    return this.kind === 'journey' ? canon.replace(/^\.ann\/journey\//, '') : canon;
  }

  current(name: string): { name: string; path: string; sha?: string; producer: string } | undefined {
    const lockers = this.lockers(name);
    const superseded = this.supersededLocks(name);
    const candidates = lockers.filter((p) => !superseded.has(p));
    if (!candidates.length) return undefined;
    const producer = candidates[candidates.length - 1];
    // A producer may lock MULTIPLE artifacts (e.g. an amendment task that supersedes
    // two specs) — match by logical name, never just the first artifact-locked event.
    const byName = this.events(producer).find((x) => x.type === 'artifact-locked' && x.artifact?.name === name);
    const e = byName ?? this.events(producer).find((x) => x.type === 'artifact-locked');
    const a = e?.artifact;
    const filename = a?.path
      ? basename(a.path)
      : String(e?.note ?? '').match(/([\w.-]+\.md)/)?.[1] ?? '';
    return {
      name,
      path: this.artifactPath(a?.path ?? `journey/legs/${producer}/artifacts/${filename}`),
      sha: a?.lockSha ?? '',
      producer,
    };
  }

  /** Every CURRENT legacy artifact name in this store (the name-set for `specs` under a
   *  'journey'-kind store, which has no docs/ manifest) — a name once per its current
   *  producer, resolved through current() (supersession-aware). Doc-name union over
   *  structured artifact-locked events + legacy prose locks. */
  currentDocs(): Array<{ name: string; path: string; sha: string; producer: string }> {
    const names = new Set<string>();
    for (const [id, node] of this.nodes) {
      for (const e of node.events) {
        if (e.type !== 'artifact-locked') continue;
        const a = e.artifact;
        const filename = a?.path ? basename(a.path) : String(e?.note ?? '').match(/([\w.-]+\.md)/)?.[1] ?? '';
        const nm = a?.name ?? String(e?.note ?? '').match(/logical name:\s*([\w.-]+)/)?.[1] ?? logicalNameFromFile(filename);
        if (nm) names.add(nm);
      }
    }
    const out: Array<{ name: string; path: string; sha: string; producer: string }> = [];
    for (const name of [...names].sort()) {
      const c = this.current(name);
      if (c) out.push({ name, path: c.path, sha: c.sha ?? '', producer: c.producer });
    }
    return out;
  }

  /**
   * THE DOC RESOLUTION (docs → git): a logical doc name → its manifest entry → the
   * on-disk file's content sha. docs/ is git content; docs/manifest.json is the
   * committed RESOLUTION INDEX — a name the manifest serves resolves, and "current" is
   * the file at HEAD. This is the FORWARD path for docs (reads · requiredInputs ·
   * F-AC19 · the goal view). `current()` over artifact locks stays ONLY as a legacy
   * reader for archived/historical nodes — never the forward path. Returns undefined
   * when the manifest has no such name or the file is absent (a broken manifest entry
   * resolves to nothing; `docsIndexFresh` reports the drift).
   */
  resolveDoc(name: string): { name: string; path: string; sha: string } | undefined {
    // A 'journey'-kind store (an archived session) has NO docs/ home — the docs
    // manifest is the LIVE project's resolution index, never an archive's. Resolution
    // falls to the legacy current() locks (the caller's fallback). (Session-addressing.)
    if (this.kind === 'journey') return undefined;
    const rel = loadDocsManifest(this.root)[name];
    if (!rel) return undefined;
    const full = join(this.root, rel);
    if (!existsSync(full)) return undefined;
    const content = readFileSync(full, 'utf8');
    return { name, path: rel, sha: blobSha(stripMarkers(content)).slice(0, 7) };
  }

  /** Unwrap a node contract (defensive: legacy double-nested {contract:{contract:{…}}}). */
  /** The task's CONTRACT (unwrapped from node.json's {id, contract, createdAt} wrapper) —
   *  the single unwrap path for consumers (kernel, flow, validators). Derived read. */
  contractOf(id: string): Record<string, unknown> {
    const raw = this.contract(id) as { contract?: unknown } | undefined;
    const rawContract = (raw?.contract ?? {}) as Record<string, unknown>;
    return ((rawContract as { contract?: Record<string, unknown> }).contract ?? rawContract) as Record<string, unknown>;
  }

  /** F-AC19 (format v11 §2/§7) — the task contract checklist. PURE: usable at
   *  spawn (hard reject) and in check(). A contract fails when it is not
   *  self-sufficient: no intent, no acceptance criteria, or an input that does
   *  not resolve (via the docs manifest or a current artifact). Returns named
   *  problems (empty = passes). */
  contractProblems(contract: unknown): string[] {
    const problems: string[] = [];
    const c = contract as Record<string, unknown> | null | undefined;
    if (!c || typeof c !== 'object') return ['contract missing'];
    if (typeof c.intent !== 'string' || !c.intent.trim()) problems.push('intent missing/empty (what does the task do?)');
    const acs = c.acceptanceCriteria;
    if (!Array.isArray(acs) || acs.length === 0 || !acs.every((a) => typeof a === 'string' && a.trim())) {
      problems.push('acceptanceCriteria missing/empty (when is the task done?)');
    }
    const req = Array.isArray(c.requiredInputs) ? c.requiredInputs : [];
    for (const r of req) {
      if (typeof r !== 'string' || !r.trim()) {
        problems.push('requiredInputs entry is not a string');
        continue;
      }
      // A required input resolves through the DOCS MANIFEST (the forward path — a spec
      // authored in docs/) OR a CURRENT ARTIFACT (legacy: a doc locked under a task).
      if (!this.resolveDoc(r.trim()) && !this.current(r.trim())) {
        problems.push(`requiredInput '${r}' does not resolve (a docs manifest name or a current artifact's logical name)`);
      }
    }
    return problems;
  }

  /* ---------------------------------------------------------------- */
  /* results() — a task's result items (drives `ann results <id> [n]`). */
  /* Result kinds: doc (locked artifact) · commit · ref · evidence · link. */
  /* ---------------------------------------------------------------- */

  /** Gather a task's results from its log — one item per structured commit, per ref,
   *  per evidence event (format v10 §3/§14). Order: commits, then refs, then evidence.
   *  Machine-derived; never prose-parsed. (Docs are git content — a task's output doc
   *  resolves via the manifest + `read`, never through results.) */
  results(id: string): ResultItem[] {
    const out: ResultItem[] = [];
    const seen = new Set<string>();
    const push = (it: ResultItem) => {
      const key = `${it.kind}:${it.sha ?? it.path ?? it.url ?? it.note ?? ''}`;
      if (seen.has(key)) return; // dedupe repeated refs/commits cited by multiple evidence events
      seen.add(key);
      out.push(it);
    };
    const evs = this.events(id);
    // commits — structured evidence.commits[]
    for (const e of evs) {
      if (e.type !== 'evidence') continue;
      for (const c of Array.isArray(e.commits) ? e.commits : []) {
        const sha = (c as { sha?: unknown })?.sha;
        if (typeof sha !== 'string' || !sha) continue;
        push({ kind: 'commit', label: `${sha} — ${String((c as { note?: unknown })?.note ?? '')}`, sha, note: String((c as { note?: unknown })?.note ?? ''), at: e.at });
      }
    }
    // refs — structured evidence.refs[] (+ external links)
    for (const e of evs) {
      if (e.type !== 'evidence') continue;
      for (const r of Array.isArray(e.refs) ? e.refs : []) {
        if (typeof r !== 'string' || !r) continue;
        if (/^https?:\/\//.test(r)) push({ kind: 'link', label: r, url: r, at: e.at });
        else push({ kind: 'ref', label: r, path: r, at: e.at });
      }
    }
    // evidence events without structured commits/refs (informational)
    for (const e of evs) {
      if (e.type !== 'evidence') continue;
      const hasStructured = (Array.isArray(e.commits) && e.commits.length > 0) || (Array.isArray(e.refs) && e.refs.length > 0);
      if (hasStructured) continue;
      out.push({ kind: 'evidence', label: (e.note ?? '').slice(0, 90) + ((e.note?.length ?? 0) > 90 ? '…' : ''), note: e.note, at: e.at });    }
    return out;
  }

  /** Conclusion gate (v10/F-AC18): a parent may spawn children only after it has
   *  CONCLUDED — structured commit evidence (evidence.commits[] non-empty). Docs are
   *  git content: the evidence IS the publish of the staged doc, so the lock is gone.
   *  Machine-truth; never prose-parsed. */
  parentConcluded(parent: string): boolean {
    return this.events(parent).some((e) => e.type === 'evidence' && Array.isArray(e.commits) && e.commits.length > 0);
  }

  /* ---------------------------------------------------------------- */
  /* detail() — the full task/leg card (drives `ann detail <id>`).      */
  /* The store DERIVES; the CLI renders.                                */
  /* ---------------------------------------------------------------- */

  /** Full derived detail for one node — contract, gate states, artifacts (with
   *  current/superseded roles), event tail, blockers, leg tasks. */
  detail(id: string): TaskDetail {
    const evs = this.events(id);
    const gate = (name: string): DetailGate => {
      const last = [...evs]
        .reverse()
        .find((e) => ['submitted', 'confirmed', 'rejected'].includes(e.type) && e.gate === name);
      if (!last) return { state: 'none' };
      return { state: last.type as DetailGate['state'], at: last.at };
    };
    // unwrap the contract (defensive: legacy double-nested {contract:{contract:{…}}})
    const contract = this.contractOf(id);
    // artifacts — HISTORY ONLY (the record→disk files a retired flow left): docs are
    // git content now, so a lock is never a task's live output. Roles no longer derive
    // current/superseded — nothing forward reads an artifact.
    const artifacts: ArtifactRef[] = [];
    for (const e of evs) {
      if (e.type !== 'artifact-locked') continue;
      const a = e.artifact;
      const nm = a?.name ?? String(e.note ?? '').match(/logical name:\s*([\w.-]+)/)?.[1] ?? '';
      if (!nm) continue;
      const filename = a?.path ? basename(a.path) : String(e.note ?? '').match(/([\w.-]+\.md)/)?.[1] ?? '';
      const path = this.artifactPath(a?.path ?? `journey/legs/${id}/artifacts/${filename}`);
      artifacts.push({ name: nm, path, sha: a?.lockSha ?? '', role: 'historical' });
    }
    const blockers = evs
      .filter(
        (e) => e.type === 'submitted' && !evs.slice(evs.indexOf(e) + 1).some((x) => ['confirmed', 'rejected'].includes(x.type) && x.gate === e.gate),
      )
      .map((b) => `submitted (gate=${typeof b.gate === 'string' ? b.gate : '?'}) awaiting decision`);
    const detail: TaskDetail = {
      id,
      isLeg: !id.includes('/'),
      status: this.status(id),
      superseded: this.events(id).some((e) => e.type === 'superseded'),
      contract,
      gates: { grill: gate('grill'), confirm: gate('confirm') },
      artifacts,
      events: evs,
      blockers,
    };
    if (detail.isLeg) detail.tasks = this.tasksOf(id).map((t) => ({ id: t, status: this.status(t) }));
    return detail;
  }

  /** Commit traceability (format v10 §9/§14): every structured evidence.commits[].sha
   *  must resolve in git (`git cat-file -t`), every refs[] path must exist (repo-relative).
   *  git = the archive (format: git is the archive and source of truth). Never silent. */
  private commitTraceabilityProblems(): string[] {
    const problems: string[] = [];
    const repoRoot = process.cwd();
    for (const [id, node] of this.nodes) {
      for (const e of node.events) {
        if (e.type !== 'evidence') continue;
        for (const c of Array.isArray(e.commits) ? e.commits : []) {
          const sha = (c as { sha?: unknown })?.sha;
          if (typeof sha !== 'string' || !sha.trim()) {
            problems.push(`F-AC18: ${id} — evidence.commits[] entry without a sha (format v10 §9)`);
            continue;
          }
          try {
            execFileSync('git', ['cat-file', '-t', sha.trim()], { stdio: 'pipe' });
          } catch {
            problems.push(`F-AC18: ${id} — commit ${sha.trim()} does not resolve in git (traceability, format v10 §9)`);
          }
        }
        for (const ref of Array.isArray(e.refs) ? e.refs : []) {
          if (typeof ref !== 'string' || !existsSync(join(repoRoot, ref))) {
            problems.push(`F-AC18: ${id} — ref '${String(ref)}' does not exist (traceability, format v10 §9)`);
          }
        }
      }
    }
    return problems;
  }

  private lockers(name: string): string[] {
    const out: string[] = [];
    for (const [id, node] of this.nodes) {
      for (const e of node.events) {
        if (e.type !== 'artifact-locked') continue;
        const a = e.artifact;
        const filename = a?.path ? basename(a.path) : String(e.note ?? '').match(/([\w.-]+\.md)/)?.[1] ?? '';
        const nm =
          a?.name ??
          String(e.note ?? '').match(/logical name:\s*([\w.-]+)/)?.[1] ??
          logicalNameFromFile(filename);
        if (nm === name) out.push(id);
      }
    }
    return out;
  }

  /** Per-name superseded locks (format §3/§5): a superseded event's successor.name is
   *  THE artifact it supersedes — a multi-artifact producer's other locks stay current.
   *  Legacy prose superseded events (no structured successor) fall back to
   *  producer-level: every legacy producer locked exactly one artifact, so the two
   *  semantics coincide there. */
  private supersededLocks(name: string): Set<string> {
    const out = new Set<string>();
    for (const [id, node] of this.nodes) {
      for (const e of node.events) {
        if (e.type !== 'superseded') continue;
        const n = (e.successor as { name?: unknown } | undefined)?.name;
        if (typeof n === 'string') {
          if (n === name) out.add(id);
        } else {
          out.add(id); // legacy prose supersession — producer-level (single-lock era)
        }
      }
    }
    return out;
  }

  /* ══ v6 goal session — the designated childless goal leg ════════════════════ */

  /** The goal leg (goal-session-design §2): the frontmost `/`-less leg that is
   *  childless AND carries the goal seed/artifact — NOT any frontmost leg (a `01-goal`
   *  with children is an ordinary leg). Undefined = this journey has no goal yet
   *  (empty, or work legs only). The seed (`created`+`completed` root events) is what
   *  makes the leg identifiable; legacy-shaped childless goal legs (this repo's
   *  01-goal) match the same predicate. */
  goalLegId(): string | undefined {
    const legs = [...this.nodes.keys()].filter((n) => !n.includes('/')).sort();
    return legs.find((l) => this.carriesGoalSeed(l));
  }

  /** The goal-seed predicate: a childless leg carrying the goal seed —
   *  `created`+`completed` root events (the v6 goal shape → legStatus derives done,
   *  the first work leg's gate opens). The doc itself lives at docs/goal.md (git
   *  content, docs-as-git) and is NOT part of the predicate — a goal leg with no
   *  docs/goal.md yet (archive gap, pre-migration) is still the goal leg. */
  private carriesGoalSeed(id: string): boolean {
    if (this.tasksOf(id).length) return false; // a goal leg is CHILDLESS
    const evs = this.events(id);
    return evs.some((e) => e.type === 'created') && evs.some((e) => e.type === 'completed');
  }

  /** The id-scoped root-event exception (§2): the designated childless goal leg may
   *  hold `goal-met` through this predicate (the one-off migration meta record, D, is
   *  granted by goalRootMigrationEvent below — the two are the ONLY goal-root writes
   *  through the general writer; the seed is written by seedGoal, never here). Nothing
   *  else on any leg root. docs-as-git: there is no goal-root artifact-lock for the doc. */
  private goalRootEvent(id: string, e: JourneyEvent): boolean {
    if (id !== this.goalLegId()) return false;
    return e.type === 'goal-met';
  }

  /** The one-off migration meta record (docs-as-git refactor, Stage D): a NON-BUSINESS
   *  `evidence` event whose note is prefixed `meta-refactor:` (commits[] = the migration
   *  git sha) is allowed on the goal root EVEN POST-completed — the refactor records
   *  itself on the session that archived the moved docs. SELF-DISABLING: the allowance
   *  grants the FIRST such record only; a goal root that already holds a meta-refactor
   *  evidence refuses another (the migration happened once — a second is a new write of
   *  a retired bookkeeping act, not history). */
  private goalRootMigrationEvent(id: string, e: JourneyEvent): boolean {
    if (id !== this.goalLegId()) return false;
    if (e.type !== 'evidence' || typeof e.note !== 'string' || !e.note.startsWith('meta-refactor:')) return false;
    return !this.events(id).some((x) => x.type === 'evidence' && typeof x.note === 'string' && x.note.startsWith('meta-refactor:'));
  }

  /** v6 seed: a new session's goal leg. goal.md (fixed Goal:/Success criteria: sections)
   *  is the authored truth; node.json is generated 1:1 from it (the machine reads it);
   *  the `created`+`completed` seed events make legStatus derive done so the first work
   *  leg's legGateMet opens. A goal seeds the FIRST leg of an EMPTY journey only (a
   *  changed goal is a new session — archive first; re-seeding a SOLE UNCONSUMED goal is
   *  reseedGoal below, never seedGoal). The seed writes flow through the store's own
   *  write path + ledger (recordWrite) so verify stays clean from the first write.
   *  docs-as-git (D7): the authored doc is written to docs/goal.md (git content) + the
   *  manifest regenerated — there is NO goal-root artifact-lock; publishing the doc is
   *  the operator's git commit. */
  seedGoal(doc: string): { id: string; contract: { intent: string; acceptanceCriteria: string[] } } {
    this.assertWritable('seedGoal');
    if (this.nodes.size) throw new Error('seedGoal rejected: the journey is not empty — a goal seeds the first leg of an empty session (archive first)');
    if (this.goalLegId()) throw new Error('seedGoal rejected: a goal leg already exists');
    const parsed = this.parseGoalDoc(doc);
    const id = '01-goal';
    const today = new Date().toISOString().slice(0, 10);
    const dir = this.nodeFolder(id);
    this.writeGoalDoc(doc);
    mkdirSync(dir, { recursive: true }); // the goal leg's own folder (no artifacts/ subdir)
    const nodeJson = JSON.stringify({ id, contract: parsed, createdAt: today }, null, 2) + '\n';
    writeFileSync(join(dir, 'node.json'), nodeJson);
    const seed: JourneyEvent[] = [
      { at: today, type: 'created', note: 'goal seeded — the session starts by grilling the goal' },
      { at: today, type: 'completed', note: 'goal grilled & recorded — success criteria sealed when the operator commits docs/goal.md' },
    ];
    writeFileSync(join(dir, 'events.jsonl'), seed.map((e) => JSON.stringify(e)).join('\n') + '\n');
    this.nodes.set(id, { id, events: seed });
    this.recordWrite(id, nodeJson); // events come from the in-memory log → bytes match the file
    return { id, contract: parsed };
  }

  /** v6 re-seed (the RE-SEEDABLE rule): REPLACE the freshly-seeded, UNCONSUMED goal leg
   *  IN PLACE — docs/goal.md is overwritten with the new doc + the manifest regenerated,
   *  node.json is regenerated 1:1 from it, and the seed events are rewritten. Refused
   *  unless the goal leg is the journey's ONLY node and carries no goal-met verdict —
   *  the guard that makes this immutability break safe: nothing has spawned under/after
   *  the goal and nothing has derived from the doc, so replacing it orphans nothing
   *  (goal-session-design §1/§2). */
  reseedGoal(doc: string): { id: string; contract: { intent: string; acceptanceCriteria: string[] } } {
    this.assertWritable('reseedGoal');
    const goalId = this.goalLegId();
    if (!goalId || this.nodes.size !== 1 || !this.nodes.has(goalId)) {
      throw new Error('reseedGoal rejected: a goal re-seeds only while it is the journey\'s SOLE unconsumed node — archive the consumed session and seed a new goal');
    }
    if (this.events(goalId).some((e) => e.type === 'goal-met')) {
      throw new Error('reseedGoal rejected: the goal is met/sealed — a changed goal is a new session (archive first)');
    }
    const parsed = this.parseGoalDoc(doc);
    const today = new Date().toISOString().slice(0, 10);
    const dir = this.nodeFolder(goalId);
    this.writeGoalDoc(doc);
    mkdirSync(dir, { recursive: true }); // the goal leg's own folder (no artifacts/ subdir)
    const nodeJson = JSON.stringify({ id: goalId, contract: parsed, createdAt: today }, null, 2) + '\n';
    writeFileSync(join(dir, 'node.json'), nodeJson);
    const seed: JourneyEvent[] = [
      { at: today, type: 'created', note: 'goal re-seeded — the goal was replaced by a fresh grill' },
      { at: today, type: 'completed', note: 'goal re-grilled & recorded — success criteria sealed when the operator commits docs/goal.md' },
    ];
    writeFileSync(join(dir, 'events.jsonl'), seed.map((e) => JSON.stringify(e)).join('\n') + '\n');
    this.nodes.set(goalId, { id: goalId, events: seed });
    this.recordWrite(goalId, nodeJson); // events come from the in-memory log → bytes match the file
    return { id: goalId, contract: parsed };
  }

  /** docs-as-git (D7): the authored goal doc lives at docs/goal.md (git content) —
   *  write it and regenerate the manifest so resolveDoc('goal') serves it. No
   *  goal-root artifact-lock (the write path itself stays the node.json/events one). */
  private writeGoalDoc(doc: string): void {
    const dir = join(this.root, 'docs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'goal.md'), doc);
    writeDocsManifest(this.root, scanDocsDir(this.root));
  }

  /** v6 archive: move the finished session's legs + the write-rev ledger to
   *  `.ann/archive/sessions/<ts>-<slug>/journey/{legs, .ledger.json}` — a faithful
   *  snapshot that round-trips Store() for read-only loads. The LIVE ledger entry is
   *  removed (else verify reports node-deleted) and the in-memory tree resets to an
   *  empty journey — id reuse across sessions is then safe. */
  archiveJourney(slug: string): { at: string; dest: string } {
    this.assertWritable('archive');
    const ts = new Date().toISOString().replace(/[:.]/g, '-'); // dir-safe ISO stamp
    const dir = join(this.root, '.ann', 'archive', 'sessions', `${ts}-${slug}`, 'journey');
    mkdirSync(join(dir, 'legs'), { recursive: true });
    if (existsSync(this.legs)) {
      for (const name of readdirSync(this.legs)) {
        renameSync(join(this.legs, name), join(dir, 'legs', name));
      }
    }
    const ledgerFile = join(this.journeyDir, '.ledger.json');
    if (existsSync(ledgerFile)) renameSync(ledgerFile, join(dir, '.ledger.json'));
    mkdirSync(this.legs, { recursive: true }); // an empty live legs root stays — Store() loads clean
    // docs-as-git (D7): the archived session's goal doc leaves the LIVE docs/ home (git
    // history + the archive keep it) and the manifest is regenerated so the next seed
    // starts clean — resolveDoc('goal') resolves nothing until the next seed writes it.
    if (existsSync(join(this.root, 'docs', 'goal.md'))) {
      rmSync(join(this.root, 'docs', 'goal.md'));
      writeDocsManifest(this.root, scanDocsDir(this.root));
    }
    // reset the live store: empty journey, no ledger baseline
    this.nodes.clear();
    this.unparseableNodes.clear();
    this.ledger = undefined;
    return { at: ts, dest: dir };
  }

  /** goal.md → contract (goal-session-design §1/§2): the `Goal:` line is the intent;
   *  the bullet list under `Success criteria:` are the acceptance criteria. This is the
   *  1:1 doc→node mapping (a doc change = a new session, so seedGoal writes both). */
  private parseGoalDoc(doc: string): { intent: string; acceptanceCriteria: string[] } {
    const goal = (doc.match(/^#{0,6}\s*[#*]*\s*Goal\s*[#*]*:\s*(.+)$/m) || [])[1];
    const body = doc.split(/^#{0,6}\s*[#*]*\s*Success criteria\s*[#*]*:/m)[1] ?? '';
    const criteria = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[-*]\s+/.test(l))
      .map((l) => l.replace(/^[-*]\s+/, '').trim())
      .filter(Boolean);
    if (!goal || !goal.trim()) throw new Error("seedGoal rejected: goal.md must carry a 'Goal:' line (the intent)");
    if (!criteria.length) throw new Error("seedGoal rejected: goal.md must carry a 'Success criteria:' bullet list");
    return { intent: goal.trim(), acceptanceCriteria: criteria };
  }

  /**
   * THE single write path (LB-3): validate schema against the vocab registry,
   * gate-check the prospective log, append only when clean — fail-closed.
   *
   * Write confinement (AC-2): the event goes to the ADDRESSED node only — the handle
   * mints the one write target (`join(node.dir, 'events.jsonl')`), so a caller can
   * never aim an append at a sibling, a parent, or the store root.
   */
  appendEvent(node: NodeDir, event: JourneyEvent): void {
    this.assertWritable('append');
    // v6 goal session (goal-session-design §2): the designated childless goal leg is
    // the ONE leg root that may carry events — the seed (`created`/`completed`, written
    // by seedGoal, never through the general append), `goal-met`, and the one-off
    // migration meta record (goalRootMigrationEvent, self-disabling — Stage D).
    // Everything else on a leg root stays refused (v8 §3). docs-as-git: the goal doc is
    // docs/goal.md, so a leg root never holds an artifact-lock (there is no goal-root seal).
    if (!node.id.includes('/') && !this.goalRootEvent(node.id, event) && !this.goalRootMigrationEvent(node.id, event)) {
      throw new Error(`append rejected: leg roots carry no events (v8 §3) — record process facts on tasks`);
    }
    // goal-met is a goal-root VERDICT — never on a task id or a non-goal leg root (the
    // leg-root guard above already refuses the latter; this catches task ids).
    if (event.type === 'goal-met' && node.id !== this.goalLegId()) {
      throw new Error(`append rejected: goal-met is a goal-root verdict — refused on ${node.id}`);
    }
    if (!event.at || !event.type || !getVOCAB().eventTypes.includes(event.type)) {
      throw new Error(`append rejected: bad schema (at + known type required, got ${event.type})`);
    }
    this.validateEventShape(event); // strict schema (format v12 §3): unknown fields + shapes rejected
    const entry = this.nodes.get(node.id);
    if (!entry) throw new Error(`append rejected: no node ${node.id}`);
    // The ledger guard — fail-closed, AFTER schema (a bad incoming event still gets its
    // schema error) but BEFORE gate work (ann never computes gates over a store state it
    // does not recognize). If the on-disk node diverged from what ann last wrote, the
    // write is refused and the ledger never advances past the external edit (no masking).
    const drift = this.ledgerDivergence(node.id);
    this.assertLedgerReadable(); // before any data write — an unreadable ledger refuses everything
    if (drift) {
      throw new StoreExternalEditError(`append rejected: store-external edit on ${node.id} — ${drift}. Run 'ann verify' to diff; ann never writes on a state it does not recognize.`);
    }
    const prospective = [...entry.events, event];
    const gaps = this.gateProblems(node.id, prospective);
    if (gaps.length) throw new Error(gaps.join('\n'));
    appendFileSync(join(node.dir, 'events.jsonl'), JSON.stringify(event) + '\n');
    entry.events = prospective;
    this.recordWrite(node.id);
  }

  /* ══ THE STORE WRITE-REV LEDGER (.ann/journey/.ledger.json) — the store-external
   *   integrity guard. ann records its own last-known state per node after every
   *   write; verify() diffs the disk against it and the write guard refuses to build
   *   on (or bless) an unrecognized state. Purely additive: only the ledger is
   *   written here — events.jsonl/node.json are never modified. */

  /** Fail-closed: ann never writes without a readable integrity record (an unreadable
   *  ledger means ann cannot verify the state it is about to build on). */
  private assertLedgerReadable(): void {
    if (this.ledgerCorrupt) {
      throw new LedgerError('ledger-corrupt: .ann/journey/.ledger.json is unparseable — run \'ann verify\' (ann refuses to write without a readable integrity record)');
    }
  }

  /** undefined = clean (no baseline, or disk matches the ledger); a string = why the
   *  node's on-disk state is unrecognized. Byte comparison against what ann last wrote.
   *  A MISSING events.jsonl reads as '' — a spawned leg's ledger eventsContent is ''
   *  (a leg has no events.jsonl at all), so the first goal-root write on a spawned leg
   *  must not trip `null !== ''` (v6). Verify()'s separate loop keeps its own
   *  missing-vs-empty reporting (null vs ''). */
  private ledgerDivergence(id: string): string | undefined {
    const entry = this.ledger?.nodes?.[id];
    if (!entry) return undefined; // no baseline — a first write (or fixture node) is clean
    const ev = join(this.legs, id, 'events.jsonl');
    const evDisk = existsSync(ev) ? readFileSync(ev, 'utf8') : '';
    if (evDisk !== entry.eventsContent) {
      return `events.jsonl differs from the ledger (ann wrote rev ${entry.lastRev} at ${entry.lastEventAt})`;
    }
    const nd = join(this.legs, id, 'node.json');
    const ndDisk = existsSync(nd) ? readFileSync(nd, 'utf8') : null;
    if (ndDisk !== entry.nodeContent) {
      return `node.json differs from the ledger (ann wrote rev ${entry.lastRev} at ${entry.lastEventAt})`;
    }
    return undefined;
  }

  /** Record ann's last-known state for a node (post-write). Events come from the
   *  in-memory log (canonical serialization is byte-identical to the file — V8 order is
   *  insertion order); node.json content is passed by spawn (what ann wrote) or carried
   *  from the prior entry, so the steady state never re-reads. */
  private recordWrite(id: string, nodeContent?: string): void {
    this.assertLedgerReadable();
    if (!this.ledger) this.ledger = { rev: 0, bootstrappedAt: new Date().toISOString(), nodes: {} };
    const node = this.nodes.get(id);
    // Empty logs serialize to '' (a leg has no events.jsonl at all) — never '\n'.
    const eventsContent = node && node.events.length ? node.events.map((e) => JSON.stringify(e)).join('\n') + '\n' : '';
    const prev = this.ledger.nodes[id];
    const nodeContentFinal =
      nodeContent ??
      prev?.nodeContent ??
      (existsSync(join(this.legs, id, 'node.json')) ? readFileSync(join(this.legs, id, 'node.json'), 'utf8') : '');
    this.ledger.rev += 1;
    this.ledger.nodes[id] = {
      eventsContent,
      nodeContent: nodeContentFinal,
      eventsSha: blobSha(eventsContent),
      nodeSha: blobSha(nodeContentFinal),
      lastEventAt: node && node.events.length ? (node.events[node.events.length - 1].at ?? '') : '',
      lastRev: this.ledger.rev,
    };
    this.writeLedger();
  }

  /** Atomic ledger write (tmp + rename — a reader never sees a partial ledger). */
  private writeLedger(): void {
    const p = join(this.journeyDir, '.ledger.json');
    mkdirSync(this.journeyDir, { recursive: true });
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.ledger, null, 2) + '\n');
    renameSync(tmp, p);
  }

  /** STRICT SCHEMA (format v12 §3): the allowed top-level fields per event type and
   *  the structured field shapes. Unknown fields or malformed shapes are REJECTED at
   *  the single writer — fail-closed, never let garbage into the log. Legacy prose
   *  events (no structured artifact/successor) remain valid HISTORY; this guards new writes. */
  private validateEventShape(e: JourneyEvent): void {
    const allowed: Record<string, string[]> = {
      created: ['at', 'type', 'note'],
      activated: ['at', 'type', 'note'],
      extended: ['at', 'type', 'note'],
      evidence: ['at', 'type', 'note', 'commits', 'refs', 'answers', 'trace'],
      'artifact-locked': ['at', 'type', 'note', 'artifact'],
      completed: ['at', 'type', 'note'],
      failed: ['at', 'type', 'note'],
      waiting: ['at', 'type', 'note'],
      superseded: ['at', 'type', 'note', 'successor'],
      submitted: ['at', 'type', 'note', 'gate', 'confirmedSha'],
      confirmed: ['at', 'type', 'note', 'gate', 'feedback'],
      rejected: ['at', 'type', 'note', 'gate', 'feedback'],
      'gate-revised': ['at', 'type', 'note', 'gate'],
      transferred: ['at', 'type', 'note', 'target', 'scope'],
      deferred: ['at', 'type', 'note', 'reason'],
      // leg 08 task 01: `cancelled` records WHY the task is no longer needed — the reason
      // is REQUIRED (checked below), so a cancellation is never a silent disappearance.
      cancelled: ['at', 'type', 'note', 'reason'],
      'goal-met': ['at', 'type', 'note', 'decision', 'feedback'],
    };
    const unknown = Object.keys(e).filter((k) => !(allowed[e.type] ?? []).includes(k));
    if (unknown.length) throw new Error(`append rejected: unknown field(s) '${unknown.join(', ')}' on ${e.type} (strict schema, format v12 §3)`);
    if (e.type === 'cancelled') {
      // The reason is the record's whole point (a task marked no longer needed must say
      // why); fail-closed rather than let a bare cancellation into the log.
      if (typeof e.reason !== 'string' || !e.reason.trim()) {
        throw new Error("append rejected: cancelled requires a reason (a non-blank 'reason' field — why the task is no longer needed)");
      }
    }
    if (e.type === 'goal-met') {
      // v6 (goal-session-design §4): the verdict is 'met' only — a recorded human call.
      if (e.decision !== 'met') throw new Error("append rejected: goal-met.decision must be 'met'");
      if (e.feedback !== undefined && typeof e.feedback !== 'string') throw new Error('append rejected: goal-met.feedback must be a string');
    }
    if (e.type === 'submitted' || e.type === 'confirmed' || e.type === 'rejected') {
      if (typeof e.gate !== 'string' || !getVOCAB().gates.includes(e.gate)) {
        throw new Error(`append rejected: ${e.type}.gate must be one of ${getVOCAB().gates.join('|')}`);
      }
      // G1: gate accept persists the human's rationale as `feedback` on the confirmed
      // event (rejected already records it) — both must be strings when present.
      if ((e.type === 'rejected' || e.type === 'confirmed') && e.feedback !== undefined && typeof e.feedback !== 'string') {
        throw new Error(`append rejected: ${e.type}.feedback must be a string`);
      }
      // v14 §3: the gate②-to-commit content binding — submit!(confirm) records the
      // working artifact's blob sha over MARKER-STRIPPED content; commit refuses on mismatch.
      if (e.type === 'submitted' && e.confirmedSha !== undefined && (typeof e.confirmedSha !== 'string' || !/^[0-9a-f]{7,40}$/.test(e.confirmedSha))) {
        throw new Error('append rejected: submitted.confirmedSha must be a blob sha (7-40 hex, v14 §3)');
      }
    }
    if (e.type === 'gate-revised') {
      const g = e.gate as { old?: unknown; new?: unknown } | undefined;
      if (!g || typeof g !== 'object' || typeof g.old !== 'string' || typeof g.new !== 'string') {
        throw new Error('append rejected: gate-revised.gate must be {old, new}');
      }
    }
    if (e.type === 'artifact-locked' && e.artifact !== undefined) {
      const a = e.artifact as { name?: unknown; path?: unknown; lockSha?: unknown; type?: unknown; version?: unknown };
      if (!a || typeof a !== 'object' || typeof a.name !== 'string' || !a.name || typeof a.path !== 'string' || !a.path) {
        throw new Error('append rejected: artifact-locked.artifact must be {name, path, lockSha?, type?, version?}');
      }
      if (a.lockSha !== undefined && typeof a.lockSha !== 'string') throw new Error('append rejected: artifact.lockSha must be a string');
      if (a.type !== undefined && typeof a.type !== 'string') throw new Error('append rejected: artifact.type must be a string');
      if (a.version !== undefined && typeof a.version !== 'number') throw new Error('append rejected: artifact.version must be a number');
    }
    if (e.type === 'superseded' && e.successor !== undefined) {
      const s = e.successor as { name?: unknown; path?: unknown };
      if (!s || typeof s !== 'object' || typeof s.name !== 'string' || !s.name || typeof s.path !== 'string' || !s.path) {
        throw new Error('append rejected: superseded.successor must be {name, path}');
      }
    }
    if (e.type === 'evidence') {
      // commits[] is the CONCLUSION shape (F-AC18): when present it is non-empty and every
      // entry names a commit. An empty commit list concludes nothing — refuse it here so
      // the single writer is the one place the shape lives (leg 08 task 02).
      if (e.commits !== undefined && (!Array.isArray(e.commits) || !e.commits.length || !e.commits.every((c) => typeof (c as { sha?: unknown })?.sha === 'string' && (c as { sha: string }).sha))) {
        throw new Error('append rejected: evidence.commits must be a non-empty [{sha, note?}, …] — an empty commit list concludes nothing');
      }
      if (e.refs !== undefined && (!Array.isArray(e.refs) || !e.refs.every((r) => typeof r === 'string'))) {
        throw new Error('append rejected: evidence.refs must be [path, …]');
      }
      // answer-recording primitive (high-impact-defaulted): answers [{id, answer, provenance?}]
      if (e.answers !== undefined && (!Array.isArray(e.answers) || !e.answers.every((a) => typeof (a as { id?: unknown })?.id === 'string' && typeof (a as { answer?: unknown })?.answer === 'string'))) {
        throw new Error('append rejected: evidence.answers must be [{id, answer, provenance?}, …]');
      }
      if (e.trace !== undefined) this.validateTrace(e.trace);
    }
    if (e.type === 'transferred' && (typeof e.target !== 'string' || typeof e.scope !== 'string')) {
      throw new Error('append rejected: transferred.target and .scope must be strings');
    }
    if (e.type === 'deferred' && typeof e.reason !== 'string') {
      throw new Error('append rejected: deferred.reason must be a string');
    }
  }

  /** THE TRANSCRIPT'S SHAPE (v14 §3, core-design §2): an `evidence` event may carry a
   *  structured `trace` record — machine-truth, never prose. SIX kinds on one discriminant:
   *  the FOUR step-level kinds (llm · ask · research · decide), keyed (stepId, runId, seq)
   *  — the replay key; and TWO frame-phase kinds — `verify` {cycle} (NO stepId: a verify
   *  cycle belongs to the frame) and `skip` {stepId, condition, evaluated:false} (NO cycle:
   *  a skip is step-keyed, NFR-OBS-1). Shape-policed at the single writer, fail-closed. */
  private validateTrace(t: unknown): void {
    const r = t as Record<string, unknown>;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('append rejected: evidence.trace must be an object (v14 §3)');
    const allowed: Record<string, string[]> = {
      llm: ['kind', 'stepId', 'runId', 'seq', 'prompt', 'completion'],
      ask: ['kind', 'stepId', 'runId', 'seq', 'question', 'answer'],
      research: ['kind', 'stepId', 'runId', 'seq', 'question', 'research'],
      decide: ['kind', 'stepId', 'runId', 'seq', 'question', 'answer', 'options'],
      verify: ['kind', 'cycle'],
      skip: ['kind', 'stepId', 'condition', 'evaluated'],
    };
    const kind = r.kind;
    if (typeof kind !== 'string' || !(kind in allowed)) {
      throw new Error(`append rejected: evidence.trace.kind must be one of ${Object.keys(allowed).join('|')} (v14 §3)`);
    }
    const unknown = Object.keys(r).filter((k) => !allowed[kind].includes(k));
    if (unknown.length) throw new Error(`append rejected: evidence.trace unknown field(s) '${unknown.join(', ')}' on kind '${kind}' (v14 §3)`);
    if (kind === 'verify') {
      if (typeof r.cycle !== 'number') throw new Error('append rejected: trace kind:verify must carry {cycle} — a frame-phase record, no stepId (v14 §3)');
      return;
    }
    if (kind === 'skip') {
      if (typeof r.stepId !== 'string' || !r.stepId || typeof r.condition !== 'string' || r.evaluated !== false) {
        throw new Error('append rejected: trace kind:skip must be {stepId, condition, evaluated:false} — step-keyed, no cycle (v14 §3)');
      }
      return;
    }
    // the four STEP-LEVEL kinds — (stepId, runId, seq) IS the replay key
    if (typeof r.stepId !== 'string' || !r.stepId) throw new Error(`append rejected: trace kind:${kind} must carry a stepId (the replay key)`);
    if (typeof r.runId !== 'number' || typeof r.seq !== 'number') throw new Error(`append rejected: trace kind:${kind} must carry numeric runId + seq (the replay key)`);
    if (kind === 'research') {
      const rs = r.research;
      if (!Array.isArray(rs) || !rs.every((x) => typeof (x as { topic?: unknown })?.topic === 'string' && typeof (x as { findings?: unknown })?.findings === 'string')) {
        throw new Error('append rejected: trace kind:research.research must be [{topic, findings, sources?[]}, …] — an ARRAY with per-topic sources (v14 §3)');
      }
    }
    if (kind === 'decide' && !Array.isArray(r.options)) {
      throw new Error('append rejected: trace kind:decide must carry options[] — replay-by-identity needs them (v14 §3)');
    }
  }

  /** Spawn a node: write the immutable creation record, then the `created` event
   *  through appendEvent (every event write flows through the single writer).
   *  Leg roots get NO events at all (v8 §13) — only node.json + the card. */
  spawn(id: string, contract: unknown, who = 'agent'): void {
    this.assertWritable('spawn');
    if (this.nodes.has(id)) throw new Error(`spawn rejected: ${id} already exists (node.json immutable — no re-spawn)`);
    this.assertLedgerReadable();
    // Fail-closed: a ledger-tracked node that is no longer on disk is an external
    // deletion — refuse to silently re-bless it (the store only changes through the CLI).
    if (this.ledger?.nodes?.[id]) {
      throw new StoreExternalEditError(`spawn rejected: ${id} is tracked in the ledger but no longer exists on disk (external deletion?). Run 'ann verify'.`);
    }
    // normalize: accept the contract directly, or a wrapped {contract:{…}} (spawn-arg convenience)
    const raw = (contract ?? {}) as Record<string, unknown>;
    const c = ((raw.contract ?? raw) ?? {}) as Record<string, unknown>;
    // format v14 §2: openQuestions is a TOP-LEVEL SIBLING of contract, never a contract
    // field — lift it out wherever the caller put it (the packet assembler reads it there).
    const { openQuestions: nested, ...contractFields } = c;
    const openQuestions = raw.openQuestions ?? nested;
    // Write confinement (AC-1/AC-2): the folder derives from the store's own legs
    // root (nodeFolder normalizes + refuses an escape), and the `created` event flows
    // through the single writer on a handle — spawn itself never joins a raw id+path.
    // The node's own folder is created here (a fresh id has no folder yet); only the
    // `artifacts/` subdir is not pre-made — outputs are docs at the repo's docs/ home.
    const dir = this.nodeFolder(id);
    mkdirSync(dir, { recursive: true });
    const nodeJson =
      JSON.stringify(
        { id, contract: contractFields, ...(openQuestions ? { openQuestions } : {}), createdAt: new Date().toISOString().slice(0, 10) },
        null,
        2,
      ) + '\n';
    writeFileSync(join(dir, 'node.json'), nodeJson);
    this.nodes.set(id, { id, events: [] });
    if (id.includes('/')) {
      this.appendEvent(new NodeDirImpl(id, dir), { at: new Date().toISOString().slice(0, 10), type: 'created', note: `spawned by bookkeeper (${who})` });
    }
    // record the exact bytes ann wrote — the ledger never re-reads node.json on spawn
    this.recordWrite(id, nodeJson);
  }

  /** GATE-1/GATE-2 (F-AC15): tasks only — leg roots carry no events (v8).
   *
   *  UNCONDITIONAL (core-design §1, §7): this reads no `createdAt` — the writer refuses
   *  gate-skipping writes on every task, always. The v13-era PROSE ESCAPES are REMOVED:
   *  the `gate` value comes from the STRUCTURED field only (no note-regex derivation, no
   *  empty-gate fallback that let a bare `confirmed` count as gate②), and the
   *  `retrospective`-note suppression of the GATE-1 gap is gone. Both were legacy-only;
   *  the pre-cutoff tasks that carry them are grandfathered at CHECK-REPORTING (check()),
   *  never at the writer. */
  gateProblems(id: string, evs?: JourneyEvent[]): string[] {
    const problems: string[] = [];
    if (!id.includes('/')) return problems;
    const list = evs ?? this.events(id);
    let lastComplete = -1,
      lastConfirm2 = -1,
      firstWork = -1,
      lastConfirm1 = -1;
    list.forEach((e, i) => {
      const gate = typeof e.gate === 'string' ? e.gate : '';
      if (e.type === 'completed') lastComplete = i;
      if (e.type === 'artifact-locked' || e.type === 'completed') {
        if (firstWork === -1) firstWork = i;
      }
      if (e.type === 'confirmed' && gate === 'confirm') lastConfirm2 = i;
      if (e.type === 'confirmed' && gate === 'grill') lastConfirm1 = i;
    });
    if (lastComplete >= 0 && lastConfirm2 === -1) {
      problems.push(`GATE-2 GAP: ${id} — completed but no confirmed(gate=confirm) recorded`);
    }
    if (firstWork >= 0 && (lastConfirm1 === -1 || lastConfirm1 > firstWork)) {
      problems.push(`GATE-1 GAP: ${id} — produced work (artifact-locked/completed) but no confirmed(gate=grill) before it`);
    }
    // flow-control v4 §3: gates are SEQUENTIAL — a confirm-gate with NO confirmed grill ever
    // = GATE① skipped. (Recording order may be retrospective — the write path enforces strict
    // order; the check only catches a truly missing grill.)
    const confirmIdx = list.findIndex((e) => (e.type === 'submitted' || e.type === 'confirmed') && e.gate === 'confirm');
    const grillIdx = list.findIndex((e) => e.type === 'confirmed' && e.gate === 'grill');
    if (confirmIdx >= 0 && grillIdx === -1) {
      problems.push(`GATE-SEQ GAP: ${id} — confirm gate recorded but no confirmed(gate=grill) ever (flow-control v4 §3)`);
    }
    return problems;
  }

  /** Integrity check: gate gaps + closure integrity (F-AC16) + F-AC18 conclusion +
   *  commit-traceability + contract self-sufficiency (F-AC19). Leg-level events are
   *  INERT by design (v8): they are parsed for display and resolution only, never read
   *  for status and never policed — the write path (spawn) is what keeps new leg roots
   *  free of events. (Doc integrity is check's commit traceability + the manifest
   *  freshness read — artifact files are no longer policed.) */
  check(): string[] {
    const problems: string[] = [];
    // THE CUTOFF grandfathers the legacy prose-gate era at CHECK-REPORTING only
    // (core-design §1): gateProblems itself is unconditional — the writer refuses
    // gate-skipping on every task — but the 19 measured pre-cutoff tasks whose gates
    // were recorded in prose (or retrospectively) are not re-litigated by the check.
    for (const id of this.nodes.keys()) {
      if (this.grandfathered(id)) continue;
      for (const p of this.gateProblems(id)) problems.push(p);
    }
    // F-AC16 closure invariants: completed-after-gate-revised requires transferred|deferred;
    // transferred targets must exist. Tasks only (leg roots carry no events by construction).
    const allIds = new Set(this.nodes.keys());
    for (const [id, node] of this.nodes) {
      if (!id.includes('/')) continue;
      let revised = -1,
        completed = -1,
        closureOk = false;
      const targets: string[] = [];
      node.events.forEach((e, i) => {
        if (e.type === 'gate-revised') revised = i;
        if (e.type === 'completed') completed = i;
        if (e.type === 'transferred' || e.type === 'deferred') closureOk = true;
        if (e.type === 'transferred' && e.target) targets.push(e.target);
      });
      if (revised >= 0 && completed > revised && !closureOk) {
        problems.push(`${id}: gate-revised but closed without transferred/deferred (F-AC16)`);
      }
      for (const t of targets) {
        if (!allIds.has(t)) problems.push(`${id}: transferred target '${t}' does not exist (F-AC16)`);
      }
    }
    // F-AC18 (v9; v10/this leg amended): every task SPAWNED under v9 that completes must
    // have concluded — structured commit evidence (evidence.commits[], format v10 §3/§14).
    // Docs are git content: the commit evidence IS the conclusion (the lock is retired).
    // Grandfathered: tasks spawned before the v9 migration (createdAt < cutoff) are
    // exempt — the one-time hot fix, never a live rule on history.
    for (const [id, node] of this.nodes) {
      if (!id.includes('/')) continue;
      if (!node.events.some((e) => e.type === 'completed')) continue;
      if (this.parentConcluded(id)) continue;
      if (!this.grandfathered(id)) {
        problems.push(`F-AC18: ${id} — completed without structured commit evidence (evidence.commits[]; docs are git content — commit the staged doc + record the evidence)`);
      }
    }
    // F-AC18 traceability (format v10 §9/§14): structured commits[] must RESOLVE in
    // git and refs[] paths must exist. Machine-truth — never prose-parsed (NFR-COM-1).
    problems.push(...this.commitTraceabilityProblems());
    // F-AC19 (v11) — contract self-sufficiency (the §2 checklist): v9+ nodes only
    // (pre-v9 contracts grandfathered, same cutoff as F-AC18).
    for (const id of this.nodes.keys()) {
      if (!id.includes('/')) continue;
      if (this.grandfathered(id)) continue;
      for (const p of this.contractProblems(this.contractOf(id))) problems.push(`F-AC19: ${id} — ${p}`);
    }
    return problems;
  }

  /* ---------------------------------------------------------------- */
  /* verify() — the DRIFT reconciliation (`ann verify`). READ-ONLY.     */
  /* Internal drift is impossible (ONE writer, LB-3) — drift is always  */
  /* log-vs-filesystem/git: a recorded claim whose on-disk reality      */
  /* changed. Doc-artifact checks retired — see the verify() doc.       */
  /* ---------------------------------------------------------------- */

  /** Every subdir under a root (not following symlinks) — the disk walk for D4. */
  private walkDirs(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (!lstatSync(p).isSymbolicLink() && statSync(p).isDirectory()) {
        acc.push(p);
        this.walkDirs(p, acc);
      }
    }
    return acc;
  }

  /**
   * Drift reconciliation — the LOG's claims vs filesystem/git reality. One string
   * per drift, prefixed with the check kind; empty = the store and the disk agree.
   * KEPT: the legs/-tree shape (node-orphan, node-id-mismatch) · store-external
   * (write-rev ledger) · unparseable-events. RETIRED with the doc-artifact flow:
   * record→disk existence, lockSha-vs-file, and the artifacts/-orphan checks — docs
   * are git content at docs/ now, and their drift is the operator's own commit, which
   * check()'s commit-traceability + the manifest-freshness read name. Never writes.
   */
  verify(): string[] {
    const problems: string[] = [];
    const root = this.root;
    // D4 (kept scope) — the MIRROR direction: walk the disk, not the store, for the
    // node.json/events.jsonl shape. Store.load() keys on node.json ONLY — a bare
    // events.jsonl dir is invisible to the store today, so this walk must not rely on
    // ids() alone. artifacts/ subdirs are INERT to it (left by the retired flow, never
    // policed — their docs moved to docs/).
    for (const d of this.walkDirs(this.legs)) {
      const rel = d.slice(this.legs.length + 1);
      const hasNode = existsSync(join(d, 'node.json'));
      const hasEv = existsSync(join(d, 'events.jsonl'));
      if (hasEv && !hasNode) problems.push(`node-orphan: ${rel} — events.jsonl vs node.json (invisible to the store — load keys on node.json)`);
      if (hasNode && !hasEv && rel.includes('/')) problems.push(`node-orphan: ${rel} — node.json vs events.jsonl (a task dir with no log)`);
      if (hasNode) {
        let id = '';
        try {
          id = String((JSON.parse(readFileSync(join(d, 'node.json'), 'utf8')) as { id?: unknown }).id ?? '');
        } catch { /* unparseable node.json — the id mismatch below reports it */ }
        if (id !== rel) problems.push(`node-id-mismatch: ${rel} — node.json id '${id}' vs directory path`);
      }
    }
    /* ══ store-external — the write-rev ledger integrity: a node's on-disk
     *   events.jsonl/node.json vs what ann last wrote. Runs only when the ledger
     *   exists (lazy bootstrap — a legacy store has no baseline and skips entirely,
     *   so verify is unchanged until the first CLI write creates one). */
    if (this.ledgerCorrupt) {
      problems.push('store-external: ledger-corrupt — .ann/journey/.ledger.json is not valid JSON; ann cannot verify store-external integrity');
    } else if (this.ledger) {
      for (const [id, entry] of Object.entries(this.ledger.nodes)) {
        if (this.unparseableNodes.has(id)) continue; // reported below as unparseable-events (with its bound)
        const ev = join(this.legs, id, 'events.jsonl');
        const evDisk = existsSync(ev) ? readFileSync(ev, 'utf8') : null;
        const nd = join(this.legs, id, 'node.json');
        const ndDisk = existsSync(nd) ? readFileSync(nd, 'utf8') : null;
        const bound = `ann wrote rev ${entry.lastRev} at ${entry.lastEventAt}`;
        // node.json side
        if (ndDisk === null && entry.nodeContent !== '') {
          problems.push(`store-external: ${id} — node.json missing vs ${bound}; class=node-deleted`);
        } else if (ndDisk !== null && ndDisk !== entry.nodeContent) {
          problems.push(`store-external: ${id} — node.json differs vs ${bound}; class=node-edit`);
        }
        // events.jsonl side
        if (evDisk === null) {
          if (entry.eventsContent !== '') problems.push(`store-external: ${id} — events.jsonl missing vs ${bound}; class=deleted`);
        } else if (evDisk === entry.eventsContent) {
          // clean
        } else if (evDisk.startsWith(entry.eventsContent) && evDisk.length > entry.eventsContent.length) {
          const added = evDisk.slice(entry.eventsContent.length).split('\n').filter(Boolean);
          problems.push(
            added.every((l) => this.parseLine(l))
              ? `store-external: ${id} — events.jsonl differs vs ${bound}; class=append; +${added.length} line(s) ${this.terse(added[0])}`
              : `store-external: ${id} — events.jsonl differs vs ${bound}; class=unparseable (the appended tail is not valid JSON lines)`,
          );
        } else if (entry.eventsContent.startsWith(evDisk)) {
          const gone = entry.eventsContent.split('\n').length - evDisk.split('\n').length;
          problems.push(`store-external: ${id} — events.jsonl differs vs ${bound}; class=truncate (${gone} ann line(s) gone)`);
        } else {
          const cur = this.tryParseLines(evDisk);
          const base = this.tryParseLines(entry.eventsContent);
          if (cur === null) {
            problems.push(`store-external: ${id} — events.jsonl differs vs ${bound}; class=unparseable (not valid JSON lines)`);
          } else if (base !== null && this.sameMultiset(cur, base)) {
            problems.push(`store-external: ${id} — events.jsonl differs vs ${bound}; class=reorder`);
          } else {
            problems.push(`store-external: ${id} — events.jsonl differs vs ${bound}; class=rewrite; ${this.diffLines(entry.eventsContent, evDisk)}`);
          }
        }
      }
    }
    // unparseable-events — the always-on counterpart to the load() hardening: a corrupt
    // log used to crash every command; now it loads empty and verify names it, with the
    // ledger bound when ann had recorded one.
    for (const id of this.unparseableNodes) {
      const entry = this.ledger?.nodes?.[id];
      problems.push(`unparseable-events: ${id} — events.jsonl is not valid JSON lines (load skipped it)${entry ? `; ledger bound: rev ${entry.lastRev} at ${entry.lastEventAt}` : ''}`);
    }
    return problems;
  }

  /* ══ store-external classification helpers (the reasoning ann does over a detected
   *   change: what KIND of change, and which lines differ). */

  private parseLine(l: string): boolean {
    try { JSON.parse(l); return true; } catch { return false; }
  }

  /** All-or-nothing parse: null when the content is not valid JSON lines. */
  private tryParseLines(content: string): JourneyEvent[] | null {
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
    try { return lines.map((l) => JSON.parse(l) as JourneyEvent); } catch { return null; }
  }

  /** Same events, possibly a different order? (the `reorder` classification) */
  private sameMultiset(a: JourneyEvent[], b: JourneyEvent[]): boolean {
    if (a.length !== b.length) return false;
    const counts = new Map<string, number>();
    for (const e of a) counts.set(JSON.stringify(e), (counts.get(JSON.stringify(e)) ?? 0) + 1);
    for (const e of b) {
      const k = JSON.stringify(e);
      const n = counts.get(k);
      if (!n) return false;
      if (n === 1) counts.delete(k);
      else counts.set(k, n - 1);
    }
    return true;
  }

  /** Line-level summary of two differing serializations (≤3 differing line numbers). */
  private diffLines(a: string, b: string): string {
    const la = a.split('\n');
    const lb = b.split('\n');
    const diffs: string[] = [];
    for (let i = 0; i < Math.max(la.length, lb.length) && diffs.length < 3; i++) {
      if (la[i] !== lb[i]) diffs.push(`L${i + 1}: ${this.terse(lb[i] ?? '∅')}`);
    }
    return diffs.join(', ');
  }

  /** One-line compaction for drift reporting (whitespace-collapsed, capped). */
  private terse(l: string): string {
    const s = (l ?? '').replace(/\s+/g, ' ').trim();
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  }

  /** Leg gate (v8 §12/§13): is every task of this leg's predecessor done? */  legGateMet(legId: string): { met: boolean; blocker?: string } {
    const legs = [...this.nodes.keys()].filter((n) => !n.includes('/')).sort();
    const preds = legs.filter((l) => l < legId);
    if (!preds.length) return { met: true }; // first leg — no predecessor
    const prev = preds[preds.length - 1];
    const tasks = [...this.nodes.keys()].filter((n) => n.startsWith(prev + '/') && n.split('/').length === 2);
    if (!tasks.length) {
      const met = this.events(prev).some((e) => e.type === 'completed');
      return { met, blocker: met ? undefined : `leg ${prev} (childless) has no completed record` };
    }
    // CLOSED_TASK_STATUSES (leg 08 task 01): a cancelled task is closed work like a done
    // or superseded one — it never holds the next leg's gate shut.
    const undone = tasks.filter((t) => !CLOSED_TASK_STATUSES.includes(this.taskStatus(t)));
    return undone.length ? { met: false, blocker: `${prev} has unfinished tasks: ${undone.join(', ')}` } : { met: true };
  }
}
