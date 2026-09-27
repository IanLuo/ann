/**
 * THE MINIMAL UI (the goal's AC-3) — the journey view, the WAITING ON YOU gate queue, the
 * gate card, and the WHAT'S NEXT card (leg 11) with its DRILL-INS, as ONE page: vanilla
 * JS, no framework, no bundler, no build step (the server serves this string as-is, `GET /`).
 *
 * ONE DETAIL PANE, EVERY DETAIL — IN ITS OWN TAB: a gate queue row opens the gate card;
 * a WHAT'S NEXT item (the derivation, the frontmost-ready task, the leg gate, each pending
 * gate, each integrity blocker) and a gate card's result / evidence item are DRILLS. Every
 * drill is a LINK that opens the item in a NEW TAB (`#drill=<kind>&id=…`, target=_blank):
 * the new tab boots this same page and renders that item — deep-linkable, middle-clickable,
 * no JS-only affordance. A drill is PRESENTED, never decided — EXCEPT a result/evidence item
 * drilled from an exit gate, which keeps the Accept/Reject in hand (the fragment carries the
 * gate) because the operator is reviewing the very node the queue opened.
 *
 * It is a CLIENT OF THE SERVICE'S HTTP CONTRACT ONLY — the same routes whose bodies are
 * the CLI's own `--json` values:
 *   GET  /api/journey            → the journey view: legs · tasks · the ahead/state line
 *   GET  /api/gates              → the WAITING ON YOU queue: EVERY undecided submission
 *                                  across the WHOLE journey, each with its STEP (the gate's
 *                                  role — ENTRY before work / EXIT before the close — the
 *                                  task's own intent, what is DELIVERED there already)
 *   GET  /api/whatsnext          → the WHAT'S NEXT card: the derived advance (action +
 *                                  detail) · the frontmost-ready task · the leg gate · the
 *                                  pending gates · the frontmost-ready task's resolved chain
 *                                  LENGTH (0 content steps = the machine can only ACTIVATE
 *                                  it, and so it says). It carries NO integrity verdict: the
 *                                  full pre-check cost ~3.3s and ran on every load (leg
 *                                  12/07), so the card says it is unchecked and asks for the
 *                                  snapshot below. What the check RE-RUNS is listed in ONE
 *                                  place — approve.ts's INTEGRITY_UNCHECKED (G4).
 *   GET  /api/integrity          → THE LAZY INTEGRITY SNAPSHOT (leg 12/07): the SAME
 *                                  fail-closed pre-check the approve refuses on, asked for
 *                                  on the page's own clock. The card shows a pending state
 *                                  until it lands, then the real verdict — never a stale or
 *                                  blank claim. The check itself is unchanged and still
 *                                  guards the writes.
 *   GET  /api/confirm?id=<node>  → the gate card: the complete node (contract · inputs ·
 *                                  open questions) · CLAIMS (with resolved pointers) ·
 *                                  CHECKS · gate states · results
 *   GET  /api/results?id=<node>&n=<n> → ONE result item, DRILLED: a commit's `git show`,
 *                                  the local file/dir at a ref's path, an evidence event,
 *                                  a link — the exit gate's review, item by item
 *   GET  /api/events?id=<node>[&n=<n>] → the node's EVENT LIST in log order, numbered
 *                                  exactly as `ann journey <id>` numbers it; with `n`, ONE
 *                                  event DRILLED: the raw record + what it points at
 *                                  (a commit · a ref · an artifact · the gate · a node)
 *   POST /api/gate               → the decision: {id, gate, decision, feedback} → the same
 *                                  L1 `gate!` write the CLI performs; the page then
 *                                  RE-READS the journey + queue, so a landed decision is
 *                                  what the view shows (never an optimistic local edit)
 *   POST /api/transfer           → THE HALF ACCEPT (leg 12/13): {id, gate, decision, why,
 *                                  transfer:{target, scope}} → the SAME `gate!` write with
 *                                  the transfer flags (leg 12/12), so the confirm card's
 *                                  third action closes the task and moves the scope it
 *                                  does not deliver to a successor the human PICKED from
 *                                  this leg's real tasks. The successor must exist — the
 *                                  route never spawns, and the card never types an id the
 *                                  engine would refuse
 *   POST /api/approve            → the APPROVE: {proposal:{action,detail}} → the operator
 *                                  action's continue-leg path (the SAME machinery as the
 *                                  CLI's `advance!`), bound to the card the human saw; then
 *                                  a RE-READ, so a landed run is what the view shows
 *
 * A gate is a STEP, so the queue says which one: ENTRY (grill — confirm the contract, then
 * the work starts) or EXIT (confirm — review the delivered result, then it lands). Relative
 * URLs only — the page assumes nothing about where it is served from. No credentials, no
 * state: rendering is a pure function of those reads.
 */
