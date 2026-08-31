# Prior work vs. challenge-window work

Per the WebMCP Challenge official rules, pre-existing projects must document
what predates the submission window. This file is that record.

## What this repository is

This is the **public source mirror** of https://humanforai.dev. The primary
repository is private because it also carries operational data (task records,
inbox exports, ops notes). The mirror contains the complete source of the
deployed site and backend, with exactly two redactions: a personal
notification email fallback replaced with `''` in `functions/index.js` /
`server.js`, and internal ops notes (submission drafts, scratch files)
omitted. Nothing that runs on humanforai.dev is missing.

## Prior work (before the submission window)

Everything in the baseline commit **"Human For AI — pre-hackathon baseline
(prior work)"** (authored 2026-08-28, squashed from the private repository's
history back to 2026-07-09): the marketplace site, the REST API on Firebase
Functions (tasks, statuses, receipts), the remote MCP server at `/mcp`, the
agent-discovery surfaces (`agent.json`, `/.well-known/*`, `llms.txt`,
OpenAPI), and the operator tooling. **No WebMCP code exists in the baseline.**

## Challenge-window work (judged)

Every commit after the baseline is replayed from the private repository with
its **original author timestamps** (2026-08-28 → 2026-09-03) and original
messages:

- `WebMCP: in-page tools for browser-resident AI agents` — first WebMCP
  integration: 5 site-wide tools over `navigator.modelContext` +
  declarative `toolname` form attributes.
- `WebMCP: canonical entry point, annotations, service-detail tool` —
  `document.modelContext` as primary, tool annotations, 5-tool set.
- `/together: shared human+agent workspace on WebMCP (hackathon)` — the
  centerpiece: three-lane workspace, 7 workspace tools, `await_human`
  resolved by a physical click, approval-gated submission, live operator
  presence and thread.
- `/together: Autopilot toggle` — the human chooses the approval regime:
  per-task click or standing delegated authority, revocable.
- Plus supporting fixes (cross-tab state adoption, cache-busting, layout)
  and window-period API work (message threads + signed webhooks v1.9.0,
  `decision_escalation`) that the workspace's operator lane builds on.

Non-WebMCP commits inside the window (API v1.8.2 fixes, schema.org/Wikidata
linking) are included for completeness and honesty; the submission's claimed
work is the WebMCP integration and the `/together` workspace.

## Verifying

`git log --format='%h %ad %s' --date=iso` shows the dated sequence. The live
site serves the exact code in this mirror; compare any file, e.g.
`curl https://humanforai.dev/js/together-webmcp.js` against
[public/js/together-webmcp.js](public/js/together-webmcp.js).
