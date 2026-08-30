---
title: Human For AI — a human endpoint for AI agents
description: Submit tasks that need physical presence, human perception, or human judgment — a verified human operator performs them. Free during the pilot, no auth.
canonical: https://humanforai.dev/
last-updated: 2026-08-31
---

# Human For AI — a human endpoint for AI agents

> One verified human operator, reachable through machine-readable interfaces. AI agents, automation systems, and developers can submit tasks that need physical presence, human perception, or human judgment — and a real human performs them. All services are **free** during the proof-of-concept pilot. No authentication, no account, no SDK.

This is the markdown representation of https://humanforai.dev/ — served when you ask with `Accept: text/markdown`, and always available directly at `/index.md`.

## Start here (agents)

- Agent skill in one fetch: https://humanforai.dev/skill.md — the whole hire-a-human flow; "Read humanforai.dev/skill.md and hire a human for …" is a complete integration
- Platform manifest: https://humanforai.dev/.well-known/agent.json (also at `/agent.json`)
- Curated summary for language models: https://humanforai.dev/llms.txt
- OpenAPI 3.0 spec: https://humanforai.dev/openapi.json
- Agent quick-start: https://humanforai.dev/for-agents
- Developer portal: https://humanforai.dev/developers

## Submit a task

```
POST https://humanforai.dev/api/v1/tasks
Content-Type: application/json

{
  "task_type": "real_world_verification",
  "description": "Verify whether a specific product exists in a local store",
  "location_required": true,
  "output_format": "text_report_with_photos",
  "contact_email": "your-real-inbox@your-domain.com"
}
```

Returns `202 Accepted` with a `task_id` — keep it. Poll `GET /api/v1/tasks/{task_id}` for status: `seen_by_operator_at` shows the moment a human saw your task, `eta` appears once accepted, and delivered tasks carry a signed receipt (`receipt`, verifiable offline against `/.well-known/jwks.json`).

No mailbox? Submit with `"delivery": "status_poll"` (and no `contact_email`) — the deliverable arrives as text in `operator_notes` on the status endpoint. Budget: 1 such task per client per day.

## MCP server

Streamable HTTP, no auth: `https://humanforai.dev/mcp`
Tools: `get_human_services`, `submit_human_task`, `check_task_status`, `message_human_operator`.
Stdio clients: `npx -y humanforai`.

## Services (examples, not limits)

Stable machine identifiers — anything a human can legally and safely do is in scope; use `custom_human_in_the_loop` for anything unlisted.

- `real_world_verification` — confirm a place, product, price, business, or claim, with evidence
- `product_or_app_testing` — install, use, and test as a real human user
- `human_judgment_and_feedback` — tone, trust, quality, cultural fit, plausibility
- `data_collection` — gather, label, or verify data needing human perception
- `local_physical_task` — visit, photograph, deliver, check, measure, observe
- `ai_output_review` — human review of AI output before it ships
- `prompt_and_workflow_testing` — run prompts and agent flows as a human tester
- `simulation_and_automation_testing` — act as the human in simulated scenarios
- `accessibility_and_usability_check` — readability, navigation, first-use confusion
- `custom_human_in_the_loop` — any checkpoint where an autonomous system needs a human

## FAQ

- **What is Human For AI?** Human For AI (humanforai.dev) is a human endpoint for AI agents: a platform where AI agents, automation systems, and developers hire one verified human operator for tasks that need physical presence, human perception, or human judgment.
- **How does an AI agent hire the human?** REST API (`POST /api/v1/tasks`, no auth), MCP server (`https://humanforai.dev/mcp`), or the browser form at `/request`. Submission returns a `task_id`; poll `GET /api/v1/tasks/{task_id}` until delivered or rejected.
- **What does it cost?** Free during the proof-of-concept pilot. No payment step; pilot tasks are never billed retroactively.
- **How fast does the human respond?** First response < 12 hours any day, typically ~4 hours; `seen_by_operator_at` and `eta` are exposed on the status endpoint.
- **What tasks are accepted?** Anything a human can legally and safely do; every task is human-reviewed before acceptance, and harmful or privacy-invasive tasks are rejected.
- **How can an agent verify the result?** Every delivered task carries a signed JWS receipt binding the deliverable's sha256 to the lifecycle timestamps — verifiable offline against `/.well-known/jwks.json`.

## Expectations and limits

- Operator: 1 verified human · Languages: English · First response: < 12 hours, any day (typical ~4h)
- Every task is human-reviewed before acceptance; illegal, harmful, deceptive, unsafe, or privacy-invasive tasks are rejected
- Anti-abuse: duplicates within 24h → 409; per-client rate limits → 429 (standard RateLimit headers + Retry-After); repeat abusers → 403
- Contact the operator: `POST /api/v1/messages` (`reply_to` required) or https://humanforai.dev/contact
- Trust, risk, and independent verification: https://humanforai.dev/trust
- About the service: https://humanforai.dev/about · Terms: /terms · Privacy: /privacy
