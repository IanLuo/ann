import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveSecret, addKeychainSecret, deleteKeychainSecret } from '../credentials.js';
import type { KeychainExec } from '../credentials.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const fakeKeychain = (entries: Record<string, string>): KeychainExec => (args, _input) => {
  if (args[0] === 'find-generic-password') {
    const key = `${args[args.indexOf('-s') + 1]}/${args[args.indexOf('-a') + 1]}`;
    const v = entries[key];
    if (!v) throw new Error('not found');
    return v;
  }
  if (args[0] === 'add-generic-password') {
    const service = args[args.indexOf('-s') + 1];
    const account = args[args.indexOf('-a') + 1];
    entries[`${service}/${account}`] = _input ?? '';
    return 'ok';
  }
  if (args[0] === 'delete-generic-password') {
    const service = args[args.indexOf('-s') + 1];
    const account = args[args.indexOf('-a') + 1];
    delete entries[`${service}/${account}`];
    return 'ok';
  }
  throw new Error('unexpected');
};

describe('resolveSecret — safe credential chain (keychain → env → literal)', () => {
  it('resolves from the macOS keychain via `security find-generic-password`', () => {
    const exec = fakeKeychain({ 'ann/llm-api-key': 'sk-secret-123' });
    const r = resolveSecret('keychain:ann/llm-api-key', exec, 'darwin');
    expect(r).toEqual({ value: 'sk-secret-123', source: 'keychain' });
  });

  it('falls back to env when the keychain entry is absent', () => {
    const exec = fakeKeychain({}); // empty keychain
    vi.stubEnv('ANN_LLM_API_KEY', 'sk-from-env');
    const r = resolveSecret('keychain:ann/llm-api-key || env:ANN_LLM_API_KEY', exec, 'darwin');
    expect(r).toEqual({ value: 'sk-from-env', source: 'env' });
  });

  it('skips keychain on non-macOS platforms (env still works)', () => {
    const exec = fakeKeychain({ 'ann/llm-api-key': 'sk-secret-123' });
    vi.stubEnv('ANN_LLM_API_KEY', 'sk-from-env');
    const r = resolveSecret('keychain:ann/llm-api-key || env:ANN_LLM_API_KEY', exec, 'linux');
    expect(r).toEqual({ value: 'sk-from-env', source: 'env' }); // keychain skipped on linux
  });

  it('returns none when nothing resolves', () => {
    const exec = fakeKeychain({});
    expect(resolveSecret('keychain:ann/x || env:ANN_DEFINITELY_UNSET_VAR', exec, 'darwin')).toEqual({ source: 'none' });
  });

  it('rejects a malformed keychain spec gracefully (tries next source)', () => {
    const exec = fakeKeychain({});
    vi.stubEnv('ANN_LLM_API_KEY', 'sk-from-env');
    expect(resolveSecret('keychain:no-slash || env:ANN_LLM_API_KEY', exec, 'darwin')).toEqual({ value: 'sk-from-env', source: 'env' });
  });
});

describe('keychain write helpers — value via stdin, never argv', () => {
  it('addKeychainSecret upserts with the secret as stdin input (not in args)', () => {
    const entries: Record<string, string> = {};
    const exec = fakeKeychain(entries);
    const args: string[][] = [];
    const spy: KeychainExec = (a, input) => {
      args.push(a);
      return exec(a, input);
    };
    addKeychainSecret('ann', 'llm-api-key', 'sk-secret-123', spy);
    expect(entries['ann/llm-api-key']).toBe('sk-secret-123');
    // the secret must NOT appear in argv
    expect(args[0].some((a) => a.includes('sk-secret'))).toBe(false);
    expect(args[0]).toContain('-w'); // stdin-marked, value passed separately
  });

  it('deleteKeychainSecret removes the entry', () => {
    const entries = { 'ann/llm-api-key': 'sk-secret-123' };
    deleteKeychainSecret('ann', 'llm-api-key', fakeKeychain(entries));
    expect(entries['ann/llm-api-key']).toBeUndefined();
  });
});
