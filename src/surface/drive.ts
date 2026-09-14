import { createContext } from './handlers.js';
import { getAdapter } from '../abilities/llm/index.js';
import { providerLlm } from '../abilities/index.js';
import { newRunId, type OpLog } from '../abilities/obs/log.js';
import { buildStepRegistry } from '../flow/steps/index.js';
import { DriverCheckpoint, DriverResult, runSemanticDriver } from '../flow/semantic-driver.js';

/**
 * L3 · THE SEMANTIC DRIVER'S BINDING — the operate loop's LLM surface (leg 12 task 02).
 *
 * The daemon's `POST /api/drive`: the same L2 loop the module exposes, called IN-PROCESS
 * with the CLI's own deps (ctx.commands · root · the step registry · the provider
 * ability), exactly as `approve.ts` binds the operator action. Nothing is re-implemented
 * here: this module owns what a daemon must supply and a terminal would not —
 *
 *   1. THE ADAPTER, SERVER-SIDE. The provider (and its key) is resolved HERE, inside the
 *      process, and only the wrapped `LlmAbility` reaches the driver. The key is never
 *      read by the loop, never logged by it, and never serialized into the response: the
 *      response body is the driver's own result, which holds provenance — provider, model,
 *      turn, run — and no credential (AC-4, asserted in the e2e).
 *   2. THE PRESENT-ONLY CHANNEL — the driver builds its own (`semantic-driver.ts`): this
 *      binding passes NO interact ability, so the loop cannot answer a gate even here.
 *   3. THE SEAMS: the read-only journey refusal (a non-active ANN_STORE target) and the
 *      single-flight slot, which the service shares with `POST /api/approve` — one
 *      operate-loop action at a time, so two drives (or a drive and an approve) can never
 *      interleave frames over one journey.
 *
 * NO NEW WRITE PATH: the loop composes the existing L1 writers (`submit!` + the Frame).
 * This binding adds no write of its own and no command.
 */

/** A drive is already running: nothing queued, nothing interleaved (the shared slot). */
export const DRIVE_BUSY =
  'a drive is already running — the daemon runs ONE operate-loop action at a time (this request was refused; nothing was queued or interleaved) — re-read the journey and try again';

export interface DriveOptions {
  /** The run id (the correlation id every log line of this run carries); default: minted. */
  runId?: string;
  provider?: string;
  model?: string;
  maxTurns?: number;
  resume?: DriverCheckpoint;
}

export interface DriveOutcome {
  status: number;
  body: Record<string, unknown>;
}

const refusal = (status: number, code: string, message: string): DriveOutcome => ({ status, body: { ok: false, error: { code, message } } });

export async function driveJourney(root: string, opts: DriveOptions = {}, log?: OpLog): Promise<DriveOutcome> {
  const ctx = createContext(root, ['drive'], { json: true, ...(log ? { log } : {}) });

  // A read-only target (ANN_STORE pointing at a non-active journey) does not get an LLM
  // loop aimed at it: refused up front, by name, before any provider call (the store's
  // own write guard stays the backstop).
  const t = ctx.target();
  if (t.readOnly) {
    return refusal(
      409,
      'read-only',
      `drive refused: the journey is READ-ONLY (${t.loc.kind === 'project' ? `${t.loc.root}/.ann/journey` : t.loc.root}) — not the active session`,
    );
  }

  // The credential lives HERE (env / user config / the dev keychain) and goes no further
  // than the adapter. A provider that cannot be resolved is a named failure, never a
  // guessed one, and never a body that echoes a secret.
  // THE DRIVER'S RUN ID (leg 12/05): minted HERE, so the op-log's model calls, the
  // driver's turns and the frame's phases inside the run all carry ONE correlation id.
  const runId = opts.runId ?? newRunId('drive');
  let llm;
  try {
    llm = providerLlm(getAdapter(opts.provider, root, runId), opts.model);
  } catch (e) {
    return refusal(503, 'provider-config', `drive refused: the provider could not be resolved — ${(e as Error).message}`);
  }

  const result: DriverResult = await runSemanticDriver({
    commands: ctx.commands,
    root,
    registry: buildStepRegistry(),
    llm,
    recordedBy: ctx.who,
    log: ctx.log,
    runId,
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.resume ? { resume: opts.resume } : {}),
  });

  // Every stop is a VALUE with a route reason (a provider failure included: the loop
  // stopped with zero writes) — the client renders `value.stop` / `value.routeReason`.
  return { status: 200, body: { ok: true, value: result } };
}
