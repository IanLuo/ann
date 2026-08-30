import { TaskDetail, ResultItem } from '../store/store.js';

/**
 * S8 — THE RENDERERS (functional-spec F10/F11/F12; ann-system-design §1 "Renderers":
 * tree view · step cards · full plan). Pure functions: derived tree + packets +
 * artifacts → TEXT. No side effects, no secrets, no scalar progress.
 *
 *   renderStatusTree  (F10 — status/tree view)   rows → tree text
 *   renderGateCard    (F11 — step card)          a task detail → card text
 *   renderPlan        (F12 — full plan)          legs + look-back → plan text
 *
 * BOUNDARIES (ann-system-design §3 "Renderer input: derived tree + packets + artifacts
 * → text (no secrets, no scalar progress)"):
 *   - NO SECRETS (NFR-SEC-1): `redact()` strips token/key/secret patterns before any
 *     text leaves the renderer; `hasSecret()` is the guard.
 *   - NO SCALAR PROGRESS (AC5): the renderers emit STATUS WORDS (queued/active/done/
 *     blocked), never percentages or counts-as-progress. `hasScalarProgress()` is the
 *     guard, asserted in tests.
 */

export interface StatusRow {
  id: string;
  status: string;
  superseded: boolean;
}

/** F10 — the tree/status view: one line per node, id-padded, status + superseded marker. */
export function renderStatusTree(rows: StatusRow[]): string {
  return rows.map((r) => `${r.id.padEnd(58)} ${r.status}${r.superseded ? ' · artifact superseded' : ''}`).join('\n');
}

export interface GateCardData {
  detail: TaskDetail;
  results?: ResultItem[];
}

/** F11 — the step card: intent · ACs · status · artifacts · gates · results. The
 *  gate presentation at gate①/② (functional-spec §3: present → decide → feedback). */
export function renderGateCard(data: GateCardData): string {
  const d = data.detail;
  const out: string[] = [];
  const contract = (d.contract ?? {}) as Record<string, unknown>;
  const acs = (contract.acceptanceCriteria ?? []) as string[];

  out.push(`GATE CARD: ${d.id}`);
  out.push(`  status: ${d.status}${d.superseded ? ' · superseded producer' : ''}`);
  out.push(`  intent: ${redact(String(contract.intent ?? '(none)'))}`);
  acs.forEach((a, i) => out.push(`  AC-${i + 1}: ${redact(a)}`));

  out.push('  artifacts:');
  if (!d.artifacts.length) out.push('    (none locked)');
  for (const a of d.artifacts) {
    out.push(`    - ${redact(a.name)} @ ${a.sha || '(no sha)'} [${a.role}]`);
    out.push(`        ${redact(a.path)}`);
  }

  out.push('  gates (derived):');
  const gateLine = (g: { state: string; at?: string }, label: string) =>
    `    ${g.state === 'confirmed' ? '✓' : g.state === 'rejected' ? '✗' : g.state === 'submitted' ? '…' : '·'} ${label} — ${g.state}${g.at ? ` (${g.at})` : ''}`;
  out.push(gateLine(d.gates.grill, 'grilling (entry)'));
  out.push(gateLine(d.gates.confirm, 'confirm-result (exit)'));

  const items = data.results ?? [];
  out.push('  results:');
  if (!items.length) out.push('    (no results yet)');
  items.forEach((it, i) => out.push(`    ${String(i + 1).padStart(2)}. [${it.kind.padEnd(8)}] ${redact(it.label)}`));

  if (d.blockers.length) {
    out.push('  BLOCKED — waiting on human:');
    for (const b of d.blockers) out.push(`    ${redact(b)}`);
  }

  out.push('→ verify each AC against the artifact + evidence, then confirm or reject + reason.');
  return out.join('\n');
}

/** F12 — the full plan: where we are (every leg + its tasks) + what is ahead (the
 *  look-back: active leg, frontmost-ready, also-ready, leg gate). */
export interface PlanLeg {
  id: string;
  status: string;
  superseded: boolean;
  tasks?: Array<{ id: string; status: string; superseded?: boolean }>;
}

export interface PlanAhead {
  activeLeg?: string;
  activeLegStatus?: string;
  frontmostReady?: { task: string; status: string };
  alsoReady: Array<{ task: string; status: string }>;
  legGate: { met: boolean; blocker?: string };
  readyCount?: number;
}

