import { readdirSync, readFileSync, appendFileSync, existsSync, statSync, lstatSync } from 'node:fs';
import { join, basename } from 'node:path';
import { VOCAB } from './vocab.js';
const GRANDFATHERED_LEGS = new Set([
    '01-goal',
    '02-grilling',
    '03-tree-format',
    '04-system-design',
    '05-engine',
    '06-engine-build',
]);
/**
 * The tree store (S1) — reads/writes legs, nodes, events, artifacts per
 * journey-format-spec v8. Builds the in-memory tree; owns the single
 * appendEvent() write function (architecture LB-3); exposes derived views
 * (status / resolution / integrity) for shared readers.
 */
export class Store {
    root;
    legs;
    nodes = new Map();
    constructor(root) {
        this.root = root;
        this.legs = join(root, 'journey', 'legs');
        this.load();
    }
    walk(dir, acc = []) {
        for (const entry of readdirSync(dir)) {
            const p = join(dir, entry);
            if (!lstatSync(p).isSymbolicLink() && statSync(p).isDirectory())
                this.walk(p, acc);
            else if (entry === 'events.jsonl')
                acc.push(p);
        }
        return acc;
    }
    load() {
        for (const file of this.walk(this.legs)) {
            const id = file.replace(new RegExp('^' + this.legs + '/'), '').replace(/\/events\.jsonl$/, '');
            this.nodes.set(id, { id, events: this.parse(file) });
        }
    }
    parse(file) {
        return readFileSync(file, 'utf8')
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => JSON.parse(l));
    }
    ids() {
        return [...this.nodes.keys()];
    }
    events(id) {
        return this.nodes.get(id)?.events ?? [];
    }
    /**
     * Derived status (v8 §3/§12). Tasks: tail mapping. Legs: pure function of the
     * leg's tasks — all done → done; frontmost-ready child → its status; childless
     * → own lifecycle (L1 base step); all remaining failed → blocked (escalate).
     */
    status(id) {
        if (id.includes('/'))
            return this.taskStatus(id);
        return this.legStatus(id);
    }
    taskStatus(id) {
        let status = 'queued';
        for (const e of this.events(id)) {
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
                    if (status !== 'done' && status !== 'failed')
                        status = 'superseded';
                    break;
            }
        }
        return status;
    }
    legStatus(id) {
        const children = [...this.nodes.keys()].filter((n) => n.startsWith(id + '/') && n.split('/').length === 2);
        if (!children.length)
            return this.taskStatus(id);
        if (children.every((c) => ['done', 'superseded'].includes(this.taskStatus(c))))
            return 'done';
        const ready = children
            .filter((c) => !['done', 'failed', 'superseded'].includes(this.taskStatus(c)))
            .sort();
        return ready.length ? this.taskStatus(ready[0]) : 'blocked';
    }
    /**
     * Resolution (format §5): current(name) = the artifact-locked producer with that
     * name that is not superseded. Never by timestamp; the log is the only order.
     * Structured events preferred; legacy prose notes are parsed as a fallback.
     */
    current(name) {
        const lockers = this.lockers(name);
        const superseded = this.supersededProducers(name);
        const candidates = lockers.filter((p) => !superseded.has(p));
        if (!candidates.length)
            return undefined;
        const producer = candidates[candidates.length - 1];
        const e = this.events(producer).find((x) => x.type === 'artifact-locked');
        const a = e?.artifact;
        const filename = a?.path
            ? basename(a.path)
            : String(e?.note ?? '').match(/([\w.-]+\.md)/)?.[1] ?? '';
        return {
            name,
            path: a?.path ?? `${producer}/artifacts/${filename}`,
            sha: a?.lockSha ?? '',
            producer,
        };
    }
    lockers(name) {
        const out = [];
        for (const [id, node] of this.nodes) {
            for (const e of node.events) {
                if (e.type !== 'artifact-locked')
                    continue;
                const a = e.artifact;
                const nm = a?.name ?? String(e.note ?? '').match(/logical name:\s*([\w.-]+)/)?.[1] ?? '';
                if (nm === name)
                    out.push(id);
            }
        }
        return out;
    }
    supersededProducers(name) {
        const out = new Set();
        for (const [id, node] of this.nodes) {
            for (const e of node.events) {
                if (e.type === 'superseded' && e.successor?.name === name)
                    out.add(id);
            }
        }
        return out;
    }
    /**
     * THE single write path (LB-3): validate schema against the vocab registry,
     * gate-check the prospective log, append only when clean — fail-closed.
     */
    appendEvent(id, event) {
        if (!event.at || !event.type || !VOCAB.eventTypes.includes(event.type)) {
            throw new Error(`append rejected: bad schema (at + known type required, got ${event.type})`);
        }
        const node = this.nodes.get(id);
        if (!node)
            throw new Error(`append rejected: no node ${id}`);
        const prospective = [...node.events, event];
        const gaps = this.gateProblems(id, prospective);
        if (gaps.length)
            throw new Error(gaps.join('\n'));
        appendFileSync(join(this.legs, id, 'events.jsonl'), JSON.stringify(event) + '\n');
        node.events = prospective;
    }
    /** GATE-1/GATE-2 (F-AC15): tasks only — leg roots carry no events (v8). */
    gateProblems(id, evs) {
        const problems = [];
        if (!id.includes('/'))
            return problems;
        const list = evs ?? this.events(id);
        let lastComplete = -1, lastConfirm2 = -1, firstWork = -1, lastConfirm1 = -1, retroGrill = false;
        list.forEach((e, i) => {
            const gate = typeof e.gate === 'string' ? e.gate : String(e.note ?? '').match(/gate=(\w+)/)?.[1] ?? '';
            if (e.type === 'completed')
                lastComplete = i;
            if (e.type === 'artifact-locked' || e.type === 'completed') {
                if (firstWork === -1)
                    firstWork = i;
            }
            if (e.type === 'confirmed' && (gate === 'confirm' || gate === ''))
                lastConfirm2 = i;
            if (e.type === 'confirmed' && gate === 'grill')
                lastConfirm1 = i;
            if (e.type === 'confirmed' && gate === 'grill' && e.note?.includes('retrospective'))
                retroGrill = true;
        });
        if (lastComplete >= 0 && lastConfirm2 === -1) {
            problems.push(`GATE-2 GAP: ${id} — completed but no confirmed(gate=confirm) recorded`);
        }
        if (firstWork >= 0 && !retroGrill && (lastConfirm1 === -1 || lastConfirm1 > firstWork)) {
            problems.push(`GATE-1 GAP: ${id} — produced work (artifact-locked/completed) but no confirmed(gate=grill) before it`);
        }
        return problems;
    }
    /** Integrity check: gate gaps + missing current-artifact files + orphan names. */
    check() {
        const problems = [];
        for (const id of this.nodes.keys()) {
            for (const p of this.gateProblems(id))
                problems.push(p);
        }
        const lockersByName = new Map();
        for (const [id, node] of this.nodes) {
            for (const e of node.events) {
                if (e.type === 'artifact-locked' && e.artifact?.name) {
                    const nm = e.artifact.name;
                    if (!lockersByName.has(nm))
                        lockersByName.set(nm, []);
                    lockersByName.get(nm).push(id);
                    const path = e.artifact.path;
                    if (path && !existsSync(join(this.root, path)))
                        problems.push(`MISSING: ${nm} → ${path}`);
                }
            }
        }
        for (const [nm, producers] of lockersByName) {
            if (this.current(nm))
                continue;
            const allSuperseded = producers.every((p) => this.supersededProducers(nm).has(p));
            if (!allSuperseded)
                problems.push(`NO CURRENT: ${nm} (locked but never superseded and not current — orphan)`);
        }
        return problems;
    }
    /** Leg gate (v8 §12/§13): is every task of this leg's predecessor done? */
    legGateMet(legId) {
        const legs = [...this.nodes.keys()].filter((n) => !n.includes('/')).sort();
        const preds = legs.filter((l) => l < legId);
        if (!preds.length)
            return { met: true }; // first leg — no predecessor
        const prev = preds[preds.length - 1];
        const tasks = [...this.nodes.keys()].filter((n) => n.startsWith(prev + '/') && n.split('/').length === 2);
        if (!tasks.length) {
            const met = this.events(prev).some((e) => e.type === 'completed');
            return { met, blocker: met ? undefined : `leg ${prev} (childless) has no completed record` };
        }
        const undone = tasks.filter((t) => !['done', 'superseded'].includes(this.taskStatus(t)));
        return undone.length ? { met: false, blocker: `${prev} has unfinished tasks: ${undone.join(', ')}` } : { met: true };
    }
    /** v8 §12/§13: leg roots carry no events — the grandfathered set is historical. */
    legRootDisciplineProblems() {
        const out = [];
        for (const [id, node] of this.nodes) {
            if (id.includes('/') || GRANDFATHERED_LEGS.has(id))
                continue;
            if (node.events.length)
                out.push(`${id}: leg root carries events (v8 §3) — leg roots have no log`);
        }
        return out;
    }
}
