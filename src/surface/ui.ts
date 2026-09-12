/**
 * THE MINIMAL UI (the goal's AC-3) — the journey view, the WAITING ON YOU gate queue, and
 * the gate card, as ONE page: vanilla JS, no framework, no bundler, no build step (the
 * server serves this string as-is, `GET /`).
 *
 * It is a CLIENT OF THE SERVICE'S HTTP CONTRACT ONLY — the same routes whose bodies are
 * the CLI's own `--json` values:
 *   GET  /api/journey            → the journey view: legs · tasks · the ahead/state line
 *   GET  /api/gates              → the WAITING ON YOU queue: EVERY undecided submission
 *                                  across the WHOLE journey, each with its STEP (the gate's
 *                                  role — ENTRY before work / EXIT before the close — the
 *                                  task's own intent, what is DELIVERED there already)
 *   GET  /api/confirm?id=<node>  → the gate card: the complete node (contract · inputs ·
 *                                  open questions) · CLAIMS (with resolved pointers) ·
 *                                  CHECKS · gate states · results
 *   POST /api/gate               → the decision: {id, gate, decision, feedback} → the same
 *                                  L1 `gate!` write the CLI performs; the page then
 *                                  RE-READS the journey + queue, so a landed decision is
 *                                  what the view shows (never an optimistic local edit)
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
    <h2>Claims</h2>
    <ul class="claims" id="card-claims"></ul>
    <h2>Checks</h2>
    <ul class="checks" id="card-checks"></ul>
    <div class="gates" id="card-gates"></div>
    <h2>Results</h2>
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
    confirm: { role: 'exit', badge: 'EXIT', what: 'the result gate — approving it lets the delivered work land (complete!)' }
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
    if (st === 'accepted') return 'the exit gate is accepted — awaiting the close: complete! ' + detail.id;
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

  // ── boot: the reads, and a view that cannot go silently stale ──
  function refresh() {
    return Promise.all([api('/api/journey'), api('/api/gates')]).then(function (r) {
      if (r[0].status !== 200) { byId('state').textContent = 'journey unavailable: ' + JSON.stringify(r[0].doc.error); return; }
      renderState(r[0].doc.ahead || {});
      renderLegs(r[0].doc.legs || []);
      renderQueue(r[1].status === 200 ? r[1].doc : []);
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
