/**
 * Shared machinery for the S2 engines (grilling + envision) — the honesty layer
 * that both engines apply deterministically over model output:
 *  - provenance: cited `basis` labels must exist in the provided context; unknown
 *    labels are dropped, never trusted; ungrounded claims are labeled 'inference'
 *    (design §6 sourceType taxonomy);
 *  - refuse fake precision: ungrounded + low-confidence assertions are demoted to
 *    QUESTIONS (their honest form), never asserted;
 *  - batch-ask: questions are deduped and asked together at the end (flow-control §7).
 */

export type SourceType =
  | 'user input'
  | 'local file'
  | 'repo metadata'
  | 'runtime/tool output'
  | 'documentation'
  | 'web source'
  | 'prior plan'
  | 'inference'
  | 'observation'
  | 'external system';

export interface GroundingInput {
  /** Stable id the model cites as `basis`. */
  label: string;
  text: string;
  sourceType: SourceType;
}

export interface GrillQuestion {
  id: string;
  question: string;
  reason: string;
  impact: 'high' | 'medium' | 'low';
  options?: string[];
  default?: string;
}

export interface RawGrillQuestion {
  question: string;
  reason: string;
  impact: 'high' | 'medium' | 'low';
  options?: string[];
  default?: string;
}

export const isRawQuestion = (q: unknown): q is RawGrillQuestion => {
  const o = q as Record<string, unknown>;
  return (
    typeof o?.question === 'string' &&
    typeof o?.reason === 'string' &&
    (o.impact === 'high' || o.impact === 'medium' || o.impact === 'low')
  );
};

export const unquote = (s: string): string => s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');

export const renderContext = (ctx: GroundingInput[] | undefined): string => {
  if (!ctx || ctx.length === 0) return '(none provided)';
  return ctx.map((c) => `- ${c.label} [${c.sourceType}]: ${c.text}`).join('\n');
};

export const renderConstraints = (c: string[] | undefined): string => {
  return c && c.length > 0 ? c.map((x, i) => `${i + 1}. ${x}`).join('\n') : '(none declared)';
};

/** Build a question with dedupe on normalized text (batch-ask, deduped per flow-control
 *  §4 — never ask the same question twice). Returns null when the text duplicates an
 *  earlier question in the batch. */
export const buildQuestion = (
  id: string,
  text: string,
  reason: string,
  impact: 'high' | 'medium' | 'low',
  seen: Set<string>,
  options?: string[],
  def?: string,
): GrillQuestion | null => {
  const key = text.trim().toLowerCase();
  if (seen.has(key)) return null;
  seen.add(key);
  return {
    id,
    question: text.trim(),
    reason,
    impact,
    ...(options && options.length > 0 ? { options } : {}),
    ...(def !== undefined ? { default: def } : {}),
  };
};
