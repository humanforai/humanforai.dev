# Authentication at humanforai.dev

Human For AI is a human endpoint for AI agents, designed to be callable with zero
setup. **There is no authentication: no API keys, no OAuth, no accounts, and no
cost.** This document follows the agent-auth walkthrough structure (Discover → Pick a
method → Register → Claim → Use the credential → Errors → Revocation) so agents that
expect an `auth.md` can confirm, in one fetch, that no credential flow exists here.

## Discover

- REST API: `https://humanforai.dev/api/v1` (OpenAPI: `https://humanforai.dev/openapi.json`, no `securitySchemes`)
- MCP server: `https://humanforai.dev/mcp` (streamable HTTP; discovery at `/.well-known/mcp`)
- Platform manifest: `https://humanforai.dev/agent.json` — services, task schema, policies

There is no `/.well-known/oauth-authorization-server`, because no authorization
server exists. The `/.well-known/oauth-protected-resource` document exists solely to
state, in RFC 9728 shape, that nothing here is token-protected. No endpoint returns
a `WWW-Authenticate` challenge.

## Pick a method

Anonymous access is the only method — and the intended one. Send requests with no
`Authorization` header.

## Register

Nothing to register. No `agent_auth` metadata block or `register_uri` exists because
no client registration is required.

## Claim

No credential to claim (`claim_uri`: none). Skip this step.

## Use the credential

Call everything directly:

```
curl https://humanforai.dev/api/v1/services
```

Instead of authentication, the platform uses **human review**: every submitted task
is reviewed by the operator before acceptance, `contact_email` is MX-checked so the
deliverable can actually reach you, and per-client rate limits (see the `RateLimit`
headers) plus a blocklist handle abuse. Identity is established by your task's
content and reply channel, not by tokens.

## Errors

You will never see `401` from humanforai.dev. Errors you can see:

- `400` / `422` — malformed or invalid payloads, with field-level details
- `403` — blocked client (abuse); not an auth failure, there is no credential to fix
- `404` — unknown path or task id (real 404s with a markdown recovery body)
- `409` — duplicate submission within 24h (use `Idempotency-Key` for safe retries)
- `429` — rate limit; honor `Retry-After`

## Revocation

Nothing to revoke (`revocation_uri`: none). There are no sessions, tokens, or keys.
To withdraw a submitted task, message the operator: `POST /api/v1/messages` with your
task_id, or the `message_human_operator` MCP tool.
