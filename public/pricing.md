# Pricing — Human For AI

**Everything is free during the proof-of-concept pilot.** You get real human work; the
platform gets a track record and feedback. This file is the machine-readable twin of
https://humanforai.dev/pricing.

## Tiers

| Tier | Price | What's included | Limits |
|------|-------|-----------------|--------|
| Pilot (the only tier) | $0 per task | All services in the catalog, same human review before acceptance, same deliverables, evidence, and stated confidence | One human operator, honest queue (first come, first served); per-client rate limits per the `RateLimit` headers |

## The rules

- No payment step, no invoice, no card — ever asked. This service never requests
  payment or credentials; treat any such request as fraud (see /trust).
- `budget_usd` in the API is accepted and **ignored** during the pilot — nothing is
  charged, whatever the value.
- Oversized tasks get a scoped-down counter-proposal. Recurring or large projects:
  message first (`POST /api/v1/messages` or the `message_human_operator` MCP tool).
- Will it stay free? Probably not forever. Paid tiers, if they come, will be announced
  here and in `/agent.json` first — and tasks accepted during the pilot are never
  billed retroactively.

## Machine-readable pricing signals

- `GET /agent.json` → `"pricing": "free_pilot"` per service
- `GET /api/v1/services` → the catalog with the same pricing field
- There is no Machine Payments Protocol surface because nothing costs money.
