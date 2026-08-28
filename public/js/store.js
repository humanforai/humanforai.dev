/**
 * Human For AI — data layer.
 *
 * Tries the real API first (served by server.js). If the API is not
 * reachable (static hosting, file://), falls back to localStorage so the
 * whole MVP still works. To connect a real database later, only server.js
 * needs to change — this client stays the same.
 */
(function () {
  'use strict';

  const API_BASE = '/api/v1';
  const LS_KEY = 'human_api_tasks';

  /* ---- localStorage fallback ---- */

  function lsRead() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; }
    catch { return []; }
  }

  function lsWrite(tasks) {
    localStorage.setItem(LS_KEY, JSON.stringify(tasks));
  }

  function lsGenerateId() {
    const year = new Date().getFullYear();
    let rand = '';
    const hex = '0123456789ABCDEF';
    for (let i = 0; i < 8; i++) rand += hex[Math.floor(Math.random() * 16)];
    return 'HFAI-' + year + '-' + rand;
  }

  function lsCreateTask(payload) {
    const now = new Date().toISOString();
    const task = {
      task_id: lsGenerateId(),
      status: 'submitted',
      task_type: payload.task_type,
      description: payload.description,
      location_required: Boolean(payload.location_required),
      location_detail: payload.location_detail || null,
      deadline: payload.deadline || null,
      output_format: payload.output_format || 'text_report',
      budget_usd: typeof payload.budget_usd === 'number' ? payload.budget_usd : 0,
      contact_email: payload.contact_email || null,
      requester: payload.requester || 'unspecified',
      source: payload.source || 'web_form',
      created_at: now,
      updated_at: now,
      status_history: [{ status: 'submitted', at: now }],
      operator_notes: null,
    };
    const tasks = lsRead();
    tasks.push(task);
    lsWrite(tasks);
    return task;
  }

  /* ---- API with fallback ---- */

  async function apiFetch(path, options) {
    const res = await fetch(API_BASE + path, options);
    const data = await res.json().catch(function () { return {}; });
    return { ok: res.ok, status: res.status, data: data };
  }

  async function submitTask(payload) {
    try {
      const r = await apiFetch('/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.status === 422 || r.status === 400) {
        return { ok: false, errors: r.data.details || [r.data.message] };
      }
      if (r.ok) return { ok: true, task: r.data, via: 'api' };
      throw new Error('api_unavailable');
    } catch (err) {
      // Fallback: store locally so the MVP works without a server.
      const task = lsCreateTask(payload);
      return { ok: true, task: task, via: 'local' };
    }
  }

  async function getTask(taskId) {
    const id = String(taskId || '').trim().toUpperCase();
    if (!id) return { ok: false, error: 'empty_id' };
    try {
      const r = await apiFetch('/tasks/' + encodeURIComponent(id));
      if (r.ok) return { ok: true, task: r.data, via: 'api' };
      if (r.status === 404) {
        const local = lsRead().find(function (t) { return t.task_id === id; });
        if (local) return { ok: true, task: local, via: 'local' };
        return { ok: false, error: 'not_found' };
      }
      throw new Error('api_unavailable');
    } catch (err) {
      const local = lsRead().find(function (t) { return t.task_id === id; });
      if (local) return { ok: true, task: local, via: 'local' };
      return { ok: false, error: 'not_found' };
    }
  }

  async function listTasks(adminKey) {
    try {
      const r = await apiFetch('/tasks', { headers: { 'X-Admin-Key': adminKey || '' } });
      if (r.ok) return { ok: true, tasks: r.data.tasks, via: 'api' };
      if (r.status === 401) return { ok: false, error: 'unauthorized' };
      throw new Error('api_unavailable');
    } catch (err) {
      return { ok: true, tasks: lsRead().slice().reverse(), via: 'local' };
    }
  }

  async function updateTask(taskId, patch, adminKey) {
    try {
      const r = await apiFetch('/tasks/' + encodeURIComponent(taskId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey || '' },
        body: JSON.stringify(patch),
      });
      if (r.ok) return { ok: true, task: r.data, via: 'api' };
      if (r.status === 401) return { ok: false, error: 'unauthorized' };
      throw new Error('api_unavailable');
    } catch (err) {
      const tasks = lsRead();
      const task = tasks.find(function (t) { return t.task_id === taskId; });
      if (!task) return { ok: false, error: 'not_found' };
      if (patch.status && patch.status !== task.status) {
        task.status = patch.status;
        task.status_history.push({ status: patch.status, at: new Date().toISOString() });
      }
      // Without these the offline path silently drops an ETA or a
      // deliverable the operator just typed.
      if (patch.eta !== undefined) task.eta = patch.eta;
      if (patch.operator_notes !== undefined) {
        task.operator_notes = patch.operator_notes ? String(patch.operator_notes).slice(0, 2000) : null;
      }
      task.updated_at = new Date().toISOString();
      lsWrite(tasks);
      return { ok: true, task: task, via: 'local' };
    }
  }

  async function submitMessage(payload) {
    try {
      const r = await apiFetch('/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.status === 422 || r.status === 400) {
        return { ok: false, errors: r.data.details || [r.data.message] };
      }
      if (r.ok) return { ok: true, result: r.data, via: 'api' };
      throw new Error('api_unavailable');
    } catch (err) {
      // No server — the message can't reach the operator; fall back to email.
      return { ok: false, errors: [], fallback: 'email' };
    }
  }

  async function listMessages(adminKey) {
    try {
      const r = await apiFetch('/messages', { headers: { 'X-Admin-Key': adminKey || '' } });
      if (r.ok) return { ok: true, messages: r.data.messages, via: 'api' };
      if (r.status === 401) return { ok: false, error: 'unauthorized' };
      throw new Error('api_unavailable');
    } catch (err) {
      return { ok: true, messages: [], via: 'local' };
    }
  }

  /* Deletes one message, or the whole inbox when messageId is omitted.
     Admin only; permanent — callers confirm first. */
  async function deleteMessages(messageId, adminKey) {
    try {
      const path = messageId ? '/messages/' + encodeURIComponent(messageId) : '/messages';
      const r = await apiFetch(path, {
        method: 'DELETE',
        headers: { 'X-Admin-Key': adminKey || '' },
      });
      if (r.ok) return { ok: true, deleted: r.data.deleted, via: 'api' };
      if (r.status === 401) return { ok: false, error: 'unauthorized' };
      if (r.status === 404) return { ok: false, error: 'not_found' };
      throw new Error('api_unavailable');
    } catch (err) {
      return { ok: false, error: 'unavailable' };
    }
  }

  /* Abuse blocklist (admin). blockIp adds a client hash; unblockIp
     removes it; listBlocklist returns current entries. */
  async function listBlocklist(adminKey) {
    try {
      const r = await apiFetch('/blocklist', { headers: { 'X-Admin-Key': adminKey || '' } });
      if (r.ok) return { ok: true, entries: r.data.entries, via: 'api' };
      if (r.status === 401) return { ok: false, error: 'unauthorized' };
      throw new Error('api_unavailable');
    } catch (err) {
      return { ok: false, error: 'unavailable' };
    }
  }

  async function blockIp(ipHash, note, adminKey) {
    try {
      const r = await apiFetch('/blocklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey || '' },
        body: JSON.stringify({ ip_hash: ipHash, note: note || null }),
      });
      if (r.ok) return { ok: true, entry: r.data, via: 'api' };
      return { ok: false, error: r.data.error || 'failed' };
    } catch (err) {
      return { ok: false, error: 'unavailable' };
    }
  }

  async function unblockIp(ipHash, adminKey) {
    try {
      const r = await apiFetch('/blocklist/' + encodeURIComponent(ipHash), {
        method: 'DELETE',
        headers: { 'X-Admin-Key': adminKey || '' },
      });
      if (r.ok) return { ok: true, via: 'api' };
      return { ok: false, error: r.data.error || 'failed' };
    } catch (err) {
      return { ok: false, error: 'unavailable' };
    }
  }

  async function getAnalytics(adminKey) {
    try {
      const r = await apiFetch('/analytics', { headers: { 'X-Admin-Key': adminKey || '' } });
      if (r.ok) return { ok: true, data: r.data, via: 'api' };
      if (r.status === 401) return { ok: false, error: 'unauthorized' };
      throw new Error('api_unavailable');
    } catch (err) {
      return { ok: false, error: 'unavailable' };
    }
  }

  window.HumanAPIStore = {
    submitTask: submitTask,
    getTask: getTask,
    listTasks: listTasks,
    updateTask: updateTask,
    submitMessage: submitMessage,
    listMessages: listMessages,
    deleteMessages: deleteMessages,
    listBlocklist: listBlocklist,
    blockIp: blockIp,
    unblockIp: unblockIp,
    getAnalytics: getAnalytics,
  };
})();
