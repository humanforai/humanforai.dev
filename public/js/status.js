/**
 * Human For AI — task status lookup page.
 * Accepts ?id=HFAI-... in the URL or manual entry, renders the
 * status timeline for the task.
 */
(function () {
  'use strict';

  var form = document.getElementById('status-form');
  if (!form) return;

  var input = document.getElementById('task-id-input');
  var resultEl = document.getElementById('status-result');
  var errorEl = document.getElementById('status-error');

  var STATUS_FLOW = ['submitted', 'accepted', 'delivered'];

  // `under_review` and `in_progress` were retired in v1.8.0. The API no
  // longer emits them, but a cached response or an old bookmark still
  // can, so they stay mapped here — without this, an unknown status
  // falls out of STATUS_FLOW and the whole timeline renders un-reached.
  var LEGACY_STATUS_MAP = { under_review: 'submitted', in_progress: 'accepted' };

  var STATUS_LABELS = {
    submitted: 'Submitted',
    accepted: 'Accepted',
    delivered: 'Delivered',
    rejected: 'Rejected',
  };

  function canonical(status) {
    return LEGACY_STATUS_MAP[status] || status;
  }

  /* Escapes quotes too, so values are safe in attribute contexts as well
     as text nodes. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtTime(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }

  function render(task) {
    // Earliest entry wins: a legacy status folds onto the step it became,
    // and must not overwrite that step's own, earlier timestamp.
    var historyByStatus = {};
    (task.status_history || []).forEach(function (h) {
      var key = canonical(h.status);
      if (!historyByStatus[key] || h.at < historyByStatus[key]) historyByStatus[key] = h.at;
    });

    var status = canonical(task.status);
    var rejected = status === 'rejected';
    var flow = rejected ? ['submitted', 'rejected'] : STATUS_FLOW;
    var currentIdx = flow.indexOf(status);

    var timeline = flow.map(function (status, i) {
      var reached = i <= currentIdx;
      var cls = reached ? (i === currentIdx ? 'done current' : 'done') : '';
      var at = historyByStatus[status];
      return (
        '<li class="' + cls + '">' +
        '<span class="t-status">' + esc(STATUS_LABELS[status] || status) + '</span>' +
        (at ? '<span class="t-time">' + esc(fmtTime(at)) + '</span>' : '') +
        '</li>'
      );
    }).join('');

    var pillClass = rejected ? 'pill-bad' : (status === 'delivered' ? 'pill-ok' : 'pill-accent');

    // The receipt has always been in the API response but never on this
    // page, so the proof only paid off for someone who read the docs and
    // wrote code. The token is long, so it lives behind a disclosure.
    var receipt = '';
    if (task.receipt) {
      receipt =
        '<h3>Signed receipt</h3>' +
        '<p class="small muted">Proof that the operator note above is exactly what was delivered, ' +
        'and that it came from humanforai.dev. Verifiable offline, with no account — ' +
        '<a href="/trust#receipts">how to check it yourself</a>.</p>' +
        (task.receipt_issued_at
          ? '<p class="small muted">Issued: ' + esc(fmtTime(task.receipt_issued_at)) + '</p>'
          : '') +
        (task.deliverable_sha256
          ? '<p class="small muted">Deliverable fingerprint (sha256):<br>' +
            '<span class="mono-break">' + esc(task.deliverable_sha256) + '</span></p>'
          : '') +
        '<details class="receipt-details">' +
        '<summary>Show the signed token</summary>' +
        '<pre class="code receipt-token"><code>' + esc(task.receipt) + '</code></pre>' +
        '<button type="button" class="btn btn-ghost btn-xs btn-copy" data-copy="' + esc(task.receipt) + '">copy token</button>' +
        '</details>';
    }

    resultEl.innerHTML =
      '<div class="panel">' +
      '<span class="machine muted">GET /api/v1/tasks/' + esc(task.task_id) + ' → 200 OK</span>' +
      '<h2 style="margin-top:0.75rem">' + esc(task.task_id) + '</h2>' +
      '<p><span class="pill ' + pillClass + '">' + esc(STATUS_LABELS[status] || status) + '</span> ' +
      '<span class="pill">' + esc(task.task_type) + '</span>' +
      (Number(task.budget_usd) > 0 ? ' <span class="pill">$' + esc(task.budget_usd) + '</span>' : '') +
      (task.receipt ? ' <span class="pill pill-ok">signed receipt</span>' : '') + '</p>' +
      '<p class="muted">' + esc(task.description) + '</p>' +
      (task.seen_by_operator_at ? '<p class="small muted">👁 Seen by operator: ' + esc(fmtTime(task.seen_by_operator_at)) + '</p>' : '') +
      (task.eta ? '<p class="small muted">Estimated delivery: ' + esc(fmtTime(task.eta)) + '</p>' : '') +
      (task.deadline ? '<p class="small muted">Deadline: ' + esc(fmtTime(task.deadline)) + '</p>' : '') +
      (task.operator_notes ? '<div class="notice">Operator note: ' + esc(task.operator_notes) + '</div>' : '') +
      '<h3>Progress</h3>' +
      '<ol class="timeline">' + timeline + '</ol>' +
      receipt +
      '</div>';
    resultEl.hidden = false;
    errorEl.hidden = true;
  }

  function lookup(id) {
    errorEl.hidden = true;
    resultEl.hidden = true;
    window.HumanAPIStore.getTask(id).then(function (r) {
      if (r.ok) {
        render(r.task);
      } else {
        errorEl.textContent = r.error === 'empty_id'
          ? 'Enter a task ID, e.g. HFAI-2026-A1B2C3D4E5F60718.'
          : 'No task found with that ID. Check the ID and try again — IDs look like HFAI-2026-A1B2C3D4E5F60718.';
        errorEl.hidden = false;
      }
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var id = input.value.trim();
    if (id) {
      var url = new URL(window.location.href);
      url.searchParams.set('id', id);
      history.replaceState(null, '', url);
    }
    lookup(id);
  });

  var fromQuery = new URLSearchParams(window.location.search).get('id');
  if (fromQuery) {
    input.value = fromQuery;
    lookup(fromQuery);
  }
})();
