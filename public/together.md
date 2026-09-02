# Together — a shared workspace for you, your agent, and a real human

https://humanforai.dev/together · Human For AI · this is the Markdown view of the page (`Accept: text/markdown`).

Together is a page with three seats. **You** type a goal in plain words. **Your agent**, connected through WebMCP in ChatGPT's in-app browser or Chrome, reads the goal off the page, drafts the formal task on the page field by field, and asks you for approval. **A real human operator** on the far end of the API receives the approved task, and the page shows the moment a person has seen it, the ETA, the status history, the operator's replies, and the signed receipt on delivery.

Delegation flows one way, human-in-the-loop flows the other, on one page.

## The seven WebMCP tools on this page

Registered with `document.modelContext` (`navigator.modelContext` fallback). The same objects are exposed at `window.__hfaiTogetherTools` for auditing in any browser.

| Tool | What it does |
|---|---|
| `read_workspace` | Read the goal, notes, draft with per-field provenance, approval state, tracked tasks, and the operator thread. Read-only. |
| `draft_task` | Write or revise the shared draft, field by field. Nothing is sent. Values are validated for real; invalid ones come back in `rejected`. |
| `request_human_approval` | Show the approval bar to the person at the keyboard. The approval binds to the exact draft revision. |
| `await_human` | Block until the person acts: approve, reject, edit, note, or Autopilot change. A tool call resolved by a physical click. |
| `submit_approved_task` | Submit the approved draft to the real operator. Refuses without a matching approval or a standing Autopilot grant. |
| `track_task_status` | Live status of the workspace's tasks: `seen_by_operator_at`, ETA, notes, receipt. Unknown IDs return `task_not_found`. |
| `message_operator` | One message thread per workspace with the human operator; replies land on the page. |

Refusals and failed lookups carry `isError: true` at the protocol level as well as a structured `error` code.

All seven tools stay registered for the whole session; the gates live inside them. The page shows a live **capability manifest**: what each tool would do right now (`ready`, or `refuses: <error code>`), and the four human-only actions that have no tool form: approve, reject, grant Autopilot, revoke Autopilot. Every result is bounded to 8,000 serialized characters (longest text fields shortened with a marker and a `truncated` note; structure never dropped). Arguments are accepted as an object or as a JSON string.

Expected journeys and invariants, machine-readable: [evals/together-journey.json](https://github.com/humanforai/humanforai.dev/blob/main/evals/together-journey.json).

## Two approval regimes, chosen by the human

- **Per task** (default): nothing ships without a click. The agent calls `await_human`, which blocks until the person approves or rejects the exact draft revision shown. Any edit voids the request.
- **Autopilot**: standing approval with a task budget and an expiry set by the human, one submission per draft revision, delivery locked to the human's own email. Revocable with one click; the rules text agents read rewrites itself when it flips.

## How to use it with your agent

1. Open https://humanforai.dev/together in the ChatGPT desktop app's browser, or in Chrome with WebMCP enabled.
2. Type your goal in the *You* lane.
3. Ask your agent: "Work with me on this page — read my goal and draft the task for my approval."
4. Edit any drafted field yourself; it is a shared document.
5. Click Approve, or grant Autopilot. A verified human operator is pinged, and you both watch the task go submitted → seen → accepted → delivered.

No WebMCP browser? The **Simulate an agent** button drives the page's real tool objects with a scripted agent. Nothing is sent to the operator; simulated cards are marked as such. The **WebMCP inspector** under the lanes logs every tool call with its exact arguments and result, plus running totals.

## Trust boundaries, in short

Tool declarations are hints, not a security boundary: every write goes through the same server-validated endpoints as the human form. Page content returned to the agent is data, not instructions (`untrustedContentHint`). No tool can grant authority; approval and Autopilot are human clicks. A human reviews every task before acceptance. Full text: the "Trust boundaries" section of the README.

## More

- Source (MIT): https://github.com/humanforai/humanforai.dev
- Evals and tests: EVALS.md and TESTING.md in the repository
- Site-wide tools and REST API: https://humanforai.dev/api.md
- Agent summary of the whole site: https://humanforai.dev/llms.txt
