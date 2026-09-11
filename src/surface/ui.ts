/**
 * THE MINIMAL UI (the goal's AC-3) — the journey view, the WAITING ON YOU gate queue,
 * and the gate card, as ONE page: vanilla JS, no framework, no bundler, no build step
 * (the server serves this string as-is, `GET /`).
 *
 * It is a CLIENT OF THE SERVICE'S HTTP CONTRACT ONLY — the same routes whose bodies are
 * the CLI's own `--json` values:
 *   GET  /api/journey            → the journey view: legs · tasks · the ahead/state line
 *   GET  /api/gates              → the WAITING ON YOU queue: EVERY undecided submission
 *                                  across the WHOLE journey (not just the active leg)
 *   GET  /api/confirm?id=<node>  → the gate card: contract (intent · ACs) · gate states
 *                                  · results
 *   POST /api/gate               → the decision: {id, gate, decision, feedback} → the
 *                                  same L1 `gate!` write the CLI performs; the page then
 *                                  RE-READS the journey + queue, so a landed decision is
 *                                  what the view shows (never an optimistic local edit)
 *
 * Relative URLs only — the page assumes nothing about where it is served from (local or
 * remote). No credentials, no state: rendering is a pure function of those three reads.
 */
export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ann — the journey</title>
<style>
  :root { color-scheme: dark; --fg: #e8e6e3; --muted: #9a958e; --bg: #16151a; --panel: #1f1e25; --line: #322f3a; --accent: #7cc4ff; --warn: #ffb454; --ok: #7ddc9a; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0 0 4rem; background: var(--bg); color: var(--fg); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { padding: 1.5rem 2rem 1rem; border-bottom: 1px solid var(--line); }
  h1 { margin: 0 0 .35rem; font-size: 1.15rem; letter-spacing: .02em; }
  h2 { margin: 0 0 .75rem; font-size: .8rem; text-transform: uppercase; letter-spacing: .12em; color: var(--muted); }
  h3 { margin: 0 0 .5rem; font-size: .95rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .muted { color: var(--muted); }
  .state { margin: 0; font-size: .85rem; color: var(--muted); }
  main { display: grid; grid-template-columns: minmax(320px, 1fr) minmax(360px, 1.2fr); gap: 1.5rem; padding: 1.5rem 2rem; align-items: start; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 1rem 1.15rem; }
  .queue { grid-column: 1 / -1; }
  ul { list-style: none; margin: 0; padding: 0; }
  .queue li { border-top: 1px solid var(--line); }
  .queue li:first-child { border-top: 0; }
  .queue button { display: flex; justify-content: space-between; gap: 1rem; width: 100%; padding: .55rem .25rem; background: none; border: 0; color: var(--fg); font: inherit; text-align: left; cursor: pointer; }
  .queue button:hover { color: var(--accent); }
  .gate-tag { color: var(--warn); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; }
  .count { color: var(--warn); }
  .leg { border-top: 1px solid var(--line); padding: .75rem 0; }
  .leg:first-child { border-top: 0; padding-top: 0; }
  .task { display: block; width: 100%; padding: .3rem .35rem; background: none; border: 0; border-left: 2px solid var(--line); color: var(--muted); font: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; text-align: left; cursor: pointer; }
  .task:hover { color: var(--fg); border-left-color: var(--accent); }
  .status-done { color: var(--ok); }
  .status-blocked { color: var(--warn); }
  .status-active { color: var(--accent); }
  .card-body h3 { font-size: 1rem; }
  .card-body p.intent { margin: .25rem 0 .75rem; }
  .card-body ul.acs { margin: 0 0 .75rem; padding-left: 1.1rem; list-style: disc; }
  .gates { display: flex; gap: .75rem; margin-bottom: .75rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; }
  .gates span { border: 1px solid var(--line); border-radius: 999px; padding: .1rem .6rem; }
  textarea { width: 100%; min-height: 4.5rem; margin: .35rem 0 .75rem; padding: .5rem; background: #121118; color: var(--fg); border: 1px solid var(--line); border-radius: 8px; font: inherit; }
  .actions { display: flex; gap: .6rem; }
  .actions button { padding: .45rem 1.1rem; border-radius: 8px; border: 1px solid var(--line); background: #26242e; color: var(--fg); font: inherit; cursor: pointer; }
  .actions button.accept:hover { border-color: var(--ok); color: var(--ok); }
  .actions button.reject:hover { border-color: var(--warn); color: var(--warn); }
  .message { margin: .75rem 0 0; font-size: .85rem; color: var(--muted); white-space: pre-wrap; }
  .message.error { color: var(--warn); }
</style>
</head>
<body>
<header>
  <h1>ann · the journey</h1>
  <p id="state" class="state">loading…</p>
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
    <h2>Gate card</h2>
    <h3 id="card-title"></h3>
    <p class="intent" id="card-intent"></p>
    <ul class="acs" id="card-acs"></ul>
    <div class="gates" id="card-gates"></div>
    <ul id="card-results"></ul>
    <textarea id="feedback" placeholder="feedback for the decision (the rejection's why)"></textarea>
    <div class="actions">
      <button class="accept" id="accept">Accept</button>
      <button class="reject" id="reject">Reject</button>
    </div>
    <p class="message" id="card-message"></p>
  </section>
</main>
<script>
(function () {
  'use strict';
  var selected = { id: null, gate: null };

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

  // ── the WAITING ON YOU queue: every undecided submission across the whole journey ──
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
      var li = el('li');
      var b = el('button');
      b.appendChild(el('span', g.task));
      b.appendChild(el('span', 'gate ' + g.gate, 'gate-tag'));
      b.addEventListener('click', function () { openCard(g.task, g.gate); });
      li.appendChild(b);
      list.appendChild(li);
    });
  }

  // ── the gate card: the node's contract · gate states · results + the decision ──
  function openCard(id, gate) {
    selected = { id: id, gate: gate };
    message('');
    return api('/api/confirm?id=' + encodeURIComponent(id)).then(function (r) {
      if (r.status !== 200) { message('card unavailable: ' + JSON.stringify(r.doc.error), true); return; }
      var detail = r.doc.detail;
      byId('card').hidden = false;
      byId('card-title').textContent = id + (gate ? ' · gate ' + gate : '');
      byId('card-intent').textContent = (detail.contract && detail.contract.intent) || '(no contract)';
      var acs = byId('card-acs');
      acs.replaceChildren();
      var list = (detail.contract && detail.contract.acceptanceCriteria) || [];
      list.forEach(function (ac) { acs.appendChild(el('li', ac)); });
      var gates = byId('card-gates');
      gates.replaceChildren();
      ['grill', 'confirm'].forEach(function (g) {
        var state = (detail.gates && detail.gates[g] && detail.gates[g].state) || 'none';
        gates.appendChild(el('span', g + ': ' + state));
      });
      var results = byId('card-results');
      results.replaceChildren();
      (r.doc.results || []).forEach(function (it) { results.appendChild(el('li', it.kind + ' · ' + it.label)); });
      byId('accept').disabled = gate === null;
      byId('reject').disabled = gate === null;
      if (gate === null) message('no undecided gate on this node — nothing to decide here');
      return null;
    });
  }

  // ── the decision: the SAME L1 gate! write the CLI performs, then a re-read ──
  function decide(decision) {
    if (!selected.id || !selected.gate) { message('select a gate from WAITING ON YOU first', true); return; }
    var body = { id: selected.id, gate: selected.gate, decision: decision, feedback: byId('feedback').value };
    message('recording ' + decision + '…');
    fetch('/api/gate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (doc) { return { status: r.status, doc: doc }; }); })
      .then(function (r) {
        if (r.status !== 200) { message(decision + ' refused: ' + JSON.stringify(r.doc.error), true); return null; }
        message(decision + ' recorded — ' + selected.id + ' gate ' + selected.gate + ' (the view re-reads the log)');
        byId('feedback').value = '';
        return refresh();
      })
      .then(function () { return openCard(selected.id, undecidedGate(selected.id)); })
      .catch(function (e) { message('request failed: ' + e.message, true); });
  }
  byId('accept').addEventListener('click', function () { decide('accept'); });
  byId('reject').addEventListener('click', function () { decide('reject'); });

  // ── boot: the three reads ──
  function refresh() {
    return Promise.all([api('/api/journey'), api('/api/gates')]).then(function (r) {
      if (r[0].status !== 200) { byId('state').textContent = 'journey unavailable: ' + JSON.stringify(r[0].doc.error); return; }
      renderState(r[0].doc.ahead || {});
      renderLegs(r[0].doc.legs || []);
      renderQueue(r[1].status === 200 ? r[1].doc : []);
    });
  }
  refresh().catch(function (e) { byId('state').textContent = 'service unreachable: ' + e.message; });
})();
</script>
</body>
</html>
`;
