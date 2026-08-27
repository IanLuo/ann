import { execFileSync } from 'node:child_process';
import { loadConfig } from './config.js';

/**
 * Secret resolution — where the adapter's API keys come from.
 *
 * The PRODUCT is a web app: credentials are SERVER-SIDE, environment-injected
 * (12-factor — the deployment platform / secrets manager sets the env at runtime;
 * the browser client never holds the key, the adapter runs server-side and reads
 * its env). The macOS Keychain is a DEV-ONLY convenience for the local CLI — it is
 * NOT a valid credential store for a web app (no keychain on a server, and the
 * client must never see the key).
 *
 * Sources (tried in spec order, ' || ' separated):
 *   - `env:NAME` — the product path: server-side env (platform/secrets-manager injected).
 *   - `keychain:SERVICE/ACCOUNT` — macOS Keychain (dev-only, local CLI; read via
 *     `security find-generic-password -s SERVICE -a ACCOUNT -w`; macOS only).
 *   - a bare literal (discouraged — a literal key in the registry is a secret at rest).
 *
 * The resolved value is NEVER printed, logged, or written to the op-log; `ann providers`
 * shows only the SOURCE state (set/masked). `ann cred!` writes to the keychain
 * (dev-only); production credentials are set via the server environment.
 */

export type KeychainExec = (args: string[], input?: string) => string;

/** The real macOS Keychain executor (`security` CLI) — injectable for tests. */
export const keychainExec: KeychainExec = (args, input) =>
  execFileSync('security', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'ignore'] }).trim();

export interface SecretResolution {
  value?: string;
  source: 'keychain' | 'env' | 'config' | 'literal' | 'none';
}

/** Resolve a secret spec — first resolvable source wins. Value is returned in memory
 *  only; nothing logs or prints it. Platform injectable for tests. */
export function resolveSecret(spec: string, exec: KeychainExec = keychainExec, platform: string = process.platform): SecretResolution {
  for (const part of spec.split('||').map((p) => p.trim())) {
    if (part.startsWith('keychain:')) {
      const rest = part.slice('keychain:'.length).split('/');
      if (rest.length !== 2 || !rest[0] || !rest[1]) continue;
      if (platform !== 'darwin') continue; // keychain is macOS-native
      try {
        const value = exec(['find-generic-password', '-s', rest[0], '-a', rest[1], '-w']);
        if (value) return { value, source: 'keychain' };
      } catch {
        continue; // not found → try the next source
      }
    } else if (part.startsWith('env:')) {
      const v = process.env[part.slice(4).trim()];
      if (v) return { value: v, source: 'env' };
      // env unset → the user config file (local app; chmod 600, masked everywhere)
      const cfg = loadConfig().apiKey;
      if (cfg) return { value: cfg, source: 'config' };
    } else if (part) {
      return { value: part, source: 'literal' };
    }
  }
  return { source: 'none' };
}

/** Save a secret to the macOS Keychain. The password goes via STDIN (security's
 *  documented behavior when -w has no value) — never through argv, so it is not
 *  visible in `ps`. Upserts (`-U`). */
export function addKeychainSecret(service: string, account: string, secret: string, exec: KeychainExec = keychainExec): void {
  exec(['add-generic-password', '-s', service, '-a', account, '-w', '-U'], secret);
}

/** Delete a secret from the macOS Keychain (no error if absent). */
export function deleteKeychainSecret(service: string, account: string, exec: KeychainExec = keychainExec): void {
  try {
    exec(['delete-generic-password', '-s', service, '-a', account]);
  } catch {
    /* absent — nothing to delete */
  }
}
