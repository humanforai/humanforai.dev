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
- Or send it yourself: **Submit this draft myself** runs the same gate as
  the agent's `submit_approved_task` (validation, one submission per
  revision, delivery to your own email), your click counts as the approval,
  and an agent blocked in `await_human` gets `submitted_by_human` with the
  task ID, so it tracks the task instead of submitting it again.
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

Above the inspector, a live **capability manifest** shows what each of the
seven registered tools would do at this moment — `ready`, or
`refuses: <error code>` — and lists the four human-only actions that have no
tool form: approve, reject, grant Autopilot, revoke Autopilot. All seven tools
stay registered for the whole session; the gates live inside them and refuse
with a structured reason, so an agent learns what to do next rather than
finding a tool missing. Every result is bounded to 8,000 serialized
characters (long text fields are shortened with a marker and a `truncated`
note; structure is never dropped), and arguments are accepted as an object or
as a JSON string. The expected journeys, per-phase refusals, and invariants
are encoded in [`evals/together-journey.json`](evals/together-journey.json).

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

### Trust boundaries

What the tools promise, what they do not, and where the real checks sit.

- **Tool declarations are hints, not a security boundary.** Every write goes
  through the same HTTPS endpoints as the human form and the remote MCP
  server, and the server validates every field again: task types, lengths,
  reply addresses (MX-checked), duplicate descriptions, rate limits. Passing
  the client-side schema proves nothing.
- **Page content is data, not instructions.** `read_workspace`,
  `await_human`, `track_task_status` and `message_operator` return
  human-authored text (the goal, notes, operator replies) and carry
  `untrustedContentHint: true`. Nothing in a tool result asks the agent to do
  anything; results are status codes and records.
- **No tool can grant authority.** The only consequential action,
  `submit_approved_task`, needs an on-page approval bound to the exact draft
  revision, or a bounded Autopilot grant. Both are clicks by the person at the
  keyboard; there is no tool that approves, grants, or extends. An injected
  instruction can draft, but it cannot ship.
- **Autopilot is bounded by construction.** A task budget and an expiry set
  by the human, one submission per draft revision, delivery locked to the
  human's own email; an agent-set `contact_email` is ignored under Autopilot.
- **Failures read as failures.** A refusal or a failed lookup returns
  `isError: true` at the protocol level as well as a structured `error` code,
  so an agent never mistakes `not_approved` or `task_not_found` for success.
- **Same origin only.** Tools are registered by the page, for the page;
  nothing is exposed to other origins or frames. The workspace lives in this
  browser's localStorage: no account, no credential, nothing on the page the
  agent can reach that the human cannot see.
- **Outbound calls identify themselves.** Webhook pushes to a `reply_to` URL
  carry two signatures: an HMAC over the body with the thread's own token, and
  an RFC 9421 HTTP Message Signature (tag `web-bot-auth`) made with the same
  Ed25519 key that signs receipts, published at
  `/.well-known/http-message-signatures-directory`. A receiver can verify who
  is calling, not only that the body is intact.
- **A human reviews every task before acceptance.** The operator rejects
  illegal, harmful, deceptive, unsafe, or privacy-invasive requests, whichever
  client submitted them.

Known limits, stated rather than hidden: approval enforcement is client-side,
and an agent that bypasses the page and calls the REST API directly can file a
task like any other API client, which the operator then reviews like any other
task. Prompt injection is not solved by any WebMCP site; this page narrows what
an injected instruction can do, it does not make it impossible.

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

Agent readiness, measured: [isitagentready.com](https://isitagentready.com/https%3A%2F%2Fhumanforai.dev%2Ftogether)
scores `/together` **81/100, Level 5 "Agent-Native"** (2 Sep 2026): Markdown
negotiation, Content Signals, Web Bot Auth, API catalog, MCP server card, Agent
Skills index, WebMCP, and ARD all pass. The two open checks are OAuth discovery,
which does not apply to a no-auth API, and DNS-AID records.

## Hackathon provenance

Built for the **WebMCP Challenge** (OpenAI × ChromiumDev × Cloudflare ×
Shopify × Vercel × Render × Netlify, Aug–Sep 2026). The platform predates the
challenge; **all WebMCP work is challenge-window work** — see
[PRIOR-WORK.md](PRIOR-WORK.md) for the exact commit-by-commit split.

## License

[MIT](LICENSE).
