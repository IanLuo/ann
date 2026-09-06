import { describe, it, expect } from 'vitest';
import { InteractAbility, InteractAbort, LlmAbility, ResearchFinding } from '../types.js';
import { makeDedupeLabeler, isUnresolved, humanChannel } from '../session-shared.js';

/**
 * THE SHARED SESSION MECHANICS (flow/session-shared) — the byte-level machinery both
 * interactive grilling sessions genuinely duplicate (the portable core GrillSession +
 * the task idea-validate session): the unresolved-answer markers, counter-deduped
 * provenance labeling, and the fail-closed human-channel wrapper. Semantics per loop
 * stay separate — this module carries only what both need identical.
 */

describe('session-shared — the unresolved-answer markers', () => {
  it('treats a skip/pass/empty reply as unresolved — never a real answer', () => {
    for (const no of ['unknown', 'skip', 'not sure', 'unsure', 'n/a', 'na', 'dont know', "don't know", '', '  SKIP  ']) {
      expect(isUnresolved(no)).toBe(true);
    }
    for (const yes of ['markdown', 'web first', 'no', 'a']) {
      expect(isUnresolved(yes)).toBe(false);
    }
  });
});

describe('session-shared — counter-deduped provenance labeling', () => {
  it('uses the base label first and suffixes repeats (-2, -3, …) — seeded labels are never re-used', () => {
    const label = makeDedupeLabeler(['answer:q1']); // an existing label from prior context
    expect(label('answer:q1')).toBe('answer:q1-2'); // the seeded one is taken
    expect(label('answer:q1')).toBe('answer:q1-3');
    expect(label('research:x')).toBe('research:x'); // a fresh base is used as-is
  });

  it('labels stay unique across any mix of bases — the grounding map can never be shadowed', () => {
    const label = makeDedupeLabeler([]);
    const a = [label('answer:q1'), label('answer:q1'), label('answer:q2'), label('answer:q1')];
    expect(new Set(a).size).toBe(a.length);
    expect(a).toEqual(['answer:q1', 'answer:q1-2', 'answer:q2', 'answer:q1-3']);
  });
});

describe('session-shared — the fail-closed human-channel wrapper', () => {
  /** A scripted channel: FIFO answers; an InteractAbort is THROWN (the one signal the
   *  interact protocol raises rather than returns) — the wrapper catches it. */
  const human = (script: Array<string | Error | 'ABORT'>): InteractAbility => {
    let i = 0;
    return {
      async present() {},
      async ask(): Promise<string> {
        const a = script[Math.min(i++, script.length - 1)];
        if (a === 'ABORT') throw new InteractAbort('walked away');
        if (a instanceof Error) throw a;
        return a;
      },
      async research(): Promise<ResearchFinding[]> {
        const a = script[Math.min(i++, script.length - 1)];
        if (a === 'ABORT') throw new InteractAbort('walked away');
        if (a instanceof Error) throw a;
        return [];
      },
      async decide(): Promise<string> {
        return 'GO';
      },
    };
  };

  it('a value comes back as {kind:value} — untouched', async () => {
    const h = human(['markdown']);
    const r = await humanChannel('idea validation: interactor failed', () => h.ask('format?'));
    expect(r).toEqual({ kind: 'value', value: 'markdown' });
  });

  it('an InteractAbort (the human walked away) is {kind:abort} — never an error, never a blank', async () => {
    const h = human(['ABORT']);
    const r = await humanChannel('goal grill: the human channel failed', () => h.ask('q?'));
    expect(r).toEqual({ kind: 'abort' });
  });

  it('a channel failure fails CLOSED as {kind:error} with the caller-phrased blocker + the raw message', async () => {
    const h = human([new Error('provider down')]);
    const r = await humanChannel('idea validation: research channel failed', () => h.research(['t']));
    expect(r).toEqual({
      kind: 'error',
      error: { code: 'provider-unavailable', blocker: 'idea validation: research channel failed — provider down' },
    });
  });
});
