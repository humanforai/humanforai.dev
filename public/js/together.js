/*
 * /together — the shared human+agent workspace engine.
 *
 * One state object, three writers: the human at the keyboard (form
 * controls and contenteditable draft fields), the in-browser agent
 * (WebMCP tools in together-webmcp.js, which call the window.HFAI_TOGETHER
 * facade), and the operator side (live polling of /api/v1/tasks and the
 * message thread). Everything renders from state; state persists in
 * localStorage so a reload loses nothing.
 *
 * The one rule the page enforces: submission requires a standing human
 * approval of the exact draft revision being sent.
 */
(function () {
  'use strict';

  var LS_KEY = 'hfai_together_v1';
  var POLL_MS = 20000;
  var MAX_TRACKED = 6;

  var DRAFT_FIELDS = [
    'task_type', 'description', 'location_required', 'location_detail',
    'deadline', 'output_format', 'contact_email', 'requester',
  ];
  var TASK_TYPES = [
    'real_world_verification', 'product_or_app_testing', 'human_judgment_and_feedback',
    'data_collection', 'local_physical_task', 'ai_output_review',
    'prompt_and_workflow_testing', 'simulation_and_automation_testing',
    'accessibility_and_usability_check', 'decision_escalation', 'custom_human_in_the_loop',
  ];

  var state = load() || {
    goal: '',
    email: '',
    notes: [],                   // [{text, ts}] — human → agent
    draft: null,                 // {fields: {k: v}, provenance: {k: 'agent'|'human'}, rev: n}
    approval: { state: 'none' }, // none|requested|approved|rejected {note, rev, ts}
    feed: [],                    // [{actor, text, ts}]
    tasks: {},                   // task_id → last API payload
    taskOrder: [],
    thread: null,                // {message_id, url, token, data}
    agentSeen: false,
  };

  var waiters = []; // await_human: [{resolve, timer}]

  function load() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { return null; }
  }
  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
  }
  function $(id) { return document.getElementById(id); }
  function now() { return new Date().toISOString(); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function feed(actor, text) {
    state.feed.unshift({ actor: actor, text: text, ts: now() });
    if (state.feed.length > 80) state.feed.length = 80;
    save();
    renderFeed();
  }

  // Resolve every pending await_human with what just happened.
  function humanActed(event) {
    var snapshot = publicState();
    waiters.splice(0).forEach(function (w) {
      clearTimeout(w.timer);
      w.resolve({ event: event, workspace: snapshot });
    });
  }

  function agentPresent() {
    if (!state.agentSeen) {
      state.agentSeen = true;
      save();
    }
    var el = $('agent-presence');
    if (el) el.textContent = 'connected via WebMCP';
    var banner = $('mcp-banner');
    if (banner) banner.classList.add('on');
    var bt = $('mcp-banner-text');
    if (bt) bt.textContent = 'Your agent is here — it is using this page’s WebMCP tools.';
  }

  /* ── rendering ─────────────────────────────────────────────────── */

  function renderFeed() {
    var ul = $('feed');
    if (!ul) return;
    ul.innerHTML = state.feed.map(function (f) {
      var who = f.actor === 'human' ? 'you' : f.actor === 'agent' ? 'your agent' : f.actor === 'operator' ? 'operator' : 'page';
      return '<li class="f-' + esc(f.actor) + '"><span class="who">' + esc(who) +
        '<span class="ts">' + esc(f.ts.slice(11, 19)) + ' utc</span></span>' + esc(f.text) + '</li>';
    }).join('');
  }

  function renderDraft() {
    var box = $('draft');
    var stateChip = $('draft-state');
    if (!box) return;
    if (!state.draft || !Object.keys(state.draft.fields).length) {
      box.innerHTML = '<p class="small muted">No draft yet. Your agent writes here with <code>draft_task</code> — and you can edit any field it writes, right on the page.</p>';
      if (stateChip) stateChip.textContent = 'empty';
      return;
    }
    if (stateChip) {
      stateChip.textContent = 'rev ' + state.draft.rev +
        (state.approval.state === 'approved' ? ' · approved' :
         state.approval.state === 'requested' ? ' · awaiting your approval' :
         state.approval.state === 'rejected' ? ' · rejected' : '');
    }
    box.innerHTML = DRAFT_FIELDS.filter(function (k) { return state.draft.fields[k] !== undefined && state.draft.fields[k] !== ''; })
      .map(function (k) {
        var prov = state.draft.provenance[k] || 'agent';
        return '<div class="draft-field"><span class="k">' + esc(k) +
          '<span class="prov prov-' + prov + '">' + (prov === 'agent' ? 'written by your agent' : 'edited by you') + '</span></span>' +
          '<span class="v" contenteditable="plaintext-only" data-field="' + esc(k) + '">' + esc(String(state.draft.fields[k])) + '</span></div>';
      }).join('');
    box.querySelectorAll('.v[contenteditable]').forEach(function (el) {
      el.addEventListener('blur', function () {
        var k = el.getAttribute('data-field');
        var v = el.textContent.trim();
        if (String(state.draft.fields[k]) === v) return;
        state.draft.fields[k] = k === 'location_required' ? v === 'true' : v;
        state.draft.provenance[k] = 'human';
        state.draft.rev += 1;
        invalidateApproval('you edited ' + k);
        save();
        feed('human', 'edited draft field "' + k + '"');
        renderDraft();
        humanActed({ type: 'draft_edited', field: k, value: v });
      });
    });
  }

  function invalidateApproval(why) {
    if (state.approval.state === 'approved') {
      state.approval = { state: 'none' };
      feed('system', 'approval reset — ' + why + '. The draft changed, so the agent must ask again.');
    }
  }

  function renderApproval() {
    var bar = $('approval-bar');
    if (!bar) return;
    bar.hidden = state.approval.state !== 'requested';
  }

  function renderTasks() {
    var box = $('tasks');
    if (!box) return;
    if (!state.taskOrder.length) {
      box.innerHTML = '<p class="small muted">Approved and submitted tasks appear here with live status — including the moment a real human has <em>seen</em> them.</p>';
      return;
    }
    box.innerHTML = state.taskOrder.map(function (id) {
      var t = state.tasks[id] || {};
      var seen = t.seen_by_operator_at ? '👁 seen by the operator ' + esc(String(t.seen_by_operator_at).slice(0, 16)) + ' utc' : 'not yet seen';
      var eta = t.eta ? ' · eta ' + esc(String(t.eta).slice(0, 16)) : '';
      var status = t.status || 'submitted';
      var pill = status === 'delivered' ? 'pill-ok' : status === 'rejected' ? 'pill-bad' : '';
      return '<div class="task-card"><span class="tid">' + esc(id) + '</span>' +
        '<div class="trow"><span class="pill ' + pill + '">' + esc(status) + '</span>' + eta + '</div>' +
        '<div class="trow">' + seen + '</div>' +
        (t.operator_notes ? '<div class="trow">📝 ' + esc(String(t.operator_notes).slice(0, 400)) + '</div>' : '') +
        (t.receipt ? '<div class="trow">🧾 signed receipt attached</div>' : '') +
        '</div>';
    }).join('');
  }

  function renderThread() {
    var box = $('thread');
    var follow = $('thread-followup');
    if (!box) return;
    if (!state.thread) {
      box.innerHTML = '<p class="small muted">Questions before committing? You or your agent can open a message thread with the operator (<code>message_operator</code>) — replies land right here.</p>';
      if (follow) follow.hidden = true;
      return;
    }
    if (follow) follow.hidden = false;
    var d = state.thread.data || {};
    var items = [{ author: 'you', message: d.message || state.thread.first || '', created_at: d.created_at || '' }]
      .concat((d.replies || []).map(function (r) {
        return { author: r.author === 'operator' ? 'operator' : 'you', message: r.message, created_at: r.created_at };
      }));
    box.innerHTML = items.map(function (m) {
      return '<div class="thread-msg t-' + (m.author === 'operator' ? 'operator' : 'requester') + '">' +
        '<span class="who">' + esc(m.author) + (m.created_at ? ' · ' + esc(String(m.created_at).slice(0, 16)) + ' utc' : '') + '</span>' +
        esc(m.message) + '</div>';
    }).join('');
  }

  function renderAll() {
    renderFeed(); renderDraft(); renderApproval(); renderTasks(); renderThread();
    var g = $('goal'); if (g && g.value !== state.goal) g.value = state.goal;
    var e = $('you-email'); if (e && e.value !== state.email) e.value = state.email;
  }

  /* ── operator-side polling ─────────────────────────────────────── */

  var pollTimer = null;
  function pollSoon(delay) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, delay == null ? POLL_MS : delay);
  }

  function poll() {
    var jobs = state.taskOrder.slice(0, MAX_TRACKED).map(function (id) {
      return fetch('/api/v1/tasks/' + encodeURIComponent(id))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.task_id) {
            var prev = state.tasks[id] || {};
            if (prev.status !== data.status && prev.status) {
              feed('operator', 'task ' + id + ' moved: ' + prev.status + ' → ' + data.status);
            }
            if (!prev.seen_by_operator_at && data.seen_by_operator_at) {
              feed('operator', 'a human has seen task ' + id);
            }
            state.tasks[id] = data;
          }
        }).catch(function () {});
    });
    if (state.thread) {
      jobs.push(fetch(state.thread.url + '?token=' + encodeURIComponent(state.thread.token))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.message_id) {
            var before = ((state.thread.data || {}).replies || []).filter(function (r) { return r.author === 'operator'; }).length;
            var after = (data.replies || []).filter(function (r) { return r.author === 'operator'; }).length;
            if (after > before) feed('operator', 'the operator replied in the thread');
            state.thread.data = data;
          }
        }).catch(function () {}));
    }
    Promise.all(jobs).then(function () { save(); renderTasks(); renderThread(); pollSoon(); });
  }

  /* ── the facade the WebMCP layer calls ─────────────────────────── */

  function publicState() {
    return {
      goal: state.goal || null,
      human_email_on_file: !!state.email,
      notes_from_human: state.notes.slice(0, 10),
      draft: state.draft ? { fields: state.draft.fields, provenance: state.draft.provenance, rev: state.draft.rev } : null,
      approval: state.approval,
      tracked_tasks: state.taskOrder.map(function (id) {
        var t = state.tasks[id] || {};
        return { task_id: id, status: t.status || 'submitted', seen_by_operator_at: t.seen_by_operator_at || null, eta: t.eta || null };
      }),
      operator_thread: state.thread ? {
        message_id: state.thread.message_id,
        status: (state.thread.data || {}).status || 'received',
        reply_count: ((state.thread.data || {}).replies || []).length,
        replies: ((state.thread.data || {}).replies || []),
      } : null,
      valid_task_types: TASK_TYPES,
      rules: 'submit_approved_task only works while approval.state is "approved" for the current draft rev. ' +
        'Any draft change resets approval. The human sees everything you write here, live.',
    };
  }

  window.HFAI_TOGETHER = {
    agentPresent: agentPresent,

    getState: publicState,

    applyDraft: function (fields) {
      var applied = [], rejected = [];
      if (!state.draft) state.draft = { fields: {}, provenance: {}, rev: 0 };
      Object.keys(fields || {}).forEach(function (k) {
        if (DRAFT_FIELDS.indexOf(k) === -1) { rejected.push(k); return; }
        if (k === 'task_type' && TASK_TYPES.indexOf(String(fields[k])) === -1) { rejected.push(k + ' (invalid value)'); return; }
        state.draft.fields[k] = fields[k];
        state.draft.provenance[k] = 'agent';
        applied.push(k);
      });
      if (applied.length) {
        state.draft.rev += 1;
        invalidateApproval('the agent revised the draft');
        feed('agent', 'drafted ' + applied.join(', '));
        save(); renderDraft(); renderApproval();
      }
      return { applied: applied, rejected: rejected, draft_rev: state.draft.rev, valid_fields: DRAFT_FIELDS };
    },

    requestApproval: function (messageToHuman) {
      if (!state.draft || !state.draft.fields.description) {
        return { error: 'nothing_to_approve', message: 'Draft a task first with draft_task (description is required).' };
      }
      state.approval = { state: 'requested', rev: state.draft.rev, ts: now(), agent_message: String(messageToHuman || '').slice(0, 500) };
      feed('agent', 'requested your approval' + (messageToHuman ? ': "' + String(messageToHuman).slice(0, 120) + '"' : ''));
      save(); renderApproval(); renderDraft();
      return {
        status: 'approval_requested',
        draft_rev: state.draft.rev,
        message: 'The human sees an approval bar now. Call await_human to wait for their decision, or poll read_workspace.',
      };
    },

    awaitHuman: function (timeoutSeconds) {
      var t = Math.max(5, Math.min(240, Number(timeoutSeconds) || 60));
      return new Promise(function (resolve) {
        var timer = setTimeout(function () {
          var i = waiters.findIndex(function (w) { return w.resolve === resolve; });
          if (i !== -1) waiters.splice(i, 1);
          resolve({ event: { type: 'timeout', waited_seconds: t }, workspace: publicState() });
        }, t * 1000);
        waiters.push({ resolve: resolve, timer: timer });
      });
    },

    submitApproved: function () {
      if (!state.draft) return Promise.resolve({ error: 'no_draft', message: 'Nothing drafted yet.' });
      if (state.approval.state !== 'approved' || state.approval.rev !== state.draft.rev) {
        return Promise.resolve({
          error: 'not_approved',
          approval: state.approval,
          message: 'The human has not approved this draft revision. Call request_human_approval and wait for their click — that is the point of this page.',
        });
      }
      var payload = {};
      DRAFT_FIELDS.forEach(function (k) { if (state.draft.fields[k] !== undefined && state.draft.fields[k] !== '') payload[k] = state.draft.fields[k]; });
      if (!payload.contact_email && state.email) payload.contact_email = state.email;
      if (!payload.contact_email) payload.delivery = 'status_poll';
      payload.requester = payload.requester || 'together-workspace (human-approved)';
      payload.source = 'api';
      return fetch('/api/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (r) { return r.json().then(function (data) { return { http: r.status, data: data }; }); })
        .then(function (out) {
          if (out.data && out.data.task_id) {
            state.approval = { state: 'none' };
            state.taskOrder.unshift(out.data.task_id);
            state.tasks[out.data.task_id] = out.data;
            feed('agent', 'submitted approved task ' + out.data.task_id + ' to the operator');
            save(); renderTasks(); renderApproval(); renderDraft();
            pollSoon(3000);
          }
          return { http_status: out.http, response: out.data };
        });
    },

    trackTask: function (taskId) {
      var id = String(taskId || '').trim();
      var chain = Promise.resolve();
      if (id) {
        if (state.taskOrder.indexOf(id) === -1) state.taskOrder.unshift(id);
        state.taskOrder = state.taskOrder.slice(0, MAX_TRACKED);
        chain = fetch('/api/v1/tasks/' + encodeURIComponent(id))
          .then(function (r) { return r.json(); })
          .then(function (data) { if (data && data.task_id) state.tasks[id] = data; save(); renderTasks(); })
          .catch(function () {});
      }
      return chain.then(function () {
        return { tracked_tasks: state.taskOrder.map(function (tid) { return state.tasks[tid] || { task_id: tid }; }) };
      });
    },

    messageOperator: function (message, subject) {
      var text = String(message || '').trim();
      if (text.length < 5) return Promise.resolve({ error: 'validation_failed', message: 'message must be at least 5 characters.' });
      if (state.thread) {
        return fetch(state.thread.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, token: state.thread.token }),
        }).then(function (r) { return r.json(); }).then(function (data) {
          feed('agent', 'followed up in the operator thread');
          pollSoon(3000);
          return { thread: 'follow_up_added', response: data };
        });
      }
      if (!state.email) {
        return Promise.resolve({
          error: 'no_reply_address',
          message: 'The workspace has no human email yet. Ask your human to fill the "Your email" field in the You lane — the operator’s reply also lands in this page’s thread either way.',
        });
      }
      return fetch('/api/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          subject: String(subject || 'From the /together workspace').slice(0, 200),
          reply_to: state.email,
          from: 'together-workspace-agent',
          source: 'api',
        }),
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (data && data.message_id) {
          state.thread = { message_id: data.message_id, url: data.thread_url, token: data.access_token, first: text, data: null };
          feed('agent', 'opened a thread with the operator (' + data.message_id + ')');
          save(); renderThread();
          pollSoon(5000);
        }
        return { response: { message_id: data.message_id, created_at: data.created_at, note: 'Thread opened; replies render on the page and go to the human’s email.' } };
      });
    },
  };

  /* ── human-side wiring ─────────────────────────────────────────── */

  function wire() {
    var g = $('goal');
    if (g) {
      var goalTimer = null;
      g.addEventListener('input', function () {
        clearTimeout(goalTimer);
        goalTimer = setTimeout(function () {
          if (g.value.trim() === state.goal) return;
          state.goal = g.value.trim();
          save();
          feed('human', 'updated the goal');
          humanActed({ type: 'goal_updated', goal: state.goal });
        }, 900);
      });
    }
    var e = $('you-email');
    if (e) e.addEventListener('change', function () {
      state.email = e.value.trim(); save();
      feed('human', state.email ? 'set a delivery email' : 'cleared the delivery email');
    });
    var noteBtn = $('you-note-send');
    if (noteBtn) noteBtn.addEventListener('click', function () {
      var inp = $('you-note');
      var text = (inp.value || '').trim();
      if (!text) return;
      state.notes.unshift({ text: text, ts: now() });
      state.notes = state.notes.slice(0, 20);
      inp.value = '';
      save();
      feed('human', 'note to agent: "' + text.slice(0, 120) + '"');
      humanActed({ type: 'note_to_agent', note: text });
    });
    var ap = $('btn-approve');
    if (ap) ap.addEventListener('click', function () {
      var note = ($('approval-note').value || '').trim();
      state.approval = { state: 'approved', rev: state.draft ? state.draft.rev : 0, ts: now(), note: note };
      $('approval-note').value = '';
      save();
      feed('human', 'APPROVED the draft' + (note ? ' — "' + note.slice(0, 120) + '"' : ''));
      renderApproval(); renderDraft();
      humanActed({ type: 'approved', note: note });
    });
    var rj = $('btn-reject');
    if (rj) rj.addEventListener('click', function () {
      var note = ($('approval-note').value || '').trim();
      state.approval = { state: 'rejected', rev: state.draft ? state.draft.rev : 0, ts: now(), note: note };
      $('approval-note').value = '';
      save();
      feed('human', 'rejected the draft' + (note ? ' — "' + note.slice(0, 120) + '"' : ''));
      renderApproval(); renderDraft();
      humanActed({ type: 'rejected', note: note });
    });
    var tr = $('track-add');
    if (tr) tr.addEventListener('click', function () {
      var id = ($('track-id').value || '').trim();
      if (!id) return;
      $('track-id').value = '';
      feed('human', 'tracking task ' + id);
      window.HFAI_TOGETHER.trackTask(id);
    });
    var ts = $('thread-send');
    if (ts) ts.addEventListener('click', function () {
      var inp = $('thread-input');
      var text = (inp.value || '').trim();
      if (!text || !state.thread) return;
      inp.value = '';
      fetch(state.thread.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, token: state.thread.token }),
      }).then(function () {
        feed('human', 'wrote to the operator');
        pollSoon(3000);
      });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    wire();
    renderAll();
    if (!state.feed.length) feed('system', 'workspace ready — three seats, two occupied. Waiting for your agent.');
    var banner = $('mcp-banner');
    var hasMC = (typeof document.modelContext !== 'undefined' && document.modelContext) ||
                (typeof navigator.modelContext !== 'undefined' && navigator.modelContext);
    var bt = $('mcp-banner-text');
    if (bt) {
      bt.textContent = hasMC
        ? 'WebMCP detected — ask your agent to work with you on this page.'
        : 'No WebMCP in this browser. Open this page in the ChatGPT desktop app or Chrome with WebMCP enabled — or drive everything by hand.';
    }
    if (hasMC && banner) banner.classList.add('on');
    pollSoon(2000);
  });
})();
