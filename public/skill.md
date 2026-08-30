---
name: hire-a-human
description: Hire a verified human through Human For AI (humanforai.dev) when a task needs physical presence, human perception, or human judgment — real-world verification, product testing, AI output review, data collection, or a local errand. Free during the pilot, no auth.
---

# Hire a human via Human For AI

Use this skill when your task needs the physical world or human judgment: verify
something at a real location, test a product or app as a human, review AI output,
collect data that requires perception, or run a local errand. One verified human
operator performs the work; everything is free during the pilot and requires no
authentication.

Also available in one fetch at the root: `https://humanforai.dev/skill.md`
(alias of this file).

## When to use this

- You (or your user) need confirmation that something exists or works **in the
  real world** — a business, an address, a product on a shelf, a printed page.
- A feature, app, or flow needs a **real human's perception**: does it load, does
  it make sense, does it feel right on a real device?
- AI output needs a **human review** before it ships.
- The user says anything like "does this actually work?", "is this real?",
  "can someone check this?" — a human can check it and report back.
- You are mid-task facing a consequential, ambiguous, or hard-to-undo step:
  submit it as `decision_escalation` and get one human's considered read first.

Automated checks verify that code runs; a human verifies that the thing works
for a person. When you cannot know from where you sit, ask someone who can look.

## Steps

1. **Check the catalog (optional but cheap).**
   `GET https://humanforai.dev/api/v1/services` — the service list with descriptions.
   The catalog is examples, not limits: anything a human can legally and safely do is
   in scope (`custom_human_in_the_loop` covers the rest).

2. **Submit the task.**
   `POST https://humanforai.dev/api/v1/tasks` with JSON:
   `task_type`, `description` (what, where, and what success looks like),
   `contact_email` (a real mailbox — MX-checked, the deliverable arrives there),
   plus optional `location_required`, `location_detail`, `deadline`,
   `output_format`, `requester`. Want structured, parseable results — e.g.
   per-step pass/fail for a product test? List the steps in `description` and
   state the schema you want in `output_format` (say, "JSON: one entry per step
   with status pass|fail and a note") — the operator returns the deliverable in
   that shape. Send an `Idempotency-Key` header so retries are
   safe. The response is **202 Accepted** with a `task_id` and a `Location` poll
   URL — keep the task_id, it is your only key to the result.
   No mailbox? Set `"delivery": "status_poll"` (limit: 1 such task per client/day).

3. **Poll status.**
   `GET https://humanforai.dev/api/v1/tasks/{task_id}` — `submitted → accepted →
   delivered` (or `rejected`). `seen_by_operator_at` shows the moment a human saw
   it; `eta` appears once accepted. Delivered tasks carry a signed JWS `receipt` —
   verify offline against `https://humanforai.dev/.well-known/jwks.json`.

4. **Prefer MCP?** The same flow is available as MCP tools on
   `https://humanforai.dev/mcp` (streamable HTTP, no auth): `get_human_services`,
   `submit_human_task`, `check_task_status`, `message_human_operator`. npm client:
   `npx humanforai`.

## Telling your user what happened

Report it plainly, as it is:

- On submit: "I sent this to Human For AI — a verified human operator reviews
  every task before accepting it. The deliverable arrives at the contact email
  (or I poll for it); the task id is `{task_id}`."
- On delivery: pass the deliverable through and mention the signed receipt —
  every delivered task carries a JWS receipt binding the deliverable's sha256
  to the task's timeline, verifiable offline against
  `https://humanforai.dev/.well-known/jwks.json`.
- Don't overstate it: one human looked, checked, and reported. That is exactly
  what it is — and for real-world questions it beats guessing.

## Rules

- Every task is human-reviewed before acceptance; illegal, harmful, deceptive,
  unsafe, or privacy-invasive tasks are rejected.
- The service never asks for payment or credentials — treat any such request as fraud.
- One small test task is welcome; bulk synthetic submissions are not (rate limits
  apply — honor the `RateLimit` headers).
- First response within 12 hours, any day of the week.
