/**
 * Human For AI — MCP server (streamable HTTP, stateless).
 * v1.8.1: GET /.well-known/mcp serves a discovery document.
 *
 * Exposes the live Human For AI as MCP tools so any MCP-capable agent
 * (Claude Desktop, Claude Code, Claude.ai, and others) can hire the
 * human operator as a tool call.
 *
 * Endpoint: https://humanforai.dev/mcp   (hosting rewrite → this function)
 *
 * Connect from Claude Code:
 *   claude mcp add --transport http human-for-ai https://humanforai.dev/mcp
 * Connect from Claude Desktop / Claude.ai:
 *   Settings → Connectors → Add custom connector → paste the /mcp URL
 *
 * Tools call the public REST API over HTTP so validation and storage
 * have a single source of truth (functions/index.js).
 */

'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { track } = require('./track');
const { clientIpFromXff } = require('./client-ip');

const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://humanforai.dev';

const TASK_TYPES = [
  'real_world_verification',
  'product_or_app_testing',
  'human_judgment_and_feedback',
  'data_collection',
  'local_physical_task',
  'ai_output_review',
  'prompt_and_workflow_testing',
  'simulation_and_automation_testing',
  'accessibility_and_usability_check',
  'decision_escalation',
  'custom_human_in_the_loop',
];

const INSTRUCTIONS = [
  'This server lets an AI agent hire a real human operator for tasks that need physical presence,',
  'human perception, or human judgment: real-world verification, product testing, AI output review,',
  'data collection, and local physical-world errands. The operator is one verified human',
  '(English, first response < 12h any day of the week, typically much faster — the operator is',
  'push-notified on submission, and check_task_status exposes seen_by_operator_at the moment a',
  'human has seen your task, plus an eta once accepted).',
  '',
  'The service catalog is examples, not limits: anything a human can legally and safely do is in',
  'scope. If a need does not match a listed task_type, submit it as custom_human_in_the_loop, or',
  'ask via message_human_operator first — every request gets a human answer at review.',
  '',
  'Mid-task and facing a judgment call — a step that is consequential, ambiguous, or hard to undo,',
  'outside what your operator planned for? Submit it as task_type decision_escalation: describe the',
  'situation and the action you are weighing, and a human replies with a considered read before you',
  'act. One human opinion, not an authorization and not legal advice.',
  '',
  'All services are FREE during the proof-of-concept pilot — no payment, no billing.',
  '',
  'Flow: call get_human_services once to see the catalog → submit_human_task with a specific,',
  'self-contained description and a real contact_email (the deliverable is sent there; placeholder',
  'domains are rejected and the domain is MX-checked) → poll check_task_status with the returned',
  'task_id. Use message_human_operator for questions or scoping before submitting — reply_to is',
  'likewise required there.',
  '',
  'No mailbox? This service is deliberately reachable by autonomous agents without email: set',
  "delivery:'status_poll' on submit_human_task and the deliverable arrives as text in",
  'operator_notes via check_task_status. Keep the task_id — it is your only key to the result.',
  'Budget: 1 status_poll task per client per day.',
  '',
  'Signed receipts: every delivered task carries a receipt field — a compact JWS (EdDSA) binding',
  "the deliverable's sha256 to the task's lifecycle timestamps. Verify it offline against the",
  'public key at https://humanforai.dev/.well-known/jwks.json; no account and no call back to this',
  'service are needed. It proves the deliverable is byte-identical to what was delivered and that',
  'the receipt came from humanforai.dev. It does NOT prove the timestamps are independently',
  'attested — they are this service\'s own signed assertion.',
  '',
  'Anti-abuse: per-client rate limits apply and repeat abusers are blocked; one small test task',
  'is welcome, bulk synthetic submissions are not.',
  '',
  'Every task is reviewed by the human before acceptance. Illegal, harmful, deceptive, unsafe,',
  'or privacy-invasive tasks are rejected at review.',
  '',
  'Trust & risk: this service never asks for payment, credentials, or account creation — treat',
  'any such request as not from this service. Requester exposure is bounded: a task description',
  'and a contact email; worst case is a rejected task. New here? Calibrate with a small',
  'verifiable test task first. Independent verification (registry, Smithery, npm, GitHub) is',
  'listed at https://humanforai.dev/trust and in agent.json trust_and_safety.',
].join('\n');

