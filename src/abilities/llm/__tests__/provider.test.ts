import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAICompatibleAdapter } from '../http.js';
import { getAdapter, loadProviderRegistry, resolveSetting, resetProviderRegistryCache, complete } from '../index.js';
import type { ProviderDefaults, ProviderEntry } from '../index.js';

const entry = (over: Partial<ProviderEntry> = {}): ProviderEntry => ({
  id: 'test',
  kind: 'http',
  protocol: 'test protocol',
  baseUrl: 'https://llm.test/v1',
  defaultModel: 'test-model',
  ...over,
});

const defaults: ProviderDefaults = {
  maxTokens: 100,
  temperature: 0.7,
  retries: 2,
  backoffMs: 1,
  backoffMaxMs: 4,
  timeoutMs: 5000,
};

let root: string;
const fetchMock = vi.fn();

const jsonResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ann-provider-'));
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  resetProviderRegistryCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

const oplog = () => readFileSync(join(root, 'logs', 'provider.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('the op-log carries the trace/run correlation (leg 12/05 + its rework)', () => {
  it('records the CHAIN and the run the caller supplied, and omits them when there is none', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    await new OpenAICompatibleAdapter(entry(), defaults, root, { traceId: 'trace-1', runId: 'drive-run-1' }).complete('hello');
    await new OpenAICompatibleAdapter(entry(), defaults, root).complete('hello');
    const [withRun, withoutRun] = oplog();
    expect(withRun).toMatchObject({ traceId: 'trace-1', runId: 'drive-run-1', provider: 'test', ok: true });
    expect(withoutRun.runId).toBeUndefined();
    expect(withoutRun.traceId).toBeUndefined();
  });
});

describe('OpenAICompatibleAdapter — frozen contract (design §3)', () => {
  it('returns {ok:true, text, usage} on a well-formed completion', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: 'the answer' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
    );
    vi.stubEnv('ANN_TEST_KEY', 'secret');
    const adapter = new OpenAICompatibleAdapter(entry({ apiKey: 'env:ANN_TEST_KEY' }), defaults, root);

    const c = await adapter.complete('hello', { model: 'override-model' });

    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.text).toBe('the answer');
    expect(c.usage).toEqual({ inputTokens: 12, outputTokens: 3 });

    // the request went out as an OpenAI-compatible chat/completions call
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://llm.test/v1/chat/completions');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('override-model'); // per-task model selection wins
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0.7);
    expect(init.headers).toMatchObject({ authorization: 'Bearer secret' });
  });

  it('retries on 429 then succeeds — bounded retry/backoff, retries counted in the op log', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'rate limited' }, 429))
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 503))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const adapter = new OpenAICompatibleAdapter(entry(), defaults, root);

    const c = await adapter.complete('p');

    expect(c.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(oplog()[0]).toMatchObject({ ok: true, retries: 2, provider: 'test', model: 'test-model' });
  });

  it('exhausts retries → fail-closed failure VALUE naming the blocker (never throws, never silent)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'down' }, 500));
    const adapter = new OpenAICompatibleAdapter(entry(), defaults, root);

    let c;
    try {
      c = await adapter.complete('p');
    } catch {
      expect.unreachable('adapter must return a failure value, not throw');
    }
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.error.code).toBe('provider-unavailable');
    expect(c.error.blocker).toContain("provider 'test' failed after 2 retries");
    expect(c.error.blocker).toContain('HTTP 500');
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + retries(2)
    expect(oplog()[0]).toMatchObject({ ok: false, retries: 2, error: { code: 'provider-unavailable' } });
  });

  it('treats empty/unstructured completions as failure — never fabricated (design §5)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: '   ' } }] }));
    const adapter = new OpenAICompatibleAdapter(entry(), defaults, root);

    const c = await adapter.complete('p');
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.error.code).toBe('bad-response');
    expect(c.error.blocker).toContain('never fabricated');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a 200 with no choices as bad-response (not an empty success)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ choices: [] }));
    const adapter = new OpenAICompatibleAdapter(entry(), defaults, root);
    const c = await adapter.complete('p');
    expect(c).toEqual({ ok: false, error: { code: 'bad-response', blocker: expect.stringContaining('empty/unstructured') } });
  });

  it('network failure → bounded retries → named failure, never silent', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const adapter = new OpenAICompatibleAdapter(entry(), defaults, root);
    const c = await adapter.complete('p');
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.error.blocker).toContain('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('non-retryable 4xx fails immediately with the response snippet named', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'invalid api key' } }, 401));
    const adapter = new OpenAICompatibleAdapter(entry({ apiKey: 'env:ANN_TEST_KEY' }), defaults, root);
    vi.stubEnv('ANN_TEST_KEY', 'wrong');
    const c = await adapter.complete('p');
    expect(c.ok).toBe(false);
    if (c.ok) return;
    expect(c.error.blocker).toContain('HTTP 401');
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry on 401
  });

  it('writes the runtime op log — one entry per call, never in the tree (design §4)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
    const adapter = new OpenAICompatibleAdapter(entry(), defaults, root);

    await adapter.complete('first');
    await adapter.complete('second');

    const lines = oplog();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ provider: 'test', model: 'test-model', ok: true, promptChars: 5 });
    expect(typeof lines[0].latencyMs).toBe('number');
    expect(lines[0].at).toBeTruthy();
  });
});

