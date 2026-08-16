#!/usr/bin/env node
/**
 * resolve.mjs — the derived logical-name resolver (tree-format-spec v3 §4, F-AC13 seed).
 *
 * The FIRST engine component, built pre-engine as a plain Node script (no deps),
 * used by the bootstrap itself. Implements:
 *   current(name) = artifact of the latest `artifact-locked` event with that name
 *                   whose producer is not `superseded`.
 *
 * Usage:
 *   node scripts/resolve.mjs                → print the name → current-path map
 *   node scripts/resolve.mjs <name>         → print the current path for one name
 *   node scripts/resolve.mjs --check        → verify: files exist, one current per name
 *
 * Logical name extraction: structured `artifact.name` field (v3 §3) if present,
 * else derive from the artifact filename minus a version suffix (-vN).
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

const ROOT = process.cwd();
const ROUNDS = join(ROOT, 'tree', 'rounds');

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (entry === 'events.jsonl') acc.push(p);
  }
  return acc;
}

function logicalNameFromFile(path) {
  const base = basename(path).replace(/\.md$/, '');
  return base.replace(/-v\d+$/, ''); // strip version suffix
}

function parseEvents(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

function collect() {
  const locked = [];   // {name, path, sha, producer}
  const superseded = []; // {name, producer}
  for (const file of walk(ROUNDS)) {
    for (const ev of parseEvents(file)) {
      const producer = file.replace(new RegExp('^' + ROOT + '/'), '').replace(/\/events\.jsonl$/, '');
      
      if (ev.type === 'artifact-locked') {
        const artifact = ev.artifact || {};
        const filename = artifact.path
          ? basename(artifact.path)
          : (ev.note.match(/([\w.-]+\.md)/) || [])[1] || '';
        const name = artifact.name
          || (ev.note.match(/logical name:\s*([\w.-]+)/) || [])[1]
          || logicalNameFromFile(filename);
        const path = artifact.path || producer + '/artifacts/' + filename;
        const sha = artifact.lockSha || (ev.note.match(/@\s*([0-9a-f]{7,})/) || [])[1] || '';
        locked.push({ name, path, sha, producer });
      } else if (ev.type === 'superseded') {
        const succ = ev.successor || {};
        const oldName = (ev.note.match(/([\w.-]+\.md)/) || [])[1] || '';
        const name = succ.name
          || (ev.note.match(/logical name:\s*([\w.-]+)/) || [])[1]
          || logicalNameFromFile(oldName);
        superseded.push({ name, producer });
      }
    }
  }
  return { locked, superseded };
}

function resolve() {
  const { locked, superseded } = collect();
  const supersededProducers = new Set(superseded.map((s) => s.producer));
  // current(name) = latest artifact-locked with name, producer not superseded
  const current = new Map();
  for (const l of locked) {
    if (supersededProducers.has(l.producer)) continue;
    const prev = current.get(l.name);
    if (!prev || prev.sha <= l.sha || prev.producer < l.producer) current.set(l.name, l);
  }
  return current;
}

function check(current) {
  const problems = [];
  for (const [name, l] of current) {
    const full = join(ROOT, l.path);
    if (!existsSync(full)) problems.push(`MISSING: ${name} → ${l.path}`);
  }
  const { locked, superseded } = collect();
  const supersededProducers = new Set(superseded.map((s) => s.producer));
  const namesWithLock = new Set(locked.map((l) => l.name));
  for (const name of namesWithLock) {
    if (current.has(name)) continue;
    const allSuperseded = locked.filter((l) => l.name === name).every((l) => supersededProducers.has(l.producer));
    if (!allSuperseded) problems.push(`NO CURRENT: ${name} (locked but never superseded and not current — orphan)`);
  }
  return problems;
}

const args = process.argv.slice(2);
const current = resolve();
const problems = check(current);

if (args.includes('--check')) {
  for (const p of problems) console.error(p);
  console.log(problems.length === 0 ? `OK — ${current.size} current artifacts, verified.` : `${problems.length} problem(s).`);
  process.exit(problems.length === 0 ? 0 : 1);
}

if (args[0] && !args[0].startsWith('--')) {
  const l = current.get(args[0]);
  if (!l) { console.error(`resolve: no current artifact for '${args[0]}'`); process.exit(1); }
  console.log(l.path);
  if (l.sha) console.error(`  (locked @ ${l.sha}, producer ${l.producer})`);
} else {
  for (const [name, l] of [...current.entries()].sort()) {
    console.log(`${name.padEnd(28)} ${l.path}${l.sha ? '  @ ' + l.sha : ''}`);
  }
}
