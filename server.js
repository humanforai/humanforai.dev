/**
 * Human For AI — MVP server
 *
 * Zero-dependency Node.js server that:
 *   1. Serves the static site from /public
 *   2. Implements the task API:
 *        POST   /api/v1/tasks            submit a task (agents + human form)
 *        GET    /api/v1/tasks/:id        public status lookup (ID acts as token)
 *        GET    /api/v1/tasks            list all tasks        (admin key required)
 *        PATCH  /api/v1/tasks/:id        update status / notes (admin key required)
 *        GET    /api/v1/health           liveness check
 *   3. Persists tasks to data/tasks.json (swap for a real DB later — see store)
 *   4. Sends a "new task" notification (console + data/notifications.log —
 *      swap sendNotification() for a real email provider later)
 *
 * Run:  node server.js       (http://localhost:4180)
 * Env:  PORT=4180  ADMIN_KEY=<required; random per-run key generated and printed if unset>  NOTIFY_EMAIL=you@example.com
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 4180;
/* No fixed fallback: a guessable default key here once mirrored into the
 * production functions. When ADMIN_KEY is unset, mint a random key for
 * this run and print it, so local dev stays one command while the admin
 * surface is never guessable. */
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(16).toString('hex');
if (!process.env.ADMIN_KEY) {
  console.log(`ADMIN_KEY not set — generated for this run: ${ADMIN_KEY}`);
}
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || '';

// Constant-time comparison so the key can't be recovered byte-by-byte
// from response timing. (Mirrors functions/index.js.)
function keyMatches(candidate) {
  const a = Buffer.from(String(candidate ?? ''));
  const b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const BLOCKLIST_FILE = path.join(DATA_DIR, 'blocklist.json');
const NOTIFY_LOG = path.join(DATA_DIR, 'notifications.log');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.md': 'text/markdown; charset=utf-8',
};

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
  'custom_human_in_the_loop',
];

/* Task lifecycle (v1.8.0) — submitted → accepted → delivered, plus the
 * terminal `rejected`. Mirrors functions/index.js; see the longer note
 * there for why `under_review` and `in_progress` were retired and how
 * they are still accepted on PATCH. */
const TASK_STATUSES = [
  'submitted',
  'accepted',
  'delivered',
  'rejected',
];

const LEGACY_STATUS_MAP = {
  under_review: 'submitted',
  in_progress: 'accepted',
};

const STATUS_ORDER = ['submitted', 'accepted', 'delivered'];

function canonicalStatus(status) {
  return LEGACY_STATUS_MAP[status] || status;
}

function canTransition(from, to) {
  if (from === to) return true;
  if (from === 'delivered' || from === 'rejected') return false;
  if (to === 'rejected') return true;
  const fromIdx = STATUS_ORDER.indexOf(from);
  const toIdx = STATUS_ORDER.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return false;
  return toIdx > fromIdx;
}

/* ------------------------------------------------------------------ */
/* Task store — file-backed for the MVP.                               */
/* To use a real database, reimplement these four functions.          */
/* ------------------------------------------------------------------ */

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, '[]\n');
  if (!fs.existsSync(MESSAGES_FILE)) fs.writeFileSync(MESSAGES_FILE, '[]\n');
  if (!fs.existsSync(BLOCKLIST_FILE)) fs.writeFileSync(BLOCKLIST_FILE, '[]\n');
}

async function readBlocklist() {
  try {
    return JSON.parse(await fsp.readFile(BLOCKLIST_FILE, 'utf8'));
  } catch {
    return [];
  }
}

async function writeBlocklist(entries) {
  await fsp.writeFile(BLOCKLIST_FILE, JSON.stringify(entries, null, 2) + '\n');
}