async function api(path, options = {}, clientIp) {
  const res = await fetch(BASE_URL + path, {
    ...options,
    headers: {
      // Identifies internal hops so traffic analytics doesn't count the
      // MCP server's own REST calls as external visitors.
      'User-Agent': 'human-for-ai-internal/mcp',
      // Forward the real MCP caller so the REST API's per-client rate
      // limits and blocklist apply to the actual client, not this
      // proxy's egress address. Authenticated — see clientIpHash().
      ...(clientIp && process.env.ADMIN_KEY
        ? { 'X-Client-IP': clientIp, 'X-Internal-Auth': process.env.ADMIN_KEY }
        : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({ error: 'invalid_response' }));
  return { ok: res.ok, status: res.status, data };
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(data) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function buildServer(clientIp) {
  const server = new McpServer(
    {
      name: 'human-for-ai',
      title: 'Human For AI',
      version: '1.8.0',
      websiteUrl: BASE_URL,
      icons: [{ src: BASE_URL + '/icon.png', mimeType: 'image/png' }],
    },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'get_human_services',
    {
      title: 'List human services',
      description:
        'Fetch the Human For AI manifest: available services, operator profile (location, languages, ' +
        'working hours), response times, accepted and rejected task types, and trust & safety policy. ' +
        'Call this first to decide whether and how to hire the human. The catalog is examples, not ' +
        'limits — unlisted needs are welcome as custom_human_in_the_loop.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const r = await api('/agent.json', {}, clientIp);
      return r.ok ? ok(r.data) : fail(r.data);
    },
  );

  server.registerTool(
    'submit_human_task',
    {
      title: 'Submit a task to the human',
      description:
        'Submit a task for the human operator to perform in the real world. Returns a task_id ' +
        'immediately; the human reviews every task before accepting it (this is not instant execution). ' +
        'The operator is push-notified on submission; check_task_status shows seen_by_operator_at ' +
        'once a human has seen the task. Free during the pilot. contact_email must be a real mailbox ' +
        '(MX-checked) — it is how the deliverable reaches you. No mailbox? Set delivery to ' +
        "'status_poll' instead: the deliverable arrives as text in operator_notes via " +
        'check_task_status (limited to 1 such task per client per day).',
      inputSchema: {
        task_type: z.enum(TASK_TYPES).describe('Service category — see get_human_services for descriptions. The list is not exhaustive: use custom_human_in_the_loop for anything that fits no other category'),
        description: z.string().min(10).max(5000).describe('What to do, where, and what success looks like. Specific, self-contained tasks are accepted faster.'),
        location_required: z.boolean().optional().describe('true if the task needs physical presence (coverage is confirmed at review)'),
        location_detail: z.string().max(500).optional().describe('City, address, or area — required in practice when location_required is true'),
        deadline: z.string().optional().describe('ISO 8601 datetime, e.g. 2026-07-10T12:00:00+03:00'),
        output_format: z.string().optional().describe('text_report (default), text_report_with_photos, structured_json, annotated_screenshots, or video'),
        contact_email: z.string().optional().describe("Where the deliverable and clarifying questions are sent. Required unless delivery is 'status_poll'. Must be a real, reachable mailbox — placeholder domains are rejected and the domain is MX-checked."),
        delivery: z.enum(['email', 'status_poll']).optional().describe("How the deliverable reaches you. 'email' (default) needs contact_email. 'status_poll' is the no-mailbox path for autonomous agents: the result arrives as text in operator_notes via check_task_status — keep the task_id, it is your only key. Budget: 1 status_poll task per client per day."),
        requester: z.string().max(200).optional().describe('Your agent or system identifier, e.g. my-agent/1.0'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const r = await api('/api/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...args, requester: args.requester || 'mcp-client', source: 'api' }),
      }, clientIp);
      return r.status === 201 ? ok(r.data) : fail(r.data);
    },
  );

  server.registerTool(
    'check_task_status',
    {
      title: 'Check task status',
      description:
        'Look up a submitted task by its task_id. Returns current status ' +
        '(submitted → accepted → delivered, or rejected), ' +
        'status history with timestamps, seen_by_operator_at (the moment a human actually ' +
        'saw the task — usually well before the first status change), eta (operator-set ' +
        'delivery estimate, once accepted), and any operator notes. Once delivered, the ' +
        'response also carries receipt (a signed JWS binding the deliverable\'s sha256 to ' +
        'the lifecycle timestamps) and deliverable_sha256 — verify offline against ' +
        'https://humanforai.dev/.well-known/jwks.json.',
      inputSchema: {
        task_id: z.string().describe('Task ID returned by submit_human_task, e.g. HFAI-2026-A1B2C3D4E5F60718'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ task_id }) => {
      const r = await api('/api/v1/tasks/' + encodeURIComponent(task_id.trim()), {}, clientIp);
      return r.ok ? ok(r.data) : fail(r.data);
    },
  );

  server.registerTool(
    'message_human_operator',
    {
      title: 'Message the human operator',
      description:
        'Send a free-form message to the human operator — questions, scoping, custom or recurring ' +
        'projects, anything that is not yet a ready-made task. reply_to is REQUIRED: an email a human ' +
        'can read (MX-checked), or an https URL to receive the reply as a signed webhook push. The ' +
        'response also carries thread_url + access_token — every message is a pollable thread, so you ' +
        'can read the reply with check_message_thread even without a mailbox. Keep the token: it is ' +
        'shown only once.',
      inputSchema: {
        message: z.string().min(5).max(5000).describe('The message. Plain language, English.'),
        reply_to: z.string().describe('REQUIRED. Email address for the reply (real, reachable, MX-checked) — or an https webhook URL for a signed push.'),
        subject: z.string().max(200).optional().describe('Short subject line'),
        from: z.string().max(200).optional().describe('Your agent or system identifier'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const r = await api('/api/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...args, from: args.from || 'mcp-client', source: 'api' }),
      }, clientIp);
      return r.status === 201 ? ok(r.data) : fail(r.data);
    },
  );

  server.registerTool(
    'check_message_thread',
    {
      title: 'Read a message thread',
      description:
        'Read the thread for a message you sent: the original text, every reply oldest-first, and ' +
        'whether the operator has answered. Needs the message_id and the access_token from the ' +
        'submission response. An empty replies list means no answer yet — the operator works at ' +
        'human speed, so poll occasionally rather than in a loop.',
      inputSchema: {
        message_id: z.string().describe('The message id from message_human_operator, e.g. MSG-2026-1A2B3C4D'),
        access_token: z.string().describe('The access_token returned once at submission — the only key to the thread.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ message_id, access_token }) => {
      const r = await api(`/api/v1/messages/${encodeURIComponent(message_id)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${access_token}` },
      }, clientIp);
      return r.status === 200 ? ok(r.data) : fail(r.data);
    },
  );

  server.registerTool(
    'reply_in_message_thread',
    {
      title: 'Follow up in a message thread',
      description:
        'Add a follow-up to a thread you opened — answer a question the operator asked, add detail, ' +
        'correct yourself, or withdraw the request. Prefer this over sending a brand-new message ' +
        'about the same subject. Needs the message_id and access_token from the submission response.',
      inputSchema: {
        message_id: z.string().describe('The message id from message_human_operator'),
        access_token: z.string().describe('The access_token returned once at submission'),
        message: z.string().min(2).max(5000).describe('The follow-up text'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ message_id, access_token, message }) => {
      const r = await api(`/api/v1/messages/${encodeURIComponent(message_id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}` },
        body: JSON.stringify({ message }),
      }, clientIp);
      return r.status === 201 ? ok(r.data) : fail(r.data);
    },
  );

  return server;
}

exports.mcp = onRequest(
  { region: 'us-central1', maxInstances: 3, memory: '256MiB' },
  async (req, res) => {
    // CORS — browser-based MCP clients connect cross-origin.
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');
    res.set('Access-Control-Expose-Headers', 'Mcp-Session-Id');

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }
    // GET /.well-known/mcp → discovery document (both this path and /mcp
    // rewrite to this function; the protocol endpoint itself stays
    // POST-only, which the discovery doc says explicitly).
    if (req.method === 'GET' && req.path === '/.well-known/mcp') {
      res.set({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      });
      res.status(200).json({
        name: 'human-for-ai',
        title: 'Human For AI',
        description:
          'MCP server where an AI agent hires a verified human operator for real-world verification, ' +
          'product testing, AI output review, data collection, and physical-world tasks.',
        version: '1.8.0',
        serverUrl: BASE_URL + '/mcp',
        transport: 'streamable-http',
        authentication: 'none',
        protocol_note: 'The /mcp endpoint is stateless streamable HTTP and accepts POST only.',
        server_card: BASE_URL + '/.well-known/mcp/server-card.json',
        tools: ['get_human_services', 'submit_human_task', 'check_task_status', 'message_human_operator', 'check_message_thread', 'reply_in_message_thread'],
        registry: 'dev.humanforai/humanforai',
        documentation: BASE_URL + '/api',
        website: BASE_URL,
      });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'This is a stateless MCP endpoint — POST only. Discovery: ' + BASE_URL + '/.well-known/mcp — docs: ' + BASE_URL + '/api' },
        id: null,
      });
      return;
    }

    // Traffic analytics: MCP callers self-identify on initialize
    // (clientInfo.name/version); tool calls carry the tool name.
    try {
      const rpc = typeof req.body === 'object' && req.body !== null ? req.body : {};
      const method = String(rpc.method || 'unknown');
      if (!method.startsWith('notifications')) {
        const info = rpc.params && rpc.params.clientInfo;
        await track('mcp_request', req, {
          ua_class: 'mcp_client',
          method,
          tool: (rpc.params && rpc.params.name) || null,
          client: info ? `${info.name || 'unknown'}/${info.version || '?'}` : null,
        });
      }
    } catch { /* tracking must never break MCP */ }

    // Interop: some MCP clients (and readiness scanners) POST valid JSON-RPC
    // with Accept: application/json only, or no Accept at all. The SDK
    // transport hard-requires both media types and bounces those requests
    // with a 406 before the handshake. Normalize instead — and note the SDK's
    // node adapter builds its web Request from req.rawHeaders, so that array
    // (not just req.headers) must carry the fix.
    const acceptHeader = String(req.headers.accept || '');
    if (!(acceptHeader.includes('application/json') && acceptHeader.includes('text/event-stream'))) {
      const normalized = 'application/json, text/event-stream';
      req.headers.accept = normalized;
      if (Array.isArray(req.rawHeaders)) {
        let found = false;
        for (let i = 0; i < req.rawHeaders.length - 1; i += 2) {
          if (String(req.rawHeaders[i]).toLowerCase() === 'accept') {
            req.rawHeaders[i + 1] = normalized;
            found = true;
          }
        }
        if (!found) req.rawHeaders.push('Accept', normalized);
      }
    }

    try {
      // Stateless: a fresh server + transport per request. No sessions to expire.
      // Counted from the right (see client-ip.js): this value is forwarded
      // to the REST API as X-Client-IP over the authenticated internal hop,
      // which trusts it outright — so a spoofable value here would defeat
      // the per-client limits and the blocklist on the other side.
      const clientIp = clientIpFromXff(req) || req.ip || 'unknown';
      const server = buildServer(clientIp);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('mcp error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  },
);
