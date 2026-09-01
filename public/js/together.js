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
  var OUTPUT_FORMATS = [
    'text_report', 'text_report_with_photos', 'structured_json',
    'annotated_screenshots', 'video',
  ];

  // The schemas the agent sees are advisory; this is the boundary. Used for
  // agent drafts, human edits, approval requests, and final submission alike.
  function validateField(k, v) {
    var s = String(v == null ? '' : v);
    switch (k) {
      case 'task_type':
        return TASK_TYPES.indexOf(s) === -1 ? 'must be one of the valid task types' : null;
      case 'description':
        if (s.trim().length < 10) return 'must be at least 10 characters';
        if (s.length > 5000) return 'must be at most 5000 characters';
        return null;
      case 'location_required':
        return (v === true || v === false || s === 'true' || s === 'false') ? null : 'must be true or false';
      case 'location_detail':
        return s.length > 500 ? 'must be at most 500 characters' : null;
      case 'deadline':
        return isNaN(Date.parse(s)) ? 'must be an ISO 8601 datetime' : null;
      case 'output_format':
        return OUTPUT_FORMATS.indexOf(s) === -1 ? 'must be one of: ' + OUTPUT_FORMATS.join(', ') : null;
      case 'contact_email':
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? null : 'must be a valid email address';
      case 'requester':
        return s.length > 200 ? 'must be at most 200 characters' : null;
    }
    return null;
  }

  function validateDraft(draft) {
    if (!draft || !draft.fields) return ['no draft'];
    var problems = [];
    if (!draft.fields.description) problems.push('description: required');
    Object.keys(draft.fields).forEach(function (k) {
      var v = draft.fields[k];
      if (v === undefined || v === '') return;
      var why = validateField(k, v);
      if (why) problems.push(k + ': ' + why);
    });
    var locReq = draft.fields.location_required;
    if ((locReq === true || locReq === 'true') && !draft.fields.location_detail) {
      problems.push('location_detail: required when location_required is true');
    }
    return problems;
  }

  var state = load() || {
    goal: '',
    email: '',
    notes: [],                   // [{text, ts}] — human → agent
    draft: null,                 // {fields: {k: v}, provenance: {k: 'agent'|'human'}, rev: n}
    approval: { state: 'none' }, // none|requested|approved|rejected {note, rev, ts}
    autopilot: { enabled: false }, // standing approval: {enabled, scope, granted_at}
    feed: [],                    // [{actor, text, ts}]
    tasks: {},                   // task_id → last API payload
    taskOrder: [],
    thread: null,                // {message_id, url, token, data}
    agentSeen: false,
  };

  if (!state.autopilot) state.autopilot = { enabled: false }; // pre-autopilot saved states
  // Legacy autopilot grants had no expiry or budget — a standing authority
  // with no bounds. Retire them; the human can re-grant with limits.
  if (state.autopilot.enabled && !state.autopilot.expires_at) state.autopilot = { enabled: false };

  var waiters = [];       // await_human: [{resolve, timer}]
  var pendingEvents = []; // human acts that happened while no await_human was listening
  var submitInFlight = false;
  // Simulation mode (together-sim.js): a scripted agent drives the real tool
  // objects. Everything it writes is labeled "simulated"; nothing leaves the
  // browser. Not persisted — a reload ends any simulation.
  var simMode = false;
  var agentBusyTimer = null;
  var agentBusy = false;

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
    var entry = { actor: actor, text: text, ts: now() };
    if (simMode && actor === 'agent') entry.sim = true;
    state.feed.unshift(entry);
    if (state.feed.length > 80) state.feed.length = 80;
    save();
    renderFeed();
  }

  // Short-lived "agent working" signal for the lane pulse: every real tool
  // call (and every simulated step) lights the agent lane for a moment.
  function markAgentBusy(ms) {
    agentBusy = true;
    clearTimeout(agentBusyTimer);
    agentBusyTimer = setTimeout(function () { agentBusy = false; renderTurn(); }, ms || 2500);
    renderTurn();
  }

  // Resolve every pending await_human with what just happened. If no one is
  // waiting yet, queue the event so an await_human that starts a moment later
  // doesn't miss it (the approve-before-await race).
  function humanActed(event) {
    if (!waiters.length) {
      pendingEvents.push(event);
      if (pendingEvents.length > 5) pendingEvents.shift();
      return;
    }
    var snapshot = publicState();
    waiters.splice(0).forEach(function (w) {
      clearTimeout(w.timer);
      w.resolve({ event: event, workspace: snapshot });
    });
  }

  // DOM-only on purpose: read_workspace is annotated read-only, so the
  // presence signal must not mutate persisted workspace state.
  function agentPresent() {
    markAgentBusy();
    var el = $('agent-presence');
    var banner = $('mcp-banner');
    var bt = $('mcp-banner-text');
    if (simMode) {
      if (el) el.textContent = 'SIMULATED agent — scripted, not WebMCP';
      if (bt) bt.textContent = 'Simulation running — a scripted agent is driving this page’s real tool objects. Nothing is sent to the operator.';
      return;
    }
    if (el) el.textContent = 'connected via WebMCP';
    if (banner) banner.classList.add('on');
    if (bt) bt.textContent = 'Your agent is here — it is using this page’s WebMCP tools.';
  }

  /* ── rendering ─────────────────────────────────────────────────── */

  function renderFeed() {
    var ul = $('feed');
    if (!ul) return;
    ul.innerHTML = state.feed.map(function (f) {
      var who = f.sim && f.actor === 'agent' ? 'simulated agent'
        : f.actor === 'human' ? 'you' : f.actor === 'agent' ? 'your agent'
        : f.actor === 'operator' ? 'operator' : f.actor === 'sim' ? 'simulation' : 'page';
      return '<li class="f-' + esc(f.actor) + (f.sim ? ' f-sim' : '') + '"><span class="who">' + esc(who) +
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
        (state.autopilot.enabled ? ' · autopilot' :
         state.approval.state === 'approved' ? ' · approved' :
         state.approval.state === 'requested' ? ' · awaiting your approval' :
         state.approval.state === 'rejected' ? ' · rejected' : '');
    }
    box.innerHTML = DRAFT_FIELDS.filter(function (k) { return state.draft.fields[k] !== undefined && state.draft.fields[k] !== ''; })
      .map(function (k) {
        var prov = state.draft.provenance[k] || 'agent';
        return '<div class="draft-field"><span class="k">' + esc(k) +
          '<span class="prov prov-' + prov + '">' + (prov === 'agent' ? 'written by your agent' : 'edited by you') + '</span></span>' +
          '<span class="v" contenteditable="plaintext-only" role="textbox" aria-label="Draft field ' + esc(k) +
          ', last ' + (prov === 'agent' ? 'written by your agent' : 'edited by you') + '. Press Enter to save your edit." data-field="' + esc(k) + '">' +
          esc(String(state.draft.fields[k])) + '</span></div>';
      }).join('');
    box.querySelectorAll('.v[contenteditable]').forEach(function (el) {
      el.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && el.getAttribute('data-field') !== 'description') { ev.preventDefault(); el.blur(); }
      });
      el.addEventListener('blur', function () {
        var k = el.getAttribute('data-field');
        var v = el.textContent.trim();
        if (String(state.draft.fields[k]) === v) return;
        if (v !== '') {
          var why = validateField(k, v);
          if (why) {
            feed('system', 'your edit to "' + k + '" was not applied — ' + why + '.');
            renderDraft();
            return;
          }
        }
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

  // Any draft mutation kills BOTH standing approvals and open requests: the
  // human must never be able to click Approve on a revision other than the
  // one the bar was raised for.
  function invalidateApproval(why) {
    if (state.approval.state === 'approved' || state.approval.state === 'requested') {
      var was = state.approval.state;
      state.approval = { state: 'none' };
      feed('system', was === 'approved'
        ? 'approval reset — ' + why + '. The draft changed, so the agent must ask again.'
        : 'approval request withdrawn — ' + why + '. The draft changed under the open request; the agent must ask again for the new revision.');
      renderApproval();
    }
  }

  // The single authority check for autopilot. Expired or exhausted grants
  // are retired on the spot — never silently honored.
  function autopilotActive() {
    var a = state.autopilot;
    if (!a.enabled) return false;
    if (a.expires_at && Date.parse(a.expires_at) <= Date.now()) {
      state.autopilot = { enabled: false };
      feed('system', 'autopilot expired — submissions need your click again.');
      save(); renderApproval();
      return false;
    }
    if ((a.used || 0) >= (a.max_tasks || 1)) {
      state.autopilot = { enabled: false };
      feed('system', 'autopilot used its full budget of ' + (a.max_tasks || 1) + ' task(s) — submissions need your click again.');
      save(); renderApproval();
      return false;
    }
    return true;
  }

  function renderApproval() {
    var onAutopilot = state.autopilot.enabled;
    var bar = $('approval-bar');
    if (!bar) return;
    var stale = state.approval.state === 'requested' &&
      (!state.draft || state.approval.rev !== state.draft.rev);
    bar.hidden = onAutopilot || state.approval.state !== 'requested' || stale;
    var revLine = $('approval-rev');
    if (revLine && !bar.hidden) {
      revLine.textContent = 'approving draft rev ' + state.approval.rev +
        ' — exactly the fields shown in the middle lane right now';
    }
    var box = $('autopilot-box');
    if (box) box.classList.toggle('on', onAutopilot);
    var chip = $('autopilot-state');
    if (chip) {
      if (onAutopilot) {
        var a = state.autopilot;
        var left = Math.max(0, (a.max_tasks || 1) - (a.used || 0));
        chip.textContent = 'ON — ' + left + ' of ' + (a.max_tasks || 1) + ' submission' + ((a.max_tasks || 1) === 1 ? '' : 's') + ' left · expires ' +
          (a.expires_at ? String(a.expires_at).slice(11, 16) + ' utc' : 'never') +
          (state.email ? ' · delivers to your email' : ' · no email — status-poll delivery');
      } else {
        chip.textContent = 'off — every submit needs your click';
      }
    }
    renderTurn();
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
      return '<div class="task-card' + (t.simulated ? ' task-sim' : '') + '"><span class="tid">' + esc(id) + '</span>' +
        (t.simulated ? '<span class="sim-badge">SIMULATED — not a real task</span>' +
          '<button type="button" class="sim-dismiss" data-sim-dismiss="' + esc(id) + '" aria-label="Remove simulated task ' + esc(id) + '">dismiss</button>' : '') +
        '<div class="trow"><span class="pill ' + pill + '">' + esc(status) + '</span>' + eta + '</div>' +
        '<div class="trow">' + seen + '</div>' +
        (t.operator_notes ? '<div class="trow">📝 ' + esc(String(t.operator_notes).slice(0, 400)) + '</div>' : '') +
        (t.receipt ? '<div class="trow">🧾 signed receipt attached</div>' : '') +
        '</div>';
    }).join('');
    box.querySelectorAll('[data-sim-dismiss]').forEach(function (b) {
      b.addEventListener('click', function () { window.HFAI_TOGETHER.dismissSimulated(b.getAttribute('data-sim-dismiss')); });
    });
    renderTurn();
  }

  // Whose move is it? One pulse per lane, computed from state — the human's
  // lane when a decision or goal is needed, the agent's while it works or owes
  // the next step, the operator's while a task is live.
  function setTurn(laneId, chipId, on, label) {
    var lane = $(laneId);
    var chip = $(chipId);
    if (lane) lane.classList.toggle('turn', !!on);
    if (chip) { chip.hidden = !on; chip.textContent = label || ''; }
  }
  function renderTurn() {
    var hasDraft = !!(state.draft && state.draft.fields && state.draft.fields.description);
    var reqOpen = state.approval.state === 'requested' && state.draft && state.approval.rev === state.draft.rev;
    var live = state.taskOrder.some(function (id) {
      var s = (state.tasks[id] || {}).status || 'submitted';
      return s !== 'delivered' && s !== 'rejected';
    });
    var you = reqOpen || (!state.goal && !hasDraft);
    var agentReason = agentBusy ? 'working'
      : state.approval.state === 'approved' ? 'submit'
      : state.approval.state === 'rejected' ? 'revise'
      : (state.goal && !hasDraft) ? 'draft'
      : (state.autopilot.enabled && hasDraft && state.lastSubmittedRev !== state.draft.rev) ? 'submit'
      : null;
    setTurn('lane-you', 'turn-you', you, reqOpen ? 'your move — approve or reject' : 'your move — set a goal');
    setTurn('lane-agent', 'turn-agent', !!agentReason && !(you && !agentBusy),
      agentReason === 'working' ? 'agent working…' : 'agent’s move — ' + agentReason);
    setTurn('lane-operator', 'turn-operator', live, 'operator’s move — task live');
  }

  /* ── tool-call inspector ───────────────────────────────────────── */

  // Every tool call — from a real WebMCP agent or the simulator — is logged
  // with its exact arguments and result, so the protocol is visible in any
  // browser. Fed by the hfai:tool event from together-webmcp.js.
  var toolCalls = 0;
  function logToolCall(d) {
    var ol = $('tool-log');
    if (!ol) return;
    toolCalls += 1;
    var count = $('tool-count');
    if (count) count.textContent = toolCalls + ' call' + (toolCalls === 1 ? '' : 's');
    var details = $('tool-console');
    if (details && toolCalls === 1) details.open = true;
    var trunc = function (v) {
      var s = JSON.stringify(v == null ? null : v, null, 1);
      return s.length > 1600 ? s.slice(0, 1600) + '\n… (' + (s.length - 1600) + ' more chars)' : s;
    };
    var li = document.createElement('li');
    li.className = d.simulated ? 'tc tc-sim' : 'tc';
    li.innerHTML = '<span class="tc-head"><span class="tc-name">' + esc(d.name) + '</span>' +
      (d.simulated ? '<span class="sim-badge">simulated</span>' : '') +
      '<span class="ts">' + esc(now().slice(11, 19)) + ' utc · ' + esc(String(d.ms)) + ' ms</span></span>' +
      '<pre class="tc-io"><span class="tc-dir">→ args</span>\n' + esc(trunc(d.args)) + '</pre>' +
      '<pre class="tc-io"><span class="tc-dir">← result</span>\n' + esc(trunc(d.result)) + '</pre>';
    ol.insertBefore(li, ol.firstChild);
    while (ol.children.length > 40) ol.removeChild(ol.lastChild);
  }
  document.addEventListener('hfai:tool', function (e) { logToolCall(e.detail || {}); });

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
    var a = $('autopilot-toggle'); if (a) a.checked = !!state.autopilot.enabled;
    var s = $('autopilot-scope'); if (s && state.autopilot.scope && !s.value) s.value = state.autopilot.scope;
    renderTurn();
  }

  /* ── operator-side polling ─────────────────────────────────────── */

  var pollTimer = null;
  function pollSoon(delay) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, delay == null ? POLL_MS : delay);
  }

  function poll() {
    var jobs = state.taskOrder.slice(0, MAX_TRACKED).filter(function (id) {
      return !(state.tasks[id] && state.tasks[id].simulated); // never hits the API
    }).map(function (id) {
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
    Promise.all(jobs).then(function () { autopilotActive(); save(); renderTasks(); renderThread(); pollSoon(); });
  }

  /* ── the facade the WebMCP layer calls ─────────────────────────── */

  function publicState() {
    return {
      goal: state.goal || null,
      human_email_on_file: !!state.email,
      notes_from_human: state.notes.slice(0, 10),
      draft: state.draft ? { fields: state.draft.fields, provenance: state.draft.provenance, rev: state.draft.rev } : null,
      approval: state.approval,
      autopilot: state.autopilot,
      tracked_tasks: state.taskOrder.map(function (id) {
        var t = state.tasks[id] || {};
        var row = { task_id: id, status: t.status || 'submitted', seen_by_operator_at: t.seen_by_operator_at || null, eta: t.eta || null };
        if (t.simulated) row.simulated = true; // a demo card, not a real task
        return row;
      }),
      operator_thread: state.thread ? {
        message_id: state.thread.message_id,
        status: (state.thread.data || {}).status || 'received',
        reply_count: ((state.thread.data || {}).replies || []).length,
        replies: ((state.thread.data || {}).replies || []),
      } : null,
      valid_task_types: TASK_TYPES,
      valid_output_formats: OUTPUT_FORMATS,
      rules: state.autopilot.enabled
        ? 'AUTOPILOT is ON: the human granted you bounded standing approval' +
          (state.autopilot.scope ? ' — scope: "' + state.autopilot.scope + '"' : '') +
          '. Budget: ' + Math.max(0, (state.autopilot.max_tasks || 1) - (state.autopilot.used || 0)) + ' submission(s) left, expires ' + state.autopilot.expires_at +
          '. Delivery goes to the human\'s own email (or status polling) — an agent-set contact_email is ignored under autopilot. ' +
          'Each draft revision can be submitted once. Stay inside the scope and the goal; the human sees everything live and can revoke at any moment.'
        : 'submit_approved_task only works while approval.state is "approved" for the current draft rev. ' +
          'Any draft change resets approval — including an open approval request. The human sees everything you write here, live — and can grant ' +
          'bounded autopilot (standing approval with a task budget and expiry) with the toggle in their lane.',
    };
  }

  // The one gate in front of submission, shared by the real submit and the
  // simulator: a per-task approval of this exact revision, or live autopilot
  // with budget left. Returns {viaAutopilot} or a structured refusal.
  function submitAuthority() {
    if (!state.draft) return { error: 'no_draft', message: 'Nothing drafted yet.' };
    if (submitInFlight) {
      return { error: 'submission_in_flight', message: 'A submission is already in progress — wait for it to return before submitting again.' };
    }
    var viaAutopilot = autopilotActive();
    if (!viaAutopilot && (state.approval.state !== 'approved' || state.approval.rev !== state.draft.rev)) {
      return {
        error: 'not_approved',
        approval: state.approval,
        autopilot: state.autopilot,
        message: 'The human has not approved this draft revision. Call request_human_approval and wait for their click — or the human can grant bounded Autopilot in their lane.',
      };
    }
    var problems = validateDraft(state.draft);
    if (problems.length) {
      return { error: 'invalid_draft', problems: problems, message: 'The draft is not valid — fix these fields with draft_task, then get approval again.' };
    }
    if (viaAutopilot && state.lastSubmittedRev === state.draft.rev) {
      return { error: 'already_submitted', message: 'This exact draft revision was already submitted. Revise the draft (a new revision) before submitting another task.' };
    }
    return { viaAutopilot: viaAutopilot };
  }

  window.HFAI_TOGETHER = {
    agentPresent: agentPresent,

    getState: function () { autopilotActive(); return publicState(); },

    /* ── simulation-only surface (together-sim.js) ───────────────── */

    isSimulating: function () { return simMode; },

    setSimMode: function (on) {
      simMode = !!on;
      var el = $('agent-presence');
      var banner = $('mcp-banner');
      if (simMode) {
        if (banner) banner.classList.add('sim');
        agentPresent();
      } else {
        if (banner) banner.classList.remove('sim');
        agentBusy = false; clearTimeout(agentBusyTimer);
        if (el) el.textContent = window.__hfaiToolReport && window.__hfaiToolReport.ok ? 'connected via WebMCP' : 'not connected yet';
        renderTurn();
      }
    },

    // The simulator narrates in the feed under its own actor, never as "you".
    simNarrate: function (text) { feed('sim', String(text || '')); },

    // The simulator fills a sample goal when the page has none — attributed
    // to the simulation, not the human, and it does not fire a human event.
    setGoal: function (text) {
      state.goal = String(text || '').trim();
      var g = $('goal'); if (g) g.value = state.goal;
      save(); renderTurn();
    },

    // Same gate as the real submit (approval consumed, autopilot budget
    // spent, revision recorded) — but no request leaves the browser: a card
    // marked SIMULATED lands on the operator board instead.
    simulateSubmission: function () {
      var started = Date.now();
      var auth = submitAuthority();
      var result;
      if (auth.error) {
        result = auth;
      } else {
        var id = 'SIM-' + Date.now().toString(36).toUpperCase();
        var f = state.draft.fields;
        state.approval = { state: 'none' };
        state.lastSubmittedRev = state.draft.rev;
        if (auth.viaAutopilot) state.autopilot.used = (state.autopilot.used || 0) + 1;
        state.taskOrder.unshift(id);
        state.taskOrder = state.taskOrder.slice(0, MAX_TRACKED);
        state.tasks[id] = {
          task_id: id, simulated: true, status: 'submitted', created_at: now(),
          task_type: f.task_type, description: f.description,
          status_history: [{ status: 'submitted', at: now() }],
        };
        feed('agent', 'submitted SIMULATED task ' + id + (auth.viaAutopilot ? ' on autopilot' : ' with your approval') + ' — nothing was sent to the operator');
        save(); renderTasks(); renderApproval(); renderDraft();
        result = { simulated: true, http_status: 201, response: { task_id: id, status: 'submitted', message: 'Simulated — no request left the browser. A real submit_approved_task would POST /api/v1/tasks here.' } };
      }
      document.dispatchEvent(new CustomEvent('hfai:tool', { detail: { name: 'submit_approved_task', args: {}, result: result, ms: Date.now() - started, simulated: true } }));
      markAgentBusy();
      return result;
    },

    // Advance a simulated task through the operator lifecycle. Refuses to
    // touch anything that is not marked simulated.
    simAdvance: function (id, patch) {
      var t = state.tasks[id];
      if (!t || !t.simulated) return false;
      Object.keys(patch || {}).forEach(function (k) { t[k] = patch[k]; });
      if (patch && patch.status) {
        t.status_history = (t.status_history || []).concat([{ status: patch.status, at: now() }]);
        feed('operator', '(simulated) task ' + id + ' moved to ' + patch.status);
      }
      if (patch && patch.seen_by_operator_at) feed('operator', '(simulated) a human has seen task ' + id);
      save(); renderTasks();
      return true;
    },

    dismissSimulated: function (id) {
      if (!state.tasks[id] || !state.tasks[id].simulated) return;
      delete state.tasks[id];
      state.taskOrder = state.taskOrder.filter(function (x) { return x !== id; });
      save(); renderTasks();
    },

    applyDraft: function (fields) {
      var applied = [], rejected = [];
      if (!state.draft) state.draft = { fields: {}, provenance: {}, rev: 0 };
      Object.keys(fields || {}).forEach(function (k) {
        if (DRAFT_FIELDS.indexOf(k) === -1) { rejected.push(k + ' (unknown field)'); return; }
        var why = validateField(k, fields[k]);
        if (why) { rejected.push(k + ' (' + why + ')'); return; }
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
      var problems = validateDraft(state.draft);
      if (problems.length) {
        return { error: 'invalid_draft', problems: problems, message: 'The draft is not valid yet — fix these fields with draft_task before asking for approval.' };
      }
      if (autopilotActive()) {
        return {
          status: 'not_needed',
          autopilot: state.autopilot,
          message: 'Autopilot is on — the human already granted standing approval. Call submit_approved_task directly.',
        };
      }
      state.approval = { state: 'requested', rev: state.draft.rev, ts: now(), agent_message: String(messageToHuman || '').slice(0, 500) };
      feed('agent', 'requested your approval' + (messageToHuman ? ': "' + String(messageToHuman).slice(0, 120) + '"' : ''));
      save(); renderApproval(); renderDraft();
      // Bring the human to the decision: scroll, focus, and announce it.
      var bar = $('approval-bar');
      if (bar && !bar.hidden) {
        bar.scrollIntoView({ behavior: 'smooth', block: 'center' });
        bar.focus({ preventScroll: true });
      }
      var sr = $('sr-announce');
      if (sr) sr.textContent = 'Your agent requests approval for draft revision ' + state.draft.rev + '. The approval controls are below the draft.';
      return {
        status: 'approval_requested',
        draft_rev: state.draft.rev,
        message: 'The human sees an approval bar now. Call await_human to wait for their decision, or poll read_workspace.',
      };
    },

    awaitHuman: function (timeoutSeconds) {
      // The human may have acted between the agent's last read and this call —
      // deliver the queued event instead of blocking past it.
      if (pendingEvents.length) {
        var missed = pendingEvents.shift();
        return Promise.resolve({ event: missed, workspace: publicState() });
      }
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
      var auth = submitAuthority();
      if (auth.error) return Promise.resolve(auth);
      var viaAutopilot = auth.viaAutopilot;
      var payload = {};
      DRAFT_FIELDS.forEach(function (k) { if (state.draft.fields[k] !== undefined && state.draft.fields[k] !== '') payload[k] = state.draft.fields[k]; });
      // Delivery destination is human-controlled: the email in the You lane
      // always wins. Under autopilot an agent-set contact_email is never
      // honored — without a human email, delivery falls back to status polling.
      if (state.email) payload.contact_email = state.email;
      else if (viaAutopilot) { delete payload.contact_email; payload.delivery = 'status_poll'; }
      else if (!payload.contact_email) payload.delivery = 'status_poll';
      payload.requester = payload.requester || (viaAutopilot ? 'together-workspace (autopilot)' : 'together-workspace (human-approved)');
      payload.source = 'api';
      submitInFlight = true;
      return fetch('/api/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(function (r) { return r.json().then(function (data) { return { http: r.status, ok: r.ok, data: data }; }); })
        .then(function (out) {
          submitInFlight = false;
          if (out.ok && out.data && out.data.task_id) {
            state.approval = { state: 'none' };
            state.lastSubmittedRev = state.draft.rev;
            if (viaAutopilot) state.autopilot.used = (state.autopilot.used || 0) + 1;
            state.taskOrder.unshift(out.data.task_id);
            state.tasks[out.data.task_id] = out.data;
            feed('agent', viaAutopilot
              ? 'submitted task ' + out.data.task_id + ' on autopilot (' + Math.max(0, (state.autopilot.max_tasks || 1) - state.autopilot.used) + ' left in the budget)'
              : 'submitted approved task ' + out.data.task_id + ' to the operator');
            save(); renderTasks(); renderApproval(); renderDraft();
            pollSoon(3000);
          } else {
            feed('system', 'submission failed (http ' + out.http + ') — no task was created. Approval was NOT consumed.');
          }
          return { http_status: out.http, response: out.data };
        })
        .catch(function (err) {
          submitInFlight = false;
          feed('system', 'submission failed (network error) — no task was created. Approval was NOT consumed.');
          return { error: 'network_error', message: String(err && err.message || err) };
        });
    },

    trackTask: function (taskId) {
      var id = String(taskId || '').trim();
      // Verify the task exists BEFORE it touches the board — an unknown ID
      // must come back as an error, never as a card that says "submitted".
      var chain = Promise.resolve(null);
      if (id) {
        chain = fetch('/api/v1/tasks/' + encodeURIComponent(id))
          .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, http: r.status, data: data }; }); })
          .then(function (out) {
            if (out.ok && out.data && out.data.task_id) {
              if (state.taskOrder.indexOf(id) === -1) state.taskOrder.unshift(id);
              state.taskOrder = state.taskOrder.slice(0, MAX_TRACKED);
              state.tasks[id] = out.data;
              save(); renderTasks();
              return null;
            }
            return {
              error: out.http === 404 ? 'task_not_found' : 'lookup_failed',
              http_status: out.http,
              message: out.http === 404
                ? 'No task with ID ' + id + ' exists. It was not added to the board.'
                : 'The status lookup for ' + id + ' failed (http ' + out.http + '). It was not added to the board.',
            };
          })
          .catch(function (err) {
            return { error: 'network_error', message: 'Could not reach the task API for ' + id + ' — it was not added to the board. ' + String(err && err.message || err) };
          });
      }
      return chain.then(function (problem) {
        var result = { tracked_tasks: state.taskOrder.map(function (tid) { return state.tasks[tid] || { task_id: tid }; }) };
        if (problem) {
          result.error = problem.error;
          result.http_status = problem.http_status;
          result.message = problem.message;
          result.task_id = id;
          feed('system', 'task ' + id + ' was not added to the board: ' + problem.error);
        }
        return result;
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
          renderTurn();
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
    var auto = $('autopilot-toggle');
    if (auto) auto.addEventListener('change', function () {
      if (auto.checked) {
        var scope = ($('autopilot-scope').value || '').trim();
        var maxTasks = Math.max(1, Math.min(10, parseInt(($('autopilot-max') || {}).value, 10) || 1));
        var minutes = Math.max(5, Math.min(1440, parseInt(($('autopilot-minutes') || {}).value, 10) || 60));
        state.autopilot = {
          enabled: true,
          scope: scope,
          granted_at: now(),
          expires_at: new Date(Date.now() + minutes * 60000).toISOString(),
          max_tasks: maxTasks,
          used: 0,
        };
        feed('human', 'granted AUTOPILOT — standing approval for ' + maxTasks + ' task(s), expires in ' + minutes + ' min' + (scope ? ' (scope: "' + scope.slice(0, 120) + '")' : ''));
        humanActed({ type: 'autopilot_granted', scope: scope });
      } else {
        state.autopilot = { enabled: false };
        feed('human', 'revoked autopilot — submissions need a per-task approval again');
        humanActed({ type: 'autopilot_revoked' });
      }
      save();
      renderApproval(); renderDraft();
    });
    var ap = $('btn-approve');
    if (ap) ap.addEventListener('click', function () {
      // The click binds to the rev the agent requested — never to whatever
      // the draft happens to be at click time. A mismatch means the request
      // is stale and the click is refused.
      if (state.approval.state !== 'requested' || !state.draft || state.approval.rev !== state.draft.rev) {
        feed('system', 'approve ignored — the request is stale (the draft changed since it was raised). The agent must ask again.');
        state.approval = { state: 'none' };
        save(); renderApproval(); renderDraft();
        return;
      }
      var note = ($('approval-note').value || '').trim();
      state.approval = { state: 'approved', rev: state.approval.rev, ts: now(), note: note };
      $('approval-note').value = '';
      save();
      feed('human', 'APPROVED draft rev ' + state.approval.rev + (note ? ' — "' + note.slice(0, 120) + '"' : ''));
      renderApproval(); renderDraft();
      humanActed({ type: 'approved', note: note });
    });
    var rj = $('btn-reject');
    if (rj) rj.addEventListener('click', function () {
      if (state.approval.state !== 'requested') return;
      var note = ($('approval-note').value || '').trim();
      state.approval = { state: 'rejected', rev: state.approval.rev, ts: now(), note: note };
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
    document.querySelectorAll('.goal-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var goal = chip.getAttribute('data-goal') || '';
        var g2 = $('goal');
        if (!g2) return;
        g2.value = goal;
        state.goal = goal;
        save();
        feed('human', 'picked a sample goal');
        humanActed({ type: 'goal_updated', goal: state.goal });
        g2.focus();
      });
    });
    var cp = $('copy-prompt');
    if (cp) cp.addEventListener('click', function () {
      var text = ($('agent-prompt') || {}).textContent || '';
      var done2 = function () { cp.textContent = 'copied'; setTimeout(function () { cp.textContent = 'copy'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done2, function () {});
    });
    var cw = $('clear-workspace');
    if (cw) cw.addEventListener('click', function () {
      if (!window.confirm('Clear this workspace? Goal, draft, approvals, tracked tasks and the operator thread are removed from this browser. Already-submitted tasks stay live with the operator.')) return;
      try { localStorage.removeItem(LS_KEY); } catch (e) { /* private mode */ }
      window.location.reload();
    });
  }

  // Another tab (or an older one left open) wrote the workspace: adopt
  // its state instead of clobbering it back on the next save.
  window.addEventListener('storage', function (e) {
    if (e.key !== LS_KEY || !e.newValue) return;
    try { state = JSON.parse(e.newValue); } catch (err) { return; }
    if (!state.autopilot) state.autopilot = { enabled: false };
    renderAll();
  });

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
        : 'No WebMCP in this browser. Open this page in the ChatGPT desktop app or Chrome with WebMCP enabled — or press Simulate to watch a scripted agent drive the page’s real tools.';
    }
    if (hasMC && banner) banner.classList.add('on');
    pollSoon(2000);
  });
})();
