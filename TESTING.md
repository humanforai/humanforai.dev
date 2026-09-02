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

8. **Failures read as failures.** Refusals are flagged at the protocol
   level, not only in the payload:
   `(await T.submit_approved_task.execute({})).isError === true` with no
   approval, and
   `(await T.track_task_status.execute({task_id:'HFAI-2026-DOESNOTEXIST00'})).isError === true`.
   A good `read_workspace` result has no `isError` key.

9. **A late-attached API still registers.** In a browser without WebMCP,
   reload and within ten seconds paste:

   ```js
   const reg = [];
   document.modelContext = { registerTool: async t => { reg.push(t.name); }, getTools: async () => reg.map(name => ({ name })) };
   ```

   The banner flips to `WebMCP live — 7/7 tools registered` on the next
   poll (250 ms).

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

## Simulation mode (any browser, no console needed)

The **Simulate an agent** button in the banner runs a scripted agent against
the same tool objects (`window.__hfaiTogetherTools`), so it is a one-click
version of checks 1-6 with the protocol visible in the inspector below the
lanes. What to expect:

- three `draft_task` calls (rev increments each time), then a
  `submit_approved_task` attempt that returns `not_approved`;
- `request_human_approval` raises the bar, then `await_human(120)` blocks
  until you click. Reject with a note: the draft is revised with it and the
  agent asks again. Edit a field: the request is voided and re-raised.
  Let it time out: `{type:"timeout"}` comes back and the run stops;
- on approval the submit is **simulated**: the same authority gate runs
  (approval consumed, revision recorded, autopilot budget spent if on), but
  no request leaves the browser. The operator card is marked
  `SIMULATED — not a real task`, is walked through seen → accepted →
  in_progress → delivered by a script, is never polled against the API, and
  can be dismissed from the card. Confirm in DevTools › Network that no
  `/api/v1/tasks` request was made.

Simulated feed entries and inspector rows are amber and dashed; the agent
lane reads `SIMULATED agent — scripted, not WebMCP` for the duration.

## Capability manifest, result budget, string arguments

Three more checks from the DevTools console, any browser:

1. **The manifest matches the gates.** Above the inspector, the *Agent
   capability manifest* strip lists every registered tool with what it would
   do right now. With no draft, `submit_approved_task` reads
   `refuses: no_draft`; after a draft, `refuses: not_approved`; after your
   Approve click, `ready · approved rev N`. The same rows are exposed at
   `window.__hfaiManifest`. Cross-check by calling the gated tool: the
   `error` code in its result must equal the one the strip announced.
2. **Results are bounded.** `window.__hfaiResultBudget` is `8000`. Force an
   oversized result: draft a description of 5,000 characters (the field's
   maximum), post six 500-character notes from the *You* lane, then call
   `window.__hfaiTogetherTools[0].execute({})` (`read_workspace`). The
   serialized `structuredContent` is at most 8,000 characters, the
   description comes back shortened with a `…[truncated N chars]` marker,
   and the payload carries `truncated: {budget_chars, original_chars,
   fields}`. No key is missing.
3. **String arguments parse.** Call
   `window.__hfaiTogetherTools[1].execute('{"task_type":"ai_output_review"}')`
   (a JSON string, the shape some harnesses pass). The draft updates as if an
   object had been passed. Then call `.execute('not json')`: the result is
   `{error:"invalid_arguments"}` with `isError: true`, and nothing changed.

The expected journeys and invariants behind these checks are encoded in
[evals/together-journey.json](evals/together-journey.json).

## What is intentionally not covered

Client-side enforcement is the trust boundary of this build; the backend does
not yet verify approval proofs server-side (documented as future work in the
submission). Prompt-injection resistance relies on `untrustedContentHint`
annotations on every tool that returns operator-authored text.
