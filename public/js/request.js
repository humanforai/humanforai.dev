/**
 * Human For AI — task request form.
 * Builds the same JSON payload an agent would POST, submits it through
 * the data layer, and shows the generated task ID.
 */
(function () {
  'use strict';

  var form = document.getElementById('task-form');
  if (!form) return;

  var errorBox = document.getElementById('form-errors');
  var successBox = document.getElementById('form-success');
  var previewEl = document.getElementById('payload-preview');
  var submitBtn = form.querySelector('button[type="submit"]');

  /* Server validation errors can echo user input (e.g. the rejected
     email's domain), so they must land as text, never as markup. */
  function showErrors(list) {
    errorBox.textContent = '';
    list.forEach(function (p) {
      var line = document.createElement('div');
      line.textContent = p;
      errorBox.appendChild(line);
    });
    errorBox.hidden = false;
    errorBox.focus();
  }

  function collectPayload() {
    var deadlineRaw = form.deadline.value;
    var payload = {
      task_type: form.task_type.value,
      description: form.description.value.trim(),
      location_required: form.location_required.checked,
      location_detail: form.location_detail.value.trim() || undefined,
      deadline: deadlineRaw ? new Date(deadlineRaw).toISOString() : undefined,
      output_format: form.output_format.value,
      contact_email: form.contact_email.value.trim() || undefined,
      requester: form.requester.value.trim() || undefined,
      source: 'web_form',
    };
    Object.keys(payload).forEach(function (k) {
      if (payload[k] === undefined) delete payload[k];
    });
    return payload;
  }

  /* Live "what the machine sees" preview — the form and the API are
     the same interface. */
  function refreshPreview() {
    if (!previewEl) return;
    previewEl.textContent = JSON.stringify(collectPayload(), null, 2);
  }
  form.addEventListener('input', refreshPreview);
  refreshPreview();

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorBox.hidden = true;
    errorBox.textContent = '';

    var payload = collectPayload();
    var problems = [];
    if (!payload.task_type) problems.push('Choose a task type.');
    if (!payload.description || payload.description.length < 10) {
      problems.push('Describe the task in at least 10 characters.');
    }
    // contact_email is required server-side (v1.5.0) — catch it here for
    // instant feedback instead of a failed round-trip.
    if (!payload.contact_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.contact_email)) {
      problems.push('A real contact email is required — the deliverable and any questions are sent there.');
    }
    if (problems.length) {
      showErrors(problems);
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    window.HumanAPIStore.submitTask(payload).then(function (result) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit task';

      if (!result.ok) {
        showErrors(result.errors || ['Submission failed.']);
        return;
      }

      form.hidden = true;
      var id = result.task.task_id;
      document.getElementById('result-task-id').textContent = id;
      document.getElementById('result-status-link').href = '/tasks?id=' + encodeURIComponent(id);
      var viaNote = document.getElementById('result-via');
      if (viaNote) {
        viaNote.textContent = result.via === 'local'
          ? 'Saved in this browser (no server detected). Run the local server for API-backed storage.'
          : 'Received by the API. The operator has been notified and will review it.';
      }
      successBox.hidden = false;
      successBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
})();
