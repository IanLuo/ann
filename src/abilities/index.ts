import { createInterface } from 'node:readline/promises';
import { ProviderAdapter } from '../adapters/provider/index.js';
import { Abilities, InteractAbility, LlmAbility, ResearchFinding } from '../flow/types.js';

export { recording } from './recording.js';

/**
 * L3 — THE ABILITIES (core-design §1, §2). L2 DEFINES the protocols; L3 implements
 * them. An ability never touches the store: effects leave a step as declared INTENTS,
 * and the only writer stays L1.
 *
 *   llm      — the frozen ProviderAdapter, wrapped. The op-log is already written at
 *              the adapter; the transcript half of the two-log trace is the recording
 *              wrapper's job (src/abilities/recording.ts), not this one's.
 *   interact — the human channel, FOUR verbs. The console implementation is v1's; the
 *              real talk/UI adapter (S8) plugs in at this same interface.
 *   shell / tool — protocol-declared in §2, UNBUILT in v1 (§8): no consumers. They are
 *              absent from the built set rather than stubbed, so a step that needs one
 *              fails closed on the optional field instead of silently doing nothing.
 */

/** The v1 llm ability. A provider failure THROWS — the frame turns it into the locked
 *  error value at the step boundary, so no fabricated completion can reach a step. */
export const providerLlm = (adapter: ProviderAdapter, taskModel?: string): LlmAbility => ({
  async complete(req) {
    const r = await adapter.complete(req.prompt, {
      model: req.model ?? taskModel,
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
    });
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.blocker}`);
    return r.text;
  },
});

/** The v1 console human channel (the CLI's talk seam). */
export class ConsoleInteract implements InteractAbility {
  constructor(private readonly read: (q: string) => Promise<string> = consoleRead) {}

  async present(text: string): Promise<void> {
    console.log(`\n${text}\n`);
  }

  async ask(question: string): Promise<string> {
    return this.read(question);
  }

  async research(topics: string[]): Promise<ResearchFinding[]> {
    const out: ResearchFinding[] = [];
    for (const topic of topics) {
      const findings = await this.read(`research topic: ${topic} — findings (blank to skip)`);
      if (findings.trim()) out.push({ topic, findings });
    }
    return out;
  }

  async decide(question: string, options: string[]): Promise<string> {
    return this.read(`${question} [${options.join(' | ')}]`);
  }
}

/** One prompt on stdin. Closed per call — the CLI is not a long-lived REPL. */
export async function consoleRead(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${question}\n> `)).trim();
  } finally {
    rl.close();
  }
}

/** The v1 built set: llm + interact. shell/tool stay absent (unbuilt, fail closed). */
export const buildAbilities = (adapter: ProviderAdapter, opts: { interact?: InteractAbility; taskModel?: string } = {}): Abilities => ({
  llm: providerLlm(adapter, opts.taskModel),
  interact: opts.interact ?? new ConsoleInteract(),
});
