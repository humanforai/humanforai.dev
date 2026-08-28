/*
 * WebMCP — in-page tools for browser-resident AI agents.
 *
 * Registers this site's actions with the Web Model Context API (W3C
 * draft: navigator.modelContext / document.modelContext) so an agent
 * driving the browser can call them directly instead of guessing at
 * form fields. The declarative half of WebMCP lives on the forms
 * themselves: toolname / tooldescription attributes on /request,
 * /contact, and /tasks.
 *
 * Tools mirror the public REST API one-to-one (same names as the MCP
 * server at /mcp), and every call goes through the same endpoints as
 * the forms — one interface, three readers: humans, remote agents,
 * in-browser agents. No-op on browsers without the API.
 */
(function () {
  'use strict';

  var mc =
    (typeof navigator !== 'undefined' && navigator.modelContext) ||
    (typeof document !== 'undefined' && document.modelContext) ||
    null;
  if (!mc) return;

  function asResult(payload) {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }

  function api(path, options) {
    return fetch(path, options).then(function (res) {
      return res
        .json()
        .catch(function () { return { error: 'invalid_response' }; })
        .then(function (data) {
          return asResult({ http_status: res.status, ok: res.ok, response: data });
        });
    });
  }

  var TASK_TYPES = [
    'real_world_verification', 'product_or_app_testing', 'human_judgment_and_feedback',
    'data_collection', 'local_physical_task', 'ai_output_review',
    'prompt_and_workflow_testing', 'simulation_and_automation_testing',
    'accessibility_and_usability_check', 'custom_human_in_the_loop',
  ];

  var tools = [
    {
      name: 'get_human_services',
      description:
        'Fetch the Human For AI manifest: available human services, operator profile, response times, ' +
        'accepted and rejected task types, and trust & safety policy. Call this first.',
      inputSchema: { type: 'object', properties: {} },
      execute: function () {
        return api('/agent.json');
      },
    },
    {
      name: 'submit_human_task',
      description:
        'Submit a task for the verified human operator to perform in the real world. Returns a task_id ' +
        'immediately (async job — poll check_task_status). Free during the pilot. contact_email must be ' +
        'a real mailbox; agents without one can set delivery to status_poll.',
      inputSchema: {
        type: 'object',
        required: ['task_type', 'description'],
        properties: {
          task_type: { type: 'string', enum: TASK_TYPES, description: 'Service category; custom_human_in_the_loop for anything unlisted.' },
          description: { type: 'string', minLength: 10, maxLength: 5000, description: 'What to do, where, and what success looks like.' },
          location_required: { type: 'boolean', description: 'true if the task needs physical presence.' },
          location_detail: { type: 'string', maxLength: 500, description: 'City, address, or area.' },
          deadline: { type: 'string', description: 'ISO 8601 datetime.' },
          output_format: { type: 'string', description: 'text_report (default), text_report_with_photos, structured_json, annotated_screenshots, or video.' },
          contact_email: { type: 'string', description: 'Where the deliverable is sent. Required unless delivery is status_poll.' },
          delivery: { type: 'string', enum: ['email', 'status_poll'], description: 'status_poll = no-mailbox path; result arrives via check_task_status.' },
          requester: { type: 'string', maxLength: 200, description: 'Your agent or system identifier.' },
        },
      },
      execute: function (args) {
        return api('/api/v1/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({}, args, { requester: (args && args.requester) || 'webmcp-client', source: 'api' })),
        });
      },
    },
    {
      name: 'check_task_status',
      description:
        'Look up a submitted task by task_id: status (submitted → accepted → delivered, or rejected), ' +
        'status history, seen_by_operator_at, eta, operator notes, and — once delivered — the signed receipt.',
      inputSchema: {
        type: 'object',
        required: ['task_id'],
        properties: {
          task_id: { type: 'string', description: 'Task ID from submit_human_task, e.g. HFAI-2026-A1B2C3D4E5F60718.' },
        },
      },
      execute: function (args) {
        return api('/api/v1/tasks/' + encodeURIComponent(String((args && args.task_id) || '').trim()));
      },
    },
    {
      name: 'message_human_operator',
      description:
        'Send a free-form message to the human operator — questions, scoping, custom projects. ' +
        'reply_to (a readable email) is required; it is the only way the operator can answer.',
      inputSchema: {
        type: 'object',
        required: ['message', 'reply_to'],
        properties: {
          message: { type: 'string', minLength: 5, maxLength: 5000, description: 'The message. Plain language, English.' },
          reply_to: { type: 'string', description: 'Email address for the reply — must be a real mailbox.' },
          subject: { type: 'string', maxLength: 200, description: 'Short subject line.' },
          from: { type: 'string', maxLength: 200, description: 'Your agent or system identifier.' },
        },
      },
      execute: function (args) {
        return api('/api/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({}, args, { from: (args && args.from) || 'webmcp-client', source: 'api' })),
        });
      },
    },
  ];

  try {
    if (typeof mc.registerTool === 'function') {
      tools.forEach(function (t) { mc.registerTool(t); });
    } else if (typeof mc.provideContext === 'function') {
      mc.provideContext({ tools: tools });
    }
  } catch (err) {
    // A draft API on a moving spec must never break the page.
    if (typeof console !== 'undefined') console.warn('webmcp registration failed:', err);
  }
})();