async function readMessages() {
  try {
    return JSON.parse(await fsp.readFile(MESSAGES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

async function writeMessages(messages) {
  await fsp.writeFile(MESSAGES_FILE, JSON.stringify(messages, null, 2) + '\n');
}

async function readTasks() {
  try {
    return JSON.parse(await fsp.readFile(TASKS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

async function writeTasks(tasks) {
  await fsp.writeFile(TASKS_FILE, JSON.stringify(tasks, null, 2) + '\n');
}

// 8 random bytes (64 bits) — the id is a bearer credential for an
// unauthenticated read. See the note in functions/index.js.
function generateTaskId() {
  const year = new Date().getFullYear();
  const rand = crypto.randomBytes(8).toString('hex').toUpperCase();
  return `HFAI-${year}-${rand}`;
}

// Duplicate detection key for long text fields — mirrors functions/index.js,
// where the hash exists because raw description/message (up to 5000 chars)
// exceed Firestore's 1500-byte indexed-value limit. Local JSON storage has
// no such limit, but the dedup logic must stay identical.
function textHash(text) {
  return crypto.createHash('sha256').update(String(text).trim()).digest('hex');
}

/* ---- Signed deliverable receipts (v1.7.0) ------------------------- *
 * Mirrors functions/index.js — same payload shape, same JWS output, so
 * a receipt issued locally verifies with the same code path as one from
 * production. Only the key differs: local dev generates its own throwaway
 * keypair in data/ (dev-receipt-key.json) and NEVER uses the production
 * key, which lives only in functions/.env. data/ is neither deployed nor
 * committed anywhere, so the dev key stays on this machine. Receipts
 * signed here will not verify against the published JWKS — intended.
 */
const RECEIPT_KEY_ID = process.env.RECEIPT_KEY_ID || 'receipts-dev-local';
const RECEIPT_VERSION = 1;
const DEV_KEY_FILE = path.join(DATA_DIR, 'dev-receipt-key.json');

function devSigningKey() {
  try {
    if (fs.existsSync(DEV_KEY_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DEV_KEY_FILE, 'utf8'));
      return crypto.createPrivateKey({
        key: Buffer.from(saved.pkcs8_b64, 'base64'), format: 'der', type: 'pkcs8',
      });
    }
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    ensureDataDir();
    fs.writeFileSync(DEV_KEY_FILE, JSON.stringify({
      note: 'LOCAL DEV ONLY — receipts signed with this key do not verify against the published JWKS.',
      pkcs8_b64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      public_jwk: { ...publicKey.export({ format: 'jwk' }), kid: RECEIPT_KEY_ID, use: 'sig', alg: 'EdDSA' },
    }, null, 2) + '\n');
    console.log(`dev receipt key generated → ${path.relative(__dirname, DEV_KEY_FILE)}`);
    return privateKey;
  } catch (err) {
    console.error('dev receipt key unavailable:', err.message);
    return null;
  }
}

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function firstStatusAt(task, status) {
  const want = canonicalStatus(status);
  const hit = (task.status_history || []).find((h) => canonicalStatus(h.status) === want);
  return hit ? hit.at : null;
}

function issueReceipt(task) {
  const deliverable = task.operator_notes || '';
  if (!deliverable) return null;
  const key = devSigningKey();
  if (!key) return null;
  try {
    const sha256 = crypto.createHash('sha256').update(deliverable, 'utf8').digest('hex');
    const header = { alg: 'EdDSA', typ: 'JWT', kid: RECEIPT_KEY_ID };
    const payload = {
      iss: 'https://humanforai.dev',
      sub: task.task_id,
      iat: Math.floor(Date.now() / 1000),
      receipt_version: RECEIPT_VERSION,
      deliverable_sha256: sha256,
      deliverable_encoding: 'utf-8',
      delivery_channel: task.delivery || 'email',
      task_type: task.task_type,
      timeline: {
        submitted_at: task.created_at || null,
        seen_by_operator_at: task.seen_by_operator_at || null,
        accepted_at: firstStatusAt(task, 'accepted'),
        delivered_at: firstStatusAt(task, 'delivered'),
      },
      timeline_note: 'Timestamps are the service\'s own signed assertion, not third-party attested.',
      verify: 'https://humanforai.dev/.well-known/jwks.json',
    };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = crypto.sign(null, Buffer.from(signingInput), key);
    return { receipt: `${signingInput}.${b64url(signature)}`, sha256 };
  } catch (err) {
    console.error('receipt signing failed:', err.message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Notifications — console + log file for the MVP.                     */
/* To send real email, call your provider (Resend, SES, SMTP) here.   */
/* ------------------------------------------------------------------ */

async function sendNotification(task) {
  const line =
    `[${new Date().toISOString()}] NEW TASK ${task.task_id} ` +
    `type=${task.task_type} budget=$${task.budget_usd} → notify ${NOTIFY_EMAIL}\n`;
  console.log(line.trim());
  try {
    await fsp.appendFile(NOTIFY_LOG, line);
  } catch (err) {
    console.error('notification log failed:', err.message);
  }
  // TODO: real email — e.g. Resend:
  // await fetch('https://api.resend.com/emails', { method: 'POST', headers: {...},
  //   body: JSON.stringify({ to: NOTIFY_EMAIL, subject: `New task ${task.task_id}`, ... }) })
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

// Reserved example domains (RFC 2606) and TLDs that can never receive
// mail. A placeholder address means the deliverable could never reach
// the requester, so it is rejected up front with an explanation.
// (Mirrors functions/index.js.)
const PLACEHOLDER_EMAIL_DOMAINS = new Set([
  'example.com', 'example.org', 'example.net', 'example.edu', 'test.com',
]);
const PLACEHOLDER_EMAIL_TLDS = new Set([
  'test', 'invalid', 'localhost', 'example', 'local', 'lan',
  'internal', 'intranet', 'private', 'corp', 'home', 'lab', 'fake',
]);

function placeholderEmailError(value, field) {
  const domain = String(value).toLowerCase().split('@').pop();
  const tld = domain.split('.').pop();
  // Suffix match so subdomains can't slip through (a.example.com).
  const reserved = [...PLACEHOLDER_EMAIL_DOMAINS].some(
    (d) => domain === d || domain.endsWith('.' + d)
  );
  if (reserved || PLACEHOLDER_EMAIL_TLDS.has(tld)) {
    return `${field} uses a placeholder or reserved domain (${domain}) that cannot receive mail. ` +
      'Provide a deliverable address so the result can reach you.';
  }
  return null;
}

/* Per-client abuse guard — in-memory mirror of the Firestore counters in
   functions/index.js. Local dev only, so it resets on restart. */
const IP_TASKS_DAILY_LIMIT = Number(process.env.IP_TASKS_DAILY_LIMIT) || 5;
const IP_MESSAGES_DAILY_LIMIT = Number(process.env.IP_MESSAGES_DAILY_LIMIT) || 5;
const IP_TASKS_HOURLY_LIMIT = Number(process.env.IP_TASKS_HOURLY_LIMIT) || 3;
const IP_MESSAGES_HOURLY_LIMIT = Number(process.env.IP_MESSAGES_HOURLY_LIMIT) || 3;
// No-mailbox path budget — mirrors functions/index.js.
const IP_POLL_TASKS_DAILY_LIMIT = Number(process.env.IP_POLL_TASKS_DAILY_LIMIT) || 1;
const ipDailyCounters = new Map();

/* ---- RateLimit response headers (v1.8.0) — mirrors functions/index.js */
const READS_HOURLY_LIMIT = 1000; // per instance — soft backstop for read GETs

const RATELIMIT_POLICY = [
  `"tasks-per-client-hourly";q=${IP_TASKS_HOURLY_LIMIT};w=3600`,
  `"tasks-per-client-daily";q=${IP_TASKS_DAILY_LIMIT};w=86400`,
  `"messages-per-client-hourly";q=${IP_MESSAGES_HOURLY_LIMIT};w=3600`,
  `"messages-per-client-daily";q=${IP_MESSAGES_DAILY_LIMIT};w=86400`,
  `"reads-per-instance-hourly";q=${READS_HOURLY_LIMIT};w=3600`,
].join(', ');

// Soft per-instance read budget — mirrors functions/index.js readBudget().
let readWindow = { hour: '', count: 0 };
function readBudget() {
  const now = new Date();
  const hour = now.toISOString().slice(0, 13);
  if (readWindow.hour !== hour) readWindow = { hour, count: 0 };
  readWindow.count += 1;
  const resetSeconds = 3600 - (now.getUTCMinutes() * 60 + now.getUTCSeconds());
  return {
    ok: readWindow.count <= READS_HOURLY_LIMIT,
    headers: rateHeaders(READS_HOURLY_LIMIT, READS_HOURLY_LIMIT - readWindow.count, resetSeconds),
    resetSeconds,
  };
}

function secondsToUtcMidnight() {
  const next = new Date();
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - Date.now()) / 1000));
}

function secondsToNextUtcHour() {
  const now = new Date();
  return Math.max(1, 3600 - (now.getUTCMinutes() * 60 + now.getUTCSeconds()));
}

function rateHeaders(limit, remaining, resetSeconds) {
  return {
    'RateLimit-Limit': String(limit),
    'RateLimit-Remaining': String(Math.max(0, remaining)),
    'RateLimit-Reset': String(resetSeconds),
  };
}

function clientIpHash(req) {
  let ip;
  if (keyMatches(req.headers['x-internal-auth']) && req.headers['x-client-ip']) {
    ip = req.headers['x-client-ip'];
  } else {
    const xff = String(req.headers['x-forwarded-for'] || '');
    ip = (xff.split(',')[0] || '').trim() || req.socket.remoteAddress || 'unknown';
  }
  return crypto.createHash('sha256').update('hfai-ip-salt:' + ip).digest('hex').slice(0, 16);
}

// Increments and returns { allowed, count } — the count feeds the
// RateLimit-Remaining header. (Mirrors underDailyLimit in functions/index.js.)
function underIpLimit(kind, ipHash, limit) {
  const key = `${kind}-${ipHash}-${new Date().toISOString().slice(0, 10)}`;
  const count = ipDailyCounters.get(key) || 0;
  if (count >= limit) return { allowed: false, count };
  ipDailyCounters.set(key, count + 1);
  return { allowed: true, count: count + 1 };
}

/* MX check — mirrors functions/index.js: no mail service on the domain
   means the deliverable could never arrive. Fail-open on transient DNS
   errors; 6h in-memory cache. */
const dns = require('node:dns');
const mxCache = new Map();

async function emailDomainAcceptsMail(email) {
  const domain = String(email).toLowerCase().split('@').pop();
  const hit = mxCache.get(domain);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.ok;
  let ok;
  try {
    const mx = await dns.promises.resolveMx(domain);
    ok = Array.isArray(mx) && mx.length > 0;
  } catch (err) {
    ok = !(err && (err.code === 'ENOTFOUND' || err.code === 'ENODATA'));
  }
  mxCache.set(domain, { ok, at: Date.now() });
  return ok;
}

function validateTaskPayload(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['Request body must be a JSON object.'];
  }
  if (!TASK_TYPES.includes(body.task_type)) {
    errors.push(`task_type must be one of: ${TASK_TYPES.join(', ')}`);
  }
  if (typeof body.description !== 'string' || body.description.trim().length < 10) {
    errors.push('description is required (min 10 characters).');
  }
  if (body.description && body.description.length > 5000) {
    errors.push('description must be under 5000 characters.');
  }
  // budget_usd is optional; 0 (or omitted) means "request a quote".
  if (body.budget_usd !== undefined &&
      (typeof body.budget_usd !== 'number' || body.budget_usd < 0 || body.budget_usd > 100000)) {
    errors.push('budget_usd must be a number between 0 and 100000 (0 = request a quote).');
  }
  if (body.deadline !== undefined && Number.isNaN(Date.parse(body.deadline))) {
    errors.push('deadline must be an ISO 8601 datetime string.');
  }
  // A working return channel is required since v1.5.0 (anti-abuse).
  // Two channels exist: email (default), or — for agents without a
  // mailbox — delivery:'status_poll', where the deliverable arrives as
  // text in operator_notes on the public status endpoint (1/day budget).
  if (body.delivery !== undefined && body.delivery !== 'email' && body.delivery !== 'status_poll') {
    errors.push("delivery must be 'email' (default) or 'status_poll'.");
  }
  const hasEmail = !(body.contact_email === undefined || body.contact_email === null || body.contact_email === '');
  if (!hasEmail && body.delivery !== 'status_poll') {
    errors.push('contact_email is required — the deliverable and any operator questions are sent there. ' +
      "Agents without a mailbox: set delivery:'status_poll' to receive the result as text via GET /api/v1/tasks/{task_id} (operator_notes field; limited to 1 such task per client per day).");
  } else if (hasEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.contact_email))) {
    errors.push('contact_email must be a valid email address.');
  } else if (hasEmail) {
    const placeholder = placeholderEmailError(body.contact_email, 'contact_email');
    if (placeholder) errors.push(placeholder);
  }
  return errors;
}

function buildTask(body, ipHash) {
  const now = new Date().toISOString();
  return {
    client_ip_hash: ipHash || null,
    task_id: generateTaskId(),
    status: 'submitted',
    task_type: body.task_type,
    description: String(body.description).trim(),
    description_hash: textHash(body.description),
    location_required: Boolean(body.location_required),
    location_detail: body.location_detail ? String(body.location_detail).slice(0, 500) : null,
    deadline: body.deadline || null,
    output_format: body.output_format ? String(body.output_format).slice(0, 200) : 'text_report',
    budget_usd: typeof body.budget_usd === 'number' ? body.budget_usd : 0,
    // Email wins when both are given; status_poll only without a mailbox.
    delivery: (!body.contact_email && body.delivery === 'status_poll') ? 'status_poll' : 'email',
    contact_email: body.contact_email || null,
    requester: body.requester ? String(body.requester).slice(0, 200) : 'unspecified',
    source: body.source === 'web_form' ? 'web_form' : 'api',
    created_at: now,
    updated_at: now,
    status_history: [{ status: 'submitted', at: now }],
    seen_by_operator_at: null,
    eta: null,
    operator_notes: null,
    // Issued on the delivered transition — see issueReceipt().
    receipt: null,
    deliverable_sha256: null,
    receipt_issued_at: null,
  };
}

/* Public view — hides admin-only fields from status lookups. */
function publicTask(task) {
  const { contact_email, operator_notes, client_ip_hash, ...rest } = task;
  // Never emit a retired status, even from a pre-v1.8.0 row.
  return { ...rest, status: canonicalStatus(rest.status), operator_notes: operator_notes || undefined };
}

/* ------------------------------------------------------------------ */
/* Messages — structured contact channel for agents (and humans)       */
/* ------------------------------------------------------------------ */

function validateMessagePayload(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['Request body must be a JSON object.'];
  }
  if (typeof body.message !== 'string' || body.message.trim().length < 5) {
    errors.push('message is required (min 5 characters).');
  }
  if (body.message && body.message.length > 5000) {
    errors.push('message must be under 5000 characters.');
  }
  // Required since v1.5.0 (anti-abuse): without a reply address the
  // operator has no way to answer, so the message serves no purpose.
  if (body.reply_to === undefined || body.reply_to === null || body.reply_to === '') {
    errors.push('reply_to is required — it is the only way the operator can answer you. ' +
      "Agents without a mailbox: submit your question as a custom_human_in_the_loop task with delivery:'status_poll' instead, and read the answer via GET /api/v1/tasks/{task_id}.");
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.reply_to))) {
    errors.push('reply_to must be a valid email address.');
  } else {
    const placeholder = placeholderEmailError(body.reply_to, 'reply_to');
    if (placeholder) errors.push(placeholder);
  }
  return errors;
}

function buildMessage(body, ipHash) {
  const now = new Date().toISOString();
  return {
    client_ip_hash: ipHash || null,
    message_id: `MSG-${new Date().getFullYear()}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`,
    from: body.from ? String(body.from).slice(0, 200) : 'unspecified',
    subject: body.subject ? String(body.subject).slice(0, 200) : null,
    message: String(body.message).trim(),
    message_hash: textHash(body.message),
    reply_to: body.reply_to || null,
    source: body.source === 'web_form' ? 'web_form' : 'api',
    created_at: now,
  };
}

async function sendContactNotification(msg) {
  const line =
    `[${new Date().toISOString()}] NEW MESSAGE ${msg.message_id} ` +
    `from=${msg.from} reply_to=${msg.reply_to || 'none'} → notify ${NOTIFY_EMAIL}\n`;
  console.log(line.trim());
  try {
    await fsp.appendFile(NOTIFY_LOG, line);
  } catch (err) {
    console.error('notification log failed:', err.message);
  }
  // TODO: real email — same provider hook as sendNotification().
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function sendJSON(res, status, data, headers) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    // Documented submission budgets on every API response — mirrors
    // functions/index.js; the dynamic trio rides on submissions and 429s.
    'RateLimit-Policy': RATELIMIT_POLICY,
    ...(headers || {}),
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Header only — never a query param, so the key can't leak into logs,
// browser history, or Referer headers. (Mirrors functions/index.js.)
function isAdmin(req) {
  return keyMatches(req.headers['x-admin-key']);
}

/* ---- Idempotency-Key support (v1.8.1) ------------------------------ *
 * Mirrors functions/index.js, with an in-memory store instead of
 * Firestore — good enough for the local dev server's lifetime. Same
 * semantics: same key + same payload within 24h replays the stored 201
 * (Idempotency-Replayed: true); same key + different payload → 422.
 */
const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;
const IDEMPOTENCY_KEY_MAX = 200;
const idempotencyStore = new Map();

function idempotencyPhase(req, res, ipHash, body, pathname) {
  const key = String(req.headers['idempotency-key'] || '').trim();
  if (!key) return { replayed: false, id: null, requestHash: null };
  if (key.length > IDEMPOTENCY_KEY_MAX) {
    sendJSON(res, 422, {
      error: 'validation_failed',
      details: [`Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX} characters.`],
    });
    return { replayed: true };
  }
  const requestHash = textHash(pathname + '\n' + JSON.stringify(body));
  const id = `${ipHash}:${key}`;
  const rec = idempotencyStore.get(id);
  if (rec && Date.now() - Date.parse(rec.created_at) < IDEMPOTENCY_TTL_MS) {
    if (rec.request_hash !== requestHash) {
      sendJSON(res, 422, {
        error: 'idempotency_key_reuse',
        message: 'This Idempotency-Key was already used with a different payload. Use a fresh key for each distinct request.',
      });
      return { replayed: true };
    }
    sendJSON(res, rec.status, rec.response, { 'Idempotency-Replayed': 'true', ...(rec.headers || {}) });
    return { replayed: true };
  }
  return { replayed: false, id, requestHash };
}

function storeIdempotent(idem, status, response, headers) {
  if (!idem || !idem.id) return;
  idempotencyStore.set(idem.id, {
    request_hash: idem.requestHash,
    status,
    response,
    headers: headers || null,
    created_at: new Date().toISOString(),
  });
}

/* ------------------------------------------------------------------ */
/* API routing                                                         */
/* ------------------------------------------------------------------ */

async function handleAPI(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','v1','tasks',...]
  const resource = parts[2];
  const id = parts[3];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, Idempotency-Key',
      'Access-Control-Expose-Headers': 'Location, Idempotency-Replayed, Retry-After, RateLimit-Policy, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  if (resource === 'health' && req.method === 'GET') {
    sendJSON(res, 200, { status: 'ok', service: 'human-for-ai', api_version: '1.8.2', time: new Date().toISOString() });
    return;
  }

  // GET /api/v1/services — public, cursor-paginated service catalog.
  // (Mirrors functions/index.js; see openapi.json for the contract.)
  // GET /api/v1/services.md — markdown twin (mirrors functions/index.js).
  if (resource === 'services.md' && req.method === 'GET') {
    const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'agent.json'), 'utf8'));
    const services = Array.isArray(manifest.services) ? manifest.services : [];
    const lines = [
      '# Human For AI — service catalog',
      '',
      'Markdown twin of `GET /api/v1/services` (JSON, cursor-paginated). All services are free during the pilot; every task is human-reviewed before acceptance. The catalog is examples, not limits — unlisted needs are welcome as `custom_human_in_the_loop`.',
      '',
    ];
    for (const s of services) {
      lines.push(`## ${s.name || s.id}`, '');
      if (s.description) lines.push(s.description, '');
      lines.push(`- task_type: \`${s.id || s.task_type || 'custom_human_in_the_loop'}\``);
      if (s.pricing) lines.push(`- pricing: ${s.pricing}`);
      if (s.typical_turnaround) lines.push(`- typical turnaround: ${s.typical_turnaround}`);
      lines.push('');
    }
    lines.push('Submit: `POST /api/v1/tasks` (202 Accepted + poll URL) — docs: https://humanforai.dev/api.md');
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(lines.join('\n') + '\n');
    return;
  }

  if (resource === 'services' && req.method === 'GET') {
    const budget = readBudget();
    if (!budget.ok) {
      sendJSON(res, 429, {
        error: 'rate_limited',
        message: 'Per-instance read budget exceeded. Honor Retry-After.',
      }, { ...budget.headers, 'Retry-After': String(budget.resetSeconds) });
      return;
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'agent.json'), 'utf8'));
    const services = Array.isArray(manifest.services) ? manifest.services : [];
    const limitRaw = Number(url.searchParams.get('limit'));
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 50) : 10;
    let offset = 0;
    if (url.searchParams.get('cursor') !== null) {
      try {
        const parsed = JSON.parse(Buffer.from(String(url.searchParams.get('cursor')), 'base64url').toString('utf8'));
        offset = parsed.offset;
        if (!Number.isInteger(offset) || offset < 0) throw new Error('bad cursor');
      } catch {
        sendJSON(res, 422, {
          error: 'validation_failed',
          details: ['cursor is not a valid pagination cursor from a previous response.'],
        });
        return;
      }
    }
    const next = offset + limit;
    sendJSON(res, 200, {
      items: services.slice(offset, next),
      total: services.length,
      next_cursor: next < services.length
        ? Buffer.from(JSON.stringify({ offset: next })).toString('base64url')
        : null,
    }, budget.headers);
    return;
  }

  // Local no-ops for production-only analytics (collected in Firestore).
  if (resource === 'beacon' && req.method === 'POST') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }
  if (resource === 'analytics' && req.method === 'GET') {
    if (!isAdmin(req)) {
      sendJSON(res, 401, { error: 'unauthorized', message: 'Admin key required (X-Admin-Key header).' });
      return;
    }
    sendJSON(res, 200, { days: [], events: [], note: 'Traffic analytics is collected in production only.' });
    return;
  }

  // /api/v1/blocklist — admin-managed abuse blocklist. (Mirrors functions/index.js.)
  if (resource === 'blocklist') {
    if (!isAdmin(req)) {
      sendJSON(res, 401, { error: 'unauthorized', message: 'Admin key required (X-Admin-Key header).' });
      return;
    }
    if (req.method === 'GET') {
      const entries = await readBlocklist();
      sendJSON(res, 200, { count: entries.length, entries: entries.slice().reverse() });
      return;
    }
    if (req.method === 'POST') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch {
        sendJSON(res, 400, { error: 'invalid_json', message: 'Request body must be valid JSON.' });
        return;
      }
      const hash = String(body.ip_hash || '').trim().toLowerCase();
      if (!/^[0-9a-f]{16}$/.test(hash)) {
        sendJSON(res, 422, { error: 'validation_failed', details: ['ip_hash must be the 16-hex-char client_ip_hash from a task or message.'] });
        return;
      }
      const entries = await readBlocklist();
      const entry = {
        ip_hash: hash,
        note: body.note ? String(body.note).slice(0, 500) : null,
        created_at: new Date().toISOString(),
      };
      if (!entries.some((e) => e.ip_hash === hash)) entries.push(entry);
      await writeBlocklist(entries);
      sendJSON(res, 201, entry);
      return;
    }
    if (req.method === 'DELETE' && id) {
      const hash = String(id).toLowerCase();
      const entries = await readBlocklist();
      const kept = entries.filter((e) => e.ip_hash !== hash);
      if (kept.length === entries.length) {
        sendJSON(res, 404, { error: 'not_found', message: `No blocklist entry ${hash}.` });
        return;
      }
      await writeBlocklist(kept);
      sendJSON(res, 200, { deleted: 1, ip_hash: hash });
      return;
    }
    sendJSON(res, 405, { error: 'method_not_allowed', message: 'Blocklist supports GET, POST, and DELETE /:hash (admin).' });
    return;
  }

  // POST /api/v1/messages — structured contact channel (no auth)
  // GET  /api/v1/messages — admin inbox
  if (resource === 'messages') {
    if (req.method === 'POST') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (err) {
        const tooLarge = err.message === 'payload_too_large';
        sendJSON(res, tooLarge ? 413 : 400, {
          error: tooLarge ? 'payload_too_large' : 'invalid_json',
          message: tooLarge ? 'Request body exceeds 64 KB.' : 'Request body must be valid JSON.',
        });
        return;
      }
      const ipHash = clientIpHash(req);
      if ((await readBlocklist()).some((b) => b.ip_hash === ipHash)) {
        sendJSON(res, 403, {
          error: 'blocked',
          message: 'This client address has been blocked for abuse. If you believe this is a mistake, see https://humanforai.dev/trust.',
        });
        return;
      }
      const idem = idempotencyPhase(req, res, ipHash, body, url.pathname);
      if (idem.replayed) return;
      const errors = validateMessagePayload(body);
      if (errors.length) {
        sendJSON(res, 422, { error: 'validation_failed', details: errors });
        return;
      }
      if (!(await emailDomainAcceptsMail(body.reply_to))) {
        sendJSON(res, 422, {
          error: 'validation_failed',
          details: [`reply_to domain (${String(body.reply_to).split('@').pop()}) has no mail service (MX records) — the operator could never answer you. Provide a real mailbox.`],
        });
        return;
      }
      const messages = await readMessages();
      // Duplicate guard — same rule as tasks: identical text within 24h.
      // Hash-matched to mirror functions/index.js; pre-hash docs never
      // match (fine for a 24h-window guard).
      const msgHash = textHash(body.message);
      const dupSince = Date.now() - 24 * 3600 * 1000;
      const dup = messages.find((m) => m.message_hash === msgHash && Date.parse(m.created_at) >= dupSince);
      if (dup) {
        sendJSON(res, 409, {
          error: 'duplicate_message',
          message_id: dup.message_id,
          message: `An identical message was already received at ${dup.created_at} (${dup.message_id}). The operator will reply to it — no need to resend.`,
        });
        return;
      }
      const hour = new Date().toISOString().slice(11, 13);
      if (!underIpLimit(`messages-h${hour}`, ipHash, IP_MESSAGES_HOURLY_LIMIT).allowed) {
        sendJSON(res, 429, {
          error: 'rate_limited',
          message: `This client address has reached its hourly message limit (${IP_MESSAGES_HOURLY_LIMIT}/hour during the free pilot). Try again next hour.`,
        }, {
          'Retry-After': String(secondsToNextUtcHour()),
          ...rateHeaders(IP_MESSAGES_HOURLY_LIMIT, 0, secondsToNextUtcHour()),
        });
        return;
      }
      const msgDaily = underIpLimit('messages', ipHash, IP_MESSAGES_DAILY_LIMIT);
      if (!msgDaily.allowed) {
        sendJSON(res, 429, {
          error: 'rate_limited',
          message: `This client address has reached its daily message limit (${IP_MESSAGES_DAILY_LIMIT}/day during the free pilot). Try again after 00:00 UTC.`,
        }, {
          'Retry-After': String(secondsToUtcMidnight()),
          ...rateHeaders(IP_MESSAGES_DAILY_LIMIT, 0, secondsToUtcMidnight()),
        });
        return;
      }
      const msg = buildMessage(body, ipHash);
      messages.push(msg);
      await writeMessages(messages);
      await sendContactNotification(msg);
      const msgResponse = {
        message_id: msg.message_id,
        created_at: msg.created_at,
        message: 'Message received. The operator replies within 12 hours, any day of the week. Include reply_to to get an answer.',
      };
      sendJSON(res, 201, msgResponse,
        rateHeaders(IP_MESSAGES_DAILY_LIMIT, IP_MESSAGES_DAILY_LIMIT - msgDaily.count, secondsToUtcMidnight()));
      storeIdempotent(idem, 201, msgResponse);
      return;
    }
    if (req.method === 'GET') {
      if (!isAdmin(req)) {
        sendJSON(res, 401, { error: 'unauthorized', message: 'Admin key required (X-Admin-Key header).' });
        return;
      }
      const messages = await readMessages();
      sendJSON(res, 200, { count: messages.length, messages: messages.slice().reverse() });
      return;
    }
    // DELETE /api/v1/messages/:id  — remove one message   (admin)
    // DELETE /api/v1/messages      — clear the inbox      (admin)
    // Deletion is permanent; the admin UI confirms before calling.
    // (Mirrors functions/index.js.)
    if (req.method === 'DELETE') {
      if (!isAdmin(req)) {
        sendJSON(res, 401, { error: 'unauthorized', message: 'Admin key required (X-Admin-Key header).' });
        return;
      }
      const messages = await readMessages();
      if (id) {
        const wanted = String(id).toUpperCase();
        const kept = messages.filter((m) => m.message_id.toUpperCase() !== wanted);
        if (kept.length === messages.length) {
          sendJSON(res, 404, { error: 'message_not_found', message: `No message with id ${id}.` });
          return;
        }
        await writeMessages(kept);
        sendJSON(res, 200, { deleted: 1, message_id: wanted });
        return;
      }
      await writeMessages([]);
      sendJSON(res, 200, { deleted: messages.length });
      return;
    }
    sendJSON(res, 405, { error: 'method_not_allowed', message: 'Messages support POST (public), GET and DELETE (admin).' });
    return;
  }

  if (resource !== 'tasks') {
    sendJSON(res, 404, { error: 'not_found', message: 'Unknown API resource. See /api for documentation.' });
    return;
  }

  // POST /api/v1/tasks — submit a task
  if (req.method === 'POST' && !id) {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch (err) {
      const tooLarge = err.message === 'payload_too_large';
      sendJSON(res, tooLarge ? 413 : 400, {
        error: tooLarge ? 'payload_too_large' : 'invalid_json',
        message: tooLarge ? 'Request body exceeds 64 KB.' : 'Request body must be valid JSON.',
      });
      return;
    }
    const ipHash = clientIpHash(req);
    if ((await readBlocklist()).some((b) => b.ip_hash === ipHash)) {
      sendJSON(res, 403, {
        error: 'blocked',
        message: 'This client address has been blocked for abuse. If you believe this is a mistake, see https://humanforai.dev/trust.',
      });
      return;
    }
    const idem = idempotencyPhase(req, res, ipHash, body, url.pathname);
    if (idem.replayed) return;
    const errors = validateTaskPayload(body);
    if (errors.length) {
      sendJSON(res, 422, { error: 'validation_failed', details: errors });
      return;
    }
    const isPollTask = !body.contact_email && body.delivery === 'status_poll';
    if (!isPollTask && !(await emailDomainAcceptsMail(body.contact_email))) {
      sendJSON(res, 422, {
        error: 'validation_failed',
        details: [`contact_email domain (${String(body.contact_email).split('@').pop()}) has no mail service (MX records) — the deliverable could never reach you. Provide a real mailbox.`],
      });
      return;
    }
    const tasks = await readTasks();
    // Duplicate guard: an identical description within 24h is a retry
    // or spam — point the client at the existing task instead of
    // creating a copy. (Mirrors functions/index.js.)
    // Hash-matched to mirror functions/index.js; pre-hash docs never
    // match (fine for a 24h-window guard).
    const descHash = textHash(body.description);
    const dupSince = Date.now() - 24 * 3600 * 1000;
    const dup = tasks.find((t) => t.description_hash === descHash && Date.parse(t.created_at) >= dupSince);
    if (dup) {
      sendJSON(res, 409, {
        error: 'duplicate_task',
        task_id: dup.task_id,
        status_url: `/api/v1/tasks/${dup.task_id}`,
        message: `An identical task was already submitted at ${dup.created_at} (${dup.task_id}). Poll its status instead of resubmitting.`,
      });
      return;
    }
    if (isPollTask && !underIpLimit('polltasks', ipHash, IP_POLL_TASKS_DAILY_LIMIT).allowed) {
      sendJSON(res, 429, {
        error: 'rate_limited',
        message: `The no-mailbox path (delivery: status_poll) accepts ${IP_POLL_TASKS_DAILY_LIMIT} task per client per day. Try again after 00:00 UTC, or provide a real contact_email for the normal budget.`,
      }, {
        'Retry-After': String(secondsToUtcMidnight()),
        ...rateHeaders(IP_POLL_TASKS_DAILY_LIMIT, 0, secondsToUtcMidnight()),
      });
      return;
    }
    const hour = new Date().toISOString().slice(11, 13);
    if (!underIpLimit(`tasks-h${hour}`, ipHash, IP_TASKS_HOURLY_LIMIT).allowed) {
      sendJSON(res, 429, {
        error: 'rate_limited',
        message: `This client address has reached its hourly task limit (${IP_TASKS_HOURLY_LIMIT}/hour during the free pilot). Try again next hour.`,
      }, {
        'Retry-After': String(secondsToNextUtcHour()),
        ...rateHeaders(IP_TASKS_HOURLY_LIMIT, 0, secondsToNextUtcHour()),
      });
      return;
    }
    const taskDaily = underIpLimit('tasks', ipHash, IP_TASKS_DAILY_LIMIT);
    if (!taskDaily.allowed) {
      sendJSON(res, 429, {
        error: 'rate_limited',
        message: `This client address has reached its daily task limit (${IP_TASKS_DAILY_LIMIT}/day during the free pilot). Try again after 00:00 UTC.`,
      }, {
        'Retry-After': String(secondsToUtcMidnight()),
        ...rateHeaders(IP_TASKS_DAILY_LIMIT, 0, secondsToUtcMidnight()),
      });
      return;
    }
    const task = buildTask(body, ipHash);
    tasks.push(task);
    await writeTasks(tasks);
    await sendNotification(task);
    // Async-job contract (mirrors functions/index.js): 202 Accepted — a
    // queued job, not a finished one; Location points at the poll endpoint.
    const taskResponse = {
      task_id: task.task_id,
      status: task.status,
      created_at: task.created_at,
      status_url: `/api/v1/tasks/${task.task_id}`,
      status_page: `/tasks?id=${task.task_id}`,
      message: task.delivery === 'status_poll'
        ? 'Task received in no-mailbox mode. Poll status_url — the deliverable and any operator questions will appear in operator_notes. Keep the task_id: it is your only key to the result.'
        : 'Task received. It will be reviewed before acceptance. Keep the task_id to check status.',
    };
    const taskHeaders = {
      Location: `/api/v1/tasks/${task.task_id}`,
      ...rateHeaders(IP_TASKS_DAILY_LIMIT, IP_TASKS_DAILY_LIMIT - taskDaily.count, secondsToUtcMidnight()),
    };
    sendJSON(res, 202, taskResponse, taskHeaders);
    storeIdempotent(idem, 202, taskResponse, { Location: taskHeaders.Location });
    return;
  }

  // GET /api/v1/tasks — admin list
  if (req.method === 'GET' && !id) {
    if (!isAdmin(req)) {
      sendJSON(res, 401, { error: 'unauthorized', message: 'Admin key required (X-Admin-Key header).' });
      return;
    }
    const tasks = await readTasks();
    // The operator just loaded the inbox — stamp any not-yet-seen task
    // (mirrors the production seen_by_operator_at behavior).
    const seenAt = new Date().toISOString();
    let stamped = false;
    tasks.forEach((t) => {
      if (!t.seen_by_operator_at) { t.seen_by_operator_at = seenAt; stamped = true; }
    });
    if (stamped) await writeTasks(tasks);
    sendJSON(res, 200, { count: tasks.length, tasks: tasks.slice().reverse() });
    return;
  }

  // GET /api/v1/tasks/:id — public status lookup
  if (req.method === 'GET' && id) {
    const tasks = await readTasks();
    const task = tasks.find((t) => t.task_id === id.toUpperCase());
    if (!task) {
      sendJSON(res, 404, { error: 'task_not_found', message: `No task with id ${id}.` });
      return;
    }
    sendJSON(res, 200, publicTask(task));
    return;
  }

  // PATCH /api/v1/tasks/:id — admin status update
  if (req.method === 'PATCH' && id) {
    if (!isAdmin(req)) {
      sendJSON(res, 401, { error: 'unauthorized', message: 'Admin key required (X-Admin-Key header).' });
      return;
    }
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      sendJSON(res, 400, { error: 'invalid_json', message: 'Request body must be valid JSON.' });
      return;
    }
    // Retired values stay accepted here, folded onto their survivor.
    if (body.status && !TASK_STATUSES.includes(body.status) && !LEGACY_STATUS_MAP[body.status]) {
      sendJSON(res, 422, { error: 'validation_failed', details: [`status must be one of: ${TASK_STATUSES.join(', ')}`] });
      return;
    }
    const tasks = await readTasks();
    const task = tasks.find((t) => t.task_id === id.toUpperCase());
    if (!task) {
      sendJSON(res, 404, { error: 'task_not_found', message: `No task with id ${id}.` });
      return;
    }
    // Heal a pre-v1.8.0 row in place; history keeps the original entries.
    task.status = canonicalStatus(task.status);
    if (body.status) {
      const next = canonicalStatus(body.status);
      if (!canTransition(task.status, next)) {
        sendJSON(res, 409, {
          error: 'invalid_transition',
          message: `Cannot move a task from ${task.status} to ${next}. The lifecycle is ${STATUS_ORDER.join(' → ')}, with rejected reachable from any open state; delivered and rejected are final.`,
        });
        return;
      }
      if (next !== task.status) {
        task.status = next;
        task.status_history.push({ status: next, at: new Date().toISOString() });
      }
    }
    if (body.eta !== undefined) {
      if (body.eta !== null && Number.isNaN(Date.parse(body.eta))) {
        sendJSON(res, 422, { error: 'validation_failed', details: ['eta must be an ISO 8601 datetime string or null.'] });
        return;
      }
      task.eta = body.eta;
    }
    if (body.operator_notes !== undefined) {
      task.operator_notes = body.operator_notes ? String(body.operator_notes).slice(0, 2000) : null;
    }
    // Sign the deliverable once it is delivered. Re-signed if the text is
    // later edited: a receipt that no longer matches the deliverable would
    // be worse than none, so the hash always tracks reality.
    if (task.status === 'delivered') {
      const deliverable = task.operator_notes || '';
      const currentHash = deliverable
        ? crypto.createHash('sha256').update(deliverable, 'utf8').digest('hex')
        : null;
      if (currentHash && currentHash !== task.deliverable_sha256) {
        const issued = issueReceipt(task);
        if (issued) {
          task.receipt = issued.receipt;
          task.deliverable_sha256 = issued.sha256;
          task.receipt_issued_at = new Date().toISOString();
        }
      }
    }
    task.updated_at = new Date().toISOString();
    await writeTasks(tasks);
    sendJSON(res, 200, task);
    return;
  }

  sendJSON(res, 405, { error: 'method_not_allowed', message: 'See /api for supported methods.' });
}