export function renderPlan(legs: PlanLeg[], ahead: PlanAhead): string {
  const out: string[] = [];
  out.push('=== WHERE WE ARE ===');
  for (const leg of legs) {
    const suffix = leg.tasks?.length
      ? ' — tasks: ' +
        leg.tasks.map((t) => `${t.id.replace(leg.id + '/', '')}:${t.status}${t.superseded ? ' · artifact superseded' : ''}`).join(', ')
      : '';
    out.push(`${leg.id.padEnd(6)} ${leg.status}${leg.superseded ? ' · superseded' : ''}${suffix}`);
  }

  out.push('');
  out.push('=== WHAT IS AHEAD ===');
  if (ahead.activeLeg) {
    out.push(`active leg: ${ahead.activeLeg} (${ahead.activeLegStatus})`);
    if (ahead.frontmostReady) {
      out.push(`frontmost-ready: ${ahead.frontmostReady.task} (${ahead.frontmostReady.status})`);
      for (const t of ahead.alsoReady) out.push(`  also ready: ${t.task} (${t.status})`);
    } else if (ahead.legGate.met) {
      out.push('LEG GATE REVIEW: all spawned tasks done — verify the epic ACs (node.json contract) before advancing or spawning remaining tasks');
    } else {
      out.push(`no ready tasks in leg — leg gate may need review${ahead.legGate.blocker ? ` (${ahead.legGate.blocker})` : ''}`);
    }
  } else {
    out.push('no active leg — previous leg derived done; LEG GATE REVIEW before spawning the next leg');
  }
  out.push('');
  out.push('(grounded in: statuses + gates + validation — run --check / validate.mjs for the proof)');
  return out.join('\n');
}

/* ══ NFR-SEC-1 — the redaction boundary ═══════════════════════════════════════ */

/** Secret-bearing patterns: tokens, api keys, Authorization headers, GitHub PATs,
 *  OpenAI-style sk- keys. Renders must never leak them (NFR-SEC-1). */
const SECRET_PATTERNS: RegExp[] = [
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub personal access token
  /\bsk-[A-Za-z0-9]{16,}\b/g, // OpenAI-style secret key
  /\b(?:token|api[_-]?key|secret|authorization|password|passwd)\s*[:=]\s*["']?[^\s"',;]+/gi,
  /\bauthorization:\s*Bearer\s+\S+/gi,
];

/** Replace secret-looking patterns with [REDACTED]. */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

/** True when the text still contains a secret pattern — the render guard. */
export function hasSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/* ══ the drift read (`ann verify`) — one pure line renderer ═══════════════════ */

/** A drift line: `DRIFT <kind>: <claim> vs <reality>` (the reconcile mirror of
 *  check's integrity lines). Pure — the CLI just prints it to stderr. */
export function renderDrift(drift: string): string {
  return `DRIFT ${drift}`;
}

/* ══ the ledger read (`ann ledger`) — the store write-rev integrity view ═══════ */

/** The read surface of `.ann/journey/.ledger.json` (content snapshots stay private). */
export interface LedgerView {
  rev: number;
  bootstrappedAt: string;
  nodes: Record<string, { eventsSha: string; nodeSha: string; lastEventAt: string; lastRev: number }>;
}

/** The write-rev ledger as text: the global rev + one padded line per tracked node. */
export function renderLedger(v: LedgerView): string {
  const out = [`LEDGER rev ${v.rev}${v.bootstrappedAt ? ` (bootstrapped ${v.bootstrappedAt.slice(0, 10)})` : ' — no ledger yet (no CLI writes recorded)'}`];
  for (const [id, n] of Object.entries(v.nodes).sort(([a], [b]) => a.localeCompare(b))) {
    out.push(`  ${id.padEnd(46)} rev ${n.lastRev} @ ${n.lastEventAt}  events ${n.eventsSha.slice(0, 7)} · node ${n.nodeSha.slice(0, 7)}`);
  }
  return out.join('\n');
}

/* ══ AC5 — the no-scalar-progress guard ═══════════════════════════════════════ */

/** Scalar-progress patterns: percentages, counts-as-progress, progress bars. The
 *  renderers NEVER emit these (AC5 — ann-system-design §1: renderers "Render scalar
 *  progress (AC5)" in the never column). Status WORDS are the only progress signal. */
const SCALAR_PROGRESS_PATTERNS: RegExp[] = [
  /\b\d+(\.\d+)?\s*%/,
  /(?:progress|done|complete)[^\n]*\b\d+\s*(?:steps|tasks|items|of|\/)/i,
  /(?:[=|█▉▊▋▌▍▎▏#]){2,}\s*\d+\s*%/,
];

/** True when the text contains a scalar-progress signal — the AC5 guard. */
export function hasScalarProgress(text: string): boolean {
  return SCALAR_PROGRESS_PATTERNS.some((re) => re.test(text));
}
