import { readdirSync, readFileSync, appendFileSync, existsSync, statSync, lstatSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { getVOCAB } from './vocab.js';
import { blobSha, stripMarkers } from './sha.js';

export interface JourneyEvent {
  at: string;
  type: string;
  note?: string;
  gate?: string | { old: string; new: string };
  artifact?: { name: string; path: string; lockSha: string };
  successor?: { name: string; path: string };
  target?: string;
  feedback?: string;
  [key: string]: unknown;
}

interface NodeEntry {
  id: string;
  events: JourneyEvent[];
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
  kind: 'doc' | 'commit' | 'ref' | 'evidence' | 'link';
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
  private nodes = new Map<string, NodeEntry>();

  constructor(root: string) {
    this.root = root;
    this.legs = join(root, '.ann', 'journey', 'legs'); // v12 layout: all ann files under .ann/
    this.load();
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
    // Node EXISTENCE comes from node.json (v8: leg roots have no events.jsonl);
    // events are optional (tasks have them, leg roots don't).
    for (const file of this.walk(this.legs, [], 'node.json')) {
      const id = file.replace(new RegExp('^' + this.legs + '/'), '').replace(/\/node\.json$/, '');
      const evFile = file.replace(/node\.json$/, 'events.jsonl');
      const events = existsSync(evFile) ? this.parse(evFile) : [];
      this.nodes.set(id, { id, events });
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
   * leg's tasks — all done → done; frontmost-ready child → its status; childless
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
      }
    }
    // v8 §3: a submitted without a confirmed/rejected at that gate = blocked
    // (waiting on human) — a gate cannot be skipped silently. Never overrides done/failed.
    if (status !== 'done' && status !== 'failed') {
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
    if (children.every((c) => ['done', 'superseded'].includes(this.taskStatus(c)))) return 'done';
    const ready = children
      .filter((c) => !['done', 'failed', 'superseded'].includes(this.taskStatus(c)))
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
      path: legacyPath(a?.path ?? `journey/legs/${producer}/artifacts/${filename}`),
      sha: a?.lockSha ?? '',
      producer,
    };
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
   *  not resolve via current(). Returns named problems (empty = passes). */
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
      if (!this.current(r.trim())) problems.push(`requiredInput '${r}' does not resolve via current() (use the artifact's logical name)`);
    }
    return problems;
  }

  /* ---------------------------------------------------------------- */
  /* results() — a task's result items (drives `ann results <id> [n]`). */
  /* Result kinds: doc (locked artifact) · commit · ref · evidence · link. */
  /* ---------------------------------------------------------------- */

  /** Gather a task's results from its log — one item per artifact lock, per structured
   *  commit, per ref, per evidence event (format v10 §3/§14). Order: docs, then
   *  commits, then refs, then evidence. Machine-derived; never prose-parsed. */
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
    // docs — locked artifacts (with role)
    for (const e of evs) {
      if (e.type !== 'artifact-locked') continue;
      const a = e.artifact;
      const nm = a?.name ?? String(e.note ?? '').match(/logical name:\s*([\w.-]+)/)?.[1] ?? '';
      if (!nm) continue;
      const filename = a?.path ? basename(a.path) : String(e.note ?? '').match(/([\w.-]+\.md)/)?.[1] ?? '';
      const path = legacyPath(a?.path ?? `journey/legs/${id}/artifacts/${filename}`);
      const cur = this.current(nm);
      const role = cur?.producer === id ? 'current' : cur ? 'superseded' : 'historical';
      out.push({ kind: 'doc', label: `${nm} @ ${a?.lockSha ?? '(no sha)'} [${role}]`, path, sha: a?.lockSha, at: e.at });    }
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

  /** Artifact gate (v10, format §4/§14): a parent may spawn children only after it
   *  has CONCLUDED — a locked artifact OR structured commit evidence
   *  (evidence.commits[] non-empty). Machine-truth; never prose-parsed. */
  parentConcluded(parent: string): boolean {
    return (
      this.events(parent).some((e) => e.type === 'artifact-locked') ||
      this.events(parent).some((e) => e.type === 'evidence' && Array.isArray(e.commits) && e.commits.length > 0)
    );
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
    // artifacts: every lock with its derived role (current / superseded / historical)
    const artifacts: ArtifactRef[] = [];
    for (const e of evs) {
      if (e.type !== 'artifact-locked') continue;
      const a = e.artifact;
      const nm = a?.name ?? String(e.note ?? '').match(/logical name:\s*([\w.-]+)/)?.[1] ?? '';
      if (!nm) continue;
      const filename = a?.path ? basename(a.path) : String(e.note ?? '').match(/([\w.-]+\.md)/)?.[1] ?? '';
      const path = legacyPath(a?.path ?? `journey/legs/${id}/artifacts/${filename}`);
      const cur = this.current(nm);
      const role: ArtifactRef['role'] = cur?.producer === id ? 'current' : cur ? 'superseded' : 'historical';
      artifacts.push({ name: nm, path, sha: a?.lockSha ?? '', role });
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

  /**
   * THE single write path (LB-3): validate schema against the vocab registry,
   * gate-check the prospective log, append only when clean — fail-closed.
   */
  appendEvent(id: string, event: JourneyEvent): void {
    if (!id.includes('/')) {
      throw new Error(`append rejected: leg roots carry no events (v8 §3) — record process facts on tasks`);
    }
    if (!event.at || !event.type || !getVOCAB().eventTypes.includes(event.type)) {
      throw new Error(`append rejected: bad schema (at + known type required, got ${event.type})`);
    }
    this.validateEventShape(event); // strict schema (format v12 §3): unknown fields + shapes rejected
    const node = this.nodes.get(id);
    if (!node) throw new Error(`append rejected: no node ${id}`);
    const prospective = [...node.events, event];
    const gaps = this.gateProblems(id, prospective);
    if (gaps.length) throw new Error(gaps.join('\n'));
    appendFileSync(join(this.legs, id, 'events.jsonl'), JSON.stringify(event) + '\n');
    node.events = prospective;
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
      confirmed: ['at', 'type', 'note', 'gate'],
      rejected: ['at', 'type', 'note', 'gate', 'feedback'],
      'gate-revised': ['at', 'type', 'note', 'gate'],
      transferred: ['at', 'type', 'note', 'target', 'scope'],
      deferred: ['at', 'type', 'note', 'reason'],
    };
    const unknown = Object.keys(e).filter((k) => !(allowed[e.type] ?? []).includes(k));
    if (unknown.length) throw new Error(`append rejected: unknown field(s) '${unknown.join(', ')}' on ${e.type} (strict schema, format v12 §3)`);
    if (e.type === 'submitted' || e.type === 'confirmed' || e.type === 'rejected') {
      if (typeof e.gate !== 'string' || !getVOCAB().gates.includes(e.gate)) {
        throw new Error(`append rejected: ${e.type}.gate must be one of ${getVOCAB().gates.join('|')}`);
      }
      if (e.type === 'rejected' && e.feedback !== undefined && typeof e.feedback !== 'string') {
        throw new Error('append rejected: rejected.feedback must be a string');
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
      const a = e.artifact as { name?: unknown; path?: unknown; lockSha?: unknown; version?: unknown };
      if (!a || typeof a !== 'object' || typeof a.name !== 'string' || !a.name || typeof a.path !== 'string' || !a.path) {
        throw new Error('append rejected: artifact-locked.artifact must be {name, path, lockSha?, version?}');
      }
      if (a.lockSha !== undefined && typeof a.lockSha !== 'string') throw new Error('append rejected: artifact.lockSha must be a string');
      if (a.version !== undefined && typeof a.version !== 'number') throw new Error('append rejected: artifact.version must be a number');
    }
    if (e.type === 'superseded' && e.successor !== undefined) {
      const s = e.successor as { name?: unknown; path?: unknown };
      if (!s || typeof s !== 'object' || typeof s.name !== 'string' || !s.name || typeof s.path !== 'string' || !s.path) {
        throw new Error('append rejected: superseded.successor must be {name, path}');
      }
    }
    if (e.type === 'evidence') {
      if (e.commits !== undefined && (!Array.isArray(e.commits) || !e.commits.every((c) => typeof (c as { sha?: unknown })?.sha === 'string' && (c as { sha: string }).sha))) {
        throw new Error('append rejected: evidence.commits must be [{sha, note?}, …]');
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
    if (this.nodes.has(id)) throw new Error(`spawn rejected: ${id} already exists (node.json immutable — no re-spawn)`);
    // normalize: accept the contract directly, or a wrapped {contract:{…}} (spawn-arg convenience)
    const raw = (contract ?? {}) as Record<string, unknown>;
    const c = ((raw.contract ?? raw) ?? {}) as Record<string, unknown>;
    // format v14 §2: openQuestions is a TOP-LEVEL SIBLING of contract, never a contract
    // field — lift it out wherever the caller put it (the packet assembler reads it there).
    const { openQuestions: nested, ...contractFields } = c;
    const openQuestions = raw.openQuestions ?? nested;
    const dir = join(this.legs, id);
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    writeFileSync(
      join(this.legs, id, 'node.json'),
      JSON.stringify(
        { id, contract: contractFields, ...(openQuestions ? { openQuestions } : {}), createdAt: new Date().toISOString().slice(0, 10) },
        null,
        2,
      ) + '\n',
    );
    this.nodes.set(id, { id, events: [] });
    if (id.includes('/')) {
      this.appendEvent(id, { at: new Date().toISOString().slice(0, 10), type: 'created', note: `spawned by bookkeeper (${who})` });
    }
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

  /** Integrity check: gate gaps + closure integrity (F-AC16) + missing current-artifact
   *  files + orphan names. Leg-level events are INERT by design (v8): they are parsed
   *  for display and resolution only, never read for status and never policed — the
   *  write path (spawn) is what keeps new leg roots free of events. */
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
    // F-AC18 (v9; v10 amended): every task SPAWNED under v9 that completes must have
    // concluded — a locked artifact OR structured commit evidence (evidence.commits[],
    // format v10 §3/§14). Grandfathered: tasks spawned before the v9 migration
    // (createdAt < cutoff) are exempt — the one-time hot fix, never a live rule on history.
    for (const [id, node] of this.nodes) {
      if (!id.includes('/')) continue;
      if (!node.events.some((e) => e.type === 'completed')) continue;
      if (this.parentConcluded(id)) continue;
      if (!this.grandfathered(id)) {
        problems.push(`F-AC18: ${id} — completed without an artifact-locked record or structured commit evidence (v10: document artifact or evidence.commits[] required)`);
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
    const lockersByName = new Map<string, string[]>();
    for (const [id, node] of this.nodes) {
      for (const e of node.events) {
        if (e.type === 'artifact-locked' && e.artifact?.name) {
          const nm = e.artifact.name;
          if (!lockersByName.has(nm)) lockersByName.set(nm, []);
          lockersByName.get(nm)!.push(id);
          const path = e.artifact.path;
          if (path && !existsSync(join(this.root, legacyPath(path)))) problems.push(`MISSING: ${nm} → ${path}`);
        }
      }
    }
    for (const [nm, producers] of lockersByName) {
      if (this.current(nm)) continue;
      const allSuperseded = producers.every((p) => this.supersededLocks(nm).has(p));
      if (!allSuperseded) problems.push(`NO CURRENT: ${nm} (locked but never superseded and not current — orphan)`);
    }
    return problems;
  }

  /* ---------------------------------------------------------------- */
  /* verify() — the DRIFT reconciliation (`ann verify`). READ-ONLY.     */
  /* Internal drift is impossible (ONE writer, LB-3) — drift is always  */
  /* log-vs-filesystem/git: a recorded claim whose on-disk reality      */
  /* changed. Five checks, two directions (record→disk, disk→record).   */
  /* ---------------------------------------------------------------- */

  /** The logical name + derived filename an artifact-locked event claims —
   *  the same fallbacks current()/lockers() use (structured → note marker → filename). */
  private claimedName(e: JourneyEvent): string {
    const a = e.artifact;
    const filename = a?.path ? basename(a.path) : String(e.note ?? '').match(/([\w.-]+\.md)/)?.[1] ?? '';
    return a?.name ?? String(e.note ?? '').match(/logical name:\s*([\w.-]+)/)?.[1] ?? logicalNameFromFile(filename);
  }

  /** Repo-root-relative path (`.ann/docs/…`) — the message vocabulary. */
  private rel(p: string): string {
    return p.startsWith(this.root + '/') ? p.slice(this.root.length + 1) : p;
  }

  /** Directory entries as [] when absent (fresh stores have no docs/ yet). */
  private dirNames(dir: string): string[] {
    return existsSync(dir) ? readdirSync(dir) : [];
  }

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
   * D1 record→disk existence (kept from check's MISSING) · D2 event lockSha vs file
   * content · D3 the docs/ symlink layer · D4 filesystem orphans · D5 version/type
   * coherence. Never writes — reports only (the single writer stays the only mutator).
   */
  verify(): string[] {
    const problems: string[] = [];
    const root = this.root;
    // THE CURRENT LOCK PER LOGICAL NAME: the artifact-locked event whose producer
    // IS current(name).producer — the claims a healthy store must still hold.
    const currentEvents = new Map<string, { id: string; event: JourneyEvent }>();
    for (const [id, node] of this.nodes) {
      for (const e of node.events) {
        if (e.type !== 'artifact-locked') continue;
        const nm = this.claimedName(e);
        if (!nm) continue;
        if (this.current(nm)?.producer !== id) continue; // only the CURRENT producer's lock
        currentEvents.set(nm, { id, event: e });
      }
    }
    // D1 — record → disk existence (the store's MISSING check, kept verbatim shape)
    for (const [id, node] of this.nodes) {
      for (const e of node.events) {
        if (e.type !== 'artifact-locked' || !e.artifact?.name) continue;
        const p = e.artifact.path;
        if (p && !existsSync(join(root, legacyPath(p)))) problems.push(`missing-file: ${e.artifact.name} → ${p} vs no such file on disk`);
      }
    }
    // D2 — the RECORDED event lockSha vs the ACTUAL file content (blob over
    // marker-stripped). The artifact-hash validator only cross-checks the file's
    // own marker — this compares the log's claim to the bytes, and reports the gap.
    for (const [nm, { event }] of currentEvents) {
      const a = event.artifact;
      const rec = typeof a?.lockSha === 'string' && a.lockSha ? a.lockSha : '';
      if (!rec) continue; // no recorded sha — nothing claimed (prose-era locks)
      const cur = this.current(nm)!;
      const full = join(root, cur.path);
      if (!existsSync(full)) continue; // D1 already reports the missing file
      const actual = blobSha(stripMarkers(readFileSync(full, 'utf8')));
      if (!actual.startsWith(rec)) problems.push(`locksha: ${nm} — recorded lockSha ${rec} vs file content ${actual.slice(0, 7)}`);
    }
    // D3 + D5 — the docs/ symlink layer (the placement flip, task 26) and the
    // version/type coherence. docs/<category>/<name>[-v<N>].md must EXIST, RESOLVE,
    // point at the producer's real file, and carry the recorded version; the walk
    // catches entries no current/claimed layout accounts for.
    const docsRoot = join(root, '.ann', 'docs');
    const reportedDocs = new Set<string>(); // docs paths a per-name check already reported
    const accountedDocs = new Set<string>(); // docs paths the current/claimed layout accounts for
    for (const [id, node] of this.nodes) {
      for (const e of node.events) {
        if (e.type !== 'artifact-locked' || !e.artifact?.path) continue;
        const p = legacyPath(e.artifact.path);
        if (p.startsWith('.ann/docs/')) accountedDocs.add(p); // legacy claim pointing INTO docs/
      }
    }
    const docsRel = (p: string) => this.rel(p).replace(/^\.ann\/docs\//, '');
    for (const [nm, { event }] of currentEvents) {
      const cur = this.current(nm)!;
      const full = join(root, cur.path);
      if (!existsSync(full)) continue; // D1 covers the missing file
      const type = (readFileSync(full, 'utf8').match(/specs:locked:[0-9a-f]+ [0-9-]+ type=(\S+)/) || [])[1] ?? '';
      const entry = type ? getVOCAB().artifactTypes[type] : undefined;
      if (type && !entry) problems.push(`type-coherence: ${nm} — marker type '${type}' vs the vocab registry (unknown)`);
      // A docs entry belongs to this artifact by LOGICAL NAME, or — legacy locks —
      // by the recorded FILE name (docs/<name>-spec.md carries the filename, not the
      // logical name; the realpath test below is what settles it).
      const recordedFile = event.artifact?.path
        ? basename(legacyPath(event.artifact.path))
        : String(event.note ?? '').match(/([\w.-]+\.md)/)?.[1] ?? '';
      const isNamedFor = (f: string) => logicalNameFromFile(f) === nm || (recordedFile !== '' && f === recordedFile);
      if (!entry?.category) {
        // task-local type — no docs view is expected; a stray docs entry is drift
        for (const cat of this.dirNames(docsRoot)) {
          for (const f of this.dirNames(join(docsRoot, cat))) {
            if (!isNamedFor(f)) continue;
            problems.push(`type-coherence: ${nm} — docs/${cat}/${f} vs type '${type || '(none)'}' is task-local (no docs view)`);
            reportedDocs.add(this.rel(join(docsRoot, cat, f)));
          }
        }
        continue;
      }
      const dir = join(docsRoot, entry.category);
      const currentReal = realpathSync(full);
      const version = (event.artifact as { version?: unknown } | undefined)?.version;
      // The docs entry for this name is the one that RESOLVES to the current artifact.
      // realpath is the definitive test: a legacy docs filename (e.g. resource-registry-spec-v3.md)
      // may embed neither the logical name nor the current basename.
      let matched: string | undefined;
      const named: string[] = [];
      for (const f of this.dirNames(dir)) {
        const p = join(dir, f);
        let target: string | undefined;
        try {
          target = realpathSync(p);
        } catch {
          // dangling symlink — target missing (reported below, if the name matches)
        }
        if (target === currentReal) {
          matched = p;
          if (isNamedFor(f)) named.push(f);
          continue;
        }
        if (!isNamedFor(f)) continue;
        named.push(f);
        if (target === undefined) {
          problems.push(`docs-dangling: ${nm} — docs/${docsRel(p)} vs target missing (does not resolve)`);
        } else {
          problems.push(`docs-mispointed: ${nm} — docs/${docsRel(p)} vs resolves to ${this.rel(target)} not the current artifact (${cur.path})`);
        }
        reportedDocs.add(this.rel(p));
      }
      if (matched) {
        accountedDocs.add(this.rel(matched));
        if (typeof version === 'number' && basename(matched) !== `${nm}-v${version}.md`) {
          problems.push(`docs-version: ${nm} — event records version ${version} vs docs symlink ${basename(matched)}`);
          reportedDocs.add(this.rel(matched));
        }
      } else if (typeof version === 'number') {
        // modern lock — the docs entry is pinned at exactly <name>-v<version>.md
        const expectFile = `${nm}-v${version}.md`;
        const expectPath = join(dir, expectFile);
        const expectRel = this.rel(expectPath);
        if (reportedDocs.has(expectRel)) {
          // the pinned entry exists but is broken — already reported per-entry above
        } else if (existsSync(expectPath)) {
          problems.push(`docs-version: ${nm} — event records version ${version} vs the pinned docs symlink ${expectFile} does not resolve to the current artifact`);
          reportedDocs.add(expectRel);
        } else {
          const stale = named.filter((f) => !reportedDocs.has(this.rel(join(dir, f))));
          problems.push(`docs-version: ${nm} — event records version ${version} vs no docs symlink ${expectFile} resolves to it${stale.length ? ` (stale: ${stale.join(', ')})` : ''}`);
          for (const f of stale) reportedDocs.add(this.rel(join(dir, f)));
        }
      } else if (!named.length) {
        // legacy lock with no docs entry at all — nothing even attempted
        problems.push(`docs-missing: ${nm} — no docs/${entry.category} symlink resolves to the current artifact (${cur.path})`);
      }
      // D5 placement coherence: the name must not appear in any OTHER category
      for (const cat of this.dirNames(docsRoot)) {
        if (cat === entry.category) continue;
        for (const f of this.dirNames(join(docsRoot, cat))) {
          if (!isNamedFor(f)) continue;
          problems.push(`type-coherence: ${nm} — docs/${cat}/${f} vs type '${type}' places into '${entry.category}'`);
          reportedDocs.add(this.rel(join(docsRoot, cat, f)));
        }
      }
    }
    // the walk: every docs/ entry no current/claimed layout accounts for
    for (const cat of this.dirNames(docsRoot)) {
      for (const f of this.dirNames(join(docsRoot, cat))) {
        if (!f.endsWith('.md')) continue;
        const r = this.rel(join(docsRoot, cat, f));
        if (accountedDocs.has(r) || reportedDocs.has(r)) continue;
        problems.push(`docs-orphan: docs/${docsRel(join(docsRoot, cat, f))} vs no current/claimed layout accounts for it`);
      }
    }
    // D4 — filesystem orphans (the MIRROR direction: walk the disk, not the store).
    // Store.load() keys on node.json ONLY — a bare events.jsonl dir is invisible to
    // the store today, so this walk must not rely on ids() alone.
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
      // every .md under artifacts/ must be named by an artifact-locked event of this node
      const adir = join(d, 'artifacts');
      if (!existsSync(adir)) continue;
      let events = this.nodes.get(rel)?.events;
      if (!events) {
        const ef = join(d, 'events.jsonl');
        events = existsSync(ef) ? this.parse(ef) : [];
      }
      const claimed = new Set<string>();
      for (const e of events) {
        if (e.type !== 'artifact-locked') continue;
        const filename = e.artifact?.path ? basename(e.artifact.path) : String(e.note ?? '').match(/([\w.-]+\.md)/)?.[1] ?? '';
        if (filename) claimed.add(filename);
      }
      for (const f of readdirSync(adir)) {
        if (!f.endsWith('.md')) continue;
        if (!claimed.has(f)) problems.push(`artifact-orphan: ${rel}/artifacts/${f} vs no artifact-locked event of this node names it`);
      }
    }
    return problems;
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
    const undone = tasks.filter((t) => !['done', 'superseded'].includes(this.taskStatus(t)));
    return undone.length ? { met: false, blocker: `${prev} has unfinished tasks: ${undone.join(', ')}` } : { met: true };
  }
}
