/*
 * WebMCP tools for /together — the agent's seat at the shared workspace.
 *
 * Registers the workspace toolset with the Web Model Context API
 * (document.modelContext, navigator.modelContext fallback). These tools
 * differ from the site-wide set in webmcp.js: they read and WRITE page
 * state that the human co-edits live, and the submit tool is gated on a
 * physical human click (the approval bar in the You lane).
 *
 * The same tools are exposed on window.__hfaiTogetherTools so the page
 * can be exercised and audited in browsers without the draft API.
 */
(function () {
  'use strict';

  function ws() { return window.HFAI_TOGETHER; }

  function asResult(payload) {
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
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
    properties: {
      enabled: { type: 'boolean' },
      scope: { type: 'string', description: 'The human\'s scope note for the standing approval.' },
      granted_at: { type: 'string', description: 'ISO 8601.' },
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
  function run(fn) {
    if (ws()) ws().agentPresent();
    return Promise.resolve()
      .then(fn)
      .then(asResult)
      .catch(function (err) { return asResult({ error: 'tool_failed', message: String(err && err.message || err) }); });
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
        'provenance, approval state, live tracked tasks, and the operator thread. Call this first, and again after ' +
        'the human acts. The human sees the same state rendered on the page.',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: WORKSPACE_SCHEMA,
      annotations: { title: 'Read the shared workspace', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execute: function () { return run(function () { return ws().getState(); }); },
    },
    {
      name: 'draft_task',
      title: 'Draft the task on the page',
      description:
        'Write or revise the shared task draft, field by field. Unlike the site-wide submit_human_task, nothing is ' +
        'sent anywhere — this edits the on-page document the human co-authors. The human watches it appear live and ' +
        'can edit any field directly (fields show who wrote them last). Partial updates are fine — send only the ' +
        'fields you are changing. Revising the draft resets any per-task approval (Autopilot is unaffected).',
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
      annotations: { title: 'Draft the task on the page', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      execute: function (args) { return run(function () { return ws().applyDraft(args || {}); }); },
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
        description: 'approval_requested when the bar is shown; not_needed when Autopilot already stands; nothing_to_approve without a draft.',
        properties: {
          status: { type: 'string', enum: ['approval_requested', 'not_needed'] },
          draft_rev: { type: 'integer' },
          autopilot: AUTOPILOT_SCHEMA,
          message: { type: 'string' },
          error: { type: 'string', const: 'nothing_to_approve' },
        },
      },
      annotations: { title: 'Ask the human for approval', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execute: function (args) { return run(function () { return ws().requestApproval(args && args.message_to_human); }); },
    },
    {
      name: 'await_human',
      title: 'Wait for the human to act',
      description:
        'Block until the human at the keyboard acts — approves, rejects, edits the draft, updates the goal, posts ' +
        'a note to you, or grants/revokes Autopilot — or the timeout passes. Returns the event and a fresh ' +
        'workspace snapshot. This is a tool call resolved by a physical human click.',
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
      annotations: { title: 'Wait for the human to act', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      execute: function (args) { return run(function () { return ws().awaitHuman(args && args.timeout_seconds); }); },
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
        description: 'On success: the REST envelope with the created task. Without authority: {error:"not_approved"} plus the current approval and autopilot state.',
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
          error: { type: 'string', enum: ['no_draft', 'not_approved'] },
          approval: APPROVAL_SCHEMA,
          autopilot: AUTOPILOT_SCHEMA,
          message: { type: 'string' },
        },
      },
      annotations: { title: 'Submit the approved task', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      execute: function () { return run(function () { return ws().submitApproved(); }); },
    },
    {
      name: 'track_task_status',
      title: 'Live status of workspace tasks',
      description:
        'Workspace-scoped variant of the site-wide check_task_status: same live task records (status history, ' +
        'seen_by_operator_at — the moment a real human saw it, eta, operator notes, signed receipt), but it reads ' +
        'the whole shared board at once and keeps the page\'s live-status cards in sync for the human. Pass task_id ' +
        'to add an existing task to the board; omit it to read everything tracked.',
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
      annotations: { title: 'Live status of workspace tasks', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execute: function (args) { return run(function () { return ws().trackTask(args && args.task_id); }); },
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
      annotations: { title: 'Message the human operator', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      execute: function (args) { return run(function () { return ws().messageOperator(args && args.message, args && args.subject); }); },
    },
  ];

  // Auditable in any browser: the same tool objects, callable by hand.
  window.__hfaiTogetherTools = tools;

  var mc =
    (typeof document !== 'undefined' && document.modelContext) ||
    (typeof navigator !== 'undefined' && navigator.modelContext) ||
    null;
  if (!mc) return;

  try {
    if (typeof mc.registerTool === 'function') {
      tools.forEach(function (t) { mc.registerTool(t); });
    } else if (typeof mc.provideContext === 'function') {
      mc.provideContext({ tools: tools });
    }
  } catch (err) {
    if (typeof console !== 'undefined') console.warn('together webmcp registration failed:', err);
  }
})();
