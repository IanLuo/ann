import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GithubClient, fetchTransport, resolveGithubToken, GithubTransport } from '../index.js';

/** A recorded transport — records every request, returns a canned response. */
const recordingTransport = (responses: Array<{ status: number; body: unknown }>) => {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const transport: GithubTransport = {
    async request(req) {
      calls.push(req);
      const r = responses[Math.min(calls.length - 1, responses.length - 1)];
      return { status: r.status, ok: r.status >= 200 && r.status < 400, body: r.body };
    },
  };
  return { transport, calls };
};

const client = (t: GithubTransport) => new GithubClient({ owner: 'owner', repo: 'repo', token: 'tok_123', transport: t });

const issueBody = (n: number) => ({
  id: n,
  number: n,
  title: `issue ${n}`,
  state: 'open',
  html_url: `https://github.com/owner/repo/issues/${n}`,
  url: `https://api.github.com/repos/owner/repo/issues/${n}`,
});

describe('GithubClient — create issue/PR (F13, AC-1)', () => {
  it('creates an issue: POSTs the right payload and returns a provenance artifact (AC6)', async () => {
    const { transport, calls } = recordingTransport([{ status: 201, body: issueBody(7) }]);
    const r = await client(transport).createIssue({ title: 'the title', body: 'the body', labels: ['bug'] });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].path).toBe('/repos/owner/repo/issues');
    expect(calls[0].body).toEqual({ title: 'the title', body: 'the body', labels: ['bug'] });

    // the provenance artifact: action · result · links (AC6)
    expect(r.value.system).toBe('github');
    expect(r.value.action).toBe('create-issue');
    expect(r.value.result).toMatchObject({ number: 7, state: 'open' });
    expect(r.value.links.html).toBe('https://github.com/owner/repo/issues/7');
    expect(r.value.links.api).toBe('https://api.github.com/repos/owner/repo/issues/7');
    expect(typeof r.value.at).toBe('string');
  });

  it('creates a pull request with head/base', async () => {
    const { transport, calls } = recordingTransport([
      { status: 201, body: { number: 3, html_url: 'https://github.com/owner/repo/pull/3', url: 'https://api.github.com/repos/owner/repo/pulls/3' } },
    ]);
    const r = await client(transport).createPullRequest({ title: 'pr title', head: 'feature', base: 'main' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls[0].path).toBe('/repos/owner/repo/pulls');
    expect(calls[0].body).toEqual({ title: 'pr title', head: 'feature', base: 'main' });
    expect(r.value.action).toBe('create-pr');
    expect(r.value.params).not.toHaveProperty('token');
  });

  it('omits optional body/labels when absent', async () => {
    const { transport, calls } = recordingTransport([{ status: 201, body: issueBody(1) }]);
    await client(transport).createIssue({ title: 'bare' });
    expect(calls[0].body).toEqual({ title: 'bare' });
  });

  it('rejects a missing issue title (bad-params, fail-closed)', async () => {
    const { transport, calls } = recordingTransport([{ status: 201, body: issueBody(1) }]);
    const r = await client(transport).createIssue({ title: '   ' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('bad-params');
    expect(calls).toHaveLength(0); // no request was made
  });

  it('rejects missing head/base on a PR', async () => {
    const { transport, calls } = recordingTransport([{ status: 201, body: {} }]);
    const r = await client(transport).createPullRequest({ title: 't', head: '', base: 'main' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('bad-params');
    expect(calls).toHaveLength(0);
  });
});

describe('GithubClient — destructive actions require confirmation (AC-3, NFR-SEC-1)', () => {
  it('refuses to close an issue without { confirm: true } — and makes NO request', async () => {
    const { transport, calls } = recordingTransport([{ status: 200, body: {} }]);
    const r = await client(transport).closeIssue(7, {} as never);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('confirmation-required');
    expect(calls).toHaveLength(0); // the refusal happens before any API call
  });

  it('closes an issue once confirm:true is given (PATCH state=closed)', async () => {
    const { transport, calls } = recordingTransport([{ status: 200, body: { number: 7, state: 'closed', html_url: 'https://github.com/owner/repo/issues/7', url: 'https://api.github.com/repos/owner/repo/issues/7' } }]);
    const r = await client(transport).closeIssue(7, { confirm: true });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].path).toBe('/repos/owner/repo/issues/7');
    expect(calls[0].body).toEqual({ state: 'closed' });
    expect(r.value.action).toBe('close-issue');
  });

  it('refuses to close a PR without confirmation', async () => {
    const { transport, calls } = recordingTransport([{ status: 200, body: {} }]);
    const r = await client(transport).closePullRequest(3, { confirm: false } as never);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('confirmation-required');
    expect(calls).toHaveLength(0);
  });
});

describe('GithubClient — no fake success, fail-closed (AC-4)', () => {
  it('returns a structured error on an API failure (HTTP 422) — never a fake success', async () => {
    const { transport } = recordingTransport([{ status: 422, body: { message: 'Validation Failed' } }]);
    const r = await client(transport).createIssue({ title: 't' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('github-api');
    expect(r.error.blocker).toContain('HTTP 422');
    expect(r.error.blocker).toContain('Validation Failed');
  });

  it('returns a structured error when the transport throws (github-unavailable)', async () => {
    const transport: GithubTransport = {
      async request() {
        throw new Error('network down');
      },
    };
    const r = await client(transport).createIssue({ title: 't' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('github-unavailable');
    expect(r.error.blocker).toContain('network down');
  });

  it('never puts the token in the provenance params', async () => {
    const { transport } = recordingTransport([{ status: 201, body: issueBody(1) }]);
    const r = await client(transport).createIssue({ title: 't', body: 'b' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(r.value.params)).not.toContain('tok_123');
  });
});

describe('GithubClient — construction + token resolution (fail-closed)', () => {
  it('throws at construction without a token', () => {
    expect(() => new GithubClient({ owner: 'o', repo: 'r', token: '  ' })).toThrow(/token is required/);
  });

  it('throws at construction without owner/repo', () => {
    expect(() => new GithubClient({ owner: '', repo: 'r', token: 't' })).toThrow(/owner is required/);
  });

  it('resolveGithubToken reads GITHUB_TOKEN and refuses when unset', () => {
    const prev = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      expect(() => resolveGithubToken()).toThrow(/GITHUB_TOKEN is unset/);
    } finally {
      if (prev !== undefined) process.env.GITHUB_TOKEN = prev;
    }
  });
});

describe('fetchTransport — real header shape (seam sanity)', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('sends Bearer auth, JSON body, and parses the response', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const t = fetchTransport({ baseUrl: 'https://api.github.test', token: 'tok_x' });
    const res = await t.request({ method: 'POST', path: '/repos/o/r/issues', body: { title: 't' } });

    expect(res.ok).toBe(true);
    expect(res.body).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.test/repos/o/r/issues');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok_x');
    expect(init.body).toContain('"title":"t"');
  });
});
