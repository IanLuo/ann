#!/usr/bin/env node
/**
 * ann — the journey CLI (S1 store seed). Read + manage through commands only;
 * never hand-edit node.json/events.jsonl (read discipline, journey-format-spec v8 §6).
 *
 * VALUE-CANONICAL (the refactor): this file is a THIN ENTRY. Every command is a PURE
 * HANDLER of a `ctx` in surface/handlers.ts that returns an `Outcome`; runMain() there
 * routes flag-stripping / dispatch / exits / errors, and the DEFAULT text is a RENDER
 * (surface/command-renderers.ts) of the SAME value `--json` emits — so the two can
 * never diverge and handlers are in-process testable.
 *
 * Usage:
 *   ann                    → name → current-path map
 *   ann <name>             → path for one doc (manifest) or a current artifact's logical name
 *   ann --journey          → the look-back (where we are + what's ahead)
 *   ann --status [filter]  → every node's derived status
 *   ann --check            → integrity + gates + docs-manifest freshness
 *   ann --specs            → the docs contract stack (docs manifest → docs/<name>.md)
 *   ann --docs [--write]   → the docs→git resolution index (docs/manifest.json; --write regenerates)
 *   ann --providers        → the adapter registry (providers · models · defaults · key state)
 *   ann project / project! add|use|remove <path>  → multi-project by PATH (own journey each)
 *   ann config / config! set <key> <val>  → user config file (masked)
 *   ann cred! set|delete <svc> <acct> [secret]  → OS keychain (dev-only)
 *   ann --branch <id>      → a node + every descendant's events
 *   ann journey <id>       → one node's full event walk
 *   ann confirm <id>       → a node's gate card (intent · ACs · gates · results)
 *   ann detail <id>        → full derived detail (contract · gates · artifacts · blockers)
 *   ann results <id> [n]   → results by kind; drill (commit/ref/evidence/link)
 *   ann append <id> '{"at":..,"type":..}'   → single-writer append (LB-3)
 *   ann spawn <id> '<contract-json>'        → create a node (validated)
 *   ann gate <id> grill|confirm accept|reject [feedback]
 *   ann read <name>        → marker-stripped content + path + sha (docs manifest name, or a legacy current artifact)
 */
import { runMain } from './handlers.js';

runMain().then(
  () => {},
  (e) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
