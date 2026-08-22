import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, setConfig, maskedConfig, configPath, resetConfigCache, listProjects, findProject, getCurrentProject, setProject, useProject, removeProject } from '../config.js';
import { resolveSetting } from '../registry.js';
import { resolveSecret } from '../credentials.js';
import type { KeychainExec } from '../credentials.js';

let dir: string;
const cfg = (name: string) => join(dir, name);

afterEach(() => {
  resetConfigCache();
  delete process.env.ANN_CONFIG;
  delete process.env.ANN_LLM_MODEL;
  rmSync(dir, { recursive: true, force: true });
});

const withConfig = (name: string) => {
  dir = mkdtempSync(join(tmpdir(), 'ann-cfg-'));
  process.env.ANN_CONFIG = cfg(name);
  resetConfigCache();
};

describe('user config file (~/.config/ann/config.json equivalent)', () => {
  it('loads an existing config file', () => {
    withConfig('a.json');
    const { writeFileSync } = require('node:fs');
    writeFileSync(cfg('a.json'), JSON.stringify({ model: 'my-model', baseUrl: 'https://x.test/v1' }));
    expect(loadConfig()).toEqual({ model: 'my-model', baseUrl: 'https://x.test/v1' });
  });

  it('returns an empty config when absent (env/fallbacks still apply)', () => {
    withConfig('missing.json');
    expect(loadConfig()).toEqual({});
  });

  it('setConfig writes with chmod 600 and masks the apiKey in maskedConfig', () => {
    withConfig('b.json');
    setConfig('apiKey', 'sk-secret-123');
    setConfig('model', 'gpt-x');
    // file exists, user-only
    expect(existsSync(cfg('b.json'))).toBe(true);
    expect(statSync(cfg('b.json')).mode & 0o777).toBe(0o600);
    // masked view never leaks the key
    expect(maskedConfig()).toEqual({ apiKey: 'SET (masked)', model: 'gpt-x' });
    // the file itself holds the plaintext (trust model: local, 600 — like ~/.aws/credentials)
    expect(readFileSync(cfg('b.json'), 'utf8')).toContain('sk-secret-123');
  });
});

describe('resolution: env > config file > fallback', () => {
  it('config file supplies a setting when the env var is unset', () => {
    withConfig('c.json');
    setConfig('baseUrl', 'https://cfg.test/v1');
    expect(resolveSetting('env:ANN_LLM_BASE_URL || https://api.openai.com/v1', 'baseUrl')).toBe('https://cfg.test/v1');
  });

  it('env still wins over the config file (deployment override)', () => {
    withConfig('d.json');
    setConfig('baseUrl', 'https://cfg.test/v1');
    process.env.ANN_LLM_BASE_URL = 'https://env.test/v1';
    expect(resolveSetting('env:ANN_LLM_BASE_URL || https://api.openai.com/v1', 'baseUrl')).toBe('https://env.test/v1');
  });

  it('falls back to the registry literal when neither env nor config is set', () => {
    withConfig('e.json');
    expect(resolveSetting('env:ANN_LLM_MODEL || gpt-4o-mini', 'model')).toBe('gpt-4o-mini');
  });
});

describe('secret chain: env > config > keychain', () => {
  const noKeychain: KeychainExec = () => {
    throw new Error('not found');
  };

  it('config file apiKey is used when env is unset and keychain is empty', () => {
    withConfig('f.json');
    setConfig('apiKey', 'sk-from-config');
    const r = resolveSecret('env:ANN_LLM_API_KEY || keychain:ann/llm-api-key', noKeychain, 'darwin');
    expect(r).toEqual({ value: 'sk-from-config', source: 'config' });
  });

  it('env beats config beats keychain', () => {
    withConfig('g.json');
    setConfig('apiKey', 'sk-from-config');
    process.env.ANN_LLM_API_KEY = 'sk-from-env';
    expect(resolveSecret('env:ANN_LLM_API_KEY || keychain:ann/llm-api-key', noKeychain, 'darwin')).toEqual({ value: 'sk-from-env', source: 'env' });
  });
});

describe('project registry (each project has its own journey)', () => {
  it('add / find / use / remove a project', () => {
    withConfig('p.json');
    expect(listProjects()).toEqual([]);
    setProject('alpha', '/projects/alpha');
    setProject('beta', '/projects/beta');
    expect(listProjects().map((p) => p.name)).toEqual(['alpha', 'beta']);
    expect(findProject('alpha')).toEqual({ name: 'alpha', path: '/projects/alpha' });
    expect(getCurrentProject()).toBeUndefined();
    useProject('beta');
    expect(getCurrentProject()).toEqual({ name: 'beta', path: '/projects/beta' });
    removeProject('beta');
    expect(findProject('beta')).toBeUndefined();
    expect(getCurrentProject()).toBeUndefined(); // removing the current clears it
  });

  it('useProject fails closed on an unknown project', () => {
    withConfig('q.json');
    expect(() => useProject('nope')).toThrow(/not found/);
  });

  it('setProject replaces an existing entry (name is the key)', () => {
    withConfig('r.json');
    setProject('alpha', '/first');
    setProject('alpha', '/second');
    expect(listProjects()).toEqual([{ name: 'alpha', path: '/second' }]);
  });
});
