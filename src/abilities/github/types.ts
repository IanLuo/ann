/**
 * S7 — THE GITHUB BINDING (architecture-v3 rung 2: "GitHub + human-interface follow
 * the same adapter pattern — fail-closed, confirm-before-destructive"; functional-spec
 * F13: "create issue/PR from a step; destructive actions confirm first").
 *
 * The result of EVERY action is a PROVENANCE artifact (ann-system-design-v3 §1: "record
 * action + result as provenance artifact (AC6)"; §3: "Binding API: execute(...) →
 * {ok, artifactRef?, provenance}"). The client never touches the store — it RETURNS the
 * provenance for the caller (a step) to record as a tree artifact or evidence; NFR-SEC-1
 * applies: params are REDACTED of secrets before they ride in the provenance.
 */

export interface GitHubActionLinks {
  html: string;
  api: string;
}

export interface GitHubProvenance {
  system: 'github';
  action: string;
  /** The action's parameters, SECRETS REDACTED — provenance is a tree artifact (AC6),
   *  and NFR-SEC-1 forbids secrets in the tree/artifacts/renders. */
  params: Record<string, unknown>;
  /** The API's result — the action's outcome as the server returned it, never fabricated. */
  result: Record<string, unknown>;
  links: GitHubActionLinks;
  at: string;
}

export interface GitHubError {
  code: string;
  blocker: string;
}

export type GitHubResult = { ok: true; value: GitHubProvenance } | { ok: false; error: GitHubError };

export interface CreateIssueParams {
  title: string;
  body?: string;
  labels?: string[];
}

export interface CreatePullRequestParams {
  title: string;
  body?: string;
  head: string;
  base: string;
}

/** Destructive actions require `confirm: true` — an explicit human signal, never assumed. */
export interface DestructiveParams {
  confirm: true;
}