/* ------------------------------------------------------------------ */
/* Static files                                                        */
/* ------------------------------------------------------------------ */

/* Clean URLs: /services → /services.html, / → /index.html */
function resolveStaticPath(pathname) {
  let clean = decodeURIComponent(pathname).replace(/\/+$/, '') || '/';
  if (clean === '/') clean = '/index.html';
  const candidate = path.normalize(path.join(PUBLIC_DIR, clean));
  if (!candidate.startsWith(PUBLIC_DIR)) return null; // path traversal guard
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  if (!path.extname(candidate) && fs.existsSync(candidate + '.html')) return candidate + '.html';
  return null;
}

/* ---- Markdown content negotiation (v1.8.0) — mirrors functions/index.js *
 * The homepage answers Accept: text/markdown with public/index.md, and
 * 404s carry a markdown recovery body for non-browser callers. In
 * production the hosting ** rewrite routes these paths to the api
 * function; here the same logic runs inline in serveStatic.
 */
const HTML_SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function acceptQ(header) {
  let md = 0;
  let html = 0;
  let wild = 0;
  for (const part of String(header || '*/*').split(',')) {
    const [type, ...params] = part.trim().split(';');
    let q = 1;
    for (const p of params) {
      const m = /^q=([0-9.]+)$/i.exec(p.trim());
      if (m) q = Number(m[1]) || 0;
    }
    const t = type.trim().toLowerCase();
    if (t === 'text/markdown') md = Math.max(md, q);
    else if (t === 'text/html' || t === 'application/xhtml+xml') html = Math.max(html, q);
    else if (t === 'text/*' || t === '*/*') wild = Math.max(wild, q);
  }
  return { md, html, wild };
}

