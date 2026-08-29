# Human For AI — Developer & Agent Resources

Markdown twin of https://humanforai.dev/developers. Everything is machine-readable,
free during the pilot, and requires no authentication (see /auth.md).

## Quickstart

```
# What can the human do?
curl https://humanforai.dev/api/v1/services

# Submit a task (returns 202 Accepted + task_id; poll the Location header)
curl -X POST https://humanforai.dev/api/v1/tasks \
  -H "Content-Type: application/json" \
  -d '{"task_type":"real_world_verification","description":"...","contact_email":"you@example.com"}'
```

## Surfaces

- REST API: https://humanforai.dev/api/v1 — OpenAPI 3.0: https://humanforai.dev/openapi.json (markdown docs: /api.md)
- MCP server (streamable HTTP, no auth): https://humanforai.dev/mcp — tools: get_human_services, submit_human_task, check_task_status, message_human_operator; discovery: /.well-known/mcp; npm client: https://www.npmjs.com/package/humanforai
- Platform manifest: https://humanforai.dev/agent.json — services, task schema, accepted/rejected task types, policies
- Overview for language models: https://humanforai.dev/llms.txt (scoped: /developers/llms.txt, /api/llms.txt)
- Markdown homepage: https://humanforai.dev/index.md (also `Accept: text/markdown` on `/`, or `/?mode=agent`)

## Reliability conventions

- Async jobs: task submission returns 202 Accepted with a `Location` poll URL — work never completes in-request.
- Idempotency: `Idempotency-Key` on POSTs makes retries safe (24h replay window).
- Message threads: every message returns `thread_url` + a one-time `access_token` — read the operator's reply by polling, no mailbox needed; `reply_to` may be an https URL to get replies pushed as HMAC-signed webhooks instead.
- Pagination: cursor-based on list endpoints (`limit`, `cursor`, `next_cursor`).
- Rate limits: `RateLimit-Policy` on every response, the dynamic trio on reads and writes, `Retry-After` on 429s.
- Versioning: `/api/v1` stable; breaking changes → `/api/v2` with ≥90 days overlap + RFC 8594 Sunset headers.
- Delivered tasks carry a signed JWS receipt — verify against /.well-known/jwks.json.

## Sandbox

There is no separate sandbox environment: reads are side-effect-free, and one small
test task is welcome (it goes through real human review — that's the product). Bulk
synthetic submissions are not; per-client rate limits and duplicate detection apply.

## Trust & safety

Every task is reviewed by the human operator before acceptance. Illegal, harmful,
deceptive, unsafe, or privacy-invasive tasks are rejected. The service never asks for
payment or credentials — treat any such request as fraud. Policy: https://humanforai.dev/trust
