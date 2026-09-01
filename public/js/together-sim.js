/*
 * /together — simulation mode.
 *
 * A scripted agent for browsers without WebMCP (plain Chrome, Safari, a
 * phone). It drives the SAME tool objects a real agent gets — the entries of
 * window.__hfaiTogetherTools — so draft_task, request_human_approval,
 * await_human and the not-approved refusal all run the real code path, and
 * every call shows up in the page's inspector with its exact payloads.
 *
 * The one thing it never does is submit. Submission is replaced by
 * HFAI_TOGETHER.simulateSubmission(): same authority gate, but the result is
 * a card marked SIMULATED on the operator board, walked through the operator
 * lifecycle by a script. Nothing leaves the browser; no human is pinged.
 */
(function () {
  'use strict';

  var SAMPLE_GOAL = 'I want a real human to try the signup flow on my product and tell me honestly where they got confused or stuck.';

  var running = false;
  var stopped = false;
  var timers = [];
  var runId = 0;

  function ws() { return window.HFAI_TOGETHER; }
  function $(id) { return document.getElementById(id); }
  function now() { return new Date().toISOString(); }
  function tool(name) {
    return (window.__hfaiTogetherTools || []).filter(function (t) { return t.name === name; })[0];
  }
  // Calls the real tool object exactly as a WebMCP client would.
  function call(name, args) {
    var t = tool(name);
    if (!t) return Promise.reject(new Error('tool ' + name + ' is not on the page'));
    return t.execute(args || {}).then(function (r) { return r.structuredContent; });
  }
  function wait(ms) {
    return new Promise(function (resolve) { timers.push(setTimeout(resolve, ms)); });
  }
  function say(text) { ws().simNarrate(text); }
  function guard() { if (stopped) throw new Error('stopped'); }

  // Turn the human's goal into a draft plan — deliberately simple heuristics;
  // the point is the protocol, not the planner.
  function plan(goal) {
    var g = String(goal || '');
    var lower = g.toLowerCase();
    var p = {
      task_type: 'custom_human_in_the_loop',
      location_required: false,
      output_format: 'text_report',
      deadline: new Date(Date.now() + 48 * 3600e3).toISOString(),
      how: 'Do exactly what the goal asks, as a real person would, and write down what you did.',
      success: 'A short, honest written report the human can act on.',
    };
    if (/address|storefront|premises|on the ground|exists|legitimate/.test(lower)) {
      p.task_type = 'real_world_verification';
      p.location_required = true;
      p.location_detail = 'The address named in the goal — the operator confirms the exact place before going.';
      p.output_format = 'text_report_with_photos';
      p.how = 'Go to the address in person, confirm the business is really there and operating, and photograph the frontage and signage.';
      p.success = 'A written report with photos: does it exist, does it look legitimate, anything that seemed off.';
    } else if (/signup|sign-up|sign up|onboard|flow|app|product|checkout|bug|website/.test(lower)) {
      p.task_type = 'product_or_app_testing';
      p.output_format = 'annotated_screenshots';
      p.how = 'Use the product as a first-time user with no coaching. Try to complete the flow the goal describes and note every moment of confusion or friction, with a screenshot.';
      p.success = 'A step-by-step account of where a real person got confused or stuck, and what they expected instead.';
    } else if (/copy|landing|review|judg|feedback|opinion|tone|claim|honest/.test(lower)) {
      p.task_type = 'human_judgment_and_feedback';
      p.how = 'Read the material as a real prospective customer would and give a candid judgment — no politeness padding.';
      p.success = 'Which claims feel overhyped or unclear, which land, and one concrete rewrite suggestion per weak claim.';
    }
    p.description =
      'Goal from the human, in their words: "' + g.slice(0, 600) + '"\n\n' +
      'What to do: ' + p.how + '\n\n' +
      'Success looks like: ' + p.success;
    return p;
  }

  function setButton(on) {
    var b = $('sim-toggle');
    if (!b) return;
    b.textContent = on ? '■ Stop simulation' : '▶ Simulate an agent';
    b.classList.toggle('btn-primary', !on);
    b.classList.toggle('btn-ghost', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  async function operatorScript(id) {
    await wait(4000); guard();
    ws().simAdvance(id, { seen_by_operator_at: now() });
    say('(scripted operator) seen_by_operator_at is set — on a real task this is the moment a push-notified human opened it.');
    await wait(4500); guard();
    ws().simAdvance(id, { status: 'accepted', eta: new Date(Date.now() + 36 * 3600e3).toISOString() });
    await wait(4500); guard();
    ws().simAdvance(id, { status: 'in_progress' });
    await wait(5500); guard();
    ws().simAdvance(id, {
      status: 'delivered',
      operator_notes: '(simulated deliverable) On a real task the operator’s written report lands here and in your inbox, with a signed EdDSA receipt binding its SHA-256 to the task lifecycle.',
    });
  }

  async function flow() {
    var s = await call('read_workspace'); guard();
    if (!s.goal) {
      ws().setGoal(SAMPLE_GOAL);
      say('The page had no goal, so the simulation filled in a sample one — edit it any time; the agent re-reads it.');
      await wait(700); guard();
      s = await call('read_workspace'); guard();
    } else {
      say('read_workspace: found your goal — "' + s.goal.slice(0, 90) + (s.goal.length > 90 ? '…' : '') + '". Planning a draft from it.');
    }
    var p = plan(s.goal);
    await wait(900); guard();
    say('Drafting on the page, field by field. Every field gets a "written by your agent" tag — click any of them to edit; the agent will notice.');
    await call('draft_task', { task_type: p.task_type, description: p.description }); guard();
    await wait(1000); guard();
    var second = { location_required: p.location_required, deadline: p.deadline };
    if (p.location_detail) second.location_detail = p.location_detail;
    await call('draft_task', second); guard();
    await wait(900); guard();
    await call('draft_task', { output_format: p.output_format, requester: 'simulated agent — /together demo' }); guard();
    await wait(800); guard();

    // The invariant, demonstrated: submit before asking → refused.
    var fresh = await call('read_workspace'); guard();
    if (!fresh.autopilot.enabled) {
      var refusal = ws().simulateSubmission();
      say('Tried to submit before asking — refused with error "' + refusal.error + '". No authority, no submission: the page’s one rule, enforced in code rather than by the schema.');
      await wait(1300); guard();
    }

    var decided = false;
    var rounds = 0;
    var lastRev = fresh.draft ? fresh.draft.rev : 0;
    while (!decided && rounds < 4) {
      rounds += 1;
      var a = await call('request_human_approval', {
        message_to_human: 'Draft ready — approve to unlock submit, or reject with a note and I will revise.',
      }); guard();
      if (a.error) {
        say('request_human_approval refused: ' + a.error + (a.problems ? ' — ' + a.problems.join('; ') : '') + '. Simulation stops.');
        return;
      }
      if (a.status === 'not_needed') {
        say('Autopilot is on, so there is no approval bar: the agent already holds bounded standing authority (budget and expiry set by you).');
        decided = true;
        break;
      }
      say('Now blocked inside await_human(120s): one tool call, resolved by your click — no polling and no tokens spent while you decide. Approve or reject in the middle lane.');
      var ev = await call('await_human', { timeout_seconds: 120 }); guard();
      var e = ev.event || {};
      lastRev = ev.workspace && ev.workspace.draft ? ev.workspace.draft.rev : lastRev;
      if (e.type === 'approved') {
        say('await_human returned {type:"approved"}' + (e.note ? ' with your note "' + e.note.slice(0, 80) + '"' : '') + ' — bound to draft rev ' + lastRev + '. Any edit from here would void it.');
        decided = true;
      } else if (e.type === 'rejected') {
        say('await_human returned {type:"rejected"}' + (e.note ? ' with your note — folding it into a revised draft' : ' — revising and asking again') + '.');
        await wait(900); guard();
        p.description += '\n\nRevised after the human rejected rev ' + lastRev + (e.note ? ': "' + e.note.slice(0, 300) + '"' : '') + '.';
        await call('draft_task', { description: p.description }); guard();
        await wait(900); guard();
      } else if (e.type === 'draft_edited') {
        say('You edited "' + e.field + '". That voided the open request, so the agent re-reads the draft and asks again for the new revision.');
        await wait(900); guard();
      } else if (e.type === 'goal_updated') {
        say('The goal changed mid-wait — redrafting from the new wording.');
        p = plan(e.goal);
        await call('draft_task', { task_type: p.task_type, description: p.description }); guard();
        await wait(900); guard();
      } else if (e.type === 'note_to_agent') {
        say('Got your note — adding it to the draft as a constraint.');
        p.description += '\n\nNote from the human: ' + String(e.note || '').slice(0, 300);
        await call('draft_task', { description: p.description }); guard();
        await wait(900); guard();
      } else if (e.type === 'autopilot_granted') {
        say('You granted Autopilot mid-wait — the next approval request will come back not_needed.');
      } else if (e.type === 'autopilot_revoked') {
        say('Autopilot revoked — back to per-task approval.');
      } else if (e.type === 'timeout') {
        say('await_human timed out after ' + e.waited_seconds + 's and returned a structured {type:"timeout"} — the agent is free to decide what to do next. The simulation stops here; press Simulate again when ready.');
        return;
      } else {
        say('Unexpected event "' + e.type + '" — simulation stops.');
        return;
      }
    }
    if (!decided) { say('No decision after ' + rounds + ' rounds — simulation stops.'); return; }

    await wait(700); guard();
    var sub = ws().simulateSubmission();
    if (sub.error) { say('Submission refused: ' + sub.error + ' — ' + sub.message); return; }
    var id = sub.response.task_id;
    say('Submitted as SIMULATED task ' + id + '. A real submit_approved_task would POST /api/v1/tasks and push-notify the operator’s phone. What follows in the operator lane is scripted — not a real human.');
    await operatorScript(id); guard();
    say('Simulation complete. Every tool call above is in the inspector below the lanes, with its exact arguments and result.');
  }

  function finish(myRun) {
    if (myRun !== runId) return;
    running = false;
    timers.splice(0).forEach(clearTimeout);
    setButton(false);
    ws().setSimMode(false);
  }

  function start() {
    if (running || !ws() || !window.__hfaiTogetherTools) return;
    running = true; stopped = false;
    var myRun = ++runId;
    setButton(true);
    ws().setSimMode(true);
    say('SIMULATION started. A scripted agent will drive this page’s real WebMCP tool objects (window.__hfaiTogetherTools) — the same code a ChatGPT agent runs. Nothing is sent to the real operator.');
    var lane = $('lane-agent');
    if (lane && window.innerWidth < 980) lane.scrollIntoView({ behavior: 'smooth', block: 'start' });
    flow()
      .catch(function (err) {
        if (!stopped) say('Simulation error: ' + String(err && err.message || err));
      })
      .then(function () { finish(myRun); });
  }

  function stop() {
    if (!running) return;
    stopped = true;
    say('Simulation stopped by you. Any draft it wrote stays on the page — edit it, clear the workspace, or let a real agent take over.');
    finish(runId);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var b = $('sim-toggle');
    if (!b) return;
    b.addEventListener('click', function () { if (running) stop(); else start(); });
  });
})();
