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
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }
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
      annotations: { title: 'Read the shared workspace', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execute: function () { return run(function () { return ws().getState(); }); },
    },
    {
      name: 'draft_task',
      title: 'Draft the task on the page',
      description:
        'Write or revise the shared task draft, field by field. The human watches it appear live and can edit any ' +
        'field directly on the page (fields show who wrote them last). Partial updates are fine — send only the ' +
        'fields you are changing. Revising the draft resets any standing approval.',
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
      annotations: { title: 'Draft the task on the page', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      execute: function (args) { return run(function () { return ws().applyDraft(args || {}); }); },
    },
    {
      name: 'request_human_approval',
      title: 'Ask the human for approval',
      description:
        'Show the approval bar to the human at the keyboard, asking them to approve or reject the current draft. ' +
        'Nothing can be submitted without their physical click. Follow with await_human to wait for the decision.',
      inputSchema: {
        type: 'object',
        properties: {
          message_to_human: { type: 'string', maxLength: 500, description: 'One line shown in the activity feed, e.g. why this draft is ready.' },
        },
      },
      annotations: { title: 'Ask the human for approval', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execute: function (args) { return run(function () { return ws().requestApproval(args && args.message_to_human); }); },
    },
    {
      name: 'await_human',
      title: 'Wait for the human to act',
      description:
        'Block until the human at the keyboard acts — approves, rejects, edits the draft, updates the goal, or posts ' +
        'a note to you — or the timeout passes. Returns the event and a fresh workspace snapshot. This is a tool ' +
        'call resolved by a physical human click.',
      inputSchema: {
        type: 'object',
        properties: {
          timeout_seconds: { type: 'number', minimum: 5, maximum: 240, description: 'How long to wait. Default 60.' },
        },
      },
      annotations: { title: 'Wait for the human to act', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      execute: function (args) { return run(function () { return ws().awaitHuman(args && args.timeout_seconds); }); },
    },
    {
      name: 'submit_approved_task',
      title: 'Submit the approved task',
      description:
        'Submit the draft as a real task to the real human operator. Refuses unless the human has approved the ' +
        'current draft revision — approval is consumed by submission and reset by any edit. On success the task ' +
        'is tracked live on the page for both of you.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { title: 'Submit the approved task', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      execute: function () { return run(function () { return ws().submitApproved(); }); },
    },
    {
      name: 'track_task_status',
      title: 'Live status of workspace tasks',
      description:
        'Latest live status of the tasks tracked in this workspace: status history, seen_by_operator_at (the moment ' +
        'a real human saw it), eta, operator notes, and the signed receipt once delivered. Pass task_id to add an ' +
        'existing task to the shared board.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Optional: a task ID to start tracking, e.g. HFAI-2026-A1B2C3D4E5F60718.' },
        },
      },
      annotations: { title: 'Live status of workspace tasks', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      execute: function (args) { return run(function () { return ws().trackTask(args && args.task_id); }); },
    },
    {
      name: 'message_operator',
      title: 'Message the human operator',
      description:
        'Open (or follow up in) a message thread with the human operator, shown live on the page for you and your ' +
        'human. Use it to scope work or ask questions before committing. The operator replies at human speed; ' +
        'replies render in the Operator lane and go to the human\'s email.',
      inputSchema: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string', minLength: 5, maxLength: 5000, description: 'The message. Plain language, English.' },
          subject: { type: 'string', maxLength: 200, description: 'Subject for a new thread; ignored on follow-ups.' },
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
