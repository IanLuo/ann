/**
 * The provider adapter contract — FROZEN (ann-system-design v3 §3):
 *   complete(prompt, {provider?, model?, maxTokens}) → {text, usage}
 * provider/model selectable per call (task grain); bounded retry/backoff;
 * provider errors map to design §12 outcomes, never silent.
 *
 * Failure is a VALUE (architecture rung 4: {ok:false, error:{code, blocker}}),
 * never an exception-as-flow. On success the shape is exactly the frozen
 * {text, usage}. Consumers narrow on `ok`.
 */

export interface CompletionOptions {
  /** Provider id from the adapter registry (rules/adapter/provider.json); defaults to the registry default. */
  provider?: string;
  /** Model id; overrides the provider's default — per-task model selection (task grain, design §3 / Q2). */
  model?: string;
  /** Max output tokens; defaults to the registry default. */
  maxTokens?: number;
}

export interface CompletionUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Fail-closed, blocker named, never silent (design §5/§12 — retry · ask_user · block). */
export interface AdapterError {
  code: 'provider-unavailable' | 'bad-response' | 'invalid-config';
  /** The named blocker: what failed and why — never fabricated, never empty. */
  blocker: string;
}

/** Success — exactly the frozen `{text, usage}` (design §3). */
export interface CompletionSuccess {
  ok: true;
  text: string;
  usage: CompletionUsage;
}

export interface CompletionFailure {
  ok: false;
  error: AdapterError;
}

export type Completion = CompletionSuccess | CompletionFailure;

/** The frozen provider-adapter interface: the ONLY way engines reach an LLM
 *  (no direct provider access — task AC-4). Engines receive this interface via
 *  getAdapter(); tests substitute a mock. */
export interface ProviderAdapter {
  complete(prompt: string, opts?: CompletionOptions): Promise<Completion>;
}
