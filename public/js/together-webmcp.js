/*
 * WebMCP tools for /together — the agent's seat at the shared workspace.
 *
 * Registers the workspace toolset with the Web Model Context API
 * (document.modelContext, navigator.modelContext fallback). These tools
 * differ from the site-wide set in webmcp.js: they read and WRITE page
 * state that the human co-edits live, and the submit tool is gated on an
 * explicit on-page approval bound to the exact draft revision.
 *
 * The same tools are exposed on window.__hfaiTogetherTools so the page
 * can be exercised and audited in browsers without the draft API.
 */
(function () {
  'use strict';

  function ws() { return window.HFAI_TOGETHER; }

  // A top-level `error` key is a refusal or a failure. It is flagged at the
  // protocol level too (isError), so an agent never mistakes a refused
  // submit or a failed lookup for a good result.
  function asResult(payload) {
    var failed = !!(payload && typeof payload === 'object' && payload.error);
    var result = {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
    if (failed) result.isError = true;
    return result;
  }

  // Every result is bounded. If the serialized payload exceeds RESULT_BUDGET
  // characters, the longest text fields are shortened (longest first, each
  // left with a visible marker) until it fits, and a `truncated` note names
  // the fields and where the full record lives. Structure is never dropped,
  // so one tool call can never flood the agent's context and never silently
  // loses a key either.
  var RESULT_BUDGET = 8000;
  function boundPayload(payload) {
    var s;
    try { s = JSON.stringify(payload); }
    catch (e) { return { error: 'unserializable_result', message: String(e && e.message || e) }; }
    if (!s || s.length <= RESULT_BUDGET) return payload;
    var clone = JSON.parse(s);
    var leaves = [];
    (function walk(node, path) {
      Object.keys(node).forEach(function (k) {
        var v = node[k], p = path ? path + '.' + k : k;
        if (typeof v === 'string' && v.length > 160) leaves.push({ parent: node, key: k, path: p, orig: v, keep: v.length });
        else if (v && typeof v === 'object') walk(v, p);
      });
    })(clone, '');
    var note = {
      budget_chars: RESULT_BUDGET,
      original_chars: s.length,
      fields: [],
      note: 'The result exceeded the per-call budget, so the longest text fields were shortened. Full task records: GET /api/v1/tasks/{task_id}; the page shows everything in full.',
    };
    if (clone && typeof clone === 'object' && !Array.isArray(clone)) clone.truncated = note;
    // Shorten, re-measure, repeat: the note and the markers take room too.
    for (var pass = 0; pass < 5; pass++) {
      var over = JSON.stringify(clone).length - RESULT_BUDGET;
      if (over <= 0) break;
      leaves.sort(function (a, b) { return b.keep - a.keep; });
      for (var i = 0; i < leaves.length && over > 0; i++) {
        var leaf = leaves[i];
        var keep = Math.max(120, leaf.keep - over - 32);
        if (keep >= leaf.keep) continue;
        over -= leaf.keep - keep;
        leaf.keep = keep;
        leaf.parent[leaf.key] = leaf.orig.slice(0, keep) + ' …[truncated ' + (leaf.orig.length - keep) + ' chars]';
        if (note.fields.indexOf(leaf.path) === -1) note.fields.push(leaf.path);
      }
    }
    return clone;
  }

  // Tool arguments arrive as an object from most clients and as a JSON
  // string from some harnesses (Chrome 152's DevTools path serializes them).
  // Accept both; an unparseable string becomes a structured refusal rather
  // than a thrown error.
  function parseArgs(raw) {
    if (typeof raw !== 'string') return { args: raw == null ? {} : raw };
    var t = raw.trim();
    if (!t) return { args: {} };
    try { var v = JSON.parse(t); return { args: v == null ? {} : v }; }
    catch (e) {
      return { refusal: { error: 'invalid_arguments', message: 'Arguments arrived as a string that is not valid JSON: ' + String(e && e.message || e) } };
    }
  }
  function acceptStringArgs(tool) {
    var inner = tool.execute;
    tool.execute = function (raw, opts) {
      var p = parseArgs(raw);
      if (p.refusal) return run(tool.name, { raw: String(raw).slice(0, 200) }, function () { return p.refusal; });
      return inner.call(tool, p.args, opts);
    };
    return tool;
  }

  // Shared schema fragments for outputSchema declarations.
  var DRAFT_SCHEMA = {
    type: ['object', 'null'],
    description: 'The shared draft, or null before the first draft_task call.',
    properties: {
      fields: { type: 'object', description: 'task_type, description, location_required, location_detail, deadline, output_format, contact_email, requester.' },
      provenance: { type: 'object', description: 'Per-field last writer: "agent" or "human".' },
      rev: { type: 'integer', description: 'Increments on every change; approvals bind to a rev.' },
    },
  };
  var APPROVAL_SCHEMA = {
    type: 'object',
    properties: {
      state: { type: 'string', enum: ['none', 'requested', 'approved', 'rejected'] },
      rev: { type: 'integer', description: 'The draft rev the decision applies to.' },
      ts: { type: 'string', description: 'ISO 8601.' },
      note: { type: 'string', description: 'The human\'s optional note.' },
      agent_message: { type: 'string' },
    },
    required: ['state'],
  };
  var AUTOPILOT_SCHEMA = {
    type: 'object',
    description: 'Bounded standing approval: a task budget and an expiry, both set by the human. Delivery always goes to the human\'s own email (or status polling) — agent-set contact_email is ignored under autopilot.',
    properties: {
      enabled: { type: 'boolean' },
      scope: { type: 'string', description: 'The human\'s scope note for the standing approval.' },
      granted_at: { type: 'string', description: 'ISO 8601.' },
      expires_at: { type: 'string', description: 'ISO 8601 — the grant retires itself at this moment.' },
      max_tasks: { type: 'integer', description: 'How many submissions the grant covers (each draft revision only once).' },
      used: { type: 'integer', description: 'Submissions already spent from the budget.' },
    },
    required: ['enabled'],
  };
  var WORKSPACE_SCHEMA = {
    type: 'object',
    description: 'Snapshot of the shared page state — the same state the human sees rendered.',
    properties: {
      goal: { type: ['string', 'null'], description: 'The human\'s goal, in their words.' },
      human_email_on_file: { type: 'boolean' },
      notes_from_human: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, ts: { type: 'string' } } } },
      draft: DRAFT_SCHEMA,
      approval: APPROVAL_SCHEMA,
      autopilot: AUTOPILOT_SCHEMA,
      tracked_tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            task_id: { type: 'string' },
            status: { type: 'string' },
            seen_by_operator_at: { type: ['string', 'null'] },
            eta: { type: ['string', 'null'] },
            simulated: { type: 'boolean', description: 'Present and true only for demo cards created by this page in simulation mode — not real tasks; never poll or act on them.' },
          },
        },
      },
      operator_thread: {
        type: ['object', 'null'],
        properties: {
          message_id: { type: 'string' },
          status: { type: 'string', enum: ['received', 'answered'] },
          reply_count: { type: 'integer' },
          replies: { type: 'array', items: { type: 'object', properties: { author: { type: 'string' }, message: { type: 'string' }, created_at: { type: 'string' } } } },
        },
      },
      valid_task_types: { type: 'array', items: { type: 'string' } },
      rules: { type: 'string', description: 'The current submission regime, in prose — changes when the human flips Autopilot.' },
    },
  };
  // Every call is announced as an hfai:tool DOM event (name, args, result,
  // duration) so the page's inspector can show the protocol live — for a
  // real WebMCP agent and for the simulator alike.
  function run(name, args, fn) {
    if (ws()) ws().agentPresent();
    var started = Date.now();
    var simulated = !!(ws() && ws().isSimulating && ws().isSimulating());
    return Promise.resolve()
      .then(fn)
      .catch(function (err) { return { error: 'tool_failed', message: String(err && err.message || err) }; })
      .then(function (payload) {
        payload = boundPayload(payload);
        try {
          document.dispatchEvent(new CustomEvent('hfai:tool', {
            detail: { name: name, args: args || {}, result: payload, ms: Date.now() - started, simulated: simulated },
          }));
        } catch (e) { /* inspector is optional */ }
        return asResult(payload);
      });
  }

  var TASK_TYPES = [
    'real_world_verification', 'product_or_app_testing', 'human_judgment_and_feedback',
    'data_collection', 'local_physical_task', 'ai_output_review',
    'prompt_and_workflow_testing', 'simulation_and_automation_testing',
    'accessibility_and_usability_check', 'decision_escalation', 'custom_human_in_the_loop',
  ];

  var tools = [
    {
      name: 'read_workspace',
      title: 'Read the shared workspace',
      description:
        'Read everything on this page: the human\'s goal and notes to you, the current task draft with per-field ' +
        'provenance, approval state, live tracked tasks, and the operator thread. The starting point, and the ' +
        'refresh after each human action. The human sees the same state rendered on the page.',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: WORKSPACE_SCHEMA,
      annotations: { title: 'Read the shared workspace', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, untrustedContentHint: true },
      execute: function () { return run('read_workspace', {}, function () { return ws().getState(); }); },
    },
    {
      name: 'draft_task',
      title: 'Draft the task on the page',
      description:
        'Write or revise the shared task draft, field by field. Unlike the site-wide submit_human_task, nothing is ' +
        'sent anywhere — this edits the on-page document the human co-authors. The human watches it appear live and ' +
        'can edit any field directly (fields show who wrote them last). Partial updates are fine — send only the ' +
        'fields you are changing. Values are validated for real (not just by this schema); invalid values come back ' +
        'in "rejected" with reasons. Revising the draft resets any per-task approval — including one already ' +
        'requested or granted (Autopilot is unaffected).',
      inputSchema: {
        type: 'object',
        properties: {
          task_type: { type: 'string', enum: TASK_TYPES, description: 'Service category; custom_human_in_the_loop for anything unlisted.' },
          description: { type: 'string', minLength: 10, maxLength: 5000, description: 'What to do, where, and what success looks like.' },
          location_required: { type: 'boolean' },
          location_detail: { type: 'string', maxLength: 500 },
          deadline: { type: 'string', description: 'ISO 8601 datetime.' },
          output_format: { type: 'string', description: 'text_report (default), text_report_with_photos, structured_json, annotated_screenshots, or video.' },
          contact_email: { type: 'string', description: 'Usually leave unset — the human\'s email from the You lane is used.' },
          requester: { type: 'string', maxLength: 200 },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          applied: { type: 'array', items: { type: 'string' }, description: 'Field names accepted into the draft.' },
          rejected: { type: 'array', items: { type: 'string' }, description: 'Unknown fields or invalid values, with reasons.' },
          draft_rev: { type: 'integer' },
          valid_fields: { type: 'array', items: { type: 'string' } },
        },
        required: ['applied', 'rejected', 'draft_rev'],
      },
      annotations: { title: 'Draft the task on the page', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, untrustedContentHint: false },
      execute: function (args) { return run('draft_task', args, function () { return ws().applyDraft(args || {}); }); },
    },
    {
      name: 'request_human_approval',
      title: 'Ask the human for approval',
      description:
        'Show the approval bar to the human at the keyboard, asking them to approve or reject the current draft. ' +
        'Follow with await_human to wait for the decision. Not needed while the human has Autopilot on — ' +
        'read_workspace shows which regime you are in.',
      inputSchema: {
        type: 'object',
        properties: {
          message_to_human: { type: 'string', maxLength: 500, description: 'One line shown in the activity feed, e.g. why this draft is ready.' },
        },
      },
      outputSchema: {
        type: 'object',
        description: 'approval_requested when the bar is shown; not_needed when Autopilot already stands; nothing_to_approve without a draft; invalid_draft (with problems) when the draft fails validation.',
        properties: {
          status: { type: 'string', enum: ['approval_requested', 'not_needed'] },
          draft_rev: { type: 'integer', description: 'The exact revision the approval will bind to. Any draft change voids the request.' },
          autopilot: AUTOPILOT_SCHEMA,
          message: { type: 'string' },
          error: { type: 'string', enum: ['nothing_to_approve', 'invalid_draft'] },
          problems: { type: 'array', items: { type: 'string' }, description: 'On invalid_draft: field-by-field reasons.' },
        },
      },
      annotations: { title: 'Ask the human for approval', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, untrustedContentHint: false },
      execute: function (args) { return run('request_human_approval', args, function () { return ws().requestApproval(args && args.message_to_human); }); },
    },
    {
      name: 'await_human',
      title: 'Wait for the human to act',
      description:
        'Block until the human at the keyboard acts — approves, rejects, edits the draft, updates the goal, posts ' +
        'a note to you, or grants/revokes Autopilot — or the timeout passes. Returns the event and a fresh ' +
        'workspace snapshot. This is a tool call resolved by an explicit human action on the shared page.',
      inputSchema: {
        type: 'object',
        properties: {
          timeout_seconds: { type: 'number', minimum: 5, maximum: 240, description: 'How long to wait. Default 60.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['event', 'workspace'],
        properties: {
          event: {
            type: 'object',
            description: 'What the human did (or a timeout).',
            required: ['type'],
            properties: {
              type: { type: 'string', enum: ['approved', 'rejected', 'draft_edited', 'goal_updated', 'note_to_agent', 'autopilot_granted', 'autopilot_revoked', 'timeout'] },
              note: { type: 'string', description: 'On approved/rejected/note_to_agent: the human\'s text.' },
              field: { type: 'string', description: 'On draft_edited: which field.' },
              value: { type: 'string', description: 'On draft_edited: the new value.' },
              goal: { type: 'string', description: 'On goal_updated: the new goal.' },
              scope: { type: 'string', description: 'On autopilot_granted: the human\'s scope note.' },
              waited_seconds: { type: 'number', description: 'On timeout.' },
            },
          },
          workspace: WORKSPACE_SCHEMA,
        },
      },
      annotations: { title: 'Wait for the human to act', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false, untrustedContentHint: true },
      execute: function (args) { return run('await_human', args, function () { return ws().awaitHuman(args && args.timeout_seconds); }); },
    },
    {
      name: 'submit_approved_task',
      title: 'Submit the approved task',
      description:
        'Submit the draft as a real task to the real human operator. Works under either regime the human chose: ' +
        'a per-task approval of the current draft revision, or standing Autopilot authority (see read_workspace). ' +
        'Without either it refuses. On success the task is tracked live on the page for both of you.',
      inputSchema: {
        type: 'object',
        properties: {},
        description: 'Deliberately empty: the payload IS the shared on-page draft, exactly as the human saw and authorized it. Inspect it first with read_workspace.',
      },
      outputSchema: {
        type: 'object',
        description: 'On success: the REST envelope with the created task. Refusals are structured: not_approved (no authority for this exact revision), invalid_draft (with problems), already_submitted (this revision was sent once already), submission_in_flight (a submit is mid-flight), network_error. A failed HTTP call never consumes the approval.',
        properties: {
          http_status: { type: 'integer' },
          response: {
            type: 'object',
            properties: {
              task_id: { type: 'string' },
              status: { type: 'string' },
              status_url: { type: 'string' },
              message: { type: 'string' },
            },
          },
          error: { type: 'string', enum: ['no_draft', 'not_approved', 'invalid_draft', 'already_submitted', 'submission_in_flight', 'network_error'] },
          problems: { type: 'array', items: { type: 'string' } },
          approval: APPROVAL_SCHEMA,
          autopilot: AUTOPILOT_SCHEMA,
          message: { type: 'string' },
        },
      },
      annotations: { title: 'Submit the approved task', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, untrustedContentHint: false },
      execute: function () { return run('submit_approved_task', {}, function () { return ws().submitApproved(); }); },
    },
    {
      name: 'track_task_status',
      title: 'Live status of workspace tasks',
      description:
        'Workspace-scoped variant of the site-wide check_task_status: same live task records (status history, ' +
        'seen_by_operator_at — the moment a real human saw it, eta, operator notes, signed receipt), but it reads ' +
        'the whole shared board at once and keeps the page\'s live-status cards in sync for the human. Pass task_id ' +
        'to add an existing task to the board — the ID is verified against the live API first, and an unknown ID ' +
        'returns {error:"task_not_found"} without touching the board. Omit it to read everything tracked.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Optional: a task ID to start tracking, e.g. HFAI-2026-A1B2C3D4E5F60718.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['tracked_tasks'],
        properties: {
          error: { type: 'string', enum: ['task_not_found', 'lookup_failed', 'network_error'], description: 'Present when a passed task_id could not be verified — it was NOT added to the board.' },
          http_status: { type: 'integer' },
          message: { type: 'string' },
          task_id: { type: 'string', description: 'On error: the ID that failed verification.' },
          tracked_tasks: {
            type: 'array',
            description: 'Latest known record per tracked task (full REST task shape once fetched).',
            items: {
              type: 'object',
              properties: {
                task_id: { type: 'string' },
                status: { type: 'string', description: 'submitted | accepted | in_progress | delivered | rejected.' },
                status_history: { type: 'array', items: { type: 'object' } },
                seen_by_operator_at: { type: ['string', 'null'] },
                eta: { type: ['string', 'null'] },
                operator_notes: { type: ['string', 'null'] },
                receipt: { type: ['string', 'null'], description: 'Compact JWS (EdDSA) once delivered.' },
              },
              required: ['task_id'],
            },
          },
        },
      },
      annotations: { title: 'Live status of workspace tasks', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false, untrustedContentHint: true },
      execute: function (args) { return run('track_task_status', args, function () { return ws().trackTask(args && args.task_id); }); },
    },
    {
      name: 'message_operator',
      title: 'Message the human operator',
      description:
        'Workspace-scoped variant of the site-wide message_human_operator: no reply_to needed — it uses the reply ' +
        'address the human saved in their lane, keeps one thread per workspace (follow-ups go to the same thread ' +
        'automatically), and renders the conversation on the page for both of you. Use it to scope work or ask ' +
        'questions before committing. The operator replies at human speed.',
      inputSchema: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string', minLength: 5, maxLength: 5000, description: 'The message. Plain language, English.' },
          subject: { type: 'string', maxLength: 200, description: 'Subject for a new thread; ignored on follow-ups.' },
        },
      },
      outputSchema: {
        type: 'object',
        description: 'New thread: {response:{message_id, created_at, note}}. Follow-up: {thread:"follow_up_added", response}. Without a saved reply address: {error:"no_reply_address"} — ask your human to fill the email field.',
        properties: {
          response: {
            type: 'object',
            properties: {
              message_id: { type: 'string' },
              created_at: { type: 'string' },
              reply_count: { type: 'integer' },
              note: { type: 'string' },
              message: { type: 'string' },
            },
          },
          thread: { type: 'string', const: 'follow_up_added' },
          error: { type: 'string', enum: ['validation_failed', 'no_reply_address'] },
          message: { type: 'string' },
        },
      },
      annotations: { title: 'Message the human operator', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, untrustedContentHint: true },
      execute: function (args) { return run('message_operator', args, function () { return ws().messageOperator(args && args.message, args && args.subject); }); },
    },
  ];

  tools.forEach(acceptStringArgs);

  // Auditable in any browser: the same tool objects, callable by hand.
  window.__hfaiTogetherTools = tools;
  window.__hfaiResultBudget = RESULT_BUDGET;

  // The API object can be attached after this script has run (a browser
  // that injects it late, or an extension). Look now, then keep looking
  // for ten seconds rather than giving up on the first miss.
  function findModelContext() {
    return (typeof document !== 'undefined' && document.modelContext) ||
      (typeof navigator !== 'undefined' && navigator.modelContext) || null;
  }
  function whenModelContext(cb) {
    var mc = findModelContext();
    if (mc) return cb(mc);
    var tries = 0;
    var timer = setInterval(function () {
      mc = findModelContext();
      if (mc || ++tries >= 40) {
        clearInterval(timer);
        if (mc) cb(mc);
      }
    }, 250);
  }

  function register(mc) {
    // "WebMCP detected" only proves the API object exists. Await every
    // registration, cross-check with getTools() where available, and tell the
    // human exactly how many of the 7 tools actually stand.
    function reportRegistration(ok, total, failed) {
      window.__hfaiToolReport = { ok: ok, total: total, failed: failed };
      var apply = function () {
        var bt = document.getElementById('mcp-banner-text');
        var banner = document.getElementById('mcp-banner');
        if (!bt) return;
        if (ok === total) {
          bt.textContent = 'WebMCP live — ' + ok + '/' + total + ' tools registered. Ask your agent to work with you on this page.';
          if (banner) banner.classList.add('on');
        } else {
          bt.textContent = 'WebMCP degraded — ' + ok + '/' + total + ' tools registered' +
            (failed.length ? ' (failed: ' + failed.join(', ') + ')' : '') + '. Reload the page.';
          if (banner) banner.classList.remove('on');
        }
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
      else apply();
    }

    var registrations;
    if (typeof mc.registerTool === 'function') {
      registrations = tools.map(function (t) {
        try {
          return Promise.resolve(mc.registerTool(t)).then(
            function () { return { name: t.name, ok: true }; },
            function (err) {
              if (typeof console !== 'undefined') console.warn('together webmcp: registerTool(' + t.name + ') rejected:', err);
              return { name: t.name, ok: false };
            }
          );
        } catch (err) {
          if (typeof console !== 'undefined') console.warn('together webmcp: registerTool(' + t.name + ') threw:', err);
          return Promise.resolve({ name: t.name, ok: false });
        }
      });
    } else if (typeof mc.provideContext === 'function') {
      var all;
      try { all = Promise.resolve(mc.provideContext({ tools: tools })).then(function () { return true; }, function () { return false; }); }
      catch (err) { all = Promise.resolve(false); }
      registrations = [all.then(function (ok) { return tools.map(function (t) { return { name: t.name, ok: ok }; }); })];
    } else {
      reportRegistration(0, tools.length, tools.map(function (t) { return t.name; }));
      return;
    }

    Promise.all(registrations)
      .then(function (results) {
        var flat = [].concat.apply([], results.map(function (r) { return Array.isArray(r) ? r : [r]; }));
        // Cross-check against what the browser says it actually holds.
        if (typeof mc.getTools === 'function') {
          return Promise.resolve(mc.getTools()).then(function (registered) {
            var names = (registered || []).map(function (t) { return t && t.name; });
            if (names.length) {
              flat.forEach(function (r) { if (r.ok && names.indexOf(r.name) === -1) r.ok = false; });
            }
            return flat;
          }, function () { return flat; });
        }
        return flat;
      })
      .then(function (flat) {
        var failed = flat.filter(function (r) { return !r.ok; }).map(function (r) { return r.name; });
        reportRegistration(flat.length - failed.length, flat.length, failed);
      });
  }

  whenModelContext(register);
})();
