/**
 * Human For AI — production API on Cloud Functions + Firestore.
 * API version: 1.9.0 (message threads + signed webhooks; 202 async jobs).
 *
 * Mirrors the local server.js API exactly (same routes, same validation,
 * same responses), with Firestore replacing data/*.json:
 *   POST   /api/v1/tasks            submit a task (agents + human form)
 *   GET    /api/v1/tasks/:id        public status lookup (ID acts as token)
 *   GET    /api/v1/tasks            list all tasks        (admin key)
 *   PATCH  /api/v1/tasks/:id        update status / notes (admin key)
 *   POST   /api/v1/messages         structured contact channel
 *   GET    /api/v1/messages         message inbox         (admin key)
 *   GET    /api/v1/health           liveness check
 *
 * Config: functions/.env → ADMIN_KEY, NOTIFY_EMAIL
 * Notifications land in Cloud Logging (console.log) and the
 * `notifications` collection; wire a real email provider in notify().
 */

'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const { track } = require('./track');
const { clientIpFromXff } = require('./client-ip');

/* Fail closed: ADMIN_KEY gates every admin endpoint (task list, PATCH,
 * message inbox, blocklist) and the internal rate-limit bypass. A deploy
 * without it must refuse to start rather than silently fall back to a
 * guessable default. index.js is the sole functions entrypoint (mcp and
 * the kill switch re-export through it), so this covers everything. */
const ADMIN_KEY = process.env.ADMIN_KEY;
/* FUNCTIONS_CONTROL_API marks the Firebase CLI's deploy-time discovery
 * phase, which loads this module in a sanitized environment with no
 * .env vars — the throw there would block every deploy. Real runtime
 * (cold start on Cloud Functions, or local server.js) never has that
 * flag, so the fail-closed guarantee is unchanged where it matters. */
if (!ADMIN_KEY && process.env.FUNCTIONS_CONTROL_API !== 'true') {
  throw new Error('ADMIN_KEY is not set — add it to functions/.env before deploying.');
}
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || '';

