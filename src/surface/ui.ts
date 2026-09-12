/**
 * THE MINIMAL UI (the goal's AC-3) — the journey view, the WAITING ON YOU gate queue, the
 * gate card, and the WHAT'S NEXT card (leg 11) with its DRILL-INS, as ONE page: vanilla
 * JS, no framework, no bundler, no build step (the server serves this string as-is, `GET /`).
 *
 * ONE DETAIL PANE, EVERY DETAIL: a gate queue row opens the gate card; a WHAT'S NEXT item
 * (the derivation, the frontmost-ready task, the leg gate, each pending gate, each integrity
 * blocker) opens the SAME pane, filled from the reads the service already exposes — the
 * node/packet/detail reads for the items, the goal consult for a `none` derivation. A
 * drilled item is PRESENTED, never decided.
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
 *                                  pending gates · the integrity blockers
 *   GET  /api/confirm?id=<node>  → the gate card: the complete node (contract · inputs ·
 *                                  open questions) · CLAIMS (with resolved pointers) ·
 *                                  CHECKS · gate states · results
 *   POST /api/gate               → the decision: {id, gate, decision, feedback} → the same
 *                                  L1 `gate!` write the CLI performs; the page then
 *                                  RE-READS the journey + queue, so a landed decision is
 *                                  what the view shows (never an optimistic local edit)
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
  .actions { display: flex; gap: .6rem; }
  .actions button { padding: .45rem 1.1rem; border-radius: 8px; border: 1px solid var(--line); background: #26242e; color: var(--fg); font: inherit; cursor: pointer; }
  .actions button.accept:hover { border-color: var(--ok); color: var(--ok); }
  .actions button.reject:hover { border-color: var(--warn); color: var(--warn); }
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
  .wn-action { padding: .1rem .5rem; margin-left: -.5rem; border: 1px solid transparent; border-radius: 8px; background: none; color: var(--fg); font: inherit; font-size: .95rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; cursor: pointer; }
  .wn-action:hover { border-color: var(--line); color: var(--accent); }
  .wn-detail { margin: .4rem 0 .6rem; font-size: .9rem; }
  .wn-facts { margin: 0 0 .35rem; font-size: .85rem; }
  .wn-facts button { display: inline-block; margin: 0 .35rem .35rem 0; padding: .15rem .6rem; border: 1px solid var(--line); border-radius: 999px; background: #26242e; color: var(--fg); font: inherit; font-size: .82rem; cursor: pointer; }
  .wn-facts button:hover { border-color: var(--accent); }
  .wn-facts button:hover .k { color: var(--accent); }
  .wn-facts .k { color: var(--muted); }
  .wn-blockers { margin: .35rem 0 .5rem; }
  .wn-blockers button { display: block; width: 100%; padding: .25rem .3rem; border: 1px solid transparent; border-radius: 8px; background: none; color: var(--warn); font: inherit; font-size: .85rem; text-align: left; cursor: pointer; }
  .wn-blockers button:hover { border-color: var(--warn); }
  .wn-blockers button .k { color: var(--muted); }
  .drill { margin: .15rem 0; font-size: .85rem; }
</style>
</head>
<body>
<header>
  <h1>ann · the journey</h1>
  <div class="hrow">
    <p id="state" class="state">loading…</p>
    <span><span id="updated" class="muted"></span> <button class="ghost" id="refresh">Refresh</button></span>
  </div>
</header>
<main>
  <section class="wn" id="wn">
    <h2>What's next</h2>
    <div class="wn-head">
      <button class="wn-action" id="wn-action">loading…</button>
      <span class="badge" id="wn-badge"></span>
    </div>
    <p class="wn-detail" id="wn-detail"></p>
    <p class="wn-facts" id="wn-facts"></p>
    <ul class="wn-blockers" id="wn-blockers"></ul>
    <div class="actions" id="wn-actions" hidden>
      <button class="accept" id="approve">Approve &amp; run the next step</button>
    </div>
    <p class="message" id="wn-message"></p>
  </section>
  <section class="queue">
    <h2>Waiting on you <span id="queue-count" class="count"></span></h2>
    <ul id="queue"><li class="muted">loading…</li></ul>
  </section>
  <section class="journey">
    <h2>The journey</h2>
    <div id="legs"></div>
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
      <textarea id="feedback" placeholder="feedback for the decision (the rejection's why)"></textarea>
      <div class="actions">
        <button class="accept" id="accept">Accept</button>
        <button class="reject" id="reject">Reject</button>
      </div>
    </div>
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
        var b = el('button', t.id + ' · ' + t.status, 'task status-' + t.status);
        b.addEventListener('click', function () { openCard(t.id, undecidedGate(t.id)); });
        sec.appendChild(b);
      });
      if (!(leg.tasks || []).length) sec.appendChild(el('p', '(no tasks)', 'muted'));
      box.appendChild(sec);
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
      b.appendChild(el('span', step.what, 'q-do ' + step.role));
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
    byId('card-claims-h').hidden = !o.claims;
    byId('card-checks-h').hidden = !o.checks;
    byId('card-results-h').hidden = !o.results;
    byId('card-gates').hidden = !o.gates;
  }
  /** What the task is WAITING FOR — derived from its status + gate states, never assumed:
   *  a queued task with nothing submitted is NOT decidable, and must not look it. */
  function nextLine(detail, gate) {
    var st = detail.status;
    var grill = gateState(detail, 'grill').state;
    var confirm = gateState(detail, 'confirm').state;
    if (gate && gateState(detail, gate).state === 'submitted') {
      return 'decide it now — accepting ' + gate + ' ' + (STEP[gate].role === 'entry' ? 'lets the work start' : 'lets it land');
    }
    if (st === 'done') return 'closed';
    if (st === 'accepted') return 'the exit gate is accepted but the conclusion evidence is MISSING — record it, then close: complete! ' + detail.id;
    if (st === 'blocked') {
      var which = confirm === 'submitted' ? 'confirm (exit)' : grill === 'submitted' ? 'grill (entry)' : 'a decision';
      return 'waiting on a decision — ' + which + ' is in WAITING ON YOU';
    }
    if (st === 'failed' || st === 'deferred' || st === 'cancelled' || st === 'superseded') return st;
    if (st === 'active') return 'work in progress';
    return grill === 'submitted'
      ? 'submitted at the entry gate — waiting on a decision (in WAITING ON YOU)'
      : grill === 'confirmed'
        ? 'the entry (grill) gate is confirmed — the work has not started'
        : 'queued — the entry (grill) gate has not been submitted yet; nothing to decide here';
  }

  function openCard(id, gate) {
    selected = { id: id, gate: gate };
    message('');
    sections({ claims: true, checks: true, gates: true, results: true }); // the gate card shows all four
    return api('/api/confirm?id=' + encodeURIComponent(id)).then(function (r) {
      if (r.status !== 200) { message('card unavailable: ' + JSON.stringify(r.doc.error), true); return; }
      var detail = r.doc.detail;
      var at = gateState(detail, gate);
      var decidable = !!gate && at.state === 'submitted'; // the NODE decides, not the page's snapshot
      var step = gate ? STEP[gate] : null;
      byId('card').hidden = false;
      byId('card-step-label').textContent = decidable
        ? step.badge + ' STEP · the ' + step.role + ' gate (' + gate + ')'
        : gate
          ? 'the ' + (step ? step.role : '') + ' gate (' + gate + ') — ALREADY ' + at.state.toUpperCase() + (at.at ? ' on ' + at.at : '')
          : 'TASK · ' + detail.status;
      byId('card-title').textContent = id;
      byId('card-what').textContent = decidable
        ? step.what
        : gate
          ? 'this gate was decided already — the view was showing a stale submission; press Refresh to see the current queue'
          : 'no undecided gate on this node — nothing to decide here';
      byId('card-next').replaceChildren();
      byId('card-next').appendChild(el('span', 'next: ', 'k'));
      byId('card-next').appendChild(el('span', nextLine(detail, gate)));
      byId('card-decide').hidden = !decidable; // ABSENT when there is nothing to decide

      // NODE — the contract as node.json holds it (the fields the CLI card prints)
      var node = byId('card-node');
      node.replaceChildren();
      var c = detail.contract || {};
      field(node, 'status', detail.status + (detail.createdAt ? ' · created ' + detail.createdAt : ''));
      field(node, 'intent', c.intent || '(none)');
      var acs = c.acceptanceCriteria || [];
      acs.forEach(function (ac, i) { field(node, 'AC-' + (i + 1), ac); });
      if (c.workType) field(node, 'workType', c.workType);
      if (c.model) field(node, 'model', c.model);
      (detail.inputs || []).forEach(function (i) {
        field(node, 'input ' + i.name, i.resolved ? i.path + ' @ ' + (i.sha || '(no sha)') : 'UNRESOLVED');
      });
      (detail.openQuestions || []).forEach(function (q) { field(node, 'open question' + (q.blocking ? ' [BLOCKING]' : ''), (q.id ? q.id + ': ' : '') + (q.question || '')); });

      // CLAIMS — how each acceptance criterion is met (resolved pointers), gaps named
      var claims = byId('card-claims');
      claims.replaceChildren();
      (detail.claims || []).forEach(function (claim) {
        var li = el('li', null, claim.statement ? '' : 'gap');
        li.appendChild(el('span', claim.ac + ': ', 'ac'));
        li.appendChild(el('span', claim.statement || 'NO CLAIM RECORDED — ' + (claim.acText || '')));
        (claim.evidence || []).forEach(function (e) { li.appendChild(el('span', 'evidence: ' + e, 'ev')); });
        claims.appendChild(li);
      });
      if (!(detail.claims || []).length) claims.appendChild(el('li', 'no claims recorded', 'muted'));

      // CHECKS — what was run, and against which bytes
      var checks = byId('card-checks');
      checks.replaceChildren();
      (detail.checks || []).forEach(function (k) {
        var li = el('li');
        li.appendChild(el('span', k.result === 'pass' ? 'PASS  ' : 'FAIL  ', k.result));
        li.appendChild(el('span', k.command + (k.sha ? ' @ ' + k.sha : '') + (k.detail ? ' — ' + k.detail : '')));
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
      (r.doc.results || []).forEach(function (it) { results.appendChild(el('li', it.kind + ' · ' + it.label)); });
      if (!decidable && !gate) message('no undecided gate on this node — nothing to decide here');
      return null;
    });
  }

  // ── the decision: the SAME L1 gate! write the CLI performs, then a re-read ──
  function decide(decision) {
    if (!selected.id || !selected.gate) { message('select a gate from WAITING ON YOU first', true); return; }
    var id = selected.id, gate = selected.gate;
    var body = { id: id, gate: gate, decision: decision, feedback: byId('feedback').value };
    message('recording ' + decision + '…');
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
        return fetch('/api/gate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
          .then(function (r) { return r.json().then(function (doc) { return { status: r.status, doc: doc }; }); })
          .then(function (r) {
            if (r.status !== 200) { message(decision + ' refused: ' + JSON.stringify(r.doc.error), true); return null; }
            message(decision + ' recorded — ' + id + ' ' + gate + ' gate (the view re-reads the log)');
            byId('feedback').value = '';
            return refresh();
          })
          .then(function () { return openCard(id, undecidedGate(id)); });
      })
      .catch(function (e) { message('request failed: ' + e.message, true); });
  }
  byId('accept').addEventListener('click', function () { decide('accept'); });
  byId('reject').addEventListener('click', function () { decide('reject'); });

  // ── the WHAT'S NEXT card: the derived proposal + the honest blocker surface (leg 11) ──
  var whatsNext = null; // the derivation the approve is bound to (the card the human saw)
  /** The operator action's four derivations, in the card's own words: continue-leg is the
   *  ONE the machine can execute; the other three are the AUTHORED-WORK BOUNDARY — the
   *  card presents them and STOPS (never a dead approve button). */
  var DERIVATION = {
    'continue-leg': { run: true, what: 'the machine can run this step through the frame' },
    'advance-leg': { run: false, what: 'NOT machine-executable — the authored-work boundary: the front leg is empty, so the next leg is AUTHORED work (a human writes the contract), never a machine spawn' },
    'closure-needed': { run: false, what: 'NOT machine-executable — the authored-work boundary: the leg gate is unmet, so closing it is a GATED HUMAN move (a closure task: transfer or defer), never a machine close' },
    'none': { run: false, what: 'NOT machine-executable — the authored-work boundary: every spawned leg is done; the goal consult is the human verdict (goal! met), never a machine seal' }
  };
  function wnMessage(text, isError) {
    var m = byId('wn-message');
    m.className = isError ? 'message error' : 'message';
    m.replaceChildren();
    var lines = Array.isArray(text) ? text : (text ? [text] : []);
    lines.forEach(function (line) { m.appendChild(el('div', line)); });
  }
  /** A blocker's own operator step: every blocker is NAMED, and the ones the operator can
   *  clear say how (ann check / ann verify / ann docs --write / git). */
  function remedy(b) {
    if (b.indexOf('uncommitted tracked change') === 0) return ' — uncommitted tracked journey changes — commit them (the operator step: the daemon never commits), then approve again';
    if (b.indexOf('docs manifest out of sync') === 0) return ' — run ann docs --write, commit, then approve again';
    if (b.indexOf('verify:') === 0) return ' — the log and the files disagree: run ann verify and reconcile';
    return '';
  }
  function renderWhatsNext(v) {
    whatsNext = v;
    var d = v.advance || { action: 'none', detail: '' };
    var step = DERIVATION[d.action] || { run: false, what: '' };
    var clean = v.integrity && v.integrity.clean;
    byId('wn-action').textContent = d.action;
    byId('wn-detail').textContent = d.detail;
    var badge = byId('wn-badge');
    if (step.run && clean) { badge.textContent = 'MACHINE-EXECUTABLE'; badge.className = 'badge run'; }
    else if (!clean) { badge.textContent = 'BLOCKED — CANNOT ADVANCE'; badge.className = 'badge stop'; }
    else { badge.textContent = 'PRESENTED AND STOPPED'; badge.className = 'badge stop'; }

    // the facts: EVERY one is a DRILL — click it and the pane shows the item's own data
    var facts = byId('wn-facts');
    facts.replaceChildren();
    function fact(k, val, drill) {
      var b = el('button', null, 'wn-fact');
      b.appendChild(el('span', k + ': ', 'k'));
      b.appendChild(el('span', val));
      b.appendChild(el('span', ' ›', 'k'));
      b.addEventListener('click', drill);
      facts.appendChild(b);
    }
    fact('frontmost-ready', v.frontmost ? v.frontmost.task + ' (' + v.frontmost.status + ')' : 'none',
      function () { if (v.frontmost) drillTask(v.frontmost.task); else wnMessage('no frontmost-ready task — nothing to drill (the derivation above says why).'); });
    fact('leg gate', v.legGate && v.legGate.met ? 'MET' : 'UNMET — ' + ((v.legGate && v.legGate.blocker) || ''), function () { drillLeg(v.advance.leg, v.legGate); });
    fact('pending gates', (v.pendingGates || []).length
      ? (v.pendingGates || []).map(function (p) { return p.task + '@' + p.gate; }).join(' · ')
      : 'none',
      function () { drillGates(v.pendingGates || []); });
    facts.appendChild(el('span', step.what, 'k'));

    // the integrity blockers — each is a DRILL too: the finding, its class, the read that
    // derives it, and the operator's step (the card CANNOT claim the journey can advance)
    var list = byId('wn-blockers');
    list.replaceChildren();
    var blockers = (v.integrity && v.integrity.blockers) || [];
    blockers.forEach(function (b) {
      var li = el('li');
      var btn = el('button', null, 'wn-blocker');
      btn.appendChild(el('span', 'blocker: ' + b));
      btn.appendChild(el('span', remedy(b) + ' ›', 'k'));
      btn.addEventListener('click', function () { drillBlocker(b); });
      li.appendChild(btn);
      list.appendChild(li);
    });
    if (blockers.length) list.appendChild(el('li', 'the approve re-checks all of this fail-closed first — with a blocker present it refuses and writes NOTHING.', 'muted'));

    // the approve affordance exists ONLY where it can work: clean state · continue-leg ·
    // a ready task. Otherwise the card PRESENTS the state and stops (never a dead button).
    var executable = !!(v.executable && step.run && clean);
    byId('wn-actions').hidden = !executable;
    if (!executable && !blockers.length && !step.run) wnMessage('nothing to approve — ' + step.what + '.');
    else if (!executable && !blockers.length) wnMessage('nothing to approve — no frontmost-ready task.');
    else if (!blockers.length) wnMessage('');
  }

  /* ── THE DRILL — every item on the WHAT'S NEXT card opens HERE, in the same pane the
   *  gate queue uses, filled from the reads the service ALREADY exposes (no new route, no
   *  new state): the item's own node / packet / derivation, and — for a gate — the
   *  decision surface. A drilled item is PRESENTED, never decided (selected is cleared),
   *  so no decision UI can appear for a node the operator did not pick from WAITING ON YOU. */
  function drillHead(label, title, what) {
    selected = { id: null, gate: null };
    byId('card').hidden = false;
    byId('card-step-label').textContent = label;
    byId('card-title').textContent = title;
    byId('card-what').textContent = what;
    byId('card-next').replaceChildren();
    byId('card-decide').hidden = true;
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
    var b = el('button', (label || id + ' (drill in)') + ' ›', 'task');
    b.addEventListener('click', function () { if (id.indexOf('/') > 0) drillTask(id); else drillLeg(id, null); });
    node.appendChild(b);
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
    sections({});
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
      tasks.forEach(function (t) { nodeDrillButton(node, t.id, t.id + ' · ' + t.status); });
      if (!tasks.length) node.appendChild(el('p', '(this leg holds no tasks — an EMPTY front leg is advance-leg: the next leg is AUTHORED work, never a machine spawn)', 'muted'));
      return null;
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
      var b = el('button', p.task + ' · ' + p.gate + ' (decide it) ›', 'task');
      b.addEventListener('click', function () { openCard(p.task, p.gate); });
      node.appendChild(b);
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
  byId('wn-action').addEventListener('click', drillAdvance); // the derivation itself drills in

  // ── boot: the reads, and a view that cannot go silently stale ──
  function refresh() {
    return Promise.all([api('/api/journey'), api('/api/gates'), api('/api/whatsnext')]).then(function (r) {
      if (r[0].status !== 200) { byId('state').textContent = 'journey unavailable: ' + JSON.stringify(r[0].doc.error); return; }
      renderState(r[0].doc.ahead || {});
      renderLegs(r[0].doc.legs || []);
      renderQueue(r[1].status === 200 ? r[1].doc : []);
      if (r[2].status !== 200) wnMessage("what's-next unavailable: " + JSON.stringify(r[2].doc.error), true);
      else renderWhatsNext(r[2].doc);
      byId('updated').textContent = 'as of ' + new Date().toLocaleTimeString();
    });
  }
  byId('refresh').addEventListener('click', function () { refresh().catch(function (e) { message('refresh failed: ' + e.message, true); }); });
  window.addEventListener('focus', function () { refresh().catch(function () {}); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh().catch(function () {}); });
  refresh().catch(function (e) { byId('state').textContent = 'service unreachable: ' + e.message; });
})();
</script>
</body>
</html>
`;