export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ann — the journey</title>
<style>
  :root { color-scheme: dark; --fg: #e8e6e3; --muted: #9a958e; --bg: #16151a; --panel: #1f1e25; --line: #322f3a; --accent: #7cc4ff; --warn: #ffb454; --ok: #7ddc9a; --entry: #7cc4ff; --exit: #ffb454; }
  * { box-sizing: border-box; }
  /* THE HIDDEN GUARD: the UA rule for [hidden] loses to ANY class that sets display (e.g.
     .actions { display: flex }), so setting el.hidden = true silently did NOTHING there — a
     blocked card still offered a clickable approve. One rule makes the attribute
     authoritative wherever this page uses it. */
  [hidden] { display: none !important; }
  body { margin: 0; padding: 0 0 4rem; background: var(--bg); color: var(--fg); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { padding: 1.5rem 2rem 1rem; border-bottom: 1px solid var(--line); }
  h1 { margin: 0 0 .35rem; font-size: 1.15rem; letter-spacing: .02em; }
  h2 { margin: 0 0 .75rem; font-size: .8rem; text-transform: uppercase; letter-spacing: .12em; color: var(--muted); }
  h3 { margin: 0 0 .5rem; font-size: .95rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .muted { color: var(--muted); }
  .state { margin: 0; font-size: .85rem; color: var(--muted); }
  main { display: grid; grid-template-columns: minmax(320px, 1fr) minmax(380px, 1.15fr); gap: 1.5rem; padding: 1.5rem 2rem; align-items: start; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.15rem; }
  .queue { grid-column: 1 / -1; }
  ul { list-style: none; margin: 0; padding: 0; }
  .queue li { border-top: 1px solid var(--line); }
  .queue li:first-child { border-top: 0; }
  .queue button { display: block; width: 100%; padding: .7rem .25rem; background: none; border: 0; color: var(--fg); font: inherit; text-align: left; cursor: pointer; }
  .queue button:hover .q-title { color: var(--accent); }
  .badge { display: inline-block; min-width: 3.6rem; margin-right: .6rem; padding: .05rem .5rem; border-radius: 999px; border: 1px solid currentColor; font-size: .72rem; letter-spacing: .08em; text-transform: uppercase; }
  .badge.entry { color: var(--entry); }
  .badge.exit { color: var(--exit); }
  .q-title { display: inline; font-weight: 600; }
  .q-meta { display: block; margin-top: .25rem; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; }
  .q-do { display: block; margin-top: .3rem; font-size: .85rem; }
  .q-do.entry { color: var(--entry); }
  .q-do.exit { color: var(--exit); }
  .count { color: var(--warn); }
  .leg { border-top: 1px solid var(--line); padding: .75rem 0; }
  .leg:first-child { border-top: 0; padding-top: 0; }
  /* the DEFERRED rows: work the journey postponed — a deferred task closes its leg, so it
     never appears as a ready task or a gate; without this list it vanishes from the page */
  .deferred { margin: .75rem 0 0; }
  .deferred li { border-top: 1px solid var(--line); }
  .deferred button { display: block; width: 100%; padding: .6rem .25rem; background: none; border: 0; color: var(--fg); font: inherit; text-align: left; cursor: pointer; }
  .deferred button:hover .q-title { color: var(--accent); }
  .badge.deferred { color: var(--warn); }
  /* the REWORK rows (leg 12 task 06): a task owing a re-submission at a REJECTED gate is
     open work but not READY work, and its gate is not undecided — so like a deferred task
     it appears in neither the ready list nor the gate queue, and needs its own rows */
  .rework { margin: .75rem 0 0; }
  .rework li { border-top: 1px solid var(--line); }
  .rework button { display: block; width: 100%; padding: .6rem .25rem; background: none; border: 0; color: var(--fg); font: inherit; text-align: left; cursor: pointer; }
  .rework button:hover .q-title { color: var(--accent); }
  .badge.rework { color: var(--warn); }
  .task { display: block; width: 100%; padding: .3rem .35rem; background: none; border: 0; border-left: 2px solid var(--line); color: var(--muted); font: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; text-align: left; cursor: pointer; }
  .task:hover { color: var(--fg); border-left-color: var(--accent); }
  .status-done { color: var(--ok); }
  .status-blocked { color: var(--warn); }
  .status-active { color: var(--accent); }
  .card-body h3 { font-size: 1rem; }
  .card-step { display: flex; align-items: baseline; gap: .6rem; margin: 0 0 .35rem; }
  .card-what { margin: 0 0 1rem; font-size: .9rem; }
  .field { margin: .15rem 0; }
  .field .k { color: var(--muted); }
  .claims { margin: .35rem 0 .75rem; padding: 0; }
  .claims li { border-top: 1px solid var(--line); padding: .45rem 0; }
  .claims li:first-child { border-top: 0; }
  .claims .ac { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--accent); }
  .claims .ev { display: block; margin-top: .15rem; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; }
  .claims li.gap .ac { color: var(--warn); }
  .checks { margin: .35rem 0 .75rem; padding: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; }
  .checks .pass { color: var(--ok); }
  .checks .fail { color: var(--warn); }
  .gates { display: flex; gap: .75rem; margin-bottom: .75rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; }
  .gates span { border: 1px solid var(--line); border-radius: 999px; padding: .1rem .6rem; }
  textarea { width: 100%; min-height: 4.5rem; margin: .35rem 0 .75rem; padding: .5rem; background: #121118; color: var(--fg); border: 1px solid var(--line); border-radius: 8px; font: inherit; }
  /* THE HALF ACCEPT's form (leg 12/13): the third action lives UNDER the two, in its own
     block — it is a different act (the scope moves), not a third vote on the same one. */
  #transfer { margin-top: 1rem; padding-top: .85rem; border-top: 1px solid var(--line); }
  #transfer label { display: block; margin-top: .6rem; font-size: .8rem; }
  #transfer .transfer-head { margin: 0 0 .35rem; font-size: .85rem; }
  select { width: 100%; margin: .35rem 0 0; padding: .45rem .5rem; background: #121118; color: var(--fg); border: 1px solid var(--line); border-radius: 8px; font: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; }
  #transfer textarea { min-height: 4.5rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem; }
  /* THE DRAFT (leg 12/13 AC-3): the card cannot spawn a successor — spawn! is deliberately
     not a route — so when there is no node to point at it DRAFTS the contract as text the
     human edits and runs. Labelled GENERATED, and it writes nothing. */
  #draft { margin-top: .85rem; }
  #draft .transfer-head { margin: 0 0 .5rem; }
  #draft .draft-label { margin: .6rem 0 .3rem; font-size: .74rem; letter-spacing: .08em; text-transform: uppercase; color: var(--warn); }
  #draft pre { margin: 0; padding: .6rem .7rem; background: #121118; border: 1px solid var(--line); border-radius: 8px; color: var(--fg); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .78rem; white-space: pre-wrap; word-break: break-word; }
  .actions { display: flex; gap: .6rem; }
  .actions button { padding: .45rem 1.1rem; border-radius: 8px; border: 1px solid var(--line); background: #26242e; color: var(--fg); font: inherit; cursor: pointer; }
  .actions button.accept:hover { border-color: var(--ok); color: var(--ok); }
  .actions button.reject:hover { border-color: var(--warn); color: var(--warn); }
  .actions button.transfer:hover { border-color: var(--accent); color: var(--accent); }
  .message { margin: .75rem 0 0; font-size: .85rem; color: var(--muted); white-space: pre-wrap; }
  .message.error { color: var(--warn); }
  .hrow { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
  .ghost { padding: .3rem .85rem; border-radius: 8px; border: 1px solid var(--line); background: #26242e; color: var(--fg); font: inherit; cursor: pointer; }
  .ghost:hover { border-color: var(--accent); color: var(--accent); }
  .next { margin: .35rem 0 1rem; font-size: .9rem; }
  .next .k { color: var(--muted); }
  .stale { color: var(--warn); }
  .wn { grid-column: 1 / -1; }
  .wn-head { display: flex; align-items: center; gap: .75rem; }
  .wn-head h3 { margin: 0; }
  .wn .badge.run { color: var(--ok); }
  .wn .badge.stop { color: var(--warn); }
  .wn-action { display: inline-block; padding: .1rem .5rem; margin-left: -.5rem; border: 1px solid transparent; border-radius: 8px; color: var(--fg); font: inherit; font-size: .95rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; text-decoration: none; cursor: pointer; }
  .wn-action:hover { border-color: var(--line); color: var(--accent); }
  .wn-detail { margin: .4rem 0 .6rem; font-size: .9rem; }
  .wn-facts { margin: 0 0 .35rem; font-size: .85rem; }
  .wn-facts .wn-fact { display: inline-block; margin: 0 .35rem .35rem 0; padding: .15rem .6rem; border: 1px solid var(--line); border-radius: 999px; background: #26242e; color: var(--fg); font: inherit; font-size: .82rem; text-decoration: none; }
  .wn-facts a.wn-fact:hover { border-color: var(--accent); }
  .wn-facts a.wn-fact:hover .k { color: var(--accent); }
  .wn-facts .k { color: var(--muted); }
  .wn-blockers { margin: .35rem 0 .5rem; }
  .wn-blockers a.wn-blocker { display: block; width: 100%; padding: .25rem .3rem; border: 1px solid transparent; border-radius: 8px; color: var(--warn); font: inherit; font-size: .85rem; text-align: left; text-decoration: none; cursor: pointer; }
  .wn-blockers a.wn-blocker:hover { border-color: var(--warn); }
  .wn-blockers a.wn-blocker .k { color: var(--muted); }
  .drill { margin: .15rem 0; font-size: .85rem; }
  a.task { text-decoration: none; }
  /* FOCUS MODE — a drilled item in its own tab: that item AND NOTHING ELSE. The journey
     views are hidden by the SAME "hidden" flag the code sets (never rendered, never READ —
     see parseDrill/renderFocus); this block only re-lays-out the page for one column. */
  body.focus main { grid-template-columns: minmax(0, 1fr); padding-top: 1rem; }
  body.focus header { padding-bottom: .5rem; }
  a.ghost { text-decoration: none; }
  /* a DRILLED item (an exit-gate result / evidence pointer) and the drill's own output:
     every one is a NEW-TAB link carrying the item in its fragment */
  .ev.drill, a.ev.drill, li a.drill { display: block; padding: .1rem 0; color: var(--muted); font: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; text-align: left; text-decoration: none; cursor: pointer; }
  .ev.drill:hover, a.ev.drill:hover, li a.drill:hover { color: var(--accent); }
  pre.drill-out { margin: .35rem 0; padding: .5rem .6rem; background: #121118; border: 1px solid var(--line); border-radius: 8px; overflow-x: auto; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; }
</style>
</head>
<body>
<header>
  <h1>ann · the journey</h1>
  <div class="hrow">
    <p id="state" class="state">loading…</p>
    <span><a id="back" class="ghost" href="./" hidden>‹ the journey</a> <span id="updated" class="muted"></span> <button class="ghost" id="refresh">Refresh</button></span>
  </div>
</header>
<main>
  <section class="wn" id="wn">
    <h2>What's next</h2>
    <div class="wn-head">
      <a class="wn-action" id="wn-action" href="#drill=advance" target="_blank" rel="noopener" title="open in a new tab">loading…</a>
      <span class="badge" id="wn-badge"></span>
    </div>
    <p class="wn-detail" id="wn-detail"></p>
    <p class="wn-facts" id="wn-facts"></p>
    <ul class="wn-blockers" id="wn-blockers"></ul>
    <div class="actions" id="wn-actions" hidden>
      <button class="accept" id="approve">Approve &amp; run the next step</button>
    </div>
    <div class="actions" id="drive-area">
      <button class="ghost" id="drive">Drive it — the model picks the next call</button>
      <span class="muted" id="drive-why"></span>
    </div>
    <p class="muted" id="drive-cost">A DRIVE runs the engine's own LLM loop — REAL provider calls, billed to the SERVER-SIDE key, which never reaches this page. One operate-loop action at a time (the slot is shared with Approve). A provider failure stops the run with ZERO writes.</p>
    <div id="drive-view" hidden>
      <h3 id="drive-head"></h3>
      <p class="message" id="drive-state"></p>
      <ul id="drive-turns"></ul>
      <div id="drive-draft"></div>
    </div>
    <p class="message" id="wn-message"></p>
  </section>
  <section class="queue" id="queue-view">
    <h2>Waiting on you <span id="queue-count" class="count"></span></h2>
    <ul id="queue"><li class="muted">loading…</li></ul>
  </section>
  <section class="journey" id="journey-view">
    <h2>The journey</h2>
    <div id="legs"></div>
    <h3 id="deferred-head" hidden>Deferred — still owing</h3>
    <ul class="deferred" id="deferred"></ul>
    <h3 id="rework-head" hidden>Rework owed — a rejected gate</h3>
    <ul class="rework" id="rework"></ul>
  </section>
  <section class="card card-body" id="card" hidden>
    <h2 id="card-step-label">Gate card</h2>
    <h3 id="card-title"></h3>
    <p class="card-what" id="card-what"></p>
    <p class="next" id="card-next"></p>
    <div id="card-node"></div>
    <h2 id="card-claims-h">Claims</h2>
    <ul class="claims" id="card-claims"></ul>
    <h2 id="card-checks-h">Checks</h2>
    <ul class="checks" id="card-checks"></ul>
    <div class="gates" id="card-gates"></div>
    <h2 id="card-results-h">Results</h2>
    <ul id="card-results"></ul>
    <div id="card-decide" hidden>
      <textarea id="feedback" placeholder="feedback for the decision (the rejection's why; a confirm ACCEPT requires one — it is the decision's rationale)"></textarea>
      <div class="actions">
        <button class="accept" id="accept">Accept</button>
        <button class="reject" id="reject">Reject</button>
      </div>
      <div id="transfer" hidden>
        <p class="transfer-head muted">…or close it and move what is left — <strong>the half accept</strong>. The task lands done; the scope below is not claimed as met, it MOVES.</p>
        <label class="muted" for="successor">successor — where the remaining scope moves (a real task of this leg; it must already exist)</label>
        <select id="successor"></select>
        <label class="muted" for="scope">scope that moves — verbatim, one AC per line, editable</label>
        <textarea id="scope" placeholder="AC-2: &lt;the criterion, verbatim&gt;"></textarea>
        <div class="actions">
          <button class="transfer" id="accept-transfer">Accept + continue elsewhere</button>
        </div>
        <div id="draft">
          <p class="transfer-head muted">Nothing to point at yet — or the successor is a FRESH node? The card cannot create one: <strong>spawn! is not a route</strong>, because a successor is authored work. Draft the contract instead and run it yourself.</p>
          <div class="actions">
            <button id="draft-contract">Draft the successor</button>
          </div>
          <p class="draft-label" id="draft-label" hidden></p>
          <pre id="draft-body" hidden></pre>
        </div>
      </div>
    </div>
    <h2 id="card-events-h">Events — the node’s log, in order</h2>
    <ul class="events" id="card-events"></ul>
    <p class="message" id="card-message"></p>
  </section>
</main>
<script>
(function () {
  'use strict';
  var selected = { id: null, gate: null };

  // the STEP words: a gate is a step — entry (grill) before the work, exit (confirm) before the close
  var STEP = {
    grill: { role: 'entry', badge: 'ENTRY', what: 'the contract gate — approving it lets the work start' },
    confirm: { role: 'exit', badge: 'EXIT', what: 'the result gate — approving it closes the task when the conclusion evidence is recorded (the same rule the frame runs), otherwise it awaits complete!' }
  };
  /** THE UNLOCK CLAIM, ONLY WHEN THE ENGINE AGREES (leg 12/19): the step's what line and the
   *  decide-now line both asserted the ENGINE's answer — the work starts, it lands — from
   *  the HUMAN's fact (a gate was submitted), while detail.readiness (12/18's ONE
   *  derivation) sat unread a few fields above them. A submitted gate whose run the engine
   *  REFUSES says what its accept settles, and NAMES THE WAIT in the derivation's own
   *  blocker string — never a second phrasing of the same fact. */
  function runBlocked(rd) { return !!rd && rd.ready === false; }
  function waitOn(rd) { return 'waiting on ' + (rd.blockers || []).join('; '); }
  /** The step's what, from readiness. An ENTRY accept is the run's trigger, so it is the one
   *  that can promise a run the engine refuses; the EXIT gate's sentence is about the CLOSE,
   *  which readiness does not decide (12/18: an exit gate's question is the close), so its
   *  wording is untouched in both states. */
  function stepWhat(gate, rd) {
    var s = STEP[gate];
    if (!s) return '';
    if (s.role !== 'entry' || !runBlocked(rd)) return s.what;
    return 'the contract gate — approving it settles the contract; it does not start the work';
  }

  function byId(id) { return document.getElementById(id); }
  function el(tag, text, cls) {
    var n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  }
  function api(path) {
    return fetch(path, { headers: { accept: 'application/json' } }).then(function (r) {
      return r.json().then(function (doc) { return { status: r.status, doc: doc }; });
    });
  }
  function message(text, isError) {
    var m = byId('card-message');
    m.textContent = text || '';
    m.className = isError ? 'message error' : 'message';
  }
  function shorten(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  /** THE PER-TASK EXECUTABILITY VERDICT (leg 12/18) — the ENGINE's answer on a row that
   *  otherwise carries the bare status word. A row with no readiness (a leg) says nothing:
   *  absent is not the same as READY. */
  function execVerdict(t) {
    var rd = t && t.readiness;
    if (!rd) return '';
    return rd.ready ? ' · executability READY' : ' · executability BLOCKED — ' + (rd.blockers || []).join('; ');
  }
  function delivered(g) {
    var d = g.delivered || { commits: 0, claims: 0, unclaimed: 0, checks: 0, bound: 0 };
    if (!d.commits && !d.claims && !d.checks) return 'nothing delivered yet';
    var parts = [];
    parts.push(d.commits + ' commit' + (d.commits === 1 ? '' : 's'));
    parts.push(d.claims + ' claim' + (d.claims === 1 ? '' : 's') + (d.unclaimed ? ' (' + d.unclaimed + ' AC unclaimed)' : ''));
    parts.push(d.checks + ' check' + (d.checks === 1 ? '' : 's') + (d.bound ? ' · ' + d.bound + ' bound to the cited bytes' : ' · none bound'));
    return parts.join(' · ');
  }

  // ── the journey view: legs · tasks · the ahead/state line ──
  function renderState(ahead) {
    var parts = [];
    parts.push('active leg: ' + (ahead.activeLeg || 'none'));
    if (ahead.frontmostReady) parts.push('frontmost-ready: ' + ahead.frontmostReady.task + ' (' + ahead.frontmostReady.status + ')');
    parts.push(ahead.legGate && ahead.legGate.met ? 'leg gate: met' : 'leg gate: unmet — ' + ((ahead.legGate && ahead.legGate.blocker) || ''));
    byId('state').textContent = parts.join(' · ');
  }
  function renderLegs(legs) {
    var box = byId('legs');
    box.replaceChildren();
    if (!legs.length) { box.appendChild(el('p', 'no legs yet — the journey is empty', 'muted')); return; }
    legs.forEach(function (leg) {
      var sec = el('section', null, 'leg');
      sec.appendChild(el('h3', leg.id + ' · ' + leg.status));
      (leg.tasks || []).forEach(function (t) {
        var b = el('button', t.id + ' · ' + t.status + execVerdict(t), 'task status-' + t.status);
        b.addEventListener('click', function () { openCard(t.id, undecidedGate(t.id)); });
        sec.appendChild(b);
      });
      if (!(leg.tasks || []).length) sec.appendChild(el('p', '(no tasks)', 'muted'));
      box.appendChild(sec);
    });
  }

  /** THE DEFERRED ROWS (leg 12 task 01) — the work the journey postponed. A deferred task
   *  CLOSES its leg, so it is neither a ready task nor a gate: without this list the
   *  obligation vanishes from the page while the CLI reads exhausted. One row per task:
   *  its id, the recorded reason, and the plan pointer the reason names. The row DRILLS
   *  into the node (presented, never decided — a deferred task has no gate in hand). */
  function renderDeferred(deferred) {
    var rows = deferred || [];
    var list = byId('deferred');
    list.replaceChildren();
    byId('deferred-head').hidden = !rows.length;
    rows.forEach(function (d) {
      var li = el('li');
      var b = el('button');
      b.appendChild(el('span', 'DEFERRED', 'badge deferred'));
      b.appendChild(el('span', d.task + '  ·  leg ' + (d.leg || '') + '  ·  deferred ' + (d.since || '?'), 'q-title'));
      b.appendChild(el('span', d.reason || '(no reason recorded)', 'q-meta'));
      if (d.plan) b.appendChild(el('span', 'plan: ' + d.plan, 'q-meta'));
      b.addEventListener('click', function () { openCard(d.task, null); });
      li.appendChild(b);
      list.appendChild(li);
    });
  }

  /** THE REWORK ROWS (leg 12 task 06) — the rework owed at a REJECTED gate. The same shape
   *  as the deferred rows, for the same reason: the task derives the rework word, which is
   *  outside the ready set, and its gate is not undecided — so it is in neither the ready
   *  list nor WAITING ON YOU, and without these rows the human's rejection vanishes from the
   *  page. One row per task: its id, the gate, and the human's feedback VERBATIM. The row
   *  drills into the node (presented, never decided — the re-submission is the human's). */
  function renderRework(rework) {
    var rows = rework || [];
    var list = byId('rework');
    list.replaceChildren();
    byId('rework-head').hidden = !rows.length;
    rows.forEach(function (r) {
      var li = el('li');
      var b = el('button');
      b.appendChild(el('span', 'REWORK', 'badge rework'));
      b.appendChild(el('span', r.task + '  ·  leg ' + (r.leg || '') + '  ·  the ' + (r.gate || 'gate') + ' gate was REJECTED' + (r.since ? ' (' + r.since + ')' : ''), 'q-title'));
      b.appendChild(el('span', 'feedback: ' + (r.feedback || '(no feedback recorded)'), 'q-meta'));
      b.addEventListener('click', function () { openCard(r.task, r.gate); });
      li.appendChild(b);
      list.appendChild(li);
    });
  }

  // ── the WAITING ON YOU queue: every undecided submission, EACH NAMED AS ITS STEP ──
  var queue = [];
  function undecidedGate(id) {
    for (var i = 0; i < queue.length; i++) if (queue[i].task === id) return queue[i].gate;
    return null;
  }
  function renderQueue(gates) {
    queue = gates;
    var list = byId('queue');
    list.replaceChildren();
    byId('queue-count').textContent = gates.length ? String(gates.length) : '';
    if (!gates.length) { list.appendChild(el('li', 'nothing waiting — no undecided submission anywhere in the journey', 'muted')); return; }
    gates.forEach(function (g) {
      var step = STEP[g.gate] || { role: g.role || '', badge: String(g.gate).toUpperCase(), what: '' };
      var li = el('li');
      var b = el('button');
      b.appendChild(el('span', step.badge + ' · ' + g.gate, 'badge ' + step.role));
      b.appendChild(el('span', shorten(g.intent, 110), 'q-title'));
      b.appendChild(el('span', g.task + '  ·  leg ' + (g.leg || '') + '  ·  waiting since ' + (g.since || '?'), 'q-meta'));
      b.appendChild(el('span', stepWhat(g.gate, g.readiness), 'q-do ' + step.role));
      b.appendChild(el('span', 'delivered: ' + delivered(g), 'q-meta'));
      b.addEventListener('click', function () { openCard(g.task, g.gate); });
      li.appendChild(b);
      list.appendChild(li);
    });
  }

  // ── the gate card: the complete node · claims · checks · results, for the STEP in hand ──
  function field(parent, k, v) {
    var p = el('p', null, 'field');
    p.appendChild(el('span', k + ': ', 'k'));
    p.appendChild(el('span', v));
    parent.appendChild(p);
  }
  function gateState(detail, gate) {
    return gate && detail.gates && detail.gates[gate] ? detail.gates[gate] : { state: 'none' };
  }
  /** The pane's sections BEYOND the node fields: a gate card shows all four, a drilled
   *  item shows only what it has (and the rest are hidden, never left stale). */
  function sections(o) {
    byId('card-claims').replaceChildren();
    byId('card-checks').replaceChildren();
    byId('card-gates').replaceChildren();
    byId('card-results').replaceChildren();
    byId('card-events').replaceChildren();
    byId('card-claims-h').hidden = !o.claims;
    byId('card-checks-h').hidden = !o.checks;
    byId('card-results-h').hidden = !o.results;
    byId('card-events-h').hidden = !o.events;
    byId('card-gates').hidden = !o.gates;
  }
  /** What the task is WAITING FOR — WORDED here, DERIVED in the engine: detail.next is
   *  the workflow projection's verdict (the /api/confirm payload), so the card cannot
   *  disagree with check(), the queue, the driver or the CLI. The ONE thing this side
   *  adds is the gate IN HAND (the page knows which gate the operator clicked): a
   *  submitted gate in hand is decidable NOW. */
  /** The human's own words at the last rejection — read from the brief the card ALREADY
   *  carries (the same assembly the gate card's decisions field prints), never a second
   *  read of the log. The rework line says WHAT was rejected; this says WHY, verbatim. */
  function reworkWhy(detail) {
    var decisions = (detail.brief || {}).decisions || [];
    for (var i = decisions.length - 1; i >= 0; i--) {
      if (decisions[i].type === 'rejected') return decisions[i].why ? ' — the feedback: ' + decisions[i].why : ' — (no feedback recorded)';
    }
    return '';
  }

  function nextLine(detail, gate) {
    var v = detail.next || {};
    // THE WORKER'S STANDING COMES FIRST (leg 12/27). A confirm gate the review worker has
    // already DECLINED, could not REACH, or been locked out of at the bound is not 'waiting on
    // a decision' — a review has happened, and the ENGINE's own sentence for it (composed in
    // Commands, exactly as the terminal and the served card print it) is the whole answer.
    // It wins over the submitted-gate override below because the engine only publishes a
    // standing while the confirm gate reads SUBMITTED and UNDECIDED — the same condition —
    // so whenever this branch fires, the accept is still the human's to give, and the
    // sentence says what the worker did instead of hiding it behind 'decide it now'.
    var standing = (detail.brief || {}).review;
    if (standing) return standing.line;
    var verdict = v.verdict;
    if (gate && gateState(detail, gate).state === 'submitted') verdict = 'decide-now';
    switch (verdict) {
      case 'decide-now':
        // A SUBMITTED GATE IS NOT AN UNLOCK (12/19): the decision is the human's and stays
        // available, but any claim about the RUN comes from readiness, never from the
        // submission. Blocked, the accept is named for what it settles — the entry gate's
        // contract, the exit gate's result — and the wait is the derivation's own string.
        if (runBlocked(detail.readiness)) {
          return 'decide it now — accepting ' + gate + ' settles the ' +
            (STEP[gate].role === 'entry' ? 'contract; it does not start the work' : 'result') +
            ' — ' + waitOn(detail.readiness);
        }
        return 'decide it now — accepting ' + gate + ' ' + (STEP[gate].role === 'entry' ? 'lets the work start' : 'lets it land');
      case 'closed':
        return 'closed';
      case 'terminal':
        return v.status || (detail.status || 'closed');
      case 'conclusion-missing':
        return 'the exit gate is accepted but the conclusion evidence is MISSING — record it, then close: complete! ' + detail.id;
      case 'rework':
        return 'REWORK OWED — the last decision at the ' + (v.gate || 'gate') + ' gate is a REJECTION; the task must be reworked and re-submitted there before it can run' + reworkWhy(detail);
      case 'waiting-on-decision':
        return 'waiting on a decision — ' + (v.gate === 'confirm' ? 'confirm (exit)' : v.gate === 'grill' ? 'grill (entry)' : 'a gate') + ' is in WAITING ON YOU';
      case 'waiting-on-runner':
        return 'waiting on the runner — the confirm gate is decided and the evidence commit is not recorded yet';
      case 'work-in-progress':
        return 'work in progress';
      case 'entry-accepted':
        return 'the entry (grill) gate is accepted — the work has not started';
      default:
        return 'queued — the entry (grill) gate has not been submitted yet; nothing to decide here';
    }
  }

  /** THE NODE'S EVENT LIST — the SAME read the CLI prints with 'ann events <id>': every
   *  event in LOG ORDER, numbered exactly as 'journey <id>' numbers it (at · type · gate ·
   *  note), each row a NEW-TAB drill into that event's raw record and what it points at.
   *  One section, EVERY node view (a gate card, a drilled task, a leg). 'gate' carries the
   *  exit gate's decision into each drill, exactly as the results list does. */
  function loadEvents(id, gate) {
    var list = byId('card-events');
    list.replaceChildren();
    return api('/api/events?id=' + encodeURIComponent(id)).then(function (r) {
      if (r.status !== 200) { list.appendChild(el('li', 'events unavailable: ' + JSON.stringify(r.doc.error), 'muted')); return null; }
      var evs = r.doc.events || [];
      if (!evs.length) {
        list.appendChild(
          el(
            'li',
            r.doc.kind === 'LEG'
              ? 'no events — a leg root carries none by design: its status is derived from its tasks, and the facts live on them'
              : 'no events recorded',
            'muted',
          ),
        );
        return null;
      }
      evs.forEach(function (e) {
        var li = el('li');
        // A NOTE IS CAPPED on the card (the brief's own rule): a 4,000-character extended
        // note is unreadable in a list row — the row is a drill anyway, so the text is
        // shortened with the cut NAMED, never hidden.
        var note = e.note || '';
        var shown = note.length > 240 ? note.slice(0, 240) + '… (+' + (note.length - 240) + ' chars — drill for the full record)' : note;
        li.appendChild(
          drillLink(
            { kind: 'event', id: id, n: e.n, gate: gate || null },
            'drill',
            e.n + '. ' + e.at + '  ' + e.type + (e.gate ? ' (gate=' + e.gate + ')' : '') + (shown ? ' — ' + shown : '') + ' ›',
          ),
        );
        list.appendChild(li);
      });
      return null;
    });
  }

  function openCard(id, gate) {
    selected = { id: id, gate: gate };
    message('');
    sections({ claims: true, checks: true, gates: true, results: true, events: true }); // the gate card shows all five
    return api('/api/confirm?id=' + encodeURIComponent(id)).then(function (r) {
      if (r.status !== 200) { message('card unavailable: ' + JSON.stringify(r.doc.error), true); return; }
      var detail = r.doc.detail;
      var at = gateState(detail, gate);
      var decidable = !!gate && at.state === 'submitted'; // the NODE decides, not the page's snapshot
      var step = gate ? STEP[gate] : null;
      // THE EXIT GATE'S DRILL CONTEXT: a drill opened from THIS card stays inside the
      // decision in hand (the operator is reviewing the very node the queue opened), so the
      // Accept/Reject stay available — 'decide()' re-checks the node's own gate state
      // immediately before it writes, so a stale decision still cannot land.
      var keep = decidable ? { id: id, gate: gate } : null;
      byId('card').hidden = false;
      byId('card-step-label').textContent = decidable
        ? step.badge + ' STEP · the ' + step.role + ' gate (' + gate + ')'
        : gate
          ? 'the ' + (step ? step.role : '') + ' gate (' + gate + ') — ALREADY ' + at.state.toUpperCase() + (at.at ? ' on ' + at.at : '')
          : 'TASK · ' + detail.status;
      byId('card-title').textContent = id;
      byId('card-what').textContent = decidable
        ? stepWhat(gate, detail.readiness) +
          (gate === 'confirm'
            ? ' — every result and evidence item below DRILLS IN: the commit’s git show, the local file at its path'
            : '')
        : gate
          ? 'this gate was decided already — the view was showing a stale submission; press Refresh to see the current queue'
          : 'no undecided gate on this node — nothing to decide here';
      byId('card-next').replaceChildren();
      byId('card-next').appendChild(el('span', 'next: ', 'k'));
      byId('card-next').appendChild(el('span', nextLine(detail, gate)));
      byId('card-decide').hidden = !decidable; // ABSENT when there is nothing to decide

      // THE HALF ACCEPT (leg 12/13 AC-1). The third action shows ONLY on a live CONFIRM
      // gate: the entry gate has no scope to move (the work has not been done), and a
      // decided gate has nothing to decide. It collects exactly two things — the successor
      // and the scope — and the why is the SAME box Accept reads above it.
      var briefFor = detail.brief || {};
      var unclaimed = ((briefFor.conclusion || {}).unclaimed) || [];
      byId('transfer').hidden = !(decidable && gate === 'confirm');
      // a draft belongs to the card that made it — never let one outlive the card it was
      // drafted on (the scope it was built from is replaced just below)
      byId('draft-label').hidden = true;
      byId('draft-body').hidden = true;
      var picker = byId('successor');
      picker.replaceChildren();
      // THE HONEST ENABLEMENT (the same discipline the drive affordance follows): the button
      // is disabled WITH the reason beside it whenever the picker holds no real successor,
      // rather than offering a click the engine would refuse.
      byId('accept-transfer').disabled = false;
      function noSuccessor(why) {
        picker.appendChild(el('option', why));
        byId('accept-transfer').disabled = true;
      }
      byId('scope').value = unclaimed.map(function (u) { return u.ac + ': ' + u.acText; }).join('\\n');
      if (decidable && gate === 'confirm') {
        // THE SUCCESSOR IS THE HUMAN'S, AND THE PICKER CANNOT LIE (AC-3): it lists REAL
        // nodes only — the task's own LEG's tasks, from the packet read, open and closed
        // alike (Q1) — so the client cannot type an id the engine will reject, and it never
        // offers this node itself (the engine refuses a self-transfer by name). The route
        // refuses an unknown target regardless: the picker narrows, it does not guard.
        api('/api/packet?id=' + encodeURIComponent(id))
          .then(function (p) {
            if (p.status !== 200) { noSuccessor('the tasks of this leg are unavailable — ' + JSON.stringify(p.doc.error)); return; }
            var sibs = ((p.doc.siblingStatus || {}).siblings) || [];
            var real = sibs.filter(function (s) { return s.id !== id; });
            if (!real.length) { noSuccessor('no other task exists in this leg — spawn the successor first'); return; }
            real.forEach(function (s) {
              var o = el('option', s.id + '  (' + s.status + ')');
              o.value = s.id; // the LABEL carries the status; the VALUE is the bare id
              picker.appendChild(o);
            });
          })
          .catch(function (e) { noSuccessor('the tasks of this leg are unavailable — ' + e.message); });
      }

      // NODE — the contract as node.json holds it (the fields the CLI card prints)
      var node = byId('card-node');
      node.replaceChildren();
      var c = detail.contract || {};
      field(node, 'status', detail.status + (detail.createdAt ? ' · created ' + detail.createdAt : ''));
      // THE TWO ANSWERS, KEPT APART (leg 12/18): the ENGINE's answer (could the frame run
      // it now — the same readiness the frame enforces) beside the HUMAN's (a gate decision
      // is owed). Both used to read as the bare word blocked.
      if (!detail.isLeg) {
        var rd = detail.readiness || { ready: true, blockers: [] };
        field(node, 'executability', rd.ready ? 'READY — the frame could run it now' : 'BLOCKED — ' + rd.blockers.join('; '));
        var gs = detail.gates || {};
        var owed = ['grill', 'confirm'].filter(function (g) { return gs[g] && gs[g].state === 'submitted'; });
        field(node, 'waiting on', owed.length ? owed.join(' · ') + ' gate submitted, undecided — yours' : 'no gate decision owed');
      }
      field(node, 'intent', c.intent || '(none)');
      var acs = c.acceptanceCriteria || [];
      acs.forEach(function (ac, i) { field(node, 'AC-' + (i + 1), ac); });
      if (c.workType) field(node, 'workType', c.workType);
      if (c.model) field(node, 'model', c.model);
      (detail.inputs || []).forEach(function (i) {
        field(node, 'input ' + i.name, i.resolved ? i.path + ' @ ' + (i.sha || '(no sha)') : 'UNRESOLVED');
      });
      // THE DEPENDENCY EDGES (detail.deps): input edges resolve or they do not; TASK edges
      // are read from the record (the format carries no task→task field) and are labelled
      // as a reading, so a prose mention is never shown as a guarantee.
      var deps = detail.deps || { dependsOn: [], referencedBy: [] };
      deps.dependsOn.forEach(function (d) {
        field(node, 'depends on', d.ref + ' → ' + d.detail + (d.kind === 'task' ? ' [' + (d.how === 'declared' ? 'DECLARED — binding' : 'read from the record — a hint') + ']' : ''));
      });
      if (deps.referencedBy.length) {
        field(node, 'referenced by', deps.referencedBy.map(function (r) { return r.id + ' (' + r.status + ')'; }).join(' · '));
      }
      (detail.openQuestions || []).forEach(function (q) { field(node, 'open question' + (q.blocking ? ' [BLOCKING]' : ''), (q.id ? q.id + ': ' : '') + (q.question || '')); });

      // THE DECISION MATERIAL (detail.brief — the SAME value 'ann brief' renders, never a
      // second assembly): the choices already made WITH their whys (an absent why is named,
      // never inferred) and whether a close would pass right now. This is the block the
      // human reads INSTEAD of scrolling the contract + the event log.
      var brief = detail.brief || {};
      (brief.decisions || []).forEach(function (d) {
        // A HALF ACCEPT (leg 12/12) names the successor ON the decision: the transfer record
        // carries no why of its own, so the accept is where the move reads — the same line
        // 'ann decisions' prints, never a bare status.
        field(node, 'decision', d.at + '  ' + d.type + '@' + d.gate + ' — ' + (d.note || '') + (d.successor ? '  · scope moved to ' + d.successor : '') + '  · why: ' + (d.why ? d.why : '(NOT RECORDED)'));
      });
      if (brief.conclusion) {
        var un = (brief.conclusion.unclaimed || []).length;
        var moved = brief.conclusion.transferred || [];
        // THE MOVED SCOPE, PER SUCCESSOR (leg 12/13 AC-4): the task landed, and what did not
        // come with it is NAMED with where it went — 'the rest is now <target>'. A moved AC
        // is not a met one, so it is never folded into the claim count.
        moved.forEach(function (t) {
          field(node, 'the rest', 'the rest is now ' + t.target + ' — ' + t.ac + ' (' + t.acText + ') · moved, not claimed as met');
        });
        field(
          node,
          'close',
          brief.closeBlocker
            ? 'REFUSED now — ' + brief.closeBlocker.code
            // "every AC claimed" is said only when it is TRUE (12/12 AC-2): with ACs moved,
            // the honest line names how many, never the empty gap that reads as a full one.
            : 'a confirm accept would auto-close (claims: ' + (brief.conclusion.claims || []).length + (un ? ', UNCLAIMED: ' + un : '') + (moved.length ? ', TRANSFERRED: ' + moved.length : '') + (un || moved.length ? '' : ', every AC claimed') + ')',
        );
      }

      // THE REVIEW RECORD (leg 12/09) — what a review of this delivery FOUND, per finding,
      // read from the SAME assembled field the terminal prints (brief.findings) and never a
      // second read of the log. A review's findings are per finding instead of a digest for
      // one measured reason: a digest cannot be checked, so 'everything found was fixed' has
      // nothing to be measured against. One line per finding: its id, severity, status (and
      // an omission, named — a finding the latest pass did not re-assess), where it points,
      // and what it says.
      var fv = brief.findings || {};
      // THE WORKER'S STANDING (leg 12/27) — the engine's own sentence, printed verbatim: the
      // same bytes 'ann brief' prints, so the page and the terminal cannot say different things
      // about one gate. It is the fact 12/13 (reviewed, declined, silent about it) and 12/23
      // (at the bound, never reviewed, silent about it) could not state, and it is why the
      // next-line above no longer has to mean four things at once.
      if (brief.review) field(node, 'review', brief.review.line);
      if (fv.reviews) {
        field(node, 'review', fv.reviews + ' pass' + (fv.reviews === 1 ? '' : 'es') + ' (latest ' + fv.at + ') · cited at ' + (fv.anchor || '(none)'));
        (fv.findings || []).forEach(function (f) {
          field(node, 'finding', f.id + '  [' + f.severity + ']  ' + f.status + (f.stale ? '  · NOT RE-ASSESSED by the latest pass' : '') + '  ' + f.where + ' — ' + f.text);
        });
      } else {
        field(node, 'review', 'no review has landed (ann review! ' + (detail.id || '') + ' runs one at the confirm gate)');
      }

      // CLAIMS — how each acceptance criterion is met (resolved pointers), gaps named.
      // A pointer that NAMES a result item is itself a DRILL (the git submit, the local
      // file path) — one list, one numbering ('ann results <id> <n>'); prose stays text.
      var items = r.doc.results || [];
      function resultIndexFor(pointer) {
        for (var i = 0; i < items.length; i++) {
          var key = items[i].sha || items[i].path || items[i].url;
          if (key && String(pointer).indexOf(key) === 0) return i + 1;
        }
        return 0;
      }
      var claims = byId('card-claims');
      claims.replaceChildren();
      (detail.claims || []).forEach(function (claim) {
        var li = el('li', null, claim.statement ? '' : 'gap');
        li.appendChild(el('span', claim.ac + ': ', 'ac'));
        li.appendChild(el('span', claim.statement || 'NO CLAIM RECORDED — ' + (claim.acText || '')));
        // the ac→check MAPPING (leg 12/03): which act covers the AC, and whether the log
        // actually holds it — a mapping that names nothing IS the finding
        if (claim.check) {
          var b = claim.bound;
          li.appendChild(el('span', 'check: ' + claim.check + ' ' + (b ? '[' + b.source + ' ' + b.result + (b.sha ? ' @ ' + b.sha : '') + ']' : '[NO SUCH RUN IN THE LOG]'), 'ev'));
        }
        (claim.evidence || []).forEach(function (e) {
          var n = resultIndexFor(e);
          if (!n) { li.appendChild(el('span', 'evidence: ' + e, 'ev')); return; }
          li.appendChild(drillLink({ kind: 'result', id: id, n: n, gate: keep ? keep.gate : null }, 'ev drill', 'evidence: ' + e + ' ›'));
        });
        claims.appendChild(li);
      });
      if (!(detail.claims || []).length) claims.appendChild(el('li', 'no claims recorded', 'muted'));

      // CHECKS — what was run, and against which bytes
      var checks = byId('card-checks');
      checks.replaceChildren();
      (detail.checks || []).forEach(function (k) {
        var li = el('li');
        li.appendChild(el('span', k.result === 'pass' ? 'PASS  ' : 'FAIL  ', k.result));
        li.appendChild(el('span', k.command + ' [' + (k.source || 'reported') + ']' + (k.sha ? ' @ ' + k.sha : '') + (k.detail ? ' — ' + k.detail : '')));
        checks.appendChild(li);
      });
      if (!(detail.checks || []).length) checks.appendChild(el('li', 'no checks recorded', 'muted'));

      var gates = byId('card-gates');
      gates.replaceChildren();
      ['grill', 'confirm'].forEach(function (g) {
        var gs = gateState(detail, g);
        gates.appendChild(el('span', g + ' (' + STEP[g].role + '): ' + gs.state + (gs.at ? ' · ' + gs.at : '')));
      });
      var results = byId('card-results');
      results.replaceChildren();
      // EVERY result item is a DRILL — the SAME command-layer drill the CLI addresses with
      // an index: a commit → its 'git show', a ref → the local file/dir at its path. Each
      // is a NEW-TAB link carrying the item in its fragment, so the review survives the click.
      items.forEach(function (it, i) {
        var li = el('li');
        li.appendChild(drillLink({ kind: 'result', id: id, n: i + 1, gate: keep ? keep.gate : null }, 'drill', it.kind + ' · ' + it.label + ' ›'));
        results.appendChild(li);
      });
      if (!items.length) results.appendChild(el('li', 'no results recorded', 'muted'));
      if (!decidable && !gate) message('no undecided gate on this node — nothing to decide here');
      return loadEvents(id, keep ? keep.gate : null);
    });
  }

  // ── the decision: the SAME L1 gate! write the CLI performs, then a re-read ──
  // 'transfer' (leg 12/13 AC-1/AC-2) is the THIRD action: it does not change the decision —
  // it is the same confirm ACCEPT — it adds the move of the remaining scope, so it takes the
  // same why box, the same stale re-check and the same re-read. Only the route and the body
  // differ: POST /api/transfer, whose shape is AC-2's own key list.
  function decide(decision, transfer) {
    if (!selected.id || !selected.gate) { message('select a gate from WAITING ON YOU first', true); return; }
    var id = selected.id, gate = selected.gate;
    var why = byId('feedback').value;
    // AC-1 (leg 12/11) — a CONFIRM accept must carry a WHY, so the form ASKS before it
    // writes rather than letting the write refuse. The rule itself lives in gate! (one
    // chokepoint: the CLI and the frame meet it too); this is the same ask, on the page.
    // Cancelling (or an empty answer) writes NOTHING — the refusal stays a named error,
    // never a silent accept.
    if (decision === 'accept' && gate === 'confirm' && !why.trim()) {
      var asked = window.prompt('Why is the confirm gate accepted for ' + id + '? (the rationale is recorded on the decision)', '');
      if (asked === null || !asked.trim()) { message('not recorded — a confirm accept needs a why (the rationale is the decision)', true); return; }
      byId('feedback').value = asked;
      why = asked;
    }
    var body = transfer
      ? { id: id, gate: gate, decision: decision, why: why, transfer: transfer }
      : { id: id, gate: gate, decision: decision, feedback: why };
    var route = transfer ? '/api/transfer' : '/api/gate';
    message('recording ' + (transfer ? 'the half accept — ' + decision + ' + the move to ' + transfer.target : decision) + '…');
    // RE-CHECK the node immediately before writing: a submission decided elsewhere in the
    // meantime must not be re-decided (gate! would auto-submit + accept, recording a
    // redundant decision). The card's own read is the authority.
    api('/api/confirm?id=' + encodeURIComponent(id))
      .then(function (fresh) {
        if (fresh.status !== 200) { message('card unavailable: ' + JSON.stringify(fresh.doc.error), true); return null; }
        var st = gateState(fresh.doc.detail, gate).state;
        if (st !== 'submitted') {
          message('stale — the ' + gate + ' gate on ' + id + ' is already ' + st + ' (decided elsewhere); nothing was written. Refreshing.', true);
          return refresh().then(function () { return openCard(id, undecidedGate(id)); });
        }
        return fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
          .then(function (r) { return r.json().then(function (doc) { return { status: r.status, doc: doc }; }); })
          .then(function (r) {
            if (r.status !== 200) { message(decision + ' refused: ' + JSON.stringify(r.doc.error), true); return null; }
            message(transfer
              ? 'the half accept landed — ' + id + ' closed, the rest is now ' + transfer.target + ' (the view re-reads the log)'
              : decision + ' recorded — ' + id + ' ' + gate + ' gate (the view re-reads the log)');
            byId('feedback').value = '';
            return refresh();
          })
          .then(function () { if (focus) return null; return openCard(id, undecidedGate(id)); });
      })
      .catch(function (e) { message('request failed: ' + e.message, true); });
  }
  byId('accept').addEventListener('click', function () { decide('accept'); });
  byId('reject').addEventListener('click', function () { decide('reject'); });
  byId('accept-transfer').addEventListener('click', function () {
    // THE TWO THINGS THE FORM COLLECTS, AND NOTHING MORE (AC-1): the successor the human
    // picked and the scope as the human edited it. An empty pick is NOT sent — the engine
    // would refuse it, so the page says what is missing instead of round-tripping a refusal
    // it can see coming.
    var target = byId('successor').value;
    if (!target) { message('pick a successor first — the scope has to move somewhere (a real task of this leg; spawn it first if it does not exist)', true); return; }
    decide('accept', { target: target, scope: byId('scope').value });
  });

  // THE DRAFT PATH (AC-3), AND WHY IT IS TEXT. The successor's contract is AUTHORED work:
  // spawn! is deliberately not a route (service.ts), so the card's honest part is to draft
  // the contract — GENERATED, labelled, editable — and hand the human the command. NOTHING
  // HERE WRITES: no request leaves the page (the AC's never-auto-spawned boundary, enforced
  // by construction rather than by a guard). The scope textarea is the source, so the draft
  // follows the human's last edit; the AC ids are the OLD task's, which is why the draft is a
  // draft. The leg is the current task's own, so the command is one line to copy and run.
  function draftOf(scopeText, taskId) {
    var leg = String(taskId).split('/')[0];
    var acs = String(scopeText).split('\\n')
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l.length > 0; })
      // strip the scope convention's id prefix (AC-2: / AC2 -) — the text is the criterion
      .map(function (l) { return l.replace(/^ac[\\s-]?\\d+\\s*[:\\u2013-]?\\s*/i, '').trim(); })
      .filter(function (t) { return t.length > 0; });
    if (!acs.length) return null;
    var contract = { intent: 'carry the scope ' + taskId + ' did not meet: ' + acs[0], acceptanceCriteria: acs };
    return 'ann spawn! ' + leg + '/<NN-slug> ' + "'" + JSON.stringify(contract) + "'";
  }
  byId('draft-contract').addEventListener('click', function () {
    var text = draftOf(byId('scope').value, selected.id || '');
    if (!text) { message('nothing to draft — write the scope that moves first, one AC per line', true); return; }
    byId('draft-body').textContent = text;
    byId('draft-body').hidden = false;
    // the label is written with the draft, the way the drive's own draft names its provenance:
    // a GENERATED line above the bytes, so the box can never be mistaken for a made thing
    byId('draft-label').textContent = 'GENERATED — a draft, nothing was written';
    byId('draft-label').hidden = false;
    message('a DRAFT, not a spawn — nothing was written. Edit the id, run the command, then reopen this card and pick the new task.');
  });

  // ── the WHAT'S NEXT card: the derived proposal + the honest blocker surface (leg 11) ──
  var whatsNext = null; // the derivation the approve is bound to (the card the human saw)
  // THE LAZY INTEGRITY SNAPSHOT (leg 12/07). The card's READ no longer runs the full
  // fail-closed pre-check (measured: ~3.3s of EVERY page load); the page asks for it here,
  // on its own clock, and says exactly what it does not yet know. States: checking · clean ·
  // dirty · unavailable — never a verdict the page did not receive.
  var wnIntegrity = { state: 'checking' };
  var integritySeq = 0; // the in-flight snapshot's generation (a newer render wins)
  /** The operator action's four derivations, in the card's own words: continue-leg is the
   *  ONE the machine can run — and only when the frontmost-ready task's RESOLVED chain has
   *  CONTENT steps (an implementation task's chain is empty — nothing to execute, the
   *  runner does the work). The other three are the AUTHORED-WORK BOUNDARY — the card
   *  presents them and STOPS (never a dead approve button). */
  var DERIVATION = {
    'continue-leg': { run: true, what: 'the machine can run this step through the frame' },
    'advance-leg': { run: false, what: 'NOT machine-executable — the authored-work boundary: the front leg is empty, so the next leg is AUTHORED work (a human writes the contract), never a machine spawn' },
    'closure-needed': { run: false, what: 'NOT machine-executable — the authored-work boundary: the leg gate is unmet, so closing it is a GATED HUMAN move (a closure task: transfer or defer), never a machine close' },
    'rework-needed': { run: false, what: 'NOT machine-executable — a bound gate was REJECTED and the task owes a rework: the move is the HUMAN’s (rework the contract, then re-submit it at THAT gate), never a machine run against the rejected bytes and never a closure' },
    'none': { run: false, what: 'NOT machine-executable — the authored-work boundary: every spawned leg is done; the goal consult is the human verdict (goal! met), never a machine seal' }
  };
  var EMPTY_CHAIN = 'nothing to execute — the frame activates the task and waits for the runner (empty chain)';
  function wnMessage(text, isError) {
    var m = byId('wn-message');
    m.className = isError ? 'message error' : 'message';
    m.replaceChildren();
    var lines = Array.isArray(text) ? text : (text ? [text] : []);
    lines.forEach(function (line) { m.appendChild(el('div', line)); });
  }
  /** A blocker's own operator step: every blocker is NAMED, and the ones the operator can
   *  clear say how (ann check / ann verify / ann docs --write / git). What a blocker BLOCKS
   *  is said once, below the list — the remedy is the same either way. */
  function remedy(b) {
    if (b.indexOf('uncommitted tracked change') === 0) return ' — uncommitted tracked journey changes — commit them (the operator step: the daemon never commits)';
    if (b.indexOf('docs manifest out of sync') === 0) return ' — run ann docs --write and commit';
    if (b.indexOf('verify:') === 0) return ' — the log and the files disagree: run ann verify and reconcile';
    return '';
  }
  function renderWhatsNext(v) {
    whatsNext = v;
    var d = v.advance || { action: 'none', detail: '' };
    var step = DERIVATION[d.action] || { run: false, what: '' };
    var checking = wnIntegrity.state === 'checking';
    var dirty = wnIntegrity.state === 'dirty';
    var clean = wnIntegrity.state === 'clean';
    var steps = v.chainSteps || 0; // the frontmost-ready task's RESOLVED chain: 0 = NOTHING to execute
    byId('wn-action').textContent = d.action;
    byId('wn-detail').textContent = d.detail;
    var badge = byId('wn-badge');
    // THE HEADLINE IS WHAT THE HUMAN CAN DO, in this order: a boundary derivation is the
    // point of the card (the move is the human's — a dirty tree does not change that), then
    // the integrity verdict the lazy snapshot gave (a dirty tree CANNOT advance — said as
    // soon as it is known, never assumed), then a pending/unknown verdict (the read does not
    // guess), then a clean MACHINE-EXECUTABLE advance, then an EMPTY CHAIN — the machine can
    // only activate it (the runner does the work), never execute anything.
    if (!step.run) { badge.textContent = 'PRESENTED AND STOPPED'; badge.className = 'badge stop'; }
    else if (dirty) { badge.textContent = 'BLOCKED — CANNOT ADVANCE'; badge.className = 'badge stop'; }
    else if (checking) { badge.textContent = 'CHECKING INTEGRITY'; badge.className = 'badge stop'; }
    else if (!clean) { badge.textContent = 'INTEGRITY UNKNOWN'; badge.className = 'badge stop'; }
    else if (steps) { badge.textContent = 'MACHINE-EXECUTABLE'; badge.className = 'badge run'; }
    else { badge.textContent = 'ACTIVATE & WAIT'; badge.className = 'badge stop'; }

    // the facts: EVERY one is a DRILL — click it and the pane shows the item's own data
    var facts = byId('wn-facts');
    facts.replaceChildren();
    function fact(k, val, spec) {
      var node = spec ? drillLink(spec, 'wn-fact') : el('span', null, 'wn-fact');
      node.appendChild(el('span', k + ': ', 'k'));
      node.appendChild(el('span', val));
      if (spec) node.appendChild(el('span', ' ›', 'k'));
      facts.appendChild(node);
    }
    fact('frontmost-ready', v.frontmost ? v.frontmost.task + ' (' + v.frontmost.status + ')' : 'none',
      v.frontmost ? { kind: 'task', id: v.frontmost.task } : null);
    fact('leg gate', v.legGate && v.legGate.met ? 'MET' : 'UNMET — ' + ((v.legGate && v.legGate.blocker) || ''), { kind: 'leg', id: v.advance.leg });
    fact('pending gates', (v.pendingGates || []).length
      ? (v.pendingGates || []).map(function (p) { return p.task + '@' + p.gate; }).join(' · ')
      : 'none',
      { kind: 'gates' });
    // THE INTEGRITY VERDICT — the LAZY snapshot's, never the page load's (leg 12/07): the
    // read does not run the pre-check (that is what made a load take ~3.3s), so the card
    // says what it knows and no more. 'checking…' is a real state, not a blank claim.
    fact('integrity', integrityWords(), null);
    // the derivation's own words — for a continue-leg with an EMPTY chain the honest
    // sentence is what the frame really does (activate + wait), never 'the machine can run
    // this step' (the badge above says the same, and this is why)
    facts.appendChild(el('span', step.run && !steps ? EMPTY_CHAIN : step.what, 'k'));

    // the integrity blockers — each is a DRILL too: the finding, its class, the read that
    // derives it, and the operator's step (the card CANNOT claim the journey can advance)
    var list = byId('wn-blockers');
    list.replaceChildren();
    var blockers = wnIntegrity.blockers || [];
    blockers.forEach(function (b) {
      var li = el('li');
      var a = drillLink({ kind: 'blocker', blocker: b }, 'wn-blocker');
      a.appendChild(el('span', 'blocker: ' + b));
      a.appendChild(el('span', remedy(b) + ' ›', 'k'));
      li.appendChild(a);
      list.appendChild(li);
    });
    // WHAT the blockers block — said once, and NOT overstated: with a boundary derivation
    // there is no approve to refuse, so they are a heads-up for the next advance, not a
    // gate on the human's move.
    if (blockers.length) {
      list.appendChild(el('li', step.run
        ? 'the approve re-checks all of this fail-closed first — with a blocker present it refuses and writes NOTHING.'
        : 'these would block an APPROVE — and none is offered here: the move above is the human step (the daemon never commits, closes, or spawns).', 'muted'));
    }

    // the approve affordance exists ONLY where it can work: a KNOWN-clean state · continue-leg
    // · a ready task. While the snapshot is in flight — or unreadable — the verdict is not
    // known, so the card says WHICH (never a dead button, never a guessed verdict); an
    // 'unavailable' snapshot still offers the approve, because the WRITE re-checks fail-closed
    // and refuses with its named blockers if it must (the button always has a defined effect).
    var executable = !!(v.executable && step.run && !checking && !dirty);
    byId('wn-actions').hidden = !executable;
    if (executable) wnMessage('');
    else if (!step.run) wnMessage('nothing to approve — ' + step.what + '.'); // the human move is above
    else if (checking || dirty) { /* the badge, the integrity fact and the blocker list say why */ }
    else if (v.executable) wnMessage('nothing to approve — the integrity snapshot could not be read; the approve would re-check it fail-closed, so read it again with Refresh.');
    else wnMessage('nothing to approve — no frontmost-ready task.');
    // blocked-and-continuable: keep whatever the last action said — the blocker list is the message
    driveEnablement(v, step);
  }

  /** THE DRIVE AFFORDANCE'S HONEST STATE (leg 12/04 AC-1) — NEVER a dead button. The drive
   *  button lives on the card whether or not it can run, and when it cannot it says WHY, in
   *  the same terms the approve uses: a boundary derivation (the move is the human's), the
   *  tree dirty (with the named blockers), the snapshot still in flight, or no ready task.
   *  The page never guesses a verdict the write would then refuse. */
  function driveEnablement(v, step) {
    var why = byId('drive-why');
    var button = byId('drive');
    var off = !step.run
      ? 'off — ' + v.advance.action + ': the move here is yours, not the machine’s'
      : wnIntegrity.state === 'checking'
        ? 'off — the integrity snapshot is still being read; Refresh re-reads it'
        : wnIntegrity.state === 'dirty'
          ? 'off — the tree is dirty: ' + (wnIntegrity.blockers || []).length + ' named blocker(s) below'
          : !v.executable
            ? 'off — no frontmost-ready task to drive'
            : '';
    button.disabled = !!off;
    why.textContent = off;
    return off;
  }

  /** THE DRIVE (AC-1…AC-3) — the SAME loop the CLI drive runs, triggered from the card. The
   *  route re-derives and re-checks fail-closed, so this handler CLAIMS nothing: it renders
   *  what came back, named state by named state. A refusal (busy · provider · read-only) is
   *  shown with the server's own words; a run is rendered turn by turn. */
  function drive() {
    var button = byId('drive');
    byId('drive-view').hidden = false;
    byId('drive-head').textContent = 'the drive';
    byId('drive-turns').replaceChildren();
    byId('drive-draft').replaceChildren();
    driveMessage('driving — the model is choosing the next call. This is a REAL provider call on the server’s key.', false);
    button.disabled = true;
    fetch('/api/drive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
      .then(function (r) { return r.json().then(function (doc) { return { status: r.status, doc: doc }; }); })
      .then(function (r) {
        if (r.status !== 200) {
          // a NAMED stop before the loop even ran: drive-busy (the shared slot) · provider
          // config · read-only. The server's message is the state; nothing is invented.
          var e = r.doc.error || {};
          byId('drive-head').textContent = 'the drive — STOPPED: ' + (e.code || r.status);
          driveMessage((e.code || 'refused') + ' — ' + (e.message || ''), true);
          return null;
        }
        renderDrive(r.doc.value);
        return refresh();
      })
      .catch(function (e) { driveMessage('drive request failed: ' + e.message, true); })
      .then(function () {
        // the card owns the enablement (it knows the derivation + the integrity verdict);
        // re-deriving here would be a second opinion the write could contradict.
        if (whatsNext) driveEnablement(whatsNext, DERIVATION[whatsNext.advance.action] || { run: false });
      });
  }
  function driveMessage(text, isError) {
    var m = byId('drive-state');
    m.textContent = text || '';
    m.className = isError ? 'message error' : 'message';
  }
  /** WHAT THE RUN DID (AC-2): the stop and its route reason · every call that EXECUTED (the
   *  accepted ones, with what they wrote) · the call that was REFUSED BY NAME, when the loop
   *  ended on one · and the DRAFTED contract, marked GENERATED, for the human's decision. */
  function renderDrive(v) {
    var head = byId('drive-head');
    head.textContent = 'the drive — STOPPED: ' + v.stop + ' · ' + v.turns + ' turn(s) · ' +
      v.provider + (v.model ? ' · ' + v.model : '') + ' · run ' + v.runId;
    driveMessage('why it stopped: ' + v.routeReason, v.stop === 'provider-failure' || v.stop === 'refusal');

    var turns = byId('drive-turns');
    turns.replaceChildren();
    (v.executed || []).forEach(function (e) {
      var li = el('li');
      li.appendChild(el('span', 'turn ' + e.turn + '  ' + e.call + '  ', 'k'));
      li.appendChild(el('span', 'ACCEPTED — ' + (e.wrote && e.wrote.length ? 'wrote ' + e.wrote.join(' · ') : 'no write')));
      turns.appendChild(li);
    });
    if (v.refusal) {
      var li = el('li');
      li.appendChild(el('span', 'turn ' + v.turns + '  ' + (v.refusal.call || '(no call named)') + '  ', 'k'));
      li.appendChild(el('span', 'REFUSED BY NAME — ' + v.refusal.code + ': ' + v.refusal.reason));
      turns.appendChild(li);
    }
    if (!(v.executed || []).length && !v.refusal) {
      turns.appendChild(el('li', 'no call was made — the loop stopped before choosing one', 'muted'));
    }
    renderDraft(v.draft);
  }
  /** THE DRAFTED CONTRACT (AC-2) — GENERATED, and the spawn! stays the HUMAN's act. The
   *  page POINTS AT THE COMMAND rather than offering a spawn button (recorded decision):
   *  the spawn! is deliberately not a route on this service — the named scope boundary — and
   *  adding one would make the page a command runner to save a copy-paste. The card shows
   *  the bytes so the human can read them before spawning, and says plainly that nothing
   *  was spawned. */
  function renderDraft(d) {
    var box = byId('drive-draft');
    box.replaceChildren();
    if (!d) return;
    var p = d.provenance;
    box.appendChild(el('h4', 'A contract was drafted at the authored-work boundary — nothing was spawned'));
    box.appendChild(el('p', d.label + ' (model ' + p.model + ' · provider ' + p.provider + ' · turn ' + p.turn + ' · run ' + p.runId + ')', 'k'));
    box.appendChild(el('p', 'kind: ' + d.kind + ' · id: ' + d.id));
    box.appendChild(el('p', 'grounded on: ' + (d.groundedOn || []).join(' · ')));
    box.appendChild(el('p', 'rationale: ' + (d.rationale || '(none)')));
    box.appendChild(el('p', 'contract: ' + JSON.stringify(d.contract)));
    box.appendChild(el('p', 'read those bytes, then make it real yourself: ann ' + d.approve.act + ' ' + d.approve.id + " '" + JSON.stringify(d.approve.contract) + "'", 'k'));
    box.appendChild(el('p', 'the machine never spawns — this draft is a proposal, and the id above is free until YOU take it.', 'muted'));
  }

  /** The integrity fact's words — the state the page actually knows, never more. */
  function integrityWords() {
    if (wnIntegrity.state === 'checking') return 'checking… — the page does NOT run the full pre-check on load (that cost ~3.3s); the verdict arrives on its own';
    if (wnIntegrity.state === 'clean') return 'clean — re-checked fail-closed (ann check · the S4 validators · ann verify · the docs manifest · uncommitted tracked journey/docs)';
    if (wnIntegrity.state === 'dirty') return 'dirty — ' + (wnIntegrity.blockers || []).length + ' named blocker(s) below: the approve would refuse fail-closed';
    return 'unknown — ' + (wnIntegrity.note || 'the snapshot could not be read') + ' (the approve re-checks fail-closed anyway)';
  }

  /** THE LAZY INTEGRITY SNAPSHOT (leg 12/07) — GET /api/integrity, the SAME
   *  operatorIntegrityBlockers the approve refuses on. Fetched AFTER the page has rendered
   *  (so a load is never blocked on it), with a pending state shown while it is in flight and
   *  the real result when it lands. A render that supersedes an in-flight read wins: the
   *  stale reply is dropped, never displayed. */
  function loadIntegrity() {
    var seq = ++integritySeq;
    wnIntegrity = { state: 'checking' };
    if (whatsNext) renderWhatsNext(whatsNext);
    return api('/api/integrity')
      .then(function (r) {
        if (seq !== integritySeq) return null; // a newer card render owns the display now
        wnIntegrity = r.status === 200
          ? { state: r.doc.clean ? 'clean' : 'dirty', blockers: r.doc.blockers || [] }
          : { state: 'unavailable', note: 'the integrity read refused: ' + JSON.stringify(r.doc.error) };
        if (whatsNext) renderWhatsNext(whatsNext);
        return null;
      })
      .catch(function (e) {
        if (seq !== integritySeq) return;
        wnIntegrity = { state: 'unavailable', note: 'the integrity read failed: ' + e.message };
        if (whatsNext) renderWhatsNext(whatsNext);
      });
  }

  /* ── THE DRILL — the fragment IS the drill: every affordance is a LINK that opens the
   *  item in a NEW TAB, and the new tab boots this same page and renders it from the URL.
   *  Nothing is shared between tabs but the service (both read the same reads), so a drill
   *  is deep-linkable, middle-clickable, copyable — never a transient pane state. */
  function drillHref(spec) {
    var parts = ['drill=' + encodeURIComponent(spec.kind)];
    if (spec.id) parts.push('id=' + encodeURIComponent(spec.id));
    if (spec.gate) parts.push('gate=' + encodeURIComponent(spec.gate));
    if (spec.n) parts.push('n=' + encodeURIComponent(spec.n));
    if (spec.blocker) parts.push('blocker=' + encodeURIComponent(spec.blocker));
    return '#' + parts.join('&');
  }
  function drillLink(spec, cls, text) {
    var a = el('a', text, cls);
    a.href = drillHref(spec);
    a.target = '_blank';
    a.rel = 'noopener';
    a.title = 'open in a new tab';
    return a;
  }
  /** THE FRAGMENT IS THE DRILL: parse it into the ONE item this page presents (null = the
   *  full journey view). Pure — renderFocus() renders it. A malformed fragment renders
   *  nothing (never a broken page); an unknown kind is ignored. */
  function parseDrill() {
    var h = String((typeof location !== 'undefined' && location.hash) || '');
    if (h.indexOf('#drill=') !== 0) return null;
    var q = {};
    try {
      h.slice(1).split('&').forEach(function (kv) {
        var i = kv.indexOf('=');
        if (i > 0) q[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
      });
    } catch (e) {
      return null;
    }
    if (q.drill === 'advance') return { kind: 'advance' };
    if (q.drill === 'task' && q.id) return { kind: 'task', id: q.id };
    if (q.drill === 'leg' && q.id) return { kind: 'leg', id: q.id };
    if (q.drill === 'gates') return { kind: 'gates' };
    if (q.drill === 'gate' && q.id && q.gate) return { kind: 'gate', id: q.id, gate: q.gate };
    if (q.drill === 'result' && q.id && q.n) return { kind: 'result', id: q.id, n: q.n, gate: q.gate };
    if (q.drill === 'event' && q.id && q.n) return { kind: 'event', id: q.id, n: q.n, gate: q.gate };
    if (q.drill === 'blocker' && q.blocker) return { kind: 'blocker', blocker: q.blocker };
    return null;
  }
  /** THE FOCUSED TAB — the drilled item AND NOTHING ELSE: the journey views are hidden and
   *  never READ (renderFocus issues only that item’s own read), the pane takes the width,
   *  and the header keeps only the way back. */
  function enterFocus(spec) {
    focus = spec;
    document.body.className = 'focus';
    byId('wn').hidden = true;
    byId('queue-view').hidden = true;
    byId('journey-view').hidden = true;
    byId('state').hidden = true; // no journey state line: this tab is one item
    byId('back').hidden = false;
    document.title = 'ann · ' + (spec.kind === 'blocker' ? 'an integrity blocker' : spec.kind + (spec.id ? ' · ' + spec.id : ''));
  }
  /** Render the focused drill — also the Refresh path in a focused tab, so a drill tab
   *  never re-reads the journey it is not showing. */
  function renderFocus() {
    var s = focus;
    if (!s) return Promise.resolve(null);
    var stamped = function () { byId('updated').textContent = 'as of ' + new Date().toLocaleTimeString(); return null; };
    if (s.kind === 'advance') return Promise.resolve(drillAdvance()).then(stamped);
    if (s.kind === 'task') return drillTask(s.id).then(stamped);
    if (s.kind === 'leg') return drillLeg(s.id, null).then(stamped);
    if (s.kind === 'gate') return openCard(s.id, s.gate).then(stamped);
    if (s.kind === 'blocker') return Promise.resolve(drillBlocker(s.blocker)).then(stamped);
    if (s.kind === 'result') return (s.gate ? drillResultFromGate(s.id, s.n, s.gate) : drillResult(s.id, s.n, null)).then(stamped);
    if (s.kind === 'event') return (s.gate ? drillEventFromGate(s.id, s.n, s.gate) : drillEvent(s.id, s.n, null)).then(stamped);
    if (s.kind === 'gates') {
      return api('/api/whatsnext').then(function (r) {
        drillGates(r.status === 200 ? (r.doc.pendingGates || []) : []);
        return stamped();
      });
    }
    return Promise.resolve(null);
  }
  /** A result drilled from a gate keeps the decision in hand — but the NODE decides whether
   *  there IS one (the SAME rule the pane applies): re-derive it here, so a gate decided
   *  since the link was made never shows an Accept/Reject that cannot land. */
  function drillResultFromGate(id, n, gate) {
    return api('/api/confirm?id=' + encodeURIComponent(id)).then(function (r) {
      var state = r.status === 200 ? gateState(r.doc.detail, gate).state : 'none';
      return drillResult(id, n, state === 'submitted' ? { id: id, gate: gate } : null);
    });
  }
  /** The SAME re-derivation for an event drilled from the exit gate: the event walk is part
   *  of the review, so the decision stays in hand while the operator reads it — and a gate
   *  decided since the link was made shows none. */
  function drillEventFromGate(id, n, gate) {
    return api('/api/confirm?id=' + encodeURIComponent(id)).then(function (r) {
      var state = r.status === 200 ? gateState(r.doc.detail, gate).state : 'none';
      return drillEvent(id, n, state === 'submitted' ? { id: id, gate: gate } : null);
    });
  }
  /** ONE EVENT — the command layer's 'ann events <id> <n>' drill: the RAW record plus the
   *  LINKS that command resolved for it (a commit · a ref · an artifact · the gate card ·
   *  the node itself), each naming the follow-up. The record and the link list ARE the
   *  command's value; this renders them and adds a drill where one applies. */
  function drillEvent(id, n, keep) {
    drillHead(
      (keep ? STEP[keep.gate].badge + ' STEP · ' : '') + 'one event',
      id + ' · event ' + n,
      'one event of the node’s log, RAW, plus what it points at — the SAME drill the CLI addresses: ann events ' + id + ' ' + n + '. Nothing is decided here; a node it names drills into its own tab.',
      keep,
    );
    sections({});
    return api('/api/events?id=' + encodeURIComponent(id) + '&n=' + n).then(function (r) {
      var node = drillFields();
      if (r.status !== 200) { field(node, 'error', JSON.stringify(r.doc.error)); return null; }
      var v = r.doc;
      field(node, 'event', n + ' of ' + v.total + ' on ' + id + ' (' + v.kind + ')');
      field(node, 'drill', 'ann events ' + id + ' ' + n);
      node.appendChild(el('h3', 'the event (raw)'));
      node.appendChild(el('pre', JSON.stringify(v.event, null, 2), 'drill-out'));
      var links = v.links || [];
      if (links.length) node.appendChild(el('h3', 'What it points at'));
      links.forEach(function (l) {
        var p = el('p', null, 'field');
        p.appendChild(el('span', l.kind + ': ', 'k'));
        p.appendChild(el('span', l.what + ' — ' + l.detail));
        // a NODE link drills into that node's own walk; every other kind names the CLI
        // command that shows more (a commit's git show, a ref's file, the gate card)
        if (l.kind === 'node' && l.what) p.appendChild(drillLink({ kind: String(l.what).indexOf('/') > 0 ? 'task' : 'leg', id: l.what }, 'task', 'drill in ›'));
        else p.appendChild(el('span', '  ' + l.command, 'ev'));
        node.appendChild(p);
      });
      return null;
    });
  }
  /** Open the pane for a DRILLED item: the same pane the gate queue uses, headed by what is
   *  shown. A drill is PRESENTED, never decided — the decision target is cleared, so no
   *  decision UI can appear for a node the operator did not pick from WAITING ON YOU. */
  function drillHead(label, title, what, keep) {
    // A drill from the EXIT GATE carries the decision it was opened inside ('keep'), so the
    // Accept/Reject survive the look (the operator is still reviewing that node); every
    // OTHER drill is PRESENTED, never decided — 'selected' is cleared, so no decision UI
    // can appear for a node the operator did not pick from WAITING ON YOU.
    selected = keep ? { id: keep.id, gate: keep.gate } : { id: null, gate: null };
    byId('card').hidden = false;
    byId('card-step-label').textContent = label;
    byId('card-title').textContent = title;
    byId('card-what').textContent = what;
    byId('card-next').replaceChildren();
    byId('card-decide').hidden = !(keep && keep.gate);
    message('');
    if (typeof byId('card').scrollIntoView === 'function') byId('card').scrollIntoView({ block: 'nearest' });
  }
  /** A drill's own fields; the views with no claims/checks/results hide those sections. */
  function drillFields() {
    var node = byId('card-node');
    node.replaceChildren();
    return node;
  }
  /** A drillable node id inside a blocker's text (the leg/task grammar), as task or leg. */
  function nodeIdsIn(text) {
    var out = [];
    var re = new RegExp('[0-9]{2}-[a-z0-9-]+(/[0-9]{2}-[a-z0-9-]+)?', 'g');
    var m;
    while ((m = re.exec(String(text))) !== null) if (out.indexOf(m[0]) < 0) out.push(m[0]);
    return out;
  }
  function nodeDrillButton(node, id, label) {
    node.appendChild(drillLink({ kind: id.indexOf('/') > 0 ? 'task' : 'leg', id: id }, 'task', (label || id + ' (drill in)') + ' ›'));
  }
  /** WHICH READ derives a blocker — the card names the rule, never a bare refusal. */
  function blockerSource(b) {
    if (b.indexOf('uncommitted tracked change') === 0) return 'git status --porcelain -- .ann/journey docs — the change is real work; the OPERATOR commits it (the daemon never commits)';
    if (b.indexOf('docs manifest out of sync') === 0) return 'ann docs --write — regenerate docs/manifest.json from docs/, then commit';
    if (b.indexOf('verify:') === 0) return 'ann verify — the drift read (the log’s claims vs filesystem/git reality, D1-D5)';
    if (b.indexOf('[') === 0) return 'ann check — the derived check rules (the rule id is in the bracket)';
    return 'ann check — gate gaps, contract self-sufficiency, the conclusion predicate';
  }
  function blockerClass(b) {
    if (b.indexOf('uncommitted tracked change') === 0) return 'a dirty tree: uncommitted tracked work';
    if (b.indexOf('docs manifest out of sync') === 0) return 'a stale docs index';
    if (b.indexOf('verify:') === 0) return 'DRIFT: the log and the filesystem disagree';
    if (b.indexOf('[') === 0) return 'a check-rule finding';
    return 'a check finding';
  }
  function drillBlocker(b) {
    drillHead('WHAT’S NEXT · integrity blocker', 'why the journey cannot advance',
      'this is ONE named blocker of the approve’s integrity re-check. The card never claims the journey can advance while one is present — the approve refuses fail-closed and writes NOTHING.');
    sections({});
    var node = drillFields();
    field(node, 'class', blockerClass(b));
    field(node, 'blocker', b);
    field(node, 'your step', (remedy(b) || 'clear it, then approve again').replace(/^ — /, ''));
    field(node, 'derived by', blockerSource(b));
    var ids = nodeIdsIn(b);
    if (ids.length) {
      node.appendChild(el('h3', 'What this names — drill in'));
      ids.forEach(function (id) { nodeDrillButton(node, id); });
    }
  }
  /** ONE result item — the command layer's 'ann results <id> <n>' drill, over the route the
   *  pane already calls: a commit → its 'git show' (message + changeset), a ref → the local
   *  file's head (or a directory's entries), an evidence event → the raw record, a link →
   *  its URL. The git/fs work is the COMMAND's; this renders what the command returns. */
  function drillResult(id, n, keep) {
    drillHead(
      (keep ? STEP[keep.gate].badge + ' STEP · ' : '') + 'a result item',
      id + ' · result ' + n,
      'one item of the results read on this node — a git commit (its git show), a ref (the local file or directory at that path), an evidence event, or a link. The SAME drill the CLI addresses, read through the service; no git or file logic is done here.',
      keep,
    );
    sections({});
    return api('/api/results?id=' + encodeURIComponent(id) + '&n=' + n).then(function (r) {
      var node = drillFields();
      if (r.status !== 200) { field(node, 'error', JSON.stringify(r.doc.error)); return null; }
      var v = r.doc;
      var it = v.item || {};
      field(node, 'item', it.kind + ' · ' + it.label + (it.at ? ' · ' + it.at : ''));
      field(node, 'drill', 'ann results ' + id + ' ' + n);
      if (v.commitError) field(node, 'commit', v.commitError);
      if (v.refError) field(node, 'ref', v.refError);
      if (v.sha) {
        node.appendChild(el('h3', 'git show'));
        node.appendChild(el('pre', v.sha, 'drill-out'));
      }
      if (v.stat) node.appendChild(el('pre', v.stat, 'drill-out'));
      if (v.dir) {
        field(node, 'directory', v.dir);
        (v.entries || []).forEach(function (f) { field(node, 'entry', f); });
      }
      if (v.file) {
        field(node, 'file', v.file);
        // the file's own leading bytes; the newline is built, not escaped — the served
        // script is ONE template literal, so a backslash escape would not survive it
        node.appendChild(el('pre', (v.head || []).join(String.fromCharCode(10)), 'drill-out'));
      }
      if (v.event) {
        node.appendChild(el('h3', 'the evidence event (raw)'));
        node.appendChild(el('pre', JSON.stringify(v.event, null, 2), 'drill-out'));
      }
      if (v.url) field(node, 'url', v.url);
      return null;
    });
  }
  /** The frontmost-ready task: its node card (contract · gates · claims · checks · results)
   *  PLUS the context packet the frame will materialize — what the step needs, and what is
   *  actually ready. The packet is derived on demand (/api/packet), never saved. */
  function drillTask(task) {
    return openCard(task, null).then(function () {
      drillHead('WHAT’S NEXT · the frontmost-ready task', task,
        'the task this derivation proposes to run through the frame. Above: its contract, gates, claims, checks and results. Below: the CONTEXT PACKET the frame materializes for it — what the step needs, and what is ready. Approving runs it; deciding happens in WAITING ON YOU.');
      return api('/api/packet?id=' + encodeURIComponent(task));
    }).then(function (r) {
      if (!r || r.status !== 200) { message('context packet unavailable: ' + JSON.stringify(r && r.doc && r.doc.error), true); return null; }
      var p = r.doc;
      var node = byId('card-node');
      node.appendChild(el('h3', 'Context packet — materialized by the frame, never saved'));
      field(node, 'readiness', p.readiness && p.readiness.ready ? 'ready' : 'BLOCKED — ' + ((p.readiness && p.readiness.blockers) || []).join('; '));
      (p.dependencies || []).forEach(function (d) {
        field(node, 'input ' + d.name, d.status + (d.path ? ' · ' + d.path + (d.sha ? ' @ ' + d.sha : '') : '') + (d.blocker ? ' — ' + d.blocker : ''));
      });
      if (!(p.dependencies || []).length) field(node, 'inputs', 'none declared (requiredInputs is empty)');
      var contracts = (p.nodeContract && p.nodeContract.expectedOutputs) || [];
      if (contracts.length) field(node, 'expected outputs', contracts.join(' · '));
      (p.openQuestions || []).forEach(function (q) { field(node, 'open question [' + q.impact + ']', (q.id ? q.id + ': ' : '') + q.question + (q.default ? ' (default: ' + q.default + ')' : '')); });
      var sib = (p.siblingStatus && p.siblingStatus.siblings) || [];
      if (sib.length) field(node, 'siblings', sib.map(function (s) { return s.id + ' (' + s.status + ')'; }).join(' · '));
      return null;
    });
  }
  /** The leg gate: the leg the derivation reads, every task it holds (each drillable), and
   *  the gate verdict (the PREDECESSOR gate — what holds this leg shut). */
  function drillLeg(leg, verdict) {
    drillHead('WHAT’S NEXT · the leg gate', leg,
      'the active leg this derivation reads. The leg gate is the PREDECESSOR gate: ' + (verdict && verdict.met ? 'MET — nothing holds this leg shut.' : 'UNMET — ' + ((verdict && verdict.blocker) || '(no blocker named)')) + ' The leg’s tasks and their derived statuses are below — drill into any one.');
    sections({ events: true });
    return api('/api/detail?id=' + encodeURIComponent(leg)).then(function (r) {
      if (r.status !== 200) { var n0 = drillFields(); field(n0, 'error', JSON.stringify(r.doc.error)); return null; }
      var d = r.doc;
      var node = drillFields();
      field(node, 'status', d.status + (d.createdAt ? ' · created ' + d.createdAt : ''));
      var c = d.contract || {};
      field(node, 'intent', c.intent || '(none)');
      (c.acceptanceCriteria || []).forEach(function (ac, i) { field(node, 'AC-' + (i + 1), ac); });
      (d.blockers || []).forEach(function (b) { field(node, 'blocker', b); });
      var tasks = d.tasks || [];
      node.appendChild(el('h3', 'Tasks (' + tasks.length + ') — drill into any one'));
      tasks.forEach(function (t) { nodeDrillButton(node, t.id, t.id + ' · ' + t.status + execVerdict(t)); });
      if (!tasks.length) node.appendChild(el('p', '(this leg holds no tasks — an EMPTY front leg is advance-leg: the next leg is AUTHORED work, never a machine spawn)', 'muted'));
      return loadEvents(leg, null);
    });
  }
  /** The pending gates: the human's OTHER move — each opens the gate card (the decision
   *  surface), exactly as the WAITING ON YOU queue does. */
  function drillGates(gates) {
    drillHead('WHAT’S NEXT · pending gates', 'waiting on you',
      'every undecided submission on the active leg: ' + gates.length + '. These are DECISIONS, not runs — open one to decide it (the same card the queue opens).');
    sections({});
    var node = drillFields();
    if (!gates.length) { node.appendChild(el('p', 'none — no undecided submission on the active leg.', 'muted')); return; }
    gates.forEach(function (p) {
      node.appendChild(drillLink({ kind: 'gate', id: p.task, gate: p.gate }, 'task', p.task + ' · ' + p.gate + ' (decide it) ›'));
      // WHAT THE DECISION UNLOCKS (12/18) — the engine's answer beside the human's, and
      // the GATE'S ROLE: an ENTRY accept makes the task runnable; an EXIT accept is not a
      // run at all — it closes the task when the conclusion evidence is there, and otherwise
      // leaves the close owed. One sentence cannot serve both gates.
      var rd = p.readiness || { ready: true, blockers: [] };
      node.appendChild(el('p', p.gate === 'confirm'
        ? (p.closesOnAccept
          ? 'accepting it closes the task — the conclusion evidence is present'
          : 'accepting it accepts the task: the close would still refuse, so complete! is owed')
        : (rd.ready
          ? 'accepting it makes the task runnable'
          : 'it would still not run — ' + rd.blockers.join('; ')), 'muted'));
    });
  }
  /** The derivation itself: the F5 pull proposal and everything it reads (the look-back).
   *  Its own items are drillable in turn. */
  function drillAdvance() {
    drillHead('WHAT’S NEXT · the derivation', 'the F5 pull proposal',
      'what the engine derives as the next step, and everything that derivation reads (the look-back). The approve on the card executes ONLY this — and re-derives it at execution.');
    sections({});
    return api('/api/next').then(function (r) {
      if (r.status !== 200) { var n0 = drillFields(); field(n0, 'error', JSON.stringify(r.doc.error)); return null; }
      var v = r.doc;
      var lb = v.lookBack || {};
      var node = drillFields();
      field(node, 'advance', v.advance.action + ' — ' + v.advance.detail);
      field(node, 'active leg', (lb.activeLeg || 'none') + (lb.activeLegStatus ? ' (' + lb.activeLegStatus + ')' : ''));
      if (lb.frontmostReady) field(node, 'frontmost-ready', lb.frontmostReady.task + ' (' + lb.frontmostReady.status + ')');
      (lb.alsoReady || []).forEach(function (t) { field(node, 'also ready', t.task + ' (' + t.status + ')'); });
      field(node, 'leg gate', lb.legGate && lb.legGate.met ? 'MET' : 'UNMET — ' + ((lb.legGate && lb.legGate.blocker) || ''));
      field(node, 'pending gates', (lb.pendingGates || []).length ? (lb.pendingGates || []).map(function (p) { return p.task + '@' + p.gate; }).join(' · ') : 'none');
      if (v.goal) field(node, 'goal consult', v.goal.goalId + ' [' + v.goal.goalStatus + '] — verdict ' + v.goal.verdict);
      node.appendChild(el('h3', 'Drill in from here'));
      if (lb.activeLeg) nodeDrillButton(node, lb.activeLeg);
      if (lb.frontmostReady) nodeDrillButton(node, lb.frontmostReady.task);
      return null;
    });
  }

  /** The approve: the SAME operator action the CLI's advance! runs, bound to the card the
   *  human is looking at. A refusal is SHOWN (the named blockers / the stale
   *  re-derivation), never swallowed; a landing re-reads the journey. */
  function approve() {
    if (!whatsNext || !whatsNext.advance) return;
    var proposal = { action: whatsNext.advance.action, detail: whatsNext.advance.detail };
    var button = byId('approve');
    button.disabled = true;
    wnMessage('approving ' + proposal.action + '…');
    fetch('/api/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ proposal: proposal })
    })
      .then(function (r) { return r.json().then(function (doc) { return { status: r.status, doc: doc }; }); })
      .then(function (r) {
        if (r.status !== 200) {
          var e = r.doc.error || {};
          var lines = ['approve refused — ' + (e.message || '')];
          (r.doc.blockers || []).forEach(function (b) { lines.push('blocker: ' + b + remedy(b)); });
          if (r.doc.reDerivation) lines.push('now: ' + r.doc.reDerivation.action + ' — ' + r.doc.reDerivation.detail);
          wnMessage(lines, true);
          return null;
        }
        wnMessage(landingText(r.doc.value), false);
        return refresh();
      })
      .catch(function (e) { wnMessage('approve request failed: ' + e.message, true); })
      .then(function () { button.disabled = false; });
  }
  /** Where the run landed — the NEXT human decision, in the card's words (never silent). */
  function landingText(v) {
    if (!v) return 'the action stopped.';
    if (v.stop === 'boundary') return 'nothing to execute — ' + v.derivation.detail;
    if (v.stop === 'declined') return 'declined — nothing executed.';
    var l = v.landing;
    if (!l) return 'the action stopped: ' + v.stop + (v.frame ? ' (' + v.frame.stop + ')' : '');
    if (l.where === 'gate') return 'landed at the next human gate — ' + l.task + ' gate ' + l.gate + ' is a submission awaiting YOUR decision (see WAITING ON YOU).';
    if (l.where === 'awaiting-runner') return 'ran ' + l.task + ' through the frame (' + l.frameStop + ') — it now awaits the RUNNER (the work + its commit evidence); the confirm-result gate is the next human decision.';
    if (l.where === 'completed') return l.task + ' completed.' + (l.advance ? ' next: ' + l.advance : '');
    return l.task + ' stopped (' + l.frameStop + '): ' + (l.problems || []).join('; ');
  }
  byId('approve').addEventListener('click', approve);
  byId('drive').addEventListener('click', drive);
  // the head is itself a drill: a NEW-TAB link to the derivation (the markup carries the
  // same href/target; this keeps it true wherever the render moves the action)
  byId('wn-action').href = drillHref({ kind: 'advance' });
  byId('wn-action').target = '_blank';
  byId('wn-action').rel = 'noopener';
  byId('wn-action').title = 'open in a new tab';

  // ── boot: the FULL journey view, or the ONE drilled item a new tab was opened at ──
  function refresh() {
    if (focus) return renderFocus(); // a focused tab re-reads its item, NEVER the journey
    return Promise.all([api('/api/journey'), api('/api/gates'), api('/api/whatsnext')]).then(function (r) {
      if (r[0].status !== 200) { byId('state').textContent = 'journey unavailable: ' + JSON.stringify(r[0].doc.error); return; }
      renderState(r[0].doc.ahead || {});
      renderLegs(r[0].doc.legs || []);
      renderDeferred((r[0].doc.ahead || {}).deferred);
      renderRework((r[0].doc.ahead || {}).rework);
      renderQueue(r[1].status === 200 ? r[1].doc : []);
      if (r[2].status !== 200) wnMessage("what's-next unavailable: " + JSON.stringify(r[2].doc.error), true);
      else { renderWhatsNext(r[2].doc); loadIntegrity(); } // the verdict is fetched LAZILY, after the render
      byId('updated').textContent = 'as of ' + new Date().toLocaleTimeString();
    });
  }
  var focus = null; // the drilled item this tab presents (null = the whole journey)
  byId('refresh').addEventListener('click', function () { refresh().catch(function (e) { message('refresh failed: ' + e.message, true); }); });
  window.addEventListener('focus', function () { refresh().catch(function () {}); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh().catch(function () {}); });
  var focusSpec = parseDrill();
  if (focusSpec) {
    // A DRILLED ITEM IN ITS OWN TAB: only that item is read and rendered — the journey
    // views are neither fetched nor shown.
    enterFocus(focusSpec);
    renderFocus().catch(function (e) { message('drill failed: ' + e.message, true); });
  } else {
    byId('back').hidden = true; // the way back belongs to a focused tab only
    refresh().catch(function (e) { byId('state').textContent = 'service unreachable: ' + e.message; });
  }
})();
</script>
</body>
</html>
`;
