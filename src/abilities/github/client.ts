import {
  CreateIssueParams,
  CreatePullRequestParams,
  DestructiveParams,
  GitHubProvenance,
  GitHubResult,
} from './types.js';

/**
 * S7 — THE GITHUB CLIENT (functional-spec F13).
 *
 * Issue/PR creation via the GitHub REST API, fail-closed (AC-4/AC-5 of the binding):
 *
 *   - every action returns a PROVENANCE record (AC6: action · result · links) — the
 *     client never fabricates success; a failed action is a structured error
 *   - DESTRUCTIVE actions (closing an issue/PR) require `{ confirm: true }` — the
 *     explicit human signal — and REFUSE otherwise, naming the confirmation required
 *     (NFR-SEC-1: destructive binding actions require confirmation)
 *   - the token is a SECRET: it rides only in the request Authorization header, is
 *     never logged, and never appears in a provenance record
 *
 * The transport is INJECTABLE (the unit tests mock it); the default is a fetch-backed
 * transport. The client is a standalone L3 servant — it does not enter the L2 `Abilities`
 * interface (llm · interact · shell · tool), and it never touches the store.
 */

export interface GithubTransportRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface GithubTransportResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

export interface GithubTransport {
  request(req: GithubTransportRequest): Promise<GithubTransportResponse>;
}

export interface GithubClientOptions {
  owner: string;
  repo: string;
  /** The GitHub token (a SECRET — resolved from GITHUB_TOKEN by the caller; never logged). */
  token: string;
  /** Injectable transport — the unit-test seam. Defaults to a fetch-backed transport. */
  transport?: GithubTransport;
  /** Override the API base URL (tests / GitHub Enterprise). */
  baseUrl?: string;
}

export const GITHUB_API_BASE = 'https://api.github.com';
export const GITHUB_REQUEST_TIMEOUT_MS = 15_000;

/** The default transport — a thin fetch client over the GitHub REST API. */
export function fetchTransport(opts: { baseUrl: string; token: string }): GithubTransport {
  return {
    async request(req: GithubTransportRequest): Promise<GithubTransportResponse> {
      const res = await fetch(`${opts.baseUrl}${req.path}`, {
        method: req.method,
        headers: {
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          authorization: `Bearer ${opts.token}`,
          'user-agent': 'ann',
        },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      let body: unknown = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text };
      }
      return { status: res.status, ok: res.ok, body };
    },
  };
}

/** Resolve the GitHub token — `GITHUB_TOKEN`, fail-closed when unset (never a tokenless
 *  request, never a silent empty auth). */
export function resolveGithubToken(): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token || !token.trim()) {
    throw new Error('github binding: GITHUB_TOKEN is unset — set it (fail-closed: a tokenless request would 401, and a silent default would be a fabricated decision)');
  }
  return token.trim();
}

export class GithubClient {
  private readonly owner: string;
  private readonly repo: string;
  private readonly transport: GithubTransport;

  constructor(opts: GithubClientOptions) {
    if (!opts.owner.trim()) throw new Error('github binding: owner is required');
    if (!opts.repo.trim()) throw new Error('github binding: repo is required');
    if (!opts.token.trim()) throw new Error('github binding: token is required — GITHUB_TOKEN unset (fail-closed)');
    this.owner = opts.owner.trim();
    this.repo = opts.repo.trim();
    this.transport = opts.transport ?? fetchTransport({ baseUrl: opts.baseUrl ?? GITHUB_API_BASE, token: opts.token });
  }

  /** F13 — create an issue. Non-destructive. */
  async createIssue(params: CreateIssueParams): Promise<GitHubResult> {
    if (!params.title || !params.title.trim()) {
      return { ok: false, error: { code: 'bad-params', blocker: "create-issue: 'title' is required" } };
    }
    const body: Record<string, unknown> = { title: params.title.trim() };
    if (params.body !== undefined && params.body !== '') body.body = params.body;
    if (params.labels !== undefined && params.labels.length) body.labels = params.labels;
    return this.act('create-issue', 'POST', `/repos/${this.owner}/${this.repo}/issues`, body, {
      title: params.title,
      ...(params.body !== undefined ? { body: params.body } : {}),
      ...(params.labels !== undefined ? { labels: params.labels } : {}),
    });
  }

