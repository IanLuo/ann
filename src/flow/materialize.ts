import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../store/store.js';

/**
 * The context assembler (S3) — materializes the per-node context packet.
 *
 * CONTRACT: `context-packet-spec` (locked) — the canonical field-level schema ALL
 * consumers cite. Deterministic, derived, never saved:
 *  - pure (never writes — no appendEvent);
 *  - zero LLM in v1 (AC-4 guards a future summarizer that never overrides this skeleton);
 *  - every entry carries a provenance ladder label (derived-from / observation);
 *  - bounded (< 8k token target; excerpts capped; names/paths/shas never dropped).
 */

export interface PacketPathDecisions {
  nodeId: string;
  isLeg: boolean;
  leg: string;
  route: string[];
  depth: number;
}

export interface PacketContract {
  intent?: string;
  acceptanceCriteria?: string[];
  targetAreas?: string[];
  requiredInputs?: string[];
  expectedOutputs?: string[];
  openQuestions?: Array<{ id?: string; question?: string; blocking?: boolean; defaultIfUnanswered?: string }>;
}

export interface PacketDependency {
  name: string;
  status: 'resolved' | 'missing';
  path?: string;
  sha?: string;
  sourceType: 'derived-from' | 'observation';
  excerpt?: string;
  blocker?: string;
}

export interface PacketQuestion {
  id: string;
  question: string;
  impact: 'high' | 'medium' | 'low';
  default?: string;
  provenance: string;
  status: 'open';
}

export interface ContextPacket {
  pathDecisions: PacketPathDecisions;
  nodeContract: PacketContract;
  dependencies: PacketDependency[];
  readiness: { ready: boolean; blockers: string[] };
  siblingStatus: { siblings: Array<{ id: string; status: string }>; children: Array<{ id: string; status: string }> };
  bindingState: { links: Array<{ url: string; note: string; at?: string }> };
  openQuestions: PacketQuestion[];
}

/** Excerpt cap per resolved input (spec §4 — names/paths/shas are never dropped for the budget). */
const EXCERPT_CHARS = 2000;
const MARKER = /^<!-- (?:specs:locked|draft)[^\n]* -->\n?/;

/** A requiredInput's content identity: the DOCS MANIFEST first (the forward path — a
 *  spec in docs/), falling back to `current()` over artifact locks (legacy reader). */
const currentArtifact = (store: Store, name: string): { path: string; sha: string } | undefined => {
  const doc = store.resolveDoc(name);
  if (doc) return { path: doc.path, sha: doc.sha };
  const cur = store.current(name);
  if (!cur) return undefined;
  return { path: cur.path, sha: cur.sha ?? '' };
};

/** Bounded head of an artifact's content (follows symlinks; lock marker stripped). */
function excerptOf(store: Store, path: string): string {
  try {
    const full = join(store.root, path);
    if (!existsSync(full)) return '';
    const text = readFileSync(full, 'utf8').replace(MARKER, '').trim();
    return text.length > EXCERPT_CHARS ? text.slice(0, EXCERPT_CHARS) + '…' : text;
  } catch {
    return '';
  }
}

/** Assemble the deterministic context packet for a node (pure — never writes). */
export function assemblePacket(store: Store, nodeId: string): ContextPacket {
  const segs = nodeId.split('/');
  const isLeg = segs.length === 1;
  const contract = store.contract(nodeId) as { contract?: Record<string, unknown>; openQuestions?: unknown } | undefined;
  const rawContract = (contract?.contract ?? {}) as Record<string, unknown>;
  const c = ((rawContract as { contract?: Record<string, unknown> }).contract ?? rawContract) as Record<string, unknown>;
  // format v14 §2: openQuestions is a TOP-LEVEL SIBLING of contract (legacy nodes that
  // carry it inside the contract still read — the fallback, never the written shape).
  const openQ = ((contract?.openQuestions ?? c.openQuestions) ?? []) as Array<{ id?: string; question?: string; blocking?: boolean; defaultIfUnanswered?: string }>;

  // dependencies: requiredInputs × resolveDoc/current(name) — provenance: derived-from
  const req = (Array.isArray(c.requiredInputs) ? c.requiredInputs : []) as string[];
  const dependencies: PacketDependency[] = req.map((name) => {
    const art = currentArtifact(store, name);
    if (!art) {
      return { name, status: 'missing', sourceType: 'derived-from', blocker: name };
    }
    return {
      name,
      status: 'resolved',
      path: art.path,
      sha: art.sha,
      sourceType: 'derived-from',
      excerpt: excerptOf(store, art.path),
    };
  });

  // readiness: all dependencies resolved AND no blocking question unanswered
  const blockers: string[] = [];
  for (const d of dependencies) if (d.status === 'missing') blockers.push(`missing requiredInput: ${d.blocker}`);
  for (const q of openQ) if (q.blocking) blockers.push(`blocking question unanswered: ${q.id ?? q.question}`);

  // siblingStatus: the leg's task group + the node's children — statuses only
  const siblings = isLeg ? [] : store.tasksOf(segs[0]).map((t) => ({ id: t, status: store.status(t) }));
  const children = store
    .ids()
    .filter((i) => i.startsWith(nodeId + '/') && i.split('/').length === segs.length + 1)
    .map((i) => ({ id: i, status: store.status(i) }));

  // bindingState: external links from evidence.refs[] (http(s))
  const links: Array<{ url: string; note: string; at?: string }> = [];
  for (const e of store.events(nodeId)) {
    if (e.type !== 'evidence') continue;
    for (const r of Array.isArray(e.refs) ? e.refs : []) {
      if (typeof r === 'string' && /^https?:\/\//.test(r)) links.push({ url: r, note: e.note ?? '', at: e.at });
    }
  }

  const questions: PacketQuestion[] = openQ.map((q) => ({
    id: q.id ?? 'Q?',
    question: q.question ?? '',
    impact: q.blocking ? 'high' : 'medium',
    ...(q.defaultIfUnanswered ? { default: q.defaultIfUnanswered } : {}),
    provenance: 'declared at spawn',
    status: 'open',
  }));

  return {
    pathDecisions: { nodeId, isLeg, leg: segs[0], route: segs, depth: segs.length },
    nodeContract: {
      intent: typeof c.intent === 'string' ? c.intent : undefined,
      acceptanceCriteria: (Array.isArray(c.acceptanceCriteria) ? c.acceptanceCriteria : []) as string[],
      targetAreas: (Array.isArray(c.targetAreas) ? c.targetAreas : []) as string[],
      requiredInputs: req,
      expectedOutputs: (Array.isArray(c.expectedOutputs) ? c.expectedOutputs : []) as string[],
      openQuestions: openQ,
    },
    dependencies,
    readiness: { ready: blockers.length === 0, blockers },
    siblingStatus: { siblings, children },
    bindingState: { links },
    openQuestions: questions,
  };
}
