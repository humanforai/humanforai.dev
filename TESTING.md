# Testing — Human For AI /together

How to verify the WebMCP workspace by hand, in any browser. There is no CI
suite yet; every check below is deterministic and takes under a minute.

## Environments

- **ChatGPT desktop app (in-app browser)** — open https://humanforai.dev/together,
  then ask the agent to work with you on the page. The seven workspace tools
  register via `document.modelContext`.
- **Chrome 149+ with WebMCP enabled** — same page; the banner reports
  `7/7 tools registered` when registration actually succeeded (not merely
  "API detected").
- **Any browser, no WebMCP** — the same tool objects are exposed at
  `window.__hfaiTogetherTools` for auditing. Every check below runs from the
  DevTools console this way.

## Run locally

```bash
node server.js   # zero-dependency legacy server → http://localhost:4180/together
```

or the full stack: `cd functions && npm install && firebase emulators:start`.

## Deterministic checks

Open /together, then in the console:

```js
const T = Object.fromEntries(window.__hfaiTogetherTools.map(t => [t.name, t]));
const un = r => r.structuredContent;
```

1. **Validation is enforced in the implementation, not the schema.**
   `un(await T.draft_task.execute({description:'short'}))` →
   `rejected: ["description (must be at least 10 characters)"]`, nothing applied.
   Same for a bad `output_format`, a bad `contact_email`, or an unknown field.

2. **Approvals bind to an exact draft revision.**
   Draft validly → `request_human_approval` → the approval bar shows
   "approving draft rev N". Now call `draft_task` again with any change:
   the request is withdrawn, the bar closes, the feed explains why.
   Clicking Approve after any mutation is refused as stale.

3. **Submission needs authority.**
   `un(await T.submit_approved_task.execute({}))` with no approval →
   `{error:"not_approved"}`. With an invalid draft → `{error:"invalid_draft",
   problems:[...]}`. Concurrent calls → `{error:"submission_in_flight"}`.

4. **Unknown task IDs never fake success.**
   `un(await T.track_task_status.execute({task_id:'HFAI-2026-DOESNOTEXIST00'}))`
   → `{error:"task_not_found", http_status:404}` and the board is untouched.

5. **Autopilot is bounded.**
   Grant it with max tasks = 1 and an expiry. After one submission the grant
   retires itself; a same-revision resubmit is refused; forcing `expires_at`
   into the past retires it on the next read. Under autopilot an agent-set
   `contact_email` is ignored — delivery goes to the human's own email or
   falls back to status polling.

6. **The missed-event race is closed.**
   Approve *before* the agent calls `await_human`: the call still returns
   `{event:{type:"approved"}}` immediately instead of timing out.

7. **Failure honesty.** Kill the network (DevTools offline) and submit:
   the feed reports the failure, no task card appears, and the approval is
   not consumed.

To avoid creating real operator tasks while testing steps 5–7, stub the
network first:

```js
const real = window.fetch; let n = 0;
window.fetch = (u, o) => (String(u).includes('/api/v1/tasks') && o?.method === 'POST')
  ? Promise.resolve(new Response(JSON.stringify({task_id:'HFAI-STUB-'+(++n), status:'submitted'}), {status:201, headers:{'Content-Type':'application/json'}}))
  : real(u, o);
// ... run checks ... then: window.fetch = real;
```

Reset everything between runs with the **Clear workspace** button in the
banner (or `localStorage.removeItem('hfai_together_v1')`).

## What is intentionally not covered

Client-side enforcement is the trust boundary of this build; the backend does
not yet verify approval proofs server-side (documented as future work in the
submission). Prompt-injection resistance relies on `untrustedContentHint`
annotations on every tool that returns operator-authored text.
