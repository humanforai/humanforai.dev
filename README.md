# Human For AI — humanforai.dev

**A human endpoint for AI agents — and a WebMCP workspace where you and your agent hire a real human, together.**

Live site: **https://humanforai.dev** · WebMCP workspace: **https://humanforai.dev/together**

Every WebMCP entry in this challenge is a site agents can use *for* humans.
This one is inverted: Human For AI is a marketplace where **the agent is the
customer and the human is the service**. AI agents hire one verified human
operator for things software can't do — real-world verification, product
testing, human judgment, physical-world errands — over REST, MCP, and now
WebMCP. Free during the proof-of-concept pilot.

## /together — the WebMCP Challenge piece

[`/together`](https://humanforai.dev/together) is a shared workspace with three
seats: **you** (the human at the keyboard), **your agent** (ChatGPT or any
browser-resident agent, via WebMCP), and **the operator** (a real human on the
other end of the API).

- You type a goal in plain words. Your agent reads it off the page
  (`read_workspace`) and drafts the formal task on the page (`draft_task`) —
  every field shows who wrote it last, and you can edit any field directly.
  It's a document you both hold.
- **You choose the approval regime.** Default: nothing is submitted without
  your explicit on-page approval (`request_human_approval` → `await_human`, a
  WebMCP tool call that blocks until a person acts on the page) — and the
  approval binds to the exact draft revision shown; any edit voids it. Or flip
  **Autopilot** and grant your agent bounded standing authority: a task
  budget and an expiry you set, delivery locked to your own email, one
  submission per draft revision. The grant retires itself and is revocable
  any time.
- After submission the third human appears: the operator's
  `seen_by_operator_at`, ETA, status history, and message-thread replies
  stream onto the page for both of you (`track_task_status`,
  `message_operator`).

Delegation in one direction, human-in-the-loop in the other — on one page.

No WebMCP browser? Press **Simulate an agent**: a scripted agent drives the
page's real tool objects — drafts, gets refused when it tries to submit
unapproved, blocks in `await_human` until you click, then places a clearly
marked *simulated* task on the operator board and walks it through the
lifecycle. Nothing is sent to the operator. The **WebMCP inspector** under
the lanes logs every tool call — real or simulated — with its exact
arguments and result. Each lane pulses when it is that seat's move.

### WebMCP tools

Registered via `document.modelContext` (W3C Web Model Context draft), with a
`navigator.modelContext` fallback. Site-wide
([`public/js/webmcp.js`](public/js/webmcp.js)): `get_human_services`,
`get_service_details`, `submit_human_task`, `check_task_status`,
`message_human_operator` — mirroring the REST API and remote MCP server
one-to-one. Workspace
([`public/js/together-webmcp.js`](public/js/together-webmcp.js)):
`read_workspace`, `draft_task`, `request_human_approval`, `await_human`,
`submit_approved_task`, `track_task_status`, `message_operator`. The
declarative half lives as `toolname`/`tooldescription` attributes on the
site's forms. In browsers without the API the pages no-op gracefully, and the
workspace tools stay auditable at `window.__hfaiTogetherTools`.

## Try it

1. Open https://humanforai.dev/together in the **ChatGPT desktop app's
   browser** or Chrome with WebMCP enabled.
2. Type a goal, then ask your agent: *"Work with me on this page — read my
   goal and draft the task for my approval."*
3. Approve with a click — or grant Autopilot and watch it work.

No WebMCP client at hand? Press **Simulate an agent** on the page instead —
same tools, scripted driver, clearly labeled, nothing sent.

Everything is real: a task submitted here pings a real human operator
(push-notified), who reviews, accepts, and delivers — with a signed receipt
(EdDSA JWS binding the deliverable's SHA-256 to the task lifecycle,
verifiable against [`/.well-known/jwks.json`](https://humanforai.dev/.well-known/jwks.json)).

## Architecture

```
public/            static site (no framework, no build step)
  together.html    the shared workspace page
  js/together.js   workspace engine: shared state, three-lane rendering,
                   approval + autopilot regimes, live polling, localStorage
  js/together-webmcp.js   the agent's seat: 7 WebMCP tools over the engine
  js/together-sim.js      simulation mode: a scripted agent over the same
                          tool objects, for browsers without WebMCP
  js/webmcp.js     site-wide WebMCP tools (5, mirroring the REST API)
  .well-known/     agent discovery: agent.json, services, capabilities,
                   human.json, MCP server card, JWKS, agent skills
functions/         Firebase Functions: REST API (tasks, messages/threads,
                   signed webhooks, receipts), remote MCP server (/mcp)
server.js          zero-dependency local MVP server (legacy, still runs)
```

One interface, three readers: the human form, the JSON API, and the in-page
WebMCP tools all hit the same endpoints with the same validation.

## Run locally

The production site runs on Firebase (Hosting + Functions + Firestore):

```bash
cd functions && npm install
firebase emulators:start
```

Set `functions/.env` from your own values (`ADMIN_KEY` required; optional
`NOTIFY_EMAIL`, Telegram/WhatsApp alert credentials — see the header of
[`functions/index.js`](functions/index.js)). Or poke the legacy
zero-dependency server: `node server.js` → http://localhost:4180.

## Testing and evals

[TESTING.md](TESTING.md) — deterministic hand-runnable checks for every trust
property (validation, rev-bound approvals, bounded autopilot, honest
failures), runnable in any browser via `window.__hfaiTogetherTools`.
[EVALS.md](EVALS.md) — expected agent journeys per tool and the measured
results of the latest verification pass.

## Hackathon provenance

Built for the **WebMCP Challenge** (OpenAI × ChromiumDev × Cloudflare ×
Shopify × Vercel × Render × Netlify, Aug–Sep 2026). The platform predates the
challenge; **all WebMCP work is challenge-window work** — see
[PRIOR-WORK.md](PRIOR-WORK.md) for the exact commit-by-commit split.

## License

[MIT](LICENSE).