  /** F13 — create a pull request. Non-destructive. */
  async createPullRequest(params: CreatePullRequestParams): Promise<GitHubResult> {
    if (!params.title || !params.title.trim()) {
      return { ok: false, error: { code: 'bad-params', blocker: "create-pr: 'title' is required" } };
    }
    if (!params.head || !params.head.trim() || !params.base || !params.base.trim()) {
      return { ok: false, error: { code: 'bad-params', blocker: "create-pr: 'head' and 'base' branches are required" } };
    }
    const body: Record<string, unknown> = { title: params.title.trim(), head: params.head.trim(), base: params.base.trim() };
    if (params.body !== undefined && params.body !== '') body.body = params.body;
    return this.act('create-pr', 'POST', `/repos/${this.owner}/${this.repo}/pulls`, body, {
      title: params.title,
      head: params.head,
      base: params.base,
      ...(params.body !== undefined ? { body: params.body } : {}),
    });
  }

  /** DESTRUCTIVE — closing an issue is irreversible to an open state without a human;
   *  requires `{ confirm: true }`, refuses otherwise (NFR-SEC-1). */
  async closeIssue(issueNumber: number, opts: DestructiveParams): Promise<GitHubResult> {
    if (opts.confirm !== true) {
      return this.refuse('close-issue', "closing an issue is DESTRUCTIVE — pass { confirm: true } to confirm the action");
    }
    return this.act('close-issue', 'PATCH', `/repos/${this.owner}/${this.repo}/issues/${issueNumber}`, { state: 'closed' }, { issueNumber });
  }

  /** DESTRUCTIVE — requires `{ confirm: true }`, refuses otherwise (NFR-SEC-1). */
  async closePullRequest(prNumber: number, opts: DestructiveParams): Promise<GitHubResult> {
    if (opts.confirm !== true) {
      return this.refuse('close-pr', "closing a pull request is DESTRUCTIVE — pass { confirm: true } to confirm the action");
    }
    return this.act('close-pr', 'PATCH', `/repos/${this.owner}/${this.repo}/pulls/${prNumber}`, { state: 'closed' }, { prNumber });
  }

  /** The destructive-action refusal — a named confirmation-required error, never a silent no-op. */
  private refuse(action: string, blocker: string): GitHubResult {
    return { ok: false, error: { code: 'confirmation-required', blocker: `github '${action}': ${blocker}` } };
  }

  /** One action: run the request, map to a PROVENANCE result or a structured error —
   *  no fake success (the binding's fail-closed rule). */
  private async act(
    action: string,
    method: string,
    path: string,
    payload: Record<string, unknown>,
    params: Record<string, unknown>,
  ): Promise<GitHubResult> {
    let res: GithubTransportResponse;
    try {
      res = await this.transport.request({ method, path, body: payload });
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 'github-unavailable',
          blocker: `github '${action}' failed before a response: ${e instanceof Error ? e.message : 'request failed'}`,
        },
      };
    }
    if (!res.ok) {
      const b = (res.body ?? {}) as Record<string, unknown>;
      const msg = typeof b.message === 'string' && b.message.trim() ? b.message : JSON.stringify(b);
      return {
        ok: false,
        error: {
          code: 'github-api',
          blocker: `github '${action}' failed: HTTP ${res.status} — ${msg}`,
        },
      };
    }
    return { ok: true, value: this.provenance(action, params, (res.body ?? {}) as Record<string, unknown>) };
  }

  /** AC6 — the provenance artifact: action · result · links. Params are the REDACTED
   *  param record (no token, no credentials — NFR-SEC-1). */
  private provenance(action: string, params: Record<string, unknown>, result: Record<string, unknown>): GitHubProvenance {
    return {
      system: 'github',
      action,
      params,
      result,
      links: {
        html: typeof result.html_url === 'string' ? result.html_url : '',
        api: typeof result.url === 'string' ? result.url : '',
      },
      at: new Date().toISOString(),
    };
  }
}
