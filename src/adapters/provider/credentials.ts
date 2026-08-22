import { execFileSync } from 'node:child_process';

/**
 * Secret resolution — SAFE credential storage for the adapter's API keys.
 *
 * Sources (tried in spec order, ' || ' separated):
 *   - `keychain:SERVICE/ACCOUNT` — macOS Keychain (encrypted at rest; read via
 *     `security find-generic-password -s SERVICE -a ACCOUNT -w`; macOS only).
 *   - `env:NAME` — environment variable.
 *   - a bare literal (discouraged — a literal key in the registry is a secret at rest).
 *
 * The resolved value is NEVER printed, logged, or written to the op-log; `ann providers`
 * shows only the SOURCE state (set/masked). Writes go through `ann cred!` →
 * `security add-generic-password` (password via stdin, never argv).
 */

export type KeychainExec = (args: string[], input?: string) => string;

/** The real macOS Keychain executor (`security` CLI) — injectable for tests. */
export const keychainExec: KeychainExec = (args, input) =>
  execFileSync('security', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'ignore'] }).trim();

export interface SecretResolution {
  value?: string;
  source: 'keychain' | 'env' | 'literal' | 'none';
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