function serveNegotiated(req, res, name, status) {
  const { md, html, wild } = acceptQ(req.headers.accept);
  // s-maxage mirrors production (CDN edge caching for the homepage) —
  // see the reachability note in functions/index.js serveNegotiated.
  const common = {
    Vary: 'Accept',
    'Cache-Control': status === 200
      ? 'public, max-age=0, s-maxage=600, stale-while-revalidate=86400'
      : 'no-cache',
  };
  const chooseMd = (md > 0 && md >= html) || (status === 404 && html === 0 && wild > 0);
  if (chooseMd) {
    res.writeHead(status, {
      ...common,
      'Content-Type': 'text/markdown; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(fs.readFileSync(path.join(PUBLIC_DIR, `${name}.md`), 'utf8'));
    return;
  }
  if (html > 0 || wild > 0) {
    res.writeHead(status, { ...common, ...HTML_SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(PUBLIC_DIR, `${name}.html`), 'utf8'));
    return;
  }
  res.writeHead(406, { ...common, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not acceptable. Available representations: text/html, text/markdown.\n');
}

function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/';
  if (pathname === '/' || pathname === '/index.html') {
    // ?mode=agent — mirrors functions/index.js: the machine view of the
    // homepage regardless of the Accept header.
    if (url.searchParams.get('mode') === 'agent') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'index.md'), 'utf8'));
      return;
    }
    serveNegotiated(req, res, 'index', 200);
    return;
  }
  const filePath = resolveStaticPath(url.pathname);
  if (!filePath) {
    serveNegotiated(req, res, '404', 404);
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const isAsset = ['.css', '.js', '.svg', '.png', '.ico'].includes(ext);
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': isAsset ? 'public, max-age=300, must-revalidate' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    // Security headers — kept identical to firebase.json (production).
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
  // Machine-readable files must be fetchable by agents from anywhere.
  if (ext === '.json' || ext === '.txt' || ext === '.xml') {
    headers['Access-Control-Allow-Origin'] = '*';
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

ensureDataDir();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/v1/')) {
      await handleAPI(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    console.error('server error:', err);
    if (!res.headersSent) {
      sendJSON(res, 500, { error: 'internal_error', message: 'Unexpected server error.' });
    }
  }
});

server.listen(PORT, () => {
  console.log(`Human For AI running → http://localhost:${PORT}`);
  console.log(`Agent manifest    → http://localhost:${PORT}/agent.json`);
  console.log(`Admin dashboard   → http://localhost:${PORT}/admin  (key: ${ADMIN_KEY})`);
});
