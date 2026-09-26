import { describe, it, expect } from 'vitest';
import { scopeAcs, transferCredit } from '../transfer.js';
import type { JourneyEvent } from '../store.js';

/**
 * THE TRANSFER'S SCOPE SHAPE (leg 12 task 12).
 *
 * The format declares `scope` verbatim free text — right for a record, unusable as a
 * credit. These pin the CONVENTION that makes it both: the `AC-n` id at the head of a
 * line is what the close matches on, the text after it is what a human rereads.
 */

const ev = (type: string, extra: Record<string, unknown> = {}) => ({ at: '2026-09-25', type, ...extra }) as unknown as JourneyEvent;

describe('scopeAcs — the ids a scope names, in one place', () => {
  it('reads one AC per line, and normalises the id (case, spacing, separators)', () => {
    expect(scopeAcs('AC-2: the second criterion')).toEqual(['AC-2']);
    expect(scopeAcs('ac-2 : lower case, spaced colon')).toEqual(['AC-2']);
    expect(scopeAcs('AC-2 — an em-dash after the id')).toEqual(['AC-2']);
    expect(scopeAcs('AC2 no separator at all')).toEqual(['AC-2']);
    expect(scopeAcs('  AC-12: crowded by whitespace  ')).toEqual(['AC-12']);
  });

  it('reads a MULTI-LINE scope — the shape the gesture asks for and prefills', () => {
    const scope = 'AC-1: the first, verbatim\nAC-3: the third, verbatim\nAC-3: a repeat';
    expect(scopeAcs(scope)).toEqual(['AC-1', 'AC-3']); // deduped, first-appearance order
  });

  it('a line naming NO AC credits nothing — residual scope is a real, honest record', () => {
    expect(scopeAcs('the remaining hardening work, unnamed')).toEqual([]);
    expect(scopeAcs('AC-2: named\nhardening follow-ups, unnamed\nAC-4: named')).toEqual(['AC-2', 'AC-4']);
    expect(scopeAcs('')).toEqual([]);
  });

  it('does not invent an id out of prose that merely mentions one', () => {
    // the id must HEAD the line — a sentence ABOUT an AC is not a claim that it moved
    expect(scopeAcs('the work AC-3 was doing')).toEqual([]);
  });
});

describe('transferCredit — which ACs moved, and where (AC-2)', () => {
  it('reads the tail: every transferred scope, mapped to its target', () => {
    const credit = transferCredit([
      ev('created'),
      ev('transferred', { target: '01-leg/02-b', scope: 'AC-2: the second\nAC-3: the third' }),
    ]);
    expect([...credit.entries()]).toEqual([['AC-2', '01-leg/02-b'], ['AC-3', '01-leg/02-b']]);
  });

  it('the LAST transfer naming an AC wins — the append-only rework reading', () => {
    const credit = transferCredit([
      ev('transferred', { target: '01-leg/02-b', scope: 'AC-2: moved once' }),
      ev('transferred', { target: '01-leg/03-c', scope: 'AC-2: moved again' }),
    ]);
    expect(credit.get('AC-2')).toBe('01-leg/03-c');
  });

  it('ignores a malformed transfer rather than crediting a scope-less move', () => {
    const credit = transferCredit([
      ev('transferred', { scope: 'AC-1: no target' }),
      ev('transferred', { target: '', scope: 'AC-1: empty target' }),
      ev('transferred', { target: '01-leg/02-b' }),
    ]);
    expect(credit.size).toBe(0);
  });

  it('is a pure read — nothing else in the tail is a transfer', () => {
    const credit = transferCredit([
      ev('completed'),
      ev('gate-revised', { gate: { old: 'confirm', new: 'grill' } }),
      ev('deferred', { reason: 'not now' }),
    ]);
    expect(credit.size).toBe(0);
  });
});
