/**
 * Human For AI — admin dashboard.
 * Lists incoming tasks, shows counts, allows status changes.
 * With the local server: uses the API + admin key (server.js prints a
 * per-run key at startup when ADMIN_KEY is unset).
 * Without a server: falls back to tasks stored in this browser.
 *
 * Section layout (order + collapsed state) is per-browser, in localStorage.
 */
(function () {
  'use strict';

  var app = document.getElementById('admin-app');
  if (!app) return;

  var keyForm = document.getElementById('admin-key-form');
  var keyInput = document.getElementById('admin-key-input');
  var dashboard = document.getElementById('admin-dashboard');
  var tbody = document.getElementById('task-rows');
  var archiveBody = document.getElementById('archive-rows');
  var statRow = document.getElementById('stat-row');
  var sourceNote = document.getElementById('admin-source');
  var keyError = document.getElementById('admin-key-error');

  var STATUSES = ['submitted', 'accepted', 'delivered', 'rejected'];
  var OPEN_STATUSES = ['submitted', 'accepted'];

  // Retired in v1.8.0; a row written before then can still carry one.
  var LEGACY_STATUS_MAP = { under_review: 'submitted', in_progress: 'accepted' };
  var STATUS_ORDER = ['submitted', 'accepted', 'delivered'];

  function canonical(status) {
    return LEGACY_STATUS_MAP[status] || status;
  }

  // Mirrors the server guard, so an unreachable status is greyed out in
  // the dropdown rather than being clickable and coming back a 409.
  function canTransition(from, to) {
    if (from === to) return true;
    if (from === 'delivered' || from === 'rejected') return false;
    if (to === 'rejected') return true;
    var fromIdx = STATUS_ORDER.indexOf(from);
    var toIdx = STATUS_ORDER.indexOf(to);
    if (fromIdx === -1 || toIdx === -1) return false;
    return toIdx > fromIdx;
  }

  var adminKey = sessionStorage.getItem('human_api_admin_key') || '';
  // Hashes currently on the abuse blocklist — loaded before rows render
  // so each row's block/unblock button shows the right state.
  var blockedSet = new Set();

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
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  }

  function renderStats(tasks) {
    var open = tasks.filter(function (t) {
      return OPEN_STATUSES.indexOf(canonical(t.status)) !== -1;
    }).length;
    var delivered = tasks.filter(function (t) { return t.status === 'delivered'; }).length;
    var rejected = tasks.filter(function (t) { return t.status === 'rejected'; }).length;

    statRow.innerHTML =
      '<div class="stat"><div class="stat-n">' + tasks.length + '</div><div class="stat-l">total_requests</div></div>' +
      '<div class="stat"><div class="stat-n">' + open + '</div><div class="stat-l">open_tasks</div></div>' +
      '<div class="stat"><div class="stat-n">' + delivered + '</div><div class="stat-l">delivered</div></div>' +
      '<div class="stat"><div class="stat-n">' + rejected + '</div><div class="stat-l">rejected</div></div>';
  }

  function renderRows(tasks, body, emptyHTML) {
    if (!tasks.length) {
      body.innerHTML = '<tr><td colspan="6" class="muted">' + emptyHTML + '</td></tr>';
      return;
    }
    body.innerHTML = tasks.map(function (t) {
      var current = canonical(t.status);
      var options = STATUSES.map(function (s) {
        return '<option value="' + s + '"' +
          (s === current ? ' selected' : '') +
          (canTransition(current, s) ? '' : ' disabled') +
          '>' + s + '</option>';
      }).join('');
      return (
        '<tr>' +
        '<td><a class="mono-link machine" href="/tasks?id=' + encodeURIComponent(t.task_id) + '">' + esc(t.task_id) + '</a>' +
        '<br><span class="small muted">' + esc(fmtTime(t.created_at)) + '</span>' +
        (t.client_ip_hash
          ? '<br><button type="button" class="btn btn-ghost btn-xs ip-block" data-hash="' + esc(t.client_ip_hash) +
            '" data-ref="' + esc(t.task_id) + '">' + (blockedSet.has(t.client_ip_hash) ? 'unblock client' : 'block client') + '</button>'
          : '') + '</td>' +
        '<td><span class="pill">' + esc(t.task_type) + '</span></td>' +
        '<td class="admin-desc">' + esc(t.description) +
        (t.contact_email ? '<br><span class="small muted">' + esc(t.contact_email) + '</span>' : '') +
        (t.delivery === 'status_poll'
          ? '<br><span class="pill" title="No mailbox — write the deliverable into operator notes; the agent reads it via the status endpoint">deliver via status poll</span>'
          : '') +
        // A delivered task is signed automatically. Surfacing the hash is
        // the operator's confirmation that the receipt covers the text
        // currently in operator notes — editing the notes re-signs them.
        (t.receipt
          ? '<br><span class="pill pill-accent" title="Signed ' + esc(fmtTime(t.receipt_issued_at)) +
            ' — receipt covers the current operator notes (sha256 ' + esc(t.deliverable_sha256) + ')">signed receipt issued</span>'
          : '') + '</td>' +
        '<td class="machine">' + (Number(t.budget_usd) > 0 ? '$' + esc(t.budget_usd) : '—') + '</td>' +
        '<td class="machine small">' + (t.deadline ? esc(fmtTime(t.deadline)) : '—') + '</td>' +
        // data-current lets a cancelled dialog put the select back where
        // it was, rather than leaving it showing a change that never saved.
        '<td><select class="status-select" data-task="' + esc(t.task_id) + '" data-current="' + esc(current) +
        '" aria-label="Status for ' + esc(t.task_id) + '">' +
        options + '</select>' +
        '<div class="status-meta">' +
        etaLabelHtml(t.eta, current) +
        '<button type="button" class="btn btn-ghost btn-xs notes-edit" data-task="' + esc(t.task_id) + '">' +
        (t.operator_notes ? '<span class="notes-dot">●</span> notes' : 'add notes') +
        '</button>' +
        '</div></td>' +
        '</tr>'
      );
    }).join('');

    body.querySelectorAll('.status-select').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var taskId = sel.getAttribute('data-task');
        var next = sel.value;
        var task = tasks.filter(function (x) { return x.task_id === taskId; })[0] || {};

        // Two transitions want more than a status change. Accepting is
        // when a delivery estimate is worth promising; delivering is when
        // the deliverable itself has to exist, since that text is what
        // the requester receives and what the receipt signs.
        var ask;
        if (next === 'accepted') ask = askEta(taskId);
        else if (next === 'delivered') ask = askNotes(taskId, task.operator_notes, true);
        else ask = Promise.resolve({ ok: true });

        ask.then(function (answer) {
          if (!answer.ok) {
            sel.value = sel.getAttribute('data-current');
            return;
          }
          var patch = { status: next };
          if (answer.eta) patch.eta = answer.eta;
          if (answer.notes !== undefined) patch.operator_notes = answer.notes;
          window.HumanAPIStore.updateTask(taskId, patch, adminKey).then(function (r) {
            if (!r.ok) alert('Update failed: ' + r.error);
            load();
          });
        });
      });
    });

    body.querySelectorAll('.notes-edit').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var taskId = btn.getAttribute('data-task');
        var task = tasks.filter(function (x) { return x.task_id === taskId; })[0] || {};
        askNotes(taskId, task.operator_notes, false).then(function (answer) {
          if (!answer.ok || answer.notes === undefined) return;
          window.HumanAPIStore.updateTask(taskId, { operator_notes: answer.notes }, adminKey)
            .then(function (r) {
              if (!r.ok) alert('Update failed: ' + r.error);
              load();
            });
        });
      });
    });
  }

  /* ---- ETA countdown ----------------------------------------------- *
   * The dashboard does not poll, so the label carries a relative time
   * and is re-ticked in place — an absolute timestamp alone tells the
   * operator nothing about how much room is left.                       */

  function relTime(iso) {
    var ms = new Date(iso).getTime() - Date.now();
    var mins = Math.round(Math.abs(ms) / 60000);
    var text;
    if (mins < 1) text = 'now';
    else if (mins < 60) text = mins + 'm';
    else if (mins < 2880) text = Math.round(mins / 60) + 'h';
    else text = Math.round(mins / 1440) + 'd';
    return { past: ms < 0, text: text, ms: ms };
  }

  function etaClass(eta, status) {
    // A closed task keeps its ETA for the record but stops being urgent.
    if (status === 'delivered' || status === 'rejected') return '';
    var rel = relTime(eta);
    if (rel.past) return ' is-overdue';
    if (rel.ms < 2 * 3600 * 1000) return ' is-due';
    return '';
  }

  function etaText(eta, status) {
    var rel = relTime(eta);
    var closed = status === 'delivered' || status === 'rejected';
    if (closed) return 'eta was ' + fmtTime(eta);
    return (rel.past ? 'overdue by ' + rel.text : 'due in ' + rel.text);
  }

  function etaLabelHtml(eta, status) {
    if (!eta) return '';
    return '<span class="eta-label' + etaClass(eta, status) + '" data-eta="' + esc(eta) +
      '" data-status="' + esc(status) + '" title="ETA ' + esc(fmtTime(eta)) + '">' +
      esc(etaText(eta, status)) + '</span>';
  }

  // Keep the countdowns honest on a dashboard left open, without
  // re-fetching: only the label text and its urgency class change.
  setInterval(function () {
    document.querySelectorAll('.eta-label[data-eta]').forEach(function (el) {
      var eta = el.getAttribute('data-eta');
      var status = el.getAttribute('data-status');
      el.textContent = etaText(eta, status);
      el.className = 'eta-label' + etaClass(eta, status);
    });
  }, 60000);

  /* ---- ETA picker -------------------------------------------------- *
   * Replaces the old free-text prompt(): a native datetime-local field
   * plus presets, so the operator picks a real moment instead of typing
   * an ISO string that may or may not parse. Resolves with
   * { ok: false } if the accept is cancelled, or { ok: true, eta } where
   * eta is a UTC ISO string, or undefined when accepting without one.   */

  var etaDialog = document.getElementById('eta-dialog');

  function pad(n) { return String(n).padStart(2, '0'); }

  // datetime-local speaks local wall-clock time; toISOString() would
  // shift it by the UTC offset, so the value is built by hand.
  function toInputValue(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function askEta(taskId) {
    if (!etaDialog || typeof etaDialog.showModal !== 'function') {
      return Promise.resolve({ ok: true });
    }

    var input = document.getElementById('eta-input');
    var errorEl = document.getElementById('eta-error');
    var taskEl = document.getElementById('eta-dialog-task');

    taskEl.innerHTML = 'Accepting <code>' + esc(taskId) + '</code>. Agents read this as <code>eta</code> when they poll.';
    errorEl.hidden = true;

    var now = new Date();
    input.min = toInputValue(now);
    // Default to a working day out, on the hour — a plausible promise the
    // operator can adjust rather than an empty field they must fill.
    var suggested = new Date(now.getTime() + 24 * 3600 * 1000);
    suggested.setMinutes(0, 0, 0);
    input.value = toInputValue(suggested);

    return new Promise(function (resolve) {
      var settled = false;

      function finish(answer) {
        if (settled) return;
        settled = true;
        cleanup();
        if (etaDialog.open) etaDialog.close();
        resolve(answer);
      }

      function onQuick(e) {
        var hours = e.target.getAttribute('data-eta-hours');
        if (!hours) return;
        var t = new Date(Date.now() + Number(hours) * 3600 * 1000);
        t.setMinutes(0, 0, 0);
        input.value = toInputValue(t);
        errorEl.hidden = true;
      }

      function onSave() {
        if (!input.value) {
          errorEl.textContent = 'Pick a date and time, or choose “Accept without ETA”.';
          errorEl.hidden = false;
          return;
        }
        var when = new Date(input.value);
        if (isNaN(when.getTime())) {
          errorEl.textContent = 'That is not a valid date and time.';
          errorEl.hidden = false;
          return;
        }
        if (when.getTime() <= Date.now()) {
          errorEl.textContent = 'That moment has already passed — pick a time in the future.';
          errorEl.hidden = false;
          return;
        }
        finish({ ok: true, eta: when.toISOString() });
      }

      var onSkip = function () { finish({ ok: true }); };
      var onCancel = function () { finish({ ok: false }); };
      // Escape closes the dialog natively; treat that as cancelling the
      // whole accept, not as accepting without an ETA.
      var onClose = function () { finish({ ok: false }); };
      var quickWrap = document.getElementById('eta-quick');
      var saveBtn = document.getElementById('eta-save');
      var skipBtn = document.getElementById('eta-skip');
      var cancelBtn = document.getElementById('eta-cancel');

      function cleanup() {
        saveBtn.removeEventListener('click', onSave);
        skipBtn.removeEventListener('click', onSkip);
        cancelBtn.removeEventListener('click', onCancel);
        quickWrap.removeEventListener('click', onQuick);
        etaDialog.removeEventListener('close', onClose);
      }

      saveBtn.addEventListener('click', onSave);
      skipBtn.addEventListener('click', onSkip);
      cancelBtn.addEventListener('click', onCancel);
      quickWrap.addEventListener('click', onQuick);
      etaDialog.addEventListener('close', onClose);

      etaDialog.showModal();
      input.focus();
    });
  }

  /* ---- Operator notes ---------------------------------------------- *
   * The one field that carries the deliverable: the public status page
   * renders it, status_poll agents read it as their only result channel,
   * and the signed receipt hashes its exact bytes. Opened either from the
   * row's notes button or automatically on the delivered transition.
   *
   * Resolves { ok: false } when cancelled, { ok: true, notes } to save,
   * or { ok: true } with no notes key to proceed without touching them.  */

  var notesDialog = document.getElementById('notes-dialog');

  function askNotes(taskId, currentNotes, forDelivery) {
    if (!notesDialog || typeof notesDialog.showModal !== 'function') {
      return Promise.resolve({ ok: true });
    }

    var input = document.getElementById('notes-input');
    var errorEl = document.getElementById('notes-error');
    var countEl = document.getElementById('notes-count');
    var titleEl = document.getElementById('notes-dialog-title');
    var taskEl = document.getElementById('notes-dialog-task');
    var receiptHint = document.getElementById('notes-receipt-hint');
    var saveBtn = document.getElementById('notes-save');
    var skipBtn = document.getElementById('notes-skip');
    var cancelBtn = document.getElementById('notes-cancel');

    input.value = currentNotes || '';
    countEl.textContent = String(input.value.length);
    errorEl.hidden = true;
    titleEl.textContent = forDelivery ? 'Deliverable' : 'Operator notes';
    taskEl.innerHTML = forDelivery
      ? 'Delivering <code>' + esc(taskId) + '</code>. This text is what the requester receives.'
      : 'Notes for <code>' + esc(taskId) + '</code>.';
    receiptHint.hidden = !forDelivery;
    skipBtn.hidden = !forDelivery;
    saveBtn.textContent = forDelivery ? 'Save & deliver' : 'Save notes';

    return new Promise(function (resolve) {
      var settled = false;

      function finish(answer) {
        if (settled) return;
        settled = true;
        cleanup();
        if (notesDialog.open) notesDialog.close();
        resolve(answer);
      }

      function onCount() { countEl.textContent = String(input.value.length); }

      function onSave() {
        // Empty is a legitimate edit outside delivery (clearing a note),
        // but delivering nothing is almost always a mistake — the skip
        // button is there for the rare case it is not.
        if (forDelivery && !input.value.trim()) {
          errorEl.textContent = 'Nothing to deliver. Write the result, or use “Deliver without receipt”.';
          errorEl.hidden = false;
          return;
        }
        finish({ ok: true, notes: input.value.trim() });
      }

      var onSkip = function () { finish({ ok: true }); };
      var onCancel = function () { finish({ ok: false }); };
      var onClose = function () { finish({ ok: false }); };

      function cleanup() {
        saveBtn.removeEventListener('click', onSave);
        skipBtn.removeEventListener('click', onSkip);
        cancelBtn.removeEventListener('click', onCancel);
        input.removeEventListener('input', onCount);
        notesDialog.removeEventListener('close', onClose);
      }

      saveBtn.addEventListener('click', onSave);
      skipBtn.addEventListener('click', onSkip);
      cancelBtn.addEventListener('click', onCancel);
      input.addEventListener('input', onCount);
      notesDialog.addEventListener('close', onClose);

      notesDialog.showModal();
      input.focus();
    });
  }

  function renderMessages(messages) {
    var mbody = document.getElementById('message-rows');
    if (!mbody) return;
    var countEl = document.getElementById('messages-count');
    if (countEl) countEl.textContent = messages.length ? String(messages.length) : '';
    var clearBtn = document.getElementById('messages-clear');
    if (clearBtn) clearBtn.hidden = !messages.length;

    if (!messages.length) {
      mbody.innerHTML = '<tr><td colspan="5" class="muted">No messages yet. ' +
        'Agents and humans can send one via <code>POST /api/v1/messages</code> or the <a href="/contact">contact page</a>.</td></tr>';
      return;
    }
    mbody.innerHTML = messages.map(function (m) {
      return (
        '<tr>' +
        '<td class="machine small">' + esc(m.message_id) +
        '<br><span class="small muted">' + esc(fmtTime(m.created_at)) + '</span></td>' +
        '<td>' + esc(m.from) + '</td>' +
        '<td class="admin-desc">' + (m.subject ? '<strong>' + esc(m.subject) + '</strong><br>' : '') + esc(m.message) + '</td>' +
        '<td>' + (m.reply_to
          ? '<a class="mono-link machine small" href="mailto:' + esc(m.reply_to) + '">' + esc(m.reply_to) + '</a>'
          : '<span class="muted small">none</span>') + '</td>' +
        '<td><button type="button" class="btn btn-ghost btn-xs msg-reply" data-message="' + esc(m.message_id) + '" ' +
        'title="Reply in the thread (and push the webhook, if any)">reply' +
        (m.replies && m.replies.length ? ' (' + m.replies.length + ')' : '') + '</button>' +
        '<br><button type="button" class="btn btn-ghost btn-xs msg-delete" data-message="' + esc(m.message_id) + '" ' +
        'title="Delete this message" aria-label="Delete message ' + esc(m.message_id) + '">delete</button>' +
        (m.client_ip_hash
          ? '<br><button type="button" class="btn btn-ghost btn-xs ip-block" data-hash="' + esc(m.client_ip_hash) +
            '" data-ref="' + esc(m.message_id) + '">' + (blockedSet.has(m.client_ip_hash) ? 'unblock client' : 'block client') + '</button>'
          : '') + '</td>' +
        '</tr>'
      );
    }).join('');

    mbody.querySelectorAll('.msg-reply').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var mid = btn.getAttribute('data-message');
        var text = prompt('Reply in thread ' + mid + ' (the requester reads it via the thread API; webhook reply_to gets a signed push):');
        if (!text || text.trim().length < 2) return;
        btn.disabled = true;
        fetch('/api/v1/messages/' + encodeURIComponent(mid), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
          body: JSON.stringify({ message: text.trim() }),
        }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (r) {
          btn.disabled = false;
          if (!r.ok) { alert('Reply failed: ' + (r.j.error || 'unknown')); return; }
          if (r.j.webhook_delivery && !r.j.webhook_delivery.ok) {
            alert('Reply saved, but the webhook push failed (' + (r.j.webhook_delivery.error || r.j.webhook_delivery.status) + '). The requester can still read it in the thread.');
          }
          load();
        }).catch(function (e) { btn.disabled = false; alert('Reply failed: ' + e); });
      });
    });

    mbody.querySelectorAll('.msg-delete').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var mid = btn.getAttribute('data-message');
        if (!confirm('Delete message ' + mid + '? This cannot be undone.')) return;
        btn.disabled = true;
        window.HumanAPIStore.deleteMessages(mid, adminKey).then(function (r) {
          if (!r.ok) { alert('Delete failed: ' + r.error); btn.disabled = false; return; }
          load();
        });
      });
    });
  }

  var clearAllBtn = document.getElementById('messages-clear');
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', function () {
      if (!confirm('Delete ALL messages? This cannot be undone.')) return;
      clearAllBtn.disabled = true;
      window.HumanAPIStore.deleteMessages(null, adminKey).then(function (r) {
        clearAllBtn.disabled = false;
        if (!r.ok) { alert('Clear failed: ' + r.error); return; }
        load();
      });
    });
  }

  function renderBlocklist(entries) {
    var bbody = document.getElementById('blocklist-rows');
    if (!bbody) return;
    var countEl = document.getElementById('blocklist-count');
    if (countEl) countEl.textContent = entries.length ? String(entries.length) : '';
    if (!entries.length) {
      bbody.innerHTML = '<tr><td colspan="4" class="muted">No blocked clients. ' +
        'Use the "block client" button on any task or message row.</td></tr>';
      return;
    }
    bbody.innerHTML = entries.map(function (b) {
      return (
        '<tr>' +
        '<td class="machine small">' + esc(b.ip_hash) + '</td>' +
        '<td class="small">' + esc(b.note || '—') + '</td>' +
        '<td class="machine small">' + esc(fmtTime(b.created_at)) + '</td>' +
        '<td><button type="button" class="btn btn-ghost btn-xs ip-block" data-hash="' + esc(b.ip_hash) + '">unblock</button></td>' +
        '</tr>'
      );
    }).join('');
  }

  // One delegated handler covers block/unblock buttons in every section —
  // rows re-render often, so per-render wiring would leak or miss.
  function handleBlockClick(btn) {
    var hash = btn.getAttribute('data-hash');
    var ref = btn.getAttribute('data-ref') || 'admin';
    if (blockedSet.has(hash)) {
      if (!confirm('Unblock client ' + hash + '? Its submissions will be accepted again.')) return;
      window.HumanAPIStore.unblockIp(hash, adminKey).then(function (r) {
        if (!r.ok) { alert('Unblock failed: ' + r.error); return; }
        load();
      });
    } else {
      if (!confirm('Block client ' + hash + '? Every future task or message from it will be rejected with 403.')) return;
      window.HumanAPIStore.blockIp(hash, 'blocked from ' + ref, adminKey).then(function (r) {
        if (!r.ok) { alert('Block failed: ' + r.error); return; }
        load();
      });
    }
  }

  /* ---- section layout: order + collapsed state, per browser ---- */

  var LAYOUT_KEY = 'human_api_admin_layout';
  var sectionsWrap = document.getElementById('admin-sections');

  function readLayout() {
    try { return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; }
    catch { return {}; }
  }

  function writeLayout(layout) {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* private mode — layout just won't persist */ }
  }

  function sectionEls() {
    return Array.prototype.slice.call(sectionsWrap.querySelectorAll('.admin-section'));
  }

  function saveLayout() {
    var collapsed = {};
    sectionEls().forEach(function (s) {
      collapsed[s.getAttribute('data-section')] = s.classList.contains('collapsed');
    });
    writeLayout({
      order: sectionEls().map(function (s) { return s.getAttribute('data-section'); }),
      collapsed: collapsed,
    });
  }

  function setCollapsed(section, isCollapsed) {
    section.classList.toggle('collapsed', isCollapsed);
    var toggle = section.querySelector('.section-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', String(!isCollapsed));
  }

  function applyLayout() {
    var layout = readLayout();
    if (layout.order) {
      layout.order.forEach(function (name) {
        var el = sectionsWrap.querySelector('.admin-section[data-section="' + name + '"]');
        if (el) sectionsWrap.appendChild(el); // reappending sorts into saved order
      });
    }
    sectionEls().forEach(function (s) {
      var name = s.getAttribute('data-section');
      var saved = layout.collapsed && layout.collapsed[name];
      // No saved state yet → honour the markup default (Archive starts closed).
      var isCollapsed = saved === undefined
        ? s.querySelector('.section-toggle').getAttribute('aria-expanded') === 'false'
        : saved;
      setCollapsed(s, isCollapsed);
    });
    refreshMoveButtons();
  }

  // Grey out ↑ on the first section and ↓ on the last — hidden sections
  // (Traffic in localStorage mode) don't count as neighbours.
  function refreshMoveButtons() {
    var visible = sectionEls().filter(function (s) { return !s.hidden; });
    visible.forEach(function (s, i) {
      var up = s.querySelector('[data-move="up"]');
      var down = s.querySelector('[data-move="down"]');
      if (up) up.disabled = i === 0;
      if (down) down.disabled = i === visible.length - 1;
    });
  }

  function moveSection(section, dir) {
    var visible = sectionEls().filter(function (s) { return !s.hidden; });
    var i = visible.indexOf(section);
    var swap = visible[dir === 'up' ? i - 1 : i + 1];
    if (!swap) return;
    if (dir === 'up') sectionsWrap.insertBefore(section, swap);
    else sectionsWrap.insertBefore(swap, section);
    saveLayout();
    refreshMoveButtons();
    section.querySelector('[data-move="' + dir + '"]').focus();
  }

  sectionsWrap.addEventListener('click', function (e) {
    var blockBtn = e.target.closest('.ip-block');
    if (blockBtn) {
      handleBlockClick(blockBtn);
      return;
    }
    var moveBtn = e.target.closest('[data-move]');
    if (moveBtn) {
      moveSection(moveBtn.closest('.admin-section'), moveBtn.getAttribute('data-move'));
      return;
    }
    var toggle = e.target.closest('.section-toggle');
    if (toggle) {
      var section = toggle.closest('.admin-section');
      setCollapsed(section, !section.classList.contains('collapsed'));
      saveLayout();
    }
  });

  var resetBtn = document.getElementById('layout-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      try { localStorage.removeItem(LAYOUT_KEY); } catch { /* nothing to clear */ }
      location.reload();
    });
  }

  var CLASS_LABELS = {
    browser: 'human browsers',
    script: 'scripts / HTTP clients',
    ai_crawler: 'AI crawlers (GPTBot, ClaudeBot…)',
    ai_agent: 'AI agent frameworks',
    mcp_client: 'MCP clients',
    search_crawler: 'search crawlers',
    other: 'other',
    unknown: 'unknown',
  };
  var MACHINE_CLASSES = ['script', 'ai_crawler', 'ai_agent', 'mcp_client', 'search_crawler', 'other'];

  function machineCount(day) {
    var c = day.classes || {};
    return MACHINE_CLASSES.reduce(function (s, k) { return s + (c[k] || 0); }, 0);
  }

  function renderTraffic(data) {
    var days = data.days || [];
    var today = days[days.length - 1] || { total: 0, kinds: {}, classes: {} };
    var kindsToday = today.kinds || {};

    // stat cards — today's picture
    document.getElementById('traffic-stats').innerHTML =
      '<div class="stat"><div class="stat-n">' + (today.total || 0) + '</div><div class="stat-l">requests_today</div></div>' +
      '<div class="stat"><div class="stat-n">' + machineCount(today) + '</div><div class="stat-l">machine_callers_today</div></div>' +
      '<div class="stat"><div class="stat-n">' + (kindsToday.mcp_request || 0) + '</div><div class="stat-l">mcp_calls_today</div></div>' +
      '<div class="stat"><div class="stat-n">' + (kindsToday.manifest_fetch || 0) + '</div><div class="stat-l">agent.json_fetches_today</div></div>';

    // 14-day chart: stacked machine (accent) over human (gray)
    var last14 = days.slice(-14);
    var max = last14.reduce(function (m, d) { return Math.max(m, d.total || 0); }, 1);
    var chart = document.getElementById('traffic-chart');
    var axis = document.getElementById('traffic-chart-x');
    chart.innerHTML = last14.map(function (d) {
      var m = machineCount(d);
      var h = Math.max(0, (d.total || 0) - m);
      var mh = Math.round((m / max) * 130);
      var hh = Math.round((h / max) * 130);
      return '<div class="cbar" title="' + esc(d.date) + ': ' + (d.total || 0) + ' total, ' + m + ' machine">' +
        '<div class="seg seg-m" style="height:' + mh + 'px"></div>' +
        '<div class="seg seg-h" style="height:' + hh + 'px"></div>' +
        '</div>';
    }).join('');
    axis.innerHTML = last14.map(function (d) {
      return '<span>' + esc(d.date.slice(8)) + '</span>';
    }).join('');

    // 30-day class totals
    var classTotals = {};
    days.forEach(function (d) {
      var c = d.classes || {};
      Object.keys(c).forEach(function (k) { classTotals[k] = (classTotals[k] || 0) + c[k]; });
    });
    var classKeys = Object.keys(classTotals).sort(function (a, b) { return classTotals[b] - classTotals[a]; });
    document.getElementById('class-rows').innerHTML = classKeys.length
      ? classKeys.map(function (k) {
          return '<tr><td>' + esc(CLASS_LABELS[k] || k) + '</td><td class="machine">' + classTotals[k] + '</td></tr>';
        }).join('')
      : '<tr><td colspan="2" class="muted">No traffic recorded yet.</td></tr>';

    // top user agents from recent machine events
    var events = data.events || [];
    var uaCounts = {};
    events.forEach(function (e) {
      var key = (e.client || e.ua || 'unknown').slice(0, 80);
      if (!uaCounts[key]) uaCounts[key] = { n: 0, cls: e.ua_class || 'unknown' };
      uaCounts[key].n += 1;
    });
    var uaKeys = Object.keys(uaCounts).sort(function (a, b) { return uaCounts[b].n - uaCounts[a].n; }).slice(0, 8);
    document.getElementById('ua-rows').innerHTML = uaKeys.length
      ? uaKeys.map(function (k) {
          return '<tr><td class="machine small" style="word-break:break-all">' + esc(k) + '</td>' +
            '<td><span class="pill">' + esc(uaCounts[k].cls) + '</span></td>' +
            '<td class="machine">' + uaCounts[k].n + '</td></tr>';
        }).join('')
      : '<tr><td colspan="3" class="muted">No machine traffic yet.</td></tr>';

    // recent events feed
    document.getElementById('event-rows').innerHTML = events.length
      ? events.slice(0, 50).map(function (e) {
          var what = e.kind === 'mcp_request'
            ? (e.method || '') + (e.tool ? ' → ' + e.tool : '')
            : (e.method || '') + ' ' + (e.path || '');
          var caller = e.client || (e.requester && e.requester !== 'unspecified' ? e.requester : '') || '';
          return '<tr>' +
            '<td class="machine small">' + esc(fmtTime(e.ts)) + '</td>' +
            '<td><span class="pill pill-accent">' + esc(e.kind) + '</span></td>' +
            '<td class="machine small">' + esc(what) + '</td>' +
            '<td><span class="pill">' + esc(e.ua_class || '?') + '</span>' +
            (caller ? ' <span class="small muted">' + esc(caller) + '</span>' : '') + '</td>' +
            '</tr>';
        }).join('')
      : '<tr><td colspan="4" class="muted">No machine requests recorded yet — they appear here the moment an agent, script, or crawler calls the API, the MCP server, or fetches /agent.json.</td></tr>';

    document.getElementById('traffic-section').hidden = false;
    document.getElementById('traffic-unavailable').hidden = true;
  }

  function load() {
    // Blocklist first: row renders need blockedSet to label buttons right.
    window.HumanAPIStore.listBlocklist(adminKey).then(function (rb) {
      blockedSet = new Set(rb.ok ? rb.entries.map(function (e) { return e.ip_hash; }) : []);
      renderBlocklist(rb.ok ? rb.entries : []);
      loadData();
    });
  }

  function loadData() {
    window.HumanAPIStore.getAnalytics(adminKey).then(function (r) {
      if (r.ok) {
        renderTraffic(r.data);
      } else if (r.error === 'unavailable') {
        document.getElementById('traffic-section').hidden = true;
        document.getElementById('traffic-unavailable').hidden = false;
      }
      refreshMoveButtons();
    });
    window.HumanAPIStore.listMessages(adminKey).then(function (r) {
      if (r.ok) renderMessages(r.messages);
    });
    window.HumanAPIStore.listTasks(adminKey).then(function (r) {
      if (!r.ok && r.error === 'unauthorized') {
        sessionStorage.removeItem('human_api_admin_key');
        dashboard.hidden = true;
        keyForm.parentElement.hidden = false;
        keyError.textContent = 'That admin key was rejected by the API.';
        keyError.hidden = false;
        return;
      }
      keyForm.parentElement.hidden = true;
      dashboard.hidden = false;
      sourceNote.textContent = r.via === 'api'
        ? 'source: api · data/tasks.json'
        : 'source: localStorage (no server detected — start it with `node server.js`)';
      renderStats(r.tasks);

      // Rejected tasks are noise once handled — they live in Archive.
      var active = r.tasks.filter(function (t) { return t.status !== 'rejected'; });
      var archived = r.tasks.filter(function (t) { return t.status === 'rejected'; });

      renderRows(active, tbody,
        'No active tasks. Submit one from the <a href="/request">task form</a> or POST to <code>/api/v1/tasks</code>.');
      renderRows(archived, archiveBody, 'Nothing archived yet — rejected tasks land here.');

      document.getElementById('tasks-count').textContent = active.length ? String(active.length) : '';
      document.getElementById('archive-count').textContent = archived.length ? String(archived.length) : '';
      refreshMoveButtons();
    });
  }

  keyForm.addEventListener('submit', function (e) {
    e.preventDefault();
    adminKey = keyInput.value.trim();
    sessionStorage.setItem('human_api_admin_key', adminKey);
    load();
  });

  applyLayout();
  if (adminKey) load();
})();
