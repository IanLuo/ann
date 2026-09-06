import { readdirSync, readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { blobSha, stripMarkers } from './sha.js';

/**
 * docs → git (the docs/ home + the manifest). In-force docs (specs + goal.md) are
 * GIT-MANAGED repo content in ONE place: docs/ at the repo root. ann manages the
 * journey (governance); git manages content. Old versions live only in git; current
 * = the file at HEAD. This module owns the docs/ filesystem + the GENERATED manifest
 * (docs/manifest.json) — the resolution index mapping a logical name → its file.
 *
 * Deliberately does NOT import from store.ts (store.ts imports these helpers for
 * resolveDoc — a cycle would bite). Callers hold the repo root and pass it in.
 */

/** The manifest filename — never scanned as a doc itself. */
export const MANIFEST_FILE = 'manifest.json';

/** Logical name from a docs/ filename — the STEM (last extension stripped): goal.md →
 *  goal, companion-guide.html → companion-guide. Versioning is git's job, so a docs/
 *  file never carries a -vN suffix (unlike the retired per-task artifact filenames). */
export const docNameFromFile = (f: string): string => f.replace(/\.[^./]*$/, '');

/** Scan docs/ (top-level only — the docs home is FLAT): every file except the manifest
 *  itself → {logical name: repo-root-relative path}. Absent docs/ dir → empty. This is
 *  the SOURCE of truth the manifest is generated from. */
export function scanDocsDir(root: string): Record<string, string> {
  const dir = join(root, 'docs');
  if (!existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir).sort()) {
    if (f === MANIFEST_FILE) continue;
    if (!statSync(join(dir, f)).isFile()) continue; // subdirs are not docs
    out[docNameFromFile(f)] = 'docs/' + f;
  }
  return out;
}

/** Load the manifest — docs/manifest.json, or {} when absent/unreadable (a corrupt
 *  manifest resolves to nothing and the freshness check reports it; `docs --write`
 *  regenerates). A committed manifest is the only committed resolution index. */
export function loadDocsManifest(root: string): Record<string, string> {
  const p = join(root, 'docs', MANIFEST_FILE);
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, string>;
  } catch {
    /* unreadable manifest → treated as absent */
  }
  return {};
}

/** Atomic manifest write (tmp + rename — a reader never sees a partial manifest).
 *  Returns the written path. The regen path (`ann docs --write`) mirrors `ann rules
 *  --write`: the manifest is DERIVED from scanDocsDir — never hand-maintained. */
export function writeDocsManifest(root: string, manifest: Record<string, string>): string {
  const dir = join(root, 'docs');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, MANIFEST_FILE);
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
  renameSync(tmp, p);
  return p;
}

/** Manifest freshness — does the committed index AGREE with the docs/ directory? A doc
 *  file with no manifest entry would be invisible to resolution (reads/requiredInputs/
 *  F-AC19 resolve via the manifest); a manifest entry with no such file points at
 *  nothing. Either is the "run `ann docs --write`" state. */
export function docsIndexFresh(root: string): { fresh: boolean; missing: string[]; stale: string[] } {
  const scanned = scanDocsDir(root);
  const manifest = loadDocsManifest(root);
  const missing = Object.keys(scanned).filter((n) => manifest[n] !== scanned[n]); // a doc file the manifest does not name (or names differently)
  const stale = Object.keys(manifest).filter((n) => manifest[n] !== scanned[n]); // a manifest entry with no matching doc file
  return { fresh: missing.length === 0 && stale.length === 0, missing, stale };
}

/** A doc's content sha — the manifest-served pointer a reader reports and a drift
 *  check compares: blob over MARKER-STRIPPED content (same convention as the retired
 *  lock-time hash), sliced to the 7-hex idiom the derived views display. */
export function docSha(content: string): string {
  return blobSha(stripMarkers(content)).slice(0, 7);
}
