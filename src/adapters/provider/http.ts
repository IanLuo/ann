import { writeOpLog } from './oplog.js';
import { resolveSecret } from './credentials.js';
import { ProviderDefaults, ProviderEntry, resolveSetting } from './registry.js';
import { AdapterError, Completion, CompletionOptions, ProviderAdapter } from './types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Verdict = { kind: 'retry'; error: AdapterError } | { kind: 'done'; completion: Completion };

interface ChatBody {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Thin OpenAI-compatible chat/completions client (design TS-6): bounded
 * retry/backoff, then fail-closed with a named blocker — never silent, never
 * fabricated (design §5/§12). Writes the runtime op log per call (design §4).
 * The ONLY LLM transport in v1; engines reach it via the frozen ProviderAdapter
 * interface, never directly.
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly model: string;

  constructor(
    private readonly entry: ProviderEntry,
    private readonly defaults: ProviderDefaults,
    private readonly logRoot: string = process.cwd(),
  ) {
    const base = resolveSetting(entry.baseUrl);
    if (!base) {
      throw new Error(`provider '${entry.id}': baseUrl unresolved — set the env var or fix rules/adapter/provider.json`);
    }
    this.baseUrl = base.replace(/\/+$/, '');
    // the API key is a SECRET — resolved via the safe chain (keychain → env),
    // never logged, never written to the op-log, never printed.
    this.apiKey = entry.apiKey ? resolveSecret(entry.apiKey).value : undefined;
    const model = resolveSetting(entry.defaultModel);
    if (!model) {
      throw new Error(`provider '${entry.id}': defaultModel unresolved — set the env var or fix rules/adapter/provider.json`);
    }
    this.model = model;
  }

  async complete(prompt: string, opts?: CompletionOptions): Promise<Completion> {
    // Frozen contract: provider selectable per call. An adapter is bound to one
    // provider entry — a mismatched request must fail closed, never silently
    // use the wrong provider. Route via the facade (index.complete) to switch.
    if (opts?.provider && opts.provider !== this.entry.id) {
      return {
        ok: false,
        error: {
          code: 'invalid-config',
          blocker: `adapter is bound to provider '${this.entry.id}' but the call requested '${opts.provider}' — route via the facade (complete) which resolves by provider (never silently wrong)`,
        },
      };
    }
    const model = opts?.model ?? this.model;
    const maxTokens = opts?.maxTokens ?? this.defaults.maxTokens;
    const started = Date.now();
    let retries = 0;
    let lastError: AdapterError = {
      code: 'provider-unavailable',
      blocker: `provider '${this.entry.id}' failed before any request`,
    };

    for (;;) {
      const verdict = await this.requestOnce(prompt, model, maxTokens);
      if (verdict.kind === 'done') {
        this.log(started, retries, model, maxTokens, prompt, verdict.completion);
        return verdict.completion;
      }
      lastError = verdict.error;
      if (retries >= this.defaults.retries) break;
      await sleep(this.backoff(retries));
      retries++;
    }

    const completion: Completion = {
      ok: false,
      error: {
        code: lastError.code,
        blocker: `provider '${this.entry.id}' failed after ${retries} retr${retries === 1 ? 'y' : 'ies'}: ${lastError.blocker}`,
      },
    };
    this.log(started, retries, model, maxTokens, prompt, completion);
    return completion;
  }

  /** One request attempt: success / non-retryable failure → done; 429/5xx/network/timeout → retry. */
  private async requestOnce(prompt: string, model: string, maxTokens: number): Promise<Verdict> {
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: this.defaults.temperature,
        }),
        signal: AbortSignal.timeout(this.defaults.timeoutMs),
      });

      if (res.status === 429 || res.status >= 500) {
        return { kind: 'retry', error: { code: 'provider-unavailable', blocker: `HTTP ${res.status}` } };
      }
      if (!res.ok) {
        const snippet = (await res.text()).slice(0, 200);
        return {
          kind: 'done',
          completion: {
            ok: false,
            error: { code: 'provider-unavailable', blocker: `HTTP ${res.status}: ${snippet}` },
          },
        };
      }

      const body = (await res.json()) as ChatBody;
      const text = body?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || text.trim() === '') {
        return {
          kind: 'done',
          completion: {
            ok: false,
            error: {
              code: 'bad-response',
              blocker: 'empty/unstructured completion — treated as failure, never fabricated',
            },
          },
        };
      }
      return {
        kind: 'done',
        completion: {
          ok: true,
          text,
          usage: {
            inputTokens: body?.usage?.prompt_tokens ?? 0,
            outputTokens: body?.usage?.completion_tokens ?? 0,
          },
        },
      };
    } catch (e) {
      return {
        kind: 'retry',
        error: { code: 'provider-unavailable', blocker: e instanceof Error ? e.message : 'request failed' },
      };
    }
  }

  /** Exponential backoff, capped (defaults.backoffMaxMs). */
  private backoff(attempt: number): number {
    return Math.min(this.defaults.backoffMs * 2 ** attempt, this.defaults.backoffMaxMs);
  }

  private log(started: number, retries: number, model: string, maxTokens: number, prompt: string, completion: Completion): void {
    writeOpLog(this.logRoot, {
      at: new Date().toISOString(),
      provider: this.entry.id,
      model,
      promptChars: prompt.length,
      maxTokens,
      ok: completion.ok,
      latencyMs: Date.now() - started,
      retries,
      ...(completion.ok ? {} : { error: completion.error }),
    });
  }
}
