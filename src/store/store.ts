import { readdirSync, readFileSync, appendFileSync, existsSync, statSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { VOCAB } from './vocab.js';

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
    .replace(/^(journey\/legs\/[^/]+)\/00\//, '$1/');

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
    this.legs = join(root, 'journey', 'legs');
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
  private contractOf(id: string): Record<string, unknown> {
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
      out.push({ kind: 'doc', label: `${nm} @ ${a?.lockSha ?? '(no sha)'} [${role}]`, path, sha: a?.lockSha, at: e.at });
    }
    // commits — structured evidence.commits[]
    for (const e of evs) {
      if (e.type !== 'evidence') continue;
      for (const c of Array.isArray(e.commits) ? e.commits : []) {
        const sha = (c as { sha?: unknown })?.sha;
        if (typeof sha !== 'string' || !sha) continue;
        out.push({ kind: 'commit', label: `${sha} — ${String((c as { note?: unknown })?.note ?? '')}`, sha, note: String((c as { note?: unknown })?.note ?? ''), at: e.at });
      }
    }
    // refs — structured evidence.refs[] (+ external links)
    for (const e of evs) {
      if (e.type !== 'evidence') continue;
      for (const r of Array.isArray(e.refs) ? e.refs : []) {
        if (typeof r !== 'string' || !r) continue;
        if (/^https?:\/\//.test(r)) out.push({ kind: 'link', label: r, url: r, at: e.at });
        else out.push({ kind: 'ref', label: r, path: r, at: e.at });
      }
    }
    // evidence events without structured commits/refs (informational)
    for (const e of evs) {
      if (e.type !== 'evidence') continue;
      const hasStructured = (Array.isArray(e.commits) && e.commits.length > 0) || (Array.isArray(e.refs) && e.refs.length > 0);
      if (hasStructured) continue;
      out.push({ kind: 'evidence', label: (e.note ?? '').slice(0, 90) + ((e.note?.length ?? 0) > 90 ? '…' : ''), note: e.note, at: e.at });
    }
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
    if (!event.at || !event.type || !VOCAB.eventTypes.includes(event.type)) {
      throw new Error(`append rejected: bad schema (at + known type required, got ${event.type})`);
    }
    const node = this.nodes.get(id);
    if (!node) throw new Error(`append rejected: no node ${id}`);
    const prospective = [...node.events, event];
    const gaps = this.gateProblems(id, prospective);
    if (gaps.length) throw new Error(gaps.join('\n'));
    appendFileSync(join(this.legs, id, 'events.jsonl'), JSON.stringify(event) + '\n');
    node.events = prospective;
  }

  /** Spawn a node: write the immutable creation record, then the `created` event
   *  through appendEvent (every event write flows through the single writer).
   *  Leg roots get NO events at all (v8 §13) — only node.json + the card. */
  spawn(id: string, contract: unknown, who = 'agent'): void {
    if (this.nodes.has(id)) throw new Error(`spawn rejected: ${id} already exists (node.json immutable — no re-spawn)`);
    // normalize: accept the contract directly, or a wrapped {contract:{…}} (spawn-arg convenience)
    const c = ((contract as { contract?: unknown })?.contract ?? contract) as Record<string, unknown>;
    const dir = join(this.legs, id);
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    writeFileSync(
      join(this.legs, id, 'node.json'),
      JSON.stringify({ id, contract: c, createdAt: new Date().toISOString().slice(0, 10) }, null, 2) + '\n',
    );
    this.nodes.set(id, { id, events: [] });
    if (id.includes('/')) {
      this.appendEvent(id, { at: new Date().toISOString().slice(0, 10), type: 'created', note: `spawned by bookkeeper (${who})` });
    }
  }

  /** GATE-1/GATE-2 (F-AC15): tasks only — leg roots carry no events (v8). */
  gateProblems(id: string, evs?: JourneyEvent[]): string[] {
    const problems: string[] = [];
    if (!id.includes('/')) return problems;
    const list = evs ?? this.events(id);
    let lastComplete = -1,
      lastConfirm2 = -1,
      firstWork = -1,
      lastConfirm1 = -1,
      retroGrill = false;
    list.forEach((e, i) => {
      const gate = typeof e.gate === 'string' ? e.gate : String(e.note ?? '').match(/gate=(\w+)/)?.[1] ?? '';
      if (e.type === 'completed') lastComplete = i;
      if (e.type === 'artifact-locked' || e.type === 'completed') {
        if (firstWork === -1) firstWork = i;
      }
      if (e.type === 'confirmed' && (gate === 'confirm' || gate === '')) lastConfirm2 = i;
      if (e.type === 'confirmed' && gate === 'grill') lastConfirm1 = i;
      if (e.type === 'confirmed' && gate === 'grill' && e.note?.includes('retrospective')) retroGrill = true;
    });
    if (lastComplete >= 0 && lastConfirm2 === -1) {
      problems.push(`GATE-2 GAP: ${id} — completed but no confirmed(gate=confirm) recorded`);
    }
    if (firstWork >= 0 && !retroGrill && (lastConfirm1 === -1 || lastConfirm1 > firstWork)) {
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
    for (const id of this.nodes.keys()) {
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
    const V9_CUTOFF = '2026-08-21';
    for (const [id, node] of this.nodes) {
      if (!id.includes('/')) continue;
      if (!node.events.some((e) => e.type === 'completed')) continue;
      if (this.parentConcluded(id)) continue;
      const createdAt = (this.contract(id) as { createdAt?: string } | undefined)?.createdAt ?? '';
      if (createdAt >= V9_CUTOFF) {
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
      const createdAt = (this.contract(id) as { createdAt?: string } | undefined)?.createdAt ?? '';
      if (createdAt < V9_CUTOFF) continue;
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