// Constant-time comparison so the key can't be recovered byte-by-byte
// from response timing.
function keyMatches(candidate) {
  const a = Buffer.from(String(candidate ?? ''));
  const b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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

/* ---- Task lifecycle (v1.8.0) --------------------------------------- *
 * submitted → accepted → delivered, plus the terminal `rejected`.
 *
 * `under_review` and `in_progress` were retired: `under_review` was a
 * manual, less precise duplicate of seen_by_operator_at (which the
 * service stamps automatically), and `in_progress` carried nothing
 * `accepted` did not already carry. The signed receipt never referenced
 * either one — its timeline has always been submitted/seen/accepted/
 * delivered — so the trust artifact is unchanged by the removal.
 *
 * Both retired values are still accepted on PATCH and folded onto their
 * surviving equivalent, so stored automation and older operator UIs keep
 * working. Tasks still holding a retired status are normalised on read
 * and healed on the next write; status_history keeps the original
 * entries, since it is the audit trail of what actually happened.
 */
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

// The forward-only path. `rejected` sits outside it: reachable from any
// open state, terminal once set.
const STATUS_ORDER = ['submitted', 'accepted', 'delivered'];

function canonicalStatus(status) {
  return LEGACY_STATUS_MAP[status] || status;
}

/**
 * Forward-only transitions. A task advances along STATUS_ORDER or is
 * rejected while still open; it never moves backwards, and `delivered`
 * and `rejected` are terminal.
 *
 * Both arguments must already be canonical. Without this guard a stray
 * dashboard click could rewind an accepted task — which strands `eta`,
 * as that is only ever set on the accept transition.
 */
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
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/* A task_id is a bearer credential: GET /api/v1/tasks/{id} is
 * unauthenticated and returns the deliverable, so the id is the only
 * thing protecting it. 8 random bytes (64 bits) rather than 4 (32) —
 * at 32 bits the odds of a blind guess hitting a live task scale with
 * how many tasks exist, and there is no rate limit on reads to slow a
 * guesser down. Nothing parses or validates the id's shape, so shorter
 * ids issued before this stay valid indefinitely. */
function generateId(prefix) {
  const year = new Date().getFullYear();
  const rand = crypto.randomBytes(8).toString('hex').toUpperCase();
  return `${prefix}-${year}-${rand}`;
}

// Duplicate detection key for long text fields. The raw text can exceed
// Firestore's 1500-byte indexed-value limit (description/message allow up
// to 5000 chars), so equality lookups run on this fixed-length hash and
// the raw fields carry index exemptions (firestore.indexes.json).
function textHash(text) {
  return crypto.createHash('sha256').update(String(text).trim()).digest('hex');
}

/* ---- Signed deliverable receipts (v1.7.0) ------------------------- *
 * When a task is delivered, the service issues a compact JWS (EdDSA,
 * Ed25519) binding the deliverable's sha256 to the task's lifecycle
 * timestamps. Anyone can verify it offline against the public key at
 * /.well-known/jwks.json — no account, no call back to us.
 *
 * What it proves: the deliverable text is byte-identical to what was
 * delivered, and the receipt was issued by humanforai.dev.
 * What it does NOT prove: that the timestamps are honest — they are our
 * own assertion, signed. External anchoring is a separate, later step;
 * the docs say so plainly rather than implying more than this delivers.
 *
 * The private key lives only in functions/.env (RECEIPT_SIGNING_KEY,
 * base64 PKCS8). Signing is best-effort: a missing or broken key logs
 * and returns null so delivery itself never fails on receipt trouble.
 */
const RECEIPT_SIGNING_KEY = process.env.RECEIPT_SIGNING_KEY || '';
const RECEIPT_KEY_ID = process.env.RECEIPT_KEY_ID || 'receipts-2026-07';
const RECEIPT_VERSION = 1;

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// First timestamp for a given status in the task's own history. History
// entries are matched canonically, so a legacy task that only ever went
// submitted → in_progress → delivered still yields an accepted_at.
function firstStatusAt(task, status) {
  const want = canonicalStatus(status);
  const hit = (task.status_history || []).find((h) => canonicalStatus(h.status) === want);
  return hit ? hit.at : null;
}

/**
 * Issue a receipt for a delivered task. Returns { receipt, sha256 } or
 * null when signing is unavailable.
 *
 * The canonical deliverable is operator_notes — the one field that holds
 * the delivered text for both paths (status_poll agents read it directly;
 * for email deliveries the operator writes the same text there, so every
 * task has a hashable deliverable of record).
 */
function issueReceipt(task) {
  if (!RECEIPT_SIGNING_KEY) {
    console.warn('receipt signing skipped — RECEIPT_SIGNING_KEY not set');
    return null;
  }
  const deliverable = task.operator_notes || '';
  if (!deliverable) return null;
  try {
    const key = crypto.createPrivateKey({
      key: Buffer.from(RECEIPT_SIGNING_KEY, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
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

function sendJSON(res, status, data, headers) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'no-store');
  // Documented submission budgets on every API response (see the
  // RateLimit headers block below) so agents can plan before they hit
  // a limit; the dynamic RateLimit trio rides on submissions and 429s.
  res.set('RateLimit-Policy', RATELIMIT_POLICY);
  if (headers) res.set(headers);
  res.status(status).json(data);
}

/* ---- Agentic web surface (v1.8.0) --------------------------------- *
 * The homepage and 404s are served here rather than statically so they
 * can do markdown content negotiation (the acceptmarkdown.com
 * convention): a client sending Accept: text/markdown gets the markdown
 * twin of the page, browsers get HTML, and Vary: Accept keeps caches
 * honest. Hosting routes every path with no static file to this
 * function (the ** rewrite), which is also what makes 404s real HTTP
 * 404s with a recovery body instead of an app shell.
 *
 * Page files are synced from public/ (the single source) into
 * functions/pages/ by copy-agent-manifest.js at predeploy.
 */
const PAGES_DIR = path.join(__dirname, 'pages');
const pageCache = new Map();
function pageFile(name) {
  if (!pageCache.has(name)) {
    pageCache.set(name, fs.readFileSync(path.join(PAGES_DIR, name), 'utf8'));
  }
  return pageCache.get(name);
}

// Mirrors the firebase.json header config — hosting headers are not
// guaranteed on rewritten responses, and an HTML page served without
// its CSP would silently drop the site's security baseline.
const HTML_SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

/**
 * Effective quality values for text/markdown and text/html from an
 * Accept header. Explicit types beat wildcards: markdown is chosen only
 * when the client names text/markdown at a q at least as high as
 * html's, so a browser's text/html always wins and a bare
 * `Accept: text/markdown` always gets markdown.
 */
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

/**
 * Serve `name` (a functions/pages basename without extension) as
 * markdown or HTML per the Accept header. Returns which variant went
 * out ('md' | 'html' | '406'). On 404s a wildcard Accept (curl, fetch,
 * agents) gets markdown — browsers ask for text/html explicitly and
 * still get the HTML page.
 */
function serveNegotiated(req, res, name, status) {
  const { md, html, wild } = acceptQ(req.get('accept'));
  res.set('Vary', 'Accept');
  /* s-maxage lets the Hosting CDN serve the homepage from the edge.
   * Besides speed, this matters for reachability: Google's frontend
   * rejects requests that spoof Google-crawler user agents (Googlebot,
   * Google-Extended) before they reach any function — a 500 the origin
   * never sees. Served from CDN cache, those requests succeed. Browsers
   * still revalidate every load (max-age=0), and a deploy clears the
   * CDN cache, so freshness matches the old static behavior. 404s stay
   * uncached. */
  res.set('Cache-Control', status === 200
    ? 'public, max-age=0, s-maxage=600, stale-while-revalidate=86400'
    : 'no-cache');
  const chooseMd = (md > 0 && md >= html) || (status === 404 && html === 0 && wild > 0);
  if (chooseMd) {
    res.set({
      'Content-Type': 'text/markdown; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    });
    res.status(status).send(pageFile(`${name}.md`));
    return 'md';
  }
  if (html > 0 || wild > 0) {
    res.set({ ...HTML_SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
    res.status(status).send(pageFile(`${name}.html`));
    return 'html';
  }
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.status(406).send('Not acceptable. Available representations: text/html, text/markdown.\n');
  return '406';
}

// Header only — never a query param, so the key can't leak into request
// logs, browser history, or Referer headers.
function isAdmin(req) {
  return keyMatches(req.get('x-admin-key'));
}

async function notify(kind, id, detail) {
  const line = `[${new Date().toISOString()}] ${kind} ${id} ${detail} → notify ${NOTIFY_EMAIL}`;
  console.log(line);
  try {
    await db.collection('notifications').add({
      kind, ref_id: id, detail, notify_email: NOTIFY_EMAIL,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('notification write failed:', err.message);
  }
}

/**
 * Queue an email for the "Trigger Email" Firebase extension
 * (firebase/firestore-send-email), which watches the `mail` collection
 * and delivers via SMTP.
 *
 * Hard daily cap (EMAIL_DAILY_LIMIT, default 100): a transactional
 * counter in counters/mail-YYYY-MM-DD guarantees no more than the limit
 * is ever queued per UTC day — flood-proof by construction. Skipped
 * emails are still recorded in the notifications collection, and the
 * task/message itself is always stored regardless.
 */
const EMAIL_DAILY_LIMIT = Number(process.env.EMAIL_DAILY_LIMIT) || 100;
const TASKS_DAILY_LIMIT = Number(process.env.TASKS_DAILY_LIMIT) || 300;
const MESSAGES_DAILY_LIMIT = Number(process.env.MESSAGES_DAILY_LIMIT) || 300;
const IP_TASKS_DAILY_LIMIT = Number(process.env.IP_TASKS_DAILY_LIMIT) || 5;
const IP_MESSAGES_DAILY_LIMIT = Number(process.env.IP_MESSAGES_DAILY_LIMIT) || 5;
const IP_TASKS_HOURLY_LIMIT = Number(process.env.IP_TASKS_HOURLY_LIMIT) || 3;
const IP_MESSAGES_HOURLY_LIMIT = Number(process.env.IP_MESSAGES_HOURLY_LIMIT) || 3;
// No-mailbox path: tasks delivered via status polling instead of email.
// Deliberately tiny budget — one door for autonomous agents, not a spam
// bypass. See the delivery field in validateTaskPayload.
const IP_POLL_TASKS_DAILY_LIMIT = Number(process.env.IP_POLL_TASKS_DAILY_LIMIT) || 1;

/* ---- RateLimit response headers (v1.8.0) --------------------------- *
 * Standard fields (draft-ietf-httpapi-ratelimit-headers) so agents can
 * self-throttle instead of discovering limits by tripping them: every
 * API response documents the budgets in RateLimit-Policy, successful
 * submissions carry the per-client daily trio, and every 429 carries
 * Retry-After. Documented at /developers#rate-limits.
 */
const READS_HOURLY_LIMIT = 1000; // per instance — soft backstop for read GETs

const RATELIMIT_POLICY = [
  `"tasks-per-client-hourly";q=${IP_TASKS_HOURLY_LIMIT};w=3600`,
  `"tasks-per-client-daily";q=${IP_TASKS_DAILY_LIMIT};w=86400`,
  `"messages-per-client-hourly";q=${IP_MESSAGES_HOURLY_LIMIT};w=3600`,
  `"messages-per-client-daily";q=${IP_MESSAGES_DAILY_LIMIT};w=86400`,
  `"reads-per-instance-hourly";q=${READS_HOURLY_LIMIT};w=3600`,
].join(', ');

// Soft per-instance read budget: public GET endpoints answer with the
// dynamic RateLimit trio (draft-ietf-httpapi-ratelimit-headers) so agents
// see live budget state on reads too, not only on submissions. Honest:
// the counter is enforced (429 past the limit), scoped per instance.
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

/**
 * Per-client abuse guard: submissions are also capped per calling
 * address per UTC day and hour (security review item 3). The counter key
 * is a salted hash — the raw IP is never stored anywhere (see /privacy).
 *
 * The MCP function proxies tool calls through the REST API, so from here
 * every MCP client would share the proxy's egress address. The MCP hop
 * therefore forwards the real caller in X-Client-IP, authenticated with
 * X-Internal-Auth — trusted only with the correct key, so external
 * callers cannot spoof their way into a fresh bucket.
 */
function clientIpHash(req) {
  let ip;
  if (keyMatches(req.get('x-internal-auth')) && req.get('x-client-ip')) {
    ip = req.get('x-client-ip');
  } else {
    ip = clientIpFromXff(req) || req.ip || 'unknown';
  }
  return crypto.createHash('sha256').update('hfai-ip-salt:' + ip).digest('hex').slice(0, 16);
}

async function isBlocked(ipHash) {
  const doc = await db.collection('blocklist').doc(ipHash).get();
  return doc.exists;
}

/* ---- Idempotency-Key support (v1.8.1) ------------------------------ *
 * POST /tasks and POST /messages accept an optional Idempotency-Key
 * header. The first 201 response is stored for 24h keyed by
 * (client, key); a retry with the same key and byte-identical payload
 * replays that stored response (with Idempotency-Replayed: true)
 * without re-running rate limits, notifications, or duplicate guards —
 * a network-failed retry is free and safe. The same key with a
 * different payload is a client bug and returns 422. Records are
 * scoped per client (the salted address hash), so keys cannot collide
 * across callers. Stale records (>24h) are simply overwritten.
 */
const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;
const IDEMPOTENCY_KEY_MAX = 200;

/**
 * Handles the Idempotency-Key phase of a submission. Returns
 * { replayed: true } when a response already went out (stored replay,
 * or a key-validation error) — the caller must stop. Otherwise returns
 * { replayed: false, ref, requestHash } where ref is null when no key
 * was sent.
 */
async function idempotencyPhase(req, res, ipHash, body) {
  const key = String(req.get('idempotency-key') || '').trim();
  if (!key) return { replayed: false, ref: null, requestHash: null };
  if (key.length > IDEMPOTENCY_KEY_MAX) {
    sendJSON(res, 422, {
      error: 'validation_failed',
      details: [`Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX} characters.`],
    });
    return { replayed: true };
  }
  const requestHash = textHash(req.path + '\n' + JSON.stringify(body));
  const docId = crypto.createHash('sha256')
    .update(`hfai-idem:${ipHash}:${key}`).digest('hex').slice(0, 32);
  const ref = db.collection('idempotency').doc(docId);
  const snap = await ref.get();
  if (snap.exists) {
    const rec = snap.data();
    if (Date.now() - Date.parse(rec.created_at) < IDEMPOTENCY_TTL_MS) {
      if (rec.request_hash !== requestHash) {
        sendJSON(res, 422, {
          error: 'idempotency_key_reuse',
          message: 'This Idempotency-Key was already used with a different payload. Use a fresh key for each distinct request.',
        });
        return { replayed: true };
      }
      sendJSON(res, rec.status, rec.response, {
        'Idempotency-Replayed': 'true',
        ...(rec.headers || {}),
      });
      return { replayed: true };
    }
  }
  return { replayed: false, ref, requestHash };
}

// Best-effort: a failed store must never fail the request itself.
async function storeIdempotent(idem, status, response, headers) {
  if (!idem || !idem.ref) return;
  try {
    await idem.ref.set({
      request_hash: idem.requestHash,
      status,
      response,
      headers: headers || null,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('idempotency store failed:', err.message);
  }
}

/**
 * MX check: the email's domain must actually run a mail service, or the
 * deliverable could never arrive. NXDOMAIN / no-MX-records → reject;
 * transient DNS failures fail open so real users are never locked out by
 * infrastructure hiccups. Results are cached per instance for 6h.
 */
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

/**
 * Transactional daily counter. Increments and returns
 * { allowed: true, count } while under `limit`; { allowed: false, count }
 * once the day's budget is spent. The count feeds the RateLimit-Remaining
 * header without a second read. One doc per kind per UTC day — a flood of
 * concurrent requests cannot race past the limit. These caps keep
 * worst-case Firestore writes far below the Blaze free quota (20K/day)
 * no matter what hits the public endpoints.
 */
async function underDailyLimit(kind, limit) {
  const day = new Date().toISOString().slice(0, 10);
  const counterRef = db.collection('counters').doc(`${kind}-${day}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const count = snap.exists ? (snap.data().count || 0) : 0;
    if (count >= limit) return { allowed: false, count };
    tx.set(counterRef, { count: count + 1, day }, { merge: true });
    return { allowed: true, count: count + 1 };
  });
}

/**
 * WhatsApp push to the operator's own phone via Meta's WhatsApp Business
 * Cloud API — the fastest "a human noticed your task" channel.
 *
 * DORMANT (2026-07-16): built and verified working up to Meta's delivery
 * gate, then parked. Meta blocks ALL business-initiated messages until the
 * business passes verification (legal documents, multi-day review), has a
 * payment method on file, and completes its profile — confirmed via
 * GET /{waba-id}?fields=health_status → can_send_message: BLOCKED
 * (errors 141010, 141006, 131000). Sends fail silently: the API returns
 * "accepted" and the webhook later reports status=failed, code 131031
 * "Business Account locked". Email alerts (queueEmail) cover this need.
 * To revive: clear those blockers, then set META_WA_TOKEN and
 * META_WA_PHONE_NUMBER_ID in .env (WHATSAPP_PHONE is already set).
 * Business-initiated messages must use an approved template: we send the
 * template META_WA_TEMPLATE (default operator_alert, body "Human For AI:
 * {{1}}") with the alert as its single body parameter. Template body
 * parameters reject newlines/tabs, so the text is flattened to one line.
 * Fire-and-forget: never throws, never blocks the request outcome.
 * Skipped entirely unless WHATSAPP_PHONE + META_WA_TOKEN +
 * META_WA_PHONE_NUMBER_ID are all set. Same flood-proof daily counter
 * pattern as email (WHATSAPP_DAILY_LIMIT, default 50).
 */
const WHATSAPP_PHONE = process.env.WHATSAPP_PHONE || '';
const META_WA_TOKEN = process.env.META_WA_TOKEN || '';
const META_WA_PHONE_NUMBER_ID = process.env.META_WA_PHONE_NUMBER_ID || '';
const META_WA_TEMPLATE = process.env.META_WA_TEMPLATE || 'operator_alert';
const META_WA_TEMPLATE_LANG = process.env.META_WA_TEMPLATE_LANG || 'en';
const META_WA_VERIFY_TOKEN = process.env.META_WA_VERIFY_TOKEN || '';
const WHATSAPP_DAILY_LIMIT = Number(process.env.WHATSAPP_DAILY_LIMIT) || 50;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_DAILY_LIMIT = Number(process.env.TELEGRAM_DAILY_LIMIT) || 50;

async function notifyWhatsApp(text) {
  if (!WHATSAPP_PHONE || !META_WA_TOKEN || !META_WA_PHONE_NUMBER_ID) return;
  try {
    const { allowed } = await underDailyLimit('whatsapp', WHATSAPP_DAILY_LIMIT);
    if (!allowed) {
      console.warn(`whatsapp daily limit (${WHATSAPP_DAILY_LIMIT}/day) reached — ping skipped`);
      return;
    }
    const oneLine = text.replace(/\s*[\r\n\t]+\s*/g, ' · ').replace(/ {4,}/g, ' ').slice(0, 900);
    const res = await fetch(`https://graph.facebook.com/v20.0/${META_WA_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${META_WA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: WHATSAPP_PHONE.replace(/[^0-9]/g, ''),
        type: 'template',
        template: {
          name: META_WA_TEMPLATE,
          language: { code: META_WA_TEMPLATE_LANG },
          components: [{ type: 'body', parameters: [{ type: 'text', text: oneLine }] }],
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('whatsapp send failed:', res.status, detail.slice(0, 300));
    }
  } catch (err) {
    console.error('whatsapp send failed:', err.message);
  }
}

async function notifyTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const { allowed } = await underDailyLimit('telegram', TELEGRAM_DAILY_LIMIT);
    if (!allowed) {
      console.warn(`telegram daily limit (${TELEGRAM_DAILY_LIMIT}/day) reached — ping skipped`);
      return;
    }
    // Plain text on purpose: parse_mode would make sends fail on unescaped
    // characters in agent-supplied task descriptions.
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('telegram send failed:', res.status, detail.slice(0, 300));
    }
  } catch (err) {
    console.error('telegram send failed:', err.message);
  }
}

async function queueEmail(subject, text) {
  try {
    const { allowed } = await underDailyLimit('mail', EMAIL_DAILY_LIMIT);
    if (!allowed) {
      console.warn(`email daily limit (${EMAIL_DAILY_LIMIT}/day) reached — email skipped: ${subject}`);
      await db.collection('notifications').add({
        kind: 'EMAIL_SKIPPED_DAILY_LIMIT',
        detail: subject,
        created_at: new Date().toISOString(),
      });
      return;
    }
    await db.collection('mail').add({
      to: NOTIFY_EMAIL,
      message: { subject, text },
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('email queue failed:', err.message);
  }
}

/* ------------------------------------------------------------------ */
/* Validation — identical rules to server.js                           */
/* ------------------------------------------------------------------ */

// Reserved example domains (RFC 2606) and TLDs that can never receive
// mail. A placeholder address means the deliverable could never reach
// the requester, so it is rejected up front with an explanation.
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
    task_id: generateId('HFAI'),
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

function publicTask(task) {
  const { contact_email, operator_notes, client_ip_hash, ...rest } = task;
  // A row written before v1.8.0 may still carry a retired status; never
  // emit one, so `status` always matches the documented enum.
  return { ...rest, status: canonicalStatus(rest.status), operator_notes: operator_notes || undefined };
}

/* ---- Message threads & signed webhooks (v1.9.0) -------------------- *
 * Every message is a thread: submission returns a thread_url plus an
 * access_token (shown once). GET the thread with the token to read the
 * operator's reply without a mailbox; POST to it to follow up. reply_to
 * may be an https URL instead of an email — operator replies are then
 * pushed there as a signed webhook (HMAC-SHA256 over
 * "<timestamp>.<raw body>", keyed on the thread's access_token).       */

const WEBHOOK_TIMEOUT_MS = 10000;
const THREAD_MAX_REPLIES = 40;

function isHttpsWebhook(value) {
  return typeof value === 'string' && /^https:\/\//i.test(value);
}

// SSRF guard for webhook targets: https only, default port, no embedded
// credentials, and a public DNS hostname — never an IP literal or an
// internal-looking name. Redirects are refused at delivery time too.
function webhookUrlError(raw) {
  if (String(raw).length > 500) return 'reply_to webhook URL must be under 500 characters.';
  let u;
  try {
    u = new URL(raw);
  } catch {
    return 'reply_to webhook must be a valid https URL.';
  }
  if (u.protocol !== 'https:') return 'reply_to webhook must use https.';
  if (u.username || u.password) return 'reply_to webhook must not embed credentials.';
  if (u.port && u.port !== '443') return 'reply_to webhook must use the default https port.';
  const host = u.hostname.toLowerCase();
  if (host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return 'reply_to webhook must use a DNS hostname, not an IP address.';
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa') || !host.includes('.')) {
    return 'reply_to webhook hostname must be a public host.';
  }
  return null;
}

function tokensMatch(supplied, stored) {
  if (typeof supplied !== 'string' || typeof stored !== 'string' || !supplied || !stored) return false;
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(stored).digest();
  return crypto.timingSafeEqual(a, b);
}

function threadToken(req, body) {
  const auth = String(req.get('authorization') || '');
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  if (typeof req.query.token === 'string' && req.query.token) return req.query.token;
  if (body && typeof body.token === 'string') return body.token;
  return '';
}

// The thread as its owner may see it: no ip hash, no content hash, no
// token echo, no raw reply_to.
function publicThread(m) {
  return {
    message_id: m.message_id,
    status: m.answered_at ? 'answered' : 'received',
    created_at: m.created_at,
    from: m.from,
    subject: m.subject,
    message: m.message,
    replies: (m.replies || []).map((r) => ({ author: r.author, message: r.message, created_at: r.created_at })),
    reply_count: (m.replies || []).length,
    last_reply_at: m.replies && m.replies.length ? m.replies[m.replies.length - 1].created_at : null,
    reply_channel: m.webhook ? 'webhook' : (m.reply_to ? 'email' : 'thread_only'),
    ...(m.webhook && m.webhook.last_delivery && { webhook_last_delivery: m.webhook.last_delivery }),
    note: 'An empty replies list means the operator has not answered yet — poll occasionally, not in a loop. Operator replies land here' +
      (m.webhook ? ' and are pushed to your webhook, signed.' : (m.reply_to ? ' and go to your reply_to mailbox.' : '.')),
  };
}

// Web Bot Auth: the outbound webhook request is also signed as an HTTP
// Message Signature (RFC 9421, tag "web-bot-auth") with the same Ed25519
// key that signs receipts, so a receiver can verify WHO is calling, not only
// that the body is intact. Public key: /.well-known/http-message-signatures-directory
// (keyid = RFC 7638 JWK thumbprint). Failure here never blocks delivery.
function webBotAuthHeaders(url) {
  if (!RECEIPT_SIGNING_KEY) return {};
  try {
    const key = crypto.createPrivateKey({ key: Buffer.from(RECEIPT_SIGNING_KEY, 'base64'), format: 'der', type: 'pkcs8' });
    const pub = crypto.createPublicKey(key).export({ format: 'jwk' });
    const keyid = crypto.createHash('sha256').update(JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x })).digest('base64url');
    const authority = new URL(url).host.toLowerCase();
    const agent = '"humanforai.dev"';
    const created = Math.floor(Date.now() / 1000);
    const params = `("@authority" "signature-agent");created=${created};expires=${created + 300};keyid="${keyid}";alg="ed25519";nonce="${crypto.randomBytes(16).toString('base64')}";tag="web-bot-auth"`;
    const base = `"@authority": ${authority}
"signature-agent": ${agent}
"@signature-params": ${params}`;
    const sig = crypto.sign(null, Buffer.from(base, 'utf8'), key).toString('base64');
    return { 'Signature-Agent': agent, 'Signature-Input': `sig1=${params}`, Signature: `sig1=:${sig}:` };
  } catch (err) {
    console.warn('web-bot-auth signing skipped:', err.message);
    return {};
  }
}

async function deliverWebhook(m, event, data) {
  if (!m.webhook || !m.webhook.url) return null;
  const body = JSON.stringify({ event, message_id: m.message_id, sent_at: new Date().toISOString(), data });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', m.access_token).update(`${ts}.${body}`).digest('hex');
  try {
    const r = await fetch(m.webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-HumanForAI-Timestamp': ts,
        'X-HumanForAI-Signature': `sha256=${sig}`,
        'User-Agent': 'humanforai-webhook/1.0 (+https://humanforai.dev/api)',
        ...webBotAuthHeaders(m.webhook.url),
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    return { at: new Date().toISOString(), event, status: r.status, ok: r.ok };
  } catch (err) {
    return { at: new Date().toISOString(), event, status: 0, ok: false, error: String(err.message || err).slice(0, 200) };
  }
}

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
  // Required since v1.5.0 (anti-abuse): without a reply channel the
  // operator has no way to answer, so the message serves no purpose.
  // Since v1.9.0 the channel may be an email OR an https webhook URL —
  // and every message is also a pollable thread regardless.
  if (body.reply_to === undefined || body.reply_to === null || body.reply_to === '') {
    errors.push('reply_to is required — an email address, or an https URL to receive signed webhook pushes. ' +
      'Either way the reply is also readable in the message thread (thread_url + access_token in the response).');
  } else if (isHttpsWebhook(body.reply_to)) {
    const webhookErr = webhookUrlError(body.reply_to);
    if (webhookErr) errors.push(webhookErr);
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.reply_to))) {
    errors.push('reply_to must be a valid email address or an https webhook URL.');
  } else {
    const placeholder = placeholderEmailError(body.reply_to, 'reply_to');
    if (placeholder) errors.push(placeholder);
  }
  return errors;
}

function buildMessage(body, ipHash) {
  const webhook = isHttpsWebhook(body.reply_to);
  return {
    client_ip_hash: ipHash || null,
    message_id: generateId('MSG'),
    from: body.from ? String(body.from).slice(0, 200) : 'unspecified',
    subject: body.subject ? String(body.subject).slice(0, 200) : null,
    message: String(body.message).trim(),
    message_hash: textHash(body.message),
    reply_to: webhook ? null : (body.reply_to || null),
    source: body.source === 'web_form' ? 'web_form' : 'api',
    created_at: new Date().toISOString(),
    // Thread fields (v1.9.0): the access_token is returned once at
    // submission and never shown again.
    access_token: crypto.randomBytes(24).toString('base64url'),
    replies: [],
    answered_at: null,
    webhook: webhook ? { url: String(body.reply_to), last_delivery: null } : null,
  };
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, Idempotency-Key',
      'Access-Control-Expose-Headers': 'Location, Idempotency-Replayed, Retry-After, RateLimit-Policy, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset',
      'Access-Control-Max-Age': '86400',
    });
    res.status(204).send('');
    return;
  }

  const parts = req.path.split('/').filter(Boolean); // ['api','v1','tasks',...]
  const resource = parts[2];
  const id = parts[3] ? parts[3].toUpperCase() : undefined;
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};

  try {
    // GET /agent.json — served here (not statically) so every manifest
    // fetch is visible in traffic analytics with its user-agent.
    if (req.path === '/agent.json' && (req.method === 'GET' || req.method === 'HEAD')) {
      const manifest = fs.readFileSync(path.join(__dirname, 'agent.json'), 'utf8');
      await track('manifest_fetch', req);
      res.set({
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.status(200).send(manifest);
      return;
    }

    // Everything outside /api/v1 reaches this function through the
    // hosting ** rewrite: the homepage (with markdown negotiation) and
    // real 404s for paths that don't exist. See serveNegotiated().
    if (!req.path.startsWith('/api/v1/')) {
      if (req.path === '/' || req.path === '/index.html') {
        if (req.method === 'GET' || req.method === 'HEAD') {
          // ?mode=agent: the machine view of the homepage, regardless of
          // the Accept header.
          if (req.query.mode === 'agent') {
            res.set({
              'Content-Type': 'text/markdown; charset=utf-8',
              'Cache-Control': 'public, max-age=0, s-maxage=600, stale-while-revalidate=86400',
              'X-Content-Type-Options': 'nosniff',
            });
            res.status(200).send(fs.readFileSync(path.join(__dirname, 'pages', 'index.md'), 'utf8'));
            await track('markdown_fetch', req, { path: '/?mode=agent' });
            return;
          }
          const variant = serveNegotiated(req, res, 'index', 200);
          // Browsers are counted by the page-view beacon; the markdown
          // variant is agent traffic worth seeing in the dashboard.
          if (variant === 'md') await track('markdown_fetch', req, { path: req.path });
          return;
        }
        res.set('Allow', 'GET, HEAD');
        sendJSON(res, 405, { error: 'method_not_allowed', message: 'The homepage supports GET and HEAD.' });
        return;
      }
      serveNegotiated(req, res, '404', 404);
      return;
    }

    // WhatsApp Cloud API webhook — Meta's delivery receipts and inbound
    // messages. Diagnostic + delivery confirmation for operator alerts:
    // status callbacks (sent/delivered/read/failed, with error codes) and
    // inbound messages both land in the `notifications` collection and
    // Cloud Logging. GET is Meta's subscription handshake.
    if (resource === 'whatsapp-webhook') {
      if (req.method === 'GET') {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];
        if (mode === 'subscribe' && token && token === META_WA_VERIFY_TOKEN) {
          console.log('whatsapp webhook verified');
          res.status(200).send(String(challenge));
        } else {
          console.warn('whatsapp webhook verification rejected');
          res.status(403).send('forbidden');
        }
        return;
      }
      if (req.method === 'POST') {
        try {
          const value = body?.entry?.[0]?.changes?.[0]?.value || {};
          for (const s of value.statuses || []) {
            const line = `WA STATUS ${s.status} id=${s.id} errors=${JSON.stringify(s.errors || [])}`;
            console.log(line);
            await db.collection('notifications').add({
              kind: 'WA_STATUS', ref_id: s.id, detail: line,
              status: s.status, errors: s.errors || null,
              created_at: new Date().toISOString(),
            });
          }
          for (const m of value.messages || []) {
            const line = `WA INBOUND from=${m.from} type=${m.type} text=${m.text?.body || ''}`;
            console.log(line);
            await db.collection('notifications').add({
              kind: 'WA_INBOUND', ref_id: m.id, detail: line,
              created_at: new Date().toISOString(),
            });
          }
        } catch (err) {
          console.error('whatsapp webhook parse failed:', err.message);
        }
        // Always 200 — Meta retries and disables webhooks that error.
        res.status(200).send('EVENT_RECEIVED');
        return;
      }
      res.status(405).send('method_not_allowed');
      return;
    }

    if (resource === 'health' && req.method === 'GET') {
      const budget = readBudget();
      sendJSON(res, 200, { status: 'ok', service: 'human-for-ai', api_version: '1.9.0', time: new Date().toISOString() }, budget.headers);
      return;
    }

    // GET /api/v1/services — public, cursor-paginated service catalog
    // (the same entries as agent.json `services`). ?limit=1..50
    // (default 10) and the opaque `cursor` from the previous page;
    // next_cursor is null on the last page. The catalog is small today —
    // the point is a documented, stable pagination shape agents can
    // rely on (see openapi.json).
    // GET /api/v1/services.md — markdown twin of the service catalog, so
    // agents fetching *.md URLs get a readable rendering of the same data.
    if (resource === 'services.md' && req.method === 'GET') {
      const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent.json'), 'utf8'));
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
      res.set({
        'Content-Type': 'text/markdown; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      });
      res.status(200).send(lines.join('\n') + '\n');
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
      const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent.json'), 'utf8'));
      const services = Array.isArray(manifest.services) ? manifest.services : [];
      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 50) : 10;
      let offset = 0;
      if (req.query.cursor !== undefined) {
        try {
          const parsed = JSON.parse(Buffer.from(String(req.query.cursor), 'base64url').toString('utf8'));
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

    // POST /api/v1/beacon — first-party, cookie-less page-view ping from
    // the site's own pages. No cookies, no IP stored; see /privacy.
    if (resource === 'beacon' && req.method === 'POST') {
      let pagePath = '/';
      try {
        const b = typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body)
          ? req.body
          : JSON.parse((req.rawBody || '').toString() || '{}');
        pagePath = String(b.path || '/').slice(0, 200);
      } catch { /* untracked malformed beacon — ignore */ }
      await track('page_view', req, { path: pagePath });
      res.set('Access-Control-Allow-Origin', '*');
      res.status(204).send('');
      return;
    }

    // GET /api/v1/analytics — admin traffic dashboard data.
    if (resource === 'analytics' && req.method === 'GET') {
      if (!isAdmin(req)) {
        sendJSON(res, 401, { error: 'unauthorized', message: 'Admin key required (X-Admin-Key header).' });
        return;
      }
      const dates = [];
      for (let i = 29; i >= 0; i--) {
        dates.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
      }
      const snaps = await db.getAll(...dates.map((d) => db.collection('stats').doc(d)));
      const days = snaps.map((s, i) => ({
        date: dates[i],
        total: 0,
        kinds: {},
        classes: {},
        ...(s.exists ? s.data() : {}),
      }));
      const ev = await db.collection('events').orderBy('ts', 'desc').limit(100).get();
      sendJSON(res, 200, {
        generated_at: new Date().toISOString(),
        days,
        events: ev.docs.map((d) => d.data()),
      });
      return;
    }

    // /api/v1/blocklist — admin-managed abuse blocklist, keyed by the
    // salted client-address hash stored on each task/message.
    //   GET               list entries
    //   POST {ip_hash}    block a client
    //   DELETE /:hash     unblock
    if (resource === 'blocklist') {
      if (!isAdmin(req)) {
        sendJSON(res, 401, { error: 'unauthorized', message: 'Admin key required (X-Admin-Key header).' });
        return;
      }
      if (req.method === 'GET') {
        const snap = await db.collection('blocklist').orderBy('created_at', 'desc').limit(500).get();
        const entries = snap.docs.map((d) => d.data());
        sendJSON(res, 200, { count: entries.length, entries });
        return;
      }
      if (req.method === 'POST') {
        const hash = String(body.ip_hash || '').trim().toLowerCase();
        if (!/^[0-9a-f]{16}$/.test(hash)) {
          sendJSON(res, 422, { error: 'validation_failed', details: ['ip_hash must be the 16-hex-char client_ip_hash from a task or message.'] });
          return;
        }
        const entry = {
          ip_hash: hash,
          note: body.note ? String(body.note).slice(0, 500) : null,
          created_at: new Date().toISOString(),
        };
        await db.collection('blocklist').doc(hash).set(entry);
        sendJSON(res, 201, entry);
        return;
      }
      if (req.method === 'DELETE' && id) {
        const hash = id.toLowerCase();
        const ref = db.collection('blocklist').doc(hash);
        const doc = await ref.get();
        if (!doc.exists) {
          sendJSON(res, 404, { error: 'not_found', message: `No blocklist entry ${hash}.` });
          return;
        }
        await ref.delete();
        sendJSON(res, 200, { deleted: 1, ip_hash: hash });
        return;
      }
      sendJSON(res, 405, { error: 'method_not_allowed', message: 'Blocklist supports GET, POST, and DELETE /:hash (admin).' });
      return;
    }

    // Traffic analytics for public API calls (admin's own actions excluded).
    if ((resource === 'tasks' || resource === 'messages') && !isAdmin(req)) {
      await track('api_request', req, {
        requester: (body && (body.requester || body.from)) || null,
      });
    }

    /* ---- messages ---- */
    if (resource === 'messages') {
      // URL-only submission fallback: some agents can fetch URLs but cannot
      // issue a POST or set headers. A GET carrying a `message` query
      // parameter is accepted as a submission through the exact same
      // pipeline (validation, MX check, duplicate guard, rate limits).
      // Plain GET without `message` stays what it always was: the
      // admin-keyed inbox listing. Note for callers: query strings traverse
      // ordinary server logs — prefer POST when you can.
      let msgBody = body;
      let isSubmission = req.method === 'POST' && !id;
      if (req.method === 'GET' && !id && typeof req.query.message === 'string' && req.query.message.trim()) {
        isSubmission = true;
        msgBody = {
          message: String(req.query.message),
          ...(req.query.reply_to && { reply_to: String(req.query.reply_to) }),
          ...(req.query.from && { from: String(req.query.from) }),
          ...(req.query.subject && { subject: String(req.query.subject) }),
          ...(req.query.requester && { requester: String(req.query.requester) }),
        };
      }
      if (isSubmission) {
        const ipHash = clientIpHash(req);
        if (await isBlocked(ipHash)) {
          sendJSON(res, 403, {
            error: 'blocked',
            message: 'This client address has been blocked for abuse. If you believe this is a mistake, see https://humanforai.dev/trust.',
          });
          return;
        }
        const idem = await idempotencyPhase(req, res, ipHash, msgBody);
        if (idem.replayed) return;
        const errors = validateMessagePayload(msgBody);
        if (errors.length) {
          sendJSON(res, 422, { error: 'validation_failed', details: errors });
          return;
        }
        if (!isHttpsWebhook(msgBody.reply_to) && !(await emailDomainAcceptsMail(msgBody.reply_to))) {
          sendJSON(res, 422, {
            error: 'validation_failed',
            details: [`reply_to domain (${String(msgBody.reply_to).split('@').pop()}) has no mail service (MX records) — the operator could never answer you. Provide a real mailbox, or an https webhook URL.`],
          });
          return;
        }
        // Duplicate guard — same rule as tasks: identical text within 24h.
        // Matched on the sha256 hash, not the raw text: message can be up
        // to 5000 chars, past Firestore's indexed-value limit. Pre-hash
        // docs have no message_hash and simply never match (fine for a
        // 24h-window guard).
        const msgHash = textHash(msgBody.message);
        const dupSnap = await db.collection('messages').where('message_hash', '==', msgHash).limit(5).get();
        const dupSince = Date.now() - 24 * 3600 * 1000;
        const dup = dupSnap.docs.map((d) => d.data()).find((m) => Date.parse(m.created_at) >= dupSince);
        if (dup) {
          sendJSON(res, 409, {
            error: 'duplicate_message',
            message_id: dup.message_id,
            message: `An identical message was already received at ${dup.created_at} (${dup.message_id}). The operator will reply to it — no need to resend.`,
          });
          return;
        }
        const hour = new Date().toISOString().slice(11, 13);
        if (!(await underDailyLimit(`ip-${ipHash}-messages-h${hour}`, IP_MESSAGES_HOURLY_LIMIT)).allowed) {
          sendJSON(res, 429, {
            error: 'rate_limited',
            message: `This client address has reached its hourly message limit (${IP_MESSAGES_HOURLY_LIMIT}/hour during the free pilot). Try again next hour.`,
          }, {
            'Retry-After': String(secondsToNextUtcHour()),
            ...rateHeaders(IP_MESSAGES_HOURLY_LIMIT, 0, secondsToNextUtcHour()),
          });
          return;
        }
        const msgDaily = await underDailyLimit(`ip-${ipHash}-messages`, IP_MESSAGES_DAILY_LIMIT);
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
        if (!(await underDailyLimit('messages', MESSAGES_DAILY_LIMIT)).allowed) {
          sendJSON(res, 429, {
            error: 'daily_capacity_reached',
            message: `The free pilot accepts up to ${MESSAGES_DAILY_LIMIT} messages per day and today's capacity is used up. Try again after 00:00 UTC.`,
          }, {
            'Retry-After': String(secondsToUtcMidnight()),
            ...rateHeaders(MESSAGES_DAILY_LIMIT, 0, secondsToUtcMidnight()),
          });
          return;
        }
        const msg = buildMessage(msgBody, ipHash);
        await db.collection('messages').doc(msg.message_id).set(msg);
        await notify('NEW MESSAGE', msg.message_id, `from=${msg.from} reply_to=${msg.reply_to || (msg.webhook ? 'webhook' : 'none')}`);
        const msgAlert =
          `✉️ Message ${msg.message_id} from ${msg.from}\n` +
          `${(msg.subject ? msg.subject + ' — ' : '')}${msg.message.slice(0, 300)}\n` +
          `https://humanforai.dev/admin`;
        await notifyTelegram(msgAlert);
        await notifyWhatsApp(msgAlert);
        await queueEmail(
          `[Human For AI] New message ${msg.message_id}${msg.subject ? ' — ' + msg.subject : ''}`,
          `A new message arrived.\n\n` +
          `From:     ${msg.from}\n` +
          `Reply-to: ${msg.reply_to || (msg.webhook ? 'webhook: ' + msg.webhook.url : 'none provided')}\n` +
          `Subject:  ${msg.subject || '(none)'}\n\n` +
          `${msg.message}\n\n` +
          `Inbox: https://humanforai.dev/admin`
        );
        const msgResponse = {
          message_id: msg.message_id,
          created_at: msg.created_at,
          thread_url: `/api/v1/messages/${msg.message_id}`,
          access_token: msg.access_token,
          message: 'Message received. The operator replies within 12 hours, any day of the week. ' +
            'This message is also a thread: GET thread_url with the access_token (Bearer header or ?token=) to read the reply without a mailbox, ' +
            'and POST {"message","token"} to the same URL to follow up. Keep the token — it is shown only once and is the only key to the thread.' +
            (msg.webhook ? ' Operator replies are also pushed to your webhook URL, signed (see /api#webhooks).' : ''),
        };
        sendJSON(res, 201, msgResponse,
          rateHeaders(IP_MESSAGES_DAILY_LIMIT, IP_MESSAGES_DAILY_LIMIT - msgDaily.count, secondsToUtcMidnight()));
        await storeIdempotent(idem, 201, msgResponse);
        return;
      }
      // Thread read: GET /api/v1/messages/{id} with the access_token from
      // submission (Bearer header or ?token=). A wrong id and a wrong token
      // answer identically, so neither is an oracle for the other.
      if (req.method === 'GET' && id) {
        const doc = await db.collection('messages').doc(id).get();
        const m = doc.exists ? doc.data() : null;
        if (!m || !m.access_token || !tokensMatch(threadToken(req, body), m.access_token)) {
          sendJSON(res, 404, {
            error: 'thread_not_found',
            message: 'No readable thread for that id and token. The access_token comes from the original submission response; threads exist for messages sent after API v1.9.0.',
          });
          return;
        }
        sendJSON(res, 200, publicThread(m));
        return;
      }
      // Thread write: POST /api/v1/messages/{id} — the operator's reply
      // (admin key) or the requester's follow-up (access_token).
      if (req.method === 'POST' && id) {
        const ref = db.collection('messages').doc(id);
        const doc = await ref.get();
        const m = doc.exists ? doc.data() : null;
        const asAdmin = isAdmin(req);
        if (!m || (!asAdmin && (!m.access_token || !tokensMatch(threadToken(req, body), m.access_token)))) {
          sendJSON(res, 404, {
            error: 'thread_not_found',
            message: 'No writable thread for that id and token. The access_token comes from the original submission response.',
          });
          return;
        }
        const text = typeof body.message === 'string' ? body.message.trim() : '';
        if (text.length < 2 || text.length > 5000) {
          sendJSON(res, 422, { error: 'validation_failed', details: ['message is required (2-5000 characters).'] });
          return;
        }
        m.replies = m.replies || [];
        if (!asAdmin && m.replies.length >= THREAD_MAX_REPLIES) {
          sendJSON(res, 422, { error: 'thread_full', message: `This thread has reached ${THREAD_MAX_REPLIES} replies. Send a new message and quote the message_id.` });
          return;
        }
        if (!asAdmin) {
          const ipHash = clientIpHash(req);
          const hour = new Date().toISOString().slice(11, 13);
          if (!(await underDailyLimit(`ip-${ipHash}-messages-h${hour}`, IP_MESSAGES_HOURLY_LIMIT)).allowed) {
            sendJSON(res, 429, {
              error: 'rate_limited',
              message: `This client address has reached its hourly message limit (${IP_MESSAGES_HOURLY_LIMIT}/hour during the free pilot). Try again next hour.`,
            }, { 'Retry-After': String(secondsToNextUtcHour()), ...rateHeaders(IP_MESSAGES_HOURLY_LIMIT, 0, secondsToNextUtcHour()) });
            return;
          }
        }
        const reply = { author: asAdmin ? 'operator' : 'requester', message: text, created_at: new Date().toISOString() };
        m.replies.push(reply);
        if (asAdmin) m.answered_at = reply.created_at;
        // Operator replies push to the webhook (signed); requester
        // follow-ups only notify the operator.
        if (asAdmin && m.webhook) {
          m.webhook.last_delivery = await deliverWebhook(m, 'operator_reply', { reply, thread_url: `/api/v1/messages/${m.message_id}` });
        }
        await ref.set(m);
        if (!asAdmin) {
          await notify('THREAD FOLLOW-UP', m.message_id, `replies=${m.replies.length}`);
          const followAlert = `↩️ Thread follow-up on ${m.message_id}\n${text.slice(0, 300)}\nhttps://humanforai.dev/admin`;
          await notifyTelegram(followAlert);
          await notifyWhatsApp(followAlert);
        }
        sendJSON(res, 201, {
          message_id: m.message_id,
          reply_count: m.replies.length,
          ...(asAdmin && m.webhook && { webhook_delivery: m.webhook.last_delivery }),
          message: asAdmin
            ? 'Reply recorded in the thread.'
            : 'Added to the thread. The operator is notified and replies at human speed — poll the thread occasionally, not in a loop.',
        });
        return;
      }
      if (req.method === 'GET') {
        if (!isAdmin(req)) {
          sendJSON(res, 401, { error: 'unauthorized', message: 'Admin key required (X-Admin-Key header).' });
          return;
        }
        const snap = await db.collection('messages').orderBy('created_at', 'desc').limit(500).get();
        const messages = snap.docs.map((d) => d.data());
        sendJSON(res, 200, { count: messages.length, messages });
        return;
      }
      // DELETE /api/v1/messages/:id  — remove one message   (admin)
      // DELETE /api/v1/messages      — clear the inbox      (admin)
      // Deletion is permanent; the admin UI confirms before calling.
      if (req.method === 'DELETE') {
        if (!isAdmin(req)) {
          sendJSON(res, 401, { error: 'unauthorized', message: 'Admin key required (X-Admin-Key header).' });
          return;
        }
        if (id) {
          const ref = db.collection('messages').doc(id);
          const doc = await ref.get();
          if (!doc.exists) {
            sendJSON(res, 404, { error: 'message_not_found', message: `No message with id ${id}.` });
            return;
          }
          await ref.delete();
          sendJSON(res, 200, { deleted: 1, message_id: id });
          return;
        }
        const snap = await db.collection('messages').get();
        let deleted = 0;
        // Firestore caps a batch at 500 writes — chunk to stay under it.
        for (let i = 0; i < snap.docs.length; i += 400) {
          const batch = db.batch();
          snap.docs.slice(i, i + 400).forEach((d) => { batch.delete(d.ref); deleted += 1; });
          await batch.commit();
        }
        sendJSON(res, 200, { deleted });
        return;
      }
      sendJSON(res, 405, { error: 'method_not_allowed', message: 'Messages support POST (public), GET and DELETE (admin).' });
      return;
    }

    if (resource !== 'tasks') {
      sendJSON(res, 404, { error: 'not_found', message: 'Unknown API resource. See /api for documentation.' });
      return;
    }

    /* ---- tasks ---- */
    if (req.method === 'POST' && !id) {
      const ipHash = clientIpHash(req);
      if (await isBlocked(ipHash)) {
        sendJSON(res, 403, {
          error: 'blocked',
          message: 'This client address has been blocked for abuse. If you believe this is a mistake, see https://humanforai.dev/trust.',
        });
        return;
      }
      const idem = await idempotencyPhase(req, res, ipHash, body);
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
      // Duplicate guard: an identical description within 24h is a retry
      // or spam — point the client at the existing task instead of
      // creating a copy (and burning notification/daily-cap budget).
      // Matched on the sha256 hash, not the raw text: description can be
      // up to 5000 chars, past Firestore's indexed-value limit. Pre-hash
      // docs have no description_hash and simply never match (fine for a
      // 24h-window guard).
      const descHash = textHash(body.description);
      const dupSnap = await db.collection('tasks').where('description_hash', '==', descHash).limit(5).get();
      const dupSince = Date.now() - 24 * 3600 * 1000;
      const dup = dupSnap.docs.map((d) => d.data()).find((t) => Date.parse(t.created_at) >= dupSince);
      if (dup) {
        sendJSON(res, 409, {
          error: 'duplicate_task',
          task_id: dup.task_id,
          status_url: `/api/v1/tasks/${dup.task_id}`,
          message: `An identical task was already submitted at ${dup.created_at} (${dup.task_id}). Poll its status instead of resubmitting.`,
        });
        return;
      }
      if (isPollTask && !(await underDailyLimit(`ip-${ipHash}-polltasks`, IP_POLL_TASKS_DAILY_LIMIT)).allowed) {
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
      if (!(await underDailyLimit(`ip-${ipHash}-tasks-h${hour}`, IP_TASKS_HOURLY_LIMIT)).allowed) {
        sendJSON(res, 429, {
          error: 'rate_limited',
          message: `This client address has reached its hourly task limit (${IP_TASKS_HOURLY_LIMIT}/hour during the free pilot). Try again next hour.`,
        }, {
          'Retry-After': String(secondsToNextUtcHour()),
          ...rateHeaders(IP_TASKS_HOURLY_LIMIT, 0, secondsToNextUtcHour()),
        });
        return;
      }
      const taskDaily = await underDailyLimit(`ip-${ipHash}-tasks`, IP_TASKS_DAILY_LIMIT);
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
      if (!(await underDailyLimit('tasks', TASKS_DAILY_LIMIT)).allowed) {
        sendJSON(res, 429, {
          error: 'daily_capacity_reached',
          message: `The free pilot accepts up to ${TASKS_DAILY_LIMIT} task submissions per day and today's capacity is used up. Try again after 00:00 UTC.`,
        }, {
          'Retry-After': String(secondsToUtcMidnight()),
          ...rateHeaders(TASKS_DAILY_LIMIT, 0, secondsToUtcMidnight()),
        });
        return;
      }
      const task = buildTask(body, ipHash);
      await db.collection('tasks').doc(task.task_id).set(task);
      await notify('NEW TASK', task.task_id, `type=${task.task_type} budget=$${task.budget_usd}`);
      await queueEmail(
        `[Human For AI] New task ${task.task_id} — ${task.task_type}`,
        `A new task was submitted.\n\n` +
        `Task:      ${task.task_id}\n` +
        `Type:      ${task.task_type}\n` +
        `Source:    ${task.source} (requester: ${task.requester})\n` +
        `Deadline:  ${task.deadline || 'none'}\n` +
        `Location:  ${task.location_required ? (task.location_detail || 'required, no detail given') : 'not required'}\n` +
        `Output:    ${task.output_format}\n` +
        `Contact:   ${task.contact_email || (task.delivery === 'status_poll' ? 'STATUS POLL (no mailbox) — deliver via operator_notes' : 'none provided')}\n\n` +
        `Description:\n${task.description}\n\n` +
        `Review it: https://humanforai.dev/admin\n` +
        `Status:    https://humanforai.dev/tasks?id=${task.task_id}`
      );
      const taskAlert =
        `🆕 Task ${task.task_id}\n` +
        `${task.task_type} · $${task.budget_usd} · ${task.deadline ? 'deadline ' + task.deadline : 'no deadline'}\n` +
        `${task.description.slice(0, 300)}\n` +
        `https://humanforai.dev/admin`;
      await notifyTelegram(taskAlert);
      await notifyWhatsApp(taskAlert);
      // Async-job contract: 202 Accepted — the job is queued for human
      // review, not finished. Location points at the poll endpoint (same
      // as status_url); the client polls until delivered or rejected.
      const taskResponse = {
        task_id: task.task_id,
        status: task.status,
        created_at: task.created_at,
        status_url: `/api/v1/tasks/${task.task_id}`,
        status_page: `/tasks?id=${task.task_id}`,
        message: task.delivery === 'status_poll'
          ? 'Task received in no-mailbox mode. Poll status_url — the deliverable and any operator questions will appear in operator_notes. Keep the task_id: it is your only key to the result.'
          : 'Task received. It will be reviewed before acceptance. Keep the task_id to check status — seen_by_operator_at shows the moment a human has seen your task, and eta appears once it is accepted.',
      };
      const taskHeaders = {
        Location: `/api/v1/tasks/${task.task_id}`,
        ...rateHeaders(IP_TASKS_DAILY_LIMIT, IP_TASKS_DAILY_LIMIT - taskDaily.count, secondsToUtcMidnight()),
      };
      sendJSON(res, 202, taskResponse, taskHeaders);
      await storeIdempotent(idem, 202, taskResponse, { Location: taskHeaders.Location });
      return;
    }

    if (req.method === 'GET' && !id) {
      if (!isAdmin(req)) {
        sendJSON(res, 401, { error: 'unauthorized', message: 'Admin key required (X-Admin-Key header).' });
        return;
      }
      const snap = await db.collection('tasks').orderBy('created_at', 'desc').limit(500).get();
      const tasks = snap.docs.map((d) => d.data());
      // The operator just loaded the inbox — stamp any not-yet-seen task.
      // This is the honest "a human saw your task" moment that agents can
      // observe via check_task_status (seen_by_operator_at).
      const seenAt = new Date().toISOString();
      const unseen = snap.docs.filter((d) => !d.data().seen_by_operator_at);
      if (unseen.length) {
        const batch = db.batch();
        unseen.forEach((d) => batch.update(d.ref, { seen_by_operator_at: seenAt }));
        await batch.commit();
        tasks.forEach((t) => { if (!t.seen_by_operator_at) t.seen_by_operator_at = seenAt; });
      }
      sendJSON(res, 200, { count: tasks.length, tasks });
      return;
    }

    if (req.method === 'GET' && id) {
      const doc = await db.collection('tasks').doc(id).get();
      if (!doc.exists) {
        sendJSON(res, 404, { error: 'task_not_found', message: `No task with id ${id}.` });
        return;
      }
      sendJSON(res, 200, publicTask(doc.data()));
      return;
    }

    if (req.method === 'PATCH' && id) {
      if (!isAdmin(req)) {
        sendJSON(res, 401, { error: 'unauthorized', message: 'Admin key required (X-Admin-Key header).' });
        return;
      }
      // Retired values stay accepted here (folded onto their survivor by
      // canonicalStatus) so older clients do not start failing.
      if (body.status && !TASK_STATUSES.includes(body.status) && !LEGACY_STATUS_MAP[body.status]) {
        sendJSON(res, 422, { error: 'validation_failed', details: [`status must be one of: ${TASK_STATUSES.join(', ')}`] });
        return;
      }
      const ref = db.collection('tasks').doc(id);
      const doc = await ref.get();
      if (!doc.exists) {
        sendJSON(res, 404, { error: 'task_not_found', message: `No task with id ${id}.` });
        return;
      }
      const task = doc.data();
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
      // Sign the deliverable once it is delivered. Re-signed if the text
      // is later edited: a receipt that no longer matches the deliverable
      // would be worse than none, so the hash always tracks reality.
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
      await ref.set(task);
      sendJSON(res, 200, task);
      return;
    }

    sendJSON(res, 405, { error: 'method_not_allowed', message: 'See /api for supported methods.' });
  } catch (err) {
    console.error('api error:', err);
    sendJSON(res, 500, { error: 'internal_error', message: 'Unexpected server error.' });
  }
}

exports.api = onRequest(
  { region: 'us-central1', maxInstances: 3, memory: '256MiB' },
  handler
);

exports.mcp = require('./mcp').mcp;

// Billing kill switch — hard cost cap. Detaches billing if spend exceeds
// the `human-api-hard-cap` budget (topic: billing-cap). See killswitch.js.
exports.billingKillSwitch = require('./killswitch').billingKillSwitch;
