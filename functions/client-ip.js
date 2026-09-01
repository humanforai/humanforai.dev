/**
 * Human For AI — trustworthy client address extraction.
 *
 * Shared by index.js (rate limits, blocklist) and mcp.js (which forwards
 * the real caller to the REST API as X-Client-IP). Both must agree: if
 * the MCP hop derived the address the naive way, a spoofed header would
 * ride through the authenticated internal hop and defeat the guard on
 * the other side. One copy, one behaviour.
 *
 * Google's frontend APPENDS to X-Forwarded-For, so the trustworthy end
 * of the chain is the right: the last TRUSTED_PROXY_HOPS entries are
 * written by infrastructure we control, and the entry just before them
 * is the address Google actually observed. Anything further left was
 * supplied by the caller and is worthless — taking chain[0] lets any
 * client mint a fresh rate-limit bucket and shed a blocklist entry.
 *
 * Getting TRUSTED_PROXY_HOPS too HIGH collapses every caller into one
 * bucket (a shared limit, and one block stops all traffic); too LOW
 * re-opens the spoof. Confirm it against a real request before trusting
 * the limits — cold start logs the observed chain length once per
 * instance (length only; never the addresses — see /privacy).
 */

'use strict';

const TRUSTED_PROXY_HOPS = Number.isInteger(Number(process.env.TRUSTED_PROXY_HOPS))
  ? Number(process.env.TRUSTED_PROXY_HOPS)
  : 1;

let loggedChainLength = false;

/**
 * The client address as Google saw it, counted from the right so a
 * caller-supplied X-Forwarded-For cannot displace it: a spoofed value is
 * simply prepended to the chain and skipped over, however many entries
 * the caller sends. Returns '' when there is no chain.
 */
function clientIpFromXff(req) {
  const chain = String((req && req.get && req.get('x-forwarded-for')) || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!loggedChainLength) {
    loggedChainLength = true;
    console.log(`x-forwarded-for chain length observed: ${chain.length} (TRUSTED_PROXY_HOPS=${TRUSTED_PROXY_HOPS})`);
  }
  if (!chain.length) return '';
  const idx = chain.length - 1 - TRUSTED_PROXY_HOPS;
  // A chain shorter than the configured hop count means the request did
  // not arrive through the expected path. Fall back to the leftmost entry
  // rather than to a proxy address, so callers stay separated.
  return idx >= 0 ? chain[idx] : chain[0];
}

module.exports = { clientIpFromXff, TRUSTED_PROXY_HOPS };
