/**
 * Human For AI — contact message form.
 * Posts to /api/v1/messages (the same endpoint agents use). If no server
 * is running, points the sender at the email fallback instead.
 */
(function () {
  'use strict';

  var form = document.getElementById('message-form');
  if (!form) return;

  var errorBox = document.getElementById('msg-errors');
  var successBox = document.getElementById('msg-success');
  var submitBtn = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errorBox.hidden = true;
    errorBox.textContent = '';

    var payload = {
      from: form.from.value.trim() || undefined,
      subject: form.subject.value.trim() || undefined,
      message: form.message.value.trim(),
      reply_to: form.reply_to.value.trim() || undefined,
      source: 'web_form',
    };
    Object.keys(payload).forEach(function (k) {
      if (payload[k] === undefined) delete payload[k];
    });

    if (!payload.message || payload.message.length < 5) {
      errorBox.textContent = 'Write a message of at least 5 characters.';
      errorBox.hidden = false;
      errorBox.focus();
      return;
    }

    // reply_to is required server-side (v1.5.0) — catch it here for
    // instant feedback instead of a failed round-trip.
    if (!payload.reply_to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.reply_to)) {
      errorBox.textContent = 'A real reply-to email is required — it is the only way the operator can answer you.';
      errorBox.hidden = false;
      errorBox.focus();
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    window.HumanAPIStore.submitMessage(payload).then(function (result) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send message';

      if (!result.ok) {
        if (result.fallback === 'email') {
          errorBox.textContent = 'No server reachable from this page — please try again once the site is back online.';
        } else {
          /* Server validation errors can echo user input (e.g. the
             rejected email's domain) — render as text, never markup. */
          errorBox.textContent = '';
          (result.errors || ['Sending failed.']).forEach(function (p) {
            var line = document.createElement('div');
            line.textContent = p;
            errorBox.appendChild(line);
          });
        }
        errorBox.hidden = false;
        errorBox.focus();
        return;
      }

      form.hidden = true;
      document.getElementById('msg-result-id').textContent = result.result.message_id;
      successBox.hidden = false;
      successBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
})();
