/**
 * Human For AI — first-party traffic tracking.
 *
 * Privacy-by-design: no cookies, no IP addresses stored, no third parties.
 * We record the request path, method, referer, and the user-agent string
 * with a coarse classification (browser / script / AI crawler / search
 * crawler / MCP client) — enough to see WHO is calling (humans vs
 * machines) without tracking any individual.
 *
 * Storage shape (Firestore):
 *   stats/{YYYY-MM-DD}  — aggregate counters (1 blind write per event)
 *   events/{auto}       — raw events for the admin feed (page views
 *                         excluded; capped per day)
 *
 * Cost control: a per-instance in-memory fuse caps tracking writes per
 * UTC day; raw events additionally pass a transactional daily cap.
 * Tracking failures never break a request.
 */

'use strict';

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const { FieldValue } = require('firebase-admin/firestore');

const FUSE_LIMIT = 4000;          // tracking writes per instance per day
const EVENTS_DAILY_LIMIT = 1500;  // raw event docs per day (global)

let fuse = { day: '', count: 0 };

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Coarse caller classification from the user-agent string. */
function classifyUA(ua) {
  const s = String(ua || '').toLowerCase();
  if (!s) return 'unknown';
  if (/(claudebot|claude-web|anthropic|gptbot|oai-searchbot|chatgpt|openai|perplexity|google-extended|ccbot|bytespider|amazonbot|meta-externalagent|cohere|mistral|youbot|diffbot)/.test(s)) return 'ai_crawler';
  if (/(langchain|llamaindex|autogen|crewai|browser-use|computer-use|agentic|mcp)/.test(s)) return 'ai_agent';
  if (/(googlebot|bingbot|duckduckbot|yandex|baiduspider|applebot|petalbot|semrush|ahrefs)/.test(s)) return 'search_crawler';
  if (/(python-requests|python-httpx|httpx|aiohttp|node-fetch|undici|axios|curl|wget|go-http-client|okhttp|libwww|java\/|ruby|php)/.test(s)) return 'script';
  if (/mozilla/.test(s)) return 'browser';
  return 'other';
}

async function underEventsCap() {
  const day = today();
  const ref = db.collection('counters').doc(`events-${day}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const count = snap.exists ? (snap.data().count || 0) : 0;
    if (count >= EVENTS_DAILY_LIMIT) return false;
    tx.set(ref, { count: count + 1, day }, { merge: true });
    return true;
  });
}

/**
 * Record one traffic event. Fire-and-forget safe: never throws.
 * kind: page_view | api_request | mcp_request | manifest_fetch
 * extra: { path?, method?, tool?, client?, requester?, ua_class? }
 */
async function track(kind, req, extra = {}) {
  try {
    const day = today();
    if (fuse.day !== day) fuse = { day, count: 0 };
    if (fuse.count >= FUSE_LIMIT) return;
    fuse.count += 1;

    const ua = String((req && req.get && req.get('user-agent')) || '').slice(0, 300);
    if (ua.startsWith('human-for-ai-internal')) return; // our own internal hops
    const uaClass = extra.ua_class || classifyUA(ua);

    // Aggregate counters — one write, no reads.
    await db.collection('stats').doc(day).set({
      total: FieldValue.increment(1),
      kinds: { [kind]: FieldValue.increment(1) },
      classes: { [uaClass]: FieldValue.increment(1) },
    }, { merge: true });

    // Raw event for the admin feed — machine traffic only, capped.
    if (kind === 'page_view') return;
    if (!(await underEventsCap())) return;

    const event = {
      ts: new Date().toISOString(),
      kind,
      ua,
      ua_class: uaClass,
      method: extra.method || (req && req.method) || null,
      path: extra.path || (req && req.path) || null,
      tool: extra.tool || null,
      client: extra.client || null,
      requester: extra.requester || null,
      referer: String((req && req.get && req.get('referer')) || '').slice(0, 300) || null,
    };
    Object.keys(event).forEach((k) => { if (event[k] === undefined) event[k] = null; });
    await db.collection('events').add(event);
  } catch (err) {
    console.error('track failed:', err.message);
  }
}

module.exports = { track, classifyUA };
