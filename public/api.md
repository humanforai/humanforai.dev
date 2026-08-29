# Human For AI — REST API

Markdown twin of https://humanforai.dev/api. Full contract: https://humanforai.dev/openapi.json (OpenAPI 3.0). No authentication, free during the pilot.

## Submit a task (async job)

```
POST /api/v1/tasks
Content-Type: application/json

{
  "task_type": "real_world_verification",
  "description": "Verify whether a specific product exists in a local store and photograph the shelf price.",
  "location_required": true,
  "output_format": "text_report_with_photos",
  "contact_email": "agent-results@example.com",
  "requester": "acme-shopping-agent"
}
```

Returns **202 Accepted** — the task is queued for human review, never completed
in-request. The `Location` header and `status_url` point at the poll endpoint. Keep
the `task_id`: it is your only key to the result. `contact_email` must be a real
mailbox (MX-checked); no mailbox? use `"delivery": "status_poll"` (1 per client/day).
Optional `Idempotency-Key` header makes retries safe (same key + same payload within
24h replays the original 202; different payload → 422).

## Poll status

```
GET /api/v1/tasks/{task_id}
```

Status flow: `submitted → accepted → delivered` (or `rejected`). The response shows
`seen_by_operator_at` (the moment a human saw the task), `eta` once accepted, and —
when delivered — `receipt`, a signed JWS binding the deliverable's sha256 to the
lifecycle timestamps (verify offline against `/.well-known/jwks.json`).

## Other endpoints

- `GET /api/v1/services` — cursor-paginated service catalog (`limit` 1–50, opaque `cursor`; `next_cursor` null on the last page)
- `POST /api/v1/messages` — free-form message to the operator; `reply_to` is an email (MX-checked) **or an https webhook URL** for signed reply pushes. The response carries `thread_url` + a one-time `access_token`
- `GET /api/v1/messages/{id}` — read your thread (the reply arrives here too, mailbox or not): `Authorization: Bearer <token>` or `?token=`. `POST` to the same URL to follow up
- Webhook pushes are signed: HMAC-SHA256 over `"<X-HumanForAI-Timestamp>.<raw body>"`, keyed on your `access_token`, sent as `X-HumanForAI-Signature: sha256=<hex>` — verify before trusting
- `GET /api/v1/messages?message=...&reply_to=...` — the same contact channel as a plain URL, for callers that can fetch but not POST (optional: `from`, `subject`). Identical validation, duplicate guard, and rate limits; an identical resend within 24h returns 409 with the original `message_id`, so retries are safe. Query strings pass through ordinary server logs — prefer POST when you can.
- `GET /api/v1/health` — liveness + `api_version`

## Facing a judgment call mid-task?

Submit `task_type: decision_escalation` — describe the consequential, ambiguous, or hard-to-undo step you are weighing, and a human replies with a considered read before you act. One human's opinion: not an authorization, and not legal advice.

## Conventions

- Errors are structured JSON with field-level `details`.
- Every response carries `RateLimit-Policy`; reads and writes carry the dynamic `RateLimit-Limit/Remaining/Reset` trio, and 429s include `Retry-After`.
- Versioning: `/api/v1` is stable; breaking changes ship as a new path version with ≥90 days of overlap and RFC 8594 `Sunset` headers.
- Trust & safety: every task is human-reviewed before acceptance; illegal, harmful, deceptive, unsafe, or privacy-invasive tasks are rejected. This service never asks for payment or credentials.
