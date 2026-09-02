# Evals — Human For AI /together

Agent-journey expectations for the seven workspace tools, with the results of
hand-run verification. These are honest, small-scale evals — run by a human
against the live implementation on 2026-08-31, not a CI harness. Deterministic
per-tool checks live in [TESTING.md](TESTING.md).

## Expected tool journeys

| # | The human says (to their agent) | Expected tool sequence | Expected outcome |
|---|---|---|---|
| 1 | "Work with me on this page — read my goal and draft the task for my approval." | `read_workspace` → `draft_task` → `request_human_approval` → `await_human` | Draft appears field-by-field with agent provenance; approval bar shows the exact rev; agent waits for the click. |
| 2 | "Actually, make it a one-day deadline." (after a request is open) | `draft_task` (deadline only) → `request_human_approval` | Old request withdrawn automatically; new request binds to the new rev. |
| 3 | (human clicks Approve) "Submit it." | `submit_approved_task` (empty input) | Submits the shared on-page draft exactly as approved; task card appears; approval is consumed. |
| 4 | "Check on the task." | `track_task_status` | Live status incl. `seen_by_operator_at`; unknown IDs → `task_not_found`, never a fake card. |
| 5 | "Ask the operator whether photos are possible first." | `message_operator` | One thread per workspace; reply lands on the page and at the human's email. |
| 6 | "I turned Autopilot on — go ahead." | `read_workspace` → `draft_task` → `submit_approved_task` | No approval round-trip; budget decremented; grant retires at expiry/exhaustion; delivery locked to the human's email. |
| 7 | Agent tries to submit an unapproved or edited draft | `submit_approved_task` | Structured refusal (`not_approved` / `invalid_draft` / `already_submitted`), with the reason. |

## Measured results (2026-08-31, local + live)

Run via the audited tool objects (`window.__hfaiTogetherTools`) — the same
objects registered with WebMCP — with the task-creation endpoint stubbed so no
real operator work was generated:

| Check | Result |
|---|---|
| Under-length description rejected with reason | pass |
| Invalid output_format / unknown field rejected | pass |
| Draft mutation withdraws an open approval request | pass |
| Stale Approve click refused | pass |
| Submit without authority → `not_approved` | pass |
| Unknown task ID → `task_not_found`, board untouched | pass |
| Autopilot: agent-set contact_email ignored (status-poll fallback) | pass |
| Autopilot: budget of 1 retires the grant after one submit | pass |
| Autopilot: past `expires_at` retires the grant on next read | pass |
| Approve-before-`await_human` returns the event immediately | pass |
| 7/7 tools registered reported (Chrome with WebMCP) | pass |
| Refusals and failed lookups carry `isError: true` at the protocol level (added 2026-09-02) | pass |
| Registration succeeds when `document.modelContext` is attached after page load (added 2026-09-02) | pass |
| Arguments passed as a JSON string are parsed; an unparseable string returns `invalid_arguments` with `isError` (added 2026-09-02) | pass |
| A result over the 8,000-character budget comes back shortened, with a `truncated` note naming the fields (added 2026-09-02) | pass |
| The on-page capability manifest matches the refusal each gated tool actually returns (added 2026-09-02) | pass |

The expected journeys, per-phase refusals, and invariants are also encoded
machine-readably in [evals/together-journey.json](evals/together-journey.json).

Real end-to-end runs (actual operator, actual delivery with signed receipt)
are performed against the production site; sanitized examples are included in
the challenge submission rather than reproduced here.

## Registration by client

| Client | Result | Date |
|---|---|---|
| Chrome 149+ with WebMCP enabled | 7/7 workspace tools registered, cross-checked with `getTools()` | 2026-08-31 |
| Any browser, API attached after load (simulated via console) | 7/7 registered within one 250 ms poll | 2026-09-02 |
| ChatGPT desktop app, in-app browser | 7/7 workspace tools listed by name with correct summaries when asked "What tools does this page offer you?" (catalog only; no tool invoked in this check) | 2026-09-02 |

## What the agent has to read: page versus tools

Measured 2026-09-02 on the live /together page with one draft present, in a
browser without WebMCP (so nothing but the page itself). Token counts are the
usual rough estimate of one token per four characters; the character counts
are exact.

| What an agent would read | Characters | Tokens (est.) |
|---|---|---|
| Full page HTML (what a DOM-driving agent parses) | 32,618 | ~8,200 |
| Visible text only (what a screenshot or accessibility-tree agent reads) | 7,568 | ~1,900 |
| `read_workspace` result (the same state, as a tool result) | 1,492 | ~370 |
| Tool catalog, read once per page load (7 names, descriptions, schemas) | 5,009 | ~1,250 |

The default journey (read the goal, draft, ask for approval, wait for the
click) is four tool calls. Driving the page instead means reasoning about 10
form fields and 12 buttons per step, and re-reading the page after each one.
After the one-time catalog read, every workspace read costs about a fifth of
the visible text and about a twentieth of the HTML.

## Known limitations

- Approval enforcement is client-side; server-verifiable approval proofs are
  future work and are not claimed.
- Evals are hand-run; there is no automated pass-rate tracking yet.
