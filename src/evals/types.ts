/**
 * S9 — THE EVAL HARNESS (ann-system-design §1 "Eval harness": run fixture suite,
 * measure K1–K5, regression goals F16 + KPIs). Types shared across the fixtures,
 * the measurement engine, and the report.
 *
 * The KPIs (requirements-spec v3 §5):
 *   K1 — locate accuracy:  displayed status/history == event-log truth (derived, never stale): 100%
 *   K2 — locate ease:       any node's status + history in ≤ 2 interactions, p95
 *   K3 — advance ease:      reaching the correct next action in ≤ 1 interaction
 *   K4 — advance correctness: the proposed next action is right per the flow rules: ≥ 95%
 *   K5 — completion success: steps complete their ACs with evidence + artifacts locked ON FIRST
 *        PASS (before rework) on the fixture suite: ≥ 85%
 * Failure signal (requirements-spec v3 §5): K3 above target, K4 below target, or K5 below
 * target → the "structure is the log" bet is failing → STOP feature work.
 */

export interface Kpi {
  id: 'k1' | 'k2' | 'k3' | 'k4' | 'k5';
  name: string;
  /** The measured value, human-readable (e.g. "100%", "2 interactions", "3/4"). */
  value: string;
  /** The target the metric must meet (e.g. "100%", "≤ 2", "≥ 85%"). */
  target: string;
  pass: boolean;
  detail: string;
}

export interface EvalReport {
  suite: string;
  at: string;
  k1: Kpi;
  k2: Kpi;
  k3: Kpi;
  k4: Kpi;
  k5: Kpi;
  /** True when any KPI is below target — the failure signal (requirements-spec v3 §5). */
  failureSignal: boolean;
  details: string[];
}

/** A navigation fixture (K1–K4): a deterministic journey store + ground truth. */
export interface EvalFixture {
  id: string;
  name: string;
  /** Write the journey store (node.json + events.jsonl) under root. */
  build(root: string): void;
  /** Ground truth: the expected derived status per node id (K1). */
  expectedStatuses: Record<string, string>;
  /** The node a builder would locate — status + history (K2). */
  locateTarget: string;
  /** Ground truth: the expected next action id (K3/K4). */
  expectedNext: string;
}

/** A flow fixture (K5): a runnable frame chain + its first-pass expectation. */
export interface FlowFixture {
  id: string;
  name: string;
  /** The step ids in the task's chain. */
  chain: string[];
  /** The chain's steps (scripted — deterministic completions/interactions). */
  steps: FlowStep[];
  /** The interact answers (gate decisions), in order — for a first-pass success. */
  interactAnswers: string[];
  /** Ground truth: does this fixture complete ON FIRST PASS? */
  expectedFirstPass: boolean;
}

/** A minimal step shape the harness drives (kept small — the frame's Step contract is
 *  the full shape; these are the fields a fixture author sets). */
export interface FlowStep {
  id: string;
  execute(ctx: { taskId: string; packet: unknown; abilities: { llm: { complete(p: string): Promise<string> }; interact: unknown }; prior: Record<string, unknown> }): Promise<{ ok: boolean; artifact?: unknown; intents?: unknown[] }>;
}