describe('registry + adapter resolution (resource-registry spec, category adapter)', () => {
  it('loads the real registry: defaultProvider resolves, getAdapter returns an adapter', () => {
    const reg = loadProviderRegistry();
    expect(reg.defaultProvider).toBe('openai-compatible');
    expect(reg.providers.some((p) => p.id === 'openai-compatible')).toBe(true);
    expect(getAdapter()).toBeInstanceOf(OpenAICompatibleAdapter);
  });

  it('unknown provider → fail-closed with the unknown id named', () => {
    expect(() => getAdapter('no-such-provider')).toThrow(/no-such-provider/);
  });

  it('fails loudly on an unsupported provider kind — no silent wrong transport', () => {
    const regRoot = join(root, 'reg1');
    mkdirSync(join(regRoot, 'rules', 'adapter'), { recursive: true });
    writeFileSync(
      join(regRoot, 'rules', 'adapter', 'provider.json'),
      JSON.stringify({
        registry: 'x',
        defaultProvider: 'a',
        providers: [{ id: 'a', kind: 'anthropic-native', protocol: 'x', baseUrl: 'https://x', defaultModel: 'm' }],
        defaults: { maxTokens: 100, temperature: 0.7, retries: 3, backoffMs: 500, backoffMaxMs: 8000, timeoutMs: 60000 },
      }),
    );
    expect(() => loadProviderRegistry(regRoot)).toThrow(/kind 'anthropic-native'/);
  });

  it('fails loudly on missing defaults — no silent NaN retry/backoff math', () => {
    const regRoot = join(root, 'reg2');
    mkdirSync(join(regRoot, 'rules', 'adapter'), { recursive: true });
    writeFileSync(
      join(regRoot, 'rules', 'adapter', 'provider.json'),
      JSON.stringify({
        registry: 'x',
        defaultProvider: 'a',
        providers: [{ id: 'a', kind: 'http', protocol: 'x', baseUrl: 'https://x', defaultModel: 'm' }],
        defaults: { maxTokens: 100 },
      }),
    );
    expect(() => loadProviderRegistry(regRoot)).toThrow(/must be a number/);
  });

  it('facade complete() routes by provider to the right endpoint (frozen contract, per call)', async () => {
    // a fixture registry in a temp root (logRoot doubles as the registry root)
    const regRoot = join(root, 'reg3');
    mkdirSync(join(regRoot, 'rules', 'adapter'), { recursive: true });
    writeFileSync(
      join(regRoot, 'rules', 'adapter', 'provider.json'),
      JSON.stringify({
        registry: 'x',
        defaultProvider: 'openai-compatible',
        providers: [{ id: 'openai-compatible', kind: 'http', protocol: 'x', baseUrl: 'https://fixture.test/v1', defaultModel: 'm' }],
        defaults: { maxTokens: 100, temperature: 0.7, retries: 3, backoffMs: 500, backoffMaxMs: 8000, timeoutMs: 60000 },
      }),
    );
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const c = await complete('hi', { provider: 'openai-compatible' }, regRoot);
    expect(c.ok).toBe(true);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://fixture.test/v1/chat/completions');
  });

  it('refuses a per-call provider mismatch — never silently wrong (frozen contract)', async () => {
    const adapter = new OpenAICompatibleAdapter(entry(), defaults, root);
    const c = await adapter.complete('p', { provider: 'other-provider' });
    expect(c).toEqual({ ok: false, error: { code: 'invalid-config', blocker: expect.stringContaining('other-provider') } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts opts.provider when it matches the bound provider', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const adapter = new OpenAICompatibleAdapter(entry(), defaults, root);
    const c = await adapter.complete('p', { provider: 'test' });
    expect(c.ok).toBe(true);
  });
});

describe('resolveSetting — env or literal-fallback (config in data, never hardcoded)', () => {
  it('resolves env:NAME from the environment', () => {
    vi.stubEnv('ANN_TEST_VAR', 'from-env');
    expect(resolveSetting('env:ANN_TEST_VAR')).toBe('from-env');
  });
  it('falls back to the literal when the env var is unset', () => {
    expect(resolveSetting('env:ANN_DEFINITELY_UNSET_VAR || https://fallback.test')).toBe('https://fallback.test');
  });
  it('passes bare literals through', () => {
    expect(resolveSetting('https://direct.test/v1')).toBe('https://direct.test/v1');
  });
});
