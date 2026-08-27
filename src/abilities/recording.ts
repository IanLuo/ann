import { Abilities, ResearchFinding } from '../flow/types.js';
import { TranscriptChannel } from '../flow/transcript.js';

/**
 * L3 — THE RECORDING/REPLAYING ABILITY WRAPPER (core-design §2).
 *
 * Every recordable ability call goes through the step's transcript channel:
 *
 *   HIT  → the recorded value is SERVED. The human is never re-interviewed and the
 *          questions never drift — a replay reproduces the attempt, it does not redo it.
 *   MISS → the live call runs and its outcome is RECORDED at the next seq under the
 *          same runId. A stranded partial attempt therefore resumes mid-step: the
 *          records it already has are served, the rest happens live.
 *
 * Lookups are BY IDENTITY (the prompt, the question) and CONSUMED IN ORDER, so the
 * same question asked twice in one run gets its two distinct recorded answers back
 * in order rather than the first one twice.
 *
 * `present` is DELIBERATELY UNRECORDED (§2): it is a one-way read for the human and
 * carries no answer to replay. Recording it would make a replay re-print the whole
 * session, and would put draft bodies in the event log for no decidable gain.
 */
export function recording(abilities: Abilities, channel: TranscriptChannel): Abilities {
  return {
    ...abilities,
    llm: {
      async complete(req) {
        const hit = channel.llm(req.prompt);
        if (hit !== undefined) return hit;
        const completion = await abilities.llm.complete(req);
        channel.record({ kind: 'llm', prompt: req.prompt, completion });
        return completion;
      },
    },
    interact: {
      present: (text: string) => abilities.interact.present(text),
      async ask(question: string) {
        const hit = channel.ask(question);
        if (hit !== undefined) return hit;
        const answer = await abilities.interact.ask(question);
        channel.record({ kind: 'ask', question, answer });
        return answer;
      },
      async research(topics: string[]): Promise<ResearchFinding[]> {
        // the topic SET is the identity — a differently-worded round is a fresh call
        const question = topics.join(' · ');
        const hit = channel.research(question);
        if (hit !== undefined) return hit;
        const research = await abilities.interact.research(topics);
        channel.record({ kind: 'research', question, research });
        return research;
      },
      async decide(question: string, options: string[]) {
        const hit = channel.decide(question);
        if (hit !== undefined) return hit;
        const answer = await abilities.interact.decide(question, options);
        channel.record({ kind: 'decide', question, answer, options });
        return answer;
      },
    },
  };
}
