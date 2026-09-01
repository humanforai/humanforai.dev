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

  // document.modelContext is the canonical entry point; the navigator
  // alias is deprecated and kept only as a fallback for older builds.
  var mc =
    (typeof document !== 'undefined' && document.modelContext) ||
    (typeof navigator !== 'undefined' && navigator.modelContext) ||
    null;
  if (!mc) return;

  function asResult(payload) {
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
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

  // Every API-backed tool returns the same envelope; `response` is the
  // REST body documented per tool (and in full at /openapi.json).
  function apiEnvelope(responseSchema) {
    return {
      type: 'object',
      required: ['http_status', 'ok', 'response'],
      properties: {
        http_status: { type: 'integer', description: 'HTTP status from the underlying REST endpoint.' },
        ok: { type: 'boolean', description: 'true when http_status is 2xx.' },
        response: responseSchema,
      },
    };
  }

  var TASK_TYPES = [
    'real_world_verification', 'product_or_app_testing', 'human_judgment_and_feedback',
    'data_collection', 'local_physical_task', 'ai_output_review',
    'prompt_and_workflow_testing', 'simulation_and_automation_testing',
    'accessibility_and_usability_check', 'decision_escalation', 'custom_human_in_the_loop',
  ];

  var tools = [
    {
      name: 'get_human_services',
      title: 'List human services',
      description:
        'Fetch the Human For AI manifest: available human services, operator profile, response times, ' +
        'accepted and rejected task types, and trust & safety policy. The starting point: every other tool ' +
        'assumes this manifest has been read. Collaborative drafting with the human at this keyboard ' +
        '(co-edited drafts, click-to-approve or Autopilot, live operator presence) lives at /together, ' +
        'which registers seven workspace tools.',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: apiEnvelope({
        type: 'object',
        description: 'The agent manifest (also served at /.well-known/agent.json).',
        properties: {
          name: { type: 'string' },
          interfaces: { type: 'array', items: { type: 'string' } },
          accepted_task_types: { type: 'array', items: { type: 'string' } },
          services: { type: 'array', description: 'Service catalog entries: {id, name, description}.', items: { type: 'object' } },
          response_expectations: { type: 'object', description: 'First-response and typical turnaround times.' },
          pricing: { type: 'object' },
          trust_and_safety: { type: 'object' },
          endpoints: { type: 'object', description: 'REST, MCP, and WebMCP entry points.' },
        },
      }),
      annotations: {
        title: 'List human services',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        untrustedContentHint: false,
      },
      execute: function () {
        return api('/agent.json');
      },
    },
    {
      name: 'get_service_details',
      title: 'Service details',
      description:
        'Full detail for one service from the catalog by its task_type: description, example request, ' +
        'response format, and turnaround. The detail view for one entry of the get_human_services catalog.',
      inputSchema: {
        type: 'object',
        required: ['task_type'],
        properties: {
          task_type: { type: 'string', enum: TASK_TYPES, description: 'The service identifier, e.g. real_world_verification.' },
        },
      },
      outputSchema: {
        type: 'object',
        description: 'On success: the service entry plus how to submit. On an unknown task_type: error + the valid list.',
        properties: {
          service: {
            type: 'object',
            properties: {
              task_type: { type: 'string', enum: TASK_TYPES },
              name: { type: 'string' },
              description: { type: 'string' },
              example_request: { type: 'string' },
              response_format: { type: 'string' },
              typical_turnaround: { type: 'string' },
            },
          },
          submit_with: {
            type: 'object',
            properties: { tool: { type: 'string', const: 'submit_human_task' }, task_type: { type: 'string' } },
          },
          error: { type: 'string', const: 'unknown_task_type' },
          valid_task_types: { type: 'array', items: { type: 'string', enum: TASK_TYPES } },
        },
      },
      annotations: {
        title: 'Service details',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        untrustedContentHint: false,
      },
      execute: function (args) {
        var wanted = String((args && args.task_type) || '').trim();
        return fetch('/.well-known/services.json').then(function (res) {
          return res.json().then(function (data) {
            var list = (data && data.services) || [];
            var hit = null;
            for (var i = 0; i < list.length; i++) {
              if (list[i].task_type === wanted) { hit = list[i]; break; }
            }
            return asResult(
              hit
                ? { service: hit, submit_with: { tool: 'submit_human_task', task_type: hit.task_type } }
                : { error: 'unknown_task_type', valid_task_types: TASK_TYPES }
            );
          });
        });
      },
    },
    {
      name: 'submit_human_task',
      title: 'Submit a task to the human',
      description:
        'Submit a task for the verified human operator to perform in the real world. Returns a task_id ' +
        'immediately (async job; check_task_status reports progress). Free during the pilot. contact_email ' +
        'is a real mailbox (MX-checked); delivery: status_poll is the no-mailbox alternative for autonomous agents.',
      annotations: {
        title: 'Submit a task to the human',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        untrustedContentHint: false,
      },
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
        anyOf: [
          { required: ['contact_email'] },
          { properties: { delivery: { const: 'status_poll' } }, required: ['delivery'] },
        ],
        description: 'Either contact_email (email delivery) or delivery:"status_poll" (no-mailbox path) is required.',
      },
      outputSchema: apiEnvelope({
        type: 'object',
        description: '202 on acceptance into review; 4xx carries {error, message|details}.',
        properties: {
          task_id: { type: 'string', description: 'e.g. HFAI-2026-A1B2C3D4E5F60718 — the key to status polling.' },
          status: { type: 'string', description: 'Initial status: submitted.' },
          status_url: { type: 'string', description: 'GET here (or use check_task_status) until delivered or rejected.' },
          message: { type: 'string' },
          error: { type: 'string', description: 'Present on failure, e.g. validation_failed, duplicate_task, rate_limited.' },
          details: { type: 'array', items: { type: 'string' }, description: 'Field-level validation messages on 422.' },
        },
      }),
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
      title: 'Check task status',
      description:
        'Look up a submitted task by task_id: status (submitted → accepted → delivered, or rejected), ' +
        'status history, seen_by_operator_at, eta, operator notes, and — once delivered — the signed receipt.',
      annotations: {
        title: 'Check task status',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        // operator_notes carries human-written deliverable text.
        untrustedContentHint: true,
      },
      inputSchema: {
        type: 'object',
        required: ['task_id'],
        properties: {
          task_id: { type: 'string', description: 'Task ID from submit_human_task, e.g. HFAI-2026-A1B2C3D4E5F60718.' },
        },
      },
      outputSchema: apiEnvelope({
        type: 'object',
        description: '200 with the task record; 404 carries {error:"task_not_found"}.',
        properties: {
          task_id: { type: 'string' },
          status: { type: 'string', description: 'submitted | accepted | in_progress | delivered | rejected.' },
          status_history: { type: 'array', items: { type: 'object' }, description: 'Timestamped status transitions.' },
          seen_by_operator_at: { type: ['string', 'null'], description: 'ISO 8601 — the moment a human first saw the task.' },
          eta: { type: ['string', 'null'], description: 'ISO 8601 — set once accepted.' },
          operator_notes: { type: ['string', 'null'], description: 'Carries the deliverable text on status_poll delivery.' },
          receipt: { type: ['string', 'null'], description: 'Compact JWS (EdDSA), present once delivered — verify against /.well-known/jwks.json.' },
          deliverable_sha256: { type: ['string', 'null'] },
          error: { type: 'string' },
        },
      }),
      execute: function (args) {
        return api('/api/v1/tasks/' + encodeURIComponent(String((args && args.task_id) || '').trim()));
      },
    },
    {
      name: 'message_human_operator',
      title: 'Message the human operator',
      description:
        'Send a free-form message to the human operator — questions, scoping, custom projects. ' +
        'reply_to is required: a readable email, or an https URL for signed webhook replies. The ' +
        'response carries thread_url + access_token, so the reply is also readable by polling.',
      annotations: {
        title: 'Message the human operator',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        // Thread replies are human-written free text.
        untrustedContentHint: true,
      },
      inputSchema: {
        type: 'object',
        required: ['message', 'reply_to'],
        properties: {
          message: { type: 'string', minLength: 5, maxLength: 5000, description: 'The message. Plain language, English.' },
          reply_to: { type: 'string', description: 'Email address for the reply (real mailbox, MX-checked) — or an https URL for a signed webhook push.' },
          subject: { type: 'string', maxLength: 200, description: 'Short subject line.' },
          from: { type: 'string', maxLength: 200, description: 'Your agent or system identifier.' },
        },
      },
      outputSchema: apiEnvelope({
        type: 'object',
        description: '201 on receipt. Keep access_token — it is shown once and is the only key to the thread.',
        properties: {
          message_id: { type: 'string' },
          created_at: { type: 'string', description: 'ISO 8601.' },
          thread_url: { type: 'string', description: 'GET with the access_token (Bearer or ?token=) to read replies; POST {message, token} to follow up.' },
          access_token: { type: 'string', description: 'One-time-shown thread key.' },
          message: { type: 'string' },
          error: { type: 'string', description: 'Present on failure, e.g. validation_failed, rate_limited.' },
        },
      }),
      execute: function (args) {
        return api('/api/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({}, args, { from: (args && args.from) || 'webmcp-client', source: 'api' })),
        });
      },
    },
  ];

  // A form carrying toolname="X" IS tool X, declaratively — registering
  // the imperative twin as well would present the same tool twice.
  function noDeclarativeTwin(t) {
    try { return !document.querySelector('form[toolname="' + t.name + '"]'); } catch (e) { return true; }
  }

  try {
    var active = tools.filter(noDeclarativeTwin);
    if (typeof mc.registerTool === 'function') {
      active.forEach(function (t) { mc.registerTool(t); });
    } else if (typeof mc.provideContext === 'function') {
      mc.provideContext({ tools: active });
    }
  } catch (err) {
    // A draft API on a moving spec must never break the page.
    if (typeof console !== 'undefined') console.warn('webmcp registration failed:', err);
  }
})();
